// The `/instinct <verb>` family: one slash command (plus, for one
// release, five deprecated hyphenated aliases lib/commands.js still
// registers) covering status/projects/export/import/observe (the old
// separate instinct-status/-import/-export/-projects/-observe commands),
// plus five verbs that live only here: `why` (what got injected into
// this session, and what fired), `keep`/`wrong` (per-instinct feedback:
// raise confidence, or archive-and-mute), `mute`/`unmute` (settings-
// only, no file move), `observer on|off` (persisted, and applied to the
// live options object immediately), `doctor` (lib/health.js's checks
// plus the observer gate's own verdict), and `help` (also the bare
// `/instinct`). Mirrors lib/evolve-command.js's own shape: a pure
// dispatcher (`dispatchInstinct`, reused by lib/commands.js's
// deprecated aliases) plus a thin command-def builder
// (`buildInstinctCommands`) that posts the dispatcher's reply via the
// same `postResult` every other command in this plugin uses. Nothing
// here ever starts a model turn (no `ctx.session.prompt`).
import fs from "node:fs/promises";
import path from "node:path";
import { runCli, tokenizeArgv } from "./cli.js";
import { postResult } from "./reply.js";
import { resolveProject } from "./project.js";
import { resolveHomunculusDir } from "./homunculus-dir.js";
import { listInstincts, writeInstinct, bumpFiredCount } from "./store.js";
import { loadInstinctFiles } from "./maintain.js";
import { readSettings, writeSettings, settingsFilePath } from "./settings.js";
import { lastInjected, invalidateInjectPool, classifySourceDir } from "./inject.js";
import { readObserverState, saveObserverState, countObservationLines, pendingSince } from "./observer-state.js";
import { evaluateObserverGate, parseModelRef, MODEL_UNSET_MESSAGE } from "./observer.js";
import { collectHealth } from "./health.js";
import { describeError } from "./util.js";

// One row per verb, doubling as both the dispatch table (below) and the
// `help` verb's own listing, so the two can never drift apart.
const VERBS = [
  { verb: "status", usage: "status", description: "Show ECC instinct status (project-scoped + global)." },
  { verb: "projects", usage: "projects", description: "List known projects and their instinct counts." },
  { verb: "export", usage: "export [...]", description: "Export instincts to stdout or a file." },
  { verb: "import", usage: "import <file|url> [...]", description: "Import instincts from a local file or an https URL." },
  { verb: "observe", usage: "observe", description: "Run the instinct observer now, ignoring the configured thresholds." },
  { verb: "why", usage: "why", description: "Show the ids, confidence and source of the latest injected block for this session, and which ids fired on the last prompt." },
  { verb: "keep", usage: "keep <id>", description: "Confirm an instinct was useful: bumps its fired count and raises its confidence by 0.05 (capped at 0.95)." },
  { verb: "wrong", usage: "wrong <id>", description: "Archive an instinct and mute it so no copy of it is injected again (undo: /instinct unmute <id>)." },
  { verb: "mute", usage: "mute <id>", description: "Skip an id for injection, without archiving its file." },
  { verb: "unmute", usage: "unmute <id>", description: "Un-skip a muted id, restoring it from the archive if 'wrong' put it there." },
  { verb: "observer", usage: "observer on|off", description: "Turn the background observer on or off; persisted across restarts and applied immediately." },
  { verb: "doctor", usage: "doctor", description: "Run the board's own health checks, plus the observer gate's current verdict." },
  { verb: "help", usage: "help", description: "List every registered command and /instinct verb (also runs for the bare /instinct, with no arguments)." },
];

function round2(value) {
  return Math.round(value * 100) / 100;
}

function globalPersonalDir(options) {
  return path.join(resolveHomunculusDir(options), "instincts", "personal");
}

// `instincts/archive/` is always a sibling of wherever an instinct's own
// store lives (this project's `instincts/personal` and `instincts/inherited`
// share one parent `instincts/` dir, so they share one archive too; the
// shared global store has its own, the same way lib/maintain.js's
// decayStep and promoteStep already treat these two archive locations).
function archiveSiblingDir(sourceDir) {
  return path.join(path.dirname(sourceDir), "archive");
}

// Finds the one file under `dir` holding `id`'s own instinct, ready for
// `keep`/`wrong`/`unmute` to rewrite: `loadInstinctFiles` (lib/maintain.js)
// only ever returns a file with exactly one frontmatter block, the one
// shape writeInstinct produces and the only one safe to rewrite in
// place. When `id` is not among those but still shows up in
// `listInstincts` (lib/store.js, which parses every block in a file
// regardless of how many it holds), it lives inside a multi-block file
// (ECC import/export batches several instincts into one file);
// reported back as its own case (`multiBlock: true`) rather than folded
// into "not found", which would wrongly suggest the id does not exist
// anywhere at all.
async function findInstinctFile(dir, id) {
  const clean = await loadInstinctFiles(dir);
  const match = clean.find((item) => item.fields.id === id);
  if (match) return { fields: match.fields, body: match.body, filePath: match.filePath, dir };

  const all = await listInstincts(dir);
  const multiBlockMatch = all.find((inst) => inst.id === id);
  if (multiBlockMatch) return { multiBlock: true, filePath: multiBlockMatch.filePath };
  return null;
}

