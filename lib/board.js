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
import { resolveProject, siblingInstinctsDir } from "./project.js";
import { clipSummaryWordBoundary, listInstincts, uniqueSuffix } from "./store.js";
import { countObservationLines, pendingSince, readObserverState } from "./observer-state.js";
import { evaluateObserverGate, parseModelRef } from "./observer.js";
import { readActivitySnapshot } from "./activity.js";
import { resolveHomunculusDir } from "./homunculus-dir.js";
import { pointerFilePath } from "./board-pointer.js";
import { DEFAULT_OBSERVATIONS_ROOT, readTaskObserverSummary } from "./board-observations.js";
import { defaultEvalRoots, readEvalsSummary } from "./board-evals.js";
import { promoteStep, readMaintenanceSummary, resolveUnusedDays } from "./maintain.js";
import { candidateCounts, findUnusedInstalled, loadCandidates, numberCandidates } from "./candidates.js";
import { readUsage } from "./usage.js";
import { DEFAULT_INJECT_OPTIONS, selectForInjection } from "./inject.js";
import { collectHealth } from "./health.js";
import { PKG_NAME } from "./pkg.js";

const DEFAULT_REFRESH_SECONDS = 30;
// Caps keep board-state.json well under the ~50 KB budget even on a
// project with hundreds of instinct files.
const INSTINCTS_LIST_CAP = 200;
const INSTINCT_TRIGGER_CLIP_CHARS = 120;
// Caps the candidate preview list the same way INSTINCTS_LIST_CAP above
// caps the instinct list, for board-state.json's own size budget:
// evolveStep's own clustering naturally keeps the candidate pool far
// smaller than the raw instinct pool, but a cap still keeps a
// pathological project bounded.
const PROPOSED_LIST_CAP = 100;
const RUN_LINE = /^\S+ run: (\d+) written, (\d+) rejected, model /;
// A `max` large enough that selectForInjection's own cap (lib/inject.js)
// never trims the "habits in prompts" eligibility count; only the real
// confidence/exclude/malformed-trigger filters should decide that number,
// not the separate, per-request `inject.max` budget.
const HABITS_NO_CAP = Number.MAX_SAFE_INTEGER;
// Up to 5 of today's fired-today habits are listed, one per line, in the
// /board chat summary (lib/board-format.js): clipped at a word boundary
// (clipSummaryWordBoundary), not a hard character cut, since that reply
// has no 36-column sidebar budget to justify one.
const FIRED_TODAY_SUMMARY_CLIP_CHARS = 100;
const FIRED_TODAY_TOP_CAP = 5;

// ------------------------------------------------------------- caches
//
// The observation line count and the cross-project promote count are
// both expensive per refresh (a 10 MB file read; a walk of every
// project's own instinct files), so both are cached here, keyed on
// cheap signals (a file's own size and mtimeMs, or a composite of
// several directories' mtimeMs) that change whenever the underlying
// data actually does, including a content-only edit: every write this
// plugin's own store.js/candidates.js module makes is a
// tmp-file-then-rename, and a rename that replaces an existing directory
// entry still updates that directory's own mtime. Module-level, so the
// cache survives across repeated refreshes of the same project.
const lineCountCache = new Map(); // observations file path -> { size, mtimeMs, count }
let observationLineReads = 0;
const promoteReadyCache = new Map(); // homunculus dir -> { signature, count }
let promoteReadyReads = 0;

// Test seam only: lets a test assert that an unchanged file (or
// unchanged set of project directories) is never re-read on a second
// refresh, and that a changed one is seen on the next.
export function _boardCacheStats() {
  return { observationLineReads, promoteReadyReads };
}
export function _resetBoardCaches() {
  observationLineReads = 0;
  promoteReadyReads = 0;
  lineCountCache.clear();
  promoteReadyCache.clear();
}

async function cachedCountObservationLines(file) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    lineCountCache.delete(file);
    return 0;
  }
  const cached = lineCountCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.count;
  observationLineReads += 1;
  const count = await countObservationLines(file);
  lineCountCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, count });
  return count;
}

