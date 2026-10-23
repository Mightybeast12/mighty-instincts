// Plain-text, chat-style summary for the /board command (lib/commands.js):
// a brief explanatory headline per block (glyph, padded label, then its
// key facts on one line), then a few plain-language detail lines, not
// the sidebar's dot-aligned label/value rows. The sidebar panel keeps
// using lib/board-text.js's row model directly (sidebar.js); this module
// only covers the /board chat reply, which reads better as a short prose
// block than as a table copied into a chat message.
//
// Every fact below is still read through lib/board-text.js's own block
// builders (buildInstinctsBlock/buildObservationsBlock/buildEvalsBlock),
// via rowValue() (below), rather than re-deriving glyph/staleness/
// availability thresholds here: that way this module can never drift
// from what the sidebar itself would show for the same board-state.json.
import { buildEvalsBlock, buildInstinctsBlock, buildObservationsBlock, GLYPH_CHAR, LEGEND } from "./board-text.js";

// Every block's headline value starts at this column (glyph + space +
// label, padded out to this width), so the three blocks' facts line up
// under each other the same way the sidebar's own detail rows do.
const HEADLINE_LABEL_WIDTH = 17;
// A block's own body lines (everything after its headline) are indented
// one level so a block reads as one short paragraph in the chat reply.
const BODY_INDENT = "  ";

export function formatBoardSummary(state, options = {}) {
  if (!state) {
    return "Board state not written yet. It is refreshed on plugin setup, after observer runs, and on a timer.";
  }
  const sections = options.board?.sections ?? {};
  const paragraphs = [];
  if (sections.instincts !== false) paragraphs.push(formatInstinctsSummary(state.instincts));
  if (sections.observations !== false) paragraphs.push(formatObservationsSummary(state.observations));
  if (sections.evals !== false) paragraphs.push(formatEvalsSummary(state.evals));
  if (paragraphs.length === 0) return "No board sections enabled.";

  return `${paragraphs.join("\n\n")}\n\n${formatLegend()}`;
}

function glyphOf(block) {
  return GLYPH_CHAR[block.glyph] ?? GLYPH_CHAR.stale;
}

function rowValue(block, label) {
  const row = block.rows.find((entry) => entry.label === label);
  return row ? row.value : null;
}

// "<glyph> <label><padding>": the circle always comes before the label,
// and the label is padded out to HEADLINE_LABEL_WIDTH (minimum one gap
// space, same "never flush against the next thing" rule alignRow uses)
// so every block's own facts start in the same column.
function headlinePrefix(block) {
  const label = block.label;
  const padded = label.length < HEADLINE_LABEL_WIDTH ? label.padEnd(HEADLINE_LABEL_WIDTH) : `${label} `;
  return `${glyphOf(block)} ${padded}`;
}

function formatBlock(headline, bodyLines) {
  return [headline, ...bodyLines.map((line) => `${BODY_INDENT}${line}`)].join("\n");
}

