// lib/evolve-command.js's unified /evolve dispatcher, which replaces the
// six separate /evolve[-install|-show|-reject|-archive|-list] commands
// with one grammar (dashboard, detail, install, reject, archive, now,
// clusters), fixes the preview dead end (evolve-preview.js no longer
// points at --generate), and keeps the five old names registered for one
// release as thin aliases.
import path from "node:path";
import fsSync from "node:fs";
import fs from "node:fs/promises";

import { resolveProject } from "../lib/project.js";
import { registerCommands } from "../lib/commands.js";
import { parseEvolveArgs } from "../lib/evolve-command.js";
import { findCandidateById, hashContent, renderCandidateBody, writeCandidate } from "../lib/candidates.js";
import { writeInstinct } from "../lib/store.js";

export async function run({ assert, createPluginHarness, makeProjectAndData, TEMP_ROOT }) {
  await testParseEvolveArgs(assert);
  await testDashboardAndDetail({ assert, createPluginHarness, makeProjectAndData, TEMP_ROOT });
  await testInstallRejectArchiveAndStaleIndex({ assert, createPluginHarness, makeProjectAndData, TEMP_ROOT });
  await testAliases({ assert, createPluginHarness, makeProjectAndData, TEMP_ROOT });
  await testNowAndClusters({ assert, createPluginHarness, makeProjectAndData, TEMP_ROOT });
  await testCrlfRuleArchive({ assert, createPluginHarness, makeProjectAndData, TEMP_ROOT });
  await testUnreadableInstallTarget({ assert, createPluginHarness, makeProjectAndData, TEMP_ROOT });
  await testPurge({ assert, createPluginHarness, makeProjectAndData, TEMP_ROOT });
}

// ---------------------------------------------------------------------------
// parseEvolveArgs: pure grammar unit tests, no filesystem at all.
// ---------------------------------------------------------------------------
async function testParseEvolveArgs(assert) {
  const install2 = parseEvolveArgs(["install", "2"]);
  assert.equal(install2.verb, "install");
  assert.deepEqual(install2.pick, { type: "index", value: 2 });
  assert.deepEqual(parseEvolveArgs(["2", "install"]), install2, "token order is free: /evolve install 2 == /evolve 2 install");

  const byId = parseEvolveArgs(["archive", "mycand"]);
  assert.deepEqual(byId.pick, { type: "id", value: "mycand" });
  assert.deepEqual(parseEvolveArgs(["mycand", "archive"]), byId, "the same is true for archive and an id pick");

  assert.ok(parseEvolveArgs(["2", "foo"]).error, "an unrecognised extra token is a usage error, not silently dropped");
  assert.ok(parseEvolveArgs(["install", "2", "archive"]).error, "two different verbs is a usage error");
  assert.ok(parseEvolveArgs(["install"]).error, "install with no pick at all is a usage error");
  assert.ok(parseEvolveArgs(["archive"]).error, "archive with no pick at all is a usage error");
  assert.ok(!parseEvolveArgs(["now"]).error, "'now' needs no pick");
  assert.ok(!parseEvolveArgs([]).error, "no tokens at all (the bare dashboard) is never a usage error");

  // reject: everything after the "reject" token is the reason, verbatim,
  // even a token that looks like a different verb or a pick index -- the
  // one documented exception to the generic "anything unclassified is a
  // usage error" rule, since a reason is free text by design.
  const rejected = parseEvolveArgs(["mycand", "reject", "not", "useful", "archive", "2"]);
  assert.equal(rejected.verb, "reject");
  assert.deepEqual(rejected.pick, { type: "id", value: "mycand" });
  assert.equal(rejected.reason, "not useful archive 2", "every token after 'reject' is the reason verbatim");
  assert.ok(parseEvolveArgs(["reject", "mycand"]).error, "the pick must come before 'reject'; the grammar never reorders a reason to find a pick inside it");

  // clusters: a bare digit is read as the positional N when no --limit is
  // given explicitly.
  assert.equal(parseEvolveArgs(["clusters", "5"]).pick.value, 5);
  assert.equal(parseEvolveArgs(["--limit", "7", "clusters"]).limit, 7);
  assert.equal(parseEvolveArgs(["clusters"]).pick, undefined, "clusters with no N at all needs no pick");

  // --limit is only ever a flag for "clusters": the verb is identified
  // first, so "--limit" inside a reject reason (typed directly, not
  // through an alias) is left completely untouched rather than stripped
  // out and reinterpreted as a flag.
  const rejectWithLimitWord = parseEvolveArgs(["mycand", "reject", "too", "strict,", "use", "--limit", "5", "instead"]);
  assert.equal(rejectWithLimitWord.verb, "reject");
  assert.equal(rejectWithLimitWord.reason, "too strict, use --limit 5 instead", "--limit inside a reason is never stripped as a flag");
}

