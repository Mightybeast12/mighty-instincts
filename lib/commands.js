// Slash commands. Most run instinct-cli.py directly (through lib/cli.js)
// and post the result as a synthetic message; the exceptions are /board
// (lib/board-format.js, reads board-state.json instead), /evolve without
// --generate (lib/evolve-preview.js, a deterministic JS preview;
// --generate still delegates to instinct-cli.py), and the four
// /evolve-install//-reject//-archive//-list candidate-lifecycle commands
// (lib/candidates.js, lib/usage.js: entirely separate from
// instinct-cli.py's own evolve output). None of them start a model turn,
// so there is nothing here that calls ctx.session.prompt.
import fs from "node:fs/promises";
import path from "node:path";
import { runCli, tokenizeArgv } from "./cli.js";
import { formatBoardSummary } from "./board-format.js";
import { buildEvolveClusters, DEFAULT_PREVIEW_LIMIT, formatEvolvePreview } from "./evolve-preview.js";
import { resolveProject } from "./project.js";
import { appendMaintenanceLog } from "./maintain.js";
import { relativeTime } from "./relative-time.js";
import { readUsage } from "./usage.js";
import {
  appendRuleBlock,
  atomicWriteAgentsFile,
  candidateCounts,
  findCandidateById,
  findUnusedInstalled,
  hashContent,
  injectGeneratedMarkers,
  installPathFor,
  isGeneratedByUs,
  loadCandidates,
  resolveEvolveTargets,
  resolveRuleFile,
  scanHandWrittenAssets,
  uninstallCandidateArtifact,
  usageBucketForKind,
  writeCandidate,
} from "./candidates.js";
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
    editor.add(buildEvolveInstallCommand(ctx, options));
    editor.add(buildEvolveShowCommand(ctx, options));
    editor.add(buildEvolveRejectCommand(ctx, options));
    editor.add(buildEvolveArchiveCommand(ctx, options));
    editor.add(buildEvolveListCommand(ctx, options));
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

// -------------------------------------------------------- candidate lifecycle

// /evolve-install <id> [--yes]: a two-step confirm. Without --yes this
// only previews (the same detail /evolve-show renders: kind, target
// path, members, full body) and stops, telling the caller to re-run
// with --yes; nothing is written until that explicit second step. Turns
// a *proposed* candidate (lib/maintain.js's evolveStep writes these,
// never installs them) into a real skill/command/agent file, or appends
// a rule's 1-3 line snippet to the project's own AGENTS.md. Refuses
// outright when the target already exists and was not written by this
// plugin *for this exact candidate* (isGeneratedByUs, now an exact
// candidate_id+project_id match rather than a marker-text substring
// search), or when the target is a symlink.
function buildEvolveInstallCommand(ctx, options) {
  return {
    name: "evolve-install",
    description: "Preview a proposed candidate; add --yes to actually install it as a skill, command, agent, or AGENTS.md rule.",
    async execute({ sessionID, prompt }) {
      const text = await installCandidate(ctx, options, prompt?.text ?? "");
      await postResult(ctx, sessionID, text);
    },
  };
}

