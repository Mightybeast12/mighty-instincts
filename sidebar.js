/**
 * OpenCode 2 sidebar panel for mighty-instincts.
 *
 * One box with four rows: Review, Instincts, Observe, Evals. Instincts,
 * Observe, and Evals are read from the board-state.json the server half
 * (lib/board.js) writes, found through the pointer file lib/board-pointer.js
 * describes. Review is derived here, from live host session data, the same
 * way mighty-reviewer's own sidebar derives its review row: sessions
 * titled "Adversarial review" (optionally "- <phase>") that belong to the
 * session tree being viewed. Only the phase is read from the title; no
 * findings parsing.
 *
 * Laid out like the oh-my-opencode-slim agent panel and mighty-reviewer's
 * "Mighty Reviewer" panel (single border, header row, a status glyph
 * column, muted labels) so the three read as siblings.
 *
 * Loaded lazily by tui.js: @opentui/solid and solid-js are provided by the
 * OpenCode TUI at runtime and are absent anywhere else (e.g. smoke tests).
 */

import { createElement, insert, setProp } from "@opentui/solid";
import { createMemo, createSignal } from "solid-js";
import fs from "node:fs";
import { pointerFilePath } from "./lib/board-pointer.js";
import { instinctsLines, observationsLines, evalsLines } from "./lib/board-text.js";

const HEADER = "Mighty Instincts";

// Must match the title mighty-reviewer gives its review sessions; phase
// suffixes are appended as "Adversarial review - <phase>". The metadata key
// is the one mighty-reviewer's v2.js stamps on a review session's own
// metadata ({ mightyReviewer: { parentID } }) to link it back to the
// session it reviewed, since review sessions are root sessions themselves.
const REVIEW_TITLE = "Adversarial review";
const REVIEW_METADATA_KEY = "mightyReviewer";
const TERMINAL_PHASES = new Set(["SHIP", "NO-SHIP", "done", "timed out"]);

const BORDER = { type: "single" };
const FRAME_MS = 100;
const POLL_MS = 1000;
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GLYPH_OK = "●";
const GLYPH_IDLE = "·";
const GLYPH_MISSING = "!";
const LABEL_WIDTH = 10;

const FALLBACK = {
  text: "#e5e7eb",
  muted: "#9ca3af",
  border: "#4b5563",
  success: "#22c55e",
  warning: "#f59e0b",
  error: "#ef4444",
};