async function makeEvolveProject(label, { makeProjectAndData, TEMP_ROOT, createPluginHarness }) {
  const { projectDir, dataDir } = makeProjectAndData(label);
  const home = fsSync.mkdtempSync(path.join(TEMP_ROOT, `${label}-home-`));
  const targets = { skill: path.join(home, "skills"), command: path.join(home, "commands"), agent: path.join(home, "agents"), rule: path.join(home, "AGENTS.md") };
  // `python` points at a binary that can never exist: /evolve now (and
  // every other /evolve path) must never shell out to the vendored CLI
  // at all; any attempt would fail loudly (ENOENT) rather than silently
  // running a real interpreter.
  const options = { python: "/nonexistent/evolve-smoke-should-never-run", dataDir, evolve: { targets } };
  const ctx = { location: { directory: projectDir } };
  const project = await resolveProject(ctx, options);
  const harness = createPluginHarness(projectDir, options);
  await registerCommands(harness.ctx, options, { run: async () => {} }, { refresh: async () => null });
  const findCmd = (name) => harness.commandDefs.find((def) => def.name === name);
  const exec = async (name, text, sessionID = "s1") => {
    await findCmd(name).execute({ sessionID, prompt: { text } });
    return harness.syntheticCalls.at(-1).text;
  };
  async function seed(kind, id, suggestedName, members, status = "proposed") {
    const cluster = members.map((m) => ({ fields: { id: m, trigger: `trigger for ${m}`, summary: `Do the ${m} thing.` } }));
    const body = renderCandidateBody(kind, "testing", cluster, suggestedName);
    await writeCandidate(
      project.evolved_dir,
      { id, kind, status, created: new Date().toISOString(), members, summary: "A test candidate.", suggested_name: suggestedName },
      body,
    );
  }
  return { project, options, targets, harness, exec, seed };
}

// ---------------------------------------------------------------------------
// Dashboard numbering/lines, and picking the same candidate by number or
// by id.
// ---------------------------------------------------------------------------
async function testDashboardAndDetail({ assert, createPluginHarness, makeProjectAndData, TEMP_ROOT }) {
  const { project, exec, seed } = await makeEvolveProject("evolve-dashboard", { makeProjectAndData, TEMP_ROOT, createPluginHarness });

  await seed("skill", "cand-a", "cand-a-skill", ["m1", "m2", "m3", "m4"]);
  await seed("command", "cand-b", "cand-b-cmd", ["m1", "m2"]);

  const dashboard = await exec("evolve", "");
  assert.ok(dashboard.includes("2 candidate(s): 2 proposed, 0 installed, 0 archived."), "header counts proposed/installed/archived");
  assert.ok(/^1\. cand-a \[skill\] 4 habits, \S+, A test candidate\.$/m.test(dashboard), "proposed line: index, id, kind, member count, age, summary");
  assert.ok(/^2\. cand-b \[command\] 2 habits/m.test(dashboard), "the second proposed candidate is numbered 2");
  assert.ok(dashboard.includes("Next: /evolve <n> to read one, /evolve now to propose from today's clusters."), "the dashboard always ends with the next-step trailer");

  const byNumber = await exec("evolve", "1");
  const byId = await exec("evolve", "cand-a");
  assert.equal(byNumber, byId, "picking by number or by id renders the exact same detail");
  assert.ok(byNumber.includes("kind: skill") && byNumber.includes("--- body ---"), "detail still shows kind and the full drafted body");
  assert.ok(byNumber.includes("Next: /evolve 1 install | /evolve 1 reject [why]"), "a proposed candidate's Next line offers install and reject, by number");

  assert.ok((await exec("evolve", "no-such-id")).includes("No candidate found with id 'no-such-id'. Run /evolve to see what is available."));
  assert.ok((await exec("evolve", "99")).includes("No candidate numbered 99. Run /evolve to see the current list."));

  assert.ok((await exec("evolve", "2 foo")).includes("Usage:"), "an unrecognised extra token after a valid pick reads as usage text");
}

