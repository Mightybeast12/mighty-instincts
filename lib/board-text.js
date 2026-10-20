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

const MAX_DOMAINS_SHOWN = 3;
const FACT_LINE_MAX_CHARS = 36;

// Three (fixed) lines: how many instincts exist and how many look ready
// to promote, their domains, then the observer's run tally and status.
// Two more lines are appended only when they have something to say:
// "applied N today" once lib/inject.js has injected at least one
// instinct today, and "learned <id> <age> ago" once at least one
// instinct has a recorded mtime.
export function instinctsLines(instincts) {
  if (!instincts) return ["not available"];
  const lines = [instinctsSummaryLine(instincts), instinctsDomainsLine(instincts), instinctsRunLine(instincts)];
  const applied = instinctsAppliedLine(instincts);
  if (applied) lines.push(applied);
  const learned = instinctsLearnedLine(instincts);
  if (learned) lines.push(learned);
  return lines;
}

function instinctsSummaryLine(instincts) {
  const total = (instincts.project ?? 0) + (instincts.global ?? 0) + (instincts.inherited ?? 0);
  const ready = instincts.readyToPromote ?? 0;
  const base = `${total} learned, ${ready} ready to promote`;
  return instincts.inherited > 0 ? `${base}, ${instincts.inherited} inherited` : base;
}

function instinctsDomainsLine(instincts) {
  const domains = Array.isArray(instincts.domains) ? instincts.domains : [];
  if (domains.length === 0) return "no domains yet";
  const shown = domains.slice(0, MAX_DOMAINS_SHOWN).map((domain) => `${domain.name} ${domain.count}`);
  const extra = domains.length - MAX_DOMAINS_SHOWN;
  if (extra > 0) shown.push(`+${extra} more`);
  return shown.join(" \u00b7 ");
}

function instinctsRunLine(instincts) {
  if (instincts.observerEnabled === false) return "observer off";
  if (!instincts.lastRun) return "never run yet";
  // "rejected" only when nonzero, so the common case fits the 36 columns.
  const rejected = instincts.rejected ? `, ${instincts.rejected} rejected` : "";
  const base = `${instincts.runs ?? 0} runs, ${instincts.written ?? 0} written${rejected}`;
  if (instincts.nextRunEligibleAt) {
    return `${base} \u00b7 next ${relativeTime(instincts.nextRunEligibleAt)}`;
  }
  return base;
}

// "applied N today" once lib/inject.js has recorded at least one
// injection today (see lib/activity.js's appliedToday/appliedDate),
// omitted entirely otherwise so a project with injection disabled or
// unused never shows a stale "applied 0 today" line.
function instinctsAppliedLine(instincts) {
  const applied = Number(instincts.appliedToday) || 0;
  return applied > 0 ? `applied ${applied} today` : null;
}

// "learned <id> <age> ago", with the id truncated (ellipsis) just enough
// to keep the whole line within FACT_LINE_MAX_CHARS, since instinct ids
// have no length cap of their own (up to 64 chars, lib/observer.js's
// INSTINCT_ID_PATTERN) and this plugin's other fact lines all fit one
// terminal row. Omitted when no instinct has a recorded mtime yet.
function instinctsLearnedLine(instincts) {
  if (typeof instincts.newestId !== "string" || instincts.newestId.length === 0) return null;
  const age = instincts.newestAt ? relativeTime(instincts.newestAt) : null;
  const prefix = "learned ";
  const suffix = ` ${age ?? "?"} ago`;
  const maxIdChars = Math.max(1, FACT_LINE_MAX_CHARS - prefix.length - suffix.length);
  const id =
    instincts.newestId.length > maxIdChars ? `${instincts.newestId.slice(0, Math.max(1, maxIdChars - 1))}\u2026` : instincts.newestId;
  return `${prefix}${id}${suffix}`;
}

// Three lines: open count and last backlog review, the busiest skills in
// the open backlog, then how recently observations were added.
export function observationsLines(observations) {
  if (!observations || observations.available === false) return ["not found"];
  return [observationsSummaryLine(observations), observationsSkillsLine(observations), observationsAddedLine(observations)];
}

function observationsSummaryLine(observations) {
  return `${observations.open ?? 0} open, review ${formatReview(observations.lastReview)}`;
}

function formatReview(value) {
  if (!value) return "never";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "never";
  return `${relativeTime(value)} ago`;
}

const MAX_SKILL_NAME_CHARS = 22;

function observationsSkillsLine(observations) {
  const skills = Array.isArray(observations.topSkills) ? observations.topSkills : [];
  if (skills.length === 0) return "no skills recorded";
  return skills.map((entry) => `${truncateSkillName(entry.skill)} ${entry.count}`).join(" \u00b7 ");
}

function truncateSkillName(name) {
  const value = typeof name === "string" ? name : String(name ?? "");
  if (value.length <= MAX_SKILL_NAME_CHARS) return value;
  return `${value.slice(0, MAX_SKILL_NAME_CHARS - 1)}\u2026`;
}

function observationsAddedLine(observations) {
  const today = observations.addedToday ?? 0;
  const week = observations.added7d ?? 0;
  return `+${today} today, +${week} this week \u00b7 newest ${formatNewest(observations.newestAt)}`;
}

function formatNewest(value) {
  if (!value) return "never";
  return relativeTime(value) ?? "never";
}

// Two lines: skill, iteration, age and run count, then the two pass rates
// compared. Wording follows whichever config name skill-creator used for
// the baseline run: "old_skill" reads as new/old, anything else (e.g.
// "without_skill") reads as with skill/without. Always strings: sidebar.js
// inserts these straight into text nodes, which (unlike a plain object or
// array) are safe to hand to the host's insert().
export function evalsLines(evals) {
  if (!evals || evals.available === false) return ["not found"];
  return [evalsSummaryLine(evals), evalsRateLine(evals)].map((line) => (typeof line === "string" ? line : String(line ?? "")));
}

function evalsSummaryLine(evals) {
  const skill = evals.skill ?? "?";
  const base = evals.iteration != null ? `${skill}, iteration ${evals.iteration}` : skill;
  const parts = [];
  const age = evals.timestamp ? relativeTime(evals.timestamp) : null;
  if (age) parts.push(`${age} old`);
  if (typeof evals.runs === "number" && Number.isFinite(evals.runs)) parts.push(`n=${evals.runs}`);
  return parts.length > 0 ? `${base} \u00b7 ${parts.join(", ")}` : base;
}

function evalsRateLine(evals) {
  const withPct = formatPercent(evals.withSkill);
  const basePct = formatPercent(evals.baseline);
  return evals.baselineKind === "old" ? `${withPct} new, ${basePct} old` : `${withPct} with skill, ${basePct} without`;
}

function formatPercent(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "?";
}
