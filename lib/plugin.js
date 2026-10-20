// Real plugin implementation. Kept out of index.js so smoke-test.mjs can
// import it directly without resolving the host-provided @opencode/plugin
// package (see index.js).
import { registerObserve } from "./observe.js";
import { createObserver } from "./observer.js";
import { registerCommands } from "./commands.js";
import { registerTool } from "./tool.js";
import { registerInject, DEFAULT_INJECT_OPTIONS } from "./inject.js";
import { resolveProject } from "./project.js";
import { createBoardController } from "./board.js";
import { PKG_NAME } from "./pkg.js";

const DEFAULT_OPTIONS = {
  disabled: false,
  dataDir: undefined,
  python: "python3",
  observePrompts: true,
  ignoreTools: ["todowrite", "todoread", "question", "instincts"],
  ignoreAgents: [],
  observer: {
    enabled: false,
    model: undefined,
    runIntervalMinutes: 5,
    minObservations: 20,
    maxAnalysisLines: 300,
    notify: true,
  },
  inject: DEFAULT_INJECT_OPTIONS,
  board: {
    enabled: true,
    sections: { instincts: true, observations: true, evals: true },
    refreshSeconds: 30,
    observationsRoot: null,
    evalRoots: null,
    compact: false,
  },
};

export async function setup(ctx) {
  const options = mergeOptions(ctx.options);
  if (options.disabled) return undefined;

  // Fire-and-forget: warms project.js's cache (and, if this is the first
  // call for this directory, kicks off the one python subprocess that any
  // concurrent early hook/command calls into resolveProject will share)
  // instead of leaving the first real caller to pay for it cold.
  void resolveProject(ctx, options);

  const board = createBoardController(ctx, options);
  const observer = createObserver(ctx, options, { afterRun: board.refresh });
  const registrations = [];

  await safeRegister(registrations, () => registerObserve(ctx, options, observer), "observation hooks");
  await safeRegister(registrations, () => registerInject(ctx, options), "prompt injection");
  await safeRegister(registrations, () => registerCommands(ctx, options, observer, board), "slash commands");
  await safeRegister(registrations, async () => [await registerTool(ctx, options)], "instincts tool");

  board.start();

  return async () => {
    board.stop();
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
    ignoreTools: source.ignoreTools ?? DEFAULT_OPTIONS.ignoreTools,
    ignoreAgents: source.ignoreAgents ?? DEFAULT_OPTIONS.ignoreAgents,
  };
}
