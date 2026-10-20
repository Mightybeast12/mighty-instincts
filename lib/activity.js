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

// Called from lib/board.js on every refresh. Always reads straight from
// disk (never the in-memory cache) so a refresh triggered by a different
// plugin instance, or after a restart, still sees the real last-written
// value instead of an empty cache.
export async function readActivitySnapshot(projectDir) {
  const data = await readFromDisk(projectDir);
  const today = todayKey();
  return {
    lastObservedAt: typeof data.lastObservedAt === "string" ? data.lastObservedAt : null,
    appliedToday: data.appliedDate === today ? Number(data.appliedToday) || 0 : 0,
  };
}
