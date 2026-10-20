// Text content for the board's Instincts / Skill observations / Skill
// evals blocks, shared by the sidebar panel (sidebar.js, which colors and
// lays these out as boxes) and the /board command's plain-text summary
// (lib/board-format.js), so the two never disagree about what a block
// says.
import { relativeTime } from "./relative-time.js";

// Static tool names for the two blocks backed by another skill's on-disk
// state. Instincts has no fixed tool name of its own (see
// instinctsToolName): which model the observer runs is configurable.
export const OBSERVATIONS_TOOL = "task-observer";
export const EVALS_TOOL = "skill-creator";

// "haiku observer" when the configured observer model is a haiku variant,
// the last path segment of the model id otherwise (e.g. "claude-opus-4-1"
// from "anthropic/claude-opus-4-1"), or "observer" when no model is set.
export function instinctsToolName(instincts) {
  const model = instincts?.model;
  if (typeof model !== "string" || model.length === 0) return "observer";
  if (model.toLowerCase().includes("haiku")) return "haiku observer";
  const segments = model.split("/");
  return segments[segments.length - 1] || "observer";
}

// Two lines: how many instincts exist and where, then the observer's run
// status.
export function instinctsLines(instincts) {
  if (!instincts) return ["not available"];
  return [instinctsCounts(instincts), instinctsStatus(instincts)];
}

function instinctsCounts(instincts) {
  const base = `${instincts.project} learned here, ${instincts.global} global`;
  return instincts.inherited > 0 ? `${base}, ${instincts.inherited} inherited` : base;
}

function instinctsStatus(instincts) {
  const pending = instincts.pendingObservations ?? 0;
  if (instincts.observerEnabled === false) return "observer off";
  if (!instincts.lastRun) return `never run yet, ${pending} new events`;
  if (instincts.nextRunEligibleAt && Date.parse(instincts.nextRunEligibleAt) > Date.now()) {
    return `next run in ${relativeTime(instincts.nextRunEligibleAt)}, ${pending} new events`;
  }
  return `ready to run, ${pending} new events`;
}

// Two lines: open/parked counts, then the last backlog review and staged
// update count.
export function observationsLines(observations) {
  if (!observations || observations.available === false) return ["not found"];
  const line1 = `${observations.open} open, ${observations.parked} parked`;
  const line2 = `last review ${formatLastReview(observations.lastReview)}, ${observations.staged} staged`;
  return [line1, line2];
}

function formatLastReview(value) {
  if (!value) return "never";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "never";
  return `${relativeTime(value)} ago`;
}

// Two lines: skill and iteration, then the two pass rates compared.
// Wording follows whichever config name skill-creator used for the
// baseline run: "old_skill" reads as new/old, anything else (e.g.
// "without_skill") reads as with skill/without.
export function evalsLines(evals) {
  if (!evals || evals.available === false) return ["not found"];
  const skill = evals.skill ?? "?";
  const line1 = evals.iteration != null ? `${skill}, iteration ${evals.iteration}` : skill;
  const withPct = formatPercent(evals.withSkill);
  const basePct = formatPercent(evals.baseline);
  const line2 = evals.baselineKind === "old" ? `${withPct} new, ${basePct} old` : `${withPct} with skill, ${basePct} without`;
  return [line1, line2];
}

function formatPercent(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "?";
}
