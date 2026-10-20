// Plain-text rendering of the board state for the /board command (hosts
// without the sidebar panel see this instead). Shares the same block
// model as the sidebar (lib/board-text.js) so the two never disagree
// about wording; only the styling differs here: dot-filled alignment
// instead of the sidebar's flex-based right alignment, no colour, and no
// collapsing (there is nothing to collapse in a one-shot text reply).
import { alignRow, buildEvalsBlock, buildInstinctsBlock, buildObservationsBlock, GLYPH_CHAR, LEGEND } from "./board-text.js";

export function formatBoardSummary(state, options = {}) {
  if (!state) {
    return "Board state not written yet. It is refreshed on plugin setup, after observer runs, and on a timer.";
  }
  const sections = options.board?.sections ?? {};
  const blocks = [];
  if (sections.instincts !== false) blocks.push(buildInstinctsBlock(state.instincts));
  if (sections.observations !== false) blocks.push(buildObservationsBlock(state.observations));
  if (sections.evals !== false) blocks.push(buildEvalsBlock(state.evals));
  if (blocks.length === 0) return "No board sections enabled.";

  return [...blocks.map(formatBlock), formatLegend()].join("\n\n");
}

// Title row (`Label ........ glyph headline`), then one line per detail
// row (2-space indent, same dot alignment) or hint (4-space indent, no
// value column: the plain-text equivalent of the sidebar's muted
// tooltip-like sub-row).
function formatBlock(block) {
  const titleValue = `${GLYPH_CHAR[block.glyph] ?? ""} ${block.headline}`.trim();
  const lines = [alignRow(block.label, titleValue, { fill: "." })];
  for (const row of block.rows) {
    lines.push("hint" in row ? `    ${row.hint}` : `  ${alignRow(row.label, row.value, { fill: "." })}`);
  }
  return lines.join("\n");
}

function formatLegend() {
  return LEGEND.map((entry) => `${GLYPH_CHAR[entry.glyph]} ${entry.label}`).join("  ");
}
