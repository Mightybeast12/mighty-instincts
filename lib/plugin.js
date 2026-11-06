// Real plugin implementation. Kept out of index.js so smoke-test.mjs can
// import it directly without resolving the host-provided @opencode/plugin
// package (see index.js).
import { registerObserve } from "./observe.js";
import { OBSERVER_DEFAULTS, createObserver } from "./observer.js";
import { registerCommands } from "./commands.js";
import { registerTool } from "./tool.js";
import { registerInject, DEFAULT_INJECT_OPTIONS } from "./inject.js";
import { resolveProject } from "./project.js";
import { createBoardController } from "./board.js";
import { createMaintenanceController, MAINTENANCE_DEFAULTS } from "./maintain.js";
import { createReviewController, REVIEW_DEFAULTS } from "./review.js";
import { PKG_NAME } from "./pkg.js";

export const DEFAULT_OPTIONS = {
  disabled: false,
  dataDir: undefined,
  python: "python3",
  observePrompts: true,
  ignoreTools: ["todowrite", "todoread", "question", "instincts"],
  ignoreAgents: [],
  observer: OBSERVER_DEFAULTS,
  inject: DEFAULT_INJECT_OPTIONS,
  board: {
    enabled: true,
    sections: { instincts: true, observations: true, evals: true },
    refreshSeconds: 30,
    observationsRoot: null,
    evalRoots: null,
    compact: false,
  },
  maintenance: MAINTENANCE_DEFAULTS,
  // Off by default, like every other automatic action this plugin can
  // take: scheduled runs are opt-in, but /skill-review (lib/commands.js)
  // can still trigger one on demand regardless of this flag.
  review: REVIEW_DEFAULTS,
  // Overrides for the four places /evolve-install writes a candidate's
  // drafted artefact to (skill/command/agent: an absolute directory;
  // rule: an absolute file, in place of the project's own AGENTS.md).
  // Unset (null) means "use the real ~/.config/opencode/... location"
  // (lib/candidates.js's resolveEvolveTargets).
  evolve: {
    targets: { skill: null, command: null, agent: null, rule: null },
  },
  // Report-only unused-installed-candidate detection (lib/maintain.js's
  // pruneCandidatesStep); `auto` opts into actually archiving and
  // removing them, which stays off by default like every other
  // automatic write/delete this plugin can do.
  prune: {
    unusedDays: 30,
    auto: false,
  },
};

export async function setup(ctx) {
  const warnings = validateOptions(ctx.options);
  for (const warning of warnings) console.warn(`[${PKG_NAME}] ${warning}`);

  const options = mergeOptions(ctx.options);
  if (options.disabled) return undefined;

  // Fire-and-forget: warms project.js's cache (and, if this is the first
  // call for this directory, kicks off the one python subprocess that any
  // concurrent early hook/command calls into resolveProject will share)
  // instead of leaving the first real caller to pay for it cold.
  void resolveProject(ctx, options);

  const board = createBoardController(ctx, options, { warnings });
  const review = createReviewController(ctx, options, { afterRun: board.refresh });
  // The maintenance controller needs a resolved `project`, which is async;
  // built lazily (and cached) on first use rather than blocking setup() on
  // it, since setup() itself must return quickly.
  let maintenancePromise = null;
  function ensureMaintenance() {
    if (!maintenancePromise) {
      maintenancePromise = resolveProject(ctx, options).then((project) =>
        createMaintenanceController(options, project, { afterRun: board.refresh }),
      );
    }
    return maintenancePromise;
  }

  const observer = createObserver(ctx, options, {
    // Runs after every observer run (board.refresh, then the maintenance
    // sweep, unconditionally: "runs after each observer run" is separate
    // from maintenance's own "at least every intervalHours" timer below).
    afterRun: async () => {
      await board.refresh();
      const maintenance = await ensureMaintenance();
      await maintenance.runAfterObserver();
    },
  });
  const registrations = [];

  await safeRegister(registrations, () => registerObserve(ctx, options, observer), "observation hooks");
  await safeRegister(registrations, () => registerInject(ctx, options), "prompt injection");
  await safeRegister(registrations, () => registerCommands(ctx, options, observer, board, review), "slash commands");
  await safeRegister(registrations, async () => [await registerTool(ctx, options)], "instincts tool");

  board.start();
  review.start();
  void ensureMaintenance().then((maintenance) => maintenance.start());

  return async () => {
    board.stop();
    review.stop();
    if (maintenancePromise) (await maintenancePromise).stop();
    await Promise.allSettled(registrations.filter(Boolean).map((registration) => registration?.dispose?.()));
  };
}

async function safeRegister(target, factory, label) {
  try {
    const added = await factory();
    if (Array.isArray(added)) target.push(...added.filter(Boolean));
  } catch (error) {
    console.warn(`[${PKG_NAME}] failed to register ${label}`, error);
  }
}

