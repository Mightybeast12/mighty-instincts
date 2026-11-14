// Maintenance loop: promote / prune / decay / dedupe / evolve / repair /
// cleanupProjects for the instinct stores this plugin writes. Runs after
// every observer run
// and at least every `maintenance.intervalHours` (lib/plugin.js wires the
// controller below alongside lib/board.js's own timer), independent of
// whether `observer.enabled` is on at all. Every step is a small, pure-ish,
// directly-callable async function (no ctx needed beyond already-resolved
// `project`/`options`), so smoke-test.mjs can exercise each one against a
// temp data dir without a real plugin host.
//
// Everything this module writes or deletes is logged, one line per event,
// to `<project.project_dir>/maintenance.log` as `<iso> <step>: <detail>`.
// That log is also this module's own state: lib/board.js's "kept tidy" row
// and this module's own weekly evolve gate both come from re-reading it
// (readMaintenanceSummary below), the same pattern lib/board.js already
// uses for observer.log, rather than a second JSON state file that could
// drift from what actually happened.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveHomunculusDir } from "./homunculus-dir.js";
import { siblingInstinctsDir } from "./project.js";
import { parseFrontmatterBlocks, stripFrontmatter, uniqueSuffix, writeInstinct } from "./store.js";
import { significantWordOverlapRatio } from "./inject.js";
import {
  buildCandidateId,
  buildCandidateSummary,
  buildSuggestedName,
  findCandidateById,
  findUnusedInstalled,
  loadCandidates,
  memberOverlapRatio,
  renderCandidateBody,
  resolveEvolveTargets,
  selectCandidateKind,
  uninstallCandidateArtifact,
  usageBucketForKind,
  writeCandidate,
} from "./candidates.js";
import { isUsageBucketEmpty, readUsage } from "./usage.js";
import { PKG_NAME } from "./pkg.js";
import { describeError } from "./util.js";

export const MAINTENANCE_DEFAULTS = {
  intervalHours: 24,
  dryRun: false,
  promote: true,
  prune: true,
  decay: true,
  dedupe: true,
  evolve: true,
  repair: true,
  cleanupProjects: true,
  cleanTmp: true,
};

const INSTINCT_FILE_PATTERN = /\.(md|ya?ml)$/i;
const MAINTENANCE_LOG_FILE = "maintenance.log";
const MAINTENANCE_POLL_MS = 15 * 60000;

// Mirrors vendor/ecc/instinct-cli.py:128-129's PROMOTE_CONFIDENCE_THRESHOLD
// (0.8) and PROMOTE_MIN_PROJECTS (2): an instinct auto-promotes once it is
// confident enough and seen in enough distinct project stores. Extended
// here (the CLI itself only groups by exact id, see _find_cross_project_instincts)
// with a trigger-overlap match, so two projects that learned "the same"
// instinct under different ids still count as one candidate.
const PROMOTE_CONFIDENCE_THRESHOLD = 0.8;
const PROMOTE_MIN_PROJECTS = 2;
const PROMOTE_TRIGGER_OVERLAP_THRESHOLD = 0.7;
// Second qualification path (0.8.2): a single instinct this confident
// and this proven promotes on its own, with no cross-project
// corroboration required at all.
const PROMOTE_FIRED_CONFIDENCE_THRESHOLD = 0.9;
const PROMOTE_FIRED_THRESHOLD = 3;

// Mirrors vendor/ecc/instinct-cli.py:133,135's PENDING_TTL_DAYS (30) and
// PENDING_EXPIRY_WARNING_DAYS (7).
const PENDING_TTL_DAYS = 30;
const PENDING_EXPIRY_WARNING_DAYS = 7;

const DECAY_GRACE_DAYS = 30;
const DECAY_STEP = 0.05;
const DECAY_WEEK_MS = 7 * 86400000;
const DECAY_ARCHIVE_THRESHOLD = 0.4;

const DEDUPE_OVERLAP_THRESHOLD = 0.6;
// A lower bar for two instincts that also share a domain: trusting the
// model's own domain tag as a second, cheap signal that they are "the
// same thing" lets a looser trigger/summary-overlap match still count as
// a duplicate, instead of requiring the full DEDUPE_OVERLAP_THRESHOLD on
// its own.
const DEDUPE_SAME_DOMAIN_OVERLAP_THRESHOLD = 0.45;
// A trigger or summary match alone merged instincts that only shared the
// project's own words ("mightyterm", "worktree"): the two `## Action`
// sections must also share this share of the shorter one's significant
// words. Measured on the mightyterm store (126 instincts, 2026-11-02):
// of the 30 pairs the trigger/summary rule matched, 8 were one habit
// learned twice and 22 were other subjects; this bar keeps 7 of the 8
// merges and none of the 22 (0.30 kept 2 of the 22, 0.40 lost 2 of the 8).
const DEDUPE_ACTION_OVERLAP_THRESHOLD = 0.35;
// Exported for lib/evolve-preview.js: the /evolve command's preview
// clusters personal instincts with the exact same thresholds evolveStep
// itself writes with, so the preview never shows a cluster evolveStep
// would not also form.
export const EVOLVE_OVERLAP_THRESHOLD = 0.3;
export const EVOLVE_MIN_CLUSTER_SIZE = 3;
// Exported for lib/evolve-command.js (its own weekly-eta calculation) and
// lib/commands-maintain.js's `/maintain --dry-run`, which forces this
// gate (and cleanupProjectsStep's own daily one, below) open so the
// preview covers every step regardless of today's actual cadence.
export const EVOLVE_INTERVAL_MS = 7 * 86400000;
// cleanupProjectsStep runs at most this often (gated the same way as
// evolveStep's own weekly gate, via readMaintenanceSummary's lastCleanupAt).
const CLEANUP_PROJECTS_INTERVAL_MS = 86400000;

// "Re-running evolve must not duplicate an existing candidate whose
// members overlap >= 70%": shared by evolveStep's own dedup/update check.
const CANDIDATE_MEMBER_OVERLAP_THRESHOLD = 0.7;
// `prune.unusedDays`'s own default (lib/plugin.js mirrors this in
// DEFAULT_OPTIONS; kept here too since pruneCandidatesStep is the only
// thing that needs a fallback when an older options object omits it).
const PRUNE_DEFAULT_UNUSED_DAYS = 30;

