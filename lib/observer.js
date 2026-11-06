// Background instinct distillation. Replaces ECC's observer-loop.sh +
// observer.md Claude-Code-agent pair with a single in-process generate.text
// call: the model has no tools here, so this module parses its markdown
// output and writes the instinct files itself.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProject, siblingInstinctsDir } from "./project.js";
import { firstActionSentence, listInstincts, parseFrontmatterBlocks, stripFrontmatter, unquoteYaml, writeInstinct } from "./store.js";
import { countObservationLines, pendingSince, readObserverState, saveObserverState } from "./observer-state.js";
import { appendEvidence, appendMaintenanceLog, classifyNewInstinct, dedupeOrMerge, loadInstinctFiles } from "./maintain.js";
import { PKG_NAME } from "./pkg.js";
import { clip } from "./scrub.js";
import { noticeDescription } from "./util.js";

const OBSERVER_TEMPLATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor", "ecc", "observer.md");
const ANALYSIS_RECORD_CLIP_CHARS = 400;
// The observer's own defaults. lib/plugin.js builds its observer group
// from this object, the same way its maintenance, review and inject
// groups come from their own modules, so no module imports plugin.js back.
export const OBSERVER_DEFAULTS = Object.freeze({
  enabled: false,
  model: undefined,
  runIntervalMinutes: 15,
  minObservations: 40,
  maxAnalysisLines: 300,
  maxAnalysisBytes: 32768,
  notify: true,
});
const MAX_INSTINCTS_PER_RUN = 10;
const INSTINCT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
// A trigger (or any other field) that still carries one of these as a
// trailing `key: value` pair almost always means the model crammed a
// second frontmatter line onto the first one; such a block is rejected
// outright rather than storing the leaked fragment as part of the
// trigger text. (lib/maintain.js's repairStep cleans up files that
// predate this check.)
const LEAKED_FIELD_PATTERN = /\b(confidence|domain|scope|source)\s*:/i;
const SUMMARY_MAX_CHARS = 160;
const SUMMARY_CLIP_CHARS = 120;
// How long a counted line count stays valid for the threshold gate: the
// gate runs on every observed tool call / prompt, and re-reading and
// re-splitting the whole observations file that often is wasted work once
// the file has any real size.
const COUNT_THROTTLE_MS = 30000;

// Backoff schedule for consecutive ctx.generate.text failures: 5 min after
// the 1st, 15 min after the 2nd, 60 min after the 3rd and every one after
// that. Index with Math.min(failures, BACKOFF_STEPS_MS.length) - 1.
const BACKOFF_STEPS_MS = [5 * 60000, 15 * 60000, 60 * 60000];

const MODEL_UNSET_MESSAGE =
  'mighty-instincts: learning runs are paused because observer.model is not set. Add "observer": { "model": "<provider>/<model>" } to the plugin options in opencode.json (a cheap model is enough) and restart.';

const OUTPUT_CONTRACT =
  "Output each instinct as a complete markdown document wrapped in `<instinct>` and `</instinct>` tags: " +
  "YAML frontmatter between `---` lines with id, trigger, confidence, domain, summary, then `# Title`, `## Action`, `## Evidence`. " +
  "`summary` is one imperative sentence describing what to do, at most 120 characters. " +
  "Keep every field's value on its own single line; never let `trigger` (or any other field) spill a second `key: value` pair onto that same line. " +
  "Never use a `---` line inside the body. Output `<none/>` and nothing else when no pattern has 3+ observations. " +
  "Do not include code snippets, file contents, or secrets.";

let cachedTemplate;

// Shared notify-gate rule for every notice this module posts: an explicit
// `true`/`false` on the per-call `notify` option (run()'s own parameter,
// e.g. /instinct-observe's `{ notify: true }`) always wins; left
// undefined (the background maybeRun() path), it falls back to
// options.observer.notify.
function wantsNotify(notify, cfgNotify) {
  if (notify === true) return true;
  if (notify === false) return false;
  return cfgNotify !== false;
}

// A finite value wins outright, including 0: `value || fallback` (the
// bug this guards against, seen in another module's own copy of this
// gate) silently replaces a deliberate 0 with the fallback, since 0 is
// falsy in JS.
function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