// ---------------------------------------------------------------------------
// install's look-before-leap, reject with a multi-word reason, archive,
// and the stale-index guard.
// ---------------------------------------------------------------------------
async function testInstallRejectArchiveAndStaleIndex({ assert, createPluginHarness, makeProjectAndData, TEMP_ROOT }) {
  const { project, targets, exec, seed } = await makeEvolveProject("evolve-actions", { makeProjectAndData, TEMP_ROOT, createPluginHarness });

  // --- install: refused (shown instead) before detail was ever rendered,
  //     accepted on the second, identical attempt, file written with its
  //     own markers -----------------------------------------------------
  await seed("skill", "cand-fresh", "cand-fresh-skill", ["m1", "m2", "m3"]);
  const dashboard1 = await exec("evolve", "");
  const freshIndex = Number(/^(\d+)\. cand-fresh \[skill\]/m.exec(dashboard1)[1]);

  const installAttempt1 = await exec("evolve", `${freshIndex} install`);
  assert.ok(installAttempt1.includes("--- body ---"), "install on a never-viewed candidate renders its detail first, instead of writing anything");
  assert.ok(installAttempt1.includes(`Run /evolve ${freshIndex} install again to install.`), "and asks for the exact same command again");
  await assert.rejects(fs.access(path.join(targets.skill, "cand-fresh-skill", "SKILL.md")), "nothing was written on the first install attempt");
  const stillProposed = await findCandidateById(project.evolved_dir, "cand-fresh");
  assert.equal(stillProposed.fields.status, "proposed", "the first install attempt never changes the candidate's own status");

  const installAttempt2 = await exec("evolve", `${freshIndex} install`);
  assert.ok(installAttempt2.includes("Restart OpenCode to load it."), "the second, identical install attempt actually installs");
  assert.ok(installAttempt2.includes("Undo: /evolve"), "and points at its own undo (archive)");
  const installedFile = await fs.readFile(path.join(targets.skill, "cand-fresh-skill", "SKILL.md"), "utf8");
  assert.ok(installedFile.includes("generated_by: mighty-instincts") && installedFile.includes("candidate_id: cand-fresh"), "the installed file carries this candidate's own markers");
  const freshAfter = await findCandidateById(project.evolved_dir, "cand-fresh");
  assert.equal(freshAfter.fields.status, "installed");
  assert.equal(freshAfter.fields.installed_hash, hashContent(installedFile), "installed_hash matches exactly what was written");

  // Viewing one candidate's detail does not satisfy another's
  // look-before-leap: a different, never-viewed candidate still gets
  // shown its own detail first.
  await seed("command", "cand-other", "cand-other-cmd", ["m1", "m2"]);
  const otherAttempt = await exec("evolve", "cand-other install");
  assert.ok(otherAttempt.includes("Run /evolve") && otherAttempt.includes("install again to install."), "a sibling candidate's own detail was never shown, so it is shown now instead of installing");

  // --- reject: multi-word reason, and an installed candidate is pointed
  //     at archive instead --------------------------------------------
  await seed("rule", "cand-reject-me", "cand-reject-rule", ["m1", "m2"]);
  const rejectReply = await exec("evolve", "cand-reject-me reject this one is too narrow for our workflow");
  assert.ok(rejectReply.includes("Archived candidate 'cand-reject-me' (reason: this one is too narrow for our workflow)."));
  const rejected = await findCandidateById(project.evolved_dir, "cand-reject-me");
  assert.equal(rejected.fields.status, "archived");
  assert.equal(rejected.fields.reason, "this one is too narrow for our workflow");

  const rejectInstalledReply = await exec("evolve", "cand-fresh reject not needed");
  assert.ok(rejectInstalledReply.includes("already installed") && rejectInstalledReply.includes("archive"), "rejecting an already-installed candidate points at archive instead");

  // A reason containing "--limit" is never stripped out as a flag, even
  // typed directly through the main /evolve command (not just via the
  // evolve-reject alias): the verb is identified before any flag
  // parsing happens, and --limit is only ever read for "clusters".
  await seed("rule", "cand-reject-limit", "cand-reject-limit-rule", ["m1", "m2"]);
  await exec("evolve", "cand-reject-limit reject too strict, use --limit 5 instead");
  const rejectedWithLimit = await findCandidateById(project.evolved_dir, "cand-reject-limit");
  assert.equal(rejectedWithLimit.fields.reason, "too strict, use --limit 5 instead", "--limit inside a reason survives intact through the real command, not just the pure parser");

  // --- archive: removes the installed file when ownership and content
  //     both still match -------------------------------------------------
  const archiveReply = await exec("evolve", "cand-fresh archive");
  assert.ok(archiveReply.includes(`Removed ${path.join(targets.skill, "cand-fresh-skill", "SKILL.md")}`));
  await assert.rejects(fs.readFile(path.join(targets.skill, "cand-fresh-skill", "SKILL.md"), "utf8"), "the installed file is actually gone");
  const archivedAfter = await findCandidateById(project.evolved_dir, "cand-fresh");
  assert.equal(archivedAfter.fields.status, "archived");
  assert.ok((await exec("evolve", "cand-fresh archive")).includes("Candidate 'cand-fresh' is already archived."));

  // --- stale index guard: archive cand-other directly on disk (as if a
  //     concurrent session did it), bypassing the command layer so the
  //     in-process numbering snapshot taken by dashboard1/installAttempt2
  //     above is never refreshed; position 2 (cand-other, a proposed
  //     candidate) now maps to nothing (archived candidates are never
  //     numbered), which must be refused rather than silently acting on
  //     whatever candidate happens to sit there now. ------------------
  const beforeStale = await exec("evolve", ""); // re-establish a known baseline
  const otherIndexMatch = /^(\d+)\. cand-other \[command\]/m.exec(beforeStale);
  assert.ok(otherIndexMatch, "cand-other is still numbered before the out-of-band change");
  const otherIndex = Number(otherIndexMatch[1]);

  const otherCandidate = await findCandidateById(project.evolved_dir, "cand-other");
  await writeCandidate(project.evolved_dir, { ...otherCandidate.fields, status: "archived", reason: "archived out of band" }, otherCandidate.body);

  const staleReply = await exec("evolve", `${otherIndex} archive`);
  assert.ok(staleReply.includes("The list changed; here it is again:"), "an index whose candidate changed since it was last shown is refused, not acted on blindly");
  assert.ok(staleReply.includes("archived: "), "the fresh dashboard it shows now reflects the out-of-band archive");
}