// Exported so lib/commands-maintain.js's /maintain reply can show the
// same unusedDays figure pruneCandidatesStep itself resolves, without
// duplicating the `options?.prune?.unusedDays || default` fallback.
export function resolveUnusedDays(options) {
  return Number(options?.prune?.unusedDays) || PRUNE_DEFAULT_UNUSED_DAYS;
}

// A trigger carrying a trailing leaked frontmatter fragment, e.g.
// `grep before editing, confidence: 0.8` (lib/observer.js's parser bug
// before the 0.7.0 fix, or a hand-edited file): stripped back to the real
// trigger text instead of left to confuse injection/promotion matching.
const LEAKED_TRIGGER_SUFFIX = /,\s*(confidence|domain|scope|source):\s*\S+\s*$/i;

const noop = () => {};

// ---------------------------------------------------------------- shared

// Pure, exported for lib/evolve-preview.js (the /evolve command's
// preview text, lib/commands.js) and smoke-test.mjs: reads every
// instinct file directly under `dir` (one `writeInstinct`-shaped block
// per file).
export async function loadInstinctFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results = [];
  for (const entry of entries) {
    if (!entry.isFile() || !INSTINCT_FILE_PATTERN.test(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    let content;
    let stat;
    try {
      [content, stat] = await Promise.all([fs.readFile(filePath, "utf8"), fs.stat(filePath)]);
    } catch {
      continue;
    }
    const blocks = parseFrontmatterBlocks(content);
    // Every file this module rewrites was written by writeInstinct (one
    // block per file); a multi-block file (ECC import/export batches) is
    // left alone rather than guessing which block a rewrite should target.
    if (blocks.length !== 1) continue;
    results.push({ fields: blocks[0], body: stripFrontmatter(content), filePath, mtimeMs: stat.mtimeMs });
  }
  return results;
}

export async function appendMaintenanceLog(projectDir, line) {
  await fs.mkdir(projectDir, { recursive: true });
  await fs.appendFile(path.join(projectDir, MAINTENANCE_LOG_FILE), `${new Date().toISOString()} ${line}\n`, "utf8");
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// Pure, exported for lib/evolve-preview.js and smoke-test.mjs: groups
// `items` into clusters where every member shares >= `threshold`
// significant-word overlap (significantWordOverlapRatio) with at least
// one other member already in that cluster (pairwise chaining, not a
// full clique: a cluster's members do not all necessarily overlap with
// each other directly).
export function clusterItems(items, threshold, textOf) {
  const groups = [];
  for (const item of items) {
    const text = textOf(item);
    const target = groups.find((group) => group.some((member) => significantWordOverlapRatio(text, textOf(member)) >= threshold));
    if (target) target.push(item);
    else groups.push([item]);
  }
  return groups;
}

// ---------------------------------------------------------------- 1. promote

// Reimplements the check over `projects/*/instincts/personal/*.md` files
// directly (no python subprocess). Two independent qualification paths,
// either of which promotes an instinct into the global personal store
// with `scope: global` (unless an instinct with that id is already
// there):
//
// 1. Cross-project corroboration (ECC's own rule, vendor/ecc/instinct-cli.py:128-129):
//    confidence >= PROMOTE_CONFIDENCE_THRESHOLD, whose id (or a trigger
//    with >= PROMOTE_TRIGGER_OVERLAP_THRESHOLD word overlap) appears in
//    at least PROMOTE_MIN_PROJECTS distinct project stores.
// 2. Proven on its own, no corroboration needed: confidence >=
//    PROMOTE_FIRED_CONFIDENCE_THRESHOLD and fired >=
//    PROMOTE_FIRED_THRESHOLD, in a single project.
//
// Each path logs its own reason, so the log reads as "which path
// qualified"; path 1 runs first so path 2 never promotes an id path 1
// already just handled.
export async function promoteStep(options, { dryRun = false, log = noop } = {}) {
  const homunculus = resolveHomunculusDir(options);
  const projectsRoot = path.join(homunculus, "projects");
  const globalPersonalDir = path.join(homunculus, "instincts", "personal");

  let projectEntries;
  try {
    projectEntries = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }

  // Never promoted: an id retired to an archive (the global store's own
  // instincts/archive/, or any project's), which the next sweep would
  // otherwise copy straight back, and an instinct whose trigger names one
  // repository, which would then be injected into every other project.
  const retiredIds = new Set((await loadInstinctFiles(path.join(homunculus, "instincts", "archive"))).map((item) => item.fields.id));
  const repositoryNames = await registeredProjectNames(homunculus);
  const candidates = [];
  for (const entry of projectEntries) {
    if (!entry.isDirectory()) continue;
    for (const item of await loadInstinctFiles(path.join(projectsRoot, entry.name, "instincts", "archive"))) retiredIds.add(item.fields.id);
  }
  for (const entry of projectEntries) {
    if (!entry.isDirectory()) continue;
    const personalDir = path.join(projectsRoot, entry.name, "instincts", "personal");
    for (const item of await loadInstinctFiles(personalDir)) {
      if ((Number(item.fields.confidence) || 0) < PROMOTE_CONFIDENCE_THRESHOLD) continue;
      if (retiredIds.has(item.fields.id) || namesRepository(item.fields, repositoryNames)) continue;
      candidates.push({ ...item, personalDir });
    }
  }

  const groups = [];
  for (const candidate of candidates) {
    const target = groups.find((group) =>
      group.some(
        (member) =>
          member.fields.id === candidate.fields.id ||
          significantWordOverlapRatio(member.fields.trigger ?? "", candidate.fields.trigger ?? "") >= PROMOTE_TRIGGER_OVERLAP_THRESHOLD,
      ),
    );
    if (target) target.push(candidate);
    else groups.push([candidate]);
  }

  const existingGlobalIds = new Set((await loadInstinctFiles(globalPersonalDir)).map((item) => item.fields.id));
  let promoted = 0;

  // Path 1: cross-project corroboration.
  for (const group of groups) {
    const distinctProjects = new Set(group.map((member) => member.personalDir));
    if (distinctProjects.size < PROMOTE_MIN_PROJECTS) continue;

    const representative = group.slice().sort((a, b) => (Number(b.fields.confidence) || 0) - (Number(a.fields.confidence) || 0))[0];
    if (existingGlobalIds.has(representative.fields.id)) continue;

    if (dryRun) {
      log(`promote: would copy ${representative.fields.id} to global store (found in ${distinctProjects.size} projects)`);
      continue;
    }
    const globalFields = { ...representative.fields, scope: "global" };
    delete globalFields.project_id;
    delete globalFields.project_name;
    await writeInstinct(globalPersonalDir, globalFields, representative.body);
    existingGlobalIds.add(representative.fields.id);
    promoted += 1;
    log(`promote: copied ${representative.fields.id} to global store (found in ${distinctProjects.size} projects)`);
  }

  // Path 2: proven on its own within a single project, no cross-project
  // corroboration needed. Every candidate here already cleared
  // PROMOTE_CONFIDENCE_THRESHOLD (0.8), a looser bar than this path's own
  // 0.9, so nothing qualifying path 2 was ever excluded from `candidates`
  // in the first place.
  for (const candidate of candidates) {
    if (existingGlobalIds.has(candidate.fields.id)) continue;
    const confidence = Number(candidate.fields.confidence) || 0;
    const fired = Number(candidate.fields.fired) || 0;
    if (confidence < PROMOTE_FIRED_CONFIDENCE_THRESHOLD || fired < PROMOTE_FIRED_THRESHOLD) continue;

    if (dryRun) {
      log(`promote: would copy ${candidate.fields.id} to global store (confidence ${confidence} >= ${PROMOTE_FIRED_CONFIDENCE_THRESHOLD} and fired ${fired} >= ${PROMOTE_FIRED_THRESHOLD} in ${candidate.personalDir})`);
      continue;
    }
    const globalFields = { ...candidate.fields, scope: "global" };
    delete globalFields.project_id;
    delete globalFields.project_name;
    await writeInstinct(globalPersonalDir, globalFields, candidate.body);
    existingGlobalIds.add(candidate.fields.id);
    promoted += 1;
    log(`promote: copied ${candidate.fields.id} to global store (confidence ${confidence} >= ${PROMOTE_FIRED_CONFIDENCE_THRESHOLD} and fired ${fired} >= ${PROMOTE_FIRED_THRESHOLD} in ${candidate.personalDir})`);
  }

  return promoted;
}

async function registeredProjectNames(homunculus) {
  try {
    const registry = JSON.parse(await fs.readFile(path.join(homunculus, "projects.json"), "utf8"));
    return Object.values(registry ?? {}).map((info) => info?.name).filter((name) => typeof name === "string" && name.length > 0);
  } catch {
    return [];
  }
}

// Whether `fields.trigger` names a repository as a whole word: any
// registered project's name, or the instinct's own `project_name`.
// Hyphens count as word characters, so "mighty-instincts" is one name.
export function namesRepository(fields, repositoryNames = []) {
  const trigger = String(fields?.trigger ?? "").toLowerCase();
  const names = new Set([...repositoryNames, fields?.project_name].filter((name) => typeof name === "string" && name.length > 0).map((name) => name.toLowerCase()));
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9-])${escaped}([^a-z0-9-]|$)`).test(trigger)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- 2. prune

export async function pruneStep(project, { dryRun = false, log = noop } = {}) {
  const pendingDir = siblingInstinctsDir(project, "pending");
  let pruned = 0;
  for (const item of await loadInstinctFiles(pendingDir)) {
    const createdMs = Date.parse(item.fields.created);
    const baseMs = Number.isFinite(createdMs) ? createdMs : item.mtimeMs;
    const ageDays = (Date.now() - baseMs) / 86400000;

    if (ageDays >= PENDING_TTL_DAYS) {
      if (dryRun) {
        log(`prune: would delete ${item.fields.id} (age ${Math.floor(ageDays)}d)`);
        continue;
      }
      await fs.unlink(item.filePath);
      pruned += 1;
      log(`prune: deleted ${item.fields.id} (age ${Math.floor(ageDays)}d)`);
    } else if (ageDays >= PENDING_TTL_DAYS - PENDING_EXPIRY_WARNING_DAYS) {
      log(`prune: warning ${item.fields.id} expires in ${Math.max(0, Math.ceil(PENDING_TTL_DAYS - ageDays))}d`);
    }
  }
  return pruned;
}

// ---------------------------------------------------------------- 3. decay

export async function decayStep(project, { dryRun = false, log = noop } = {}) {
  const personalDir = project.instincts_personal;
  const archiveDir = siblingInstinctsDir(project, "archive");
  let archived = 0;
  let decayed = 0;

  for (const item of await loadInstinctFiles(personalDir)) {
    const fired = Number(item.fields.fired) || 0;
    if (fired > 0) continue;

    const createdMs = Date.parse(item.fields.created);
    const baseCreatedMs = Number.isFinite(createdMs) ? createdMs : item.mtimeMs;
    const graceEndMs = baseCreatedMs + DECAY_GRACE_DAYS * 86400000;
    if (Date.now() < graceEndMs) continue;

    const decayedAtMs = Date.parse(item.fields.decayed_at);
    const sinceMs = Number.isFinite(decayedAtMs) ? decayedAtMs : graceEndMs;
    const weeksElapsed = Math.floor((Date.now() - sinceMs) / DECAY_WEEK_MS);
    if (weeksElapsed < 1) continue;

    const newConfidence = round2(Math.max(0, (Number(item.fields.confidence) || 0.5) - DECAY_STEP * weeksElapsed));
    const updatedFields = { ...item.fields, confidence: newConfidence, decayed_at: new Date().toISOString() };

    if (newConfidence < DECAY_ARCHIVE_THRESHOLD) {
      if (dryRun) {
        log(`decay: would archive ${item.fields.id} (confidence ${newConfidence})`);
        continue;
      }
      // Copy-then-delete rather than rename: archiveDir and personalDir are
      // always siblings on the same filesystem here, but writeInstinct's
      // own atomic tmp-then-rename only guarantees that within one
      // directory, and archiving must never lose the file if the delete
      // below somehow fails ("never delete" applies to the original too).
      await writeInstinct(archiveDir, updatedFields, item.body);
      await fs.unlink(item.filePath);
      archived += 1;
      log(`decay: archived ${item.fields.id} (confidence ${newConfidence})`);
    } else {
      if (dryRun) {
        log(`decay: would lower ${item.fields.id} to confidence ${newConfidence}`);
        continue;
      }
      await writeInstinct(personalDir, updatedFields, item.body);
      decayed += 1;
      log(`decay: lowered ${item.fields.id} confidence to ${newConfidence}`);
    }
  }
  return { archived, decayed };
}

// ---------------------------------------------------------------- 4. dedupe

// Called from lib/observer.js just before it would write a brand-new
// personal instinct. Compares the new instinct against every existing
// personal instinct on trigger-vs-trigger OR summary-vs-summary
// significant-word overlap (whichever of the two fields overlaps more):
// a match (>= 60% of the shorter side's word count on either field, or
// >= 45% on either field when both instincts also share the same
// domain) merges into the existing file instead of returning false
// (caller then skips writing a duplicate). Always reads from
// `personalDir` fresh, so two instincts merged in the same observer run
// still see each other in order.
//
// A block whose id already has a file in `personalDir` is an update of
// that instinct (the observer's missing-summary backfill, or the model
// refining it), not a new near-duplicate: it returns false so the caller
// rewrites the instinct's own file. Merging it into another instinct left
// its own file unchanged, so the backfill was requested and merged again
// on every observer run.
export async function dedupeOrMerge(personalDir, newFields, newBody, { dryRun = false, log = noop } = {}) {
  const existingItems = await loadInstinctFiles(personalDir);
  if (existingItems.some((existing) => existing.fields.id === newFields.id)) return false;
  for (const existing of existingItems) {
    const triggerOverlap = significantWordOverlapRatio(newFields.trigger ?? "", existing.fields.trigger ?? "");
    const summaryOverlap = significantWordOverlapRatio(newFields.summary ?? "", existing.fields.summary ?? "");
    const bestOverlap = Math.max(triggerOverlap, summaryOverlap);
    const sameDomain = typeof newFields.domain === "string" && newFields.domain.length > 0 && newFields.domain === existing.fields.domain;
    const threshold = sameDomain ? DEDUPE_SAME_DOMAIN_OVERLAP_THRESHOLD : DEDUPE_OVERLAP_THRESHOLD;
    if (bestOverlap < threshold) continue;
    const actionOverlap = significantWordOverlapRatio(extractSection(newBody, "Action") ?? "", extractSection(existing.body, "Action") ?? "");
    if (actionOverlap < DEDUPE_ACTION_OVERLAP_THRESHOLD) continue;

    if (dryRun) {
      log(`dedupe: would merge ${newFields.id} into ${existing.fields.id}`);
      return true;
    }
    // The target keeps its own summary: the summary is the line injected
    // for the target's own Action, and the source's describes the source.
    const merged = { ...existing.fields };
    merged.confidence = Math.min(0.95, round2((Number(existing.fields.confidence) || 0.5) + 0.05));
    const mergedBody = appendEvidence(existing.body, newBody);
    await writeInstinct(personalDir, merged, mergedBody);
    log(`dedupe: merged ${newFields.id} into ${existing.fields.id}`);
    return true;
  }
  return false;
}

function extractSection(body, heading) {
  const lines = String(body ?? "").split("\n");
  const headingPattern = new RegExp(`^##\\s+${heading}\\b`, "i");
  for (let i = 0; i < lines.length; i++) {
    if (!headingPattern.test(lines[i])) continue;
    const collected = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^##\s+/.test(lines[j])) break;
      collected.push(lines[j]);
    }
    while (collected.length && collected[0].trim() === "") collected.shift();
    while (collected.length && collected[collected.length - 1].trim() === "") collected.pop();
    return collected.length ? collected.join("\n") : null;
  }
  return null;
}

