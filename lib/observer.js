// Background instinct distillation. Replaces ECC's observer-loop.sh +
// observer.md Claude-Code-agent pair with a single in-process generate.text
// call: the model has no tools here, so this module parses its markdown
// output and writes the instinct files itself.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProject, siblingInstinctsDir } from "./project.js";
import { listInstincts, unquoteYaml, writeInstinct } from "./store.js";
import { countObservationLines, pendingSince, readObserverState, saveObserverState } from "./observer-state.js";
import { appendMaintenanceLog, classifyNewInstinct, dedupeOrMerge } from "./maintain.js";
import { PKG_NAME } from "./pkg.js";
import { clip } from "./scrub.js";

const OBSERVER_TEMPLATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor", "ecc", "observer.md");
const ANALYSIS_RECORD_CLIP_CHARS = 400;
const ANALYSIS_MAX_BYTES = 64 * 1024;
const MAX_INSTINCTS_PER_RUN = 10;
const MAX_MISSING_SUMMARY_PER_RUN = 20;
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

const OUTPUT_CONTRACT =
  "Output each instinct as a complete markdown document wrapped in `<instinct>` and `</instinct>` tags: " +
  "YAML frontmatter between `---` lines with id, trigger, confidence, domain, summary, then `# Title`, `## Action`, `## Evidence`. " +
  "`summary` is one imperative sentence describing what to do, at most 120 characters. " +
  "Keep every field's value on its own single line; never let `trigger` (or any other field) spill a second `key: value` pair onto that same line. " +
  "Never use a `---` line inside the body. Output `<none/>` and nothing else when no pattern has 3+ observations. " +
  "Do not include code snippets, file contents, or secrets.";

let cachedTemplate;

