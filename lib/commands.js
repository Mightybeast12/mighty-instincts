// Slash commands. Most run instinct-cli.py directly (through lib/cli.js)
// and post the result as a synthetic message; the exceptions are /board
// (lib/board-format.js, reads board-state.json instead) and /evolve
// (lib/evolve-command.js: dashboard, detail, install, reject, archive,
// now, clusters, backed by lib/evolve-preview.js's own deterministic
// cluster preview and lib/candidates.js/lib/usage.js's candidate
// lifecycle, entirely separate from instinct-cli.py's own vendored
// evolve output). evolve-install/-show/-reject/-archive/-list remain
// registered too, for one release, as thin aliases that forward their
// old argv shape into the same /evolve grammar (see translateEvolve*
// below) and prefix the reply with a one-line deprecation notice. None
// of this starts a model turn, so there is nothing here that calls
// ctx.session.prompt.
import { runCli, tokenizeArgv } from "./cli.js";
import { formatBoardSummary } from "./board-format.js";
import { runEvolve, runEvolveParsed, createEvolveState, EVOLVE_VERBS } from "./evolve-command.js";
import { PKG_NAME } from "./pkg.js";
import { describeError, noticeDescription } from "./util.js";

const CLI_COMMANDS = [
  { name: "instinct-status", description: "Show ECC instinct status (project-scoped + global).", action: "status", force: false },
  { name: "instinct-import", description: "Import instincts from a local file or an https URL.", action: "import", force: true },
  { name: "instinct-export", description: "Export instincts to stdout or a file.", action: "export", force: false },
  { name: "promote", description: "Promote project-scoped instincts that qualify to global scope.", action: "promote", force: true },
  { name: "instinct-projects", description: "List known projects and their instinct counts.", action: "projects", force: false },
  { name: "instinct-prune", description: "Delete pending instincts older than the TTL.", action: "prune", force: false },
];