// Exported for lib/observer.js's update path: an update keeps the stored
// body and only adds the new block's evidence.
export function appendEvidence(existingBody, newBody) {
  const newEvidence = extractSection(newBody, "Evidence");
  if (!newEvidence) return existingBody;

  const lines = existingBody.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^##\s+Evidence\b/i.test(lines[i])) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^##\s+/.test(lines[j])) {
        end = j;
        break;
      }
    }
    return [...lines.slice(0, end), newEvidence, ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
  }
  return `${existingBody.trimEnd()}\n\n## Evidence\n${newEvidence}\n`;
}

// ---------------------------------------------------------------- 5. evolve

// Groups personal instincts by domain, then by significant-word overlap
// within each domain, into clusters of >= EVOLVE_MIN_CLUSTER_SIZE; each
// qualifying cluster becomes (or updates) one candidate file under
// `project.evolved_dir` (lib/candidates.js owns the file format, kind
// selection, and body rendering). No model call: everything written here
// comes from data already on disk.
//
// Re-running this against the same instincts must not pile up duplicate
// candidates for the same underlying cluster: an existing candidate
// whose own members overlap the freshly computed cluster by >= 70%
// (memberOverlapRatio) is treated as "the same cluster, just re-seen",
// with two different outcomes depending on what happened to it since:
// an archived one (rejected, or archived after install) blocks the
// cluster from being re-proposed at all, while a proposed or installed
// one just has its `members` list refreshed to match. Only a cluster
// that matches no existing candidate at all becomes a brand new one.
export async function evolveStep(project, { dryRun = false, log = noop } = {}) {
  const list = await loadInstinctFiles(project.instincts_personal);
  const byDomain = new Map();
  for (const item of list) {
    const domain = (item.fields.domain || "general").toLowerCase();
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(item);
  }

  const existing = await loadCandidates(project.evolved_dir);
  let candidates = 0;
  for (const [domain, items] of byDomain) {
    const clusters = clusterItems(items, EVOLVE_OVERLAP_THRESHOLD, (item) => `${item.fields.trigger ?? ""} ${item.fields.summary ?? ""}`);
    for (const cluster of clusters) {
      if (cluster.length < EVOLVE_MIN_CLUSTER_SIZE) continue;
      const memberIds = cluster.map((item) => item.fields.id).sort();

      const archivedMatch = existing.find((candidate) => candidate.fields.status === "archived" && memberOverlapRatio(candidate.fields.members, memberIds) >= CANDIDATE_MEMBER_OVERLAP_THRESHOLD);
      if (archivedMatch) {
        log(`evolve: skipped cluster in domain ${domain} (previously archived as ${archivedMatch.fields.id})`);
        continue;
      }

      const liveMatch = existing.find(
        (candidate) => candidate.fields.status !== "archived" && memberOverlapRatio(candidate.fields.members, memberIds) >= CANDIDATE_MEMBER_OVERLAP_THRESHOLD,
      );
      if (liveMatch) {
        if (arraysEqual(liveMatch.fields.members, memberIds)) continue; // already up to date
        if (dryRun) {
          log(`evolve: would update cluster ${liveMatch.fields.id} members (${cluster.length} members)`);
          continue;
        }
        // Re-read from disk right before writing, rather than trusting
        // the `existing` snapshot taken at the top of this run: a
        // concurrent /evolve-reject, /evolve-archive, or /evolve-install
        // could have changed this exact candidate's status (or deleted
        // it) in the time since that snapshot, and this must never
        // overwrite whatever that command just did with stale fields,
        // or resurrect an archived candidate by writing fresh members
        // onto it.
        const fresh = await findCandidateById(project.evolved_dir, liveMatch.fields.id);
        if (!fresh || fresh.fields.status === "archived") {
          log(`evolve: skipped updating ${liveMatch.fields.id} members (status changed since this run started)`);
          continue;
        }
        await writeCandidate(project.evolved_dir, { ...fresh.fields, members: memberIds }, fresh.body);
        liveMatch.fields.members = memberIds;
        log(`evolve: updated cluster ${liveMatch.fields.id} members (${cluster.length} members)`);
        continue;
      }

      const kind = selectCandidateKind(cluster);
      const clusterId = buildCandidateId(domain, memberIds);
      if (dryRun) {
        log(`evolve: would write cluster ${clusterId} (${kind}, ${cluster.length} members)`);
        continue;
      }
      const suggestedName = buildSuggestedName(domain, kind, existing);
      const fields = {
        id: clusterId,
        kind,
        status: "proposed",
        created: new Date().toISOString(),
        members: memberIds,
        summary: buildCandidateSummary(domain, cluster),
        suggested_name: suggestedName,
        project_id: project.id,
      };
      const body = renderCandidateBody(kind, domain, cluster, suggestedName);
      await writeCandidate(project.evolved_dir, fields, body);
      existing.push({ fields, body, filePath: path.join(project.evolved_dir, `${clusterId}.md`), mtimeMs: Date.now() });
      candidates += 1;
      log(`evolve: wrote cluster ${clusterId} (${kind}, ${cluster.length} members)`);
    }
  }
  if (candidates === 0 && !dryRun) log("evolve: checked, no new clusters");
  return { candidates };
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

// ---------------------------------------------------------------- 5b. prune candidates

// Weekly (runMaintenance gates this on the same cadence as evolveStep,
// above): flags installed candidates nobody has actually used in
// `prune.unusedDays` days (lib/candidates.js's findUnusedInstalled;
// default 30; never a rule candidate, which has no runtime usage
// signal). Report-only by default: nothing is archived or deleted unless
// `prune.auto` is explicitly on, matching this whole feature's "nothing
// is ever installed or removed automatically" rule.
//
// In auto mode, a kind whose entire usage bucket is empty (lib/usage.js's
// isUsageBucketEmpty) is skipped rather than auto-archived: an
// all-empty bucket most likely means the usage *signal* for that kind is
// dead (see lib/observe.js's trackToolUsage and README's "From habits to
// skills" section on the host field-naming this depends on), not that
// every installed candidate of that kind is genuinely unused, and this
// step must never delete real, in-use files just because it failed to
// observe their use. Each candidate is handled in its own try/catch so
// one failure (a permission error, a half-written file, anything) is
// logged and skipped rather than aborting the rest of this step, or the
// maintenance sweep that called it.
export async function pruneCandidatesStep(project, options, { dryRun = false, log = noop } = {}) {
  const candidates = await loadCandidates(project.evolved_dir);
  const usage = await readUsage(project.project_dir);
  const unusedDays = resolveUnusedDays(options);
  const auto = options?.prune?.auto === true;
  const unused = findUnusedInstalled(candidates, usage, unusedDays);

  let archived = 0;
  for (const candidate of unused) {
    if (dryRun) {
      log(`prune: would ${auto ? "archive" : "flag"} unused candidate ${candidate.fields.id} (0 uses in ${unusedDays}d)`);
      continue;
    }
    if (!auto) {
      log(`prune: flagged unused candidate ${candidate.fields.id} (0 uses in ${unusedDays}d); see /evolve`);
      continue;
    }
    const bucket = usageBucketForKind(candidate.fields.kind);
    if (bucket && isUsageBucketEmpty(usage, bucket)) {
      log(`prune: skipped auto-archiving ${candidate.fields.id}: the '${bucket}' usage bucket is entirely empty, so the usage signal looks dead rather than this artefact being genuinely unused`);
      continue;
    }
    try {
      const targets = resolveEvolveTargets(options);
      const result = await uninstallCandidateArtifact(candidate, targets, { ruleProjectRoot: project.root });
      await writeCandidate(project.evolved_dir, { ...candidate.fields, status: "archived", reason: "auto-pruned: unused" }, candidate.body);
      archived += 1;
      if (result.removed) log(`prune: auto-archived unused candidate ${candidate.fields.id} (0 uses in ${unusedDays}d); removed ${result.path}`);
      else if (result.blocked) log(`prune: auto-archived unused candidate ${candidate.fields.id} (0 uses in ${unusedDays}d); its installed file at ${result.path} was left in place (${result.reason})`);
      else log(`prune: auto-archived unused candidate ${candidate.fields.id} (0 uses in ${unusedDays}d); no installed file found to remove`);
    } catch (error) {
      log(`prune: failed to auto-archive ${candidate.fields.id}: ${describeError(error)}`);
    }
  }
  return { flagged: unused.length, archived };
}

// ---------------------------------------------------------------- 6. graduate

// Moves a pending instinct to the personal store once it has fired at
// least once (lib/inject.js bumps `fired` on pending items without ever
// injecting them). Part of the "50% rule" (classifyNewInstinct below).
export async function graduatePendingStep(project, { dryRun = false, log = noop } = {}) {
  const pendingDir = siblingInstinctsDir(project, "pending");
  let promoted = 0;
  for (const item of await loadInstinctFiles(pendingDir)) {
    const fired = Number(item.fields.fired) || 0;
    if (fired <= 0) continue;
    if (dryRun) {
      log(`pending: would promote ${item.fields.id} to personal (fired ${fired})`);
      continue;
    }
    await writeInstinct(project.instincts_personal, item.fields, item.body);
    await fs.unlink(item.filePath);
    promoted += 1;
    log(`pending: promoted ${item.fields.id} to personal (fired ${fired})`);
  }
  return promoted;
}

// An instinct with confidence <= 0.5 is unproven; it goes to
// `instincts/pending/` instead of `instincts/personal/` until
// graduatePendingStep moves it out (once it fires at least once). Applies
// regardless of whether the body carries a `## Evidence` section (0.8.2:
// an Evidence section alone no longer exempts a low-confidence instinct),
// on both a brand-new instinct and an update to an existing one, except
// one that has already graduated: `existingFired` (the matching personal
// instinct's own `fired` count, 0 for anything genuinely new) exempts an
// already-proven instinct from ever being demoted back to pending just
// because a later observer run resubmitted it with a lower confidence.
export function classifyNewInstinct(fields, existingFired = 0) {
  if ((Number(existingFired) || 0) > 0) return "personal";
  const confidence = Number(fields.confidence);
  return Number.isFinite(confidence) && confidence <= 0.5 ? "pending" : "personal";
}

// ---------------------------------------------------------------- 7. repair

// One-off, idempotent cleanup pass over the personal store, for two
// unrelated problems a personal instinct file can carry:
//
// 1. A trigger with a trailing leaked frontmatter fragment (e.g. ",
//    confidence: 0.8"), the shape lib/observer.js's pre-0.7.0 parser
//    could let through when the model crammed a whole frontmatter line
//    onto one physical line.
// 2. A personal instinct that never should have landed in personal/ at
//    all under the current "50% rule" (classifyNewInstinct above):
//    confidence <= 0.5 and never fired. Moved to pending/, the same
//    place a freshly classified instinct like it would go now; it
//    graduates back out the same way (graduatePendingStep, once used).
//
// Safe to run every time: a trigger already clean never matches
// LEAKED_TRIGGER_SUFFIX, and a moved instinct is gone from personal/ by
// the next run, so both halves are no-ops on a repeat pass.
// The plugin's atomic writers name a temporary file `<name>.tmp-<pid>-<ms>-<n>`
// (store.js uniqueSuffix) and rename it over its target; a write that dies
// in between leaves it behind. One older than STALE_TMP_MS cannot be a write
// in flight. Backlog B20, the sibling of mighty-reviewer's store prune.
const STALE_TMP_MS = 3600000;
const OWN_TMP_NAME = /\.tmp-\d+-\d+-\d+$/;

// Removes the plugin's own stale temporary files (regular files only, never
// a folder or a symlink) from the store's root, the project's folder and its
// evolved folder. Returns how many it removed (or would remove, dry).
export async function cleanStaleTmpStep(options, project, { dryRun = false, log = noop } = {}) {
  const dirs = [...new Set([resolveHomunculusDir(options), project.project_dir, project.evolved_dir].filter(Boolean))];
  let cleaned = 0;
  for (const dir of dirs) {
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!OWN_TMP_NAME.test(name)) continue;
      const file = path.join(dir, name);
      let info;
      try {
        info = await fs.lstat(file);
      } catch {
        continue;
      }
      if (!info.isFile() || Date.now() - info.mtimeMs <= STALE_TMP_MS) continue;
      if (!dryRun) {
        try {
          await fs.rm(file, { force: true });
        } catch {
          continue;
        }
      }
      cleaned += 1;
      log(`${dryRun ? "would remove" : "removed"} stale temporary file ${file}`);
    }
  }
  return cleaned;
}

