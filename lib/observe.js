// Tool and prompt observation hooks. Every callback is wrapped in try/catch:
// a plugin hook that throws takes the host turn down with it, and an
// observation side-channel is never worth that.
import path from "node:path";
import { resolveProject } from "./project.js";
import { appendObservation, bumpFiredCount } from "./store.js";
import { recordObserved, recordFired } from "./activity.js";
import { bumpUsage, commandNameFromPromptText } from "./usage.js";
import { loadCandidates, usageBucketForKind } from "./candidates.js";
import { resolveHomunculusDir } from "./homunculus-dir.js";
import { PKG_NAME } from "./pkg.js";
import { clip } from "./scrub.js";

const INPUT_CLIP_CHARS = 5000;
const PROMPT_CLIP_CHARS = 2000;
// Matches lib/inject.js's own injected block exactly (open tag, lines,
// close tag), plus the blank line(s) this plugin's injection adds before
// it, so a stripped prompt reads the same as it did before injection.
const INJECTED_BLOCK_PATTERN = /\n{0,2}<instincts>[\s\S]*?<\/instincts>\n*/g;
// Tool names whose own `input` carries a "which agent did this spawn"
// field, for usage.json's `agents` bucket (0.8.0's "usage tracking of
// installed skills/commands/agents"). Both names are treated the same:
// different hosts/SDK versions have used either for the same concept.
const SUBAGENT_SPAWN_TOOLS = new Set(["subagent", "task"]);

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
        await trackToolUsage(project, options, event);
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
          await trackCommandUsage(project, options, text);
          void observer.maybeRun(event.sessionID);
        } catch (error) {
          console.warn(`[${PKG_NAME}] prompt observation failed`, error);
        }
      }),
    );
  }

  return registrations;
}

// Usage tracking (0.8.0): counts into <project data dir>/usage.json,
// independent of whether the tool/command/agent happens to be one this
// plugin's own evolve lifecycle (lib/candidates.js) generated, or
// something hand-written. `skill` tool calls count by `input.id` (or,
// when a host's skill tool names that field differently, `input.name`);
// `subagent`/`task` tool calls (spawning a named agent) count by
// `input.agent` (or `input.subagent_type`, another naming convention
// seen across hosts/SDK versions for the same concept). This dependency
// on the host's own field naming is documented in README's "From habits
// to skills" section: when neither name is present, usage for that call
// is simply not counted, which is also why pruneCandidatesStep (lib/maintain.js)
// refuses to auto-delete anything of a kind whose usage bucket is
// entirely empty, rather than trusting that silence as "genuinely
// unused". Every successfully-bumped use also feeds back into the
// member instincts behind any *installed* candidate that happens to
// share this kind+name (applyCandidateFeedback below), so the habits
// that earned a useful artefact do not decay just because the artefact
// itself, not the habit, is now what gets used day to day.
async function trackToolUsage(project, options, event) {
  const tool = String(event.tool ?? "").toLowerCase();
  if (tool === "skill") {
    const id = event.input?.id ?? event.input?.name;
    if (typeof id === "string" && id.length > 0) {
      await bumpUsage(project.project_dir, "skills", id);
      await applyCandidateFeedback(project, options, "skills", id);
    }
    return;
  }
  if (SUBAGENT_SPAWN_TOOLS.has(tool)) {
    const agent = event.input?.agent ?? event.input?.subagent_type;
    if (typeof agent === "string" && agent.length > 0) {
      await bumpUsage(project.project_dir, "agents", agent);
      await applyCandidateFeedback(project, options, "agents", agent);
    }
  }
}

// Slash commands are observed as plain prompt text (there is no separate
// "command was invoked" hook for commands this plugin did not itself
// register, e.g. a just-installed candidate command), so usage counting
// for the `commands` bucket lives here instead of in lib/commands.js.
// Tied to `observePrompts` (this function is only ever called from
// inside that gate): turning prompt observation off also turns off
// command-usage counting, which is the simplest rule to explain, even
// though the two are slightly different concerns.
async function trackCommandUsage(project, options, text) {
  const name = commandNameFromPromptText(text);
  if (!name) return;
  await bumpUsage(project.project_dir, "commands", name);
  await applyCandidateFeedback(project, options, "commands", name);
}

// When an installed candidate's own suggested_name is the thing just
// used, bumps `fired` (store.js's bumpFiredCount, the same counter
// lib/inject.js bumps on a real prompt match) on every one of its member
// instincts, wherever each one actually lives (project personal,
// inherited, or the shared global bucket). A member fired at least once
// is exempt from lib/maintain.js's decayStep, so the habits behind a
// useful artefact never decay just because people now reach for the
// artefact instead of relying on the injected instinct directly.
async function applyCandidateFeedback(project, options, bucket, key) {
  let candidates;
  try {
    candidates = await loadCandidates(project.evolved_dir);
  } catch {
    return;
  }
  const matches = candidates.filter(
    (candidate) => candidate.fields.status === "installed" && usageBucketForKind(candidate.fields.kind) === bucket && candidate.fields.suggested_name === key,
  );
  if (matches.length === 0) return;

  const globalPersonalDir = path.join(resolveHomunculusDir(options), "instincts", "personal");
  const memberDirs = [project.instincts_personal, project.instincts_inherited, globalPersonalDir];
  const memberIds = new Set(matches.flatMap((candidate) => candidate.fields.members ?? []));

  for (const memberId of memberIds) {
    for (const dir of memberDirs) {
      try {
        if (await bumpFiredCount(dir, memberId)) {
          await recordFired(project.project_dir, memberId);
          break;
        }
      } catch (error) {
        console.warn(`[${PKG_NAME}] candidate-feedback fired-count update failed for ${memberId}`, error);
      }
    }
  }
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
