// Maintenance loop: promote / prune / decay / dedupe / evolve / repair for
// the instinct stores this plugin writes. Runs after every observer run
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
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveHomunculusDir } from "./homunculus-dir.js";
import { siblingInstinctsDir } from "./project.js";
import { parseFrontmatterBlocks, stripFrontmatter, uniqueSuffix, writeInstinct } from "./store.js";
import { significantWordOverlapRatio } from "./inject.js";
import { PKG_NAME } from "./pkg.js";

export const MAINTENANCE_DEFAULTS = {
  intervalHours: 24,
  dryRun: false,
  promote: true,
  prune: true,
  decay: true,
  dedupe: true,
  evolve: true,
  repair: true,
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

// Mirrors vendor/ecc/instinct-cli.py:133,135's PENDING_TTL_DAYS (30) and
// PENDING_EXPIRY_WARNING_DAYS (7).
const PENDING_TTL_DAYS = 30;
const PENDING_EXPIRY_WARNING_DAYS = 7;

const DECAY_GRACE_DAYS = 30;
const DECAY_STEP = 0.05;
const DECAY_WEEK_MS = 7 * 86400000;
const DECAY_ARCHIVE_THRESHOLD = 0.4;

const DEDUPE_OVERLAP_THRESHOLD = 0.6;
const EVOLVE_OVERLAP_THRESHOLD = 0.3;
const EVOLVE_MIN_CLUSTER_SIZE = 3;
const EVOLVE_INTERVAL_MS = 7 * 86400000;

// A trigger carrying a trailing leaked frontmatter fragment, e.g.
// `grep before editing, confidence: 0.8` (lib/observer.js's parser bug
// before the 0.7.0 fix, or a hand-edited file): stripped back to the real
// trigger text instead of left to confuse injection/promotion matching.
const LEAKED_TRIGGER_SUFFIX = /,\s*(confidence|domain|scope|source):\s*\S+\s*$/i;

const noop = () => {};

// ---------------------------------------------------------------- shared

async function loadInstinctFiles(dir) {
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

function clusterItems(items, threshold, textOf) {
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
// directly (no python subprocess): an instinct with confidence >=
// PROMOTE_CONFIDENCE_THRESHOLD, whose id (or a trigger with >=
// PROMOTE_TRIGGER_OVERLAP_THRESHOLD word overlap) appears in at least
// PROMOTE_MIN_PROJECTS distinct project stores, is copied into the global
// personal store with `scope: global`, unless an instinct with that id is
// already there.
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

  const candidates = [];
  for (const entry of projectEntries) {
    if (!entry.isDirectory()) continue;
    const personalDir = path.join(projectsRoot, entry.name, "instincts", "personal");
    for (const item of await loadInstinctFiles(personalDir)) {
      if ((Number(item.fields.confidence) || 0) >= PROMOTE_CONFIDENCE_THRESHOLD) {
        candidates.push({ ...item, personalDir });
      }
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
  return promoted;
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
// personal instinct. Compares the new instinct's trigger+summary against
// every existing personal instinct by significant-word overlap; on a
// match (>= 60% of the shorter side's word count), merges into the
// existing file instead of returning false (caller then skips writing a
// duplicate). Always reads from `personalDir` fresh, so two instincts
// merged in the same observer run still see each other in order.
export async function dedupeOrMerge(personalDir, newFields, newBody, { dryRun = false, log = noop } = {}) {
  const newText = `${newFields.trigger ?? ""} ${newFields.summary ?? ""}`;
  for (const existing of await loadInstinctFiles(personalDir)) {
    if (existing.fields.id === newFields.id) continue;
    const existingText = `${existing.fields.trigger ?? ""} ${existing.fields.summary ?? ""}`;
    if (significantWordOverlapRatio(newText, existingText) < DEDUPE_OVERLAP_THRESHOLD) continue;

    if (dryRun) {
      log(`dedupe: would merge ${newFields.id} into ${existing.fields.id}`);
      return true;
    }
    const merged = { ...existing.fields };
    merged.confidence = Math.min(0.95, round2((Number(existing.fields.confidence) || 0.5) + 0.05));
    if (typeof newFields.summary === "string" && newFields.summary.length > 0) {
      if (!existing.fields.summary || newFields.summary.length < existing.fields.summary.length) {
        merged.summary = newFields.summary;
      }
    }
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

function appendEvidence(existingBody, newBody) {
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

function buildClusterId(domain, cluster) {
  const ids = cluster.map((item) => item.fields.id).sort();
  const hash = crypto.createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 8);
  const slug =
    String(domain)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "general";
  return `${slug}-${hash}`;
}

function titleCase(value) {
  return String(value)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function buildSkillDescription(domain, cluster) {
  const summaries = cluster
    .map((item) => item.fields.summary || item.fields.trigger)
    .filter(Boolean)
    .slice(0, 3);
  return `Capture and apply the ${domain} patterns observed across this project: ${summaries.join("; ")}.`;
}

function renderCluster(domain, clusterId, cluster) {
  return [
    `# Candidate skill: ${titleCase(domain)} patterns`,
    "",
    `Cluster id: ${clusterId}`,
    `Members (${cluster.length}):`,
    ...cluster.map((item) => `- ${item.fields.id}: ${item.fields.summary || item.fields.trigger || "(no summary)"}`),
    "",
    "## Suggested SKILL.md description",
    "",
    buildSkillDescription(domain, cluster),
    "",
  ].join("\n");
}

// Groups personal instincts by domain, then by significant-word overlap
// within each domain, into clusters of >= EVOLVE_MIN_CLUSTER_SIZE; writes
// a deterministic candidate-skill outline for each to
// `<project.evolved_dir>/<cluster-id>.md`. No model call: title, member
// ids/summaries, and the suggested SKILL.md description are all built
// from data already on disk.
export async function evolveStep(project, { dryRun = false, log = noop } = {}) {
  const list = await loadInstinctFiles(project.instincts_personal);
  const byDomain = new Map();
  for (const item of list) {
    const domain = (item.fields.domain || "general").toLowerCase();
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(item);
  }

  let candidates = 0;
  for (const [domain, items] of byDomain) {
    const clusters = clusterItems(items, EVOLVE_OVERLAP_THRESHOLD, (item) => `${item.fields.trigger ?? ""} ${item.fields.summary ?? ""}`);
    for (const cluster of clusters) {
      if (cluster.length < EVOLVE_MIN_CLUSTER_SIZE) continue;
      const clusterId = buildClusterId(domain, cluster);
      if (dryRun) {
        log(`evolve: would write cluster ${clusterId} (${cluster.length} members)`);
        continue;
      }
      await fs.mkdir(project.evolved_dir, { recursive: true });
      const outPath = path.join(project.evolved_dir, `${clusterId}.md`);
      await fs.writeFile(outPath, renderCluster(domain, clusterId, cluster), "utf8");
      candidates += 1;
      log(`evolve: wrote cluster ${clusterId} (${cluster.length} members)`);
    }
  }
  if (candidates === 0 && !dryRun) log("evolve: checked, no new clusters");
  return { candidates };
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

// An instinct the model writes with confidence exactly 0.5 and no
// `## Evidence` section is unproven; it goes to `instincts/pending/`
// instead of `instincts/personal/` until graduatePendingStep moves it out.
export function classifyNewInstinct(fields, body) {
  const hasEvidence = /^##\s+Evidence\b/im.test(body ?? "");
  const isHalfConfidence = Number(fields.confidence) === 0.5;
  return isHalfConfidence && !hasEvidence ? "pending" : "personal";
}

// ---------------------------------------------------------------- 7. repair

// One-off, idempotent cleanup for a personal instinct whose trigger
// carries a trailing leaked frontmatter fragment (e.g. ", confidence:
// 0.8"), the shape lib/observer.js's pre-0.7.0 parser could let through
// when the model crammed a whole frontmatter line onto one physical line.
// Safe to run every time: a trigger already clean never matches
// LEAKED_TRIGGER_SUFFIX, so a repeat run is a no-op.
export async function repairStep(project, { dryRun = false, log = noop } = {}) {
  const personalDir = project.instincts_personal;
  let repaired = 0;
  for (const item of await loadInstinctFiles(personalDir)) {
    const trigger = item.fields.trigger;
    if (typeof trigger !== "string" || !LEAKED_TRIGGER_SUFFIX.test(trigger)) continue;
    const cleaned = trigger.replace(LEAKED_TRIGGER_SUFFIX, "").trim();
    if (!cleaned || cleaned === trigger) continue;

    if (dryRun) {
      log(`repair: would clean trigger of ${item.fields.id}`);
      continue;
    }
    await writeInstinct(personalDir, { ...item.fields, trigger: cleaned }, item.body);
    repaired += 1;
    log(`repair: cleaned trigger of ${item.fields.id}`);
  }
  return repaired;
}

// ---------------------------------------------------------------- orchestration

const RUN_SUMMARY_LINE = /^\S+ run: promoted (\d+), archived (\d+), merged (\d+), pruned (\d+), candidates (\d+), repaired (\d+)/;
const DEDUPE_LOG_LINE = /^\S+ dedupe: merged/;
const EVOLVE_ATTEMPT_LINE = /^(\S+) evolve: (wrote cluster|checked, no new clusters)/;
const SEVEN_DAYS_MS = 7 * 86400000;

// Reads `maintenance.log` back into: the periodic sweep's last run time,
// the last time evolve was actually attempted (write or no-op check; used
// for the weekly gate below), and the last 7 days' totals for lib/board.js's
// "kept tidy" row. The log is the only state this module keeps.
export async function readMaintenanceSummary(project) {
  const base = { lastRunAt: null, lastEvolveAt: null, counts7d: { promoted: 0, archived: 0, merged: 0, pruned: 0, candidates: 0, repaired: 0 } };
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
      }
      continue;
    }
    if (DEDUPE_LOG_LINE.test(line) && timestampMs >= cutoffMs) {
      base.counts7d.merged += 1;
      continue;
    }
    if (EVOLVE_ATTEMPT_LINE.test(line) && (!base.lastEvolveAt || timestampMs > Date.parse(base.lastEvolveAt))) {
      base.lastEvolveAt = timestamp;
    }
  }
  return base;
}

// Runs every step `cfg` enables (all default on), in a fixed order, and
// writes one `run: promoted N, archived N, merged N, pruned N, candidates
// N, repaired N` summary line (merged always 0 here: dedupe runs inline
// from lib/observer.js's write path, not from this sweep; its own merges
// are logged, and counted into the 7-day total, independently). `evolve`
// only actually runs once a week (gated on readMaintenanceSummary's
// lastEvolveAt); every other call still logs an attempt marker so the
// gate has something to measure from even when nothing qualified.
export async function runMaintenance(options, project, cfg = MAINTENANCE_DEFAULTS) {
  const merged = { ...MAINTENANCE_DEFAULTS, ...cfg };
  const dryRun = merged.dryRun === true;
  const lines = [];
  const log = (line) => lines.push(line);

  const counts = { promoted: 0, archived: 0, merged: 0, pruned: 0, candidates: 0, repaired: 0 };

  if (merged.repair !== false) counts.repaired += await repairStep(project, { dryRun, log });
  if (merged.prune !== false) counts.pruned += await pruneStep(project, { dryRun, log });
  if (merged.decay !== false) {
    const { archived } = await decayStep(project, { dryRun, log });
    counts.archived += archived;
  }
  if (merged.promote !== false) counts.promoted += await promoteStep(options, { dryRun, log });
  await graduatePendingStep(project, { dryRun, log });

  if (merged.evolve !== false) {
    const summary = await readMaintenanceSummary(project);
    const due = !summary.lastEvolveAt || Date.now() - Date.parse(summary.lastEvolveAt) >= EVOLVE_INTERVAL_MS;
    if (due) {
      const { candidates } = await evolveStep(project, { dryRun, log });
      counts.candidates += candidates;
    }
  }

  lines.push(`run: promoted ${counts.promoted}, archived ${counts.archived}, merged ${counts.merged}, pruned ${counts.pruned}, candidates ${counts.candidates}, repaired ${counts.repaired}`);
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
