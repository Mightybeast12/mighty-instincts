// Installs (and undoes) the skill copies a scheduled or manual skill
// review (lib/review.js's buildReviewPrompt) stages under
// `<root>/skill-updates/<id>/` and records as a "## <id> (...): ..."
// heading in `<root>/skill-updates/PENDING.md`. Every exported function
// here is pure over a root path (reads/writes only inside it, through an
// explicit argument, never a module-level cache), so smoke/maintain.mjs
// can run the whole install/undo cycle against a throwaway fixture tree
// instead of the real, shared task-observer workspace.
//
// The real PENDING.md predates this module (see skill-updates/PENDING.md
// in the live task-observer workspace) and reads as prose: one heading
// per staged batch, a free-text "What"/"Install" body, and a status
// phrase after the heading's own colon ("staged, not installed",
// "installed 2026-10-17 10:08, nothing pending", "superseded, not
// installed", "consumed"). parsePending below has to tell "staged" apart
// from "already handled" over that prose without board-observations.js's
// own EXCLUDED_HEADING shortcut (`/\b(installed|consumed|superseded)\b/i`
// against the *whole* heading line): that regex also fires on "not
// installed", so it misreads every real "staged, not installed" entry as
// already done (confirmed against the live workspace: it currently
// reports 0 staged there, not 2). This module's own DONE_STATUS instead
// only matches a status phrase that *starts with* one of those words,
// which both real "already handled" phrasings satisfy and no real
// "staged, not installed" phrasing does; an explicit `[installed ...]`/
// `[undone ...]` tag (this module's own append-only annotation, see
// appendPendingAnnotation) always wins over that fallback once present,
// so an installed-then-undone entry is correctly staged again.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { uniqueSuffix } from "./store.js";

const HEADING_LINE = /^##[ \t]+(.+)$/;
// `<id>` is the heading's first whitespace-delimited token (every real
// id, date-only or date-suffixed like "2026-10-17-slice1-approved-303",
// has no spaces of its own); an optional "(<description>)" follows, then
// ":" and the free-text status phrase.
const ENTRY_HEADING = /^(\S+)(?:\s*\(([^)]*)\))?\s*:\s*(.*)$/;
// `entry.id` feeds path.join(root, "skill-updates", entry.id) in
// planInstall below; a heading id must match this (never "..", "/",
// or anything else path.join could resolve outside skill-updates/)
// before planInstall ever builds a path from it.
const VALID_ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// A status phrase that *starts with* one of these words is "already
// handled" in the real file's own convention (see this module's header
// comment for why `\b(installed|...)\b` against the whole line is not
// used here).
const DONE_STATUS = /^(installed|consumed|superseded)\b/i;
// This module's own machine-readable annotation, appended (never
// inserted or rewritten in place) to a heading line by applyInstall/
// undoLast below; `[a-z]+` so a future third kind never silently fails
// to match. Whichever tag appears last in the line wins over
// DONE_STATUS: an undone entry is staged again even though its status
// phrase may itself start with "installed" (mirroring the real file's
// own "installed ..., nothing pending" phrasing, which this module
// never rewrites, only appends past).
const LAST_TAG = /\[(installed|undone) (\S+) by mighty-instincts\]/gi;

const SKILL_FILE_NAME = "SKILL.md";
const INSTALL_LOG_NAME = "skill-updates/backups/.install-log.json";

