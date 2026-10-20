/**
 * OpenCode 2 sidebar panel for mighty-instincts.
 *
 * One collapsible box with a block per board source (Learned habits,
 * Skill notes, Skill test), read from the board-state.json the server
 * half (lib/board.js) writes, found through the pointer file
 * lib/board-pointer.js describes, and rendered from the structured block
 * model lib/board-text.js builds (also shared, unchanged in wording, by
 * the /board command's plain-text summary in lib/board-format.js).
 *
 * Laid out like the oh-my-opencode-slim agent panel (single border,
 * header row, two-space indented fact lines) so the two read as
 * siblings. The header and every block title are clickable: the click
 * handling (a row with an onMouseUp activator, guarded to the primary
 * mouse button) and the expand glyph are copied from oh-my-opencode-slim's
 * own sidebar (dist/tui.js: createSidebarInteraction for the signal-backed
 * open/expanded state, decorateInteractiveRow for the activation guard,
 * the ▾/▸ glyph from its agentHeaderCells), minus its hover-paint styling,
 * which this panel does not add. The default/merge logic behind the
 * collapsed state lives in lib/board-interaction.js (solid-js-free, so
 * smoke-test.mjs can assert on it); this file only wires that into solid
 * signals and persistence.
 *
 * Right alignment for a block's title row (label left, a status circle
 * plus headline right) and its detail rows (label left, value right) is
 * native flexbox here (flexGrow on the label pushes the value to the
 * row's own right edge), not lib/board-text.js's own `alignRow` string
 * helper: that one is for lib/board-format.js's plain-text output, which
 * has no layout engine to delegate to.
 *
 * Collapsed state is persisted through ctx.storage, keyed by
 * BOARD_STORAGE_KEY. The only ctx.storage surface confirmed on this
 * machine (oh-my-opencode-slim's v2 server half, which checks for it
 * before trusting it) exposes get/set/remove/scan, not a "store" method,
 * so that is what this file calls; when ctx.storage (or those methods)
 * is absent, collapsed state simply stays in-memory for the session.
 *
 * Loaded lazily by tui.js: @opentui/solid and solid-js are provided by the
 * OpenCode TUI at runtime and are absent anywhere else (e.g. smoke tests).
 */

import { createElement, insert, setProp } from "@opentui/solid";
import { createMemo, createSignal } from "solid-js";
import fs from "node:fs";
import { pointerFilePath } from "./lib/board-pointer.js";
import { buildEvalsBlock, buildInstinctsBlock, buildObservationsBlock, GLYPH_CHAR, LEGEND } from "./lib/board-text.js";
import { BOARD_STORAGE_KEY, defaultInteractionState, mergeInteractionState } from "./lib/board-interaction.js";
import { PKG_NAME, PKG_VERSION } from "./lib/pkg.js";

const HEADER = "Mighty Instincts";
const BORDER = { type: "single" };
const POLL_MS = 1000;
const GLYPH_EXPANDED = "\u25be"; // ▾
const GLYPH_COLLAPSED = "\u25b8"; // ▸
// Pulse glyph cycle for the Learned habits title (task: "reuse the
// spinner frames idea"): a slow breathe, not a spinner direction, since
// this means "recently active", not "in progress". Replaces the block's
// usual status circle while an observation landed in the last
// PULSE_WINDOW_MS, exactly as it did for the old "Instincts" title.
const PULSE_FRAMES = ["\u00b7", "\u2022", "\u25cf", "\u2022"]; // · • ● •
const PULSE_MS = 500;
const PULSE_WINDOW_MS = 60000;

const FALLBACK = {
  text: "#e5e7eb",
  muted: "#9ca3af",
  border: "#4b5563",
  warning: "#f59e0b",
  success: "#22c55e",
};

