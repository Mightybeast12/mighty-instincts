// The /evolve dispatcher: grammar parsing (parseEvolveArgs,
// EVOLVE_VERBS) and dispatch (runEvolve, runEvolveParsed,
// createEvolveState), used by lib/commands.js to register the /evolve
// command and its deprecated aliases. See the USAGE constant below for
// the grammar itself.
//
// Token order is free (`/evolve install 2` == `/evolve 2 install`): a
// bare digit is a pick index, an EVOLVE_VERBS word is the verb, and the
// first remaining token is the pick id. `reject` is the one exception:
// every token after it is taken verbatim as the reason, however it
// looks, so a reason mentioning a number or another verb's name is
// never misread as part of the grammar itself.
import { tokenizeArgv } from "./cli.js";
import { resolveProject } from "./project.js";
import { EVOLVE_INTERVAL_MS, appendMaintenanceLog, evolveStep, pruneCandidatesStep, readMaintenanceSummary, resolveUnusedDays } from "./maintain.js";
import { buildEvolveClusters, DEFAULT_PREVIEW_LIMIT, formatEvolvePreview } from "./evolve-preview.js";
import { relativeTime } from "./relative-time.js";
import { isUsageBucketEmpty, readUsage } from "./usage.js";
import { describeError } from "./util.js";
import {
  candidateCounts,
  deleteStrayDrafts,
  findUnusedInstalled,
  hashContent,
  installCandidateArtifact,
  installPathFor,
  listStrayDrafts,
  loadCandidates,
  numberCandidates,
  resolveEvolveTargets,
  resolveRuleFile,
  scanHandWrittenAssets,
  uninstallCandidateArtifact,
  usageBucketForKind,
  writeCandidate,
} from "./candidates.js";

// Every recognised verb token, spelled once and shared by the parser
// (VERBS below) and lib/commands.js's own deprecated alias translators,
// so the two can never drift on how a verb is spelled.
export const EVOLVE_VERBS = Object.freeze({
  INSTALL: "install",
  REJECT: "reject",
  ARCHIVE: "archive",
  NOW: "now",
  CLUSTERS: "clusters",
  PURGE: "purge",
});
const VERBS = new Set(Object.values(EVOLVE_VERBS));

const USAGE = [
  "Usage:",
  "/evolve                      dashboard (default)",
  "/evolve <n|id>               detail of one candidate + next-step line",
  "/evolve <n|id> install       writes it (the verb replaces --yes)",
  "/evolve <n|id> reject [why]  proposed only; remaining tokens are the reason",
  "/evolve <n|id> archive       any non-archived candidate",
  "/evolve now                  runs evolveStep + pruneCandidatesStep immediately",
  "/evolve clusters [N]         today's cluster preview; --limit N also accepted",
  "/evolve purge                deletes the drafts /evolve does not list (lists them first)",
].join("\n");


// install, archive, and reject all operate on exactly one candidate;
// shared between parseEvolveArgs (text) and runEvolveParsed (an
// already-structured object, used by lib/commands.js's own aliases).
function missingPick(verb, pick) {
  return (verb === EVOLVE_VERBS.INSTALL || verb === EVOLVE_VERBS.ARCHIVE || verb === EVOLVE_VERBS.REJECT) && !pick;
}

function extractPick(tokens) {
  let value;
  const extra = [];
  for (const token of tokens) {
    if (value === undefined) {
      value = /^\d+$/.test(token) ? { type: "index", value: Number.parseInt(token, 10) } : { type: "id", value: token };
    } else {
      extra.push(token);
    }
  }
  return { value, extra };
}

