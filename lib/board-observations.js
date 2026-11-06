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
    pendingPath: null,
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
  base.pendingPath = path.join(root, "skill-updates", "PENDING.md");
  base.staged = await countStagedHeadings(base.pendingPath);

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

// ----------------------------------------------------------------- cache
//
// Reading and parsing every observation file's own frontmatter (hundreds
// of small files on a long-lived project) every single board refresh is
// the expensive part; cached here per file, keyed by (directory, file
// name, size, mtimeMs). The task-observer skill, not this plugin, writes
// these files, with no guarantee it always replaces one by write-tmp-
// then-rename rather than editing in place, so the cache key is each
// file's own stat, never the containing directory's: a file rewritten in
// place (same name, new content, no rename) still changes its own size
// or mtimeMs and is seen on the very next call. The aggregate counts
// built from this per-file data (open/parked, the skill tally, and
// especially addedToday/added7d, both relative to "now") are never
// cached themselves: scanObservationLog recomputes them on every call
// from whichever per-file data (cached or freshly parsed) the current
// directory listing produces, so they never freeze at whatever "today"
// happened to be when a file was first read.
const frontmatterCache = new Map(); // logDir -> Map(fileName -> { size, mtimeMs, parsed })
let frontmatterReads = 0;

// Test seam only: lets a test assert that an unchanged observation file
// is never re-read on a second call, and that a changed one (including
// one rewritten in place, with no rename) is seen on the next.
export function _observationsCacheStats() {
  return { frontmatterReads };
}
export function _resetObservationsCache() {
  frontmatterReads = 0;
  frontmatterCache.clear();
}

async function readObservationFrontmatterCached(logDir, fileName) {
  const filePath = path.join(logDir, fileName);
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }
  const dirCache = frontmatterCache.get(logDir);
  const cached = dirCache?.get(fileName);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.parsed;

  frontmatterReads += 1;
  const parsed = await readObservationFrontmatter(filePath, stat.mtimeMs);
  const nextDirCache = dirCache ?? new Map();
  nextDirCache.set(fileName, { size: stat.size, mtimeMs: stat.mtimeMs, parsed });
  frontmatterCache.set(logDir, nextDirCache);
  return parsed;
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
  const touched = new Set();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    touched.add(entry.name);
    const parsed = await readObservationFrontmatterCached(logDir, entry.name);
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

  // Evicts any cached file this pass never saw (deleted, renamed, or
  // moved out from under this directory since the last call), so the
  // cache never keeps tracking files that no longer exist.
  const dirCache = frontmatterCache.get(logDir);
  if (dirCache) {
    for (const fileName of dirCache.keys()) {
      if (!touched.has(fileName)) dirCache.delete(fileName);
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

async function readObservationFrontmatter(filePath, mtimeMs) {
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
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