// ---------------------------------------------------------------------------
// The five deprecated aliases: each forwards into runEvolve with the
// equivalent new text and carries the one-line deprecation notice.
// ---------------------------------------------------------------------------
async function testAliases({ assert, createPluginHarness, makeProjectAndData, TEMP_ROOT }) {
  const { project, targets, exec, seed } = await makeEvolveProject("evolve-aliases", { makeProjectAndData, TEMP_ROOT, createPluginHarness });

  await seed("skill", "alias-cand", "alias-cand-skill", ["m1", "m2", "m3"]);

  const listReply = await exec("evolve-list", "");
  assert.ok(listReply.includes("alias of /evolve; this alias goes away in a later release."), "evolve-list with no id carries the alias prefix, forwarding to the bare dashboard");
  assert.ok(listReply.includes("1 candidate(s): 1 proposed"), "and the dashboard body follows");

  const showReply = await exec("evolve-show", "alias-cand");
  assert.ok(showReply.includes("alias of /evolve alias-cand; this alias goes away in a later release."));
  assert.ok(showReply.includes("--- body ---"), "evolve-show still renders the full detail");

  // evolve-install without --yes maps to a bare pick (the detail view),
  // which also satisfies the look-before-leap for the --yes call right
  // after.
  const previewReply = await exec("evolve-install", "alias-cand");
  assert.ok(previewReply.includes("alias of /evolve alias-cand; this alias goes away in a later release."));
  assert.ok(previewReply.includes("--- body ---") && previewReply.includes("Next: /evolve") && previewReply.includes("install"));

  const installReply = await exec("evolve-install", "alias-cand --yes");
  assert.ok(installReply.includes("alias of /evolve alias-cand install; this alias goes away in a later release."));
  assert.ok(installReply.includes("Restart OpenCode to load it."), "--yes maps to the install verb and actually installs");
  const installed = await findCandidateById(project.evolved_dir, "alias-cand");
  assert.equal(installed.fields.status, "installed");

  const archiveReply = await exec("evolve-archive", "alias-cand");
  assert.ok(archiveReply.includes("alias of /evolve alias-cand archive; this alias goes away in a later release."));
  assert.ok(archiveReply.includes(`Removed ${path.join(targets.skill, "alias-cand-skill", "SKILL.md")}`));

  await seed("rule", "alias-reject", "alias-reject-rule", ["m1", "m2"]);
  const rejectReply = await exec("evolve-reject", "alias-reject not a good fit");
  assert.ok(rejectReply.includes("alias of /evolve alias-reject reject not a good fit; this alias goes away in a later release."));
  assert.ok(rejectReply.includes("Archived candidate 'alias-reject' (reason: not a good fit)."));
}