// Pure: tokens -> { verb, pick, limit, reason } or { error: USAGE }.
// Exported for direct unit testing, independent of any command or
// filesystem state. The verb is identified first, from the raw tokens;
// `--limit N` is only ever stripped out as a flag once that verb is
// confirmed to be "clusters" (the one verb that reads one). Everywhere
// else, including a reject reason, "--limit" is left as a completely
// ordinary token rather than a flag that could be mistaken for one.
export function parseEvolveArgs(tokens) {
  const rejectIndex = tokens.indexOf(EVOLVE_VERBS.REJECT);
  if (rejectIndex !== -1) {
    const before = tokens.slice(0, rejectIndex);
    const after = tokens.slice(rejectIndex + 1);
    if (before.some((token) => VERBS.has(token))) return { error: USAGE };
    const { value: pick, extra } = extractPick(before);
    if (extra.length > 0 || missingPick(EVOLVE_VERBS.REJECT, pick)) return { error: USAGE };
    return { verb: EVOLVE_VERBS.REJECT, pick, reason: after.length > 0 ? after.join(" ") : undefined };
  }

  let verb;
  const rest = [];
  for (const token of tokens) {
    if (VERBS.has(token)) {
      if (verb !== undefined && verb !== token) return { error: USAGE };
      verb = token;
      continue;
    }
    rest.push(token);
  }

  let limit;
  let pickTokens = rest;
  if (verb === EVOLVE_VERBS.CLUSTERS) {
    pickTokens = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--limit") {
        const parsedLimit = Number.parseInt(rest[i + 1], 10);
        if (Number.isFinite(parsedLimit) && parsedLimit >= 0) limit = parsedLimit;
        i += 1;
        continue;
      }
      pickTokens.push(rest[i]);
    }
  }

  const { value: pick, extra } = extractPick(pickTokens);
  if (extra.length > 0) return { error: USAGE };
  if (missingPick(verb, pick)) return { error: USAGE };
  if (verb === EVOLVE_VERBS.PURGE && pick) return { error: USAGE };
  return { verb, pick, limit, reason: undefined };
}

// ----------------------------------------------------------- numbering state

// Created once per registerCommands call (lib/commands.js), and shared
// by every /evolve command and alias that call registers, so the
// numbering baseline and the look-before-leap record live per plugin
// instance rather than as a module global every instance in the
// process would otherwise share. Keyed by project.id within that
// state, never by directory: two projects sharing the same install
// targets (lib/candidates.js's own cross-project protection) must never
// share a numbering baseline or a "just viewed" candidate either.
// lastNumbering remembers the ids, by position, that the *last*
// dashboard or by-number pick actually showed; lastDetailRendered
// remembers only the single most recently fully-rendered candidate
// (its id and its body's own hash), for install's look-before-leap
// below.
export function createEvolveState() {
  return { lastNumbering: new Map(), lastDetailRendered: new Map(), lastPurgeListed: new Map() };
}

function rememberNumbering(state, projectId, numbered) {
  state.lastNumbering.set(projectId, numbered.map((entry) => entry.candidate.fields.id));
}

function rememberDetailRendered(state, projectId, id, bodyHash) {
  state.lastDetailRendered.set(projectId, { id, bodyHash });
}

// Resolves a parsed pick against the current candidate set. An id pick
// is looked up directly (ids never go stale). An index pick is checked
// against whatever numbering was last shown for this project: if
// nothing has been shown yet, the current numbering is accepted
// outright; otherwise position `n` must still map to the exact id it
// mapped to last time, or the caller is told the list changed (stale:
// true) instead of silently acting on the wrong candidate. Either way,
// resolving an index pick refreshes the remembered numbering to what
// was just computed.
function resolvePick(state, project, candidates, pick) {
  const numbered = numberCandidates(candidates);
  if (pick.type === "id") {
    const candidate = candidates.find((c) => c.fields.id === pick.value) ?? null;
    if (!candidate) {
      return { notFound: true, message: `No candidate found with id '${pick.value}'. Run /evolve to see what is available.` };
    }
    return { candidate, numbered };
  }

  const remembered = state.lastNumbering.get(project.id);
  const entry = numbered.find((n) => n.index === pick.value);
  if (remembered) {
    const rememberedId = remembered[pick.value - 1];
    const currentId = entry?.candidate.fields.id;
    if (rememberedId !== currentId) {
      rememberNumbering(state, project.id, numbered);
      return { stale: true };
    }
  }
  rememberNumbering(state, project.id, numbered);
  if (!entry) return { notFound: true, message: `No candidate numbered ${pick.value}. Run /evolve to see the current list.` };
  return { candidate: entry.candidate, numbered };
}

async function staleDashboardText(state, ctx, project, options) {
  const dashboard = await buildDashboard(state, ctx, project, options);
  return `The list changed; here it is again:\n\n${dashboard}`;
}

// ------------------------------------------------------------- next-evolve eta

async function nextEvolveEtaLine(project) {
  const summary = await readMaintenanceSummary(project);
  if (!summary.lastEvolveAt) return "next automatic proposal run: not run yet";
  const etaMs = Date.parse(summary.lastEvolveAt) + EVOLVE_INTERVAL_MS;
  const deltaMs = etaMs - Date.now();
  if (deltaMs <= 0) return "next automatic proposal run: due now (waiting for the next maintenance sweep)";
  return `next automatic proposal run: in ${relativeTime(new Date(etaMs).toISOString())}`;
}