export function mountSidebar(ctx) {
  const [tick, setTick] = createSignal(0);
  const pollTimer = setInterval(() => setTick((n) => n + 1), POLL_MS);
  // Its own timer, independent of the 1s data poll above: the pulse glyph
  // must keep cycling every 500ms, and PULSE_WINDOW_MS must expire on
  // time, even for several ticks in a row where board-state.json itself
  // has not changed.
  const [pulseFrameIndex, setPulseFrameIndex] = createSignal(0);
  const pulseTimer = setInterval(() => setPulseFrameIndex((n) => (n + 1) % PULSE_FRAMES.length), PULSE_MS);
  const interaction = createInteraction(ctx);

  const dispose = ctx.ui.slot({
    append: "sidebar.content",
    render: () => {
      const view = createMemo(
        () => {
          tick();
          return buildView(ctx);
        },
        null,
        { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
      );

      const root = box({ width: "100%", flexDirection: "column" });
      insert(root, () => renderPanel(view(), palette(ctx.theme), interaction, pulseFrameIndex()));
      return root;
    },
  });

  return () => {
    clearInterval(pollTimer);
    clearInterval(pulseTimer);
    dispose?.();
  };
}

// ---------------------------------------------------------------- interaction

// Wraps lib/board-interaction.js's pure default/merge logic with solid-js
// signals and ctx.storage persistence.
function createInteraction(ctx) {
  const defaults = defaultInteractionState(ctx.options);
  const [panelOpen, setPanelOpen] = createSignal(defaults.panelOpen);
  const [blocks, setBlocks] = createSignal(defaults.blocks);

  void loadPersisted(ctx).then((persisted) => {
    if (persisted === null) return;
    const merged = mergeInteractionState(defaults, persisted);
    setPanelOpen(merged.panelOpen);
    setBlocks(merged.blocks);
  });

  function persist() {
    void savePersisted(ctx, { panelOpen: panelOpen(), blocks: blocks() });
  }

  return {
    isPanelOpen: panelOpen,
    isBlockOpen: (key) => blocks()[key] !== false,
    togglePanel: () => {
      setPanelOpen((value) => !value);
      persist();
    },
    toggleBlock: (key) => {
      setBlocks((prev) => ({ ...prev, [key]: prev[key] === false }));
      persist();
    },
  };
}

async function loadPersisted(ctx) {
  const storage = ctx.storage;
  if (!storage || typeof storage.get !== "function") return null;
  try {
    const value = await storage.get(BOARD_STORAGE_KEY);
    return value === undefined ? null : value;
  } catch {
    return null;
  }
}

async function savePersisted(ctx, value) {
  const storage = ctx.storage;
  if (!storage || typeof storage.set !== "function") return;
  try {
    await storage.set(BOARD_STORAGE_KEY, value);
  } catch {
    // Best-effort: collapsed state just resets next launch.
  }
}

// ---------------------------------------------------------------- data

function buildView(ctx) {
  const sections = ctx.options?.board?.sections ?? {};
  return { sections, state: readBoardState(ctx) };
}

function readBoardState(ctx) {
  try {
    const directory = ctx.location?.directory ?? safe(() => ctx.data?.location?.default?.())?.directory;
    if (!directory) return null;
    const pointerPath = pointerFilePath(ctx.options ?? {}, directory);
    const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
    if (!pointer?.boardStatePath) return null;
    return JSON.parse(fs.readFileSync(pointer.boardStatePath, "utf8"));
  } catch {
    return null;
  }
}

function safe(read) {
  try {
    return read();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- view

function renderPanel(data, colors, interaction, pulseFrameIndex) {
  const open = interaction.isPanelOpen();
  const header = clickableRow(() => interaction.togglePanel(), [
    glyphText(open, colors),
    text({ fg: colors.text, wrapMode: "none" }, [HEADER]),
    headerVersionText(colors),
  ]);
  if (!open) return frame(colors, [header]);

  const { sections, state } = data;
  const rows = [];
  if (sections.instincts !== false) {
    const pulseGlyph = isWithinMs(state?.instincts?.lastObservedAt, PULSE_WINDOW_MS)
      ? PULSE_FRAMES[pulseFrameIndex % PULSE_FRAMES.length]
      : null;
    rows.push(...block({ key: "instincts", model: buildInstinctsBlock(state?.instincts), interaction, colors, pulseGlyph }));
  }
  if (sections.observations !== false) {
    rows.push(...block({ key: "observations", model: buildObservationsBlock(state?.observations), interaction, colors }));
  }
  if (sections.evals !== false) {
    rows.push(...block({ key: "evals", model: buildEvalsBlock(state?.evals), interaction, colors }));
  }
  rows.push(legendRow(colors));
  return frame(colors, [header, ...rows]);
}

// True when `iso` parses to a timestamp within the last `windowMs`
// (inclusive of "just now", exclusive of the future, which a clock skew
// or a slightly-ahead write timestamp could otherwise read as "active").
function isWithinMs(iso, windowMs) {
  if (typeof iso !== "string") return false;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return false;
  const age = Date.now() - parsed;
  return age >= 0 && age < windowMs;
}

// A status circle colour for a block's glyph state ("active" success,
// "attention" warning, "stale" muted); shared by a block's own title row
// and the panel-wide legend row at the bottom.
function glyphColor(glyph, colors) {
  if (glyph === "active") return colors.success;
  if (glyph === "attention") return colors.warning;
  return colors.muted;
}

// One block: a clickable title row (label, flex-grown to push a status
// circle + headline to the row's right edge, prefixed with the same
// ▾/▸ glyph the header uses), then, when expanded, its detail rows (plain
// fact rows) and hint sub-rows (muted, no value column: the board's
// nearest equivalent to a tooltip, since the TUI has no hover).
function block({ key, model, interaction, colors, pulseGlyph = null }) {
  const expanded = interaction.isBlockOpen(key);
  const glyphChar = pulseGlyph ?? GLYPH_CHAR[model.glyph] ?? GLYPH_CHAR.stale;
  const glyphClr = pulseGlyph ? colors.success : glyphColor(model.glyph, colors);
  const title = clickableRow(() => interaction.toggleBlock(key), [
    glyphText(expanded, colors),
    text({ fg: colors.text, wrapMode: "none", truncate: true, flexGrow: 1, flexShrink: 1 }, [model.label]),
    text({ fg: glyphClr, wrapMode: "none", flexShrink: 0 }, [` ${glyphChar} `]),
    text({ fg: colors.text, wrapMode: "none", flexShrink: 0, truncate: true }, [model.headline]),
  ]);
  if (!expanded) return [title];
  return [title, ...model.rows.map((row) => ("hint" in row ? hintRow(row.hint, colors) : detailRow(row, colors)))];
}

// A plain, non-interactive detail row: label flex-grown on the left,
// value anchored to the right edge, muted (facts are supporting detail,
// never as prominent as the title row's own label/headline).
function detailRow(row, colors) {
  return box({ width: "100%", flexDirection: "row", paddingLeft: 2, shouldFill: true }, [
    text({ fg: colors.muted, wrapMode: "none", truncate: true, flexGrow: 1, flexShrink: 1 }, [row.label]),
    text({ fg: colors.muted, wrapMode: "none", flexShrink: 0 }, [` ${row.value}`]),
  ]);
}

// A hint sub-row ("run /promote to share them", "see <path>"): indented
// one level deeper than a detail row and with no value column of its own,
// since it is explanatory text, not a fact.
function hintRow(hint, colors) {
  return box({ width: "100%", flexDirection: "row", paddingLeft: 4, shouldFill: true }, [
    text({ fg: colors.muted, wrapMode: "none", truncate: true }, [hint]),
  ]);
}

// The panel-wide legend ("● active  ● needs attention  ○ stale"), shown
// once at the bottom of an expanded panel (not per block): muted, with
// each glyph in its own status colour.
function legendRow(colors) {
  const children = [];
  LEGEND.forEach((entry, index) => {
    if (index > 0) children.push(text({ fg: colors.muted, wrapMode: "none" }, ["  "]));
    children.push(text({ fg: glyphColor(entry.glyph, colors), wrapMode: "none" }, [GLYPH_CHAR[entry.glyph]]));
    children.push(text({ fg: colors.muted, wrapMode: "none" }, [` ${entry.label}`]));
  });
  return box({ width: "100%", flexDirection: "row", paddingTop: 1, shouldFill: true }, children);
}

function glyphText(expanded, colors) {
  return text({ fg: colors.muted, width: 2, flexShrink: 0, wrapMode: "none" }, [`${expanded ? GLYPH_EXPANDED : GLYPH_COLLAPSED} `]);
}

// " v<version>" in the header's own muted color, read once at module load
// from package.json (lib/pkg.js); omitted entirely when that read failed
// (PKG_VERSION is then ""), so the header falls back to the bare title.
function headerVersionText(colors) {
  if (!PKG_VERSION) return null;
  return text({ fg: colors.muted, wrapMode: "none" }, [` v${PKG_VERSION}`]);
}

// A row whose click (primary mouse button only, mirroring
// oh-my-opencode-slim's shouldActivateRow guard) runs onToggle.
function clickableRow(onToggle, children) {
  return box(
    {
      width: "100%",
      flexDirection: "row",
      shouldFill: true,
      onMouseUp: (event) => {
        if (event?.button !== undefined && event.button !== 0) return;
        onToggle();
      },
    },
    children,
  );
}

function frame(colors, children) {
  return box(
    { width: "100%", flexDirection: "column", border: BORDER, borderColor: colors.border, paddingTop: 1, paddingBottom: 1, paddingRight: 1 },
    children,
  );
}

function element(tag, props, children = []) {
  const node = createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) setProp(node, key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (!isInsertableChild(child)) {
      warnInvalidChildOnce(child);
      continue;
    }
    insert(node, child);
  }
  return node;
}

// @opentui/solid's insert() assumes a child is either text (string) or a
// Renderable node tracked through .once(...) lifecycle events; a plain
// array or object (e.g. a data value that slipped into a children array
// instead of being rendered into a text node first) has neither, and
// insert() throwing "n.once is undefined" on one takes the whole sidebar
// panel down with it.
function isInsertableChild(child) {
  if (typeof child === "string" || typeof child === "function") return true;
  return typeof child === "object" && child !== null && typeof child.once === "function";
}

let warnedInvalidChild = false;
function warnInvalidChildOnce(child) {
  if (warnedInvalidChild) return;
  warnedInvalidChild = true;
  console.error(`[${PKG_NAME}] skipped a non-renderable sidebar child`, child);
}

function box(props, children) {
  return element("box", props, children);
}

function text(props, children) {
  return element("text", props, children);
}

// ---------------------------------------------------------------- theme

// Resolves a color from the first theme path that exists. OpenCode 2.0.26
// nests colors as text.base / text.feedback.success.base; earlier 2.x builds
// used text.default / text.subdued. A color is a string or an RGBA object.
function pick(theme, paths, fallback) {
  for (const path of paths) {
    let value = theme;
    for (const key of path.split(".")) value = value?.[key];
    if (isColorGroup(value)) value = value.base;
    if (typeof value === "string" || isRGBA(value)) return value;
  }
  return fallback;
}

function isRGBA(value) {
  return typeof value === "object" && value !== null && "r" in value;
}

function isColorGroup(value) {
  return typeof value === "object" && value !== null && !isRGBA(value) && "base" in value;
}

function palette(theme) {
  return {
    text: pick(theme, ["text.base", "text.default", "text"], FALLBACK.text),
    muted: pick(theme, ["text.muted", "text.subdued", "textMuted"], FALLBACK.muted),
    border: pick(theme, ["border.base", "border.default", "borderActive"], FALLBACK.border),
    warning: pick(theme, ["text.feedback.warning", "warning"], FALLBACK.warning),
    success: pick(theme, ["text.feedback.success", "success"], FALLBACK.success),
  };
}