function mergeOptions(userOptions) {
  const source = userOptions ?? {};
  return {
    ...DEFAULT_OPTIONS,
    ...source,
    observer: { ...DEFAULT_OPTIONS.observer, ...(source.observer ?? {}) },
    inject: {
      ...DEFAULT_OPTIONS.inject,
      ...(source.inject ?? {}),
      exclude: Array.isArray(source.inject?.exclude) ? source.inject.exclude : DEFAULT_OPTIONS.inject.exclude,
    },
    board: {
      ...DEFAULT_OPTIONS.board,
      ...(source.board ?? {}),
      sections: { ...DEFAULT_OPTIONS.board.sections, ...(source.board?.sections ?? {}) },
    },
    maintenance: { ...DEFAULT_OPTIONS.maintenance, ...(source.maintenance ?? {}) },
    review: {
      ...DEFAULT_OPTIONS.review,
      ...(source.review ?? {}),
      externalDirectories: Array.isArray(source.review?.externalDirectories)
        ? source.review.externalDirectories
        : DEFAULT_OPTIONS.review.externalDirectories,
    },
    evolve: {
      ...DEFAULT_OPTIONS.evolve,
      ...(source.evolve ?? {}),
      targets: { ...DEFAULT_OPTIONS.evolve.targets, ...(source.evolve?.targets ?? {}) },
    },
    prune: { ...DEFAULT_OPTIONS.prune, ...(source.prune ?? {}) },
    ignoreTools: source.ignoreTools ?? DEFAULT_OPTIONS.ignoreTools,
    ignoreAgents: source.ignoreAgents ?? DEFAULT_OPTIONS.ignoreAgents,
  };
}

// Warns about every option key mergeOptions would otherwise silently
// ignore (an unknown key, most often a typo) or silently fall back from
// (a known key given the wrong type, e.g. a string where a number is
// expected): mergeOptions's own `...DEFAULT_OPTIONS, ...source` spreads
// never reject anything, so a typo like `observer.enable` previously did
// nothing with no signal at all. Walks every group/key DEFAULT_OPTIONS
// itself defines (which already nests REVIEW_DEFAULTS, MAINTENANCE_DEFAULTS,
// DEFAULT_INJECT_OPTIONS, and evolve.targets/prune), so this never needs
// its own separate copy of that shape to stay in sync with. Returns a
// plain array of warning strings; never alters `raw` or the values
// mergeOptions produces.
export function validateOptions(raw) {
  const warnings = [];
  collectOptionWarnings("", raw ?? {}, DEFAULT_OPTIONS, warnings);
  return warnings;
}

function collectOptionWarnings(prefix, rawGroup, schema, warnings) {
  if (!isPlainObject(rawGroup)) return;
  const knownKeys = Object.keys(schema);
  for (const [key, rawValue] of Object.entries(rawGroup)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in schema)) {
      const suggestion = closestKey(key, knownKeys);
      const fullSuggestion = suggestion ? (prefix ? `${prefix}.${suggestion}` : suggestion) : null;
      warnings.push(fullSuggestion ? `unknown option ${path} (did you mean ${fullSuggestion}?)` : `unknown option ${path}`);
      continue;
    }

    const defaultValue = schema[key];
    if (isPlainObject(defaultValue)) {
      if (rawValue === undefined) continue;
      if (!isPlainObject(rawValue)) {
        warnings.push(`${path} should be ${withArticle("object")}, got ${describeType(rawValue)}`);
        continue;
      }
      collectOptionWarnings(path, rawValue, defaultValue, warnings);
      continue;
    }

    const expected = expectedTypeFor(defaultValue);
    if (expected === null || rawValue === undefined || rawValue === null) continue;
    const actual = describeType(rawValue);
    if (actual !== expected) warnings.push(`${path} should be ${withArticle(expected)}, got ${actual}`);
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// null/undefined defaults (observer.model, review.model/agent,
// evolve.targets.*) give no type to check against, so those keys are
// only ever checked for being unknown, never for their value's type.
function expectedTypeFor(defaultValue) {
  if (defaultValue === null || defaultValue === undefined) return null;
  return describeType(defaultValue);
}

function withArticle(type) {
  return type === "array" || type === "object" ? `an ${type}` : `a ${type}`;
}

// Simple edit-distance match against the schema's own keys at this
// level, so a typo like `observer.enable` suggests `observer.enabled`
// (distance 1) instead of just being reported as unknown. Distances
// over 2 are treated as "no reasonable guess" rather than suggesting an
// unrelated key; ties fall back to alphabetical order for determinism.
function closestKey(key, knownKeys) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of knownKeys) {
    const distance = levenshtein(key, candidate);
    if (distance < bestDistance || (distance === bestDistance && (best === null || candidate < best))) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= 2 ? best : null;
}

function levenshtein(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, (_, i) => [i, ...Array(cols - 1).fill(0)]);
  for (let j = 0; j < cols; j++) dp[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[rows - 1][cols - 1];
}