export async function repairStep(project, { dryRun = false, log = noop } = {}) {
  const personalDir = project.instincts_personal;
  const pendingDir = siblingInstinctsDir(project, "pending");
  let repaired = 0;
  for (const item of await loadInstinctFiles(personalDir)) {
    let fields = item.fields;

    const trigger = fields.trigger;
    if (typeof trigger === "string" && LEAKED_TRIGGER_SUFFIX.test(trigger)) {
      const cleaned = trigger.replace(LEAKED_TRIGGER_SUFFIX, "").trim();
      if (cleaned && cleaned !== trigger) fields = { ...fields, trigger: cleaned };
    }

    const confidence = Number(fields.confidence);
    const fired = Number(fields.fired) || 0;
    const misclassified = Number.isFinite(confidence) && confidence <= 0.5 && fired === 0;

    if (misclassified) {
      if (dryRun) {
        log(`repair: would move ${fields.id} to pending (confidence <= 0.5, never fired)`);
        continue;
      }
      await writeInstinct(pendingDir, fields, item.body);
      await fs.unlink(item.filePath);
      repaired += 1;
      log(`repair: moved ${fields.id} to pending (confidence <= 0.5, never fired)`);
      continue;
    }

    if (fields === item.fields) continue; // neither repair applied

    if (dryRun) {
      log(`repair: would clean trigger of ${fields.id}`);
      continue;
    }
    await writeInstinct(personalDir, fields, item.body);
    repaired += 1;
    log(`repair: cleaned trigger of ${fields.id}`);
  }
  return repaired;
}

