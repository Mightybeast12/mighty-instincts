// Background instinct distillation. Replaces ECC's observer-loop.sh +
// observer.md Claude-Code-agent pair with a single in-process generate.text
// call: the model has no tools here, so this module parses its markdown
// output and writes the instinct files itself.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProject } from "./project.js";
import { listInstincts, uniqueSuffix, unquoteYaml, writeInstinct } from "./store.js";
import { clip } from "./scrub.js";

const OBSERVER_TEMPLATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor", "ecc", "observer.md");
const ANALYSIS_RECORD_CLIP_CHARS = 400;
const ANALYSIS_MAX_BYTES = 64 * 1024;
const MAX_INSTINCTS_PER_RUN = 10;
const INSTINCT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
// How long a counted line count stays valid for the threshold gate: the
// gate runs on every observed tool call / prompt, and re-reading and
// re-splitting the whole observations file that often is wasted work once
// the file has any real size.
const COUNT_THROTTLE_MS = 30000;

const OUTPUT_CONTRACT =
  "Output each instinct as a complete markdown document wrapped in `<instinct>` and `</instinct>` tags: " +
  "YAML frontmatter between `---` lines with id, trigger, confidence, domain, then `# Title`, `## Action`, `## Evidence`. " +
  "Never use a `---` line inside the body. Output `<none/>` and nothing else when no pattern has 3+ observations. " +
  "Do not include code snippets, file contents, or secrets.";

let cachedTemplate;

export function createObserver(ctx, options) {
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
      console.warn("[opencode-instincts] observer.maybeRun failed", error);
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
    const state = await readState(project.project_dir);
    const intervalMs = cfg.runIntervalMinutes * 60000;
    if (state.lastRunAt && Date.now() - new Date(state.lastRunAt).getTime() < intervalMs) {
      return false;
    }

    const currentLineCount = await throttledCountLines(project.observations_file);
    // The observations file rotates to observations.archive/ at 10 MB
    // (lib/store.js); a smaller count than last time means that happened,
    // not that observations were deleted, so the "new since last run"
    // baseline resets to zero instead of going negative.
    const effectiveLast = currentLineCount < state.lastLineCount ? 0 : state.lastLineCount;
    return currentLineCount - effectiveLast >= cfg.minObservations;
  }

  async function throttledCountLines(file) {
    const now = Date.now();
    if (lineCountCache && lineCountCache.file === file && now - lineCountCache.at < COUNT_THROTTLE_MS) {
      return lineCountCache.count;
    }
    const count = await countLines(file);
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
    const project = await resolveProject(ctx, options);
    // mergeOptions (lib/plugin.js) always fills options.observer and every
    // field on it before setup() ever creates this observer, so there is
    // no missing-field case left to fall back from here.
    const cfg = options.observer;
    const maxLines = cfg.maxAnalysisLines;

    const view = await buildAnalysisView(project.observations_file, maxLines);
    if (view.empty) {
      const summary = "No observations recorded yet; nothing to analyse.";
      await appendLog(project.project_dir, `${new Date().toISOString()} run skipped: no observations`);
      return summary;
    }
    const personal = await listInstincts(project.instincts_personal);
    const inherited = await listInstincts(project.instincts_inherited);
    const inheritedIds = new Set(inherited.map((inst) => inst.id));

    const template = await readObserverTemplate();
    const prompt = buildObserverPrompt(template, formatExisting([...personal, ...inherited]), view.text);

    const modelRef = parseModelRef(cfg.model);
    const generateArgs = { prompt };
    if (modelRef) {
      generateArgs.model = modelRef;
    } else if (!warnedNoModel) {
      warnedNoModel = true;
      console.warn("[opencode-instincts] observer.model is not set; generate.text will use the host's default model");
    }

    const { text } = await ctx.generate.text(generateArgs);
    const blocks = extractInstinctBlocks(text ?? "");

    let written = 0;
    const writtenIds = [];
    const rejections = [];
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
      await writeInstinct(
        project.instincts_personal,
        {
          ...parsed.fields,
          source: "session-observation",
          scope: "project",
          project_id: project.id,
          project_name: project.name,
        },
        parsed.body,
      );
      written += 1;
      writtenIds.push(parsed.fields.id);
    }

    const modelDescription = modelRef ? `${modelRef.providerID}/${modelRef.id}` : "host default";
    const timestamp = new Date().toISOString();
    const logLine = `${timestamp} run: ${written} written, ${rejections.length} rejected, model ${modelDescription}`;
    await appendLog(project.project_dir, logLine);
    await saveState(project.project_dir, { lastRunAt: timestamp, lastLineCount: await countLines(project.observations_file) });

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
          description: "opencode-instincts",
          delivery: "queue",
          resume: false,
        });
      } catch (error) {
        console.warn("[opencode-instincts] observer notify failed", error);
      }
    }

    return summary;
  }

  // `_countLineReads` is a test seam only (smoke-test.mjs uses it to prove
  // the interval gate short-circuits before touching the observations
  // file); nothing in this module's own control flow depends on it.
  return { maybeRun, run, _countLineReads: () => lineCountReads };
}

async function countLines(file) {
  try {
    const content = await fs.readFile(file, "utf8");
    return content.split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

async function readState(projectDir) {
  const file = path.join(projectDir, ".observer-state.json");
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    return { lastRunAt: parsed.lastRunAt ?? null, lastLineCount: Number(parsed.lastLineCount) || 0 };
  } catch {
    return { lastRunAt: null, lastLineCount: 0 };
  }
}

async function saveState(projectDir, state) {
  await fs.mkdir(projectDir, { recursive: true });
  const file = path.join(projectDir, ".observer-state.json");
  const tmp = path.join(projectDir, `.observer-state.json.tmp-${uniqueSuffix()}`);
  await fs.writeFile(tmp, JSON.stringify(state), "utf8");
  await fs.rename(tmp, file);
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

function parseModelRef(spec) {
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

function parseInstinctBlock(block) {
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
  const confidence = Number(fields.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { error: `${fields.id}: invalid confidence '${fields.confidence}'` };
  }
  if (!fields.domain) return { error: `${fields.id}: missing domain` };

  return {
    fields: { id: fields.id, trigger: fields.trigger, confidence, domain: fields.domain },
    body: bodyLines.join("\n").trim(),
  };
}
