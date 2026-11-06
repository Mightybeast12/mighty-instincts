// Small persisted toggles for the `/instinct` command family (lib/commands-instinct.js):
// whether the background observer is on, and which instinct ids are
// muted (skipped by injection even when a personal/inherited/global copy
// would otherwise qualify). Lives at `<project.project_dir>/.settings.json`,
// written atomically (tmp file + rename, mirroring lib/store.js's own
// writes) so a crash mid-write never leaves a half-written file behind,
// and tolerant of a missing or corrupt file: both read back as the same
// empty defaults, never thrown.
import fs from "node:fs/promises";
import path from "node:path";
import { uniqueSuffix } from "./store.js";

export const SETTINGS_FILE_NAME = ".settings.json";

export function settingsFilePath(projectDir) {
  return path.join(projectDir, SETTINGS_FILE_NAME);
}

function defaultSettings() {
  return { observer: {}, muted: [] };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Normalises whatever JSON.parse handed back into the one shape every
// caller can rely on: `{ observer: { enabled?: boolean }, muted: string[] }`.
// A field of the wrong shape (an `observer` that isn't an object, a
// `muted` that isn't an array, a non-string/empty entry inside it) is
// dropped rather than passed through, the same defensive stance
// lib/observer-state.js takes toward its own on-disk state.
function normalizeSettings(parsed) {
  if (!isPlainObject(parsed)) return defaultSettings();
  const observer = isPlainObject(parsed.observer) ? parsed.observer : {};
  const muted = Array.isArray(parsed.muted) ? parsed.muted.filter((id) => typeof id === "string" && id.length > 0) : [];
  return {
    observer: typeof observer.enabled === "boolean" ? { enabled: observer.enabled } : {},
    muted,
  };
}

// Missing file (never configured yet) or corrupt JSON (hand-edited, or an
// interrupted write on a filesystem that doesn't support atomic rename):
// both read back as the same empty defaults rather than throwing, so
// every caller (lib/commands.js's registerCommands, lib/inject.js's own
// muted-list read) can treat "no settings yet" and "settings I just
// can't parse" identically.
export async function readSettings(projectDir) {
  try {
    const parsed = JSON.parse(await fs.readFile(settingsFilePath(projectDir), "utf8"));
    return normalizeSettings(parsed);
  } catch {
    return defaultSettings();
  }
}

export async function writeSettings(projectDir, next) {
  const normalized = normalizeSettings(next);
  // De-duplicated, but order otherwise left alone (not sorted): the
  // order a caller built `muted` in (e.g. "existing ids, then the one
  // just added") is more useful to read back in a hand-edited file than
  // an alphabetised one would be.
  const seen = new Set();
  const muted = normalized.muted.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
  const payload = { observer: normalized.observer, muted };

  const file = settingsFilePath(projectDir);
  const tmp = path.join(projectDir, `.${SETTINGS_FILE_NAME}.tmp-${uniqueSuffix()}`);
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
  return payload;
}

// Applies a persisted settings snapshot to the live, in-memory `options`
// object lib/commands.js's registerCommands was given. lib/plugin.js's
// mergeOptions always spreads the frozen OBSERVER_DEFAULTS (lib/observer.js)
// into a *fresh* object for `options.observer` on every setup() call
// (verified directly in lib/plugin.js: `observer: { ...DEFAULT_OPTIONS.observer,
// ...(source.observer ?? {}) }`), and that same fresh object, not a copy
// taken once at startup, is what the running observer (lib/observer.js)
// and the board (lib/board.js) read on every call, by reference. So
// replacing `options.observer` with a new object here is enough for a
// setting persisted from a previous process to take effect immediately
// on this one, with no extra wiring and no restart required; replacing
// it (rather than mutating `options.observer.enabled` in place) also
// means this never throws when `options.observer` happens to be frozen
// or missing, since spreading `null`/`undefined`/a frozen object into a
// fresh object literal always produces a plain, writable one.
//
// Returns the muted list, for a caller (lib/inject.js) that wants it
// without a second disk read of its own.
export function applyRuntimeSettings(options, settings) {
  if (typeof settings?.observer?.enabled === "boolean") {
    options.observer = { ...options.observer, enabled: settings.observer.enabled };
  }
  return Array.isArray(settings?.muted) ? settings.muted : [];
}
