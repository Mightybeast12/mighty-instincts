// Real plugin implementation. Kept out of index.js so smoke-test.mjs can
// import it directly without resolving the host-provided @opencode/plugin
// package (see index.js).
import { registerObserve } from "./observe.js";
import { createObserver } from "./observer.js";
import { registerCommands } from "./commands.js";
import { registerTool } from "./tool.js";

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
};

export async function setup(ctx) {
  const options = mergeOptions(ctx.options);
  if (options.disabled) return undefined;

  const observer = createObserver(ctx, options);
  const registrations = [];

  await safeRegister(registrations, () => registerObserve(ctx, options, observer), "observation hooks");
  await safeRegister(registrations, () => registerCommands(ctx, options, observer), "slash commands");
  await safeRegister(registrations, async () => [await registerTool(ctx, options)], "instincts tool");

  return async () => {
    await Promise.allSettled(registrations.filter(Boolean).map((registration) => registration?.dispose?.()));
  };
}

async function safeRegister(target, factory, label) {
  try {
    const added = await factory();
    if (Array.isArray(added)) target.push(...added.filter(Boolean));
  } catch (error) {
    console.warn(`[opencode-instincts] failed to register ${label}`, error);
  }
}

function mergeOptions(userOptions) {
  const source = userOptions ?? {};
  return {
    ...DEFAULT_OPTIONS,
    ...source,
    observer: { ...DEFAULT_OPTIONS.observer, ...(source.observer ?? {}) },
    ignoreTools: source.ignoreTools ?? DEFAULT_OPTIONS.ignoreTools,
    ignoreAgents: source.ignoreAgents ?? DEFAULT_OPTIONS.ignoreAgents,
  };
}
