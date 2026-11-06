// lib/commands-maintain.js (/maintain, /promote, /skill-review install|
// undo), lib/review-install.js (parsePending/planInstall/applyInstall/
// undoLast), and lib/review.js's own two P2 changes: a forced
// /skill-review still refuses at 0 open observations, and a scheduled
// (unattended) review's completion notice reaches the newest top-level
// session the host lists.
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { buildMaintenanceCommands } from "../lib/commands-maintain.js";
import { EVOLVE_INTERVAL_MS, MAINTENANCE_DEFAULTS, resolveUnusedDays } from "../lib/maintain.js";
import { resolveProject, siblingInstinctsDir } from "../lib/project.js";
import { writeInstinct } from "../lib/store.js";
import { createReviewController, REVIEW_DEFAULTS } from "../lib/review.js";
import { applyInstall, listStaged, parsePending, planInstall, undoLast } from "../lib/review-install.js";

export async function run(helpers) {
  testMaintainExports({ assert: helpers.assert });
  await testReviewInstallFixture({ assert: helpers.assert, TEMP_ROOT: helpers.TEMP_ROOT });
  await testReviewInstallBackupChaining({ assert: helpers.assert, TEMP_ROOT: helpers.TEMP_ROOT });
  await testReviewInstallAllConverges({ assert: helpers.assert, TEMP_ROOT: helpers.TEMP_ROOT });
  await testSkillReviewInstallAllConverges({ ...helpers });
  await testMaintainDryRun({ ...helpers });
  await testMaintainForcesWeeklyGateOnlyUnderDryRun({ ...helpers });
  await testMaintainPruneOnly({ ...helpers });
  await testPromoteCommand({ ...helpers });
  await testSkillReviewInstallUndo({ ...helpers });
  await testReviewControllerZeroOpenRefusal({ assert: helpers.assert, TEMP_ROOT: helpers.TEMP_ROOT });
  await testReviewControllerCompletionNotice({ ...helpers });
}

// ---------------------------------------------------------------------------
// lib/maintain.js's own P2 exports: EVOLVE_INTERVAL_MS (lib/evolve-command.js
// keeps its own copy today; the orchestrator switches it to this import),
// and resolveUnusedDays (used inside pruneCandidatesStep, and by
// lib/commands-maintain.js's own /maintain reply).
// ---------------------------------------------------------------------------
function testMaintainExports({ assert }) {
  assert.equal(EVOLVE_INTERVAL_MS, 7 * 86400000);
  assert.equal(resolveUnusedDays({}), 30, "default unusedDays when prune.unusedDays is unset");
  assert.equal(resolveUnusedDays({ prune: { unusedDays: 10 } }), 10);
  assert.equal(resolveUnusedDays({ prune: { unusedDays: 0 } }), 30, "0 falls back to the default, same as the Number(...) || default pattern elsewhere in this file");
}

