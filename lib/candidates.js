// Candidate-file format, kind selection, install-target resolution, and
// the "are we allowed to touch this file" marker checks shared by
// lib/maintain.js's evolveStep/pruneCandidatesStep (writers) and
// lib/commands.js's /evolve-install, /evolve-reject, /evolve-archive,
// /evolve-list (readers and the other writers). Centralised here the same
// way lib/store.js owns the instinct-file format: every module that reads
// or writes a candidate file goes through this one instead of each
// re-deriving the frontmatter shape.
//
// A candidate file (`<project data dir>/evolved/<cluster-id>.md`) looks
// like an instinct file but is never read by vendor/ecc/instinct-cli.py:
// frontmatter carries `id, kind (skill|command|agent|rule), status
// (proposed|installed|archived), created, members (a flow-style array of
// member instinct ids), summary, suggested_name`, plus `installed_at`
// and `reason` once a status transition adds them. The body is the
// drafted artefact itself: a full SKILL.md (skill), a commands/<name>.md
// draft (command), an agent markdown draft (agent), or a 1-3 line
// AGENTS.md snippet (rule) with no frontmatter of its own.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { uniqueSuffix, unquoteYaml, yamlQuote } from "./store.js";
import { PKG_NAME } from "./pkg.js";

export const CANDIDATE_KINDS = ["skill", "command", "agent", "rule"];
export const CANDIDATE_STATUSES = ["proposed", "installed", "archived"];

export const GENERATED_BY_MARKER = "mighty-instincts";
export const RULE_HEADING = "## Learned rules (mighty-instincts)";

const CANDIDATE_FILE_PATTERN = /\.md$/i;
const CANDIDATE_FIELD_ORDER = [
  "id",
  "kind",
  "status",
  "created",
  "members",
  "summary",
  "suggested_name",
  "project_id",
  "installed_at",
  "installed_hash",
  "reason",
];
// Same shape instinct ids already use (observer.js's INSTINCT_ID_PATTERN,
// unbounded here rather than capped at 64 chars: a candidate id is a
// slug plus an 8-char hash, never hand-typed). Also used for
// `suggested_name`, which becomes a real directory/file name component.
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

// <= 3 members (the smallest a cluster can be, see maintain.js's own
// EVOLVE_MIN_CLUSTER_SIZE) reads as "rule"; 4-5 as "command" or "skill"
// depending on content; 6+ always "skill". A judgment call, not a
// measured threshold, same as evolve-preview.js's own size cutoffs
// (which this intentionally does not share: that module previews a
// different, --generate-triggered CLI path and is free to use its own).
const RULE_MAX_MEMBERS = 3;
const COMMAND_MAX_MEMBERS = 5;

// Any member mentioning delegation or a specialist role routes the whole
// cluster to "agent", regardless of size: a group of instincts about
// handing work off to a subagent is never "a rule" or "a skill" in the
// sense those forms otherwise mean here.
const DELEGATION_PATTERN = /\b(delegat\w*|sub-?agents?|specialists?|spawn(?:s|ed|ing)?\s+an?\s+agent|hand(?:s|ed|ing)?\s+off)\b/i;
// "the summaries contain imperative verbs about running or checking":
// checked against summaries only (not triggers), per spec.
const RUN_CHECK_VERB_PATTERN = /\b(run|runs|running|check|checks|checking|verify|verifies|verifying|validate|validates|validating|test|tests|testing|lint|lints|linting|build|builds|building|execute|executes|executing|scan|scans|scanning)\b/i;

