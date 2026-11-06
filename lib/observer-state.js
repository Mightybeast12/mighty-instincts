// .observer-state.json read/write and observation-file line counting,
// shared between the observer's run gate (lib/observer.js) and the board
// state builder (lib/board.js) so both agree on "observations pending
// since the last run" without duplicating the math.
import fs from "node:fs/promises";
import path from "node:path";
import { uniqueSuffix } from "./store.js";

// Every field this plugin persists in .observer-state.json, with its
// default when the field is missing (an old file written before a field
// existed, or a brand-new project with no file yet). lib/observer.js
// reads the whole object through here and writes it back the same way,
// always passing every field (saveObserverState itself performs no
// merge: it writes exactly the object it is given), so a write that
// forgot a field would silently drop it rather than keeping the old
// value.
export async function readObserverState(projectDir) {
  const file = path.join(projectDir, ".observer-state.json");
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    return {
      lastRunAt: parsed.lastRunAt ?? null,
      lastLineCount: Number(parsed.lastLineCount) || 0,
      // lastAttemptAt covers both successful and failed attempts;
      // lastRunAt (above) only ever moves on a successful one.
      lastAttemptAt: parsed.lastAttemptAt ?? null,
      // Consecutive ctx.generate.text failures since the last success;
      // drives the backoff schedule in lib/observer.js.
      failures: Number(parsed.failures) || 0,
      // ISO timestamp before which the backoff schedule forbids another
      // attempt; null means no backoff is currently in effect.
      nextAttemptAfter: parsed.nextAttemptAfter ?? null,
      // Set to "model-unset" once a run has detected observer.model is
      // not configured (and the one-time notice for that has already
      // been posted/logged); cleared again on the next successful run.
      blocked: parsed.blocked ?? null,
      // The `written` count of the last up to 2 completed runs (oldest
      // first), used by the zero-write damper in lib/observer.js's
      // thresholdsMet().
      lastWrittenCounts: Array.isArray(parsed.lastWrittenCounts) ? parsed.lastWrittenCounts.map((n) => Number(n) || 0) : [],
    };
  } catch {
    return { lastRunAt: null, lastLineCount: 0, lastAttemptAt: null, failures: 0, nextAttemptAfter: null, blocked: null, lastWrittenCounts: [] };
  }
}

export async function saveObserverState(projectDir, state) {
  await fs.mkdir(projectDir, { recursive: true });
  const file = path.join(projectDir, ".observer-state.json");
  const tmp = path.join(projectDir, `.observer-state.json.tmp-${uniqueSuffix()}`);
  await fs.writeFile(tmp, JSON.stringify(state), "utf8");
  await fs.rename(tmp, file);
}

export async function countObservationLines(file) {
  try {
    const content = await fs.readFile(file, "utf8");
    return content.split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

// Observations appended since the last observer run. The observations file
// rotates to observations.archive/ at 10 MB (lib/store.js); a smaller count
// than last time means that happened, not that observations were deleted,
// so the baseline resets to zero instead of going negative.
export function pendingSince(state, currentLineCount) {
  const effectiveLast = currentLineCount < state.lastLineCount ? 0 : state.lastLineCount;
  return Math.max(0, currentLineCount - effectiveLast);
}