// A cheap stand-in for "would promoteStep's own, much more expensive
// full-content scan see anything different this time": the mtimeMs of
// every directory promoteStep itself reads (each project's own personal/
// archive instinct dirs, the global personal/archive dirs, and the
// projects registry file), stat-only, never the file contents those
// directories hold.
async function promoteReadySignature(options) {
  const homunculus = resolveHomunculusDir(options);
  const projectsRoot = path.join(homunculus, "projects");
  let projectEntries;
  try {
    projectEntries = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return "no-projects";
  }
  const parts = [
    `global-personal:${await safeMtime(path.join(homunculus, "instincts", "personal"))}`,
    `global-archive:${await safeMtime(path.join(homunculus, "instincts", "archive"))}`,
    `registry:${await safeMtime(path.join(homunculus, "projects.json"))}`,
  ];
  for (const entry of projectEntries) {
    if (!entry.isDirectory()) continue;
    const personalMtime = await safeMtime(path.join(projectsRoot, entry.name, "instincts", "personal"));
    const archiveMtime = await safeMtime(path.join(projectsRoot, entry.name, "instincts", "archive"));
    parts.push(`${entry.name}:${personalMtime}:${archiveMtime}`);
  }
  return parts.sort().join("|");
}

async function safeMtime(target) {
  try {
    return (await fs.stat(target)).mtimeMs;
  } catch {
    return "missing";
  }
}

// Runs lib/maintain.js's own promoteStep in dry-run mode, across every
// project in the homunculus (promoteStep is cross-project by design, not
// scoped to the current one), and counts only its "would copy" log
// lines. promoteStep's own `promoted` return value is always 0 in
// dry-run mode (every branch `continue`s before incrementing it), so the
// count has to come from the log instead.
async function countPromoteReady(options) {
  let count = 0;
  await promoteStep(options, {
    dryRun: true,
    log: (line) => {
      if (line.startsWith("promote: would copy ")) count += 1;
    },
  });
  return count;
}

async function countPromoteReadyCached(options) {
  const homunculus = resolveHomunculusDir(options);
  const signature = await promoteReadySignature(options);
  const cached = promoteReadyCache.get(homunculus);
  if (cached && cached.signature === signature) return cached.count;
  promoteReadyReads += 1;
  const count = await countPromoteReady(options);
  promoteReadyCache.set(homunculus, { signature, count });
  return count;
}