// ----------------------------------------------------------------- dashboard

async function buildDashboard(state, ctx, project, options) {
  const candidates = await loadCandidates(project.evolved_dir);
  const numbered = numberCandidates(candidates);
  rememberNumbering(state, project.id, numbered);
  const counts = candidateCounts(candidates);
  const usage = await readUsage(project.project_dir);
  const unusedDays = resolveUnusedDays(options);
  const unusedIds = new Set(findUnusedInstalled(candidates, usage, unusedDays).map((c) => c.fields.id));

  const lines = [`${candidates.length} candidate(s): ${counts.proposed} proposed, ${counts.installed} installed, ${counts.archived} archived.`];
  if (numbered.length > 0) lines.push("");
  for (const { index, candidate } of numbered) {
    const { id, kind, summary, members } = candidate.fields;
    if (candidate.fields.status === "proposed") {
      const age = candidate.fields.created ? relativeTime(candidate.fields.created) ?? "?" : "?";
      const memberCount = Array.isArray(members) ? members.length : 0;
      lines.push(`${index}. ${id} [${kind}] ${memberCount} habits, ${age}, ${summary ?? ""}`);
    } else {
      const age = candidate.fields.installed_at ? relativeTime(candidate.fields.installed_at) ?? "?" : "?";
      const bucket = usageBucketForKind(kind);
      const entry = bucket ? usage[bucket]?.[candidate.fields.suggested_name] : null;
      const uses = bucket ? String(Number(entry?.count) || 0) : "n/a";
      const unusedTag = unusedIds.has(id) ? " (unused)" : "";
      lines.push(`${index}. ${id} [${kind}] installed ${age}, ${uses} uses${unusedTag}`);
    }
  }
  if (counts.archived > 0) lines.push("", `archived: ${counts.archived}`);

  if (counts.proposed === 0) {
    const clusters = await buildEvolveClusters(project);
    lines.push("", formatEvolvePreview(clusters, { limit: DEFAULT_PREVIEW_LIMIT }), "", await nextEvolveEtaLine(project));
  }

  const targets = resolveEvolveTargets(options);
  const handWritten = (await scanHandWrittenAssets(targets, usage, unusedDays)).filter(
    (asset) => !isUsageBucketEmpty(usage, usageBucketForKind(asset.kind)),
  );
  if (handWritten.length > 0) {
    lines.push("", "unused (not generated):");
    for (const asset of handWritten) {
      lines.push(`  ${asset.kind} '${asset.name}' at ${asset.path} (hand-written, 0 uses in ${unusedDays}d, never removed automatically)`);
    }
  }

  lines.push("", "Next: /evolve <n> to read one, /evolve now to propose from today's clusters.");
  return lines.join("\n");
}

// -------------------------------------------------------------------- detail

// Shared by the bare `/evolve <n|id>` pick, by install's own
// look-before-leap render, and (through the evolve-show/evolve-list
// aliases) by every candidate status: kind, where it would install to
// (or already did), its members, and its full drafted body, so a human
// can actually read what they are about to approve before anything is
// written.
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

function installTargetPath(candidate, targets, project, ctx) {
  const { kind, suggested_name: suggestedName } = candidate.fields;
  return kind === "rule" ? resolveRuleFile(targets, project.root || ctx.location.directory) : installPathFor(kind, suggestedName, targets);
}

function nextStepLine(ctx, project, candidate, numbered, targets) {
  const status = candidate.fields.status;
  const entry = numbered.find((n) => n.candidate.fields.id === candidate.fields.id);
  const ref = entry ? entry.index : candidate.fields.id;
  if (status === "proposed") return `Next: /evolve ${ref} install | /evolve ${ref} reject [why]`;
  if (status === "installed") return `Next: /evolve ${ref} archive removes ${installTargetPath(candidate, targets, project, ctx)}`;
  const age = relativeTime(new Date(candidate.mtimeMs).toISOString()) ?? "?";
  const reason = candidate.fields.reason ?? "no reason given";
  return `Next: archived ${age} ago, reason: ${reason}`;
}

