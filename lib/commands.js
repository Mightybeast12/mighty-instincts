// Slash commands. Each one runs instinct-cli.py directly (through
// lib/cli.js) and posts the result as a synthetic message; none of them
// start a model turn, so there is nothing here that calls ctx.session.prompt.
import { resolveProject } from "./project.js";
import { runCli } from "./cli.js";

const CLI_COMMANDS = [
  { name: "instinct-status", description: "Show ECC instinct status (project-scoped + global).", action: "status", force: false },
  { name: "instinct-import", description: "Import instincts from a local file or an https URL.", action: "import", force: true },
  { name: "instinct-export", description: "Export instincts to stdout or a file.", action: "export", force: false },
  { name: "evolve", description: "Analyze instincts for skill/command/agent clusters; add --generate to write them.", action: "evolve", force: false },
  { name: "promote", description: "Promote project-scoped instincts that qualify to global scope.", action: "promote", force: true },
  { name: "instinct-projects", description: "List known projects and their instinct counts.", action: "projects", force: false },
  { name: "instinct-prune", description: "Delete pending instincts older than the TTL.", action: "prune", force: false },
];

export async function registerCommands(ctx, options, observer) {
  const registration = await ctx.command.transform((editor) => {
    for (const spec of CLI_COMMANDS) {
      editor.add(buildCliCommand(ctx, options, spec));
    }
    editor.add(buildObserveCommand(ctx, observer));
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
    const project = await resolveProject(ctx, options);
    return await runCli(project, options, spec.action, argvText, { force: spec.force, directory: ctx.location.directory });
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

async function postResult(ctx, sessionID, text) {
  try {
    await ctx.session.synthetic({
      sessionID,
      text: `\`\`\`\n${text}\n\`\`\``,
      description: "opencode-instincts",
      delivery: "queue",
      resume: false,
    });
  } catch (error) {
    console.warn("[opencode-instincts] failed to post command result", error);
  }
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
