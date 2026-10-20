// Observation and instinct-file persistence. Mirrors ECC's on-disk shapes
// (observations.jsonl records, YAML-frontmatter instinct markdown) closely
// enough that instinct-cli.py reads what this plugin writes without change.
import fs from "node:fs/promises";
import path from "node:path";
import { clip, scrub } from "./scrub.js";

const MAX_OBSERVATIONS_BYTES = 10 * 1024 * 1024;
const FIELD_CLIP_CHARS = 5000;
const SCRUBBED_FIELDS = ["input", "output", "text"];
const INSTINCT_FILE_PATTERN = /\.(md|ya?ml)$/i;
const SUMMARY_CLIP_CHARS = 120;

export async function appendObservation(project, record, fieldClipChars = {}) {
  const file = project.observations_file;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await archiveIfOversized(file);

  const clean = { ...record, timestamp: new Date().toISOString() };
  for (const field of SCRUBBED_FIELDS) {
    if (typeof clean[field] === "string") {
      clean[field] = clip(scrub(clean[field]), fieldClipChars[field] ?? FIELD_CLIP_CHARS);
    }
  }

  await fs.appendFile(file, `${JSON.stringify(clean)}\n`, "utf8");
}

async function archiveIfOversized(file) {
  let size = 0;
  try {
    size = (await fs.stat(file)).size;
  } catch {
    return;
  }
  if (size < MAX_OBSERVATIONS_BYTES) return;

  const archiveDir = path.join(path.dirname(file), "observations.archive");
  await fs.mkdir(archiveDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archivePath = path.join(archiveDir, `observations-${stamp}-${process.pid}.jsonl`);
  try {
    await fs.rename(file, archivePath);
  } catch (error) {
    // Two appends crossing the threshold together both see the oversize
    // file; the second rename finds it already moved. The append proceeds.
    if (error?.code !== "ENOENT") throw error;
  }
}

// pid plus clock collided when concurrent writers raced inside one
// millisecond; a counter makes the name unique within the process.
let tmpCounter = 0;
export function uniqueSuffix() {
  tmpCounter += 1;
  return `${process.pid}-${Date.now()}-${tmpCounter}`;
}

// Each returned instinct object also carries `mtimeMs` (the file's own
// mtime): the board's "newest instinct" fact (lib/board.js) needs it, and a
// file can hold several frontmatter blocks (see parseFrontmatterBlocks),
// which all share their one file's mtime. `filePath` is carried too, for
// lib/maintain.js's steps (promote/decay/repair/dedupe), which need to read
// and rewrite the exact file a candidate instinct came from.
export async function listInstincts(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = [];
  for (const entry of entries) {
    if (!entry.isFile() || !INSTINCT_FILE_PATTERN.test(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    let content;
    let mtimeMs = null;
    try {
      const [fileContent, stat] = await Promise.all([fs.readFile(filePath, "utf8"), fs.stat(filePath)]);
      content = fileContent;
      mtimeMs = stat.mtimeMs;
    } catch {
      continue;
    }
    for (const block of parseFrontmatterBlocks(content)) {
      results.push({ ...block, mtimeMs, filePath });
    }
  }
  return results;
}

// A single file can hold several `---`-delimited blocks (ECC's import/export
// batches multiple instincts into one file), so this walks the whole file
// rather than assuming one frontmatter pair per file.
export function parseFrontmatterBlocks(content) {
  const blocks = [];
  let current = null;
  let inFrontmatter = false;

  for (const line of content.split("\n")) {
    if (line.trim() === "---") {
      if (inFrontmatter) {
        inFrontmatter = false;
      } else {
        if (current) blocks.push(current);
        current = {};
        inFrontmatter = true;
      }
      continue;
    }
    if (inFrontmatter && current) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const rawValue = line.slice(idx + 1).trim();
      if (key === "confidence") current[key] = parseConfidence(rawValue);
      else if (key === "fired") current[key] = parseFired(rawValue);
      else current[key] = unquoteYaml(rawValue);
    }
  }
  if (current) blocks.push(current);
  return blocks.filter((block) => block.id);
}

function parseConfidence(rawValue) {
  const value = Number(unquoteYaml(rawValue));
  return Number.isFinite(value) ? value : 0.5;
}

function parseFired(rawValue) {
  const value = Number(unquoteYaml(rawValue));
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function unquoteYaml(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

export function yamlQuote(value) {
  const escaped = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

// Fields written in this fixed order when present; `undefined`/`null`
// fields are omitted so older callers (id/trigger/confidence/domain/
// source/scope/project_id/project_name only) keep writing the same header
// as before 0.7.0. The 0.7.0 additions (summary/created/decayed_at/fired)
// let lib/maintain.js's steps and the observer's summary backfill rewrite
// an instinct file through this one function instead of hand-patching
// frontmatter lines.
const FIELD_ORDER = ["id", "trigger", "confidence", "domain", "source", "scope", "project_id", "project_name", "summary", "created", "decayed_at", "fired"];
const QUOTED_FIELDS = new Set(["trigger", "summary"]);

export async function writeInstinct(dir, fields, body) {
  await fs.mkdir(dir, { recursive: true });

  const header = ["---"];
  for (const key of FIELD_ORDER) {
    const value = fields[key];
    if (value === undefined || value === null || value === "") continue;
    header.push(QUOTED_FIELDS.has(key) ? `${key}: ${yamlQuote(value)}` : `${key}: ${value}`);
  }
  header.push("---", "");

  const content = `${header.join("\n")}${String(body ?? "").trim()}\n`;
  const filePath = path.join(dir, `${fields.id}.md`);
  const tmpPath = path.join(dir, `.${fields.id}.md.tmp-${uniqueSuffix()}`);
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, filePath);
  return filePath;
}

// The instinct's own markdown body, with its YAML frontmatter block
// removed. Shared by lib/inject.js (summary fallback) and lib/maintain.js
// (decay/repair/dedupe/promote, which all read-modify-write a whole file).
export function stripFrontmatter(content) {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return content;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return lines.slice(i + 1).join("\n");
  }
  return content;
}

// First line of an instinct's `## Action` section, or (when that section
// is missing or empty) its `# Title` line. The oldest, loosest fallback:
// used only when neither a `summary:` field nor a same-sentence `##
// Action` fallback (firstActionSentence, below) produced anything.
export function summarizeInstinctBody(body) {
  const lines = body.split("\n");
  let title = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (title === null && /^#\s+\S/.test(line)) title = line.replace(/^#\s+/, "").trim();
    if (/^##\s+Action\b/i.test(line)) {
      for (let j = i + 1; j < lines.length; j++) {
        const candidate = lines[j].trim();
        if (/^##\s+/.test(lines[j])) break;
        if (candidate.length > 0) return candidate.replace(/^[-*]\s*/, "");
      }
      break;
    }
  }
  return title ?? "";
}

export function clipSummary(text, maxChars = SUMMARY_CLIP_CHARS) {
  const trimmed = String(text ?? "").trim();
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

// The `summary:` fallback lib/inject.js uses for an instinct written before
// 0.7.0 (no `summary:` field of its own): the first sentence of the `##
// Action` section (every non-heading line joined, then clipped at the
// first sentence-ending punctuation), clipped to `maxChars`. Falls back to
// `summarizeInstinctBody` (the whole first Action line, or the title) when
// there is no Action section to sentence-split at all.
export function firstActionSentence(body, maxChars = SUMMARY_CLIP_CHARS) {
  const lines = String(body ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^##\s+Action\b/i.test(lines[i])) continue;
    const collected = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^##\s+/.test(lines[j])) break;
      const candidate = lines[j].trim();
      if (candidate.length > 0) collected.push(candidate.replace(/^[-*]\s*/, ""));
    }
    const joined = collected.join(" ");
    if (!joined) break;
    const sentenceMatch = /^[^.!?]*[.!?]/.exec(joined);
    return clipSummary(sentenceMatch ? sentenceMatch[0] : joined, maxChars);
  }
  return clipSummary(summarizeInstinctBody(body), maxChars);
}

// The one-line gist lib/inject.js's injected `<instincts>` block uses for
// an instinct: its own `summary:` frontmatter field when present (clipped
// defensively, in case an older write predates the 160-char validation),
// else `firstActionSentence` read straight off disk.
export async function readInstinctSummaryLine(dir, id, frontmatterSummary) {
  if (typeof frontmatterSummary === "string" && frontmatterSummary.trim().length > 0) {
    return clipSummary(frontmatterSummary);
  }
  let content;
  try {
    content = await fs.readFile(path.join(dir, `${id}.md`), "utf8");
  } catch {
    return "";
  }
  return firstActionSentence(stripFrontmatter(content));
}

// Atomically increments (or adds, starting at 1) the `fired:` frontmatter
// field on the one block, in one file under `dir`, whose `id:` matches.
// `dir` can hold several instinct files, and (ECC import/export batches)
// a single file can hold several `---`-delimited blocks; every other
// line, including any other block sharing the file, passes through
// unchanged. Returns true when a matching block was found and updated.
export async function bumpFiredCount(dir, id) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !INSTINCT_FILE_PATTERN.test(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    let content;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const updated = incrementFiredInContent(content, id);
    if (updated === null) continue;
    const tmpPath = path.join(dir, `.${entry.name}.tmp-${uniqueSuffix()}`);
    await fs.writeFile(tmpPath, updated, "utf8");
    await fs.rename(tmpPath, filePath);
    return true;
  }
  return false;
}

// Returns the rewritten file content with `fired:` bumped inside the one
// block whose `id:` matches, or null when this file holds no such block.
function incrementFiredInContent(content, id) {
  const lines = content.split("\n");
  let inFrontmatter = false;
  let blockId = null;
  let firedLineIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "---") {
      if (!inFrontmatter) {
        inFrontmatter = true;
        blockId = null;
        firedLineIndex = -1;
        continue;
      }
      inFrontmatter = false;
      if (blockId === id) {
        if (firedLineIndex !== -1) {
          const idx = lines[firedLineIndex].indexOf(":");
          const current = Number(unquoteYaml(lines[firedLineIndex].slice(idx + 1).trim())) || 0;
          lines[firedLineIndex] = `fired: ${current + 1}`;
        } else {
          lines.splice(i, 0, "fired: 1");
        }
        return lines.join("\n");
      }
      continue;
    }
    if (inFrontmatter) {
      const idx = lines[i].indexOf(":");
      if (idx === -1) continue;
      const key = lines[i].slice(0, idx).trim();
      if (key === "id") blockId = unquoteYaml(lines[i].slice(idx + 1).trim());
      if (key === "fired") firedLineIndex = i;
    }
  }
  return null;
}