async function buildDetail(state, ctx, project, options, pick) {
  const candidates = await loadCandidates(project.evolved_dir);
  const resolved = resolvePick(state, project, candidates, pick);
  if (resolved.notFound) return resolved.message;
  if (resolved.stale) return await staleDashboardText(state, ctx, project, options);
  const { candidate, numbered } = resolved;
  rememberDetailRendered(state, project.id, candidate.fields.id, hashContent(candidate.body));
  const targets = resolveEvolveTargets(options);
  const detail = formatCandidateDetail(ctx, project, candidate, targets);
  return `${detail}\n\n${nextStepLine(ctx, project, candidate, numbered, targets)}`;
}

// -------------------------------------------------------------------- now

// `/evolve now`: runs evolveStep then pruneCandidatesStep immediately,
// the exact pair runMaintenance's own weekly gate would eventually run
// on its own, honouring `options.maintenance.dryRun` the same way that
// scheduled run does: when it is on, both steps only log what they
// would do and nothing is written, including the maintenance log
// itself (so the weekly gate is left untouched too). Otherwise, both
// steps' own log lines are collected first and written through
// appendMaintenanceLog only once every step has finished (the same
// order runMaintenance itself uses), so a crash mid-step never leaves
// a half-written log line. evolveStep always logs either "evolve:
// wrote cluster ..." (one per new candidate) or, when nothing new
// qualified, "evolve: checked, no new clusters" -- either way, at
// least one line here always matches EVOLVE_ATTEMPT_LINE, so writing
// these lines through also resets the weekly gate (readMaintenanceSummary's
// lastEvolveAt) exactly as if the scheduled run itself had just fired;
// no separate "reset the gate" code is needed.
async function runEvolveNow(project, options) {
  try {
    const dryRun = options?.maintenance?.dryRun === true;
    const lines = [];
    const log = (line) => lines.push(line);
    const { candidates } = await evolveStep(project, { dryRun, log });
    await pruneCandidatesStep(project, options, { dryRun, log });

    if (dryRun) {
      const proposed = lines.filter((line) => line.startsWith("evolve: would write cluster")).length;
      const refreshed = lines.filter((line) => line.startsWith("evolve: would update cluster")).length;
      return `Proposed ${proposed} new candidate(s), refreshed ${refreshed}: /evolve (dry run: nothing written)`;
    }

    for (const line of lines) await appendMaintenanceLog(project.project_dir, line);
    const refreshed = lines.filter((line) => line.startsWith("evolve: updated cluster")).length;
    return `Proposed ${candidates} new candidate(s), refreshed ${refreshed}: /evolve`;
  } catch (error) {
    return describeError(error);
  }
}

// ---------------------------------------------------------------- clusters

// `/evolve clusters [N]`: the deterministic preview (was the bare
// /evolve's own default before this dispatcher existed). A bare digit
// pick (parseEvolveArgs has no notion of "pick" for this verb, since
// there is no candidate to pick) is read as the positional N shorthand
// when no explicit --limit was given.
async function buildClustersPreview(project, parsed) {
  try {
    const clusters = await buildEvolveClusters(project);
    const limit = typeof parsed.limit === "number" ? parsed.limit : parsed.pick?.type === "index" ? parsed.pick.value : DEFAULT_PREVIEW_LIMIT;
    return formatEvolvePreview(clusters, { limit });
  } catch (error) {
    return describeError(error);
  }
}

// ------------------------------------------------------------------- install

async function markInstalled(project, candidate, { projectId, installedHash } = {}) {
  await writeCandidate(
    project.evolved_dir,
    { ...candidate.fields, status: "installed", installed_at: new Date().toISOString(), project_id: projectId ?? candidate.fields.project_id, installed_hash: installedHash },
    candidate.body,
  );
}

// Recomputes the numbering right after a write that can change it
// (install flips a candidate from the "proposed" group to the
// "installed" one, which usually changes its own index), and keeps the
// remembered numbering in sync with that fresh state so a command run
// immediately afterward in the same process is checked against reality,
// not the pre-write snapshot.
async function refreshedRef(state, project, id) {
  const freshNumbered = numberCandidates(await loadCandidates(project.evolved_dir));
  rememberNumbering(state, project.id, freshNumbered);
  const entry = freshNumbered.find((n) => n.candidate.fields.id === id);
  return entry ? entry.index : id;
}

function describeInstallRefusal(result) {
  if (result.reason === "symlink") return `Refused: ${result.path} is a symlink; install never follows or replaces one.`;
  return `Refused: ${result.path} already exists and was not written by mighty-instincts for this candidate.`;
}

