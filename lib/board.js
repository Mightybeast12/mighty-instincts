// Builds the on-disk board-state.json the TUI sidebar panel (tui.js /
// sidebar.js) polls, and the pointer file that lets the TUI find it without
// ever running ECC's project-detection python subprocess itself. See
// lib/board-pointer.js for why the pointer exists at all.
//
// Refreshed on plugin setup, after every observer run (lib/observer.js's
// afterRun hook), and on a timer (createBoardController below); see
// lib/plugin.js for the wiring.
import fs from "node:fs/promises";
import path from "node:path";
import { resolveProject } from "./project.js";
import { listInstincts, uniqueSuffix } from "./store.js";
import { countObservationLines, pendingSince, readObserverState } from "./observer-state.js";
import { resolveHomunculusDir } from "./homunculus-dir.js";
import { pointerFilePath } from "./board-pointer.js";
import { DEFAULT_OBSERVATIONS_ROOT, readTaskObserverSummary } from "./board-observations.js";
import { defaultEvalRoots, readEvalsSummary } from "./board-evals.js";
import { PKG_NAME } from "./pkg.js";

const DEFAULT_REFRESH_SECONDS = 30;
// Mirrors vendor/ecc/instinct-cli.py:128's PROMOTE_CONFIDENCE_THRESHOLD.
// This board-only heuristic (confidence alone, no cross-project tally) is
// a quick "how many look like promote candidates" count for the sidebar,
// not a reimplementation of the CLI's real `promote` command (which also
// requires the instinct to appear in PROMOTE_MIN_PROJECTS+ projects).
const PROMOTE_CONFIDENCE = 0.8;
// Caps keep board-state.json well under the ~50 KB budget even on a
// project with hundreds of instinct files.
const INSTINCTS_LIST_CAP = 200;
const INSTINCT_TRIGGER_CLIP_CHARS = 120;
const RUN_LINE = /^\S+ run: (\d+) written, (\d+) rejected, model /;