async function locateInstinct(dirs, id) {
  for (const dir of dirs) {
    const found = await findInstinctFile(dir, id);
    if (found) return found;
  }
  return null;
}

// Renders the one-line reply for a `located`/`findInstinctFile` result
// that cannot be rewritten: `null` means the id was not found anywhere
// searched; `multiBlock` means it was found, but inside a file this
// command refuses to rewrite blindly.
function describeUnrewritable(id, located) {
  if (!located) return `No instinct found with id '${id}'.`;
  return `${id} found in ${located.filePath} but it holds several instincts; edit it by hand.`;
}

// --------------------------------------------------------------- status/projects/export/import/observe

async function forwardCli(ctx, options, action, args, force) {
  try {
    return await runCli(options, action, args, { force, directory: ctx.location.directory });
  } catch (error) {
    return describeError(error);
  }
}

// `deps.observer` is the same controller object lib/plugin.js's
// createObserver returns, shared with the real /instinct-observe this
// replaces: `run()` posts its own synthetic summary when notify is
// forced on, so a successful call needs nothing further posted here
// (the `null` return tells the caller as much); a thrown error never
// reaches that notify step, hence returning the error text itself for
// the caller to post instead.
async function runObserveVerb(deps, sessionID) {
  if (!deps?.observer || typeof deps.observer.run !== "function") {
    return "observer is not available.";
  }
  try {
    await deps.observer.run(sessionID, { notify: true });
    return null;
  } catch (error) {
    return describeError(error);
  }
}

// --------------------------------------------------------------- why

function formatWhy(record) {
  if (!record || !Array.isArray(record.ids) || record.ids.length === 0) {
    return "nothing injected in this session yet";
  }
  const lines = [`injected at ${record.at}:`];
  for (const entry of record.ids) {
    const pct = Math.round((Number(entry.confidence) || 0) * 100);
    lines.push(`- ${entry.id} (confidence ${pct}%, ${entry.source})`);
  }
  const fired = Array.isArray(record.fired) ? record.fired : [];
  lines.push(fired.length > 0 ? `fired on last prompt: ${fired.join(", ")}` : "fired on last prompt: none");
  return lines.join("\n");
}

// --------------------------------------------------------------- keep/wrong/mute/unmute

async function verbKeep(ctx, options, id) {
  if (!id) return "Usage: /instinct keep <id>";
  const project = await resolveProject(ctx, options);
  const dirs = [project.instincts_personal, project.instincts_inherited, globalPersonalDir(options)];
  const located = await locateInstinct(dirs, id);
  if (!located || located.multiBlock) return describeUnrewritable(id, located);

  await bumpFiredCount(located.dir, id);
  // Re-read: bumpFiredCount just wrote `fired` straight to disk, and the
  // confidence raise below has to start from that fresh file, not the
  // pre-bump snapshot `located` still holds (which would otherwise
  // overwrite the just-written fired count with its own stale one).
  const reread = await findInstinctFile(located.dir, id);
  const refreshed = reread && !reread.multiBlock ? reread : located;
  const confidence = Math.min(0.95, round2((Number(refreshed.fields.confidence) || 0) + 0.05));
  await writeInstinct(located.dir, { ...refreshed.fields, confidence }, refreshed.body);
  invalidateInjectPool();
  return `kept ${id}: confidence now ${confidence} (fired ${Number(refreshed.fields.fired) || 0}, ${classifySourceDir(located.dir, project, options)})`;
}

async function verbWrong(ctx, options, deps, id) {
  if (!id) return "Usage: /instinct wrong <id>";
  // Settings written here must land after the startup read that applies
  // a previous process's persisted toggles (lib/commands.js's
  // registerCommands), never before it: that read never itself writes
  // the file, but waiting for it first keeps every settings access in
  // this module ordered the same way, with no separate rule for one
  // verb versus another.
  await deps?.settingsReady;
  const project = await resolveProject(ctx, options);
  const dirs = [project.instincts_personal, project.instincts_inherited, globalPersonalDir(options)];
  const located = await locateInstinct(dirs, id);
  if (!located || located.multiBlock) return describeUnrewritable(id, located);

  const archiveDir = archiveSiblingDir(located.dir);
  const archivedPath = await writeInstinct(archiveDir, located.fields, located.body);
  await fs.unlink(located.filePath);

  const settings = await readSettings(project.project_dir);
  const muted = new Set(settings.muted);
  muted.add(id);
  await writeSettings(project.project_dir, { ...settings, muted: [...muted] });
  invalidateInjectPool();

  return `moved ${id} to ${archivedPath} and muted it.\nundo: /instinct unmute ${id}`;
}