async function installCandidate(ctx, options, argvText) {
  const tokens = tokenizeArgv(argvText);
  const id = tokens.find((token) => !token.startsWith("--"));
  if (!id) return "Usage: /evolve-install <id> --yes (see /evolve-list for ids; without --yes this only previews).";
  const confirmed = tokens.includes("--yes");
  try {
    const project = await resolveProject(ctx, options);
    const candidate = await findCandidateById(project.evolved_dir, id);
    if (!candidate) return `No candidate found with id '${id}'. Run /evolve-list to see what is available.`;
    if (candidate.fields.status !== "proposed") {
      return `Candidate '${id}' is already ${candidate.fields.status}; only a proposed candidate can be installed.`;
    }

    const targets = resolveEvolveTargets(options);
    if (!confirmed) {
      const detail = formatCandidateDetail(ctx, project, candidate, targets);
      return `${detail}\n\nRe-run with --yes to install.`;
    }

    const { kind, suggested_name: suggestedName, members } = candidate.fields;
    const projectId = project.id;

    if (kind === "rule") {
      const ruleFile = resolveRuleFile(targets, project.root || ctx.location.directory);
      // Unlike the skill/command/agent branch below, a symlinked
      // AGENTS.md is written through rather than refused: it is the
      // project's own shared file, which may legitimately be a symlink
      // (e.g. a monorepo's root AGENTS.md pointing at a shared one), and
      // atomicWriteAgentsFile resolves it to its real file before
      // writing, in that real file's own directory, never replacing the
      // symlink itself.
      const existing = await readFileOrEmpty(ruleFile);
      const updated = appendRuleBlock(existing, candidate.fields.id, projectId, candidate.body);
      const installedHash = hashContent(candidate.body.trim());
      await fs.mkdir(path.dirname(ruleFile), { recursive: true });
      await atomicWriteAgentsFile(ruleFile, updated);
      await markInstalled(project, candidate, { projectId, installedHash });
      await appendMaintenanceLog(project.project_dir, `evolve-install: installed ${id} (rule) to ${ruleFile}`);
      return `Appended a learned rule from candidate '${id}' to ${ruleFile}.\n\nRestart OpenCode to load it.`;
    }

    const targetPath = installPathFor(kind, suggestedName, targets);
    let lstat;
    try {
      lstat = await fs.lstat(targetPath);
    } catch {
      lstat = null;
    }
    if (lstat?.isSymbolicLink()) {
      return `Refused: ${targetPath} is a symlink; install never follows or replaces one.`;
    }
    const existing = lstat ? await readFileOrNull(targetPath) : null;
    if (existing !== null && !isGeneratedByUs(existing, id, projectId)) {
      return `Refused: ${targetPath} already exists and was not written by mighty-instincts for this candidate.`;
    }
    const content = injectGeneratedMarkers(candidate.body, { candidateId: id, projectId, members });
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    // `wx` when nothing was there a moment ago: a concurrent writer that
    // creates the file between the lstat above and this write loses the
    // race outright (ENOENT) rather than being silently overwritten.
    await fs.writeFile(targetPath, content, { encoding: "utf8", flag: lstat ? "w" : "wx" });
    await markInstalled(project, candidate, { projectId, installedHash: hashContent(content) });
    await appendMaintenanceLog(project.project_dir, `evolve-install: installed ${id} (${kind}) to ${targetPath}`);
    return `Installed ${kind} '${suggestedName}' from candidate '${id}' to ${targetPath}.\n\nRestart OpenCode to load it.`;
  } catch (error) {
    return describeError(error);
  }
}

async function markInstalled(project, candidate, { projectId, installedHash } = {}) {
  await writeCandidate(
    project.evolved_dir,
    { ...candidate.fields, status: "installed", installed_at: new Date().toISOString(), project_id: projectId ?? candidate.fields.project_id, installed_hash: installedHash },
    candidate.body,
  );
}