// ---------------------------------------------------------------- 8. cleanup projects

// A project id is always this plugin/ECC's own sha256-prefix hash
// (vendor/ecc/instinct-cli.py's `_validate_project_id`); never trust a
// registry entry whose key does not match that shape enough to delete
// or move anything for it.
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function tempRootCandidates() {
  const candidates = new Set(["/private/var/folders"]);
  for (const value of [process.env.TMPDIR, os.tmpdir()]) {
    if (typeof value === "string" && value.length > 0) candidates.add(value.replace(/\/+$/, ""));
  }
  return [...candidates];
}

function isUnderTempRoot(root) {
  if (typeof root !== "string" || root.length === 0) return false;
  return tempRootCandidates().some((tmpRoot) => root === tmpRoot || root.startsWith(`${tmpRoot}/`));
}

async function pathMissing(target) {
  try {
    await fs.access(target);
    return false;
  } catch {
    return true;
  }
}

async function countProjectInstincts(projectDir) {
  const personal = await loadInstinctFiles(path.join(projectDir, "instincts", "personal"));
  const inherited = await loadInstinctFiles(path.join(projectDir, "instincts", "inherited"));
  return personal.length + inherited.length;
}

async function writeRegistry(registryFile, registry) {
  await fs.mkdir(path.dirname(registryFile), { recursive: true });
  const tmp = path.join(path.dirname(registryFile), `.${path.basename(registryFile)}.tmp-${uniqueSuffix()}`);
  await fs.writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  await fs.rename(tmp, registryFile);
}

