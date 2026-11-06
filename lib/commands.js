// Slash commands. /instinct status/projects/export/import still run
// instinct-cli.py (through lib/cli.js); everything else is JS: /board
// (lib/board-format.js, reads board-state.json instead), /evolve
// (lib/evolve-command.js: dashboard, detail, install, reject, archive,
// now, clusters, backed by lib/evolve-preview.js's own deterministic
// cluster preview and lib/candidates.js/lib/usage.js's candidate
// lifecycle, entirely separate from instinct-cli.py's own vendored
// evolve output), and /instinct (lib/commands-instinct.js: status,
// projects, export, import, observe, why, keep, wrong, mute, unmute,
// observer on/off, doctor, help; see that file's own header for the
// full grammar). evolve-install/-show/-reject/-archive/-list and
// instinct-status/-import/-export/-projects/-observe all remain
// registered too, for one release, as thin aliases that forward their
// old argv shape into the unified /evolve or /instinct grammar (see
// translateEvolve* and INSTINCT_ALIASES below) and prefix the reply
// with a one-line deprecation notice. /maintain, /promote and
// /skill-review come from lib/commands-maintain.js; /instinct-prune
// forwards into /maintain prune. Replies go through lib/reply.js. None
// of this starts a model turn, so nothing here calls ctx.session.prompt.
import { tokenizeArgv } from "./cli.js";
import { formatBoardSummary } from "./board-format.js";
import { runEvolve, runEvolveParsed, createEvolveState, EVOLVE_VERBS } from "./evolve-command.js";
import { buildInstinctCommands, dispatchInstinct } from "./commands-instinct.js";
import { resolveProject } from "./project.js";
import { readSettings, applyRuntimeSettings } from "./settings.js";
import { PKG_NAME } from "./pkg.js";
import { describeError } from "./util.js";
import { postResult } from "./reply.js";
import { buildMaintenanceCommands, runPruneOnly } from "./commands-maintain.js";


export async function registerCommands(ctx, options, observer, board, review, deps = {}) {
  // One numbering/look-before-leap state for every /evolve command and
  // alias this call registers, so they share it with each other but
  // never with another registerCommands call (another plugin instance,
  // another project) in the same process.
  const evolveState = createEvolveState();

  // resolveProject can block on a real python subprocess for up to its
  // own timeout (project.js) before a persisted /instinct setting
  // (lib/settings.js) can even be read, and setup() itself must return
  // quickly (lib/plugin.js's own invariant: every registration here runs
  // through safeRegister, which awaits this function). So this chain is
  // started here and never awaited directly: commands register
  // immediately, and `settingsReady` resolves once the startup settings
  // have actually been applied to the live `options` object (so a
  // previous process's `/instinct observer on|off` is in effect again
  // after a restart). Every /instinct verb that itself writes settings
  // (observer on|off, wrong, mute, unmute) awaits this same promise
  // before touching anything, so a command typed right after startup is
  // never later overwritten once this slower read finally lands; a
  // failure here (resolveProject's own fallback already logs its own
  // warning) just means no persisted setting is applied this run.
  const settingsReady = resolveProject(ctx, options)
    .then((project) => readSettings(project.project_dir))
    .then((settings) => applyRuntimeSettings(options, settings))
    .catch(() => {});

  // Every command def this call registers, in registration order,
  // captured for /instinct help (lib/commands-instinct.js) to list; read
  // lazily (`() => allCommandDefs`) so it reflects the final array
  // contents at help-execution time, regardless of how this list grows
  // between here and whenever help actually runs.
  const allCommandDefs = [];
  const instinctDeps = { ...deps, observer, allCommands: () => allCommandDefs, settingsReady };

  const registration = await ctx.command.transform((editor) => {
    const add = (def) => {
      allCommandDefs.push(def);
      editor.add(def);
    };
    add(buildBoardCommand(ctx, options, board));
    add(buildEvolveCommand(ctx, options, evolveState));
    for (const alias of EVOLVE_ALIASES) add(buildEvolveAliasCommand(ctx, options, alias, evolveState));
    const maintenanceCommands = buildMaintenanceCommands(ctx, options, { review });
    for (const def of maintenanceCommands) add(def);
    add(buildPruneAliasCommand(ctx, options));
    for (const def of buildInstinctCommands(ctx, options, instinctDeps)) add(def);
    for (const alias of INSTINCT_ALIASES) add(buildInstinctAliasCommand(ctx, options, instinctDeps, alias));
  });
  return [registration];
}

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

