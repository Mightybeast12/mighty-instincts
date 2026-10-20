// Plain-text rendering of the board state for the /board command (hosts
// without the sidebar panel see this instead). Shares every title and
// fact line with the sidebar's blocks (lib/board-text.js) so the two never
// disagree about what a block says; only the styling differs here (no
// glyphs, no color, no collapsing).
import { evalsLines, EVALS_TOOL, instinctsLines, instinctsToolName, observationsLines, OBSERVATIONS_TOOL } from "./board-text.js";

export function formatBoardSummary(state, options = {}) {
  if (!state) {
    return "Board state not written yet. It is refreshed on plugin setup, after observer runs, and on a timer.";
  }
  const sections = options.board?.sections ?? {};
  const blocks = [];
  if (sections.instincts !== false) {
    blocks.push(formatBlock(`Instincts \u00b7 ${instinctsToolName(state.instincts)}`, instinctsLines(state.instincts)));
  }
  if (sections.observations !== false) {
    blocks.push(formatBlock(`Skill observations \u00b7 ${OBSERVATIONS_TOOL}`, observationsLines(state.observations)));
  }
  if (sections.evals !== false) {
    blocks.push(formatBlock(`Skill evals \u00b7 ${EVALS_TOOL}`, evalsLines(state.evals)));
  }
  if (blocks.length === 0) return "No board sections enabled.";
  return blocks.join("\n\n");
}

function formatBlock(title, lines) {
  return [title, ...lines.map((line) => `  ${line}`)].join("\n");
}