// ---------------------------------------------------------------------------
// lib/review-install.js over a fixture workspace shaped like the real
// task-observer skill-updates/ tree (two staged rounds for the same
// skill, round 2 built on round 1's own still-uninstalled seed):
// parsePending's staged/not-staged read, planInstall's live-vs-seed
// verification (including the cross-batch seed reference round 2 needs),
// applyInstall's backup+copy+PENDING annotation, and undoLast's restore.
// lib/review-install.js's exported functions resolve the live skills
// directory from os.homedir() by default (lib/review.js's
// resolveLiveSkillsDir), but accept a `liveSkillsDir` override for
// exactly this reason: Bun, unlike Node, ignores a reassigned
// process.env.HOME and still returns the real OS home directory, so an
// env-var override would silently point this test at (and risk writing
// into) the real live skills tree under Bun specifically.
// ---------------------------------------------------------------------------
async function testReviewInstallFixture({ assert, TEMP_ROOT }) {
  const root = fsSync.mkdtempSync(path.join(TEMP_ROOT, "review-install-"));
  const liveSkillsDir = path.join(root, "fake-live-skills");
  const liveFile = path.join(liveSkillsDir, "demo-skill", "SKILL.md");

  async function write(filePath, content) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }

  const pendingFile = path.join(root, "skill-updates", "PENDING.md");
  await write(
    pendingFile,
    [
      "# Staged updates manifest",
      "",
      "## 2026-10-25 (demo-skill round 1): staged, not installed",
      "",
      "- Install: copy `demo-skill/SKILL.md` over the live file.",
      "",
      "## 2026-11-01 (demo-skill round 2 on top of round 1): staged, not installed",
      "",
      "- What: round 2, see 2026-11-01/README.md for the Install section.",
      "",
    ].join("\n"),
  );
  await write(path.join(root, "skill-updates", "2026-10-25", "demo-skill.pre-slice1", "SKILL.md"), "line1\nline2\n");
  await write(path.join(root, "skill-updates", "2026-10-25", "demo-skill", "SKILL.md"), "line1\nline2\nline3\n");
  await write(path.join(root, "skill-updates", "2026-11-01", "demo-skill.pre-2026-11-01", "SKILL.md"), "line1\nline2\nline3\n");
  await write(path.join(root, "skill-updates", "2026-11-01", "demo-skill", "SKILL.md"), "line1\nline2\nline3\nline4\n");
  await write(
    path.join(root, "skill-updates", "2026-11-01", "README.md"),
    "# Staged 2026-11-01\n\n## Install\n\ndemo-skill: `diff -rq` live against `../2026-10-25/demo-skill.pre-slice1` (must show no difference), then copy `demo-skill/SKILL.md` over it.\n",
  );
  await write(liveFile, "line1\nline2\n");

  const text = await fs.readFile(pendingFile, "utf8");
  const entries = parsePending(text);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.staged), [true, true], "both rounds parse as staged before anything installs");
  assert.deepEqual(listStaged(entries).map((s) => s.entry.id), ["2026-10-25", "2026-11-01"]);

  // P3: an entry id that could escape skill-updates/ through
  // path.join (e.g. a heading pasted with a slash or ".." in it) is
  // refused before any path is ever built from it.
  const maliciousPlan = await planInstall(root, { id: "../../etc", body: "" }, { liveSkillsDir });
  assert.equal(maliciousPlan.ok, false);
  assert.equal(maliciousPlan.reason, "invalid entry id: refuses to build a path from it");

  // Round 2's own plan must resolve the *cross-batch* seed the README
  // names (round 1's pre-slice1, not round 2's own local snapshot,
  // which is round 1's already-staged text, not what live still equals).
  const plan2 = await planInstall(root, entries[1], { liveSkillsDir });
  assert.equal(plan2.ok, true, `round 2 plan: ${JSON.stringify(plan2)}`);
  assert.ok(plan2.skills[0].seedFile.includes(`${path.sep}2026-10-25${path.sep}`), "round 2 resolves round 1's seed, not its own local one");

  // A live file that no longer matches the seed is refused, with a
  // diff summary, and nothing is written.
  await fs.writeFile(liveFile, "line1\nline2\nhand-edited\n", "utf8");
  const mismatchPlan = await planInstall(root, entries[0], { liveSkillsDir });
  assert.equal(mismatchPlan.ok, false);
  assert.ok(mismatchPlan.skills[0].diffSummary.length > 0, "refusal carries a diff summary");
  await fs.writeFile(liveFile, "line1\nline2\n", "utf8");

  // Install round 1: backup written, live copied, PENDING annotated.
  const plan1 = await planInstall(root, entries[0], { liveSkillsDir });
  assert.equal(plan1.ok, true);
  const installResult = await applyInstall(root, entries[0], plan1, { now: new Date("2026-11-06T12:00:00Z") });
  assert.equal(installResult.installed, true);
  assert.equal(await fs.readFile(liveFile, "utf8"), "line1\nline2\nline3\n", "live now holds the staged content");
  const backupFile = installResult.skills[0].backupFile;
  assert.equal(await fs.readFile(backupFile, "utf8"), "line1\nline2\n", "backup holds the pre-install live content");

  const pendingAfterInstall = await fs.readFile(pendingFile, "utf8");
  assert.ok(pendingAfterInstall.includes("[installed 2026-11-06 by mighty-instincts]"));
  const entriesAfterInstall = parsePending(pendingAfterInstall);
  assert.equal(entriesAfterInstall[0].staged, false, "the installed round no longer lists as staged");
  assert.equal(entriesAfterInstall[1].staged, true, "the other round is unaffected");

  // Undo restores round 1's backup and marks it undone (staged again).
  const undoResult = await undoLast(root, { now: new Date("2026-11-07T08:00:00Z"), liveSkillsDir });
  assert.equal(undoResult.restored, true);
  assert.equal(undoResult.entryId, "2026-10-25");
  assert.equal(await fs.readFile(liveFile, "utf8"), "line1\nline2\n", "live restored to its pre-install content");
  const pendingAfterUndo = await fs.readFile(pendingFile, "utf8");
  assert.ok(pendingAfterUndo.includes("[undone 2026-11-07 by mighty-instincts]"));
  assert.equal(parsePending(pendingAfterUndo)[0].staged, true, "staged again after undo");

  const secondUndo = await undoLast(root, { liveSkillsDir });
  assert.equal(secondUndo.restored, false, "nothing left to undo a second time");
}