// `hooks.afterRun`, when given, is called once after every runOnce() call
// (board refresh, lib/plugin.js wires lib/board.js's controller and
// lib/maintain.js's maintenance controller here) so the board state file
// and the maintenance sweep both stay current without observer.js knowing
// anything about either beyond "something wants to know when a run
// finished".
export function createObserver(ctx, options, hooks = {}) {
  const afterRun = typeof hooks.afterRun === "function" ? hooks.afterRun : () => {};
  let inFlight = false;
  let warnedNoModel = false;
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

  // Checks the interval gate first, against .observer-state.json alone:
  // that is one small JSON read, independent of how large the observations
  // file has grown. Only once the interval has actually elapsed does this
  // fall through to the (throttled) line count, which is the expensive
  // part: reading and splitting the whole observations file.
  async function thresholdsMet() {
    const cfg = options.observer;
    const project = await resolveProject(ctx, options);
    const state = await readObserverState(project.project_dir);
    const intervalMs = cfg.runIntervalMinutes * 60000;
    if (state.lastRunAt && Date.now() - new Date(state.lastRunAt).getTime() < intervalMs) {
      return false;
    }

    const currentLineCount = await throttledCountLines(project.observations_file);
    return pendingSince(state, currentLineCount) >= cfg.minObservations;
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
  // notification preference.
  async function run(sessionID, { notify } = {}) {
    if (inFlight) return "observer run already in progress";
    inFlight = true;
    try {
      return await runOnce(sessionID, { notify });
    } finally {
      inFlight = false;
    }
  }

  async function runOnce(sessionID, { notify } = {}) {
    try {
      return await runOnceInner(sessionID, { notify });
    } finally {
      // Fire-and-forget: a stuck or failing board/maintenance pass must
      // never slow down or fail an observer run.
      try {
        await afterRun();
      } catch (error) {
        console.warn(`[${PKG_NAME}] after-run hook failed`, error);
      }
    }
  }

  async function runOnceInner(sessionID, { notify } = {}) {
    const project = await resolveProject(ctx, options);
    // mergeOptions (lib/plugin.js) always fills options.observer/options.maintenance
    // and every field on them before setup() ever creates this observer, so
    // there is no missing-field case left to fall back from here.
    const cfg = options.observer;
    const maintenanceCfg = options.maintenance;
    const maxLines = cfg.maxAnalysisLines;

    const view = await buildAnalysisView(project.observations_file, maxLines);
    const personal = await listInstincts(project.instincts_personal);
    const inherited = await listInstincts(project.instincts_inherited);
    const missingSummarySection = buildMissingSummarySection(personal);

    if (view.empty && !missingSummarySection) {
      const summary = "No observations recorded yet; nothing to analyse.";
      await appendLog(project.project_dir, `${new Date().toISOString()} run skipped: no observations`);
      return summary;
    }

    const inheritedIds = new Set(inherited.map((inst) => inst.id));

    const template = await readObserverTemplate();
    const prompt = buildObserverPrompt(template, formatExisting([...personal, ...inherited]), view.text) + missingSummarySection;

    const modelRef = parseModelRef(cfg.model);
    const generateArgs = { prompt };
    if (modelRef) {
      generateArgs.model = modelRef;
    } else if (!warnedNoModel) {
      warnedNoModel = true;
      console.warn(`[${PKG_NAME}] observer.model is not set; generate.text will use the host's default model`);
    }

    const { text } = await ctx.generate.text(generateArgs);
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

      // Already-written personal instinct resubmitted with just a
      // `summary:` field added (missingSummarySection above), or any
      // other update to an existing personal instinct: still routed by
      // classifyNewInstinct's own "50% rule" (confidence <= 0.5 ->
      // pending), except once it has actually fired at least once
      // (existingFired below), which exempts it from ever being demoted
      // back to pending just because this resubmission's confidence
      // happens to be lower. Its original `created:` is preserved
      // (looked up from the `personal` snapshot taken at the top of this
      // run) rather than reset to now, so a summary-only backfill never
      // resets the age lib/maintain.js's decay/prune steps judge it by.
      const existing = personal.find((inst) => inst.id === fields.id);
      const createdAt = typeof existing?.created === "string" && existing.created ? existing.created : new Date().toISOString();
      const existingFired = Number(existing?.fired) || 0;
      const target = classifyNewInstinct(fields, existingFired) === "pending" ? siblingInstinctsDir(project, "pending") : project.instincts_personal;
      await writeInstinct(target, { ...fields, created: createdAt }, parsed.body);
      written += 1;
      writtenIds.push(parsed.fields.id);
    }

    const modelDescription = modelRef ? `${modelRef.providerID}/${modelRef.id}` : "host default";
    const timestamp = new Date().toISOString();
    // The board (lib/board.js) sums "run: N written, M rejected" across
    // every line it can match that prefix on, so it stays parseable; the
    // ids/rejected-reasons suffixes are appended only for the detail
    // panel's raw log tail and are never parsed back out by the board.
    const idsSuffix = writtenIds.length ? ` ids: ${writtenIds.join(",")}` : "";
    const rejectedSuffix = rejections.length ? ` rejected: ${rejections.join("; ")}` : "";
    const logLine = `${timestamp} run: ${written} written, ${rejections.length} rejected, model ${modelDescription}${idsSuffix}${rejectedSuffix}`;
    await appendLog(project.project_dir, logLine);
    await saveObserverState(project.project_dir, { lastRunAt: timestamp, lastLineCount: await countObservationLines(project.observations_file) });

    const summaryLines = [logLine];
    if (writtenIds.length) summaryLines.push(`Written: ${writtenIds.join(", ")}`);
    if (rejections.length) summaryLines.push(`Rejected: ${rejections.join("; ")}`);
    const summary = summaryLines.join("\n");

    const shouldNotify = notify ?? cfg.notify !== false;
    if (shouldNotify && sessionID) {
      try {
        await ctx.session.synthetic({
          sessionID,
          text: summary,
          description: PKG_NAME,
          delivery: "queue",
          resume: false,
        });
      } catch (error) {
        console.warn(`[${PKG_NAME}] observer notify failed`, error);
      }
    }

    return summary;
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

// Reads the tail of the observations file newest-first so the 64 KB cap
// keeps the most recent activity when the file is large, then reorders the
// kept records oldest-first because that is the order a reader (model or
// human) expects a session timeline in.
async function buildAnalysisView(observationsFile, maxLines) {
  let content;
  try {
    content = await fs.readFile(observationsFile, "utf8");
  } catch {
    return { text: "(no observations yet)", empty: true };
  }

  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  const tail = lines.slice(-maxLines);

  const newestFirst = [];
  let bytes = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const clipped = clipRecordLine(tail[i]);
    const size = Buffer.byteLength(clipped, "utf8") + 1;
    if (bytes + size > ANALYSIS_MAX_BYTES && newestFirst.length > 0) break;
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

// For personal instincts missing a `summary:` field (written before
// 0.7.0), builds a prompt section instructing the model to re-emit up to
// MAX_MISSING_SUMMARY_PER_RUN of them, unchanged apart from adding that
// one field. Returns "" when none are missing, so callers can both skip
// an otherwise-empty run (runOnceInner) and avoid appending a pointless
// empty section to the prompt.
function buildMissingSummarySection(personal) {
  const missing = personal.filter((inst) => typeof inst.summary !== "string" || inst.summary.trim().length === 0).slice(0, MAX_MISSING_SUMMARY_PER_RUN);
  if (missing.length === 0) return "";
  const lines = missing.map((inst) => `- ${inst.id} (trigger: ${inst.trigger ?? "unknown"}, confidence: ${inst.confidence ?? "?"}, domain: ${inst.domain ?? "unknown"})`);
  return [
    "",
    "## Missing Summaries",
    "",
    "These existing instincts have no `summary:` field. For every one listed below, re-emit it as a complete <instinct> block: keep its id, trigger, confidence, domain, and body exactly as given, and add only a new `summary:` line (one imperative sentence, at most 120 characters, describing what to do). Produce summaries only here; do not otherwise change these instincts.",
    "",
    lines.join("\n"),
    "",
  ].join("\n");
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
