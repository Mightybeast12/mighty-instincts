// Slash commands. Most run instinct-cli.py directly (through lib/cli.js)
// and post the result as a synthetic message; the two exceptions are
// /board (lib/board-format.js, reads board-state.json instead) and
// /evolve without --generate (lib/evolve-preview.js, a deterministic JS
// preview; --generate still delegates to instinct-cli.py). None of them
// start a model turn, so there is nothing here that calls
// ctx.session.prompt.
import { runCli, tokenizeArgv } from "./cli.js";
import { formatBoardSummary } from "./board-format.js";
import { buildEvolveClusters, DEFAULT_PREVIEW_LIMIT, formatEvolvePreview } from "./evolve-preview.js";
import { resolveProject } from "./project.js";
import { PKG_NAME } from "./pkg.js";
import { describeError } from "./util.js";

const CLI_COMMANDS = [
  { name: "instinct-status", description: "Show ECC instinct status (project-scoped + global).", action: "status", force: false },
  { name: "instinct-import", description: "Import instincts from a local file or an https URL.", action: "import", force: true },
  { name: "instinct-export", description: "Export instincts to stdout or a file.", action: "export", force: false },
  { name: "promote", description: "Promote project-scoped instincts that qualify to global scope.", action: "promote", force: true },
  { name: "instinct-projects", description: "List known projects and their instinct counts.", action: "projects", force: false },
  { name: "instinct-prune", description: "Delete pending instincts older than the TTL.", action: "prune", force: false },
];

export async function registerCommands(ctx, options, observer, board) {
  const registration = await ctx.command.transform((editor) => {
    for (const spec of CLI_COMMANDS) {
      editor.add(buildCliCommand(ctx, options, spec));
    }
    editor.add(buildObserveCommand(ctx, observer));
    editor.add(buildBoardCommand(ctx, options, board));
    editor.add(buildEvolveCommand(ctx, options));
  });
  return [registration];
}

function buildCliCommand(ctx, options, spec) {
  return {
    name: spec.name,
    description: spec.description,
    async execute({ sessionID, prompt }) {
      const text = await runCliForCommand(ctx, options, spec, prompt?.text ?? "");
      await postResult(ctx, sessionID, text);
    },
  };
}

async function runCliForCommand(ctx, options, spec, argvText) {
  try {
    return await runCli(options, spec.action, argvText, { force: spec.force, directory: ctx.location.directory });
  } catch (error) {
    return describeError(error);
  }
}

function buildObserveCommand(ctx, observer) {
  return {
    name: "instinct-observe",
    description: "Run the instinct observer now, ignoring the configured thresholds.",
    async execute({ sessionID }) {
      try {
        // run() posts its own synthetic summary when notify is forced on,
        // so success here needs no further action; failure never reaches
        // that notify step, hence the catch posting the error itself.
        await observer.run(sessionID, { notify: true });
      } catch (error) {
        await postResult(ctx, sessionID, describeError(error));
      }
    },
  };
}

// Board state is unrelated to instinct-cli.py: it summarises instincts,
// observations, and evals in one place. Posting it as a /board synthetic
// reply is for hosts without the sidebar panel (tui.js / sidebar.js).
function buildBoardCommand(ctx, options, board) {
  return {
    name: "board",
    description: "Show the instinct board summary as plain text.",
    async execute({ sessionID }) {
      const state = await board.refresh();
      const text = formatBoardSummary(state, options);
      await postResult(ctx, sessionID, text);
    },
  };
}

// /evolve without --generate never touches instinct-cli.py: it previews
// lib/evolve-preview.js's own deterministic clusters instead (top
// clusters, member ids, average confidence, a "why", a suggested form),
// which that vendored CLI has no reason to compute for itself. With
// --generate, unchanged: delegates straight through to
// vendor/ecc/instinct-cli.py's own (more involved, skill/command/agent
// triaging) evolve implementation, same as every other CLI_COMMANDS entry.
function buildEvolveCommand(ctx, options) {
  const spec = { action: "evolve", force: false };
  return {
    name: "evolve",
    description: "Preview deterministic instinct clusters; add --generate to write skill/command/agent candidates.",
    async execute({ sessionID, prompt }) {
      const argvText = prompt?.text ?? "";
      const text = tokenizeArgv(argvText).includes("--generate")
        ? await runCliForCommand(ctx, options, spec, argvText)
        : await buildEvolvePreviewText(ctx, options, argvText);
      await postResult(ctx, sessionID, text);
    },
  };
}

async function buildEvolvePreviewText(ctx, options, argvText) {
  try {
    const project = await resolveProject(ctx, options);
    const clusters = await buildEvolveClusters(project);
    return formatEvolvePreview(clusters, { limit: parsePreviewLimit(tokenizeArgv(argvText)) });
  } catch (error) {
    return describeError(error);
  }
}

// Mirrors `--limit N`'s existing meaning for the real (--generate) path:
// 0 means no cap, a positive N caps the preview at N clusters, and no
// flag at all defaults to DEFAULT_PREVIEW_LIMIT (3, lib/evolve-preview.js)
// rather than showing every cluster unprompted.
function parsePreviewLimit(tokens) {
  const idx = tokens.indexOf("--limit");
  if (idx === -1 || idx + 1 >= tokens.length) return DEFAULT_PREVIEW_LIMIT;
  const parsed = Number.parseInt(tokens[idx + 1], 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_PREVIEW_LIMIT;
}

// `resume: true`: a slash command is a direct user action, typed on its
// own turn, and the user is waiting right there for the reply, so it
// should surface immediately rather than sit queued until the next turn.
// lib/observer.js's own synthetic posting (a background run's summary,
// which nobody necessarily typed anything to trigger) keeps `resume: false`
// instead: forcing a resume there would interrupt whatever the session is
// doing on its own schedule, for a message nobody is sitting on.
async function postResult(ctx, sessionID, text) {
  try {
    await ctx.session.synthetic({
      sessionID,
      text: `\`\`\`\n${text}\n\`\`\``,
      description: PKG_NAME,
      delivery: "queue",
      resume: true,
    });
  } catch (error) {
    console.warn(`[${PKG_NAME}] failed to post command result`, error);
  }
}