// Calls lib/candidates.js's installCandidateArtifact for the actual
// write and its refusal checks, then records the result on the
// candidate itself and in the maintenance log. Called only once
// runInstall (below) has confirmed this candidate's own detail, with
// its exact current body, was actually rendered in this process first.
async function performInstall(state, ctx, project, options, candidate) {
  const { id, kind, suggested_name: suggestedName } = candidate.fields;
  const projectId = project.id;
  const targets = resolveEvolveTargets(options);
  const ruleProjectRoot = project.root || ctx.location.directory;

  const result = await installCandidateArtifact(candidate, targets, { projectId, ruleProjectRoot });
  if (result.blocked) return describeInstallRefusal(result);

  await markInstalled(project, candidate, { projectId, installedHash: result.hash });
  await appendMaintenanceLog(project.project_dir, `evolve: installed ${id} (${kind}) to ${result.path}`);
  const resultText =
    kind === "rule"
      ? `Appended a learned rule from candidate '${id}' to ${result.path}.`
      : `Installed ${kind} '${suggestedName}' from candidate '${id}' to ${result.path}.`;

  const ref = await refreshedRef(state, project, id);
  return `${resultText} Restart OpenCode to load it. Undo: /evolve ${ref} archive.`;
}

// Look-before-leap: `install` only ever writes when this exact
// candidate's own detail, with its exact current body, has already
// been rendered once in this process (lastDetailRendered, above). The
// first attempt (and any attempt where the candidate's body has
// changed since it was last shown, e.g. a weekly sweep or /evolve now
// rewrote its members in between) instead renders that detail itself
// and asks for the same command again, so install never writes a body
// the caller never actually saw.
async function runInstall(state, ctx, project, options, candidate, numbered) {
  const id = candidate.fields.id;
  if (candidate.fields.status !== "proposed") {
    return `Candidate '${id}' is already ${candidate.fields.status}; only a proposed candidate can be installed.`;
  }
  const bodyHash = hashContent(candidate.body);
  const seen = state.lastDetailRendered.get(project.id);
  if (!seen || seen.id !== id || seen.bodyHash !== bodyHash) {
    rememberDetailRendered(state, project.id, id, bodyHash);
    const targets = resolveEvolveTargets(options);
    const detail = formatCandidateDetail(ctx, project, candidate, targets);
    const entry = numbered.find((n) => n.candidate.fields.id === id);
    const ref = entry ? entry.index : id;
    return `${detail}\n\nRun /evolve ${ref} install again to install.`;
  }
  return await performInstall(state, ctx, project, options, candidate);
}

// ------------------------------------------------------------------- reject

async function runReject(project, candidate, reason) {
  const id = candidate.fields.id;
  if (candidate.fields.status === "archived") return `Candidate '${id}' is already archived.`;
  if (candidate.fields.status === "installed") {
    return `Candidate '${id}' is already installed; use /evolve ${id} archive to remove it instead.`;
  }
  const finalReason = reason || "no reason given";
  await writeCandidate(project.evolved_dir, { ...candidate.fields, status: "archived", reason: finalReason }, candidate.body);
  await appendMaintenanceLog(project.project_dir, `evolve: rejected ${id} (reason: ${finalReason})`);
  return `Archived candidate '${id}' (reason: ${finalReason}).`;
}

// ------------------------------------------------------------------ archive

function describeBlockedReason(reason) {
  if (reason === "symlink") return "it is a symlink, which install never follows or replaces";
  if (reason === "not-owned") return "it no longer carries this candidate's own marker (a different candidate, project, or a human may have replaced it)";
  if (reason === "edited") return "its content no longer matches what was actually installed (it has been hand-edited since)";
  return "its ownership could not be confirmed";
}

async function runArchive(ctx, project, options, candidate) {
  const id = candidate.fields.id;
  if (candidate.fields.status === "archived") return `Candidate '${id}' is already archived.`;

  let note = "";
  if (candidate.fields.status === "installed") {
    const targets = resolveEvolveTargets(options);
    const result = await uninstallCandidateArtifact(candidate, targets, { ruleProjectRoot: project.root || ctx.location.directory });
    if (result.blocked) note = ` ${result.path} was left in place: ${describeBlockedReason(result.reason)}.`;
    else if (result.removed) note = ` Removed ${result.path}.`;
  }
  await writeCandidate(project.evolved_dir, { ...candidate.fields, status: "archived" }, candidate.body);
  await appendMaintenanceLog(project.project_dir, `evolve: archived ${id}${note}`);
  return `Archived candidate '${id}'.${note}`;
}