// Learned habits: a headline (glyph, total learned, how many currently
// qualify for injection, how many fired today and this week), a sentence
// on what a "habit" is and how "used" is counted, up to 5 of today's
// actually-used habits (id, fired count, word-boundary-clipped summary;
// lib/board.js already clips each to 100 chars, since this reply has no
// 36-column sidebar budget to justify a hard cut), when the observer is
// next due, and a /promote hint whenever anything qualifies.
function formatInstinctsSummary(instincts) {
  const block = buildInstinctsBlock(instincts);
  if (!block.available) return `${headlinePrefix(block)}none recorded yet.`;

  const habitsInPrompts = rowValue(block, "habits in prompts") ?? "0";
  const firedToday = Number(instincts?.firedToday) || 0;
  const firedThisWeek = Number(instincts?.firedThisWeek) || 0;
  const headline = `${headlinePrefix(block)}${block.headline} total, ${habitsInPrompts} in prompts, ${firedToday} used today (${firedThisWeek} this week)`;

  const body = [
    "Habits are patterns learned from your activity; one counts as used once per prompt you type in a top-level session whose wording shares 3 or more significant words with the habit's trigger; subagent and background sessions are not counted.",
  ];

  const top = Array.isArray(instincts?.firedTodayTop) ? instincts.firedTodayTop : [];
  if (top.length > 0) {
    // "Used today:" when every habit fired exactly once (nothing to rank);
    // "Most used today:" once any two differ, since the list is then
    // actually ordered by how often each one fired.
    const introWord = top.every((habit) => habit.count === 1) ? "Used today:" : "Most used today:";
    const continuationIndent = " ".repeat(introWord.length + 1);
    top.forEach((habit, index) => {
      const entry = `${habit.id} (${habit.count}x): ${habit.summary}`;
      body.push(index === 0 ? `${introWord} ${entry}` : `${continuationIndent}${entry}`);
    });
  } else {
    body.push("No habits fired today yet.");
  }

  // The learning-run gate reads as one of three states (see
  // lib/board-text.js's own "next learning run" row): "ready" (the gate
  // has already passed), "in <rel>" (still waiting on the interval
  // itself), or "after N more events (M so far)" (the interval has
  // elapsed, but not enough has been observed yet).
  const nextRun = rowValue(block, "next learning run");
  const nextRunText = nextRun ?? (instincts?.observerEnabled === false ? "not scheduled (observer disabled)" : "waiting on more activity");
  const readyToShare = Number(rowValue(block, "ready to share globally")) || 0;
  body.push(readyToShare > 0 ? `Next learning run ${nextRunText}. ${readyToShare} ready: /promote.` : `Next learning run ${nextRunText}.`);

  // One sentence on candidates (0.8.0's evolve lifecycle), only when
  // there is anything to say: proposed, installed, and unused-installed
  // counts all come from the exact same rows the sidebar panel shows, so
  // this can never drift from what buildInstinctsBlock itself reports.
  const skillCandidates = Number(rowValue(block, "skill candidates")) || 0;
  const installedFromHabits = Number(rowValue(block, "installed from habits")) || 0;
  const unusedCandidates = Number(rowValue(block, "unused candidates")) || 0;
  if (skillCandidates > 0 || installedFromHabits > 0 || unusedCandidates > 0) {
    const parts = [];
    if (skillCandidates > 0) parts.push(`${skillCandidates} proposed from your habits`);
    if (installedFromHabits > 0) parts.push(`${installedFromHabits} installed`);
    if (unusedCandidates > 0) parts.push(`${unusedCandidates} unused`);
    body.push(`Skill candidates: ${parts.join(", ")}; run /evolve-list (or /evolve-show <id>) to review one, then /evolve-install <id> --yes to install it.`);
  }

  return formatBlock(headline, body);
}

// Skill notes: a headline covering the open backlog and how much of it
// is new this week, plus when it was last reviewed; appends ": review
// overdue" whenever lib/board-observations.js's own warning flag (open >
// 100 and the last review is never or stale) is set.
function formatObservationsSummary(observations) {
  const block = buildObservationsBlock(observations);
  if (!block.available) return `${headlinePrefix(block)}not available.`;

  const added7d = rowValue(block, "added this week") ?? "0";
  const lastReviewRaw = rowValue(block, "last reviewed") ?? "never";
  const reviewPhrase = lastReviewRaw === "never" ? "never reviewed" : `last reviewed ${lastReviewRaw}`;
  const suffix = observations?.warning === true ? ": review overdue" : "";
  return `${headlinePrefix(block)}${block.headline} open, ${added7d} this week, ${reviewPhrase}${suffix}.`;
}

// Skill test: a headline covering the newest benchmark's age and the two
// pass rates it compared; reads as "no measurable difference" (and the
// glyph reads stale) whenever buildEvalsBlock's own noMeasurableDifference
// flag is set (|with - baseline| < 0.05, or the skill measured worse).
function formatEvalsSummary(evals) {
  const block = buildEvalsBlock(evals);
  if (block.headline === "none") return `${headlinePrefix(block)}no benchmark run recorded yet.`;

  const withPct = rowValue(block, "with skill") ?? rowValue(block, "new") ?? "?";
  const baseline = rowValue(block, "without") ?? rowValue(block, "old") ?? "?";
  if (block.noMeasurableDifference) {
    return `${headlinePrefix(block)}no measurable difference last run (${withPct} vs ${baseline}, ${block.headline} ago).`;
  }
  return `${headlinePrefix(block)}last measured ${block.headline} ago, ${withPct} with the skill vs ${baseline} without.`;
}

function formatLegend() {
  return LEGEND.map((entry) => `${GLYPH_CHAR[entry.glyph]} ${entry.label}`).join("  ");
}