// The single implementation of "is a background observer run due right
// now", pure and exported so lib/board.js (or any other caller) can ask
// the same question lib/observer.js's own thresholdsMet() asks, instead
// of keeping a second copy of these rules that can drift out of sync.
// `state` is whatever readObserverState (lib/observer-state.js) returns;
// `pendingCount` is the caller's own already-computed "observations
// pending since the last run" (pendingSince), not a raw line count, so
// this function never has to touch the filesystem itself. Every number
// is read from options.observer and, only when that field is absent
// (not merely falsy), from OBSERVER_DEFAULTS: a configured 0 is
// never silently replaced by a nonzero default, and options.observer.
// runIntervalMinutes === 0 always means "no interval gate at all", the
// same thing it already means today's math (0 * 60000, never satisfied
// by a non-negative elapsed time).
// `nextEligibleAt` is the clock fact behind the interval and backoff
// timers (the later of the two, when either is still in the future),
// reported on every outcome so a display can show "in 8 min" even
// while another reason (disabled, pending) decides the verdict.
export function evaluateObserverGate({ state = {}, options, pendingCount, now = Date.now() } = {}) {
  const cfg = options?.observer ?? {};
  const minObservations = numberOr(cfg.minObservations, OBSERVER_DEFAULTS.minObservations);
  const lastWrittenCounts = Array.isArray(state.lastWrittenCounts) ? state.lastWrittenCounts : [];
  const damperActive = lastWrittenCounts.length === 2 && lastWrittenCounts.every((count) => count === 0);
  const required = damperActive ? minObservations * 2 : minObservations;

  const runIntervalMinutes = numberOr(cfg.runIntervalMinutes, OBSERVER_DEFAULTS.runIntervalMinutes);
  const intervalMs = runIntervalMinutes * 60000;
  const lastRunMs = state.lastRunAt ? new Date(state.lastRunAt).getTime() : NaN;
  const intervalBlocks = intervalMs > 0 && Number.isFinite(lastRunMs) && now - lastRunMs < intervalMs;
  const backoffMs = state.nextAttemptAfter ? new Date(state.nextAttemptAfter).getTime() : NaN;
  const backoffBlocks = Number.isFinite(backoffMs) && now < backoffMs;
  const eligibleMs = Math.max(intervalBlocks ? lastRunMs + intervalMs : -Infinity, backoffBlocks ? backoffMs : -Infinity);
  const nextEligibleAt = Number.isFinite(eligibleMs) ? new Date(eligibleMs).toISOString() : null;

  if (cfg.enabled !== true) {
    return { ready: false, reason: "disabled", required, nextEligibleAt };
  }

  if (backoffBlocks) {
    return { ready: false, reason: "backoff", nextAttemptAfter: state.nextAttemptAfter, required, nextEligibleAt };
  }

  if (intervalBlocks) {
    return { ready: false, reason: "interval", required, nextEligibleAt };
  }

  const pending = Number.isFinite(pendingCount) ? pendingCount : 0;
  if (pending < required) {
    return { ready: false, reason: "pending", required, nextEligibleAt };
  }

  // observer.model is unset and a run has already detected that once
  // (and posted/logged the one-time notice): never ready again until it
  // is configured. The very first time the model is unset (not yet
  // blocked), every other gate still decides the outcome, same as today:
  // one run is allowed through so it can discover and record the block.
  if (!parseModelRef(cfg.model) && state.blocked === "model-unset") {
    return { ready: false, reason: "model-unset", required, nextEligibleAt };
  }

  return { ready: true, reason: "ready", required, nextEligibleAt };
}

