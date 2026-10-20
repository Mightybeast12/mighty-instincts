// Pure (no solid-js / opentui) shapes for the sidebar panel's collapsible
// state: which blocks start expanded, and how a persisted snapshot merges
// over those defaults. Kept out of sidebar.js so smoke-test.mjs can assert
// on this directly; sidebar.js itself needs the host's solid-js/@opentui
// packages and is never imported outside the OpenCode TUI (see tui.js).
export const BOARD_STORAGE_KEY = "mighty-instincts.board";
export const BOARD_BLOCK_KEYS = ["instincts", "observations", "evals"];

// board.compact only seeds each block's initial expanded/collapsed state;
// once a persisted snapshot exists (the user clicked a title at least
// once), that snapshot wins instead. The panel header always starts open
// regardless of board.compact.
export function defaultInteractionState(options) {
  const compact = options?.board?.compact === true;
  return {
    panelOpen: true,
    blocks: Object.fromEntries(BOARD_BLOCK_KEYS.map((key) => [key, !compact])),
  };
}

// Merges a persisted snapshot (as read back from ctx.storage, which may be
// a JSON string, a plain object, missing, or from an older/different
// version of this plugin) over the given defaults. Unknown block keys and
// non-boolean values are dropped rather than trusted.
export function mergeInteractionState(defaults, persisted) {
  const parsed = parsePersisted(persisted);
  if (!parsed) return defaults;

  const blocks = { ...defaults.blocks };
  if (parsed.blocks && typeof parsed.blocks === "object") {
    for (const key of BOARD_BLOCK_KEYS) {
      if (typeof parsed.blocks[key] === "boolean") blocks[key] = parsed.blocks[key];
    }
  }

  return {
    panelOpen: typeof parsed.panelOpen === "boolean" ? parsed.panelOpen : defaults.panelOpen,
    blocks,
  };
}

function parsePersisted(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      const result = JSON.parse(value);
      return typeof result === "object" && result !== null ? result : null;
    } catch {
      return null;
    }
  }
  return typeof value === "object" ? value : null;
}
