// lib/commands-instinct.js's `/instinct <verb>` family: why (after an
// injection), keep (confidence + fired), wrong (archive + mute) and its
// own undo (unmute, restoring from the archive), mute hiding an id from
// the next injection, observer on/off (runtime + persisted), doctor
// (health checks + the gate verdict), help (every registered command
// and verb), the deprecated hyphenated aliases forwarding into the same
// dispatcher, lib/inject.js's own four-directory pool cache (serves from
// cache, then invalidates on a write this plugin made), and
// .activity.json's appliedToday counting once per prompt rather than
// once per request.
import fs from "node:fs/promises";
import path from "node:path";

import { resolveProject } from "../lib/project.js";
import { registerCommands } from "../lib/commands.js";
import { dispatchInstinct } from "../lib/commands-instinct.js";
import { registerInject, invalidateInjectPool, _injectPoolCacheStats, _resetInjectPoolCache } from "../lib/inject.js";
import { readSettings, writeSettings } from "../lib/settings.js";
import { writeInstinct } from "../lib/store.js";

export async function run({ assert, createPluginHarness, makeProjectAndData, contextEvent, waitFor }) {
  await testWhy({ assert, makeProjectAndData, contextEvent });
  await testKeep({ assert, makeProjectAndData });
  await testWrongAndUnmute({ assert, makeProjectAndData });
  await testMuteHidesFromInjection({ assert, makeProjectAndData, contextEvent });
  await testObserverOnOff({ assert, makeProjectAndData });
  await testDoctor({ assert, makeProjectAndData });
  await testHelpAndAliases({ assert, createPluginHarness, makeProjectAndData });
  await testPoolCache({ assert, makeProjectAndData, contextEvent });
  await testAppliedOncePerPrompt({ assert, makeProjectAndData, contextEvent });
  await testSettingsReadyNonBlocking({ assert, makeProjectAndData, createPluginHarness, waitFor });
  await testSettingsReadyRaceClosedByVerb({ assert, makeProjectAndData, createPluginHarness });
}

// A bare, minimal ctx: every verb this file dispatches directly (not
// through the full plugin / registerCommands) only ever touches
// `ctx.location.directory` (for resolveProject/runCli), never
// ctx.session or ctx.command.
function makeCtx(directory) {
  return { location: { directory } };
}