// ---------------------------------------------------------------------------
// P1-2: two installs of the same skill, on the same calendar day, must
// never share a backup location. Without a unique backup directory per
// install operation (not just per date), the second install's backup
// write clobbers the first's, and undo, undo would leave live at the
// first install's own result instead of the true original.
// ---------------------------------------------------------------------------
async function testReviewInstallBackupChaining({ assert, TEMP_ROOT }) {
  const root = fsSync.mkdtempSync(path.join(TEMP_ROOT, "review-install-chain-"));
  const liveSkillsDir = path.join(root, "fake-live-skills");
  const liveFile = path.join(liveSkillsDir, "chain-skill", "SKILL.md");

  async function write(filePath, content) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }

  const pendingFile = path.join(root, "skill-updates", "PENDING.md");
  await write(
    pendingFile,
    ["# Staged updates manifest", "", "## batch-a (chain-skill round a): staged, not installed", "", "## batch-b (chain-skill round b): staged, not installed", ""].join("\n"),
  );
  // batch-a's seed is the original live content; batch-b's own seed is
  // whatever live becomes right after batch-a installs.
  await write(path.join(root, "skill-updates", "batch-a", "chain-skill.pre-a", "SKILL.md"), "v0\n");
  await write(path.join(root, "skill-updates", "batch-a", "chain-skill", "SKILL.md"), "v1\n");
  await write(path.join(root, "skill-updates", "batch-b", "chain-skill.pre-b", "SKILL.md"), "v1\n");
  await write(path.join(root, "skill-updates", "batch-b", "chain-skill", "SKILL.md"), "v2\n");
  await write(liveFile, "v0\n");

  const entries = parsePending(await fs.readFile(pendingFile, "utf8"));
  const [entryA] = entries;

  // The exact same instant for both installs: the collision risk a
  // date-only backup directory would hit, and a per-operation one must
  // not.
  const sameInstant = new Date("2026-11-06T12:00:00Z");

  const planA = await planInstall(root, entryA, { liveSkillsDir });
  assert.equal(planA.ok, true, `batch-a plan: ${JSON.stringify(planA)}`);
  await applyInstall(root, entryA, planA, { now: sameInstant, liveSkillsDir });
  assert.equal(await fs.readFile(liveFile, "utf8"), "v1\n", "batch-a installed");

  const entryBAfterA = parsePending(await fs.readFile(pendingFile, "utf8"))[1];
  const planB = await planInstall(root, entryBAfterA, { liveSkillsDir });
  assert.equal(planB.ok, true, `batch-b plan: ${JSON.stringify(planB)}`);
  await applyInstall(root, entryBAfterA, planB, { now: sameInstant, liveSkillsDir });
  assert.equal(await fs.readFile(liveFile, "utf8"), "v2\n", "batch-b installed");

  const log = JSON.parse(await fs.readFile(path.join(root, "skill-updates", "backups", ".install-log.json"), "utf8"));
  assert.equal(log.length, 2);
  assert.notEqual(log[0].backupDir, log[1].backupDir, "two same-instant installs never share a backup directory");

  const undo1 = await undoLast(root, { now: sameInstant, liveSkillsDir });
  assert.equal(undo1.restored, true);
  assert.equal(await fs.readFile(liveFile, "utf8"), "v1\n", "first undo restores what live was right before batch-b installed");

  const undo2 = await undoLast(root, { now: sameInstant, liveSkillsDir });
  assert.equal(undo2.restored, true);
  assert.equal(await fs.readFile(liveFile, "utf8"), "v0\n", "second undo reaches the true original, never clobbered by batch-b's own backup write");
}