// ---------------------------------------------------------------------------
// `/evolve now` (evolveStep + pruneCandidatesStep, no Python subprocess
// involved at all) and `/evolve clusters` using the real lifecycle's own
// selectCandidateKind (lib/candidates.js), not a second heuristic.
// ---------------------------------------------------------------------------
async function testNowAndClusters({ assert, createPluginHarness, makeProjectAndData, TEMP_ROOT }) {
  const { project, exec } = await makeEvolveProject("evolve-now-clusters", { makeProjectAndData, TEMP_ROOT, createPluginHarness });

  // A 3-member cluster (<=3 members, candidates.js's RULE_MAX_MEMBERS) in
  // one domain, and a 6-member cluster (>5, always "skill") in another;
  // neither mentions delegation or a run/check/verify/test verb, so kind
  // is decided purely by size.
  for (let i = 0; i < 3; i++) {
    await writeInstinct(
      project.instincts_personal,
      {
        id: `style-habit-${i}`,
        trigger: `always keep commit message titles short and specific ${i}`,
        confidence: 0.6,
        domain: "style",
        summary: `Keep commit titles short and specific ${i}.`,
        created: new Date().toISOString(),
      },
      `# Style ${i}\n`,
    );
  }
  for (let i = 0; i < 6; i++) {
    await writeInstinct(
      project.instincts_personal,
      {
        id: `docs-habit-${i}`,
        trigger: `always keep the architecture notes synchronized with the code ${i}`,
        confidence: 0.6,
        domain: "docs",
        summary: `Keep architecture notes synchronized ${i}.`,
        created: new Date().toISOString(),
      },
      `# Docs ${i}\n`,
    );
  }

  const clustersReply = await exec("evolve", "clusters");
  assert.ok(/docs \(6 members.*suggested form: skill\)/.test(clustersReply), "a 6-member cluster (above the command cutoff) reads as skill, via candidates.js's selectCandidateKind");
  assert.ok(/style \(3 members.*suggested form: rule\)/.test(clustersReply), "a 3-member cluster (at the rule cutoff) reads as rule, via the same shared function");
  assert.ok(clustersReply.includes("Run /evolve now to propose candidates from these clusters."), "the clusters preview's own trailing hint points at 'now', not --generate");

  // /evolve now: must never spawn the (deliberately broken) python
  // binary; evolveStep/pruneCandidatesStep are pure JS/fs, so a real
  // proposal succeeding here is itself proof nothing shelled out.
  const nowReply = await exec("evolve", "now");
  assert.ok(/Proposed \d+ new candidate\(s\), refreshed \d+: \/evolve/.test(nowReply), "the now reply reports proposed/refreshed counts and points back at /evolve");
  assert.ok(nowReply.includes("Proposed 2 new candidate(s)"), "both qualifying clusters (style, docs) propose exactly one candidate each");

  const afterNow = await exec("evolve", "");
  assert.ok(afterNow.includes("2 candidate(s): 2 proposed, 0 installed, 0 archived."), "the two just-proposed candidates now show up on the dashboard");

  // Running it again immediately proposes nothing new (evolveStep's own
  // re-run-is-a-no-op guarantee) and still never touches python.
  const nowAgain = await exec("evolve", "now");
  assert.ok(nowAgain.includes("Proposed 0 new candidate(s)"), "re-running now against the exact same instincts proposes nothing new");
}