// /instinct-prune was a plain instinct-cli.py passthrough; it now forwards
// into /maintain prune for one release, like the other deprecated aliases,
// prefixing its reply with the same one-line deprecation notice.
function buildPruneAliasCommand(ctx, options) {
  return {
    name: "instinct-prune",
    description: "Deprecated: alias of /maintain prune [--dry-run]. Forwards into the unified /maintain command.",
    async execute({ sessionID, prompt }) {
      const dryRun = tokenizeArgv(prompt?.text ?? "").includes("--dry-run");
      const label = `/maintain prune${dryRun ? " --dry-run" : ""}`;
      try {
        const project = await resolveProject(ctx, options);
        const text = await runPruneOnly(project, dryRun);
        await postResult(ctx, sessionID, `alias of ${label}; this alias goes away in a later release.\n\n${text}`);
      } catch (error) {
        await postResult(ctx, sessionID, describeError(error));
      }
    },
  };
}

function buildEvolveCommand(ctx, options, evolveState) {
  return {
    name: "evolve",
    description: "Dashboard, detail, install, reject, archive, 'now', and 'clusters' for evolve candidates (run with no arguments for the grammar's own dashboard).",
    async execute({ sessionID, prompt }) {
      const text = await runEvolve(ctx, options, prompt?.text ?? "", evolveState);
      await postResult(ctx, sessionID, text);
    },
  };
}

// -------------------------------------------------------- deprecated aliases

// Each of these five commands, from v0.10.0 and earlier, stays
// registered for one release, translating its own old argv shape
// directly into the structured
// `{ verb, pick, limit, reason }` runEvolveParsed accepts (translateEvolve*
// below), and prefixing the reply with a one-line deprecation notice, so
// an existing habit, script, or saved note keeps working verbatim while
// pointing at its replacement. Building that structure directly, rather
// than a text equivalent re-tokenized through runEvolve, matters for
// evolve-reject specifically: its reason is free text that could contain
// anything (including something that looks like a flag or another verb),
// and must reach runReject completely unreinterpreted.
const EVOLVE_ALIASES = [
  {
    name: "evolve-install",
    description: "Deprecated: alias of /evolve <n|id> install (and, without --yes, /evolve <n|id>). Forwards into the unified /evolve dispatcher.",
    translate: translateEvolveInstall,
  },
  {
    name: "evolve-show",
    description: "Deprecated: alias of /evolve <n|id> (read-only detail). Forwards into the unified /evolve dispatcher.",
    translate: translatePickOnly,
  },
  {
    name: "evolve-reject",
    description: "Deprecated: alias of /evolve <n|id> reject [why]. Forwards into the unified /evolve dispatcher.",
    translate: translateEvolveReject,
  },
  {
    name: "evolve-archive",
    description: "Deprecated: alias of /evolve <n|id> archive. Forwards into the unified /evolve dispatcher.",
    translate: translateEvolveArchive,
  },
  {
    name: "evolve-list",
    description: "Deprecated: alias of /evolve (dashboard) or /evolve <n|id> (detail). Forwards into the unified /evolve dispatcher.",
    translate: translatePickOnly,
  },
];

function buildEvolveAliasCommand(ctx, options, alias, evolveState) {
  return {
    name: alias.name,
    description: alias.description,
    async execute({ sessionID, prompt }) {
      const parsed = alias.translate(tokenizeArgv(prompt?.text ?? ""));
      const label = describeParsedEquivalent(parsed);
      const reply = await runEvolveParsed(ctx, options, parsed, evolveState);
      await postResult(ctx, sessionID, `alias of ${label}; this alias goes away in a later release.\n\n${reply}`);
    },
  };
}