// Owns the refresh timer and exposes `refresh()` for the one-off triggers
// (plugin setup, after an observer run, /board). `enabled` mirrors
// options.board.enabled: when false every call is a no-op, so callers never
// need their own enabled-check beside this one. `warnings` (lib/plugin.js's
// own validateOptions output) rides straight through to collectHealth,
// never through options itself.
export function createBoardController(ctx, options, { warnings = [] } = {}) {
  const enabled = options.board?.enabled !== false;
  const refreshMs = Math.max(1, Number(options.board?.refreshSeconds) || DEFAULT_REFRESH_SECONDS) * 1000;
  let timer = null;

  async function refresh() {
    if (!enabled) return null;
    try {
      return await refreshBoardState(ctx, options, { warnings });
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

export async function refreshBoardState(ctx, options, { warnings = [] } = {}) {
  const project = await resolveProject(ctx, options);
  const state = await buildBoardState(ctx, options, project, warnings);
  await writeBoardState(ctx, options, project, state);
  return state;
}

async function buildBoardState(ctx, options, project, warnings = []) {
  const sections = options.board?.sections ?? {};
  const observationsRoot = resolveObservationsRoot(options);
  const evalRoots = resolveEvalRoots(options);
  // Read once, regardless of which sections are enabled: lib/health.js's
  // own diagnostics need the real observer state even when the instincts
  // section itself is toggled off, not a value that only exists as a
  // side effect of that section having been built.
  const observerState = await readObserverState(project.project_dir);
  const [instincts, observations, evals] = await Promise.all([
    sections.instincts !== false ? buildInstinctsSection(project, options, observerState) : null,
    sections.observations !== false ? readTaskObserverSummary(observationsRoot) : null,
    sections.evals !== false ? readEvalsSummary(evalRoots) : null,
  ]);
  const health = await collectHealth({ options, project, observerState, observationsRoot, evalRoots, warnings });

  const state = { updatedAt: new Date().toISOString() };
  if (instincts) state.instincts = instincts;
  if (observations) state.observations = observations;
  if (evals) state.evals = evals;
  if (health.length > 0) state.health = health;
  return state;
}

async function buildInstinctsSection(project, options, observerState) {
  const cfg = options.observer ?? {};
  const injectCfg = options.inject ?? {};
  const pendingDir = siblingInstinctsDir(project, "pending");
  const [personal, inherited, globalPersonal, pending, lineCount, logSummary, activity, maintenance, awaitingFirstUse, candidates, usage, readyToShare] =
    await Promise.all([
      listInstincts(project.instincts_personal),
      listInstincts(project.instincts_inherited),
      listInstincts(path.join(resolveHomunculusDir(options), "instincts", "personal")),
      listInstincts(pendingDir),
      cachedCountObservationLines(project.observations_file),
      readObserverLogSummary(project.project_dir),
      readActivitySnapshot(project.project_dir),
      readMaintenanceSummary(project),
      countInstinctFiles(pendingDir),
      loadCandidates(project.evolved_dir),
      readUsage(project.project_dir),
      countPromoteReadyCached(options),
    ]);

  // Candidate lifecycle: "skill candidates" is only the ones still
  // waiting on a human decision (status proposed); installed and
  // archived candidates get their own rows below instead of folding into
  // the same count. unusedCandidates reuses the exact same window
  // (prune.unusedDays, default 30) lib/maintain.js's pruneCandidatesStep
  // flags or (opt-in) auto-archives with, so the board and the real
  // prune behaviour can never disagree about what counts as unused.
  const candidateCountsByStatus = candidateCounts(candidates);
  const unusedDays = resolveUnusedDays(options);
  const unusedCandidates = findUnusedInstalled(candidates, usage, unusedDays).length;

  // One gate, shared with the observer itself (lib/observer.js's
  // evaluateObserverGate): interval, zero-write damper, failure backoff
  // and the model-unset hold all have to agree before a run is due, and
  // nextEligibleAt is the clock fact behind the interval and backoff
  // timers, shown even while another reason decides the verdict.
  const pendingObservations = pendingSince(observerState, lineCount);
  const gate = evaluateObserverGate({ state: observerState, options, pendingCount: pendingObservations });
  const nextRunReady = gate.ready;
  const nextRunEligibleAt = gate.ready ? null : gate.nextEligibleAt;
  const minObservations = gate.required;

  // Combines every instinct this project can see (its own, inherited, and
  // the shared global bucket) into one pool for the richer facts below;
  // the project/inherited/global counts above stay split, since those are
  // also used on their own (e.g. by lib/board-text.js's "N inherited").
  const combined = [...personal, ...inherited, ...globalPersonal];
  const newest = newestInstinct(combined);
  // `readyToShare` was already computed above, inside the same
  // Promise.all as everything else this function reads: lib/maintain.js's
  // promoteStep is cross-project by design (it scans every project under
  // the homunculus, not just this one), so unlike every other fact here
  // it does not depend on `combined`/`personal`/`inherited` at all.

  // Candidate lifecycle: one 1-based numbering (lib/candidates.js's
  // numberCandidates) shared by the /evolve command itself and the
  // board's own hint rows below, so "/evolve 1" in a hint is always a
  // valid pick. `proposedList` carries every proposed candidate (capped
  // for board-state.json's own size budget); the sidebar.js/board-text.js
  // only ever shows the first few of them.
  const proposedList = numberCandidates(candidates)
    .filter(({ candidate }) => candidate.fields.status === "proposed")
    .slice(0, PROPOSED_LIST_CAP)
    .map(({ index, candidate }) => ({
      index,
      id: candidate.fields.id,
      kind: candidate.fields.kind,
      members: Array.isArray(candidate.fields.members) ? candidate.fields.members : [],
      summary: candidate.fields.summary ?? null,
    }));

  // "habits in prompts": how many instincts qualify for injection right
  // now (confidence >= inject.minConfidence, not excluded, not pending;
  // `combined` already leaves pending instincts out). Reuses
  // lib/inject.js's own selectForInjection (its `cfg.exclude`/malformed-
  // trigger filtering too, exported for exactly this) instead of
  // re-deriving the same eligibility rule here, so the board and the real
  // injection path can never disagree about what counts as eligible. The
  // `max` cap is lifted (HABITS_NO_CAP below): that cap only decides how
  // many of the eligible instincts fit in one request, which is a
  // per-request budget, not part of "eligible" itself.
  const habitsInPrompts =
    injectCfg.enabled === false
      ? 0
      : selectForInjection(combined, { ...DEFAULT_INJECT_OPTIONS, ...injectCfg, max: HABITS_NO_CAP }).length;

  // Top habits actually used (fired) today, for the /board chat summary
  // (lib/board-format.js): activity.firedByIdToday (lib/activity.js) is
  // keyed by id only, so each id is looked up against every instinct this
  // project can see, including pending ones (a pending instinct can fire
  // without ever being injected, see lib/inject.js's bumpPendingFired).
  const byId = new Map([...combined, ...pending].map((inst) => [inst.id, inst]));
  const firedTodayTop = Object.entries(activity.firedByIdToday ?? {})
    .map(([id, count]) => ({ id, count: Number(count) || 0, inst: byId.get(id) }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
    .slice(0, FIRED_TODAY_TOP_CAP)
    .map((entry) => ({
      id: entry.id,
      count: entry.count,
      summary: clipSummaryWordBoundary(entry.inst?.summary || entry.inst?.trigger || entry.id, FIRED_TODAY_SUMMARY_CLIP_CHARS),
    }));

  return {
    project: personal.length,
    inherited: inherited.length,
    global: globalPersonal.length,
    lastRun: observerState.lastRunAt,
    pendingObservations,
    minObservations,
    nextRunEligibleAt,
    nextRunReady,
    observerEnabled: cfg.enabled === true,
    model: cfg.model ?? null,
    readyToShare,
    habitsInPrompts,
    domains: tallyDomains(combined),
    newestId: newest?.id ?? null,
    newestAt: newest ? new Date(newest.mtimeMs).toISOString() : null,
    runs: logSummary.runs,
    written: logSummary.written,
    rejected: logSummary.rejected,
    lastWriteAt: logSummary.lastWriteAt,
    lastObservedAt: activity.lastObservedAt,
    appliedToday: activity.appliedToday,
    firedToday: activity.firedToday,
    firedThisWeek: activity.firedThisWeek,
    firedTodayTop,
    awaitingFirstUse,
    skillCandidates: candidateCountsByStatus.proposed,
    installedFromHabits: candidateCountsByStatus.installed,
    unusedCandidates,
    candidatesPath: project.evolved_dir,
    proposedList,
    maintenance,
    // Cleared the moment observer.model is set again: observerState.blocked
    // only reflects whichever config was live the last time the observer
    // itself attempted a run, and would otherwise keep reporting
    // model-unset until the next successful run clears the state file.
    blocked: observerState.blocked === "model-unset" && !parseModelRef(cfg.model) ? "model-unset" : null,
    failures: observerState.failures,
    nextAttemptAfter: observerState.nextAttemptAfter,
    list: buildInstinctsList(combined),
  };
}

async function countInstinctFiles(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && /\.(md|ya?ml)$/i.test(entry.name)).length;
  } catch {
    return 0;
  }
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

// Per-instinct data kept in board-state.json for the sidebar's full
// instinct list: every instinct this project can see, sorted by
// confidence first, capped and trigger-clipped to keep board-state.json
// small. Not currently rendered by sidebar.js itself (its detail panel
// was removed), but kept here since other readers of board-state.json
// (and a future UI) still benefit from the richer per-instinct data.
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
      fired: Number(inst.fired) || 0,
    }));
}