export async function registerCommands(ctx, options, observer, board, review) {
  // One numbering/look-before-leap state for every /evolve command and
  // alias this call registers, so they share it with each other but
  // never with another registerCommands call (another plugin instance,
  // another project) in the same process.
  const evolveState = createEvolveState();
  const registration = await ctx.command.transform((editor) => {
    for (const spec of CLI_COMMANDS) {
      editor.add(buildCliCommand(ctx, options, spec));
    }
    editor.add(buildObserveCommand(ctx, observer));
    editor.add(buildBoardCommand(ctx, options, board));
    editor.add(buildEvolveCommand(ctx, options, evolveState));
    for (const alias of EVOLVE_ALIASES) editor.add(buildEvolveAliasCommand(ctx, options, alias, evolveState));
    if (review) editor.add(buildSkillReviewCommand(ctx, review));
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

// lib/review.js owns the gate, lock, and headless session; this command
// is just the manual trigger (review.run always forces, ignoring cadence
// and cooldown, same as a human typing /instinct-observe bypasses the
// observer's own gates) plus a read-only status view.
function buildSkillReviewCommand(ctx, review) {
  return {
    name: "skill-review",
    description: "Run the task-observer backlog review now in a headless session; `status` shows whether one is due or running.",
    async execute({ sessionID, prompt }) {
      const argvText = prompt?.text ?? "";
      if (tokenizeArgv(argvText)[0] === "status") {
        try {
          const gate = await review.status();
          await postResult(ctx, sessionID, formatReviewStatus(gate));
        } catch (error) {
          await postResult(ctx, sessionID, describeError(error));
        }
        return;
      }
      try {
        // review.run posts its own synthetic reply (started or not
        // started, with a reason), so there is nothing further to post
        // here on success; a thrown error never reaches that reply, hence
        // the catch posting the error itself.
        await review.run({ force: true, sessionID });
      } catch (error) {
        await postResult(ctx, sessionID, describeError(error));
      }
    },
  };
}

function formatReviewStatus(gate) {
  const lines = [`open: ${gate.open}`, `last review: ${gate.lastReview ?? "never"}`, `due: ${gate.due ? "yes" : "no"} (${gate.reason})`];
  if (gate.sessionID) lines.push(`in-flight session: ${gate.sessionID}`);
  return lines.join("\n");
}

// /evolve: a single dispatcher (lib/evolve-command.js's runEvolve) for
// the dashboard, one candidate's detail, install, reject, archive, an
// on-demand "now" (evolveStep + pruneCandidatesStep), and the
// deterministic cluster preview (lib/evolve-preview.js) that used to be
// the bare command's only mode. See lib/evolve-command.js's own header
// comment for the full grammar.
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

// Each of these five pre-0.9 commands stays registered for one release,
// translating its own old argv shape directly into the structured
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

// `resume: true`: a slash command is a direct user action, typed on its
// own turn, and the user is waiting right there for the reply, so it
// should surface immediately rather than sit queued until the next turn.
// lib/observer.js's own synthetic posting (a background run's summary,
// which nobody necessarily typed anything to trigger) keeps `resume: false`
// instead: forcing a resume there would interrupt whatever the session is
// doing on its own schedule, for a message nobody is sitting on.
//
// Long output (most commonly /instinct-status against a project with many
// instincts, or /instinct-projects against many known projects) used to
// be posted as one oversized synthetic message, which the host silently
// cuts off mid-entry rather than rejecting outright. No cap is documented
// for ctx.session.synthetic's own text field, so SYNTHETIC_MESSAGE_CAP is
// a conservative assumption; text under it is posted exactly as before
// (one message, no "(part N of M)" prefix). Text over it is split at
// instinct-cli.py's own entry boundaries (splitForSyntheticMessage below)
// and posted as several consecutive messages instead, each labelled
// "(part N of M)" so a reader can tell the reply continues. Each part's
// chat row (the OpenCode 2 TUI only ever shows a synthetic notice's
// `description`, never its `text`) carries that same part label plus the
// part's own content via noticeDescription, so a long reply is still
// readable without opening the transcript.
export const SYNTHETIC_MESSAGE_CAP = 12000;
// instinct-cli.py's own per-entry confidence bar (`_confidence_bar`,
// e.g. "████████░░") always opens that entry's first line; a blank line
// immediately before one of those (optionally indented) marks a safe
// place to split without ever cutting an entry's own lines apart.
const ENTRY_BOUNDARY = /\n\n(?=[ \t]*[\u2588\u2591]+)/;

// Pure, exported for smoke-test.mjs: splits `text` into the fewest
// messages that each fit within `cap`, cutting only at ENTRY_BOUNDARY
// (never mid-entry). When no such boundary exists at all (plain output
// with no bar-style entries), or a single entry is itself bigger than
// `cap`, that chunk is kept whole rather than cut at an arbitrary
// character offset.
export function splitForSyntheticMessage(text, cap = SYNTHETIC_MESSAGE_CAP) {
  if (typeof text !== "string" || text.length <= cap) return [text];
  const chunks = text.split(ENTRY_BOUNDARY);
  if (chunks.length <= 1) return [text];

  const messages = [];
  let current = chunks[0];
  for (let i = 1; i < chunks.length; i++) {
    const candidate = `${current}\n\n${chunks[i]}`;
    if (candidate.length > cap && current.length > 0) {
      messages.push(current);
      current = chunks[i];
    } else {
      current = candidate;
    }
  }
  messages.push(current);
  return messages;
}

// `cap` is a test seam only (smoke-test.mjs overrides it to exercise
// splitting without needing a many-KB fixture); every real call site uses
// the default SYNTHETIC_MESSAGE_CAP.
export async function postResult(ctx, sessionID, text, cap = SYNTHETIC_MESSAGE_CAP) {
  const parts = splitForSyntheticMessage(text, cap);
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts.length > 1 ? `(part ${i + 1} of ${parts.length})\n` : "";
    try {
      await ctx.session.synthetic({
        sessionID,
        text: `${prefix}\`\`\`\n${parts[i]}\n\`\`\``,
        description: noticeDescription(`${prefix}${parts[i]}`),
        delivery: "queue",
        resume: true,
      });
    } catch (error) {
      console.warn(`[${PKG_NAME}] failed to post command result`, error);
    }
  }
}