// `hooks.afterRun`, when given, is called once after every runOnce() call
// (board refresh, lib/plugin.js wires lib/board.js's controller and
// lib/maintain.js's maintenance controller here) so the board state file
// and the maintenance sweep both stay current without observer.js knowing
// anything about either beyond "something wants to know when a run
// finished".
export function createObserver(ctx, options, hooks = {}) {
  const afterRun = typeof hooks.afterRun === "function" ? hooks.afterRun : () => {};
  let inFlight = false;
  // Per-instance throttle cache for the line-count gate (see
  // COUNT_THROTTLE_MS above): keyed on the observations file path so a
  // stale count from a different project (if this instance ever resolved
  // to more than one) is never reused.
  let lineCountCache = null;
  let lineCountReads = 0;

  async function maybeRun(sessionID) {
    if (!options.observer?.enabled || inFlight) return;
    // Claimed before the first await: hooks fire concurrently, and a check
    // that awaited first let three of them start three generate.text calls.
    inFlight = true;
    try {
      if (await thresholdsMet()) await runOnce(sessionID, {});
    } catch (error) {
      console.warn(`[${PKG_NAME}] observer.maybeRun failed`, error);
    } finally {
      inFlight = false;
    }
  }

  // Checks the cheap, state-file-only gates first (failure backoff, then
  // the run interval), against .observer-state.json alone: that is one
  // small JSON read, independent of how large the observations file has
  // grown. Only once those have actually elapsed does this fall through
  // to the (throttled) line count, which is the expensive part: reading
  // and splitting the whole observations file. Both calls below go
  // through the same evaluateObserverGate this module exports, so there
  // is exactly one implementation of these rules: the first call uses a
  // placeholder pendingCount that can never be the deciding factor, just
  // to find out whether every other gate (enabled, backoff, interval,
  // model-unset) would already block without ever reading the
  // observations file; only once that passes does the real count get read.
  async function thresholdsMet() {
    const project = await resolveProject(ctx, options);
    const state = await readObserverState(project.project_dir);

    // Number.MAX_SAFE_INTEGER (not Infinity: evaluateObserverGate treats
    // a non-finite pendingCount as unknown, i.e. 0) stands in for "more
    // observations than any real minObservations could ever require",
    // so this first call can never be decided by the pending gate.
    const preCheck = evaluateObserverGate({ state, options, pendingCount: Number.MAX_SAFE_INTEGER });
    if (!preCheck.ready) return false;

    const currentLineCount = await throttledCountLines(project.observations_file);
    const pendingCount = pendingSince(state, currentLineCount);
    return evaluateObserverGate({ state, options, pendingCount }).ready;
  }

  async function throttledCountLines(file) {
    const now = Date.now();
    if (lineCountCache && lineCountCache.file === file && now - lineCountCache.at < COUNT_THROTTLE_MS) {
      return lineCountCache.count;
    }
    const count = await countObservationLines(file);
    lineCountReads += 1;
    lineCountCache = { file, count, at: now };
    return count;
  }

  // `notify` overrides options.observer.notify: /instinct-observe (lib/commands.js)
  // always wants a response posted back, independent of the background-run
  // notification preference. Unlike maybeRun, this never consults
  // thresholdsMet() at all, so it bypasses both the interval/count gates
  // and the failure backoff above; a thrown run here still updates the
  // backoff state (and still only reaches afterRun on success, see
  // runOnce below), but never waits on it first.
  async function run(sessionID, { notify } = {}) {
    if (inFlight) return "observer run already in progress";
    inFlight = true;
    try {
      return await runOnce(sessionID, { notify });
    } finally {
      inFlight = false;
    }
  }

  // afterRun (board refresh + the forced maintenance sweep) only runs
  // once runOnceInner has actually resolved: a thrown failure (the model
  // call itself, or a disk error parsing/writing/saving state afterward)
  // is caught and handled inside runOnceInner itself (see
  // handleRunFailure), but still re-thrown from there afterward
  // specifically so this call is skipped, instead of forcing a full
  // maintenance sweep on every failed attempt the way it used to.
  async function runOnce(sessionID, { notify } = {}) {
    const result = await runOnceInner(sessionID, { notify });
    try {
      await afterRun();
    } catch (error) {
      console.warn(`[${PKG_NAME}] after-run hook failed`, error);
    }
    return result;
  }

  async function postNotice(targetSessionID, text) {
    if (!targetSessionID) return;
    try {
      await ctx.session.synthetic({
        sessionID: targetSessionID,
        text,
        description: noticeDescription(text),
        delivery: "queue",
        resume: false,
      });
    } catch (error) {
      console.warn(`[${PKG_NAME}] observer notify failed`, error);
    }
  }

  // observer.model is unset: never call the model. The first time this
  // is reached (state.blocked was not already "model-unset"), the notice
  // is logged and posted once and the block is recorded in state so
  // neither happens again on its own; a manual /instinct-observe call
  // (notify === true) still gets the same sentence every time, since
  // that is the only reply the command posts on this path (it never
  // throws, so lib/commands.js's own catch-and-postResult fallback never
  // fires).
  async function handleModelUnset(project, state, sessionID, notify, cfg) {
    const firstTime = state.blocked !== "model-unset";
    if (firstTime) {
      await appendLog(project.project_dir, `${new Date().toISOString()} ${MODEL_UNSET_MESSAGE}`);
      await saveObserverState(project.project_dir, { ...state, blocked: "model-unset" });
    }
    if (sessionID && (firstTime || notify === true) && wantsNotify(notify, cfg.notify)) {
      await postNotice(sessionID, MODEL_UNSET_MESSAGE);
    }
    return MODEL_UNSET_MESSAGE;
  }

  // A thrown error anywhere from the model call through the final state
  // save (ctx.generate.text itself, or a disk error parsing, deduping, or
  // writing an instinct, or saving state): bump the consecutive-failure
  // count, schedule the next allowed attempt (BACKOFF_STEPS_MS), and log
  // it. The one-time "first failure of a streak" notice is posted
  // directly here (resume: false, the same shape the per-run notify below
  // uses) only for the background path (notify !== true); the manual
  // command's own reply comes from the re-thrown error below instead
  // (describeError reads its .message, which carries the same log line),
  // so the two never both post for the same failure.
  async function handleRunFailure(project, state, sessionID, notify, cfg, error) {
    const failures = state.failures + 1;
    const stepIndex = Math.min(failures, BACKOFF_STEPS_MS.length) - 1;
    const timestamp = new Date().toISOString();
    const nextAttemptAfter = new Date(Date.now() + BACKOFF_STEPS_MS[stepIndex]).toISOString();
    const message = error instanceof Error ? error.message : String(error);
    const logLine = `${timestamp} run failed: ${message} (attempt ${failures}, next after ${nextAttemptAfter})`;

    await appendLog(project.project_dir, logLine);
    await saveObserverState(project.project_dir, { ...state, lastAttemptAt: timestamp, failures, nextAttemptAfter });

    if (sessionID && failures === 1 && notify !== true && wantsNotify(notify, cfg.notify)) {
      await postNotice(sessionID, logLine);
    }

    const wrapped = new Error(logLine);
    wrapped.cause = error;
    throw wrapped;
  }

  async function runOnceInner(sessionID, { notify } = {}) {
    const project = await resolveProject(ctx, options);
    // mergeOptions (lib/plugin.js) always fills options.observer/options.maintenance
    // and every field on them before setup() ever creates this observer, so
    // there is no missing-field case left to fall back from here.
    const cfg = options.observer;
    const maintenanceCfg = options.maintenance;
    const maxLines = cfg.maxAnalysisLines;
    const state = await readObserverState(project.project_dir);

    if (maintenanceCfg?.dryRun !== true) await backfillMissingSummaries(project.instincts_personal);

    const view = await buildAnalysisView(project.observations_file, maxLines, cfg.maxAnalysisBytes);
    const personal = await listInstincts(project.instincts_personal);
    const inherited = await listInstincts(project.instincts_inherited);

    if (view.empty) {
      const summary = "No observations recorded yet; nothing to analyse.";
      await appendLog(project.project_dir, `${new Date().toISOString()} run skipped: no observations`);
      return summary;
    }

    const inheritedIds = new Set(inherited.map((inst) => inst.id));

    const template = await readObserverTemplate();
    const prompt = buildObserverPrompt(template, formatExisting([...personal, ...inherited]), view.text);

    const modelRef = parseModelRef(cfg.model);
    if (!modelRef) {
      return await handleModelUnset(project, state, sessionID, notify, cfg);
    }

    // Everything from the model call through the final state save shares
    // one failure handler: a disk error writing an instinct or saving
    // state is just as much "the run failed" as the model call itself
    // throwing, and must go through the same backoff bookkeeping so it is
    // never silently retried on every single observed event afterward.
    try {
      const { text } = await ctx.generate.text({ prompt, model: modelRef });
      const blocks = extractInstinctBlocks(text ?? "");

      let written = 0;
      const writtenIds = [];
      const rejections = [];
      const dedupeLog = (line) => void appendMaintenanceLog(project.project_dir, line).catch(() => {});

      for (const block of blocks) {
        const parsed = parseInstinctBlock(block);
        if (parsed.error) {
          rejections.push(parsed.error);
          continue;
        }
        if (inheritedIds.has(parsed.fields.id)) {
          rejections.push(`${parsed.fields.id}: duplicate of an inherited instinct`);
          continue;
        }

        const fields = {
          ...parsed.fields,
          source: "session-observation",
          scope: "project",
          project_id: project.id,
          project_name: project.name,
        };

        if (maintenanceCfg?.dedupe !== false) {
          const merged = await dedupeOrMerge(project.instincts_personal, fields, parsed.body, {
            dryRun: maintenanceCfg?.dryRun === true,
            log: dedupeLog,
          });
          if (merged) continue;
        }

        // A block for an id that already has a file is an update of that
        // instinct. The prompt shows the model only its id, trigger and
        // confidence (formatExisting below), never its body, so the stored
        // body, summary, trigger, domain, created:, decayed_at: and fired:
        // are kept, and only the block's `## Evidence` lines and its
        // confidence are taken. A brand-new id goes where
        // classifyNewInstinct's "50% rule" sends it.
        const stored = await readStoredInstinct([project.instincts_personal, siblingInstinctsDir(project, "pending")], fields.id);
        if (stored) {
          await writeInstinct(stored.dir, { ...stored.fields, ...fields, ...keptFields(stored.fields), confidence: fields.confidence }, appendEvidence(stored.body, parsed.body));
        } else {
          const target = classifyNewInstinct(fields) === "pending" ? siblingInstinctsDir(project, "pending") : project.instincts_personal;
          await writeInstinct(target, { ...fields, created: new Date().toISOString() }, parsed.body);
        }
        written += 1;
        writtenIds.push(parsed.fields.id);
      }

      const modelDescription = `${modelRef.providerID}/${modelRef.id}`;
      const timestamp = new Date().toISOString();
      // The board (lib/board.js) sums "run: N written, M rejected" across
      // every line it can match that prefix on, so it stays parseable; the
      // ids/rejected-reasons suffixes are appended only for the detail
      // panel's raw log tail and are never parsed back out by the board.
      const idsSuffix = writtenIds.length ? ` ids: ${writtenIds.join(",")}` : "";
      const rejectedSuffix = rejections.length ? ` rejected: ${rejections.join("; ")}` : "";
      const logLine = `${timestamp} run: ${written} written, ${rejections.length} rejected, model ${modelDescription}${idsSuffix}${rejectedSuffix}`;
      await appendLog(project.project_dir, logLine);
      // A successful run resets the failure streak and any model-unset
      // block, and rolls `written` into the last-two-runs window the
      // zero-write damper (thresholdsMet, above) reads.
      const lastWrittenCounts = [...state.lastWrittenCounts, written].slice(-2);
      await saveObserverState(project.project_dir, {
        lastRunAt: timestamp,
        lastLineCount: await countObservationLines(project.observations_file),
        lastAttemptAt: timestamp,
        failures: 0,
        nextAttemptAfter: null,
        blocked: null,
        lastWrittenCounts,
      });

      const summaryLines = [logLine];
      if (writtenIds.length) summaryLines.push(`Written: ${writtenIds.join(", ")}`);
      if (rejections.length) summaryLines.push(`Rejected: ${rejections.join("; ")}`);
      const summary = summaryLines.join("\n");

      // The background per-run notify (notify left undefined, following
      // options.observer.notify) only posts when the run actually wrote
      // something: a run that wrote 0 still logs its rejections, but no
      // longer interrupts the chat for them. A manual /instinct-observe
      // call (notify: true) always gets its full reply regardless.
      const shouldNotify = wantsNotify(notify, cfg.notify) && (notify === true || written > 0);
      if (shouldNotify) await postNotice(sessionID, summary);

      return summary;
    } catch (error) {
      return await handleRunFailure(project, state, sessionID, notify, cfg, error);
    }
  }

  // `_countLineReads` is a test seam only (smoke-test.mjs uses it to prove
  // the interval gate short-circuits before touching the observations
  // file); nothing in this module's own control flow depends on it.
  return { maybeRun, run, _countLineReads: () => lineCountReads };
}

