// "Doctor" diagnostics for the board: cheap, read-only checks that
// explain *why* something else on the board looks wrong (an amber
// Learned habits glyph forever, a Skill test that never updates, an
// option lib/plugin.js's own merge silently carried through unvalidated)
// instead of leaving the user to guess. Collected once per board refresh
// (lib/board.js's buildBoardState) and rendered as its own "Health"
// block only when it has entries (lib/board-text.js's buildHealthBlock,
// sidebar.js, lib/board-format.js): a project with nothing misconfigured
// never shows this block at all.
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { parseModelRef } from "./observer.js";

const PYTHON_PROBE_TIMEOUT_MS = 3000;
// A successful probe is cached for the rest of the process (python
// becoming available essentially never happens mid-session); a failed
// one is retried after this long instead, since that failure can be a
// transient PATH/environment issue fixed without a restart.
const PYTHON_PROBE_FAILURE_RETRY_MS = 5 * 60000;

function probePythonUncached(pythonBin) {
  return new Promise((resolve) => {
    execFile(pythonBin, ["--version"], { timeout: PYTHON_PROBE_TIMEOUT_MS }, (error) => resolve(!error));
  });
}

// Cached per python binary string. The default `pythonProbe` collectHealth
// uses; also the thing a caller (or a test) can substitute with a fake
// that never spawns a real subprocess.
const pythonProbeCache = new Map(); // python binary -> { promise, expiresAt }

export function probePython(pythonBin) {
  const key = typeof pythonBin === "string" && pythonBin.length > 0 ? pythonBin : "python3";
  const cached = pythonProbeCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.promise;

  const promise = probePythonUncached(key);
  pythonProbeCache.set(key, { promise, expiresAt: Number.POSITIVE_INFINITY });
  void promise.then((ok) => {
    if (!ok) pythonProbeCache.set(key, { promise, expiresAt: Date.now() + PYTHON_PROBE_FAILURE_RETRY_MS });
  });
  return promise;
}

// Test-only: clears the per-process python probe cache, so a test
// exercising two different "is python runnable" outcomes (a real
// interpreter, then a bogus path) never reads a stale cached result for
// either key.
export function _resetPythonProbeCache() {
  pythonProbeCache.clear();
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function isWritable(dir) {
  try {
    await fs.access(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Read-only and best-effort: every individual check below (pathExists,
// isWritable, the python probe) already swallows its own errors and
// resolves to a plain boolean, so a health check here can never throw
// and take the board refresh (lib/board.js's refreshBoardState) down
// with it.
export async function collectHealth({
  options = {},
  project = null,
  observerState = null,
  observationsRoot = null,
  evalRoots = [],
  pythonProbe = probePython,
} = {}) {
  const health = [];

  const pythonBin = options.python ?? "python3";
  if (!(await pythonProbe(pythonBin))) {
    health.push({
      key: "python",
      level: "attention",
      message: "python not found: habits are saved to the shared global bucket; set the python option",
    });
  }

  if (project?.project_dir && !(await isWritable(project.project_dir))) {
    health.push({ key: "data-dir", level: "attention", message: `data dir not writable: ${project.project_dir}` });
  }

  // Only flagged once the user has actually pointed board.observationsRoot
  // somewhere: the unconfigured default (DEFAULT_OBSERVATIONS_ROOT) simply
  // not existing yet (the task-observer skill never installed) is not a
  // misconfiguration worth surfacing.
  const configuredObservationsRoot = options.board?.observationsRoot;
  if (typeof configuredObservationsRoot === "string" && configuredObservationsRoot.length > 0 && !(await pathExists(observationsRoot))) {
    health.push({ key: "observations-root", level: "attention", message: `observationsRoot configured but missing: ${observationsRoot}` });
  }

  // Derived fresh from the current options every call (parseModelRef is
  // the same "provider/model" validator lib/observer.js's own run gate
  // uses, so a syntactically present but malformed value is caught too):
  // never latched from observerState.blocked, which only reflects
  // whichever config was live the last time the observer actually
  // attempted (or skipped) a run, and would otherwise keep warning after
  // observer.model is fixed but before the observer has run again.
  const observerEnabled = options.observer?.enabled === true;
  const modelConfigured = parseModelRef(options.observer?.model) !== null;
  if (observerEnabled && !modelConfigured) {
    health.push({ key: "observer-model", level: "attention", message: "observer enabled with no model: set observer.model" });
  }

  // Informational, not urgent: no skill-creator benchmark at all under
  // every configured root just means the Skill test block has nothing to
  // show yet, not that something is broken.
  if (Array.isArray(evalRoots) && evalRoots.length > 0) {
    const existsResults = await Promise.all(evalRoots.map((root) => pathExists(root)));
    if (!existsResults.some(Boolean)) {
      health.push({
        key: "eval-roots",
        level: "info",
        message: `eval roots missing: no skill-creator benchmark found under ${evalRoots.join(", ")}`,
      });
    }
  }

  // lib/plugin.js's own option merge may stash validation complaints here
  // (an unknown key, a value of the wrong shape); passed through verbatim
  // rather than re-worded, since that module already wrote the message
  // for the exact problem it found.
  if (Array.isArray(options._warnings)) {
    options._warnings.forEach((warning, index) => {
      if (typeof warning === "string" && warning.length > 0) {
        health.push({ key: `warning-${index}`, level: "attention", message: warning });
      }
    });
  }

  return health;
}
