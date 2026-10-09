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
    let content;
    try {
      content = await fs.readFile(path.join(dir, entry.name), "utf8");
    } catch {
      continue;
    }
    results.push(...parseFrontmatterBlocks(content));
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
      current[key] = key === "confidence" ? parseConfidence(rawValue) : unquoteYaml(rawValue);
    }
  }
  if (current) blocks.push(current);
  return blocks.filter((block) => block.id);
}

function parseConfidence(rawValue) {
  const value = Number(unquoteYaml(rawValue));
  return Number.isFinite(value) ? value : 0.5;
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

export async function writeInstinct(dir, fields, body) {
  await fs.mkdir(dir, { recursive: true });

  const header = [
    "---",
    `id: ${fields.id}`,
    `trigger: ${yamlQuote(fields.trigger)}`,
    `confidence: ${fields.confidence}`,
    `domain: ${fields.domain}`,
    `source: ${fields.source ?? "session-observation"}`,
    `scope: ${fields.scope ?? "project"}`,
  ];
  if (fields.project_id) header.push(`project_id: ${fields.project_id}`);
  if (fields.project_name) header.push(`project_name: ${fields.project_name}`);
  header.push("---", "");

  const content = `${header.join("\n")}${String(body ?? "").trim()}\n`;
  const filePath = path.join(dir, `${fields.id}.md`);
  const tmpPath = path.join(dir, `.${fields.id}.md.tmp-${uniqueSuffix()}`);
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, filePath);
  return filePath;
}