async function appendLog(projectDir, line) {
  await fs.mkdir(projectDir, { recursive: true });
  await fs.appendFile(path.join(projectDir, "observer.log"), `${line}\n`, "utf8");
}

async function readObserverTemplate() {
  if (cachedTemplate) return cachedTemplate;
  cachedTemplate = await fs.readFile(OBSERVER_TEMPLATE_PATH, "utf8");
  return cachedTemplate;
}

// Reads the tail of the observations file newest-first so the byte cap
// (options.observer.maxAnalysisBytes) keeps the most recent activity when
// the file is large, then reorders the kept records oldest-first because
// that is the order a reader (model or human) expects a session timeline
// in.
async function buildAnalysisView(observationsFile, maxLines, maxBytes) {
  let content;
  try {
    content = await fs.readFile(observationsFile, "utf8");
  } catch {
    return { text: "(no observations yet)", empty: true };
  }

  const effectiveMaxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : OBSERVER_DEFAULTS.maxAnalysisBytes;
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  const tail = lines.slice(-maxLines);

  const newestFirst = [];
  let bytes = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const clipped = clipRecordLine(tail[i]);
    const size = Buffer.byteLength(clipped, "utf8") + 1;
    if (bytes + size > effectiveMaxBytes && newestFirst.length > 0) break;
    newestFirst.push(clipped);
    bytes += size;
  }

  const chronological = newestFirst.reverse();
  if (!chronological.length) return { text: "(no observations yet)", empty: true };
  return { text: chronological.join("\n"), empty: false };
}