// Daily (runMaintenance gates this the same way it gates evolveStep,
// just on its own interval): for every entry in ECC's own projects
// registry (vendor/ecc/instinct-cli.py's REGISTRY_FILE, `<homunculus>/projects.json`,
// `{ id: { id, name, root, remote, created_at, last_seen } }`) whose
// root no longer exists, or lives under the OS temp directory (TMPDIR,
// os.tmpdir(), or the macOS-resolved "/private/var/folders"), and which
// has 0 instincts (personal + inherited) in its own project store, this
// removes the registry entry and archives (never deletes outright) its
// project directory to `<homunculus>/archive/projects/<id>/`.
//
// Both conditions (gone-or-temp AND zero instincts) must hold: a project
// with real instincts is kept regardless of where its root sits (nothing
// learned is ever thrown away just because the project itself was
// ephemeral), and a resident, non-temp project with 0 instincts is left
// alone too (it may simply be new).
export async function cleanupProjectsStep(options, { dryRun = false, log = noop } = {}) {
  const homunculus = resolveHomunculusDir(options);
  const registryFile = path.join(homunculus, "projects.json");
  const projectsRoot = path.join(homunculus, "projects");

  let registry;
  try {
    registry = JSON.parse(await fs.readFile(registryFile, "utf8"));
  } catch {
    return 0;
  }
  if (typeof registry !== "object" || registry === null || Array.isArray(registry)) return 0;

  const survivors = { ...registry };
  let cleaned = 0;

  for (const [id, info] of Object.entries(registry)) {
    if (!PROJECT_ID_PATTERN.test(id)) continue; // never touch a malformed registry key
    const root = typeof info?.root === "string" ? info.root : "";
    const rootGone = root.length === 0 || (await pathMissing(root));
    const rootIsTemp = isUnderTempRoot(root);
    if (!rootGone && !rootIsTemp) continue;

    const projectDir = path.join(projectsRoot, id);
    if ((await countProjectInstincts(projectDir)) > 0) continue;

    const reason = rootGone ? "root no longer exists" : "root lives under a temp directory";
    const label = info?.name ?? id;
    if (dryRun) {
      log(`cleanup: would archive project ${label} [${id}] (${reason}, 0 instincts)`);
      continue;
    }

    const archiveDir = path.join(homunculus, "archive", "projects", id);
    try {
      await fs.mkdir(path.dirname(archiveDir), { recursive: true });
      await fs.rm(archiveDir, { recursive: true, force: true }); // never collide with a previous run's archive
      if (!(await pathMissing(projectDir))) await fs.rename(projectDir, archiveDir);
    } catch (error) {
      log(`cleanup: failed to archive project ${label} [${id}]: ${describeError(error)}`);
      continue;
    }
    delete survivors[id];
    cleaned += 1;
    log(`cleanup: archived project ${label} [${id}] (${reason}, 0 instincts)`);
  }

  if (dryRun) return cleaned;
  if (cleaned > 0) await writeRegistry(registryFile, survivors);
  else log("cleanup: checked, nothing to remove");
  return cleaned;
}