export function mountSidebar(ctx) {
  const [tick, setTick] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  let animating = false;

  const pollTimer = setInterval(() => setTick((n) => n + 1), POLL_MS);
  const frameTimer = setInterval(() => {
    if (animating) setNow(Date.now());
  }, FRAME_MS);

  const dispose = ctx.ui.slot({
    append: "sidebar.content",
    render: (input) => {
      const view = createMemo(
        () => {
          tick();
          const sessionID = input?.sessionID ?? routeSessionID(ctx);
          return buildView(ctx, sessionID);
        },
        null,
        { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
      );

      const root = box({ width: "100%", flexDirection: "column" });
      insert(root, () => {
        const data = view();
        animating = data.review?.running === true;
        const colors = palette(ctx.theme);
        return renderPanel(data, colors, now);
      });
      return root;
    },
  });

  return () => {
    clearInterval(pollTimer);
    clearInterval(frameTimer);
    dispose?.();
  };
}

// ---------------------------------------------------------------- data

function buildView(ctx, sessionID) {
  const sections = ctx.options?.board?.sections ?? {};
  return {
    sections,
    review: sections.review !== false ? readReview(ctx, sessionID) : null,
    state: readBoardState(ctx),
  };
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

// Minimal: finds the most recent review session in the viewed session's
// tree and reads its phase from its title. No critic/finding parsing (the
// sidebar panel does that in full; this board row only needs the verdict).
function readReview(ctx, sessionID) {
  if (!sessionID) return null;
  const sessions = safe(() => ctx.data?.session?.list?.()) ?? [];
  const reviews = sessions.filter(isReviewSession);
  if (reviews.length === 0) return null;

  const rootID = safe(() => ctx.data.session.root(sessionID)) ?? sessionID;
  const family = new Set([rootID, sessionID, ...(safe(() => ctx.data.session.family(rootID)) ?? [])]);

  let review;
  for (const info of reviews) {
    const parentID = info.metadata?.[REVIEW_METADATA_KEY]?.parentID;
    if (!family.has(info.id) && !family.has(parentID)) continue;
    if (!review || millis(info.time?.created) > millis(review.time?.created)) review = info;
  }
  if (!review) return null;

  const phase = phaseOf(review.title);
  const finished = TERMINAL_PHASES.has(phase);
  const running = !finished && safe(() => ctx.data.session.status(review.id)) === "running";
  return { id: review.id, phase, finished, running, cycle: cycleOf(review.title) };
}

function isReviewSession(info) {
  return typeof info?.title === "string" && info.title.startsWith(REVIEW_TITLE);
}

function phaseOf(title) {
  const rest = title
    .slice(REVIEW_TITLE.length)
    .replace(/^\s*-\s*/, "")
    .trim();
  return rest || "starting";
}

// Not derivable from mighty-reviewer's actual title scheme today (its
// phases never embed a cycle count), so this returns null and the row
// simply omits the cycle detail; kept in case a future title does include it.
function cycleOf(title) {
  const match = /cycle\s+(\d+)\s*\/\s*(\d+)/i.exec(title ?? "");
  return match ? `cycle ${match[1]}/${match[2]}` : null;
}

function millis(value) {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value?.epochMillis === "number") return value.epochMillis;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function safe(read) {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function routeSessionID(ctx) {
  const route = safe(() => ctx.ui.router.current());
  return route?.type === "session" ? route.sessionID : undefined;
}

// ---------------------------------------------------------------- view

function renderPanel(data, colors, now) {
  const { sections, review, state } = data;
  const rows = [];
  if (sections.review !== false) rows.push(reviewRow(review, colors, now));
  if (sections.instincts !== false) rows.push(...labeledRows("Instincts", instinctsLines(state?.instincts), isAvailable(state?.instincts), colors));
  if (sections.observations !== false) {
    rows.push(...labeledRows("Observe", observationsLines(state?.observations), isAvailable(state?.observations), colors));
  }
  if (sections.evals !== false) rows.push(...labeledRows("Evals", evalsLines(state?.evals), isAvailable(state?.evals), colors));
  return frame(colors, [header(colors), ...rows]);
}

// A missing section (state not written yet) and an explicit
// `available: false` both render the same "!" / muted "not found" row;
// anything else (including the instincts section, which has no
// `available` flag of its own) is "ok".
function isAvailable(section) {
  return section ? section.available !== false : false;
}

function reviewRow(review, colors, now) {
  const status = reviewStatus(review, colors);
  const detail = [text({ fg: status.color, wrapMode: "none" }, [status.label])];
  if (review?.cycle) detail.push(text({ fg: colors.muted, wrapMode: "none", marginLeft: 1 }, [review.cycle]));
  return row({ glyph: reviewGlyph(review, colors, now), label: "Review", detail, colors });
}

function reviewStatus(review, colors) {
  if (!review) return { label: "idle", color: colors.muted };
  if (review.running) return { label: "running", color: colors.success };
  if (review.phase === "SHIP") return { label: "SHIP", color: colors.success };
  if (review.phase === "NO-SHIP") return { label: "NO-SHIP", color: colors.error };
  if (review.phase === "timed out") return { label: "timed out", color: colors.warning };
  if (review.finished) return { label: "done", color: colors.muted };
  return { label: review.phase, color: colors.muted };
}

function reviewGlyph(review, colors, now) {
  if (review?.running) {
    return { color: colors.success, value: () => `${FRAMES[Math.floor(now() / FRAME_MS) % FRAMES.length]} ` };
  }
  if (!review) return { color: colors.muted, value: `${GLYPH_IDLE} ` };
  const color = review.phase === "SHIP" ? colors.success : review.phase === "NO-SHIP" ? colors.error : colors.muted;
  return { color, value: `${GLYPH_OK} ` };
}

// Shared by the Instincts/Observe/Evals rows: a labeled first line with an
// ok/missing glyph, then plain continuation lines (no glyph, no label) for
// anything a section's text needs a second line for.
function labeledRows(label, lines, available, colors) {
  const glyph = available ? okGlyph(colors) : missingGlyph(colors);
  return lines.map((line, index) =>
    row({
      glyph: index === 0 ? glyph : null,
      label: index === 0 ? label : "",
      detail: [text({ fg: colors.muted, wrapMode: "none", truncate: true }, [line])],
      colors,
    }),
  );
}

function okGlyph(colors) {
  return { color: colors.muted, value: `${GLYPH_OK} ` };
}

function missingGlyph(colors) {
  return { color: colors.muted, value: `${GLYPH_MISSING} ` };
}

function frame(colors, children) {
  return box(
    { width: "100%", flexDirection: "column", border: BORDER, borderColor: colors.border, paddingTop: 1, paddingBottom: 1, paddingRight: 1 },
    children,
  );
}

function header(colors) {
  return box({ width: "100%", flexDirection: "row" }, [text({ fg: colors.text }, [HEADER])]);
}

function row({ glyph, label, detail, colors }) {
  return box({ width: "100%", flexDirection: "row", shouldFill: true }, [
    text({ fg: glyph ? glyph.color : colors.muted, width: 2, flexShrink: 0, wrapMode: "none" }, [glyph ? glyph.value : "  "]),
    text({ fg: colors.text, width: LABEL_WIDTH, flexShrink: 0, wrapMode: "none", truncate: true }, [label]),
    detail ? box({ flexDirection: "row", flexShrink: 0 }, detail) : null,
  ]);
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
    success: pick(theme, ["text.feedback.success", "success"], FALLBACK.success),
    warning: pick(theme, ["text.feedback.warning", "warning"], FALLBACK.warning),
    error: pick(theme, ["text.feedback.error", "error"], FALLBACK.error),
  };
}
