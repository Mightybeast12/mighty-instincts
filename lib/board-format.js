// Plain-text rendering of the board state for the /board command (hosts
// without the sidebar panel see this instead). Mirrors the sidebar's
// Instincts/Observe/Evals sections via the shared lines in lib/board-text.js;
// Review is omitted because it is derived from live TUI session data this
// server-side command does not have.
import { evalsLines, instinctsLines, observationsLines } from "./board-text.js";

const LABEL_WIDTH = 11;

export function formatBoardSummary(state, options = {}) {
  if (!state) {
    return "Board state not written yet. It is refreshed on plugin setup, after observer runs, and on a timer.";
  }
  const sections = options.board?.sections ?? {};
  const blocks = [];
  if (sections.instincts !== false) blocks.push(formatBlock("Instincts", instinctsLines(state.instincts)));
  if (sections.observations !== false) blocks.push(formatBlock("Observe", observationsLines(state.observations)));
  if (sections.evals !== false) blocks.push(formatBlock("Evals", evalsLines(state.evals)));
  if (blocks.length === 0) return "No board sections enabled.";
  return blocks.join("\n");
}

function formatBlock(label, lines) {
  const indent = " ".repeat(LABEL_WIDTH);
  return lines.map((line, index) => (index === 0 ? `${label.padEnd(LABEL_WIDTH)}${line}` : `${indent}${line}`)).join("\n");
}
