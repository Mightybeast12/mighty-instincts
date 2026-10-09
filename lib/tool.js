// The `instincts` tool: a model-callable, read-only slice of instinct-cli.py
// (status/projects/export/evolve-preview/promote-dry-run/prune-dry-run).
// It never writes, imports, deletes, or passes --force.
import { runCli, tokenizeArgv } from "./cli.js";
import { describeError } from "./util.js";

const READ_ONLY_ACTIONS = ["status", "projects", "export", "evolve", "promote", "prune"];

export async function registerTool(ctx, options) {
  return ctx.tool.transform((editor) => editor.add(buildToolDefinition(ctx, options)));
}

function buildToolDefinition(ctx, options) {
  return {
    id: "instincts",
    name: "instincts",
    description:
      "Read-only inspection of ECC instincts for this project: status, projects, export (stdout only), " +
      "evolve preview (no --generate), promote --dry-run, prune --dry-run. Never writes, imports, deletes, or passes --force.",
    input: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: READ_ONLY_ACTIONS,
          description: "Which read-only instinct-cli.py command to run.",
        },
        args: {
          type: "string",
          description:
            "Optional extra flags, space separated (double-quote values containing spaces). " +
            "--force, --generate and --output are rejected.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(input) {
      // The host expects a Tool.Result; a bare string makes it throw
      // ('"output" in o' on a non-object) and the call fails.
      try {
        return { content: String(await runReadOnly(ctx, options, input)) };
      } catch (error) {
        return { content: `instincts tool failed: ${describeError(error)}` };
      }
    },
  };
}

async function runReadOnly(ctx, options, input) {
  const action = input?.action;
  if (!READ_ONLY_ACTIONS.includes(action)) {
    return `Action not permitted for the instincts tool: ${action}`;
  }

  const tokens = tokenizeArgv(input?.args ?? "");
  if (tokens.includes("--force")) return "The instincts tool never passes --force.";
  if (action === "evolve" && tokens.includes("--generate")) {
    return "The instincts tool cannot generate evolved structures (--generate is not permitted).";
  }
  if (action === "export" && tokens.includes("--output")) {
    return "The instincts tool exports to stdout only (no --output).";
  }
  if ((action === "promote" || action === "prune") && !tokens.includes("--dry-run")) {
    tokens.push("--dry-run");
  }

  return runCli(options, action, tokens, { force: false, directory: ctx.location.directory });
}