// ---------------------------------------------------------------------------
// P2-1: planInstall must accept whichever seed candidate currently
// equals live, not just the first one a README names, or installing a
// round staged on top of an earlier, still-uninstalled one (the real
// 2026-11-01-on-2026-10-25 shape) installs the earlier round and then
// refuses the later one, since installing the earlier round moves live
// off the later round's own first-choice seed.
// ---------------------------------------------------------------------------
async function testReviewInstallAllConverges({ assert, TEMP_ROOT }) {
  const root = fsSync.mkdtempSync(path.join(TEMP_ROOT, "review-install-converge-"));
  const liveSkillsDir = path.join(root, "fake-live-skills");
  const liveFile = path.join(liveSkillsDir, "converge-skill", "SKILL.md");

  async function write(filePath, content) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }

  const pendingFile = path.join(root, "skill-updates", "PENDING.md");
  await write(
    pendingFile,
    [
      "# Staged updates manifest",
      "",
      "## 2026-10-25 (converge-skill round 1): staged, not installed",
      "",
      "- Install: copy `converge-skill/SKILL.md` over the live file.",
      "",
      "## 2026-11-01 (converge-skill round 2 on top of round 1): staged, not installed",
      "",
    ].join("\n"),
  );
  await write(path.join(root, "skill-updates", "2026-10-25", "converge-skill.pre-slice1", "SKILL.md"), "line1\nline2\n");
  await write(path.join(root, "skill-updates", "2026-10-25", "converge-skill", "SKILL.md"), "line1\nline2\nline3\n");
  // Round 2's own local .pre-<date> equals round 1's already-staged text
  // (the real workspace's own shape); its README names round 1's own
  // original seed for live verification instead, one batch back.
  await write(path.join(root, "skill-updates", "2026-11-01", "converge-skill.pre-2026-11-01", "SKILL.md"), "line1\nline2\nline3\n");
  await write(path.join(root, "skill-updates", "2026-11-01", "converge-skill", "SKILL.md"), "line1\nline2\nline3\nline4\n");
  await write(
    path.join(root, "skill-updates", "2026-11-01", "README.md"),
    "# Staged 2026-11-01\n\n## Install\n\nconverge-skill: `diff -rq` live against `../2026-10-25/converge-skill.pre-slice1` (must show no difference), then copy `converge-skill/SKILL.md` over it.\n",
  );
  await write(liveFile, "line1\nline2\n");

  // Round 1 installs first (document order); round 2's plan, computed
  // only afterward, must still find a seed that matches the now-moved
  // live file (its local round-1-staged snapshot), not just refuse
  // because its README's own first-choice seed no longer matches.
  const entries = parsePending(await fs.readFile(pendingFile, "utf8"));
  const plan1 = await planInstall(root, entries[0], { liveSkillsDir });
  assert.equal(plan1.ok, true, `round 1 plan: ${JSON.stringify(plan1)}`);
  await applyInstall(root, entries[0], plan1, { liveSkillsDir });
  assert.equal(await fs.readFile(liveFile, "utf8"), "line1\nline2\nline3\n", "round 1 installed");

  const entry2AfterRound1 = parsePending(await fs.readFile(pendingFile, "utf8"))[1];
  const plan2 = await planInstall(root, entry2AfterRound1, { liveSkillsDir });
  assert.equal(plan2.ok, true, `round 2 plan converges on the local round-1-staged seed once round 1 is installed: ${JSON.stringify(plan2)}`);
  await applyInstall(root, entry2AfterRound1, plan2, { liveSkillsDir });
  assert.equal(await fs.readFile(liveFile, "utf8"), "line1\nline2\nline3\nline4\n", "round 2 installed");

  // Undo chains back through round 2's install, then round 1's, to the
  // true original.
  const undoRound2 = await undoLast(root, { liveSkillsDir });
  assert.equal(undoRound2.entryId, "2026-11-01");
  assert.equal(await fs.readFile(liveFile, "utf8"), "line1\nline2\nline3\n", "first undo restores round 1's installed result");

  const undoRound1 = await undoLast(root, { liveSkillsDir });
  assert.equal(undoRound1.entryId, "2026-10-25");
  assert.equal(await fs.readFile(liveFile, "utf8"), "line1\nline2\n", "second undo restores the true original");
}

// ---------------------------------------------------------------------------
// Same P2-1 convergence scenario, through the actual /skill-review
// install all command (lib/commands-maintain.js's own "install"-loop
// order is document order, same as listStaged): the user-visible
// surface the bug report above was filed against.
// ---------------------------------------------------------------------------
async function testSkillReviewInstallAllConverges({ assert, createPluginHarness, makeProjectAndData, TEMP_ROOT }) {
  const reviewRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "install-all-converge-"));
  const liveSkillsDir = path.join(reviewRoot, "fake-live-skills");
  const liveFile = path.join(liveSkillsDir, "converge-skill", "SKILL.md");

  async function write(filePath, content) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }

  await write(
    path.join(reviewRoot, "skill-updates", "PENDING.md"),
    [
      "# Staged updates manifest",
      "",
      "## 2026-10-25 (converge-skill round 1): staged, not installed",
      "",
      "- Install: copy `converge-skill/SKILL.md` over the live file.",
      "",
      "## 2026-11-01 (converge-skill round 2 on top of round 1): staged, not installed",
      "",
    ].join("\n"),
  );
  await write(path.join(reviewRoot, "skill-updates", "2026-10-25", "converge-skill.pre-slice1", "SKILL.md"), "line1\nline2\n");
  await write(path.join(reviewRoot, "skill-updates", "2026-10-25", "converge-skill", "SKILL.md"), "line1\nline2\nline3\n");
  await write(path.join(reviewRoot, "skill-updates", "2026-11-01", "converge-skill.pre-2026-11-01", "SKILL.md"), "line1\nline2\nline3\n");
  await write(path.join(reviewRoot, "skill-updates", "2026-11-01", "converge-skill", "SKILL.md"), "line1\nline2\nline3\nline4\n");
  await write(
    path.join(reviewRoot, "skill-updates", "2026-11-01", "README.md"),
    "# Staged 2026-11-01\n\n## Install\n\nconverge-skill: `diff -rq` live against `../2026-10-25/converge-skill.pre-slice1` (must show no difference), then copy `converge-skill/SKILL.md` over it.\n",
  );
  await write(liveFile, "line1\nline2\n");

  const { projectDir, dataDir } = makeProjectAndData("install-all-converge-cmd");
  const options = { python: "python3", dataDir, board: { observationsRoot: reviewRoot } };
  const harness = createPluginHarness(projectDir, options);
  const commands = buildMaintenanceCommands(harness.ctx, options, {
    review: { run: async () => {}, status: async () => ({}) },
    liveSkillsDir,
  });
  const skillReviewCmd = commands.find((def) => def.name === "skill-review");

  await skillReviewCmd.execute({ sessionID: "s1", prompt: { text: "install all" } });
  const reply = harness.syntheticCalls.at(-1).text;
  assert.ok(!reply.includes("refused"), `install all converges on both rounds instead of refusing the newer one: ${reply}`);
  assert.equal(await fs.readFile(liveFile, "utf8"), "line1\nline2\nline3\nline4\n", "live ends up holding round 2's content");

  await skillReviewCmd.execute({ sessionID: "s1", prompt: { text: "undo" } });
  assert.equal(await fs.readFile(liveFile, "utf8"), "line1\nline2\nline3\n", "first undo restores round 1's installed result");

  await skillReviewCmd.execute({ sessionID: "s1", prompt: { text: "undo" } });
  assert.equal(await fs.readFile(liveFile, "utf8"), "line1\nline2\n", "second undo restores the true original");
}

