// Structured block model for the board's three panel sections (Learned
// habits / Skill notes / Skill test), shared by the sidebar panel
// (sidebar.js, which colors and lays these out as boxes) and the /board
// command's plain-text summary (lib/board-format.js), so the two never
// disagree about what a block says. Replaces 0.6.0's
// instinctsLines/observationsLines/evalsLines (flat text-line arrays)
// with data: { key, label, glyph, headline, rows }, where each row is
// either `{ label, value }` (a plain fact, value right-aligned by the
// renderer) or `{ hint }` (a muted sub-row with no value column, e.g.
// "run /promote to share them": the TUI has no hover, so a hint row is
// its nearest equivalent to a tooltip).
import { relativeTime } from "./relative-time.js";

export const PANEL_WIDTH = 36;

// "active"/"attention" share the same glyph character (●); only their
// colour differs, which is a sidebar.js (theme) concern, not something
// this pure module decides. "stale" (○, muted) covers both "no data yet"
// and "too old to trust".
export const GLYPH_CHAR = { active: "\u25cf", attention: "\u25cf", stale: "\u25cb" };

// Rendered as the muted legend row at the bottom of an expanded panel.
export const LEGEND = [
  { glyph: "active", label: "active" },
  { glyph: "attention", label: "needs attention" },
  { glyph: "stale", label: "stale" },
];

const ATTENTION_WINDOW_MS = 24 * 3600000; // Learned habits: last run older than this is stale attention.
const EVAL_STALE_MS = 7 * 86400000; // Skill test: benchmark older than this (or missing) reads as stale.
// Skill test: a |with - baseline| pass-rate difference smaller than this
// reads as "no measurable difference" (and, like a negative difference,
// as stale): the skill's own run did not move the needle either way.
const EVAL_NO_DIFFERENCE_THRESHOLD = 0.05;

// Right-aligns `value` to `width` columns, label on the left. `fill`
// chosen " " reads as sidebar.js's own flex-free plain-text alignment;
// any other single character (lib/board-format.js uses ".") is wrapped in
// a single space on each side, matching the `Label ........ value`
// convention: the dots fill the gap, they are never flush against either
// the label or the value. Always leaves at least one fill character, even
// when label+value would otherwise overflow `width`.
export function alignRow(label, value, { width = PANEL_WIDTH, fill = " " } = {}) {
  const safeLabel = String(label ?? "");
  const safeValue = String(value ?? "");
  if (fill === " ") {
    const padding = Math.max(1, width - safeLabel.length - safeValue.length);
    return `${safeLabel}${" ".repeat(padding)}${safeValue}`;
  }
  const padding = Math.max(1, width - safeLabel.length - safeValue.length - 2);
  return `${safeLabel} ${fill.repeat(padding)} ${safeValue}`;
}

