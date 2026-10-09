// Tool and prompt observation hooks. Every callback is wrapped in try/catch:
// a plugin hook that throws takes the host turn down with it, and an
// observation side-channel is never worth that.
import { resolveProject } from "./project.js";
import { appendObservation } from "./store.js";
import { clip, scrub } from "./scrub.js";

const DEFAULT_IGNORE_TOOLS = ["todowrite", "todoread", "question", "instincts"];
const INPUT_CLIP_CHARS = 5000;
const PROMPT_CLIP_CHARS = 2000;

export async function registerObserve(ctx, options, observer) {
  const ignoreTools = new Set((options.ignoreTools ?? DEFAULT_IGNORE_TOOLS).map((name) => String(name).toLowerCase()));
  const ignoreAgents = new Set((options.ignoreAgents ?? []).map((name) => String(name).toLowerCase()));
  const observePrompts = options.observePrompts !== false;

  const registrations = [];

  registrations.push(
    await ctx.tool.hook("execute.before", async (event) => {
      try {
        if (shouldIgnore(event, ignoreTools, ignoreAgents)) return;
        const project = await resolveProject(ctx, options);
        await appendObservation(project, {
          event: "tool_start",
          tool: event.tool,
          session: event.sessionID,
          agent: event.agent,
          project_id: project.id,
          project_name: project.name,
          input: clip(safeStringify(event.input), INPUT_CLIP_CHARS),
        });
        void observer.maybeRun(event.sessionID);
      } catch (error) {
        console.warn("[opencode-instincts] execute.before observation failed", error);
      }
    }),
  );

  registrations.push(
    await ctx.tool.hook("execute.after", async (event) => {
      try {
        if (shouldIgnore(event, ignoreTools, ignoreAgents)) return;
        const project = await resolveProject(ctx, options);
        await appendObservation(project, {
          event: "tool_complete",
          tool: event.tool,
          session: event.sessionID,
          agent: event.agent,
          project_id: project.id,
          project_name: project.name,
          output: clip(describeOutput(event), INPUT_CLIP_CHARS),
        });
        void observer.maybeRun(event.sessionID);
      } catch (error) {
        console.warn("[opencode-instincts] execute.after observation failed", error);
      }
    }),
  );

  if (observePrompts) {
    registrations.push(
      await ctx.session.hook("prompt", async (event) => {
        try {
          const text = event.prompt?.text;
          if (typeof text !== "string" || text.length === 0) return;
          const project = await resolveProject(ctx, options);
          await appendObservation(project, {
            event: "user_prompt",
            session: event.sessionID,
            project_id: project.id,
            project_name: project.name,
            text: clip(scrub(text), PROMPT_CLIP_CHARS),
          });
          void observer.maybeRun(event.sessionID);
        } catch (error) {
          console.warn("[opencode-instincts] prompt observation failed", error);
        }
      }),
    );
  }

  return registrations;
}

function shouldIgnore(event, ignoreTools, ignoreAgents) {
  const tool = String(event.tool ?? "").toLowerCase();
  const agent = String(event.agent ?? "").toLowerCase();
  if (tool && ignoreTools.has(tool)) return true;
  if (agent && ignoreAgents.has(agent)) return true;
  return false;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function describeOutput(event) {
  if (event.status === "error") {
    const message = event.error?.message ?? String(event.error ?? "unknown error");
    return `[error] ${message}`;
  }
  const result = event.result;
  if (typeof result?.content === "string") return result.content;
  if (Array.isArray(result?.content)) {
    const text = result.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    if (text) return text;
  }
  if (typeof result?.output === "string") return result.output;
  return safeStringify(result ?? "");
}