// Owns the refresh timer and exposes `refresh()` for the one-off triggers
// (plugin setup, after an observer run, /board). `enabled` mirrors
// options.board.enabled: when false every call is a no-op, so callers never
// need their own enabled-check beside this one.
export function createBoardController(ctx, options) {
  const enabled = options.board?.enabled !== false;
  const refreshMs = Math.max(1, Number(options.board?.refreshSeconds) || DEFAULT_REFRESH_SECONDS) * 1000;
  let timer = null;

  async function refresh() {
    if (!enabled) return null;
    try {
      return await refreshBoardState(ctx, options);
    } catch (error) {
      console.warn(`[${PKG_NAME}] board refresh failed`, error);
      return null;
    }
  }

  return {
    enabled,
    refresh,
    start() {
      if (!enabled || timer) return;
      void refresh();
      timer = setInterval(() => void refresh(), refreshMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export async function refreshBoardState(ctx, options) {
  const project = await resolveProject(ctx, options);
  const state = await buildBoardState(ctx, options, project);
  await writeBoardState(ctx, options, project, state);
  return state;
}

async function buildBoardState(ctx, options, project) {
  const sections = options.board?.sections ?? {};
  const [instincts, observations, evals] = await Promise.all([
    sections.instincts !== false ? buildInstinctsSection(project, options) : null,
    sections.observations !== false ? readTaskObserverSummary(resolveObservationsRoot(options)) : null,
    sections.evals !== false ? readEvalsSummary(resolveEvalRoots(options)) : null,
  ]);
  const state = { updatedAt: new Date().toISOString() };
  if (instincts) state.instincts = instincts;
  if (observations) state.observations = observations;
  if (evals) state.evals = evals;
  return state;
}

async function buildInstinctsSection(project, options) {
  const cfg = options.observer ?? {};
  const [personal, inherited, globalPersonal, observerState, lineCount, logSummary] = await Promise.all([
    listInstincts(project.instincts_personal),
    listInstincts(project.instincts_inherited),
    listInstincts(path.join(resolveHomunculusDir(options), "instincts", "personal")),
    readObserverState(project.project_dir),
    countObservationLines(project.observations_file),
    readObserverLogSummary(project.project_dir),
  ]);

  const intervalMs = (Number(cfg.runIntervalMinutes) || 5) * 60000;
  const nextRunEligibleAt = observerState.lastRunAt
    ? new Date(new Date(observerState.lastRunAt).getTime() + intervalMs).toISOString()
    : null;

  // Combines every instinct this project can see (its own, inherited, and
  // the shared global bucket) into one pool for the richer facts below;
  // the project/inherited/global counts above stay split, since those are
  // also used on their own (e.g. by lib/board-text.js's "N inherited").
  const combined = [...personal, ...inherited, ...globalPersonal];
  const newest = newestInstinct(combined);

  return {
    project: personal.length,
    inherited: inherited.length,
    global: globalPersonal.length,
    lastRun: observerState.lastRunAt,
    pendingObservations: pendingSince(observerState, lineCount),
    nextRunEligibleAt,
    observerEnabled: cfg.enabled === true,
    model: cfg.model ?? null,
    readyToPromote: combined.filter((inst) => (Number(inst.confidence) || 0) >= PROMOTE_CONFIDENCE).length,
    domains: tallyDomains(combined),
    newestId: newest?.id ?? null,
    newestAt: newest ? new Date(newest.mtimeMs).toISOString() : null,
    runs: logSummary.runs,
    written: logSummary.written,
    rejected: logSummary.rejected,
    list: buildInstinctsList(combined),
  };
}

function tallyDomains(instincts) {
  const counts = new Map();
  for (const inst of instincts) {
    const name = typeof inst.domain === "string" && inst.domain.length > 0 ? inst.domain : "unknown";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function newestInstinct(instincts) {
  let newest = null;
  for (const inst of instincts) {
    if (typeof inst.mtimeMs !== "number") continue;
    if (!newest || inst.mtimeMs > newest.mtimeMs) newest = inst;
  }
  return newest;
}

// Detail-panel data for the sidebar (lib/board-detail.js draws the
// confidence bar, sidebar.js renders it): every instinct this project can
// see, sorted by confidence first so the panel's most-trusted instincts
// are visible without scrolling, capped and trigger-clipped to keep
// board-state.json small.
function buildInstinctsList(instincts) {
  return instincts
    .slice()
    .sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0))
    .slice(0, INSTINCTS_LIST_CAP)
    .map((inst) => ({
      id: inst.id,
      confidence: Number(inst.confidence) || 0,
      domain: typeof inst.domain === "string" && inst.domain.length > 0 ? inst.domain : null,
      trigger: clipTrigger(inst.trigger),
    }));
}

function clipTrigger(value) {
  if (typeof value !== "string") return null;
  return value.length > INSTINCT_TRIGGER_CLIP_CHARS ? value.slice(0, INSTINCT_TRIGGER_CLIP_CHARS) : value;
}

// One small read of observer.log, summed across every "run:" line it can
// match (lib/observer.js writes one per run, plus an unmatched "run
// skipped: no observations" line when there was nothing to analyse, which
// this intentionally excludes from the run count).
async function readObserverLogSummary(projectDir) {
  let content;
  try {
    content = await fs.readFile(path.join(projectDir, "observer.log"), "utf8");
  } catch {
    return { runs: 0, written: 0, rejected: 0 };
  }
  let runs = 0;
  let written = 0;
  let rejected = 0;
  for (const line of content.split("\n")) {
    const match = RUN_LINE.exec(line);
    if (!match) continue;
    runs += 1;
    written += Number(match[1]) || 0;
    rejected += Number(match[2]) || 0;
  }
  return { runs, written, rejected };
}

function resolveObservationsRoot(options) {
  return expandHome(options.board?.observationsRoot) ?? DEFAULT_OBSERVATIONS_ROOT;
}

function resolveEvalRoots(options) {
  const configured = options.board?.evalRoots;
  if (Array.isArray(configured) && configured.length > 0) {
    return configured.map((root) => expandHome(root)).filter(Boolean);
  }
  return defaultEvalRoots();
}

function expandHome(value) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value === "~") return process.env.HOME ?? undefined;
  if (value.startsWith("~/")) return path.join(process.env.HOME ?? "", value.slice(2));
  return value;
}

async function writeBoardState(ctx, options, project, state) {
  const stateFile = path.join(project.project_dir, "board-state.json");
  await atomicWriteJson(stateFile, state);

  const directory = ctx.location?.directory ?? "";
  const pointerFile = pointerFilePath(options, directory);
  await atomicWriteJson(pointerFile, { boardStatePath: stateFile });
}

async function atomicWriteJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${uniqueSuffix()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}