// ---------------------------------------------------------------------------
// /maintain --dry-run (lib/commands-maintain.js's buildMaintainCommand):
// logs "would" lines and changes nothing on disk, regardless of
// maintenance.dryRun's own (default false) configured value.
// ---------------------------------------------------------------------------
async function testMaintainDryRun({ assert, createPluginHarness, makeProjectAndData }) {
  const { projectDir, dataDir } = makeProjectAndData("maintain-dry-run");
  const options = { python: "python3", dataDir, maintenance: { ...MAINTENANCE_DEFAULTS, dryRun: false } };
  const harness = createPluginHarness(projectDir, options);
  const project = await resolveProject(harness.ctx, options);

  const pendingDir = siblingInstinctsDir(project, "pending");
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  await writeInstinct(pendingDir, { id: "stale-pending", trigger: "t", confidence: 0.5, domain: "misc", summary: "s", created: daysAgo(40) }, "# Stale\n");

  const maintainCmd = buildMaintenanceCommands(harness.ctx, options, {}).find((def) => def.name === "maintain");
  await maintainCmd.execute({ sessionID: "s1", prompt: { text: "--dry-run" } });

  const reply = harness.syntheticCalls.at(-1).text;
  assert.ok(reply.includes("would"), `dry-run reply should mention 'would': ${reply}`);
  assert.ok(reply.includes("run: promoted"), "the final sweep summary line is included");
  assert.deepEqual(await fs.readdir(pendingDir), ["stale-pending.md"], "dry run deletes nothing");
}

