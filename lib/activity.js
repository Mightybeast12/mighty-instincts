// Tracks "something was just observed / injected" for the sidebar's pulse
// glyph and the applied-injections-per-day counter, in a tiny JSON file
// (.activity.json) next to .observer-state.json. board-state.json is only
// refreshed every 30s (lib/board.js), too slow for a glyph that should
// reflect activity within the last 60s with some freshness; this file is
// the hand-off between the hot observation/injection paths (lib/observe.js,
// lib/inject.js) and the board's own, independently timed refresh.
import fs from "node:fs/promises";
import path from "node:path";
import { uniqueSuffix } from "./store.js";

const FILE_NAME = ".activity.json";
// How rarely lastObservedAt is flushed to disk: tool/prompt observations
// can fire many times a second, and the pulse glyph's own 60s window has
// plenty of slack for a few seconds of staleness.
const OBSERVED_WRITE_THROTTLE_MS = 10000;
// How many calendar days of per-day fired totals (firedByDay below) are
// kept and summed for the board/chat's "(N this week)" rollup; older
// days are pruned on every write so this file never grows unbounded on a
// long-running project.
const FIRED_HISTORY_DAYS = 7;
const DAY_MS = 86400000;

// One shared in-memory entry per project directory (module-level, not
// per-ctx) so lib/observe.js's throttled writes and lib/inject.js's
// immediate writes never clobber each other's half of the file; both
// mutate the same cached object before either one flushes it.
const cache = new Map();

async function getEntry(projectDir) {
  let entry = cache.get(projectDir);
  if (!entry) {
    entry = { data: await readFromDisk(projectDir), lastDiskWriteAt: 0 };
    cache.set(projectDir, entry);
  }
  return entry;
}

async function readFromDisk(projectDir) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(projectDir, FILE_NAME), "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function writeToDisk(projectDir, data) {
  await fs.mkdir(projectDir, { recursive: true });
  const file = path.join(projectDir, FILE_NAME);
  const tmp = path.join(projectDir, `.${FILE_NAME}.tmp-${uniqueSuffix()}`);
  await fs.writeFile(tmp, JSON.stringify(data), "utf8");
  await fs.rename(tmp, file);
}

function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// Called from lib/observe.js on every observation. Updates the in-memory
// value immediately but only flushes to disk once per
// OBSERVED_WRITE_THROTTLE_MS.
export async function recordObserved(projectDir) {
  const entry = await getEntry(projectDir);
  entry.data.lastObservedAt = new Date().toISOString();
  const now = Date.now();
  if (now - entry.lastDiskWriteAt < OBSERVED_WRITE_THROTTLE_MS) return;
  entry.lastDiskWriteAt = now;
  try {
    await writeToDisk(projectDir, entry.data);
  } catch {
    // Best-effort: the pulse glyph just lags a little longer.
  }
}

// Called from lib/inject.js every time instincts are actually appended to
// a prompt. Written immediately: a user prompt (and therefore an
// injection) happens nowhere near as often as a tool-call observation, so
// there is no hot-path reason to throttle this one.
export async function recordApplied(projectDir, count) {
  if (!Number.isFinite(count) || count <= 0) return;
  const entry = await getEntry(projectDir);
  const today = todayKey();
  if (entry.data.appliedDate !== today) {
    entry.data.appliedDate = today;
    entry.data.appliedToday = 0;
  }
  entry.data.appliedToday = (Number(entry.data.appliedToday) || 0) + count;
  entry.lastDiskWriteAt = Date.now();
  try {
    await writeToDisk(projectDir, entry.data);
  } catch {
    // Best-effort: "applied N today" just lags until the next write.
  }
}