async function verbMute(ctx, options, deps, id) {
  if (!id) return "Usage: /instinct mute <id>";
  await deps?.settingsReady;
  const project = await resolveProject(ctx, options);
  const settings = await readSettings(project.project_dir);
  const muted = new Set(settings.muted);
  muted.add(id);
  await writeSettings(project.project_dir, { ...settings, muted: [...muted] });
  return `muted ${id}`;
}

async function verbUnmute(ctx, options, deps, id) {
  if (!id) return "Usage: /instinct unmute <id>";
  await deps?.settingsReady;
  const project = await resolveProject(ctx, options);
  const settings = await readSettings(project.project_dir);
  const muted = new Set(settings.muted);
  const wasMuted = muted.delete(id);
  await writeSettings(project.project_dir, { ...settings, muted: [...muted] });

  // Restore from whichever archive actually holds it, if either: the
  // project's own archive restores to the project's own personal store,
  // the shared global archive restores to the shared global personal
  // store. An id this plugin never archived (a plain /instinct mute, or
  // one that was never muted at all) simply has nothing to restore; nor
  // does one that only exists inside a multi-block file (findInstinctFile's
  // `multiBlock` case), which this verb leaves untouched rather than
  // guessing which of several instincts in that file to pull out.
  const globalDir = globalPersonalDir(options);
  const restoreCandidates = [
    { archiveDir: archiveSiblingDir(project.instincts_personal), restoreDir: project.instincts_personal },
    { archiveDir: archiveSiblingDir(globalDir), restoreDir: globalDir },
  ];
  let restoredTo = null;
  for (const { archiveDir, restoreDir } of restoreCandidates) {
    const found = await findInstinctFile(archiveDir, id);
    if (!found || found.multiBlock) continue;
    await writeInstinct(restoreDir, found.fields, found.body);
    await fs.unlink(found.filePath);
    restoredTo = restoreDir;
    break;
  }
  if (restoredTo) invalidateInjectPool();

  const parts = [wasMuted ? `unmuted ${id}` : `${id} was not muted`];
  parts.push(restoredTo ? `restored from archive to ${restoredTo}` : "nothing archived to restore");
  return parts.join("; ");
}

// --------------------------------------------------------------- observer on|off

async function verbObserver(ctx, options, deps, sub) {
  if (sub !== "on" && sub !== "off") return "Usage: /instinct observer on|off";
  await deps?.settingsReady;
  const project = await resolveProject(ctx, options);
  const settings = await readSettings(project.project_dir);
  await writeSettings(project.project_dir, { ...settings, observer: { enabled: sub === "on" } });

  // Replaces `options.observer` outright rather than mutating its own
  // `enabled` property in place: lib/plugin.js's mergeOptions always
  // spreads the frozen OBSERVER_DEFAULTS (lib/observer.js) into a fresh
  // object for `options.observer` on every setup() call, and that same
  // object, not a copy, is what the running observer and the board read
  // on every call, by reference, so a fresh object carrying the same
  // other fields plus the new `enabled` takes effect on the very next
  // observed event or board refresh, with no restart needed. Replacing
  // rather than mutating also means this never throws if `options.observer`
  // happens to be frozen: spreading a frozen object (or null/undefined)
  // into a new object literal always yields a plain, writable one.
  options.observer = { ...options.observer, enabled: sub === "on" };

  if (sub === "off") return "observer: off";

  const state = await readObserverState(project.project_dir);
  if (!parseModelRef(options.observer.model)) {
    // Recorded directly (rather than waiting for a real run attempt to
    // discover it) so the very next /instinct doctor or board refresh
    // already reads the gate as blocked on model-unset, not as merely
    // "ready" because nothing has tried and failed yet.
    if (state.blocked !== "model-unset") {
      await saveObserverState(project.project_dir, { ...state, blocked: "model-unset" });
    }
    return `observer: on, but blocked (model-unset)\n${MODEL_UNSET_MESSAGE}`;
  }
  // The model is configured: a stale model-unset block recorded before
  // it was set no longer reflects reality, so it is cleared here too.
  if (state.blocked === "model-unset") {
    await saveObserverState(project.project_dir, { ...state, blocked: null });
  }
  return "observer: on";
}

// --------------------------------------------------------------- doctor

function expandHomeLocal(value) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value === "~") return process.env.HOME ?? undefined;
  if (value.startsWith("~/")) return path.join(process.env.HOME ?? "", value.slice(2));
  return value;
}