// ---------------------------------------------------------------------------
// /maintain --dry-run's `force` override: a step gated weekly/daily
// (cleanupProjectsStep here) is skipped by a real /maintain while its own
// gate says "not due yet", but still previewed under --dry-run.
// ---------------------------------------------------------------------------
async function testMaintainForcesWeeklyGateOnlyUnderDryRun({ assert, createPluginHarness, makeProjectAndData }) {
  const { projectDir, dataDir } = makeProjectAndData("maintain-force-gate");
  const options = { python: "python3", dataDir, maintenance: { ...MAINTENANCE_DEFAULTS } };
  const harness = createPluginHarness(projectDir, options);
  const project = await resolveProject(harness.ctx, options);
  await fs.mkdir(project.instincts_personal, { recursive: true });

  // A registry entry ready for cleanupProjectsStep to flag: root gone, 0
  // instincts of its own.
  const vanishedRoot = path.join(projectDir, "..", "vanished-cleanup-root");
  await fs.mkdir(path.join(dataDir, "projects", "gone-proj", "instincts", "personal"), { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(
    path.join(dataDir, "projects.json"),
    JSON.stringify({ "gone-proj": { id: "gone-proj", name: "gone", root: vanishedRoot, remote: "", created_at: now, last_seen: now } }),
    "utf8",
  );
  // cleanupProjectsStep was "just" attempted (readMaintenanceSummary's
  // lastCleanupAt), so without `force` it is not due again today.
  await fs.mkdir(project.project_dir, { recursive: true });
  await fs.writeFile(path.join(project.project_dir, "maintenance.log"), `${new Date().toISOString()} cleanup: checked, nothing to remove\n`, "utf8");

  const commands = buildMaintenanceCommands(harness.ctx, options, {});
  const maintainCmd = commands.find((def) => def.name === "maintain");

  await maintainCmd.execute({ sessionID: "s1", prompt: { text: "" } });
  const realRunReply = harness.syntheticCalls.at(-1).text;
  assert.ok(!realRunReply.includes("gone-proj"), `a real /maintain respects today's cleanup gate: ${realRunReply}`);

  await maintainCmd.execute({ sessionID: "s1", prompt: { text: "--dry-run" } });
  const dryRunReply = harness.syntheticCalls.at(-1).text;
  assert.ok(dryRunReply.includes("would archive project gone"), `--dry-run forces the cleanup gate open so the preview still covers it: ${dryRunReply}`);
  assert.ok((await fs.readdir(path.join(dataDir, "projects"))).includes("gone-proj"), "the preview still never actually archives anything");
}

// ---------------------------------------------------------------------------
// /maintain prune [--dry-run]: runs only pruneStep, leaving every other
// step (decay here) untouched.
// ---------------------------------------------------------------------------
async function testMaintainPruneOnly({ assert, createPluginHarness, makeProjectAndData }) {
  const { projectDir, dataDir } = makeProjectAndData("maintain-prune-only");
  const options = { python: "python3", dataDir };
  const harness = createPluginHarness(projectDir, options);
  const project = await resolveProject(harness.ctx, options);

  const pendingDir = siblingInstinctsDir(project, "pending");
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  await writeInstinct(pendingDir, { id: "stale-pending", trigger: "t", confidence: 0.5, domain: "misc", summary: "s", created: daysAgo(40) }, "# Stale\n");

  // Decay-eligible personal instinct (never fired, past the grace
  // period): must survive untouched since only prune should run.
  await writeInstinct(
    project.instincts_personal,
    { id: "decay-candidate", trigger: "t2", confidence: 0.45, domain: "misc", summary: "s2", fired: 0, created: daysAgo(60), decayed_at: daysAgo(10) },
    "# Decay candidate\n",
  );

  const maintainCmd = buildMaintenanceCommands(harness.ctx, options, {}).find((def) => def.name === "maintain");
  await maintainCmd.execute({ sessionID: "s1", prompt: { text: "prune" } });

  const reply = harness.syntheticCalls.at(-1).text;
  assert.ok(reply.includes("prune: deleted 1"), `prune-only reply: ${reply}`);
  assert.deepEqual(await fs.readdir(pendingDir), [], "the stale pending instinct is gone");
  const decayContentAfter = await fs.readFile(path.join(project.instincts_personal, "decay-candidate.md"), "utf8");
  assert.ok(decayContentAfter.includes("confidence: 0.45"), "decay never ran: confidence is untouched");
  assert.ok(!reply.includes("run: promoted"), "the full sweep's own summary line never appears: only pruneStep ran");
}

// ---------------------------------------------------------------------------
// /promote [--yes]: without --yes previews (lists a qualifying id and
// its reason, writes nothing); with --yes actually promotes; a
// repo-named id is refused by promoteStep itself either way.
// ---------------------------------------------------------------------------
async function testPromoteCommand({ assert, createPluginHarness, makeProjectAndData }) {
  const { projectDir, dataDir } = makeProjectAndData("promote-command");
  const options = { python: "python3", dataDir };
  const harness = createPluginHarness(projectDir, options);

  const personalDir = path.join(dataDir, "projects", "proj-solo", "instincts", "personal");
  await fs.mkdir(personalDir, { recursive: true });
  const now = new Date().toISOString();
  await writeInstinct(
    personalDir,
    { id: "proven-habit", trigger: "always run the full build before tagging a release", confidence: 0.95, domain: "release", summary: "Run the full build.", fired: 4, created: now },
    "# Proven\n",
  );
  await writeInstinct(
    personalDir,
    { id: "names-other-repo", trigger: "when working inside the named-repo checkout", confidence: 0.95, domain: "misc", summary: "Do a thing.", fired: 4, created: now, project_name: "named-repo" },
    "# Repo-named\n",
  );
  await fs.writeFile(
    path.join(dataDir, "projects.json"),
    JSON.stringify({ "proj-solo": { id: "proj-solo", name: "named-repo", root: "/x/named-repo", remote: "", created_at: now, last_seen: now } }),
    "utf8",
  );

  const promoteCmd = buildMaintenanceCommands(harness.ctx, options, {}).find((def) => def.name === "promote");

  await promoteCmd.execute({ sessionID: "s1", prompt: { text: "" } });
  const previewReply = harness.syntheticCalls.at(-1).text;
  assert.ok(previewReply.includes("would be promoted"), previewReply);
  assert.ok(previewReply.includes("proven-habit"), `preview lists the qualifying id: ${previewReply}`);
  assert.ok(previewReply.includes("confidence 0.95") && previewReply.includes("fired 4"), `preview names confidence and fired: ${previewReply}`);
  assert.ok(!previewReply.includes("names-other-repo"), "the repo-named id is never even mentioned: promoteStep excludes it before logging anything");
  const globalDirEmpty = await fs.readdir(path.join(dataDir, "instincts", "personal")).catch(() => []);
  assert.deepEqual(globalDirEmpty, [], "preview writes nothing");

  await promoteCmd.execute({ sessionID: "s1", prompt: { text: "--yes" } });
  const appliedReply = harness.syntheticCalls.at(-1).text;
  assert.ok(appliedReply.includes("promote: promoted 1"), appliedReply);
  assert.deepEqual(await fs.readdir(path.join(dataDir, "instincts", "personal")), ["proven-habit.md"], "only the qualifying, non-repo-named id is promoted");
}

// ---------------------------------------------------------------------------
// /skill-review install [n|all] / undo, through buildMaintenanceCommands
// (the command layer calling lib/review-install.js underneath).
// ---------------------------------------------------------------------------
async function testSkillReviewInstallUndo({ assert, createPluginHarness, makeProjectAndData, TEMP_ROOT }) {
  const reviewRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "skill-review-cmd-"));
  const liveSkillsDir = path.join(reviewRoot, "fake-live-skills");
  const liveFile = path.join(liveSkillsDir, "cmd-skill", "SKILL.md");

  async function write(filePath, content) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }
  await write(
    path.join(reviewRoot, "skill-updates", "PENDING.md"),
    "# Staged updates manifest\n\n## batch-1 (cmd-skill): staged, not installed\n",
  );
  await write(path.join(reviewRoot, "skill-updates", "batch-1", "cmd-skill.pre-slice1", "SKILL.md"), "a\nb\n");
  await write(path.join(reviewRoot, "skill-updates", "batch-1", "cmd-skill", "SKILL.md"), "a\nb\nc\n");
  await write(liveFile, "a\nb\n");

  const { projectDir, dataDir } = makeProjectAndData("skill-review-command");
  const options = { python: "python3", dataDir, board: { observationsRoot: reviewRoot } };
  const harness = createPluginHarness(projectDir, options);
  const commands = buildMaintenanceCommands(harness.ctx, options, {
    review: { run: async () => {}, status: async () => ({}) },
    liveSkillsDir,
  });
  const skillReviewCmd = commands.find((def) => def.name === "skill-review");

  await skillReviewCmd.execute({ sessionID: "s1", prompt: { text: "install" } });
  const listReply = harness.syntheticCalls.at(-1).text;
  assert.ok(listReply.includes("1. batch-1"), `numbered staged listing: ${listReply}`);

  await skillReviewCmd.execute({ sessionID: "s1", prompt: { text: "install 1" } });
  const installReply = harness.syntheticCalls.at(-1).text;
  assert.ok(installReply.includes("installed"), installReply);
  assert.ok(installReply.includes("+1/-0"), `reports the lines-added/removed stat: ${installReply}`);
  assert.equal(await fs.readFile(liveFile, "utf8"), "a\nb\nc\n");

  await skillReviewCmd.execute({ sessionID: "s1", prompt: { text: "install" } });
  assert.ok(harness.syntheticCalls.at(-1).text.includes("No staged skill updates"), "installed entry no longer lists as staged");

  await skillReviewCmd.execute({ sessionID: "s1", prompt: { text: "undo" } });
  const undoReply = harness.syntheticCalls.at(-1).text;
  assert.ok(undoReply.includes("batch-1") && undoReply.includes("undone"), undoReply);
  assert.equal(await fs.readFile(liveFile, "utf8"), "a\nb\n", "live restored");
}