function clipRecordLine(line) {
  try {
    const record = JSON.parse(line);
    for (const field of ["input", "output", "text"]) {
      if (typeof record[field] === "string") record[field] = clip(record[field], ANALYSIS_RECORD_CLIP_CHARS);
    }
    return JSON.stringify(record);
  } catch {
    return clip(line, ANALYSIS_RECORD_CLIP_CHARS);
  }
}

function formatExisting(list) {
  if (!list.length) return "(none yet)";
  return list.map((inst) => `- ${inst.id} (trigger: ${inst.trigger ?? "unknown"}, confidence: ${inst.confidence ?? "?"})`).join("\n");
}

// Personal instincts with no `summary:` (written before 0.7.0, imported,
// or hand-written) get one from their own first Action sentence, the
// same fallback lib/inject.js uses, without a model call: the model was
// asked to re-emit such instincts with their body "exactly as given"
// while never being given it, and its reply replaced the stored body.
async function backfillMissingSummaries(personalDir) {
  for (const item of await loadInstinctFiles(personalDir)) {
    if (typeof item.fields.summary === "string" && item.fields.summary.trim().length > 0) continue;
    const summary = firstActionSentence(item.body);
    if (summary) await writeInstinct(personalDir, { ...item.fields, summary }, item.body);
  }
}

