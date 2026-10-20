/**
 * OpenCode 2 sidebar panel for mighty-instincts.
 *
 * One collapsible box with a block per board source (Instincts, Skill
 * observations, Skill evals), read from the board-state.json the server
 * half (lib/board.js) writes, found through the pointer file
 * lib/board-pointer.js describes.
 *
 * Laid out like the oh-my-opencode-slim agent panel (single border,
 * header row, two-space indented detail rows) so the two read as
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
 * Every fact line is also clickable: it opens a companion detail panel
 * (registered as a second, "session.panel" slot claim named
 * "mighty-instincts.detail", see lib/board-detail.js's DETAIL_PANEL_NAME)
 * showing that block's full data - every instinct with a confidence bar
 * plus the observer.log tail, every open skill with its count plus the
 * newest observations, or the eval's full pass-rate/stddev/first-failure
 * detail. A global `/instincts-detail` command (registered through
 * ctx.keymap.layer, guarded since that surface is still new) opens the
 * same panel for hosts without the sidebar's own click handling. Both
 * additions are entirely optional: a host whose `ctx.ui` has no `.panel`,
 * or whose `ctx.keymap` has no `.layer`, simply never sees them claimed.
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
import path from "node:path";
import { pointerFilePath } from "./lib/board-pointer.js";
import { evalsLines, EVALS_TOOL, instinctsLines, instinctsToolName, observationsLines, OBSERVATIONS_TOOL } from "./lib/board-text.js";
import { BOARD_STORAGE_KEY, defaultInteractionState, mergeInteractionState } from "./lib/board-interaction.js";
import { confidenceBar, DETAIL_PANEL_NAME, formatAge, formatRateWithStddev, lastLines, sortedByConfidenceDesc } from "./lib/board-detail.js";
import { relativeTime } from "./lib/relative-time.js";
import { PKG_NAME } from "./lib/pkg.js";

const HEADER = "Mighty Instincts";
const BORDER = { type: "single" };
const POLL_MS = 1000;
const GLYPH_EXPANDED = "\u25be"; // ▾
const GLYPH_COLLAPSED = "\u25b8"; // ▸
const GLYPH_MISSING = "!";
const OBSERVER_LOG_TAIL_LINES = 5;

const FALLBACK = {
  text: "#e5e7eb",
  muted: "#9ca3af",
  border: "#4b5563",
  warning: "#f59e0b",
};

export function mountSidebar(ctx) {
  const [tick, setTick] = createSignal(0);
  const pollTimer = setInterval(() => setTick((n) => n + 1), POLL_MS);
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
      insert(root, () => renderPanel(view(), palette(ctx.theme), interaction));
      return root;
    },
  });

  const disposeDetail = registerDetailPanel(ctx, interaction);
  const disposeGlobalCommand = registerGlobalCommand(ctx, interaction);

  return () => {
    clearInterval(pollTimer);
    dispose?.();
    disposeDetail?.();
    disposeGlobalCommand?.();
  };
}

// ---------------------------------------------------------------- interaction

// Wraps lib/board-interaction.js's pure default/merge logic with solid-js
// signals and ctx.storage persistence, plus (new) which block's detail
// panel is currently showing.
function createInteraction(ctx) {
  const defaults = defaultInteractionState(ctx.options);
  const [panelOpen, setPanelOpen] = createSignal(defaults.panelOpen);
  const [blocks, setBlocks] = createSignal(defaults.blocks);
  const [selectedBlock, setSelectedBlock] = createSignal(null);

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
    selectedBlock,
    togglePanel: () => {
      setPanelOpen((value) => !value);
      persist();
    },
    toggleBlock: (key) => {
      setBlocks((prev) => ({ ...prev, [key]: prev[key] === false }));
      persist();
    },
    // Records which block a fact-line click (or the /instincts-detail
    // command) wants the detail panel to show, then opens the panel
    // itself; a host without a working ctx.ui.panel just gets the signal
    // update, with nothing else to show it in.
    openDetail: (key) => {
      setSelectedBlock(key);
      try {
        ctx.ui?.panel?.open?.(DETAIL_PANEL_NAME, { presentation: "panel" });
      } catch (error) {
        console.error(`[${PKG_NAME}] opening the detail panel failed`, error);
      }
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

// observer.log lives beside board-state.json (both under the project's
// ECC data directory; see lib/board-pointer.js), so the detail panel can
// read its tail straight off disk through the same pointer file instead
// of duplicating the whole log into board-state.json.
function readObserverLogTail(ctx, limit) {
  try {
    const directory = ctx.location?.directory ?? safe(() => ctx.data?.location?.default?.())?.directory;
    if (!directory) return [];
    const pointerPath = pointerFilePath(ctx.options ?? {}, directory);
    const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
    if (!pointer?.boardStatePath) return [];
    const logPath = path.join(path.dirname(pointer.boardStatePath), "observer.log");
    return lastLines(fs.readFileSync(logPath, "utf8"), limit);
  } catch {
    return [];
  }
}

function safe(read) {
  try {
    return read();
  } catch {
    return undefined;
  }
}

// A missing section (state not written yet) and an explicit
// `available: false` both render as a single "!" / "not found" fact row;
// anything else (including the instincts block, which has no
// `available` flag of its own) renders its normal fact lines.
function isAvailable(section) {
  return section ? section.available !== false : false;
}

// ---------------------------------------------------------------- view

function renderPanel(data, colors, interaction) {
  const open = interaction.isPanelOpen();
  const header = clickableRow(() => interaction.togglePanel(), [
    glyphText(open, colors),
    text({ fg: colors.text, wrapMode: "none" }, [HEADER]),
  ]);
  if (!open) return frame(colors, [header]);

  const { sections, state } = data;
  const rows = [];
  if (sections.instincts !== false) {
    rows.push(
      ...block({
        key: "instincts",
        label: "Instincts",
        tool: instinctsToolName(state?.instincts),
        lines: instinctsLines(state?.instincts),
        available: true,
        warnFirstLine: false,
        interaction,
        colors,
      }),
    );
  }
  if (sections.observations !== false) {
    rows.push(
      ...block({
        key: "observations",
        label: "Skill observations",
        tool: OBSERVATIONS_TOOL,
        lines: observationsLines(state?.observations),
        available: isAvailable(state?.observations),
        warnFirstLine: state?.observations?.warning === true,
        interaction,
        colors,
      }),
    );
  }
  if (sections.evals !== false) {
    rows.push(
      ...block({
        key: "evals",
        label: "Skill evals",
        tool: EVALS_TOOL,
        lines: evalsLines(state?.evals),
        available: isAvailable(state?.evals),
        warnFirstLine: false,
        interaction,
        colors,
      }),
    );
  }
  return frame(colors, [header, ...rows]);
}

// One block: a clickable title row (section name in normal text, then
// " · " and the tool name in muted, prefixed with the same ▾/▸ glyph the
// header uses), then, when expanded, either its normal fact lines
// (each itself clickable, opening this block's detail panel) or
// (available === false) a single "!" / "not found" row.
function block({ key, label, tool, lines, available, warnFirstLine, interaction, colors }) {
  const expanded = interaction.isBlockOpen(key);
  const title = clickableRow(() => interaction.toggleBlock(key), [
    glyphText(expanded, colors),
    text({ fg: colors.text, wrapMode: "none", truncate: true, flexShrink: 1 }, [label]),
    text({ fg: colors.muted, wrapMode: "none", truncate: true, flexShrink: 0 }, [` \u00b7 ${tool}`]),
  ]);
  if (!expanded) return [title];
  if (!available) return [title, missingRow(colors)];
  const onOpen = () => interaction.openDetail(key);
  return [title, ...lines.map((line, index) => factRow(line, colors, { warning: warnFirstLine && index === 0, onOpen }))];
}

function glyphText(expanded, colors) {
  return text({ fg: colors.muted, width: 2, flexShrink: 0, wrapMode: "none" }, [`${expanded ? GLYPH_EXPANDED : GLYPH_COLLAPSED} `]);
}

// A fact row normally carries no glyph; `warning` swaps its usual
// paddingLeft for a colored "!" glyph of the same width, used for the
// observations block's first line when state.observations.warning is
// true. `onOpen`, when given, makes the whole row clickable (primary
// mouse button only) to open this block's detail panel.
function factRow(line, colors, { warning = false, onOpen } = {}) {
  const children = [];
  if (warning) {
    children.push(text({ fg: colors.warning, width: 2, flexShrink: 0, wrapMode: "none" }, [`${GLYPH_MISSING} `]));
  }
  children.push(text({ fg: colors.muted, wrapMode: "none", truncate: true }, [line]));
  return box(
    {
      width: "100%",
      flexDirection: "row",
      paddingLeft: warning ? 0 : 2,
      shouldFill: true,
      onMouseUp: onOpen
        ? (event) => {
            if (event?.button !== undefined && event.button !== 0) return;
            onOpen();
          }
        : undefined,
    },
    children,
  );
}

function missingRow(colors) {
  return box({ width: "100%", flexDirection: "row", shouldFill: true }, [
    text({ fg: colors.warning, width: 2, flexShrink: 0, wrapMode: "none" }, [`${GLYPH_MISSING} `]),
    text({ fg: colors.muted, wrapMode: "none", truncate: true }, ["not found"]),
  ]);
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
    insert(node, child);
  }
  return node;
}

function box(props, children) {
  return element("box", props, children);
}

function text(props, children) {
  return element("text", props, children);
}

// ---------------------------------------------------------------- detail panel

// Registers the sidebar's companion detail panel, opened by clicking a
// fact line (createInteraction's openDetail) or by the /instincts-detail
// command below. A second "session.panel" slot claim, guarded on the
// host actually offering a panel API: a narrower ctx.ui with no `.panel`
// never sees this slot claimed, so there is nothing to clean up either.
function registerDetailPanel(ctx, interaction) {
  if (!ctx.ui?.panel || typeof ctx.ui.slot !== "function") return undefined;
  try {
    return ctx.ui.slot({
      append: "session.panel",
      render: (panel) => {
        if (panel?.name !== DETAIL_PANEL_NAME) return null;
        const view = createMemo(
          () => buildDetailView(ctx, interaction.selectedBlock()),
          null,
          { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
        );
        const root = box({ width: "100%", flexDirection: "column" });
        insert(root, () => renderDetail(view(), palette(ctx.theme)));
        return root;
      },
    });
  } catch (error) {
    console.error(`[${PKG_NAME}] detail panel unavailable`, error);
    return undefined;
  }
}

function buildDetailView(ctx, selected) {
  const state = readBoardState(ctx);
  const key = selected ?? "instincts";
  if (key === "observations") {
    return {
      kind: "observations",
      skills: Array.isArray(state?.observations?.skills) ? state.observations.skills : [],
      newest: Array.isArray(state?.observations?.newest) ? state.observations.newest : [],
    };
  }
  if (key === "evals") {
    return { kind: "evals", evals: state?.evals ?? null };
  }
  return {
    kind: "instincts",
    list: sortedByConfidenceDesc(state?.instincts?.list),
    logLines: readObserverLogTail(ctx, OBSERVER_LOG_TAIL_LINES),
  };
}

// Scrollable when the host's @opentui/solid build offers a "scrollbox"
// element, plain (no scrolling) otherwise: feature-detected by trying to
// create one, since there is no capability flag to check instead.
function renderDetail(view, colors) {
  const container = tryCreate("scrollbox", { width: "100%", flexDirection: "column" }) ?? box({ width: "100%", flexDirection: "column" }, []);
  for (const child of detailChildren(view, colors)) {
    if (child) insert(container, child);
  }
  return container;
}

function tryCreate(tag, props) {
  try {
    return element(tag, props, []);
  } catch {
    return null;
  }
}

function detailChildren(view, colors) {
  if (view.kind === "observations") return observationsDetailChildren(view, colors);
  if (view.kind === "evals") return evalsDetailChildren(view, colors);
  return instinctsDetailChildren(view, colors);
}

function detailHeading(label, colors) {
  return text({ fg: colors.text, wrapMode: "none" }, [label]);
}

function detailLine(label, colors) {
  return text({ fg: colors.muted, wrapMode: "none", truncate: true }, [label]);
}

function instinctsDetailChildren(view, colors) {
  const rows = [detailHeading("Instincts", colors)];
  if (view.list.length === 0) {
    rows.push(detailLine("No instincts recorded yet.", colors));
  }
  for (const instinct of view.list) {
    const domain = instinct.domain ?? "unknown";
    rows.push(detailLine(`${instinct.id} ${confidenceBar(instinct.confidence)} ${domain}`, colors));
  }
  rows.push(detailHeading("Recent observer.log", colors));
  if (view.logLines.length === 0) {
    rows.push(detailLine("No observer.log yet.", colors));
  }
  for (const line of view.logLines) {
    rows.push(detailLine(line, colors));
  }
  return rows;
}

function observationsDetailChildren(view, colors) {
  const rows = [detailHeading("Skills in the open backlog", colors)];
  if (view.skills.length === 0) {
    rows.push(detailLine("No open skills recorded.", colors));
  }
  for (const entry of view.skills) {
    rows.push(detailLine(`${entry.skill} ${entry.count}`, colors));
  }
  rows.push(detailHeading("Newest observations", colors));
  if (view.newest.length === 0) {
    rows.push(detailLine("No observations recorded.", colors));
  }
  for (const entry of view.newest) {
    rows.push(detailLine(`${entry.title ?? "(untitled)"} \u00b7 ${formatAge(entry.date, relativeTime)}`, colors));
  }
  return rows;
}

function evalsDetailChildren(view, colors) {
  const evals = view.evals;
  if (!evals || evals.available === false) {
    return [detailHeading("Skill evals", colors), detailLine("Not found.", colors)];
  }
  const rows = [
    detailHeading("Skill evals", colors),
    detailLine(`Skill: ${evals.skill ?? "?"}`, colors),
    detailLine(`Path: ${evals.path ?? "?"}`, colors),
    detailLine(`Timestamp: ${evals.timestamp ?? "?"}`, colors),
    detailLine(`With skill: ${formatRateWithStddev(evals.withSkill, evals.stddev?.with)}`, colors),
    detailLine(`Baseline: ${formatRateWithStddev(evals.baseline, evals.stddev?.baseline)}`, colors),
  ];
  if (evals.firstFailure) {
    rows.push(detailLine(`Failed: ${evals.firstFailure.text ?? "?"}`, colors));
    rows.push(detailLine(`Evidence: ${evals.firstFailure.evidence ?? "?"}`, colors));
  } else {
    rows.push(detailLine("No failing expectations.", colors));
  }
  return rows;
}

// ---------------------------------------------------------------- global command

// Adds a global `/instincts-detail` command that opens the same detail
// panel a fact-line click does, for hosts whose command palette a user
// prefers over clicking. Registered through an "app" slot claim (render
// always returns null; the slot exists only to get a render tick to
// register the keymap layer on - the same pattern mighty-reviewer is
// adopting) and guarded on ctx.keymap actually having a `.layer` method,
// since this is new, unstabilised host surface that may simply not exist
// yet on a given build.
function registerGlobalCommand(ctx, interaction) {
  if (typeof ctx.ui?.slot !== "function") return undefined;
  let registered = false;
  try {
    return ctx.ui.slot({
      append: "app",
      render: () => {
        if (!registered && typeof ctx.keymap?.layer === "function") {
          registered = true;
          try {
            ctx.keymap.layer({
              commands: [
                {
                  name: "instincts-detail",
                  slash: "instincts-detail",
                  description: "Open the Mighty Instincts detail panel.",
                  run: () => interaction.openDetail(interaction.selectedBlock() ?? "instincts"),
                },
              ],
            });
          } catch (error) {
            console.error(`[${PKG_NAME}] instincts-detail command registration failed`, error);
          }
        }
        return null;
      },
    });
  } catch (error) {
    console.error(`[${PKG_NAME}] instincts-detail command slot unavailable`, error);
    return undefined;
  }
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
  };
}