// Renders a parsed `{ verb, pick, limit, reason }` back into a human-
// readable "/evolve ..." label for the deprecation line, straight from
// its own fields rather than any text form, so this can never disagree
// with what was actually dispatched.
function describeParsedEquivalent(parsed) {
  const parts = [];
  if (parsed.pick) parts.push(parsed.pick.type === "index" ? String(parsed.pick.value) : parsed.pick.value);
  if (parsed.verb) parts.push(parsed.verb);
  if (parsed.reason) parts.push(parsed.reason);
  if (typeof parsed.limit === "number") parts.push("--limit", String(parsed.limit));
  return parts.length > 0 ? `/evolve ${parts.join(" ")}` : "/evolve";
}

// evolve-list [id] and evolve-show <id> both only ever looked at their
// first token (extra tokens were silently ignored); their /evolve
// equivalent is that same token alone as a bare pick (none at all means
// the bare dashboard).
function translatePickOnly(tokens) {
  const id = tokens[0];
  return id ? { pick: { type: "id", value: id } } : {};
}

// evolve-install <id> [--yes]: the id is the first non-flag token;
// --yes becomes the "install" verb (its absence leaves a bare pick,
// i.e. a detail view, exactly like the old preview-without---yes did).
function translateEvolveInstall(tokens) {
  const id = tokens.find((token) => !token.startsWith("--"));
  const pick = id ? { type: "id", value: id } : undefined;
  return tokens.includes("--yes") ? { verb: EVOLVE_VERBS.INSTALL, pick } : { pick };
}

// evolve-reject <id> [reason]: every token after the id was already the
// reason verbatim; carried straight into the parsed reason field, with
// no text round-trip to misread it.
function translateEvolveReject(tokens) {
  const id = tokens[0];
  const reason = tokens.slice(1).join(" ");
  return { verb: EVOLVE_VERBS.REJECT, pick: id ? { type: "id", value: id } : undefined, reason: reason || undefined };
}

// evolve-archive <id>: the id plus the "archive" verb.
function translateEvolveArchive(tokens) {
  const id = tokens[0];
  return { verb: EVOLVE_VERBS.ARCHIVE, pick: id ? { type: "id", value: id } : undefined };
}

// ------------------------------------------------------ deprecated /instinct-* aliases

// Each of these five commands, from v0.10.0 and earlier, stays
// registered for one release, forwarding its own argv text straight
// onto the matching /instinct verb
// (lib/commands-instinct.js's dispatchInstinct, the exact same dispatcher
// the real /instinct command itself calls) and prefixing the reply with
// a one-line deprecation notice, so an existing habit, script, or saved
// note keeps working while pointing at its replacement. `prune` is not
// part of the /instinct family; /instinct-prune forwards into /maintain
// prune instead (buildPruneAliasCommand above).
const INSTINCT_ALIASES = [
  { name: "instinct-status", verb: "status", description: "Deprecated: alias of /instinct status. Forwards into the unified /instinct dispatcher." },
  { name: "instinct-import", verb: "import", description: "Deprecated: alias of /instinct import. Forwards into the unified /instinct dispatcher." },
  { name: "instinct-export", verb: "export", description: "Deprecated: alias of /instinct export. Forwards into the unified /instinct dispatcher." },
  { name: "instinct-projects", verb: "projects", description: "Deprecated: alias of /instinct projects. Forwards into the unified /instinct dispatcher." },
  { name: "instinct-observe", verb: "observe", description: "Deprecated: alias of /instinct observe. Forwards into the unified /instinct dispatcher." },
];

function buildInstinctAliasCommand(ctx, options, deps, alias) {
  return {
    name: alias.name,
    description: alias.description,
    async execute({ sessionID, prompt }) {
      const argvText = prompt?.text ?? "";
      const combined = argvText.length > 0 ? `${alias.verb} ${argvText}` : alias.verb;
      const label = `/instinct ${combined}`;
      // `dispatchInstinct` returns `null` only for a successful
      // `observe`, which already posted its own reply (lib/observer.js's
      // run() notify); the deprecation notice still needs to reach the
      // user on its own in that case, since otherwise this alias would
      // look identical to the new command forever.
      const text = await dispatchInstinct(ctx, options, deps, sessionID, combined);
      const notice = `alias of ${label}; this alias goes away in a later release.`;
      await postResult(ctx, sessionID, text === null ? notice : `${notice}\n\n${text}`);
    },
  };
}

export { SYNTHETIC_MESSAGE_CAP, splitForSyntheticMessage, postResult } from "./reply.js";