const KEPT_ON_UPDATE = ["summary", "trigger", "domain", "created", "decayed_at", "fired"];

function keptFields(storedFields) {
  const kept = {};
  for (const key of KEPT_ON_UPDATE) if (storedFields[key] !== undefined) kept[key] = storedFields[key];
  if (!kept.created) kept.created = new Date().toISOString();
  return kept;
}

async function readStoredInstinct(dirs, id) {
  for (const dir of dirs) {
    let content;
    try {
      content = await fs.readFile(path.join(dir, `${id}.md`), "utf8");
    } catch {
      continue;
    }
    const blocks = parseFrontmatterBlocks(content);
    if (blocks.length === 1 && blocks[0].id === id) return { dir, fields: blocks[0], body: stripFrontmatter(content) };
  }
  return null;
}

// Swaps vendor/ecc/observer.md's own "## Output" examples (project vs.
// global YAML samples meant for a Claude Code sub-agent with file tools)
// for the <instinct> tag contract this plugin's text-only parser expects.
function buildObserverPrompt(template, existingText, observationsText) {
  const heading = "## Output";
  const startIdx = template.indexOf(heading);
  const replacement = [
    heading,
    "",
    OUTPUT_CONTRACT,
    "",
    "## Existing Instincts (update rather than duplicate)",
    "",
    existingText,
    "",
    "## Observations",
    "",
    "```jsonl",
    observationsText,
    "```",
    "",
  ].join("\n");

  if (startIdx === -1) return `${template}\n\n${replacement}`;

  const afterHeading = startIdx + heading.length;
  const endIdx = findNextTopLevelHeading(template, afterHeading);
  return `${template.slice(0, startIdx)}${replacement}${template.slice(endIdx === -1 ? template.length : endIdx)}`;
}