// ---------------------------------------------------------------- orchestration

const RUN_SUMMARY_LINE = /^\S+ run: promoted (\d+), archived (\d+), merged (\d+), pruned (\d+), candidates (\d+), repaired (\d+)(?:, cleaned (\d+))?/;
const DEDUPE_LOG_LINE = /^\S+ dedupe: merged/;
const EVOLVE_ATTEMPT_LINE = /^(\S+) evolve: (wrote cluster|checked, no new clusters)/;
const CLEANUP_ATTEMPT_LINE = /^(\S+) cleanup: (archived project|checked, nothing to remove)/;
const SEVEN_DAYS_MS = 7 * 86400000;

// Reads `maintenance.log` back into: the periodic sweep's last run time,
// the last time evolve was actually attempted (write or no-op check; used
// for its weekly gate), the last time cleanupProjects was actually
// attempted (same pattern, daily gate), and the last 7 days' totals for
// lib/board.js's "kept tidy" row. The log is the only state this module keeps.
export async function readMaintenanceSummary(project) {
  const base = {
    lastRunAt: null,
    lastEvolveAt: null,
    lastCleanupAt: null,
    counts7d: { promoted: 0, archived: 0, merged: 0, pruned: 0, candidates: 0, repaired: 0, cleaned: 0 },
  };
  let content;
  try {
    content = await fs.readFile(path.join(project.project_dir, MAINTENANCE_LOG_FILE), "utf8");
  } catch {
    return base;
  }

  const cutoffMs = Date.now() - SEVEN_DAYS_MS;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const timestamp = line.slice(0, line.indexOf(" "));
    const timestampMs = Date.parse(timestamp);
    if (Number.isNaN(timestampMs)) continue;

    const summaryMatch = RUN_SUMMARY_LINE.exec(line);
    if (summaryMatch) {
      if (!base.lastRunAt || timestampMs > Date.parse(base.lastRunAt)) base.lastRunAt = timestamp;
      if (timestampMs >= cutoffMs) {
        base.counts7d.promoted += Number(summaryMatch[1]) || 0;
        base.counts7d.archived += Number(summaryMatch[2]) || 0;
        base.counts7d.merged += Number(summaryMatch[3]) || 0;
        base.counts7d.pruned += Number(summaryMatch[4]) || 0;
        base.counts7d.candidates += Number(summaryMatch[5]) || 0;
        base.counts7d.repaired += Number(summaryMatch[6]) || 0;
        base.counts7d.cleaned += Number(summaryMatch[7]) || 0;
      }
      continue;
    }
    if (DEDUPE_LOG_LINE.test(line) && timestampMs >= cutoffMs) {
      base.counts7d.merged += 1;
      continue;
    }
    if (EVOLVE_ATTEMPT_LINE.test(line) && (!base.lastEvolveAt || timestampMs > Date.parse(base.lastEvolveAt))) {
      base.lastEvolveAt = timestamp;
      continue;
    }
    if (CLEANUP_ATTEMPT_LINE.test(line) && (!base.lastCleanupAt || timestampMs > Date.parse(base.lastCleanupAt))) {
      base.lastCleanupAt = timestamp;
    }
  }
  return base;
}

