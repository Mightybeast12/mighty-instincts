// Tool and prompt observation hooks. Every callback is wrapped in try/catch:
// a plugin hook that throws takes the host turn down with it, and an
// observation side-channel is never worth that.
import { resolveProject } from "./project.js";
import { appendObservation } from "./store.js";
import { recordObserved } from "./activity.js";
import { PKG_NAME } from "./pkg.js";
import { clip } from "./scrub.js";

const INPUT_CLIP_CHARS = 5000;
const PROMPT_CLIP_CHARS = 2000;
// Matches lib/inject.js's own injected block exactly (open tag, lines,
// close tag), plus the blank line(s) this plugin's injection adds before
// it, so a stripped prompt reads the same as it did before injection.
const INJECTED_BLOCK_PATTERN = /\n{0,2}<instincts>[\s\S]*?<\/instincts>\n*/g;

// Removes this plugin's own injected `<instincts>...</instincts>` block
// (lib/inject.js) from a prompt before it is logged or analysed: the
// observer must learn from what the user actually typed, not from
// instincts the plugin itself appended a moment earlier.
export function stripInjectedBlock(text) {
  return text.replace(INJECTED_BLOCK_PATTERN, "").trimEnd();
}

export async function registerObserve(ctx, options, observer) {
  // mergeOptions (lib/plugin.js) always fills ignoreTools/ignoreAgents
  // before options reaches here, so there is nothing to fall back to; the
  // single default list lives in lib/plugin.js's DEFAULT_OPTIONS.
  const ignoreTools = new Set(options.ignoreTools.map((name) => String(name).toLowerCase()));
  const ignoreAgents = new Set(options.ignoreAgents.map((name) => String(name).toLowerCase()));
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
        await recordObserved(project.project_dir);
        // Not a maybeRun trigger site: execute.after and the prompt hook
        // below already cover every observation this plugin records, and
        // every tool call reaches execute.before *and* execute.after, so
        // triggering here too only doubled the gate check for no benefit.
      } catch (error) {
        console.warn(`[${PKG_NAME}] execute.before observation failed`, error);
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
        await recordObserved(project.project_dir);
        void observer.maybeRun(event.sessionID);
      } catch (error) {
        console.warn(`[${PKG_NAME}] execute.after observation failed`, error);
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
          // scrub+clip happen once, in store.js's appendObservation, for
          // every observation field (see SCRUBBED_FIELDS there); the limit
          // is passed through per-field because the store's own default
          // (FIELD_CLIP_CHARS, 5000) is wider than the 2000 chars a prompt
          // should keep. The injected `<instincts>` block (lib/inject.js),
          // if any, is stripped first: the observer must distil what the
          // user actually typed, not instincts this plugin just injected.
          await appendObservation(
            project,
            {
              event: "user_prompt",
              session: event.sessionID,
              project_id: project.id,
              project_name: project.name,
              text: stripInjectedBlock(text),
            },
            { text: PROMPT_CLIP_CHARS },
          );
          await recordObserved(project.project_dir);
          void observer.maybeRun(event.sessionID);
        } catch (error) {
          console.warn(`[${PKG_NAME}] prompt observation failed`, error);
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
