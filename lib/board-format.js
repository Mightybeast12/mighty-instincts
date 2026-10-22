// Plain-text, chat-style summary for the /board command (lib/commands.js):
// a brief explanatory paragraph per block (one headline line, then a
// sentence or two of plain-language context), not the sidebar's
// dot-aligned label/value rows. The sidebar panel keeps using
// lib/board-text.js's row model directly (sidebar.js); this module only
// covers the /board chat reply, which reads better as prose than as a
// table copied into a chat message.
//
// Every fact below is still read through lib/board-text.js's own block
// builders (buildInstinctsBlock/buildObservationsBlock/buildEvalsBlock),
// via rowValue() (below), rather than re-deriving glyph/staleness/
// availability thresholds here: that way this module can never drift
// from what the sidebar itself would show for the same board-state.json.
import { buildEvalsBlock, buildInstinctsBlock, buildObservationsBlock, GLYPH_CHAR, LEGEND } from "./board-text.js";

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

// Learned habits: a headline (glyph, total learned, how many currently
// qualify for injection), one sentence on what a "habit" is and how
// "used" is counted, up to 3 of today's actually-used habits (id, fired
// count, summary; lib/board.js already clips each summary to 45 chars),
// when the observer is next due, and a /promote hint whenever anything
// qualifies.
function formatInstinctsSummary(instincts) {
  const block = buildInstinctsBlock(instincts);
  if (!block.available) return "Learned habits: none recorded yet.";

  const habitsInPrompts = rowValue(block, "habits in prompts") ?? "0";
  const lines = [`Learned habits ${glyphOf(block)} ${block.headline} total, ${habitsInPrompts} eligible for prompts right now.`];
  lines.push(
    'A habit is a pattern this plugin learned from your own activity; it counts as "used" once an eligible (or still-unproven) habit\'s trigger shares 3 or more significant words with something you actually typed.',
  );

  const top = Array.isArray(instincts?.firedTodayTop) ? instincts.firedTodayTop : [];
  if (top.length > 0) {
    lines.push("Top habits used today:");
    top.forEach((habit, index) => {
      lines.push(`  ${index + 1}. ${habit.id} (${habit.count}x): ${habit.summary}`);
    });
  } else {
    lines.push("No habits fired today yet.");
  }

  const nextRun = rowValue(block, "next learning run");
  const nextRunText = nextRun ?? (instincts?.observerEnabled === false ? "not scheduled (observer disabled)" : "waiting on more activity");
  lines.push(`Next learning run: ${nextRunText}.`);

  const readyToShare = Number(rowValue(block, "ready to share globally")) || 0;
  if (readyToShare > 0) {
    lines.push(`${readyToShare} ${readyToShare === 1 ? "is" : "are"} confident enough to promote globally: run /promote to share them.`);
  }

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
    lines.push(`Skill candidates: ${parts.join(", ")}; run /evolve-list (or /evolve-show <id>) to review one, then /evolve-install <id> --yes to install it.`);
  }

  return lines.join("\n");
}

// Skill notes: one sentence covering the open backlog, how much of it is
// new this week, and when it was last reviewed by a human.
function formatObservationsSummary(observations) {
  const block = buildObservationsBlock(observations);
  if (!block.available) return "Skill notes: not available.";

  const added7d = rowValue(block, "added this week") ?? "0";
  const lastReview = rowValue(block, "last reviewed") ?? "never";
  return `Skill notes ${glyphOf(block)} ${block.headline} open, ${added7d} added this week, last reviewed ${lastReview}.`;
}

// Skill test: one sentence covering the newest benchmark's age and the
// two pass rates it compared.
function formatEvalsSummary(evals) {
  const block = buildEvalsBlock(evals);
  if (block.headline === "none") return "Skill test: no benchmark run recorded yet.";

  const withPct = rowValue(block, "with skill") ?? rowValue(block, "new") ?? "?";
  const baseline = rowValue(block, "without") ?? rowValue(block, "old") ?? "?";
  return `${block.label} ${glyphOf(block)}: last measured ${block.headline} ago, ${withPct} with the skill vs ${baseline} without.`;
}

function formatLegend() {
  return LEGEND.map((entry) => `${GLYPH_CHAR[entry.glyph]} ${entry.label}`).join("  ");
}