// ---------------------------------------------------------------------------
// A rule candidate installed into a CRLF AGENTS.md: the installed_hash
// (computed from the candidate's own, always "\n"-joined body) must
// still match checkRuleOwnership's own hash of the CRLF file's snippet
// lines, so archive actually removes it instead of reporting it as
// hand-edited.
// ---------------------------------------------------------------------------
async function testCrlfRuleArchive({ assert, createPluginHarness, makeProjectAndData, TEMP_ROOT }) {
  const { project, targets, exec, seed } = await makeEvolveProject("evolve-crlf-rule", { makeProjectAndData, TEMP_ROOT, createPluginHarness });

  await fs.mkdir(path.dirname(targets.rule), { recursive: true });
  await fs.writeFile(targets.rule, "# Project\r\n\r\nSome existing notes.\r\n", "utf8");

  await seed("rule", "crlf-cand", "crlf-rule", ["m1", "m2"]);
  await exec("evolve", "crlf-cand"); // render detail first, to clear the look-before-leap
  const installReply = await exec("evolve", "crlf-cand install");
  assert.ok(installReply.includes("Restart OpenCode to load it."), "the rule installs into the CRLF file");

  const afterInstall = await fs.readFile(targets.rule, "utf8");
  assert.ok(afterInstall.includes("Some existing notes.\r\n"), "the file's own pre-existing content and CRLF are untouched");
  assert.ok(!afterInstall.replace(/\r\n/g, "").includes("\n"), "the newly appended rule block uses CRLF too, not a bare LF");
  const installed = await findCandidateById(project.evolved_dir, "crlf-cand");
  assert.equal(installed.fields.status, "installed");
  assert.ok(typeof installed.fields.installed_hash === "string" && installed.fields.installed_hash.length > 0);

  const archiveReply = await exec("evolve", "crlf-cand archive");
  assert.ok(archiveReply.includes(`Removed ${targets.rule}`), "a CRLF AGENTS.md rule is still recognised as unchanged and actually removed, not reported as hand-edited");
  const afterArchive = await fs.readFile(targets.rule, "utf8");
  assert.ok(afterArchive.includes("Some existing notes.\r\n"), "everything else in the file survives the archive untouched");
  assert.ok(!afterArchive.includes("crlf-cand"), "the rule's own block is actually gone");
}

// ---------------------------------------------------------------------------
// An install target that exists but cannot be read (chmod 000): the
// read failure must surface as a real error, never be treated as "no
// file there yet" and overwritten, and never skip the ownership check.
// Skipped when running as root, which ignores file permissions.
// ---------------------------------------------------------------------------
async function testUnreadableInstallTarget({ assert, createPluginHarness, makeProjectAndData, TEMP_ROOT }) {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return;
  }
  const { project, targets, exec, seed } = await makeEvolveProject("evolve-unreadable", { makeProjectAndData, TEMP_ROOT, createPluginHarness });

  const skillDir = path.join(targets.skill, "locked-skill");
  await fs.mkdir(skillDir, { recursive: true });
  const skillFile = path.join(skillDir, "SKILL.md");
  await fs.writeFile(skillFile, "---\nname: locked-skill\ndescription: pre-existing\n---\n\nHand-written, unreadable to this process.\n", "utf8");
  await fs.chmod(skillFile, 0o000);

  try {
    await seed("skill", "locked-cand", "locked-skill", ["m1", "m2", "m3"]);
    await exec("evolve", "locked-cand"); // render detail first, to clear the look-before-leap
    const installReply = await exec("evolve", "locked-cand install");
    assert.ok(
      installReply.includes("EACCES") || installReply.toLowerCase().includes("permission denied"),
      "the unreadable file's real read error surfaces instead of being swallowed",
    );
    assert.ok(!installReply.includes("Restart OpenCode to load it."), "a read failure never reads as a successful install");

    const stillLocked = await fs.readFile(skillFile, "utf8").catch((error) => error);
    assert.ok(stillLocked instanceof Error && stillLocked.code === "EACCES", "the hand-written file is left exactly as it was, never overwritten");
    const candidateAfter = await findCandidateById(project.evolved_dir, "locked-cand");
    assert.equal(candidateAfter.fields.status, "proposed", "a failed install (read error) never flips the candidate's own status");
  } finally {
    await fs.chmod(skillFile, 0o644);
  }
}