function numberOrNull(value) {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatPercent(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : null;
}

function formatReview(value) {
  if (!value) return "never";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "never";
  return `${relativeTime(value)} ago`;
}

function formatKeptTidy(counts7d) {
  if (!counts7d) return null;
  const parts = [];
  if (counts7d.promoted) parts.push(`promoted ${counts7d.promoted}`);
  if (counts7d.archived) parts.push(`archived ${counts7d.archived}`);
  if (counts7d.merged) parts.push(`merged ${counts7d.merged}`);
  if (counts7d.pruned) parts.push(`pruned ${counts7d.pruned}`);
  if (counts7d.candidates) parts.push(`candidates ${counts7d.candidates}`);
  if (counts7d.repaired) parts.push(`repaired ${counts7d.repaired}`);
  if (counts7d.cleaned) parts.push(`cleaned ${counts7d.cleaned}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

function unavailableBlock(key, label) {
  return { key, label, available: false, glyph: "stale", headline: "none", rows: [] };
}

// Learned habits: how many instincts this plugin has learned (project +
// inherited + global), how many currently qualify for injection, how many
// were actually used today, how many look ready to promote to the shared
// global bucket, when the observer next runs, and a rollup of what
// lib/maintain.js's housekeeping did lately.
export function buildInstinctsBlock(instincts) {
  if (!instincts) return unavailableBlock("instincts", "Learned habits");

  const total = (instincts.project ?? 0) + (instincts.global ?? 0) + (instincts.inherited ?? 0);
  const rows = [];

  // "habits in prompts": a live eligibility count (confidence >=
  // inject.minConfidence, not excluded, not pending), not a per-day
  // event tally like the row it replaced ("added to prompts today"), so
  // it is shown whenever the block itself is available, including 0 ("no
  // habit currently qualifies"), the same way "ready to share globally"
  // already does below.
  const habitsInPrompts = numberOrNull(instincts.habitsInPrompts);
  if (habitsInPrompts !== null) rows.push({ label: "habits in prompts", value: String(habitsInPrompts) });

  const firedToday = numberOrNull(instincts.firedToday);
  const firedThisWeek = numberOrNull(instincts.firedThisWeek);
  if (firedThisWeek) rows.push({ label: "used today / this week", value: `${firedToday ?? 0} / ${firedThisWeek}` });

  const readyToShare = numberOrNull(instincts.readyToShare);
  if (readyToShare !== null) {
    rows.push({ label: "ready to share globally", value: String(readyToShare) });
    if (readyToShare > 0) rows.push({ hint: "run /promote to share them" });
  }

  // "ready" (the observer gate is met right now, see lib/board.js's
  // nextRunReady) takes priority over a computed ETA: relativeTime has no
  // "ago"/"in" direction of its own, so showing a duration here once the
  // gate has actually passed read as a confusing future wait instead of
  // "this will run on the very next observed tool call/prompt". A third
  // case covers the gap those two used to leave open: the interval has
  // elapsed but the observation count hasn't (lib/board.js's own
  // nextRunReady/nextRunEligibleAt comment), which has no future
  // timestamp to show but does have a concrete "N more needed" count.
  if (instincts.observerEnabled !== false) {
    if (instincts.nextRunReady) {
      rows.push({ label: "next learning run", value: "ready" });
    } else if (instincts.nextRunEligibleAt) {
      rows.push({ label: "next learning run", value: `in ${relativeTime(instincts.nextRunEligibleAt) ?? "?"}` });
    } else {
      const minObservations = numberOrNull(instincts.minObservations);
      const pendingObservations = numberOrNull(instincts.pendingObservations);
      if (minObservations !== null && pendingObservations !== null) {
        const needed = Math.max(0, minObservations - pendingObservations);
        rows.push({ label: "next learning run", value: `after ${needed} more events (${pendingObservations} so far)` });
      }
    }
  }

  const skillCandidates = numberOrNull(instincts.skillCandidates);
  if (skillCandidates > 0) {
    rows.push({ label: "skill candidates", value: String(skillCandidates) });
    rows.push({ hint: "run /evolve-list" });
  }

  const installedFromHabits = numberOrNull(instincts.installedFromHabits);
  if (installedFromHabits > 0) rows.push({ label: "installed from habits", value: String(installedFromHabits) });

  const unusedCandidates = numberOrNull(instincts.unusedCandidates);
  if (unusedCandidates > 0) {
    rows.push({ label: "unused candidates", value: String(unusedCandidates) });
    rows.push({ hint: "see /evolve-list" });
  }

  const awaitingFirstUse = numberOrNull(instincts.awaitingFirstUse);
  if (awaitingFirstUse > 0) rows.push({ label: "awaiting first use", value: String(awaitingFirstUse) });

  const keptTidy = formatKeptTidy(instincts.maintenance?.counts7d);
  if (keptTidy) rows.push({ label: "kept tidy", value: keptTidy });

  return { key: "instincts", label: "Learned habits", available: true, glyph: instinctsGlyph(instincts), headline: String(total), rows };
}

// Attention: observer disabled, or its last run is more than 24h old.
// Stale: no run on record at all (nothing to judge freshness against).
function instinctsGlyph(instincts) {
  if (instincts.observerEnabled === false) return "attention";
  if (!instincts.lastRun) return "stale";
  const ageMs = Date.now() - Date.parse(instincts.lastRun);
  if (!Number.isFinite(ageMs)) return "stale";
  return ageMs > ATTENTION_WINDOW_MS ? "attention" : "active";
}

// Skill notes: the task-observer skill's open backlog, how much of it is
// new this week, and when it was last reviewed.
export function buildObservationsBlock(observations) {
  if (!observations || observations.available === false) return unavailableBlock("observations", "Skill notes");

  const open = numberOrNull(observations.open) ?? 0;
  const rows = [{ label: "open", value: String(open) }];
  const addedWeek = numberOrNull(observations.added7d);
  if (addedWeek !== null) rows.push({ label: "added this week", value: String(addedWeek) });
  rows.push({ label: "last reviewed", value: formatReview(observations.lastReview) });

  // Mirrors lib/board-observations.js's own `warning` (open > 100 and the
  // last review is never or more than 7 days old): computed there once,
  // reused here instead of re-deriving the same threshold.
  const glyph = observations.warning === true ? "attention" : "active";
  return { key: "observations", label: "Skill notes", available: true, glyph, headline: String(open), rows };
}

// Skill test: the newest skill-creator benchmark's age, and the two pass
// rates it compared. Uses the eval's own skill name in the title
// ("Skill test (pr)"); with no skill name on record (including "no eval
// found at all"), this reads as "Skill test" / headline "none" / glyph
// stale, the same as any other "no data" case.
export function buildEvalsBlock(evals) {
  const skill = evals && evals.available !== false ? evals.skill : null;
  if (!evals || evals.available === false || !skill) {
    return { key: "evals", label: "Skill test", available: true, glyph: "stale", headline: "none", rows: [], noMeasurableDifference: false };
  }

  const ageMs = evals.timestamp ? Date.now() - Date.parse(evals.timestamp) : NaN;
  const staleByAge = !Number.isFinite(ageMs) || ageMs > EVAL_STALE_MS;

  // "no measurable difference": the skill's own run barely moved the pass
  // rate either way (< 5 points); also reads as stale whenever the skill
  // made things worse (a negative difference), not just the near-zero
  // band. withSkill/baseline missing (either one) means there is nothing
  // to compare, so neither rule can fire.
  const diff = typeof evals.withSkill === "number" && typeof evals.baseline === "number" ? evals.withSkill - evals.baseline : null;
  const noMeasurableDifference = diff !== null && Math.abs(diff) < EVAL_NO_DIFFERENCE_THRESHOLD;
  const staleByDelta = diff !== null && diff < 0;
  const stale = staleByAge || noMeasurableDifference || staleByDelta;

  const headline = evals.timestamp ? relativeTime(evals.timestamp) ?? "?" : "none";

  const withLabel = evals.baselineKind === "old" ? "new" : "with skill";
  const baseLabel = evals.baselineKind === "old" ? "old" : "without";
  const rows = [];
  const withPct = formatPercent(evals.withSkill);
  if (withPct) rows.push({ label: withLabel, value: withPct });
  const basePct = formatPercent(evals.baseline);
  if (basePct) rows.push({ label: baseLabel, value: basePct });

  return { key: "evals", label: `Skill test (${skill})`, available: true, glyph: stale ? "stale" : "active", headline, rows, noMeasurableDifference };
}