// Called from lib/inject.js every time an instinct's `fired` frontmatter
// count is actually bumped (the prompt shared enough significant words
// with its trigger), for the board's "used by the agent today" row and
// (per id, see firedByIdToday below) the /board chat summary's "top
// habits used today" list. Mirrors recordApplied's date-scoping and
// immediate-write behaviour, as a distinct counter: an injected instinct
// and a fired instinct are not the same event (one can be injected
// without firing, and a pending instinct can fire without ever being
// injected). `id` is optional only so a caller with no id handy (there is
// none left in this codebase, but external callers of this module are
// not out of the question) still gets the aggregate counted.
export async function recordFired(projectDir, id, count = 1) {
  if (!Number.isFinite(count) || count <= 0) return;
  const entry = await getEntry(projectDir);
  const today = todayKey();
  if (entry.data.firedDate !== today) {
    entry.data.firedDate = today;
    entry.data.firedToday = 0;
    entry.data.firedByIdToday = {};
  }
  entry.data.firedToday = (Number(entry.data.firedToday) || 0) + count;
  if (typeof id === "string" && id.length > 0) {
    const byId = entry.data.firedByIdToday && typeof entry.data.firedByIdToday === "object" ? entry.data.firedByIdToday : {};
    byId[id] = (Number(byId[id]) || 0) + count;
    entry.data.firedByIdToday = byId;
  }
  // Per-day fired totals, for the board/chat's "(N this week)" rollup
  // (readActivitySnapshot sums the last FIRED_HISTORY_DAYS of these);
  // pruned to that same window on every write.
  const byDay = entry.data.firedByDay && typeof entry.data.firedByDay === "object" ? entry.data.firedByDay : {};
  byDay[today] = (Number(byDay[today]) || 0) + count;
  entry.data.firedByDay = pruneOldDays(byDay);
  entry.lastDiskWriteAt = Date.now();
  try {
    await writeToDisk(projectDir, entry.data);
  } catch {
    // Best-effort: "used by the agent today" just lags until the next write.
  }
}

// Drops any day-key older than FIRED_HISTORY_DAYS (a malformed or
// unparseable key is dropped too, the same defensive stance the rest of
// this file takes toward anything read back off disk).
function pruneOldDays(byDay) {
  const cutoffMs = Date.now() - FIRED_HISTORY_DAYS * DAY_MS;
  const pruned = {};
  for (const [day, count] of Object.entries(byDay)) {
    const parsed = Date.parse(day);
    if (Number.isFinite(parsed) && parsed >= cutoffMs) pruned[day] = count;
  }
  return pruned;
}

// Sums whichever of the last FIRED_HISTORY_DAYS day-keys are actually
// present in `byDay` (today inclusive); a day with no entry at all
// simply contributes nothing, rather than this needing to backfill
// zeroes for every day in the window.
function sumRecentDays(byDay) {
  const cutoffMs = Date.now() - FIRED_HISTORY_DAYS * DAY_MS;
  let sum = 0;
  for (const [day, count] of Object.entries(byDay)) {
    const parsed = Date.parse(day);
    if (Number.isFinite(parsed) && parsed >= cutoffMs) sum += Number(count) || 0;
  }
  return sum;
}

// Called from lib/board.js on every refresh. Always reads straight from
// disk (never the in-memory cache) so a refresh triggered by a different
// plugin instance, or after a restart, still sees the real last-written
// value instead of an empty cache.
export async function readActivitySnapshot(projectDir) {
  const data = await readFromDisk(projectDir);
  const today = todayKey();
  const firedIsToday = data.firedDate === today;
  const byDay = data.firedByDay && typeof data.firedByDay === "object" ? data.firedByDay : {};
  return {
    lastObservedAt: typeof data.lastObservedAt === "string" ? data.lastObservedAt : null,
    appliedToday: data.appliedDate === today ? Number(data.appliedToday) || 0 : 0,
    firedToday: firedIsToday ? Number(data.firedToday) || 0 : 0,
    // Sum of the last FIRED_HISTORY_DAYS days' fired totals (today
    // inclusive), for the board/chat's "(N this week)" rollup.
    firedThisWeek: sumRecentDays(byDay),
    // {id: count}, reset whenever firedDate rolls over; never carried past
    // midnight UTC, same as firedToday itself.
    firedByIdToday: firedIsToday && typeof data.firedByIdToday === "object" && data.firedByIdToday !== null ? data.firedByIdToday : {},
  };
}