// ---------------------------------------------------------------------------
// lib/review.js's createReviewController: a forced run still refuses
// when there are 0 open observations (review.js previously only checked
// this for an unforced call, so `force: true` used to spawn a session
// with nothing to review).
// ---------------------------------------------------------------------------
async function testReviewControllerZeroOpenRefusal({ assert, TEMP_ROOT }) {
  const reviewRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "review-zero-open-"));
  await fs.mkdir(path.join(reviewRoot, "skill-observations", "observation-log"), { recursive: true });

  const createCalls = [];
  const syntheticCalls = [];
  const fakeCtx = {
    session: {
      create: async (input) => {
        createCalls.push(input);
        return { id: "ses_should-not-spawn" };
      },
      prompt: async () => ({}),
      synthetic: async (input) => {
        syntheticCalls.push(input);
        return {};
      },
      get: async () => null,
      interrupt: async () => ({}),
    },
  };
  const options = { board: { observationsRoot: reviewRoot }, review: { ...REVIEW_DEFAULTS, enabled: false } };
  const controller = createReviewController(fakeCtx, options, {});

  const result = await controller.run({ force: true, sessionID: "asker" });
  assert.equal(result.spawned, false);
  assert.equal(result.reason, "no open observations");
  assert.equal(createCalls.length, 0, "force never spawns a session when there is nothing open to review");
  assert.ok(syntheticCalls.at(-1).text.includes("no open observations"));
}

// ---------------------------------------------------------------------------
// lib/review.js's scheduled-run completion notice: when an *unattended*
// run (no replySessionID, the shape the controller's own startup/poll
// timer uses) finishes, a synthetic notice (resume: false) reaches the
// newest top-level session the host lists (ctx.session.list), never a
// child/subagent session even if it is the most recently updated one,
// and never the review session itself (P1-1: the review session is
// created top-level and is almost always the most recently updated
// entry right when it finishes, so without excluding it by id and by
// its own title/metadata, the notice would post into the very session
// that just finished). createPluginHarness's own ctx has neither
// ctx.event nor ctx.session.list; both are added to its ctx here, in
// this test module only, mirroring the host shapes review.js already
// expects.
// ---------------------------------------------------------------------------
function createFakeEventBus() {
  const waiters = [];
  const queue = [];
  return {
    push(event) {
      if (waiters.length > 0) waiters.shift()(event);
      else queue.push(event);
    },
    subscribe() {
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
              return new Promise((resolve) => waiters.push((event) => resolve({ value: event, done: false })));
            },
          };
        },
      };
    },
  };
}