const BUCKET_FOR_KIND = { skill: "skills", command: "commands", agent: "agents" };
export function usageBucketForKind(kind) {
  return BUCKET_FOR_KIND[kind];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function slugify(value) {
  return (
    String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "general"
  );
}

export function titleCase(value) {
  return String(value)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// ------------------------------------------------------------- frontmatter

// Supports one extra shape beyond lib/store.js's parseFrontmatterBlocks:
// a flow-style array value (`members: [a, b, c]`), the only field here
// that is ever a list.
export function parseCandidateFrontmatter(content) {
  const lines = String(content ?? "").split("\n");
  if (lines[0]?.trim() !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  const fields = {};
  for (const line of lines.slice(1, end)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    fields[key] = key === "members" ? parseMembersValue(raw) : unquoteYaml(raw);
  }
  return { fields, body: lines.slice(end + 1).join("\n") };
}

function parseMembersValue(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner
    .split(",")
    .map((entry) => unquoteYaml(entry.trim()))
    .filter((entry) => entry.length > 0);
}

export async function writeCandidate(dir, fields, body) {
  await fs.mkdir(dir, { recursive: true });
  const header = ["---"];
  for (const key of CANDIDATE_FIELD_ORDER) {
    const value = fields[key];
    if (value === undefined || value === null || value === "") continue;
    if (key === "members") {
      header.push(`members: [${(Array.isArray(value) ? value : []).join(", ")}]`);
    } else if (key === "summary") {
      header.push(`summary: ${yamlQuote(value)}`);
    } else {
      header.push(`${key}: ${value}`);
    }
  }
  header.push("---", "");
  const content = `${header.join("\n")}${String(body ?? "").trim()}\n`;
  const filePath = path.join(dir, `${fields.id}.md`);
  const tmpPath = path.join(dir, `.${fields.id}.md.tmp-${uniqueSuffix()}`);
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, filePath);
  return filePath;
}

// Every candidate file sits directly under `dir` (never recurses):
// vendor/ecc/instinct-cli.py's own `--generate` evolve output nests under
// `evolved/skills|commands|agents/`, so a flat read here never mistakes
// its files for ours (and ours never collide with its subdirectories).
//
// A file whose own `id` is malformed, whose `suggested_name` is
// malformed, or whose filename does not match `<id>.md` is skipped (with
// a warning) rather than loaded: `id`/`suggested_name` end up as real
// filesystem path segments (installPathFor below), and a value outside
// ID_PATTERN (or a filename a hand edit left out of sync with its own
// `id:` field) is exactly the shape a path-traversal or path-confusion
// attempt would take.
export async function loadCandidates(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results = [];
  for (const entry of entries) {
    if (!entry.isFile() || !CANDIDATE_FILE_PATTERN.test(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    let content;
    let stat;
    try {
      [content, stat] = await Promise.all([fs.readFile(filePath, "utf8"), fs.stat(filePath)]);
    } catch {
      continue;
    }
    const parsed = parseCandidateFrontmatter(content);
    if (!parsed || !parsed.fields.id || !CANDIDATE_KINDS.includes(parsed.fields.kind)) continue;
    const fields = { ...parsed.fields, members: Array.isArray(parsed.fields.members) ? parsed.fields.members : [] };

    if (!ID_PATTERN.test(fields.id)) {
      console.warn(`[${PKG_NAME}] skipping candidate file with an invalid id: ${entry.name}`);
      continue;
    }
    if (entry.name !== `${fields.id}.md`) {
      console.warn(`[${PKG_NAME}] skipping candidate file whose name does not match its own id: ${entry.name}`);
      continue;
    }
    if (typeof fields.suggested_name === "string" && fields.suggested_name.length > 0 && !ID_PATTERN.test(fields.suggested_name)) {
      console.warn(`[${PKG_NAME}] skipping candidate file with an invalid suggested_name: ${entry.name}`);
      continue;
    }

    results.push({ fields, body: parsed.body.trim(), filePath, mtimeMs: stat.mtimeMs });
  }
  return results;
}

export async function findCandidateById(dir, id) {
  const all = await loadCandidates(dir);
  return all.find((candidate) => candidate.fields.id === id) ?? null;
}

export function candidateCounts(candidates) {
  const counts = { proposed: 0, installed: 0, archived: 0 };
  for (const candidate of candidates) {
    if (Object.hasOwn(counts, candidate.fields.status)) counts[candidate.fields.status] += 1;
  }
  return counts;
}

// Shared by the "re-running evolve must not duplicate" rule (maintain.js)
// and by nothing else yet; a fraction of the *smaller* side matched,
// mirroring lib/inject.js's significantWordOverlapRatio convention for
// every other "do these two things count as the same thing" check in
// this codebase.
export function memberOverlapRatio(a, b) {
  const setA = new Set(a ?? []);
  const setB = new Set(b ?? []);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const id of setA) {
    if (setB.has(id)) shared += 1;
  }
  return shared / Math.min(setA.size, setB.size);
}

// -------------------------------------------------------- kind selection

export function selectCandidateKind(cluster) {
  const combined = cluster.map((item) => `${item.fields.trigger ?? ""} ${item.fields.summary ?? ""}`).join(" ");
  if (DELEGATION_PATTERN.test(combined)) return "agent";
  const size = cluster.length;
  if (size <= RULE_MAX_MEMBERS) return "rule";
  if (size <= COMMAND_MAX_MEMBERS) {
    const summaries = cluster.map((item) => item.fields.summary ?? "").join(" ");
    return RUN_CHECK_VERB_PATTERN.test(summaries) ? "command" : "skill";
  }
  return "skill";
}

export function buildCandidateId(domain, memberIds) {
  const ids = [...memberIds].sort();
  const hash = crypto.createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 8);
  return `${slugify(domain)}-${hash}`;
}

export function buildSuggestedName(domain, kind, existingCandidates) {
  const base = slugify(domain);
  const used = new Set(existingCandidates.filter((candidate) => candidate.fields.kind === kind).map((candidate) => candidate.fields.suggested_name));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function buildCandidateSummary(domain, cluster) {
  const summaries = cluster
    .map((item) => item.fields.summary || item.fields.trigger)
    .filter(Boolean)
    .slice(0, 3);
  return `Capture and apply the ${domain} patterns observed across this project: ${summaries.join("; ")}.`;
}

function memberLines(cluster) {
  return cluster.map((item) => `- ${item.fields.summary || item.fields.trigger || item.fields.id}`);
}

// The drafted artefact itself, with its own kind-appropriate frontmatter
// (skill: name+description; command/agent: description) or, for a rule,
// no frontmatter at all (just the 1-3 line snippet). `generated_by` and
// `members` are never part of this draft: injectGeneratedMarkers (below)
// adds those only once the draft is actually copied to a real install
// path, so the stored candidate file's own body always matches exactly
// what would be installed verbatim.
export function renderCandidateBody(kind, domain, cluster, suggestedName) {
  const title = titleCase(domain);
  const description = buildCandidateSummary(domain, cluster);
  const lines = memberLines(cluster);

  if (kind === "rule") {
    return `${lines.slice(0, RULE_MAX_MEMBERS).join("\n")}\n`;
  }
  if (kind === "command") {
    return [
      "---",
      `description: ${yamlQuote(description)}`,
      "---",
      "",
      `Follow these learned ${domain} steps:`,
      "",
      ...lines,
      "",
    ].join("\n");
  }
  if (kind === "agent") {
    return [
      "---",
      `description: ${yamlQuote(description)}`,
      "mode: subagent",
      "---",
      "",
      `# ${title} specialist`,
      "",
      "Responsibilities:",
      "",
      ...lines,
      "",
    ].join("\n");
  }
  // skill
  return [
    "---",
    `name: ${suggestedName}`,
    `description: ${yamlQuote(description)}`,
    "---",
    "",
    `# ${title} patterns`,
    "",
    "## Rules",
    "",
    ...lines,
    "",
  ].join("\n");
}

// ------------------------------------------------------------- install targets

// `~` expansion followed by an absolute-path requirement: a relative
// value is ambiguous (relative to what? the project directory? the
// process cwd?), so it is rejected with a once-per-label warning and the
// real default is used instead, the same defensive pattern
// lib/homunculus-dir.js's own `dataDir` option already uses.
const warnedRelativeEvolveTargets = new Set();
function expandHome(value, label) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const home = process.env.HOME ?? os.homedir();
  const expanded = value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
  if (!path.isAbsolute(expanded)) {
    if (!warnedRelativeEvolveTargets.has(label)) {
      warnedRelativeEvolveTargets.add(label);
      console.warn(`[${PKG_NAME}] evolve.targets.${label} must be an absolute path (after ~ expansion: '${expanded}'); using the default instead`);
    }
    return undefined;
  }
  return expanded;
}

// `options.evolve.targets` overrides any of the four base locations
// (an absolute directory for skill/command/agent, an absolute file path
// for rule); unset or non-absolute ones fall back to the real
// `~/.config/opencode/...` locations. Resolved once per call rather than
// cached: cheap, and lets a test (or a live config reload) change
// targets without stale state.
export function resolveEvolveTargets(options = {}) {
  const configured = options.evolve?.targets ?? {};
  const base = path.join(os.homedir(), ".config", "opencode");
  return {
    skillDir: expandHome(configured.skill, "skill") || path.join(base, "skills"),
    commandDir: expandHome(configured.command, "command") || path.join(base, "commands"),
    agentDir: expandHome(configured.agent, "agent") || path.join(base, "agents"),
    // No built-in default: callers resolve the project's own AGENTS.md
    // (project.root, falling back to ctx.location.directory) themselves,
    // since that path depends on which project is asking, not on this
    // plugin's own config.
    ruleFile: expandHome(configured.rule, "rule") || null,
  };
}

export function installPathFor(kind, suggestedName, targets) {
  if (kind === "skill") return path.join(targets.skillDir, suggestedName, "SKILL.md");
  if (kind === "command") return path.join(targets.commandDir, `${suggestedName}.md`);
  if (kind === "agent") return path.join(targets.agentDir, `${suggestedName}.md`);
  return null;
}

export function resolveRuleFile(targets, projectRoot) {
  return targets.ruleFile || (projectRoot ? path.join(projectRoot, "AGENTS.md") : null);
}

// -------------------------------------------------------------- markers

export function hashContent(text) {
  return crypto.createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

// Line splitting that preserves whichever line ending the file already
// uses (CRLF if any `\r\n` is found anywhere, LF otherwise), so editing
// an AGENTS.md that happens to use CRLF never leaves a mixed-ending file
// behind. Round-trips exactly: splitLines/joinLines on unmodified input
// always reproduces the original bytes.
function splitLines(content) {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  return { lines: content.split(/\r\n|\n/), eol };
}
function joinLines(lines, eol) {
  return lines.join(eol);
}

// Exact match only: `fields.generated_by` must equal this plugin's own
// marker string, and (when given) `candidateId`/`projectId` must match
// the specific candidate asking. A substring test over the whole file
// (frontmatter *and* body) used to let a hand-written file whose prose
// merely mentions "generated_by: mighty-instincts" be mistaken for ours,
// and let one candidate's installed file be mistaken for another's (or
// another project's) just because both happened to carry our marker
// text somewhere. `candidateId`/`projectId` are optional only for the
// generic "is this file ours at all, regardless of which candidate"
// question (scanHandWrittenAssets below, which only needs to exclude
// our own output from its hand-written-asset report).
export function isGeneratedByUs(content, candidateId, projectId) {
  const parsed = parseCandidateFrontmatter(content);
  if (!parsed) return false;
  const fields = parsed.fields;
  if (fields.generated_by !== GENERATED_BY_MARKER) return false;
  if (candidateId !== undefined && fields.candidate_id !== candidateId) return false;
  if (projectId !== undefined && fields.project_id !== projectId) return false;
  return true;
}

// Inserts `generated_by:`/`candidate_id:`/`project_id:`/`members:` just
// before the draft's own closing `---`, for a skill/command/agent
// artefact (every one of those drafts starts with its own frontmatter
// block, built by renderCandidateBody above). Falls back to wrapping the
// body in a minimal frontmatter block of its own on the
// (should-never-happen) case that it does not.
export function injectGeneratedMarkers(body, { candidateId, projectId, members } = {}) {
  const lines = String(body ?? "").split("\n");
  const extra = [
    `generated_by: ${GENERATED_BY_MARKER}`,
    `candidate_id: ${candidateId}`,
    `project_id: ${projectId}`,
    `members: [${(members ?? []).join(", ")}]`,
  ];
  if (lines[0]?.trim() !== "---") {
    return ["---", ...extra, "---", "", ...lines].join("\n");
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return body;
  lines.splice(end, 0, ...extra);
  return lines.join("\n");
}

// Each rule candidate's AGENTS.md snippet is bracketed by its own start
// and end marker (rather than the old "marker line, then consume until
// the next blank line" scheme), so removing one candidate's block can
// never eat into whatever happens to follow it, generated by another
// candidate or typed by a human. `project_id` rides on the start marker
// only: pairing a start with its end only ever needs `candidate_id`
// (there is exactly one end marker per candidate_id at a time), and the
// ownership question ("is this block ours for *this* candidate/project")
// only ever gets asked at the start marker.
function ruleStartMarker(id, projectId) {
  return `<!-- generated_by: ${GENERATED_BY_MARKER} candidate_id: ${id} project_id: ${projectId} -->`;
}
function ruleEndMarker(id) {
  return `<!-- /generated_by: ${GENERATED_BY_MARKER} candidate_id: ${id} -->`;
}
function ruleStartPattern(id) {
  return new RegExp(`^<!--\\s*generated_by:\\s*${escapeRegExp(GENERATED_BY_MARKER)}\\s+candidate_id:\\s*${escapeRegExp(id)}\\b`);
}
function ruleEndPattern(id) {
  return new RegExp(`^<!--\\s*/generated_by:\\s*${escapeRegExp(GENERATED_BY_MARKER)}\\s+candidate_id:\\s*${escapeRegExp(id)}\\b`);
}
function ruleStartProjectId(line) {
  const match = /project_id:\s*(\S+?)\s*-->/.exec(line);
  return match ? match[1] : null;
}

// Appends one bracketed block (start marker, the 1-3 line snippet, end
// marker) under RULE_HEADING, creating the heading (and, for an
// otherwise-empty file, the heading is all the file gets) when this is
// the first rule candidate installed. Idempotent: if a block for this
// `id` already exists anywhere in the file, the content is returned
// unchanged rather than appending a second copy (a retried install,
// e.g. after a crash between this write and the candidate's own status
// flip, must never duplicate the block). Every entry collects right
// after the heading rather than wherever the file happened to end, so a
// human skimming AGENTS.md finds them all in one place; nothing that
// already existed in the file (including its own blank lines, anywhere
// else in the file) is ever altered or removed.
export function appendRuleBlock(agentsContent, id, projectId, snippetBody) {
  const { lines, eol } = splitLines(String(agentsContent ?? ""));
  if (lines.some((line) => ruleStartPattern(id).test(line.trim()))) {
    return joinLines(lines, eol);
  }

  const block = [ruleStartMarker(id, projectId), ...String(snippetBody).trim().split("\n"), ruleEndMarker(id)];
  const headingIndex = lines.findIndex((line) => line.trim() === RULE_HEADING);

  if (headingIndex === -1) {
    const result = lines.slice();
    const isEmptyFile = result.length === 1 && result[0] === "";
    if (!isEmptyFile) result.push("", "");
    result.push(RULE_HEADING, "", ...block, "");
    return joinLines(result, eol);
  }

  const result = lines.slice();
  let insertAt = headingIndex + 1;
  while (insertAt < result.length && result[insertAt].trim() === "") insertAt += 1;
  result.splice(insertAt, 0, "", ...block);
  return joinLines(result, eol);
}

// Locates the bracketed block appendRuleBlock wrote for `id` (if any)
// and reports whether it is genuinely ours (project_id matches) and the
// hash of exactly the snippet lines between its markers, without
// mutating anything; removeRuleBlock (below) does the actual removal,
// called only once the caller (uninstallCandidateArtifact) has used
// this to decide it is safe to.
function checkRuleOwnership(content, id, expectedProjectId) {
  const { lines, eol } = splitLines(String(content ?? ""));
  const startIndex = lines.findIndex((line) => ruleStartPattern(id).test(line.trim()));
  if (startIndex === -1) return { found: false, ownedByUs: false, hash: null };

  const actualProjectId = ruleStartProjectId(lines[startIndex]);
  let endIndex = -1;
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (ruleEndPattern(id).test(lines[i].trim())) {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) return { found: true, ownedByUs: false, hash: null };

  const ownedByUs = expectedProjectId === undefined || actualProjectId === expectedProjectId;
  const hash = hashContent(lines.slice(startIndex + 1, endIndex).join(eol));
  return { found: true, ownedByUs, hash };
}

// Removes exactly the bracketed block for `id` (start marker through end
// marker, inclusive) plus one adjacent blank line (the separator
// appendRuleBlock always adds before a block), leaving every other
// entry, the heading itself, and everything else in the file completely
// untouched. Ownership and hash checks happen in the caller
// (uninstallCandidateArtifact), via checkRuleOwnership above, before
// this is ever called: this function only performs the removal once
// that has already been decided safe.
export function removeRuleBlock(agentsContent, id) {
  const { lines, eol } = splitLines(String(agentsContent ?? ""));
  const startIndex = lines.findIndex((line) => ruleStartPattern(id).test(line.trim()));
  if (startIndex === -1) return { content: agentsContent, removed: false };

  let endIndex = -1;
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (ruleEndPattern(id).test(lines[i].trim())) {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) return { content: agentsContent, removed: false };

  let deleteStart = startIndex;
  let deleteEnd = endIndex + 1;
  if (deleteStart > 0 && lines[deleteStart - 1].trim() === "") deleteStart -= 1;
  else if (deleteEnd < lines.length && lines[deleteEnd].trim() === "") deleteEnd += 1;

  const result = lines.slice();
  result.splice(deleteStart, deleteEnd - deleteStart);
  return { content: joinLines(result, eol), removed: true };
}

// Writes `content` to `filePath` atomically: realpath resolves the file
// (or, when it does not exist yet, its parent directory) first, so a
// symlinked AGENTS.md is written through to its real target, in the
// real directory, rather than replacing the symlink itself; the tmp file
// is created beside that real file and renamed into place, the same
// write-then-rename pattern lib/store.js's writeInstinct already uses
// for instinct files.
export async function atomicWriteAgentsFile(filePath, content) {
  let realFile;
  try {
    realFile = await fs.realpath(filePath);
  } catch {
    try {
      realFile = path.join(await fs.realpath(path.dirname(filePath)), path.basename(filePath));
    } catch {
      realFile = filePath;
    }
  }
  const dir = path.dirname(realFile);
  const tmp = path.join(dir, `.${path.basename(realFile)}.tmp-${uniqueSuffix()}`);
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, realFile);
}

// ------------------------------------------------------------- uninstall

// Shared by /evolve-archive (lib/commands.js) and pruneCandidatesStep's
// auto mode (lib/maintain.js): removes whatever /evolve-install wrote
// for this candidate. Refuses (removed: false, blocked: true) in three
// distinct cases, reported in `reason`: `"symlink"` (the target is a
// symlink, never followed or replaced), `"not-owned"` (the file's own
// marker does not match this candidate's id/project, so it was either
// never written by us or belongs to a different candidate entirely,
// possibly from another project sharing the same install directory),
// and `"edited"` (the marker matches, but the content no longer hashes
// to what was actually installed, i.e. a human has edited it since).
// A missing file (already removed by hand) is reported as removed:
// false, blocked: false, reason: "missing": there is nothing left to
// refuse, and nothing left to do either.
export async function uninstallCandidateArtifact(candidate, targets, { ruleProjectRoot } = {}) {
  const { kind, suggested_name: suggestedName, id, project_id: projectId, installed_hash: installedHash } = candidate.fields;

  if (kind === "rule") {
    const ruleFile = resolveRuleFile(targets, ruleProjectRoot);
    if (!ruleFile) return { removed: false, blocked: false, reason: "missing", path: null };
    let content;
    try {
      content = await fs.readFile(ruleFile, "utf8");
    } catch {
      return { removed: false, blocked: false, reason: "missing", path: ruleFile };
    }
    const ownership = checkRuleOwnership(content, id, projectId);
    if (!ownership.found) return { removed: false, blocked: false, reason: "missing", path: ruleFile };
    if (!ownership.ownedByUs) return { removed: false, blocked: true, reason: "not-owned", path: ruleFile };
    if (installedHash && ownership.hash !== installedHash) {
      return { removed: false, blocked: true, reason: "edited", path: ruleFile };
    }
    const result = removeRuleBlock(content, id);
    if (result.removed) await atomicWriteAgentsFile(ruleFile, result.content);
    return { removed: result.removed, blocked: false, reason: null, path: ruleFile };
  }

  const targetPath = installPathFor(kind, suggestedName, targets);
  if (!targetPath) return { removed: false, blocked: false, reason: "missing", path: null };

  let lstat;
  try {
    lstat = await fs.lstat(targetPath);
  } catch {
    return { removed: false, blocked: false, reason: "missing", path: targetPath };
  }
  if (lstat.isSymbolicLink()) return { removed: false, blocked: true, reason: "symlink", path: targetPath };

  const content = await fs.readFile(targetPath, "utf8");
  if (!isGeneratedByUs(content, id, projectId)) return { removed: false, blocked: true, reason: "not-owned", path: targetPath };
  if (installedHash && hashContent(content) !== installedHash) {
    return { removed: false, blocked: true, reason: "edited", path: targetPath };
  }

  await fs.unlink(targetPath);
  if (kind === "skill") {
    // Best-effort: drop the now-empty <skills>/<name>/ directory
    // SKILL.md lived in, never the shared skills/ root itself.
    try {
      await fs.rmdir(path.dirname(targetPath));
    } catch {
      // Not empty (unlikely for a one-file skill draft) or already gone.
    }
  }
  return { removed: true, blocked: false, reason: null, path: targetPath };
}

export async function scanHandWrittenAssets(targets, usage, unusedDays, nowMs = Date.now()) {
  const windowMs = Math.max(1, Number(unusedDays) || 30) * 86400000;
  const results = [];

  for (const entry of await safeReaddir(targets.skillDir)) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(targets.skillDir, entry.name, "SKILL.md");
    const content = await safeReadFile(skillPath);
    if (content === null || isGeneratedByUs(content)) continue;
    if (isUnusedEntry(usage.skills?.[entry.name], windowMs, nowMs)) {
      results.push({ kind: "skill", name: entry.name, path: skillPath });
    }
  }

  for (const { kind, dir, bucket } of [
    { kind: "command", dir: targets.commandDir, bucket: "commands" },
    { kind: "agent", dir: targets.agentDir, bucket: "agents" },
  ]) {
    for (const entry of await safeReaddir(dir)) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const name = entry.name.slice(0, -3);
      const filePath = path.join(dir, entry.name);
      const content = await safeReadFile(filePath);
      if (content === null || isGeneratedByUs(content)) continue;
      if (isUnusedEntry(usage[bucket]?.[name], windowMs, nowMs)) {
        results.push({ kind, name, path: filePath });
      }
    }
  }

  return results;
}

// Unlike findUnusedInstalled above, a hand-written asset has no
// `installed_at` of ours to grant a grace period from: it is reported as
// soon as usage.json shows no use within the window, never used at all
// included.
function isUnusedEntry(entry, windowMs, nowMs) {
  const lastMs = entry?.last ? Date.parse(entry.last) : NaN;
  return !(Number.isFinite(lastMs) && nowMs - lastMs < windowMs);
}

async function safeReaddir(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeReadFile(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

// "0 uses in `unusedDays` days": never used at all, or last used before
// the window; and only once the candidate itself has been installed for
// at least that long, so a same-day install is never flagged before it
// has had any real chance to be used.
export function findUnusedInstalled(candidates, usage, unusedDays, nowMs = Date.now()) {
  const windowMs = Math.max(1, Number(unusedDays) || 30) * 86400000;
  return candidates.filter((candidate) => {
    if (candidate.fields.status !== "installed") return false;
    const bucket = usageBucketForKind(candidate.fields.kind);
    if (!bucket) return false; // rule candidates have no runtime usage signal.

    const installedAtMs = Date.parse(candidate.fields.installed_at);
    if (!Number.isFinite(installedAtMs) || nowMs - installedAtMs < windowMs) return false;

    const entry = usage?.[bucket]?.[candidate.fields.suggested_name];
    const lastMs = entry?.last ? Date.parse(entry.last) : NaN;
    const usedWithinWindow = Number.isFinite(lastMs) && nowMs - lastMs < windowMs;
    return !usedWithinWindow;
  });
}