function todayStamp(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// The real, symlink-resolved skills directory a human actually edits
// (`~/.config/opencode` is commonly a nix store or dotfiles symlink,
// never the live tree itself). Falls back to the unresolved path when
// the realpath lookup fails (missing, or a broken symlink). Re-exported
// from lib/review.js for existing callers; kept here, not there, so
// review.js, this module, and board-observations.js (which imports
// listStaged/parsePending from here) never import each other in a
// circle: this module needs nothing back from either of them.
export async function resolveLiveSkillsDir() {
  const configDir = path.join(os.homedir(), ".config", "opencode");
  try {
    return path.join(await fs.realpath(configDir), "skills");
  } catch {
    return path.join(configDir, "skills");
  }
}

// ------------------------------------------------------------- PENDING.md

// Splits `text` into entries at each "## " heading line, in document
// order. Each entry carries the raw `heading` line text (unparsed, for
// appendPendingAnnotation to rewrite verbatim), its parsed `id`/
// `description`/`status`, the `body` text up to (not including) the next
// heading or end of file, and the character offsets needed to splice a
// rewritten heading back into the whole file.
export function parsePending(text) {
  const source = String(text ?? "");
  const lines = source.split("\n");
  const entries = [];
  let offset = 0;
  let current = null;

  for (const line of lines) {
    const lineStart = offset;
    const lineEnd = offset + line.length; // excludes the line's own newline
    offset = lineEnd + 1; // account for the newline this split consumed

    const headingMatch = HEADING_LINE.exec(line);
    if (headingMatch) {
      if (current) current.bodyEnd = lineStart;
      const meta = ENTRY_HEADING.exec(headingMatch[1]);
      current = {
        heading: line,
        headingStart: lineStart,
        headingEnd: lineEnd,
        id: meta ? meta[1] : headingMatch[1].trim(),
        description: meta && meta[2] !== undefined ? meta[2] : null,
        status: meta ? meta[3].trim() : "",
        bodyStart: lineEnd + 1,
        bodyEnd: source.length,
      };
      entries.push(current);
      continue;
    }
    if (current) current.bodyEnd = source.length;
  }

  for (const entry of entries) {
    entry.body = source.slice(entry.bodyStart, Math.min(entry.bodyEnd, source.length)).replace(/\n$/, "");
    entry.staged = isStagedHeading(entry.heading, entry.status);
    delete entry.bodyStart;
    delete entry.bodyEnd;
  }
  return entries;
}

function isStagedHeading(heading, status) {
  let lastTag = null;
  for (const match of heading.matchAll(LAST_TAG)) lastTag = match[1].toLowerCase();
  if (lastTag === "installed") return false;
  if (lastTag === "undone") return true;
  return !DONE_STATUS.test(status);
}

// Appends `[<kind> <date> by mighty-instincts]` to the heading line of
// the entry whose id is `entryId`, leaving every other byte of `text`
// (including that entry's own body) untouched. Returns the original
// text unchanged (not a copy with no effect masked as success) when no
// entry matches, so a caller can tell "nothing to annotate" apart from
// "annotated".
export function appendPendingAnnotation(text, entryId, kind, date) {
  const entries = parsePending(text);
  const entry = entries.find((candidate) => candidate.id === entryId);
  if (!entry) return text;
  const tagged = `${entry.heading} [${kind} ${date} by mighty-instincts]`;
  return text.slice(0, entry.headingStart) + tagged + text.slice(entry.headingEnd);
}

// Numbers the currently staged entries, in document order (the same
// order /skill-review install prints them in; "install <n>" refers back
// to this same numbering).
export function listStaged(entries) {
  return entries.filter((entry) => entry.staged).map((entry, index) => ({ number: index + 1, entry }));
}

// --------------------------------------------------------------- planning

const SEED_README_PATTERN = /`([\w./-]*\.pre-[\w.-]+)`/g;

async function isDirWithSkillFile(dir) {
  try {
    const stat = await fs.stat(path.join(dir, SKILL_FILE_NAME));
    return stat.isFile();
  } catch {
    return false;
  }
}

// The staged skill copies for `entry`: every subdirectory of
// `<root>/skill-updates/<entry.id>/` that is not `bundles`, is not itself
// a seed snapshot (`<skill>.pre-*`), and holds a SKILL.md directly.
async function listStagedSkills(batchDir) {
  let dirEntries;
  try {
    dirEntries = await fs.readdir(batchDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = [];
  for (const dirEntry of dirEntries) {
    if (!dirEntry.isDirectory() || dirEntry.name === "bundles" || dirEntry.name.includes(".pre-")) continue;
    if (await isDirWithSkillFile(path.join(batchDir, dirEntry.name))) skills.push(dirEntry.name);
  }
  return skills.sort();
}

// A per-skill "Install" instruction clause names the seed snapshot a
// batch README considers authoritative, which is not always the one
// that happens to live in this same batch directory: the real
// 2026-11-01/verification-planning round is staged on top of the still-
// uninstalled 2026-10-25 round, so the README's own Install clause names
// a seed one batch back (`../2026-10-25/verification-planning.pre-slice1`,
// the original, never-installed base), while this round's own local
// `verification-planning.pre-2026-11-01` is round 2's own diff baseline
// (round 1's already-*staged* text). Scans for the literal `<skill>:`
// clause (one instruction line per skill, as in a batch README's own
// "## Install" section, or several skills run together in one
// PENDING.md sentence, as in the real 2026-11-01 entry's own body) and
// returns the first backtick-quoted `.pre-` path inside it, bounded by
// whichever comes first: the next sibling skill's own "<skill>:"
// clause, a blank line, a heading, or 500 characters.
const INSTALL_HEADING = /^#{1,3}\s*install\b.*$/im;

function clauseEnd(text, start, otherSkills) {
  let end = text.length;
  for (const other of otherSkills) {
    const pattern = new RegExp(`\\b${escapeRegExp(other)}:`);
    const match = pattern.exec(text.slice(start));
    if (match) end = Math.min(end, start + match.index);
  }
  const blankLine = text.slice(start).search(/\n[ \t]*\n/);
  if (blankLine !== -1) end = Math.min(end, start + blankLine);
  const heading = text.slice(start).search(/\n#{1,3}\s/);
  if (heading !== -1) end = Math.min(end, start + heading);
  return Math.min(end, start + 500);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSeedFromInstallClause(text, skill, otherSkills) {
  const startPattern = new RegExp(`\\b${escapeRegExp(skill)}:`, "g");
  for (const match of text.matchAll(startPattern)) {
    const start = match.index + match[0].length;
    const clause = text.slice(start, clauseEnd(text, start, otherSkills));
    const pathMatch = /`([\w./-]*\.pre-[\w.-]+)`/.exec(clause);
    if (pathMatch) return pathMatch[1];
  }
  return null;
}

// A single-skill entry's own "## Install"/"Install:" text (or, failing
// that, the whole combined text) with no per-skill "<skill>:" prefix at
// all, e.g. the real 2026-10-25 entry's "Install: copy
// `verification-planning/SKILL.md` over the live file..." (which never
// names a `.pre-` path itself; collectSeedCandidates's own local-sibling
// source below covers that case instead).
function extractSeedFromInstallSection(text, skill) {
  const headingMatch = INSTALL_HEADING.exec(text);
  const sectionText = headingMatch ? text.slice(headingMatch.index).split(/\n#{1,3}\s+\S/)[0] : text;
  const pathMatch = [...sectionText.matchAll(SEED_README_PATTERN)].find((match) => match[1].includes(`${skill}.pre-`));
  return pathMatch ? pathMatch[1] : null;
}

// Every `.pre-*` snapshot `skill` could plausibly need verifying against,
// in the order they are found (a per-skill Install clause, the wider
// Install section, any other backtick-quoted `.pre-` mention anywhere in
// the combined README/PENDING text, then a local `<skill>.pre-*` sibling
// in this same batch), deduplicated and resolved to an existing
// directory. planInstall below does the actual "which one equals live"
// decision: collecting every candidate here, instead of returning the
// first one that merely exists (the old, three-heuristic version of
// this), is what makes `/skill-review install all` converge when a
// later round is staged on top of an earlier, still-uninstalled one
// (installing the earlier round moves live onto a *different* snapshot,
// which the later round also needs to recognise, not just its README's
// first guess).
async function collectSeedCandidates(entry, batchDir, skill, otherSkills) {
  let readmeText = "";
  try {
    readmeText = await fs.readFile(path.join(batchDir, "README.md"), "utf8");
  } catch {
    // No README to fall back to; the entry's own PENDING.md body (already
    // in `entry.body`, read by the caller) is still searched below.
  }
  const combined = `${readmeText}\n${entry.body}`;

  const relativePaths = [];
  const seen = new Set();
  const add = (relativePath) => {
    if (!relativePath || seen.has(relativePath)) return;
    seen.add(relativePath);
    relativePaths.push(relativePath);
  };

  add(extractSeedFromInstallClause(combined, skill, otherSkills));
  add(extractSeedFromInstallSection(combined, skill));
  for (const match of combined.matchAll(SEED_README_PATTERN)) {
    if (match[1].includes(`${skill}.pre-`)) add(match[1]);
  }

  let siblings;
  try {
    siblings = await fs.readdir(batchDir, { withFileTypes: true });
  } catch {
    siblings = [];
  }
  const localMatch = siblings.find((candidate) => candidate.isDirectory() && candidate.name.startsWith(`${skill}.pre-`));
  if (localMatch) add(localMatch.name);

  const resolved = [];
  for (const relativePath of relativePaths) {
    const dir = path.resolve(batchDir, relativePath);
    if (await isDirWithSkillFile(dir)) resolved.push(dir);
  }
  return resolved;
}

function diffLineStats(oldText, newText) {
  const a = String(oldText ?? "").split("\n");
  const b = String(newText ?? "").split("\n");
  const rows = a.length + 1;
  const cols = b.length + 1;
  const lengths = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = rows - 2; i >= 0; i--) {
    for (let j = cols - 2; j >= 0; j--) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const commonLength = lengths[0][0];
  return { added: b.length - commonLength, removed: a.length - commonLength };
}

async function readTextOrNull(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function summarizeMismatch(seedContent, liveContent) {
  if (seedContent === null) return "no seed snapshot to compare against";
  if (liveContent === null) return "the live file does not exist";
  const { added, removed } = diffLineStats(seedContent, liveContent);
  return `live differs from the seed snapshot: +${added}/-${removed} lines`;
}

// Builds the install plan for one staged PENDING.md `entry`: for every
// skill copy it stages, whether the live file still matches a seed
// snapshot it could have been staged against (never install over a live
// file someone edited by hand since staging) and, when it does, the
// lines-added/lines-removed the staged copy would actually change.
// Never writes anything; applyInstall below is the only function that
// does.
//
// `liveSkillsDir` is a test seam only (smoke/maintain.mjs points it at a
// fixture instead of the real resolveLiveSkillsDir): every real caller
// omits it and gets the real, symlink-resolved skills directory.
// os.homedir() itself is not a safe override point for this (Bun, unlike
// Node, ignores a reassigned process.env.HOME and still returns the
// real OS home directory), so this is an explicit parameter rather than
// an environment variable.
export async function planInstall(root, entry, { liveSkillsDir } = {}) {
  if (!VALID_ENTRY_ID.test(entry.id)) {
    return { id: entry.id, skills: [], ok: false, reason: "invalid entry id: refuses to build a path from it" };
  }

  const batchDir = path.join(root, "skill-updates", entry.id);
  const skillsDir = liveSkillsDir ?? (await resolveLiveSkillsDir());
  const skillNames = await listStagedSkills(batchDir);
  const skills = [];

  for (const skill of skillNames) {
    const stagedFile = path.join(batchDir, skill, SKILL_FILE_NAME);
    const otherSkills = skillNames.filter((candidate) => candidate !== skill);
    const liveFile = path.join(skillsDir, skill, SKILL_FILE_NAME);
    const [stagedContent, liveContent] = await Promise.all([readTextOrNull(stagedFile), readTextOrNull(liveFile)]);

    const seedDirs = await collectSeedCandidates(entry, batchDir, skill, otherSkills);
    if (seedDirs.length === 0) {
      skills.push({ skill, stagedFile, seedFile: null, liveFile, ok: false, reason: "no seed snapshot found for this skill", diffSummary: null, changeStats: null });
      continue;
    }

    // Accept the first candidate whose content equals live right now;
    // report the mismatch against the first candidate otherwise (its
    // README/PENDING clause is the one actually meant to verify
    // against, when there is more than one).
    let matchedSeedFile = null;
    let firstSeedContent = null;
    for (const seedDir of seedDirs) {
      const seedFile = path.join(seedDir, SKILL_FILE_NAME);
      const seedContent = await readTextOrNull(seedFile);
      if (firstSeedContent === null) firstSeedContent = seedContent;
      if (seedContent !== null && seedContent === liveContent) {
        matchedSeedFile = seedFile;
        break;
      }
    }

    if (!matchedSeedFile) {
      skills.push({
        skill,
        stagedFile,
        seedFile: path.join(seedDirs[0], SKILL_FILE_NAME),
        liveFile,
        ok: false,
        reason: "live file no longer matches the seed snapshot this round was staged against",
        diffSummary: summarizeMismatch(firstSeedContent, liveContent),
        changeStats: null,
      });
      continue;
    }

    skills.push({
      skill,
      stagedFile,
      seedFile: matchedSeedFile,
      liveFile,
      ok: true,
      reason: null,
      diffSummary: null,
      changeStats: diffLineStats(liveContent ?? "", stagedContent ?? ""),
    });
  }

  return { id: entry.id, skills, ok: skills.length > 0 && skills.every((skill) => skill.ok), reason: skills.length === 0 ? "no staged skill copies found" : null };
}

// ------------------------------------------------------------- applying

async function writeFileAtomic(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${uniqueSuffix()}`);
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, filePath);
}

// A backup is written once and only ever read afterward (by undoLast);
// "wx" refuses to overwrite one that already exists, so two installs
// that land in the same backup directory (should never happen, given
// backupDirName's own uniqueness, but this is the actual guarantee, not
// just a naming convention) fail loudly instead of silently destroying
// the first backup, which undoLast would otherwise restore from for the
// *second* install while believing it was the first's.
async function writeFileExclusive(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
}

// One backup directory per install operation, never per calendar date:
// two rounds staging the same skill on the same day (the real
// 2026-10-25 and 2026-11-01 batches both ship verification-planning)
// must never share a backup location, or installing the second
// overwrites the first's backup and a later undo, undo leaves live at
// the first round's content instead of the true original.
function backupDirName(now) {
  return `${now.toISOString().replace(/[:.]/g, "-")}-${uniqueSuffix()}`;
}

function installLogFile(root) {
  return path.join(root, INSTALL_LOG_NAME);
}

async function readInstallLog(root) {
  const raw = await readTextOrNull(installLogFile(root));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeInstallLog(root, operations) {
  await writeFileAtomic(installLogFile(root), `${JSON.stringify(operations, null, 2)}\n`);
}

async function rewritePending(root, entryId, kind, date) {
  const pendingFile = path.join(root, "skill-updates", "PENDING.md");
  const text = (await readTextOrNull(pendingFile)) ?? "";
  await writeFileAtomic(pendingFile, appendPendingAnnotation(text, entryId, kind, date));
}

// Installs every skill in a plan planInstall already found `ok` for
// (refuses the whole entry, writing nothing, when any skill in it is
// not: an entry installs atomically or not at all, never half of its
// skills). For each skill: the live file's current content (already
// proven equal to a seed snapshot by planInstall) is backed up to
// `<root>/skill-updates/backups/<backupDirName>/<skill>/SKILL.md`, then
// the staged copy replaces it. Records the operation (including that
// backup directory name) in this module's own install log (for
// undoLast) and appends the `[installed ...]` annotation to the
// entry's own PENDING.md heading.
export async function applyInstall(root, entry, plan, { now = new Date() } = {}) {
  if (!plan.ok) {
    return { installed: false, reason: "plan is not installable", skills: plan.skills };
  }
  const date = todayStamp(now);
  const backupDir = backupDirName(now);
  const results = [];
  for (const skill of plan.skills) {
    const liveContent = (await readTextOrNull(skill.liveFile)) ?? "";
    const stagedContent = (await readTextOrNull(skill.stagedFile)) ?? "";
    const backupFile = path.join(root, "skill-updates", "backups", backupDir, skill.skill, SKILL_FILE_NAME);
    await writeFileExclusive(backupFile, liveContent);
    await writeFileAtomic(skill.liveFile, stagedContent);
    results.push({ skill: skill.skill, ...skill.changeStats, backupFile, liveFile: skill.liveFile });
  }

  const operations = await readInstallLog(root);
  operations.push({ installedAt: now.toISOString(), date, backupDir, entryId: entry.id, skills: plan.skills.map((skill) => skill.skill) });
  await writeInstallLog(root, operations);
  await rewritePending(root, entry.id, "installed", date);

  return { installed: true, date, skills: results };
}

// Restores the most recently installed entry's skills from their
// backups and marks that entry `[undone ...]`. Only ever undoes the
// single most recent install operation (whether it was installed via
// `/skill-review install <n>` or as part of `install all`); a second
// `undo` reaches back to whichever operation is now last, restoring it
// from its own backup directory (so two installs of the same skill
// chain back correctly: undo, undo recovers the original, not the
// first install's result). `last.backupDir` falls back to `last.date`
// for an install logged before per-operation backup directories
// existed. `liveSkillsDir` is the same test seam planInstall accepts,
// for the same reason (os.homedir() is not reliably overridable for a
// test, since Bun ignores a reassigned process.env.HOME).
export async function undoLast(root, { now = new Date(), liveSkillsDir } = {}) {
  const operations = await readInstallLog(root);
  const last = operations.pop();
  if (!last) return { restored: false, reason: "nothing to undo" };

  const skillsDir = liveSkillsDir ?? (await resolveLiveSkillsDir());
  const backupDir = last.backupDir ?? last.date;
  const restored = [];
  for (const skill of last.skills) {
    const backupFile = path.join(root, "skill-updates", "backups", backupDir, skill, SKILL_FILE_NAME);
    const backupContent = await readTextOrNull(backupFile);
    if (backupContent === null) {
      restored.push({ skill, restored: false, reason: `backup missing: ${backupFile}` });
      continue;
    }
    const liveFile = path.join(skillsDir, skill, SKILL_FILE_NAME);
    await writeFileAtomic(liveFile, backupContent);
    restored.push({ skill, restored: true, liveFile });
  }

  await writeInstallLog(root, operations);
  const date = todayStamp(now);
  await rewritePending(root, last.entryId, "undone", date);

  return { restored: true, entryId: last.entryId, date, skills: restored };
}