// Runs every step `cfg` enables (all default on), in a fixed order, and
// writes one `run: promoted N, archived N, merged N, pruned N, candidates
// N, repaired N, cleaned N` summary line (merged always 0 here: dedupe
// runs inline from lib/observer.js's write path, not from this sweep;
// its own merges are logged, and counted into the 7-day total,
// independently). `evolve` only actually runs once a week (gated on
// readMaintenanceSummary's lastEvolveAt) and `cleanupProjects` only once
// a day (same pattern, lastCleanupAt); every other call still logs an
// attempt marker so each gate has something to measure from even when
// nothing qualified.
//
// `overrides` is lib/commands-maintain.js's own seam into a sweep that
// otherwise only ever runs on a timer: `dryRun` (when not undefined)
// replaces `cfg.dryRun` outright, so `/maintain --dry-run` previews
// regardless of the configured `maintenance.dryRun`; `force` skips both
// weekly/daily due-gates below, so that same preview covers evolve and
// cleanupProjects too instead of only whichever of the two happens to be
// due today (safe to force even on a real, non-dry-run call: both steps
// are idempotent no-ops when nothing in their own pool qualifies);
// `onLog` receives every line this run produces, including the final
// summary line, in order, so a caller can post them back without a
// second read of maintenance.log.
export async function runMaintenance(options, project, cfg = MAINTENANCE_DEFAULTS, overrides = {}) {
  const merged = { ...MAINTENANCE_DEFAULTS, ...cfg };
  if (overrides.dryRun !== undefined) merged.dryRun = overrides.dryRun;
  const dryRun = merged.dryRun === true;
  const force = overrides.force === true;
  const onLog = typeof overrides.onLog === "function" ? overrides.onLog : null;
  const lines = [];
  const log = (line) => {
    lines.push(line);
    if (onLog) onLog(line);
  };

  const counts = { promoted: 0, archived: 0, merged: 0, pruned: 0, candidates: 0, repaired: 0, cleaned: 0 };

  if (merged.repair !== false) counts.repaired += await repairStep(project, { dryRun, log });
  if (merged.cleanTmp !== false) counts.cleaned += await cleanStaleTmpStep(options, project, { dryRun, log });
  if (merged.prune !== false) counts.pruned += await pruneStep(project, { dryRun, log });
  if (merged.decay !== false) {
    const { archived } = await decayStep(project, { dryRun, log });
    counts.archived += archived;
  }
  if (merged.promote !== false) counts.promoted += await promoteStep(options, { dryRun, log });
  await graduatePendingStep(project, { dryRun, log });

  if ((merged.evolve !== false || merged.cleanupProjects !== false)) {
    const summary = await readMaintenanceSummary(project);

    if (merged.evolve !== false) {
      const due = force || !summary.lastEvolveAt || Date.now() - Date.parse(summary.lastEvolveAt) >= EVOLVE_INTERVAL_MS;
      if (due) {
        const { candidates } = await evolveStep(project, { dryRun, log });
        counts.candidates += candidates;
        // Same weekly cadence as evolveStep itself: both look at the whole
        // candidate pool, so there is no benefit to running pruneCandidates
        // on a separate schedule of its own.
        await pruneCandidatesStep(project, options, { dryRun, log });
      }
    }

    if (merged.cleanupProjects !== false) {
      const due = force || !summary.lastCleanupAt || Date.now() - Date.parse(summary.lastCleanupAt) >= CLEANUP_PROJECTS_INTERVAL_MS;
      if (due) counts.cleaned += await cleanupProjectsStep(options, { dryRun, log });
    }
  }

  log(
    `run: promoted ${counts.promoted}, archived ${counts.archived}, merged ${counts.merged}, pruned ${counts.pruned}, candidates ${counts.candidates}, repaired ${counts.repaired}, cleaned ${counts.cleaned}`,
  );
  for (const line of lines) {
    await appendMaintenanceLog(project.project_dir, line);
  }
  return counts;
}

// Owns the in-flight guard and the "at least every intervalHours" timer;
// `runAfterObserver()` always runs (force: true), matching "runs after
// each observer run" regardless of how recently the timer last fired.
export function createMaintenanceController(options, project, hooks = {}) {
  const cfg = { ...MAINTENANCE_DEFAULTS, ...(options.maintenance ?? {}) };
  const afterRun = typeof hooks.afterRun === "function" ? hooks.afterRun : () => {};
  let inFlight = false;
  let timer = null;

  async function run({ force = false } = {}) {
    if (inFlight) return null;
    inFlight = true;
    try {
      if (!force) {
        const summary = await readMaintenanceSummary(project);
        if (summary.lastRunAt && Date.now() - Date.parse(summary.lastRunAt) < cfg.intervalHours * 3600000) {
          return null;
        }
      }
      return await runMaintenance(options, project, cfg);
    } catch (error) {
      console.warn(`[${PKG_NAME}] maintenance run failed`, error);
      return null;
    } finally {
      inFlight = false;
      try {
        await afterRun();
      } catch (error) {
        console.warn(`[${PKG_NAME}] board refresh after maintenance run failed`, error);
      }
    }
  }

  return {
    cfg,
    runAfterObserver: () => run({ force: true }),
    start() {
      if (timer) return;
      timer = setInterval(() => void run({ force: false }), MAINTENANCE_POLL_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

// Test seam only: lets smoke-test.mjs build the same unique tmp-file
// suffix lib/store.js's atomic writes use, for fixtures that need to
// race-check nothing but still want a realistic filename.
export { uniqueSuffix };
