// Reads the task-observer skill's on-disk state for the board's Observe
// section: the observation log's open/parked counts, the last backlog
// review date, and how many staged skill updates are still pending.
// Mirrors the shapes documented in skills/task-observer/SKILL.md (observed
// directly on disk here, read-only; this plugin never writes into that
// skill's workspace).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_OBSERVATIONS_ROOT = path.join(os.homedir(), ".local", "share", "opencode", "task-observer");

const STATUS_LINE = /^status\s*:\s*(.*)$/im;
const EXCLUDED_HEADING = /\b(installed|consumed|superseded)\b/i;

export async function readTaskObserverSummary(root) {
  const base = { open: 0, parked: 0, lastReview: null, staged: 0, root, available: false };
  if (!(await pathExists(root))) return base;
  base.available = true;

  const counts = await countByStatus(path.join(root, "skill-observations", "observation-log"));
  base.open = counts.open;
  base.parked = counts.parked;
  base.lastReview = await readTrimmed(path.join(root, "skill-observations", "last-review-date.txt"));
  base.staged = await countStagedHeadings(path.join(root, "skill-updates", "PENDING.md"));
  return base;
}

async function countByStatus(logDir) {
  let entries;
  try {
    entries = await fs.readdir(logDir, { withFileTypes: true });
  } catch {
    return { open: 0, parked: 0 };
  }
  let open = 0;
  let parked = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const status = await frontmatterStatus(path.join(logDir, entry.name));
    if (status === "open") open += 1;
    else if (status === "parked") parked += 1;
    // Any other status (e.g. resolved) counts in neither bucket.
  }
  return { open, parked };
}

// "open" or no `status:` line at all both count as open (per the skill's
// own convention); only the frontmatter block is searched, not the whole
// file, so a status-looking word in the observation body never matches.
async function frontmatterStatus(file) {
  let content;
  try {
    content = await fs.readFile(file, "utf8");
  } catch {
    return "open";
  }
  const frontmatter = extractFrontmatter(content);
  const match = STATUS_LINE.exec(frontmatter);
  return match ? match[1].trim().toLowerCase() : "open";
}

function extractFrontmatter(content) {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return "";
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return lines.slice(1, i).join("\n");
  }
  return lines.slice(1).join("\n");
}

async function readTrimmed(file) {
  try {
    return (await fs.readFile(file, "utf8")).trim();
  } catch {
    return null;
  }
}

// A heading is "staged" (still waiting to be installed) unless its own
// line says it was installed, consumed, or superseded already.
async function countStagedHeadings(file) {
  let content;
  try {
    content = await fs.readFile(file, "utf8");
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of content.split("\n")) {
    if (!line.startsWith("## ")) continue;
    if (!EXCLUDED_HEADING.test(line)) count += 1;
  }
  return count;
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
