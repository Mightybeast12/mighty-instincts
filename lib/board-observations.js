// Reads the task-observer skill's on-disk state for the board's Skill
// observations block: the observation log's open/parked counts, the last
// backlog review date, the busiest skills named in open observations, how
// recently observations were added, and how many staged skill updates are
// still pending.
// Mirrors the shapes documented in skills/task-observer/SKILL.md (observed
// directly on disk here, read-only; this plugin never writes into that
// skill's workspace).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unquoteYaml } from "./store.js";

export const DEFAULT_OBSERVATIONS_ROOT = path.join(os.homedir(), ".local", "share", "opencode", "task-observer");

const STATUS_LINE = /^status\s*:\s*(.*)$/im;
const TITLE_LINE = /^title\s*:\s*(.*)$/im;
const SKILL_LINE = /^skill\s*:\s*\[([^\]]*)\]/im;
const DATE_LINE = /^date\s*:\s*(.*)$/im;
const DAY_ONLY_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EXCLUDED_HEADING = /\b(installed|consumed|superseded)\b/i;

const TOP_SKILLS_SHOWN = 3;
const NEWEST_SHOWN = 10;
const WARNING_OPEN_THRESHOLD = 100;
const WARNING_REVIEW_DAYS = 7;
const MS_PER_DAY = 86400000;

export async function readTaskObserverSummary(root) {
  const base = {
    open: 0,
    parked: 0,
    lastReview: null,
    staged: 0,
    root,
    available: false,
    topSkills: [],
    skills: [],
    addedToday: 0,
    added7d: 0,
    newestAt: null,
    newestTitle: null,
    newest: [],
    warning: false,
  };
  if (!(await pathExists(root))) return base;
  base.available = true;

  const scan = await scanObservationLog(path.join(root, "skill-observations", "observation-log"));
  base.open = scan.open;
  base.parked = scan.parked;
  base.lastReview = await readTrimmed(path.join(root, "skill-observations", "last-review-date.txt"));
  base.staged = await countStagedHeadings(path.join(root, "skill-updates", "PENDING.md"));

  base.skills = sortSkillCounts(scan.skillTally);
  base.topSkills = base.skills.slice(0, TOP_SKILLS_SHOWN);
  base.addedToday = scan.addedToday;
  base.added7d = scan.added7d;
  base.newestAt = scan.newest?.at ?? null;
  base.newestTitle = scan.newest?.title ?? null;
  base.newest = scan.newestList.slice(0, NEWEST_SHOWN);
  base.warning = base.open > WARNING_OPEN_THRESHOLD && isReviewStale(base.lastReview);
  return base;
}

// One pass over every observation file: status (for open/parked), the
// skill list and date (for the open-backlog facts below), and mtime (the
// fallback "when" for a day-only `date:` value). Reads every file's
// frontmatter once instead of the three separate directory walks a
// straightforward port of the old status-only counter plus three new
// helpers would otherwise need.
async function scanObservationLog(logDir) {
  let entries;
  try {
    entries = await fs.readdir(logDir, { withFileTypes: true });
  } catch {
    return { open: 0, parked: 0, skillTally: new Map(), addedToday: 0, added7d: 0, newest: null, newestList: [] };
  }

  let open = 0;
  let parked = 0;
  const skillTally = new Map();
  let addedToday = 0;
  let added7d = 0;
  let newest = null;
  const newestList = [];
  const now = Date.now();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = path.join(logDir, entry.name);
    const parsed = await readObservationFrontmatter(file);
    if (!parsed) continue;

    if (parsed.status === "open") open += 1;
    else if (parsed.status === "parked") parked += 1;
    // Any other status (e.g. resolved) counts in neither bucket.
    if (parsed.status !== "open") continue;

    for (const skill of parsed.skills) {
      skillTally.set(skill, (skillTally.get(skill) ?? 0) + 1);
    }

    if (parsed.date) {
      const days = daysSince(parsed.date, now);
      if (days !== null) {
        if (days === 0) addedToday += 1;
        if (days >= 0 && days < 7) added7d += 1;
      }
      newestList.push({ title: parsed.title ?? null, date: parsed.date });

      const sortKey = Date.parse(parsed.date);
      if (!Number.isNaN(sortKey)) {
        const candidate = { sortKey, mtimeMs: parsed.mtimeMs, title: parsed.title ?? null, date: parsed.date };
        if (!newest || candidate.sortKey > newest.sortKey || (candidate.sortKey === newest.sortKey && candidate.mtimeMs > newest.mtimeMs)) {
          newest = candidate;
        }
      }
    }
  }

  newestList.sort((a, b) => {
    const diff = (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0);
    return diff;
  });

  let newestAt = null;
  if (newest) {
    // A day-only `date:` has no useful time component, so the age shown
    // ("newest 2h") comes from the file's own mtime instead; a full
    // timestamp (if a future writer ever provides one) is used as-is.
    newestAt = DAY_ONLY_DATE.test(newest.date) ? new Date(newest.mtimeMs).toISOString() : newest.date;
  }

  return { open, parked, skillTally, addedToday, added7d, newest: newest ? { at: newestAt, title: newest.title } : null, newestList };
}

async function readObservationFrontmatter(file) {
  let content;
  let mtimeMs;
  try {
    const [fileContent, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
    content = fileContent;
    mtimeMs = stat.mtimeMs;
  } catch {
    return null;
  }
  const frontmatter = extractFrontmatter(content);
  const statusMatch = STATUS_LINE.exec(frontmatter);
  const titleMatch = TITLE_LINE.exec(frontmatter);
  const dateMatch = DATE_LINE.exec(frontmatter);
  return {
    // "open" or no `status:` line at all both count as open (per the
    // skill's own convention).
    status: statusMatch ? statusMatch[1].trim().toLowerCase() : "open",
    title: titleMatch ? unquoteYaml(titleMatch[1].trim()) : null,
    date: dateMatch ? dateMatch[1].trim() : null,
    skills: parseSkillList(frontmatter),
    mtimeMs,
  };
}

function parseSkillList(frontmatter) {
  const match = SKILL_LINE.exec(frontmatter);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((entry) => unquoteYaml(entry.trim()))
    .filter((entry) => entry.length > 0);
}

function sortSkillCounts(tally) {
  return [...tally.entries()]
    .map(([skill, count]) => ({ skill, count }))
    .sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill));
}

function daysSince(dateValue, now) {
  const parsed = Date.parse(dateValue);
  if (Number.isNaN(parsed)) return null;
  return Math.floor((now - parsed) / MS_PER_DAY);
}

export function isReviewStale(lastReview) {
  if (!lastReview) return true;
  const parsed = Date.parse(lastReview);
  if (Number.isNaN(parsed)) return true;
  return (Date.now() - parsed) / MS_PER_DAY > WARNING_REVIEW_DAYS;
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