async function testReviewControllerCompletionNotice({ assert, createPluginHarness, makeProjectAndData, waitFor, TEMP_ROOT }) {
  const reviewRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "review-completion-notice-"));
  await fs.mkdir(path.join(reviewRoot, "skill-observations", "observation-log"), { recursive: true });
  await fs.writeFile(path.join(reviewRoot, "skill-observations", "observation-log", "0001-open.md"), "---\nstatus: open\n---\nbody\n", "utf8");
  await fs.mkdir(path.join(reviewRoot, "skill-updates"), { recursive: true });
  // "pending" (no "installed"/"consumed"/"superseded") so board-observations.js's
  // own PENDING-heading counter (readReviewGate's `staged`, which this
  // notice's count comes from) reads this one heading as staged.
  await fs.writeFile(path.join(reviewRoot, "skill-updates", "PENDING.md"), "## batch-1 (demo): pending\n", "utf8");

  const { projectDir } = makeProjectAndData("review-completion-notice");
  const harness = createPluginHarness(projectDir, {});
  const eventBus = createFakeEventBus();
  // Wrapping createPluginHarness's own ctx: it has neither property, and
  // both are added here, in this test module only.
  harness.ctx.event = { subscribe: () => eventBus.subscribe() };
  // createPluginHarness's own ctx.session.create always returns
  // `{ id: "ses_fake-review" }` (see smoke-test.mjs), so that is exactly
  // the id the review session controller.run() below spawns and later
  // finishes; it is included here (P1-1's own regression case: omitting
  // it from this list hid the bug, since newestTopLevelSessionID never
  // saw it to exclude in the first place) with a title/metadata shape
  // matching what review.js's own ctx.session.create call sends, and
  // with the newest `time.updated` of everyone in the list except the
  // excluded child, so it would be picked if the exclusion ever broke.
  // "ses_old-review" is a *different* lingering review session (an
  // earlier run, say): no matching id, but the same title, to prove the
  // title/metadata fallback also excludes a review session on its own.
  harness.ctx.session.list = async () => [
    { id: "ses_child-newest", parentID: "ses_parent", time: { created: 1000, updated: 999999 } }, // newest overall, but a child: excluded
    {
      id: "ses_fake-review",
      title: "Skill review (mighty-instincts)",
      metadata: { "mighty-instincts": { kind: "skill-review" } },
      time: { created: 1500, updated: 888888 },
    }, // the review session that just finished: excluded by id
    { id: "ses_old-review", title: "Skill review (mighty-instincts)", time: { created: 10, updated: 500000 } }, // a different, lingering review session: excluded by title alone
    { id: "ses_top-old", time: { created: 100, updated: 200 } },
    { id: "ses_top-new", time: { created: 300, updated: 50000 } }, // newest ELIGIBLE top-level session
  ];

  let afterRunCalls = 0;
  const options = { board: { observationsRoot: reviewRoot }, review: { ...REVIEW_DEFAULTS, enabled: false } };
  const controller = createReviewController(harness.ctx, options, { afterRun: async () => { afterRunCalls += 1; } });

  // Scheduled shape: `run()` with no sessionID at all (the controller's
  // own startup timer and poll interval both call it this way).
  const started = await controller.run({ force: true });
  assert.equal(started.spawned, true);
  const spawnedID = started.sessionID;
  assert.equal(spawnedID, "ses_fake-review", "matches the id this fixture's own session list excludes by");

  const today = new Date().toISOString().slice(0, 10);
  await fs.writeFile(path.join(reviewRoot, "skill-observations", "last-review-date.txt"), `${today}\n`, "utf8");
  eventBus.push({ type: "session.idle", properties: { sessionID: spawnedID } });

  const finished = await waitFor(async () => afterRunCalls > 0);
  assert.ok(finished, "the scheduled run's completion handling ran");
  // afterRun() runs inside finalizeRun, which handleSessionFinished
  // awaits *before* postCompletionNotice: waiting on afterRunCalls alone
  // would race ahead of the notice actually posting, so this also waits
  // on the notice call itself landing in syntheticCalls.
  const notified = await waitFor(async () => harness.syntheticCalls.length > 0);
  assert.ok(notified, "the completion notice was posted");

  const notice = harness.syntheticCalls.find((call) => call.sessionID === "ses_top-new");
  assert.ok(notice, `completion notice went to the newest top-level session (calls: ${JSON.stringify(harness.syntheticCalls)})`);
  assert.ok(notice.text.startsWith("Skill review finished: 1 staged update(s) await /skill-review install"), notice.text);
  assert.equal(notice.resume, false);
  assert.ok(!harness.syntheticCalls.some((call) => call.sessionID === "ses_child-newest"), "never notifies a child/subagent session");
  assert.ok(!harness.syntheticCalls.some((call) => call.sessionID === "ses_fake-review"), "P1-1: never notifies the review session that just finished, even though it is otherwise the most recently updated top-level session");
  assert.ok(!harness.syntheticCalls.some((call) => call.sessionID === "ses_old-review"), "P1-1: never notifies a different, lingering review session either, recognised by title alone");

  controller.stop();
}