function clipTrigger(value) {
  if (typeof value !== "string") return null;
  return value.length > INSTINCT_TRIGGER_CLIP_CHARS ? value.slice(0, INSTINCT_TRIGGER_CLIP_CHARS) : value;
}

// One small read of observer.log, summed across every "run:" line it can
// match (lib/observer.js writes one per run, plus an unmatched "run
// skipped: no observations" line when there was nothing to analyse, which
// this intentionally excludes from the run count). Also tracks the
// timestamp of the most recent run that actually wrote an instinct
// (`lastWriteAt`), so the sidebar can briefly color the Instincts title
// to mark a fresh write (sidebar.js) without this plugin needing a
// separate on-disk field just for that one timestamp.
async function readObserverLogSummary(projectDir) {
  let content;
  try {
    content = await fs.readFile(path.join(projectDir, "observer.log"), "utf8");
  } catch {
    return { runs: 0, written: 0, rejected: 0, lastWriteAt: null };
  }
  let runs = 0;
  let written = 0;
  let rejected = 0;
  let lastWriteAt = null;
  for (const line of content.split("\n")) {
    const match = RUN_LINE.exec(line);
    if (!match) continue;
    runs += 1;
    const lineWritten = Number(match[1]) || 0;
    written += lineWritten;
    rejected += Number(match[2]) || 0;
    if (lineWritten > 0) {
      const timestamp = line.slice(0, line.indexOf(" "));
      if (!Number.isNaN(Date.parse(timestamp))) lastWriteAt = timestamp;
    }
  }
  return { runs, written, rejected, lastWriteAt };
}

// Exported for lib/review.js's resolveReviewRoot, which needs the same
// board.observationsRoot resolution for its own scheduled review root.
export function resolveObservationsRoot(options) {
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
