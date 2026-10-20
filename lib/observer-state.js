// .observer-state.json read/write and observation-file line counting,
// shared between the observer's run gate (lib/observer.js) and the board
// state builder (lib/board.js) so both agree on "observations pending
// since the last run" without duplicating the math.
import fs from "node:fs/promises";
import path from "node:path";
import { uniqueSuffix } from "./store.js";

export async function readObserverState(projectDir) {
  const file = path.join(projectDir, ".observer-state.json");
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    return { lastRunAt: parsed.lastRunAt ?? null, lastLineCount: Number(parsed.lastLineCount) || 0 };
  } catch {
    return { lastRunAt: null, lastLineCount: 0 };
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