async function verbDoctor(ctx, options) {
  const project = await resolveProject(ctx, options);
  const observerState = await readObserverState(project.project_dir);
  const lineCount = await countObservationLines(project.observations_file);
  const pendingCount = pendingSince(observerState, lineCount);
  const gate = evaluateObserverGate({ state: observerState, options, pendingCount });
  const observationsRoot = expandHomeLocal(options.board?.observationsRoot);
  // evalRoots is left empty here: the Skill-test eval check is purely
  // informational (lib/health.js never flags anything "attention" for
  // it), and resolving the real default roots belongs to
  // lib/board-evals.js, not to this dispatcher.
  const health = await collectHealth({ options, project, observerState, observationsRoot, evalRoots: [] });

  const lines = health.length > 0 ? health.map((entry) => `[${entry.level}] ${entry.key}: ${entry.message}`) : ["all checks passed"];
  lines.push(`observer gate: ${gate.ready ? "ready" : `blocked (${gate.reason})`}`);

  // A disabled gate can mean either opencode.json's own observer.enabled
  // is false, or .settings.json's own value (lib/settings.js, set by a
  // prior /instinct observer off) is overriding a true opencode.json
  // value: naming the file whenever it carries an explicit enabled
  // value removes the guesswork between those two cases.
  if (gate.reason === "disabled") {
    const settings = await readSettings(project.project_dir);
    if (typeof settings.observer?.enabled === "boolean") {
      lines.push(`${settingsFilePath(project.project_dir)} sets observer.enabled: ${settings.observer.enabled}, overriding opencode.json's own observer.enabled.`);
    }
  }
  return lines.join("\n");
}

// --------------------------------------------------------------- help

function buildHelpText(deps) {
  const allCommands = typeof deps?.allCommands === "function" ? deps.allCommands() : [];
  const commandLines = allCommands
    .filter((def) => def && typeof def.name === "string")
    .map((def) => `/${def.name}: ${def.description ?? ""}`);
  const verbLines = VERBS.map((entry) => `/instinct ${entry.usage}: ${entry.description}`);
  return [...commandLines, ...verbLines].join("\n");
}

// --------------------------------------------------------------- dispatch

// The one pure dispatcher backing both the real `/instinct` command
// (buildInstinctCommands, below) and lib/commands.js's deprecated
// hyphenated aliases: returns the reply text, or `null` for the one
// case (`observe`, success path) where the reply was already posted by
// something else (lib/observer.js's own notify). Never calls a model.
// `deps.settingsReady` (lib/commands.js's registerCommands), when given,
// is awaited by every verb that itself writes settings before it reads
// or writes anything, so the startup settings read this promise carries
// can never land after, and clobber, a command that ran right after
// startup.
export async function dispatchInstinct(ctx, options, deps, sessionID, argvText) {
  const tokens = tokenizeArgv(argvText ?? "");
  const verb = tokens[0];
  const args = tokens.slice(1);

  switch (verb) {
    case undefined:
    case "help":
      return buildHelpText(deps);
    case "status":
      return await forwardCli(ctx, options, "status", args, false);
    case "projects":
      return await forwardCli(ctx, options, "projects", args, false);
    case "export":
      return await forwardCli(ctx, options, "export", args, false);
    case "import":
      return await forwardCli(ctx, options, "import", args, true);
    case "observe":
      return await runObserveVerb(deps, sessionID);
    case "why":
      return formatWhy(lastInjected(sessionID));
    case "keep":
      return await verbKeep(ctx, options, args[0]);
    case "wrong":
      return await verbWrong(ctx, options, deps, args[0]);
    case "mute":
      return await verbMute(ctx, options, deps, args[0]);
    case "unmute":
      return await verbUnmute(ctx, options, deps, args[0]);
    case "observer":
      return await verbObserver(ctx, options, deps, args[0]);
    case "doctor":
      return await verbDoctor(ctx, options);
    default:
      return `Unknown /instinct verb: '${verb}'. Run /instinct help for the full list.`;
  }
}

// Returns the one "instinct" command definition, in the same `{ name,
// description, execute }` shape every other command in this plugin
// uses, replying via postResult (lib/reply.js).
export function buildInstinctCommands(ctx, options, deps = {}) {
  return [
    {
      name: "instinct",
      description:
        "ECC instinct status, per-habit feedback (keep/wrong/mute/unmute), the observer's on/off switch, doctor, and why (what got injected). Run with no arguments, or 'help', for the full verb list.",
      async execute({ sessionID, prompt }) {
        const text = await dispatchInstinct(ctx, options, deps, sessionID, prompt?.text ?? "");
        if (text !== null) await postResult(ctx, sessionID, text);
      },
    },
  ];
}
