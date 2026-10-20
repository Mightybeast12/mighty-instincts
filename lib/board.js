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
  const [personal, inherited, globalPersonal, observerState, lineCount] = await Promise.all([
    listInstincts(project.instincts_personal),
    listInstincts(project.instincts_inherited),
    listInstincts(path.join(resolveHomunculusDir(options), "instincts", "personal")),
    readObserverState(project.project_dir),
    countObservationLines(project.observations_file),
  ]);

  const intervalMs = (Number(cfg.runIntervalMinutes) || 5) * 60000;
  const nextRunEligibleAt = observerState.lastRunAt
    ? new Date(new Date(observerState.lastRunAt).getTime() + intervalMs).toISOString()
    : null;

  return {
    project: personal.length,
    inherited: inherited.length,
    global: globalPersonal.length,
    lastRun: observerState.lastRunAt,
    pendingObservations: pendingSince(observerState, lineCount),
    nextRunEligibleAt,
    observerEnabled: cfg.enabled === true,
    model: cfg.model ?? null,
  };
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