async function readFileOrNull(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function readFileOrEmpty(file) {
  return (await readFileOrNull(file)) ?? "";
}

// Shared by the /evolve-install preview (no --yes), /evolve-show, and
// /evolve-list <id>: kind, where it would install to (or already did),
// its members, and its full drafted body, so a human can actually read
// what they are about to approve before --yes writes anything.
function formatCandidateDetail(ctx, project, candidate, targets) {
  const { id, kind, status, suggested_name: suggestedName, members, summary } = candidate.fields;
  const target = kind === "rule" ? resolveRuleFile(targets, project.root || ctx.location.directory) : installPathFor(kind, suggestedName, targets);
  return [
    `id: ${id}`,
    `kind: ${kind}`,
    `status: ${status}`,
    `target: ${target}`,
    `members (${members.length}): ${members.join(", ")}`,
    `summary: ${summary ?? ""}`,
    "",
    "--- body ---",
    candidate.body,
  ].join("\n");
}

// /evolve-show <id>: a read-only alias for the same detail view
// /evolve-install's own preview (without --yes) shows, usable on any
// status (proposed, installed, or archived), for whenever a human wants
// to inspect a candidate without touching its install state at all.
function buildEvolveShowCommand(ctx, options) {
  return {
    name: "evolve-show",
    description: "Show one candidate's kind, target path, members, and full drafted body. Never installs or changes anything.",
    async execute({ sessionID, prompt }) {
      const text = await showCandidate(ctx, options, prompt?.text ?? "");
      await postResult(ctx, sessionID, text);
    },
  };
}

async function showCandidate(ctx, options, argvText) {
  const id = tokenizeArgv(argvText)[0];
  if (!id) return "Usage: /evolve-show <id> (see /evolve-list for ids).";
  try {
    const project = await resolveProject(ctx, options);
    const candidate = await findCandidateById(project.evolved_dir, id);
    if (!candidate) return `No candidate found with id '${id}'. Run /evolve-list to see what is available.`;
    const targets = resolveEvolveTargets(options);
    return formatCandidateDetail(ctx, project, candidate, targets);
  } catch (error) {
    return describeError(error);
  }
}

// /evolve-reject <id> [reason]: archives a *proposed* candidate without
// ever writing anything outside evolved/; the reason (free text, every
// remaining token) is kept on the candidate itself so /evolve-list can
// show why it was turned down. An already-installed candidate is
// pointed at /evolve-archive instead, since rejecting it would leave the
// real file it installed behind with no corresponding record.
function buildEvolveRejectCommand(ctx, options) {
  return {
    name: "evolve-reject",
    description: "Archive a proposed candidate without installing it, optionally with a reason.",
    async execute({ sessionID, prompt }) {
      const text = await rejectCandidate(ctx, options, prompt?.text ?? "");
      await postResult(ctx, sessionID, text);
    },
  };
}

async function rejectCandidate(ctx, options, argvText) {
  const tokens = tokenizeArgv(argvText);
  const id = tokens[0];
  if (!id) return "Usage: /evolve-reject <id> [reason].";
  const reason = tokens.slice(1).join(" ") || "no reason given";
  try {
    const project = await resolveProject(ctx, options);
    const candidate = await findCandidateById(project.evolved_dir, id);
    if (!candidate) return `No candidate found with id '${id}'.`;
    if (candidate.fields.status === "archived") return `Candidate '${id}' is already archived.`;
    if (candidate.fields.status === "installed") {
      return `Candidate '${id}' is already installed; use /evolve-archive to remove it instead.`;
    }
    await writeCandidate(project.evolved_dir, { ...candidate.fields, status: "archived", reason }, candidate.body);
    await appendMaintenanceLog(project.project_dir, `evolve-reject: archived ${id} (reason: ${reason})`);
    return `Archived candidate '${id}' (reason: ${reason}).`;
  } catch (error) {
    return describeError(error);
  }
}

// /evolve-archive <id>: archives any non-archived candidate. For an
// installed one, also removes the real file (or AGENTS.md snippet) it
// wrote, but only when uninstallCandidateArtifact (lib/candidates.js)
// confirms it still matches both who installed it (candidate_id +
// project_id) and what was actually installed (installed_hash); a
// symlinked, hand-edited, or otherwise-owned file is left in place with
// a note explaining why instead of being deleted.
function buildEvolveArchiveCommand(ctx, options) {
  return {
    name: "evolve-archive",
    description: "Archive a candidate, removing its installed file (or AGENTS.md snippet) only if we can still prove we own it unchanged.",
    async execute({ sessionID, prompt }) {
      const text = await archiveCandidate(ctx, options, prompt?.text ?? "");
      await postResult(ctx, sessionID, text);
    },
  };
}

function describeBlockedReason(reason) {
  if (reason === "symlink") return "it is a symlink, which install never follows or replaces";
  if (reason === "not-owned") return "it no longer carries this candidate's own marker (a different candidate, project, or a human may have replaced it)";
  if (reason === "edited") return "its content no longer matches what was actually installed (it has been hand-edited since)";
  return "its ownership could not be confirmed";
}

async function archiveCandidate(ctx, options, argvText) {
  const id = tokenizeArgv(argvText)[0];
  if (!id) return "Usage: /evolve-archive <id>.";
  try {
    const project = await resolveProject(ctx, options);
    const candidate = await findCandidateById(project.evolved_dir, id);
    if (!candidate) return `No candidate found with id '${id}'.`;
    if (candidate.fields.status === "archived") return `Candidate '${id}' is already archived.`;

    let note = "";
    if (candidate.fields.status === "installed") {
      const targets = resolveEvolveTargets(options);
      const result = await uninstallCandidateArtifact(candidate, targets, { ruleProjectRoot: project.root || ctx.location.directory });
      if (result.blocked) note = ` ${result.path} was left in place: ${describeBlockedReason(result.reason)}.`;
      else if (result.removed) note = ` Removed ${result.path}.`;
    }
    await writeCandidate(project.evolved_dir, { ...candidate.fields, status: "archived" }, candidate.body);
    await appendMaintenanceLog(project.project_dir, `evolve-archive: archived ${id}${note}`);
    return `Archived candidate '${id}'.${note}`;
  } catch (error) {
    return describeError(error);
  }
}

// /evolve-list [id]: with an id, the same single-candidate detail
// /evolve-show renders; without one, every candidate (any status) with
// its kind, member count, usage (read from usage.json by suggested_name;
// "n/a" for a rule candidate, which has no runtime usage signal), and
// age, plus which installed candidates look unused and, separately,
// which hand-written (never-generated-by-us) skills/commands/agents
// also look unused; see README's "From habits to skills" section for
// what each column means.
function buildEvolveListCommand(ctx, options) {
  return {
    name: "evolve-list",
    description: "List evolve candidates (proposed/installed/archived), or give an id for that one candidate's full detail.",
    async execute({ sessionID, prompt }) {
      const argvText = prompt?.text ?? "";
      const id = tokenizeArgv(argvText)[0];
      const text = id ? await showCandidate(ctx, options, argvText) : await renderEvolveList(ctx, options);
      await postResult(ctx, sessionID, text);
    },
  };
}

async function renderEvolveList(ctx, options) {
  try {
    const project = await resolveProject(ctx, options);
    const candidates = await loadCandidates(project.evolved_dir);
    const usage = await readUsage(project.project_dir);
    const unusedDays = Number(options?.prune?.unusedDays) || 30;
    const targets = resolveEvolveTargets(options);

    const lines = [];
    if (candidates.length === 0) {
      lines.push("No candidates yet. The weekly evolve step proposes them from clusters of related habits.");
    } else {
      const counts = candidateCounts(candidates);
      lines.push(`${candidates.length} candidate(s): ${counts.proposed} proposed, ${counts.installed} installed, ${counts.archived} archived.`, "");
      const sorted = candidates.slice().sort((a, b) => (a.fields.created ?? "").localeCompare(b.fields.created ?? ""));
      for (const candidate of sorted) {
        lines.push(formatCandidateLine(candidate, usage));
      }
    }

    const unused = findUnusedInstalled(candidates, usage, unusedDays);
    if (unused.length > 0) {
      lines.push("", `${unused.length} installed candidate(s) look unused (0 uses in ${unusedDays}d): ${unused.map((c) => c.fields.id).join(", ")}. See /evolve-archive to remove them.`);
    }

    const handWritten = await scanHandWrittenAssets(targets, usage, unusedDays);
    if (handWritten.length > 0) {
      lines.push("", "unused (not generated):");
      for (const asset of handWritten) {
        lines.push(`  ${asset.kind} '${asset.name}' at ${asset.path} (hand-written, 0 uses in ${unusedDays}d, never removed automatically)`);
      }
    }

    return lines.join("\n");
  } catch (error) {
    return describeError(error);
  }
}

function formatCandidateLine(candidate, usage) {
  const bucket = usageBucketForKind(candidate.fields.kind);
  const entry = bucket ? usage[bucket]?.[candidate.fields.suggested_name] : null;
  const uses = bucket ? String(Number(entry?.count) || 0) : "n/a";
  const age = candidate.fields.created ? relativeTime(candidate.fields.created) ?? "?" : "?";
  const members = Array.isArray(candidate.fields.members) ? candidate.fields.members.length : 0;
  return `${candidate.fields.id} [${candidate.fields.kind}] status=${candidate.fields.status} members=${members} uses=${uses} age=${age}`;
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
// "(part N of M)" so a reader can tell the reply continues.
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
        description: PKG_NAME,
        delivery: "queue",
        resume: true,
      });
    } catch (error) {
      console.warn(`[${PKG_NAME}] failed to post command result`, error);
    }
  }
}