// -------------------------------------------------------------------- purge

const PURGE_LIST_LIMIT = 60;

// `/evolve purge`: the same look-before-leap as install. The first call
// lists the stray drafts (lib/candidates.js listStrayDrafts) and deletes
// nothing; a second call deletes them only when the listing is exactly
// the one shown last, and shows it again when anything changed in
// between. Candidate files of every status are kept.
async function runPurge(state, project) {
  const dir = project.evolved_dir;
  const listing = await listStrayDrafts(dir);
  if (listing.length === 0) {
    state.lastPurgeListed.delete(project.id);
    return `No drafts to purge under ${dir}; candidates of every status are kept.`;
  }
  const listingHash = hashContent(listing.join("\n"));
  if (state.lastPurgeListed.get(project.id) !== listingHash) {
    state.lastPurgeListed.set(project.id, listingHash);
    const shown = listing.slice(0, PURGE_LIST_LIMIT).map((relPath) => `  ${relPath}`);
    if (listing.length > PURGE_LIST_LIMIT) shown.push(`  ... and ${listing.length - PURGE_LIST_LIMIT} more`);
    return [
      `${listing.length} draft file(s) under ${dir} that /evolve does not list (the CLI's --generate output and stray files):`,
      ...shown,
      "",
      `Run /evolve purge again to delete these ${listing.length} draft file(s). Candidates of every status are kept.`,
    ].join("\n");
  }
  state.lastPurgeListed.delete(project.id);
  const deleted = await deleteStrayDrafts(dir, listing);
  await appendMaintenanceLog(project.project_dir, `evolve: purged ${deleted} draft file(s) /evolve does not list`);
  return `Deleted ${deleted} draft file(s) under ${dir}. Candidates of every status are kept.`;
}

// --------------------------------------------------------------- dispatcher

// Parses `argvText` and returns the full reply text for the /evolve
// command. Never throws: any failure reaching here is reported as
// plain text, the same contract every other command in
// lib/commands.js already follows. `state` is one createEvolveState()
// result, owned by whichever registerCommands call registered this
// command.
export async function runEvolve(ctx, options, argvText, state) {
  const parsed = parseEvolveArgs(tokenizeArgv(argvText));
  if (parsed.error) return parsed.error;
  return await runEvolveParsed(ctx, options, parsed, state);
}

// Dispatches an already-parsed `{ verb, pick, limit, reason }` (the
// exact shape parseEvolveArgs returns, minus `error`) straight to the
// matching handler, with no text tokenizing or re-parsing involved at
// all. Used by runEvolve above, and directly by lib/commands.js's own
// deprecated aliases, so a reject reason (free text that may contain
// anything, including something that looks like a flag or a verb) is
// carried through as one opaque value rather than risking a second
// round of tokenizing misreading it.
export async function runEvolveParsed(ctx, options, parsed, state) {
  if (missingPick(parsed.verb, parsed.pick)) return USAGE;
  try {
    const project = await resolveProject(ctx, options);

    if (parsed.verb === EVOLVE_VERBS.NOW) return await runEvolveNow(project, options);
    if (parsed.verb === EVOLVE_VERBS.PURGE) return await runPurge(state, project);
    if (parsed.verb === EVOLVE_VERBS.CLUSTERS) return await buildClustersPreview(project, parsed);
    if (!parsed.verb) {
      return parsed.pick ? await buildDetail(state, ctx, project, options, parsed.pick) : await buildDashboard(state, ctx, project, options);
    }

    const candidates = await loadCandidates(project.evolved_dir);
    const resolved = resolvePick(state, project, candidates, parsed.pick);
    if (resolved.notFound) return resolved.message;
    if (resolved.stale) return await staleDashboardText(state, ctx, project, options);
    const { candidate, numbered } = resolved;

    if (parsed.verb === EVOLVE_VERBS.INSTALL) return await runInstall(state, ctx, project, options, candidate, numbered);
    if (parsed.verb === EVOLVE_VERBS.REJECT) return await runReject(project, candidate, parsed.reason);
    return await runArchive(ctx, project, options, candidate);
  } catch (error) {
    return describeError(error);
  }
}