// ---------------------------------------------------------------------------
// purge: deletes the drafts /evolve itself never lists (the Python CLI's
// --generate tree under evolved/skills|commands|agents/, evolved/archive/,
// and flat .md files that are not candidates), after showing them once,
// and never touches a candidate file of any status: an archived one is
// the tombstone that stops the weekly sweep from proposing its cluster
// again, and a proposed one has /evolve <n> reject.
// ---------------------------------------------------------------------------
async function testPurge({ assert, createPluginHarness, makeProjectAndData, TEMP_ROOT }) {
  const { project, exec, seed } = await makeEvolveProject("evolve-purge", { makeProjectAndData, TEMP_ROOT, createPluginHarness });
  const dir = project.evolved_dir;
  await seed("skill", "cand-keep-proposed", "keep-proposed", ["m1", "m2", "m3"]);
  await seed("rule", "cand-keep-archived", "keep-archived", ["m4", "m5"], "archived");
  const write = async (rel, text) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text, "utf8");
  };
  await write("commands/a-generated-command.md", "---\ndescription: x\n---\n# a-generated-command\n");
  await write("skills/a-generated-skill/SKILL.md", "---\nname: a-generated-skill\n---\n");
  await write("agents/a-generated-agent.md", "---\ndescription: y\n---\n");
  await write("archive/old-draft.md", "# Candidate skill: old\n");
  await write("legacy-0abc1234.md", "# Candidate skill: Testing patterns\n\nCluster id: legacy-0abc1234\n");
  const outside = path.join(path.dirname(dir), "outside-target.md");
  await fs.writeFile(outside, "not a draft\n", "utf8");
  await fs.symlink(outside, path.join(dir, "commands", "linked.md"));

  assert.ok(parseEvolveArgs(["purge"]).verb === "purge" && !parseEvolveArgs(["purge"]).error, "'purge' needs no pick");
  assert.ok(parseEvolveArgs(["purge", "2"]).error, "purge takes no pick");

  const preview = await exec("evolve", "purge");
  assert.ok(preview.includes("Run /evolve purge again to delete these 6 draft file(s)."), `the first purge only lists what it would delete: ${preview}`);
  for (const rel of ["commands/a-generated-command.md", "skills/a-generated-skill/SKILL.md", "agents/a-generated-agent.md", "archive/old-draft.md", "legacy-0abc1234.md", "commands/linked.md"]) {
    assert.ok(preview.includes(rel), `the preview names ${rel}`);
  }
  assert.ok(!preview.includes("cand-keep-proposed") && !preview.includes("cand-keep-archived"), "candidate files are never listed for purge");
  await fs.access(path.join(dir, "commands", "a-generated-command.md"));

  const done = await exec("evolve", "purge");
  assert.ok(done.includes("Deleted 6 draft file(s)"), `the second, identical purge deletes: ${done}`);
  for (const rel of ["commands", "skills", "agents", "archive", "legacy-0abc1234.md"]) {
    await assert.rejects(fs.lstat(path.join(dir, rel)), `${rel} is gone, emptied directories included`);
  }
  assert.equal(await fs.readFile(outside, "utf8"), "not a draft\n", "a symlinked draft is removed as a link; its target is never touched");
  assert.equal((await findCandidateById(dir, "cand-keep-proposed")).fields.status, "proposed", "a proposed candidate survives purge");
  assert.equal((await findCandidateById(dir, "cand-keep-archived")).fields.status, "archived", "an archived tombstone survives purge");
  assert.ok((await exec("evolve", "purge")).includes("No drafts to purge"), "a purge with nothing left says so");

  // A listing that changed between the preview and the second call is
  // shown again instead of deleted.
  await write("commands/first.md", "x\n");
  await exec("evolve", "purge");
  await write("commands/second.md", "y\n");
  const changed = await exec("evolve", "purge");
  assert.ok(changed.includes("Run /evolve purge again to delete these 2 draft file(s)."), `a listing that changed since the preview is shown again, not deleted: ${changed}`);
  await fs.access(path.join(dir, "commands", "first.md"));
}
