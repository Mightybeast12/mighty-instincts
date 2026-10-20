// Pure (no solid-js / opentui) helpers for the sidebar panel's detail
// view: the confidence bar glyphs, log-tail slicing, and pass-rate-with-
// stddev formatting. Kept out of sidebar.js so smoke-test.mjs can assert
// on this directly, the same way lib/board-interaction.js keeps the
// collapse state pure; sidebar.js itself needs the host's
// solid-js/@opentui packages and is never imported outside the OpenCode
// TUI (see tui.js).
export const DETAIL_PANEL_NAME = "mighty-instincts.detail";
export const DETAIL_BLOCK_KEYS = ["instincts", "observations", "evals"];

const BAR_CELLS = 10;
const BAR_FULL = "\u2588"; // █
const BAR_EMPTY = "\u2591"; // ░

// Mirrors vendor/ecc/instinct-cli.py's own `_confidence_bar` (lines
// 101-109): 10 cells, filled = round(confidence * 10), clamped to
// [0, 10]. A non-numeric confidence renders half-filled, the same
// fallback the python CLI uses for an unparsable value.
export function confidenceBar(confidence) {
  const value = Number(confidence);
  const filled = Number.isFinite(value) ? clamp(Math.round(value * BAR_CELLS), 0, BAR_CELLS) : Math.round(BAR_CELLS / 2);
  return BAR_FULL.repeat(filled) + BAR_EMPTY.repeat(BAR_CELLS - filled);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// The last `limit` non-blank lines of a file's content, in file order
// (oldest of the kept lines first), for the instincts detail panel's raw
// observer.log tail.
export function lastLines(content, limit) {
  if (typeof content !== "string" || !Number.isFinite(limit) || limit <= 0) return [];
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  return lines.slice(-limit);
}

// board-state.json already sorts instincts.list by confidence descending
// (lib/board.js); this re-sorts defensively so the detail panel never
// trusts the file's own ordering.
export function sortedByConfidenceDesc(list) {
  return (Array.isArray(list) ? list : []).slice().sort((a, b) => (Number(b?.confidence) || 0) - (Number(a?.confidence) || 0));
}

// "92%" alone, or "92% \u00b1 5%" when a stddev is present and numeric.
export function formatRateWithStddev(mean, stddev) {
  if (typeof mean !== "number" || !Number.isFinite(mean)) return "?";
  const pct = `${Math.round(mean * 100)}%`;
  if (typeof stddev !== "number" || !Number.isFinite(stddev)) return pct;
  return `${pct} \u00b1 ${Math.round(stddev * 100)}%`;
}

// "2h ago" / "never", for the observations detail panel's per-title age;
// `relativeTimeFn` is injected (lib/relative-time.js's `relativeTime`)
// instead of imported, keeping this module dependency-free for tests that
// want to fake the clock.
export function formatAge(value, relativeTimeFn) {
  if (!value) return "never";
  const rel = relativeTimeFn(value);
  return rel ? `${rel} ago` : "never";
}