async function readFrontmatter(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  const fields = {};
  if (match) {
    for (const line of match[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^"|"$/g, "");
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// why: nothing injected yet reads as the empty-state line; after a real
// injection (via lib/inject.js's own "context" hook), it lists the id,
// confidence, source kind, and which ids fired on that same prompt.
// ---------------------------------------------------------------------------
async function testWhy({ assert, makeProjectAndData, contextEvent }) {
  const { projectDir, dataDir } = makeProjectAndData("instinct-why");
  const options = { python: "python3", dataDir, inject: { enabled: true, max: 5, minConfidence: 0.8 } };
  const ctx = makeCtx(projectDir);
  const project = await resolveProject(ctx, options);

  await writeInstinct(
    project.instincts_personal,
    { id: "grep-before-edit", trigger: "grep unfamiliar repository before editing", confidence: 0.9, domain: "workflow", summary: "Search before editing." },
    "# Grep Before Edit\n\n## Action\nSearch before editing.\n",
  );

  const neverInjected = await dispatchInstinct(ctx, options, {}, "why-session-unseen", "why");
  assert.equal(neverInjected, "nothing injected in this session yet", "a session that never received an injection reads as the empty state");

  const hooks = {};
  const injectCtx = { location: { directory: projectDir }, session: { hook: async (name, cb) => { hooks[name] = cb; return { dispose: async () => {} }; } } };
  await registerInject(injectCtx, options);
  await hooks.context(contextEvent({ sessionID: "why-session-1", userText: "please grep this unfamiliar repository before editing anything" }));

  const why = await dispatchInstinct(ctx, options, {}, "why-session-1", "why");
  assert.ok(why.includes("grep-before-edit"), `why names the injected id: ${why}`);
  assert.ok(why.includes("confidence 90%"), `why reports the injected confidence: ${why}`);
  assert.ok(why.includes("personal"), `why names the source kind: ${why}`);
  assert.ok(why.includes("fired on last prompt: grep-before-edit"), `why names which id fired on this same prompt: ${why}`);
}

// ---------------------------------------------------------------------------
// keep: bumps fired and raises confidence by 0.05, capped at 0.95,
// wherever the instinct actually lives.
// ---------------------------------------------------------------------------
async function testKeep({ assert, makeProjectAndData }) {
  const { projectDir, dataDir } = makeProjectAndData("instinct-keep");
  const options = { python: "python3", dataDir };
  const ctx = makeCtx(projectDir);
  const project = await resolveProject(ctx, options);

  await writeInstinct(
    project.instincts_personal,
    { id: "keep-me", trigger: "always run the gate before pushing", confidence: 0.5, domain: "workflow" },
    "# Keep Me\n",
  );

  const first = await dispatchInstinct(ctx, options, {}, "s1", "keep keep-me");
  assert.ok(first.includes("confidence now 0.55"), `first keep raises confidence by 0.05: ${first}`);
  assert.ok(first.includes("fired 1"), `first keep bumps fired to 1: ${first}`);
  assert.ok(first.includes("personal"), `first keep names the source kind: ${first}`);

  const filePath = path.join(project.instincts_personal, "keep-me.md");
  const afterFirst = await readFrontmatter(filePath);
  assert.equal(afterFirst.confidence, "0.55");
  assert.equal(afterFirst.fired, "1");

  const second = await dispatchInstinct(ctx, options, {}, "s1", "keep keep-me");
  assert.ok(second.includes("confidence now 0.6"), `second keep raises confidence again: ${second}`);
  assert.ok(second.includes("fired 2"), `second keep bumps fired again: ${second}`);

  // Cap at 0.95: starting near the ceiling never overshoots it.
  await writeInstinct(project.instincts_personal, { id: "near-cap", trigger: "trigger text", confidence: 0.93, domain: "workflow" }, "# Near Cap\n");
  const capped = await dispatchInstinct(ctx, options, {}, "s1", "keep near-cap");
  assert.ok(capped.includes("confidence now 0.95"), `keep never raises confidence past 0.95: ${capped}`);

  const missing = await dispatchInstinct(ctx, options, {}, "s1", "keep no-such-id");
  assert.ok(missing.includes("No instinct found"), `keep on an unknown id reports that plainly: ${missing}`);

  const usage = await dispatchInstinct(ctx, options, {}, "s1", "keep");
  assert.ok(usage.startsWith("Usage:"), "keep with no id at all reads as usage text");
}

// ---------------------------------------------------------------------------
// wrong: archives the file (sibling instincts/archive/ of wherever it
// lived) and mutes the id; unmute removes the mute and restores the
// file from the archive.
// ---------------------------------------------------------------------------
async function testWrongAndUnmute({ assert, makeProjectAndData }) {
  const { projectDir, dataDir } = makeProjectAndData("instinct-wrong");
  const options = { python: "python3", dataDir };
  const ctx = makeCtx(projectDir);
  const project = await resolveProject(ctx, options);

  await writeInstinct(
    project.instincts_personal,
    { id: "bad-habit", trigger: "a habit nobody actually wants", confidence: 0.85, domain: "workflow" },
    "# Bad Habit\n",
  );

  const archiveDir = path.join(path.dirname(project.instincts_personal), "archive");
  const wrongReply = await dispatchInstinct(ctx, options, {}, "s1", "wrong bad-habit");
  assert.ok(wrongReply.includes(path.join(archiveDir, "bad-habit.md")), `wrong reports the path it moved the file to: ${wrongReply}`);
  assert.ok(wrongReply.includes("undo: /instinct unmute bad-habit"), `wrong points at its own undo: ${wrongReply}`);

  await assert.rejects(fs.access(path.join(project.instincts_personal, "bad-habit.md")), "the file is actually gone from personal/");
  const archivedContent = await fs.readFile(path.join(archiveDir, "bad-habit.md"), "utf8");
  assert.ok(archivedContent.includes("id: bad-habit"), "the archived file carries the same instinct");

  const settingsAfterWrong = await readSettings(project.project_dir);
  assert.ok(settingsAfterWrong.muted.includes("bad-habit"), "wrong also mutes the id");

  const unmuteReply = await dispatchInstinct(ctx, options, {}, "s1", "unmute bad-habit");
  assert.ok(unmuteReply.includes("unmuted bad-habit"), `unmute reports it unmuted the id: ${unmuteReply}`);
  assert.ok(unmuteReply.includes("restored from archive"), `unmute reports the restore: ${unmuteReply}`);

  const settingsAfterUnmute = await readSettings(project.project_dir);
  assert.ok(!settingsAfterUnmute.muted.includes("bad-habit"), "unmute actually removes the id from muted");

  const restoredContent = await fs.readFile(path.join(project.instincts_personal, "bad-habit.md"), "utf8");
  assert.ok(restoredContent.includes("id: bad-habit"), "the file is back in personal/");
  await assert.rejects(fs.access(path.join(archiveDir, "bad-habit.md")), "the archive copy is gone once restored");

  // An id that was only ever muted (never archived by 'wrong') has
  // nothing to restore, and unmute says so plainly rather than claiming
  // a restore that never happened.
  await dispatchInstinct(ctx, options, {}, "s1", "mute only-muted-id");
  const plainUnmute = await dispatchInstinct(ctx, options, {}, "s1", "unmute only-muted-id");
  assert.ok(plainUnmute.includes("unmuted only-muted-id") && plainUnmute.includes("nothing archived to restore"), `unmute without a prior archive reports no restore: ${plainUnmute}`);
}

// ---------------------------------------------------------------------------
// mute: settings only (no file move), but still hides the id from the
// very next injection.
// ---------------------------------------------------------------------------
async function testMuteHidesFromInjection({ assert, makeProjectAndData, contextEvent }) {
  const { projectDir, dataDir } = makeProjectAndData("instinct-mute-inject");
  const options = { python: "python3", dataDir, inject: { enabled: true, max: 5, minConfidence: 0.8 } };
  const ctx = makeCtx(projectDir);
  const project = await resolveProject(ctx, options);

  await writeInstinct(
    project.instincts_personal,
    { id: "mutable-habit", trigger: "a muted habit's own trigger text", confidence: 0.9, domain: "workflow", summary: "A muted habit." },
    "# Mutable\n",
  );

  const hooks = {};
  const injectCtx = { location: { directory: projectDir }, session: { hook: async (name, cb) => { hooks[name] = cb; return { dispose: async () => {} }; } } };
  await registerInject(injectCtx, options);

  const before = contextEvent({ sessionID: "mute-inject-s1", userText: "first unrelated prompt" });
  await hooks.context(before);
  assert.equal(before.system.length, 1, "before muting, the habit is injected");
  assert.ok(before.system[0].text.includes("A muted habit."), "the injected block carries this habit's summary");

  const muteReply = await dispatchInstinct(ctx, options, {}, "s1", "mute mutable-habit");
  assert.equal(muteReply, "muted mutable-habit");

  const after = contextEvent({ sessionID: "mute-inject-s1", userText: "a second, different unrelated prompt" });
  await hooks.context(after);
  assert.equal(after.system.length, 0, "once muted, the same habit is no longer injected for the next prompt");

  const settings = await readSettings(project.project_dir);
  assert.ok(settings.muted.includes("mutable-habit"));

  const unmuteReply = await dispatchInstinct(ctx, options, {}, "s1", "unmute mutable-habit");
  assert.ok(unmuteReply.includes("unmuted mutable-habit"));
  const restored = contextEvent({ sessionID: "mute-inject-s1", userText: "a third, yet another unrelated prompt" });
  await hooks.context(restored);
  assert.equal(restored.system.length, 1, "unmuting makes the habit eligible for injection again");
}

// ---------------------------------------------------------------------------
// observer on/off: flips options.observer.enabled in place at runtime,
// persists the same setting to .settings.json, and (when on with no
// model configured) blocks the gate on model-unset rather than leaving
// it to read merely "disabled" or "pending".
// ---------------------------------------------------------------------------
async function testObserverOnOff({ assert, makeProjectAndData }) {
  const { projectDir, dataDir } = makeProjectAndData("instinct-observer-toggle");
  const options = { python: "python3", dataDir, observer: { enabled: false, minObservations: 0, runIntervalMinutes: 0 } };
  const ctx = makeCtx(projectDir);
  const project = await resolveProject(ctx, options);

  assert.equal(options.observer.enabled, false, "starts disabled, as configured");

  const onReply = await dispatchInstinct(ctx, options, {}, "s1", "observer on");
  assert.equal(options.observer.enabled, true, "observer on mutates the live options object in place");
  assert.ok(onReply.includes("blocked (model-unset)"), `on with no model set reports the block: ${onReply}`);
  assert.ok(onReply.includes("observer.model"), `on with no model set names what to add to opencode.json: ${onReply}`);

  const settingsAfterOn = await readSettings(project.project_dir);
  assert.equal(settingsAfterOn.observer.enabled, true, "observer on persists to .settings.json");

  const doctorAfterOn = await dispatchInstinct(ctx, options, {}, "s1", "doctor");
  assert.ok(doctorAfterOn.includes("observer gate: blocked (model-unset)"), `doctor's gate line reads model-unset once enabled with no model: ${doctorAfterOn}`);

  const offReply = await dispatchInstinct(ctx, options, {}, "s1", "observer off");
  assert.equal(offReply, "observer: off");
  assert.equal(options.observer.enabled, false, "observer off mutates the live options object in place");

  const settingsAfterOff = await readSettings(project.project_dir);
  assert.equal(settingsAfterOff.observer.enabled, false, "observer off persists too");

  const doctorAfterOff = await dispatchInstinct(ctx, options, {}, "s1", "doctor");
  assert.ok(doctorAfterOff.includes("observer gate: blocked (disabled)"), `doctor's gate line reads disabled once off again: ${doctorAfterOff}`);

  const usage = await dispatchInstinct(ctx, options, {}, "s1", "observer");
  assert.ok(usage.startsWith("Usage:"), "observer with no on/off argument reads as usage text");
}

// ---------------------------------------------------------------------------
// doctor: the same checks collectHealth (lib/health.js) runs, plus the
// observer gate's own verdict; a bogus python binary is listed as a
// finding, and a project with nothing misconfigured reads "all checks
// passed".
// ---------------------------------------------------------------------------
async function testDoctor({ assert, makeProjectAndData }) {
  const { projectDir: bogusDir, dataDir: bogusData } = makeProjectAndData("instinct-doctor-bogus");
  const bogusOptions = { python: "/nonexistent/doctor-smoke-should-never-run", dataDir: bogusData };
  const bogusCtx = makeCtx(bogusDir);
  const bogusReply = await dispatchInstinct(bogusCtx, bogusOptions, {}, "s1", "doctor");
  assert.ok(bogusReply.includes("python not found"), `a bogus python binary is listed as a finding: ${bogusReply}`);
  assert.ok(bogusReply.includes("observer gate:"), `doctor always appends the gate verdict: ${bogusReply}`);

  const { projectDir: healthyDir, dataDir: healthyData } = makeProjectAndData("instinct-doctor-healthy");
  const healthyOptions = { python: "python3", dataDir: healthyData };
  const healthyCtx = makeCtx(healthyDir);
  const healthyReply = await dispatchInstinct(healthyCtx, healthyOptions, {}, "s1", "doctor");
  assert.ok(healthyReply.includes("all checks passed"), `a project with nothing misconfigured reads as healthy: ${healthyReply}`);
}

// ---------------------------------------------------------------------------
// help lists every registered command (including /evolve, /board,
// /skill-review, and every /instinct-* alias) and every /instinct verb;
// the deprecated aliases forward into the same dispatcher, each with its
// own one-line deprecation notice.
// ---------------------------------------------------------------------------
async function testHelpAndAliases({ assert, createPluginHarness, makeProjectAndData }) {
  const { projectDir, dataDir } = makeProjectAndData("instinct-help");
  const options = { python: "python3", dataDir };
  const harness = createPluginHarness(projectDir, options);
  const observerCalls = [];
  const fakeObserver = { run: async (sessionID, opts) => { observerCalls.push({ sessionID, opts }); } };
  const fakeBoard = { refresh: async () => null };
  const fakeReview = { status: async () => ({ open: 0, due: false, reason: "disabled" }), run: async () => {} };

  await registerCommands(harness.ctx, options, fakeObserver, fakeBoard, fakeReview);
  const findCmd = (name) => harness.commandDefs.find((def) => def.name === name);

  await findCmd("instinct").execute({ sessionID: "help-s1", prompt: { text: "" } });
  const helpText = harness.syntheticCalls.at(-1).text;
  for (const name of ["board", "evolve", "skill-review", "instinct", "promote", "instinct-prune", "instinct-status", "instinct-observe"]) {
    assert.ok(helpText.includes(`/${name}:`), `bare /instinct's help lists /${name}: ${helpText}`);
  }
  for (const verb of ["why", "keep <id>", "wrong <id>", "mute <id>", "unmute <id>", "observer on|off", "doctor", "help"]) {
    assert.ok(helpText.includes(`/instinct ${verb}:`), `help lists the /instinct ${verb} verb: ${helpText}`);
  }

  await findCmd("instinct").execute({ sessionID: "help-s2", prompt: { text: "help" } });
  assert.equal(harness.syntheticCalls.at(-1).text, helpText, "explicit 'help' and the bare command render the exact same list");

  // --- deprecated aliases forward into the same dispatcher -------------
  await findCmd("instinct-status").execute({ sessionID: "alias-s1", prompt: { text: "" } });
  const statusAliasReply = harness.syntheticCalls.at(-1).text;
  assert.ok(statusAliasReply.includes("alias of /instinct status; this alias goes away in a later release."), `instinct-status is a deprecated alias: ${statusAliasReply}`);
  assert.ok(statusAliasReply.includes("No instincts found"), "the alias still runs the real status report underneath");

  await findCmd("instinct-projects").execute({ sessionID: "alias-s2", prompt: { text: "" } });
  assert.ok(harness.syntheticCalls.at(-1).text.includes("alias of /instinct projects;"), "instinct-projects forwards into the projects verb");

  await findCmd("instinct-observe").execute({ sessionID: "alias-s3", prompt: { text: "" } });
  assert.equal(observerCalls.length, 1, "instinct-observe actually ran the observer");
  assert.deepEqual(observerCalls[0].opts, { notify: true }, "instinct-observe forces notify, same as the old direct command did");
  assert.equal(
    harness.syntheticCalls.at(-1).text,
    "```\nalias of /instinct observe; this alias goes away in a later release.\n```",
    "observe's own success posts nothing further, so the alias call posts only its own deprecation notice",
  );

  await Promise.allSettled(harness.registrations.map((registration) => registration?.dispose?.()));
}

// ---------------------------------------------------------------------------
// The four pooled directories (lib/inject.js's cachedListInstincts) are
// read once, served from cache on an immediately repeated request, and
// only re-read once this plugin's own write path explicitly invalidates
// the cache (lib/commands-instinct.js's keep/wrong/unmute all do this;
// simulated directly here via the same exported invalidateInjectPool()).
// ---------------------------------------------------------------------------
async function testPoolCache({ assert, makeProjectAndData, contextEvent }) {
  const { projectDir, dataDir } = makeProjectAndData("instinct-pool-cache");
  const options = { python: "python3", dataDir, inject: { enabled: true, max: 5, minConfidence: 0.8 } };
  const ctx = makeCtx(projectDir);
  const project = await resolveProject(ctx, options);

  await writeInstinct(
    project.instincts_personal,
    { id: "cached-habit", trigger: "a habit used only to exercise the pool cache", confidence: 0.9, domain: "workflow", summary: "Cached habit." },
    "# Cached\n",
  );

  const hooks = {};
  const injectCtx = { location: { directory: projectDir }, session: { hook: async (name, cb) => { hooks[name] = cb; return { dispose: async () => {} }; } } };
  await registerInject(injectCtx, options);

  _resetInjectPoolCache();
  await hooks.context(contextEvent({ sessionID: "pool-cache-s1", userText: "first prompt" }));
  const afterFirst = _injectPoolCacheStats().poolDirReads;
  assert.ok(afterFirst > 0, "the first request actually reads the pooled directories at least once");

  await hooks.context(contextEvent({ sessionID: "pool-cache-s1", userText: "second, different prompt, same request pattern" }));
  const afterSecond = _injectPoolCacheStats().poolDirReads;
  assert.equal(afterSecond, afterFirst, "an immediately repeated request serves the pool from cache, with no further directory read");

  invalidateInjectPool();
  await hooks.context(contextEvent({ sessionID: "pool-cache-s1", userText: "third prompt, right after an explicit invalidation" }));
  const afterInvalidate = _injectPoolCacheStats().poolDirReads;
  assert.ok(afterInvalidate > afterSecond, "invalidateInjectPool() forces the very next request to re-read, even though nothing on disk changed");
}

// ---------------------------------------------------------------------------
// .activity.json's appliedToday counts once per genuinely new prompt
// (lib/inject.js's own isNewPrompt dedupe), not once per "context"
// request: a single turn's several tool-call-step requests all carry
// the same latest user message, and injection itself still runs on
// every one of them, but only the first counts as "applied today".
// ---------------------------------------------------------------------------
async function testAppliedOncePerPrompt({ assert, makeProjectAndData, contextEvent }) {
  const { projectDir, dataDir } = makeProjectAndData("instinct-applied-once");
  const options = { python: "python3", dataDir, inject: { enabled: true, max: 5, minConfidence: 0.8 } };
  const ctx = makeCtx(projectDir);
  const project = await resolveProject(ctx, options);

  await writeInstinct(
    project.instincts_personal,
    { id: "applied-habit", trigger: "a habit used only to exercise appliedToday", confidence: 0.9, domain: "workflow", summary: "Applied habit." },
    "# Applied\n",
  );

  const hooks = {};
  const injectCtx = { location: { directory: projectDir }, session: { hook: async (name, cb) => { hooks[name] = cb; return { dispose: async () => {} }; } } };
  await registerInject(injectCtx, options);

  const text = "the exact same latest user message, repeated across tool-call steps";
  await hooks.context(contextEvent({ sessionID: "applied-once-s1", userText: text }));
  await hooks.context(contextEvent({ sessionID: "applied-once-s1", userText: text }));
  await hooks.context(contextEvent({ sessionID: "applied-once-s1", userText: text }));

  const activity = JSON.parse(await fs.readFile(path.join(project.project_dir, ".activity.json"), "utf8"));
  assert.equal(activity.appliedToday, 1, "three requests carrying the same latest user message count as one applied injection, not three");

  await hooks.context(contextEvent({ sessionID: "applied-once-s1", userText: "a genuinely different prompt" }));
  const activityAfterNew = JSON.parse(await fs.readFile(path.join(project.project_dir, ".activity.json"), "utf8"));
  assert.equal(activityAfterNew.appliedToday, 2, "a genuinely new prompt in the same session counts again");
}

// ---------------------------------------------------------------------------
// registerCommands never blocks setup() on resolveProject: it starts the
// chain that reads and applies a previous process's persisted
// /instinct settings (lib/settings.js), registers every command
// immediately, and only applies that startup read to the live options
// object once it actually lands. The python binary here always fails,
// after sleeping, so resolveProject takes a predictable, artificially
// slow path to its own global-bucket fallback (`project_dir` =
// `options.dataDir`, with no subprocess needed to predict it up front).
// ---------------------------------------------------------------------------
async function writeSleepyFailingPython(filePath, sleepMs) {
  await fs.writeFile(filePath, `#!/bin/sh\nsleep ${sleepMs / 1000}\nexit 1\n`, "utf8");
  await fs.chmod(filePath, 0o755);
}

async function testSettingsReadyNonBlocking({ assert, makeProjectAndData, createPluginHarness, waitFor }) {
  const { projectDir, dataDir } = makeProjectAndData("instinct-settings-ready");

  // A persisted toggle "from a previous process": observer enabled true,
  // while this run's own options start disabled, so applying the
  // startup read is the only thing that can flip it.
  await writeSettings(dataDir, { observer: { enabled: true }, muted: [] });

  const sleepMs = 300;
  const sleepyFailingPython = path.join(path.dirname(projectDir), "sleepy-failing-python.sh");
  await writeSleepyFailingPython(sleepyFailingPython, sleepMs);

  const options = { python: sleepyFailingPython, dataDir, observer: { enabled: false } };
  const harness = createPluginHarness(projectDir, options);

  const start = Date.now();
  await registerCommands(harness.ctx, options, { run: async () => {} }, { refresh: async () => null });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < sleepMs / 2, `registerCommands returns well before the slow (${sleepMs}ms) resolveProject settles (took ${elapsed}ms)`);
  assert.equal(options.observer.enabled, false, "the persisted toggle has not landed yet, immediately after registerCommands returns");

  const applied = await waitFor(() => options.observer.enabled === true, { timeoutMs: sleepMs * 4 });
  assert.ok(applied, "the persisted toggle is applied once the slow startup read actually lands");

  await Promise.allSettled(harness.registrations.map((registration) => registration?.dispose?.()));
}

// A command issued right after registerCommands returns, while the slow
// startup read above is still in flight, must still win: every /instinct
// verb that writes settings awaits the same settingsReady promise before
// touching anything, so the startup read is guaranteed to have already
// landed (and already been overridden) by the time that verb's own
// write happens.
async function testSettingsReadyRaceClosedByVerb({ assert, makeProjectAndData, createPluginHarness }) {
  const { projectDir, dataDir } = makeProjectAndData("instinct-settings-ready-race");
  await writeSettings(dataDir, { observer: { enabled: true }, muted: [] });

  const sleepMs = 300;
  const sleepyFailingPython = path.join(path.dirname(projectDir), "sleepy-failing-python-race.sh");
  await writeSleepyFailingPython(sleepyFailingPython, sleepMs);

  const options = { python: sleepyFailingPython, dataDir, observer: { enabled: false } };
  const harness = createPluginHarness(projectDir, options);
  await registerCommands(harness.ctx, options, { run: async () => {} }, { refresh: async () => null });

  const findCmd = (name) => harness.commandDefs.find((def) => def.name === name);
  await findCmd("instinct").execute({ sessionID: "race-s1", prompt: { text: "observer off" } });
  assert.equal(options.observer.enabled, false, "a command issued right after registerCommands still wins over the slower startup read landing later");

  await Promise.allSettled(harness.registrations.map((registration) => registration?.dispose?.()));
}