// The vendored "## Output" section's own YAML examples contain "## Action" /
// "## Evidence" lines inside fenced code blocks; a plain "\n## " search
// would stop at those instead of the real next heading ("## Scope Decision
// Guide"), so fences have to be tracked while scanning.
function findNextTopLevelHeading(text, fromIndex) {
  const lines = text.slice(fromIndex).split("\n");
  let offset = 0;
  let inFence = false;
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
    } else if (!inFence && /^## /.test(line)) {
      return fromIndex + offset;
    }
    offset += line.length + 1;
  }
  return -1;
}

// Exported for lib/review.js, which needs the same "provider/model" string
// parsing for its own headless session's model option.
export function parseModelRef(spec) {
  if (typeof spec !== "string") return null;
  const i = spec.indexOf("/");
  if (i <= 0 || i === spec.length - 1) return null;
  return { providerID: spec.slice(0, i), id: spec.slice(i + 1) };
}

function extractInstinctBlocks(text) {
  const blocks = [];
  const pattern = /<instinct>([\s\S]*?)<\/instinct>/g;
  let match;
  while (blocks.length < MAX_INSTINCTS_PER_RUN && (match = pattern.exec(text)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

// Pure, exported for smoke-test.mjs: validates and extracts fields from
// one `<instinct>...</instinct>` block's inner text (frontmatter + body).
export function parseInstinctBlock(block) {
  const lines = block.split("\n");
  if (lines[0]?.trim() !== "---") return { error: "block is missing the opening '---' frontmatter line" };

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex === -1) return { error: "block is missing the closing '---' frontmatter line" };

  const bodyLines = lines.slice(closingIndex + 1);
  if (bodyLines.some((line) => /^\s*---\s*$/.test(line))) {
    return { error: "body contains a '---' line" };
  }

  // One field per physical line: a trailing second `key: value` pair on
  // the same line (LEAKED_FIELD_PATTERN, below) means the model crammed
  // two frontmatter lines together, not that the first field's own value
  // legitimately contains a colon.
  const fields = {};
  for (const line of lines.slice(1, closingIndex)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    fields[line.slice(0, idx).trim()] = unquoteYaml(line.slice(idx + 1).trim());
  }

  if (!INSTINCT_ID_PATTERN.test(fields.id ?? "")) {
    return { error: `invalid id: ${fields.id ?? "(missing)"}` };
  }
  if (!fields.trigger) return { error: `${fields.id}: missing trigger` };
  if (LEAKED_FIELD_PATTERN.test(fields.trigger)) {
    return { error: `${fields.id}: trigger contains a leaked frontmatter field` };
  }
  const confidence = Number(fields.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { error: `${fields.id}: invalid confidence '${fields.confidence}'` };
  }
  if (!fields.domain) return { error: `${fields.id}: missing domain` };
  if (!fields.summary || !fields.summary.trim()) {
    return { error: `${fields.id}: missing summary` };
  }
  if (fields.summary.length > SUMMARY_MAX_CHARS) {
    return { error: `${fields.id}: summary too long (${fields.summary.length} chars, max ${SUMMARY_MAX_CHARS})` };
  }
  const summary = fields.summary.length > SUMMARY_CLIP_CHARS ? fields.summary.slice(0, SUMMARY_CLIP_CHARS) : fields.summary;

  return {
    fields: { id: fields.id, trigger: fields.trigger, confidence, domain: fields.domain, summary },
    body: bodyLines.join("\n").trim(),
  };
}
