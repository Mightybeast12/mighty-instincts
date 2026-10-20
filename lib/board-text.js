// Text content for the board's Instincts/Observe/Evals sections, shared by
// the sidebar panel (sidebar.js, which colors and lays these out as boxes)
// and the /board command's plain-text summary (lib/board-format.js), so the
// two never disagree about what a row says. Review is not here: it only
// exists in the TUI, built from live session data (sidebar.js).
import { relativeTime } from "./relative-time.js";

// Two lines: counts, then the run/pending/next-run status.
export function instinctsLines(instincts) {
  if (!instincts) return ["unavailable"];
  const counts = `${instincts.project} proj \u00b7 ${instincts.global} global`;
  const run = instincts.lastRun ? `run ${relativeTime(instincts.lastRun)} ago` : "run never";
  const pending = `pending ${instincts.pendingObservations}`;
  const next = instincts.nextRunEligibleAt ? `next in ${relativeTime(instincts.nextRunEligibleAt)}` : "next now";
  return [`${counts}   ${run}`, `${pending} \u00b7 ${next}`];
}

// Two lines: open/parked counts, then the last review date and staged count.
export function observationsLines(observations) {
  if (!observations || observations.available === false) return ["not found"];
  const line1 = `${observations.open} open \u00b7 ${observations.parked} parked`;
  const line2 = `review ${formatLastReview(observations.lastReview)} \u00b7 ${observations.staged} staged`;
  return [line1, line2];
}

// One line: skill, iteration, pass rates, delta.
export function evalsLines(evals) {
  if (!evals || evals.available === false) return ["not found"];
  const skill = evals.skill ?? "?";
  const iteration = evals.iteration != null ? `i${evals.iteration}` : "";
  const rates = `${formatPercent(evals.withSkill)} vs ${formatPercent(evals.baseline)}`;
  const delta = formatDelta(evals.delta);
  return [[skill, iteration, rates, delta].filter(Boolean).join("  ")];
}

function formatLastReview(value) {
  if (!value || value === "never") return "never";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return `${relativeTime(value)} ago`;
}

function formatPercent(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "?";
}

function formatDelta(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}
