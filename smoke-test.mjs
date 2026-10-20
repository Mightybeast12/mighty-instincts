// Fake-ctx smoke test modelled on mighty-reviewer's V2 harness
// (~/dev/mighty-reviewer/smoke-test.mjs). Runs under both Node and Bun
// (package.json's test script), so it imports lib/plugin.js directly
// instead of index.js: index.js resolves the host-provided @opencode/plugin
// package, which is not installed in this standalone checkout.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import { setup } from "./lib/plugin.js";
import { createObserver, parseInstinctBlock } from "./lib/observer.js";
import { resolveProject, siblingInstinctsDir } from "./lib/project.js";
import { appendObservation, writeInstinct } from "./lib/store.js";
import { runCli } from "./lib/cli.js";
import { PKG_NAME } from "./lib/pkg.js";
import {
  MAINTENANCE_DEFAULTS,
  classifyNewInstinct,
  decayStep,
  dedupeOrMerge,
  evolveStep,
  graduatePendingStep,
  promoteStep,
  pruneStep,
  repairStep,
} from "./lib/maintain.js";

// os.tmpdir() resolves under /private/var/folders in the sandboxes this
// plugin is developed in; nesting under opencode/instincts-test keeps every
// fixture this file creates inside that approved scratch area instead of
// scattering directories across the bare temp root.
const TEMP_ROOT = path.join(os.tmpdir(), "opencode", "instincts-test", "smoke");
fsSync.rmSync(TEMP_ROOT, { recursive: true, force: true });
fsSync.mkdirSync(TEMP_ROOT, { recursive: true });

function makeProjectAndData(label) {
  const root = fsSync.mkdtempSync(path.join(TEMP_ROOT, `${label}-`));
  const projectDir = path.join(root, "project");
  const dataDir = path.join(root, "homunculus");
  fsSync.mkdirSync(projectDir, { recursive: true });
  return { projectDir, dataDir };
}

async function readJsonLines(file) {
  const content = await fs.readFile(file, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

// Mirrors the registration/transform/hook shapes mighty-reviewer's smoke
// test fakes for the same V2 ctx surface, scoped to what this plugin uses:
// tool.hook, tool.transform, session.hook, session.synthetic/prompt,
// command.transform. session.hook accumulates every registration under
// its event name; 0.7.0 registers two independent session hooks under two
// different *names*: observe.js's own "prompt" (observation) and
// inject.js's "context" (injection, since 0.7.0 moved off "prompt" onto
// the SessionContext hook so it never has to edit the user's own prompt
// text). `sessionHooks[name]` exposes whichever of those is registered,
// composed into one callable (undefined when nothing registered for that
// name), mirroring how a real host presumably runs every hook registered
// for the same event in turn.
function createPluginHarness(directory, options) {
  const registrations = [];
  const toolHooks = {};
  const sessionHookLists = {};
  const commandDefs = [];
  const toolDefs = [];
  const syntheticCalls = [];
  const promptCalls = [];

  const makeRegistration = () => {
    const registration = { disposed: false, dispose: async () => { registration.disposed = true; } };
    registrations.push(registration);
    return registration;
  };

  const ctx = {
    options,
    location: { directory },
    tool: {
      transform: async (fn) => {
        fn({ add: (def) => toolDefs.push(def) });
        return makeRegistration();
      },
      hook: async (name, cb) => {
        toolHooks[name] = cb;
        return makeRegistration();
      },
    },
    session: {
      hook: async (name, cb) => {
        (sessionHookLists[name] ??= []).push(cb);
        return makeRegistration();
      },
      synthetic: async (input) => {
        syntheticCalls.push(input);
        return {};
      },
      prompt: async (input) => {
        promptCalls.push(input);
        return {};
      },
    },
    command: {
      transform: async (fn) => {
        fn({ add: (def) => commandDefs.push(def) });
        return makeRegistration();
      },
    },
    generate: {
      // Not exercised through the full-plugin harness: the observer stays
      // disabled in these tests, so maybeRun returns before ever reaching
      // generate.text.
      text: async () => ({ text: "<none/>" }),
    },
  };

  const composeHook = (name) => {
    const list = sessionHookLists[name];
    if (!list || list.length === 0) return undefined;
    return async (event) => {
      for (const cb of list) await cb(event);
    };
  };
  const sessionHooks = {
    get prompt() {
      return composeHook("prompt");
    },
    get context() {
      return composeHook("context");
    },
  };

  return { ctx, registrations, toolHooks, sessionHooks, sessionHookLists, commandDefs, toolDefs, syntheticCalls, promptCalls };
}

// Builds a minimal SessionContext-shaped event (@opencode/plugin's
// dist/promise/session.d.ts): the fields lib/inject.js's "context" hook
// reads (`system`, `messages`) plus the ones every SessionContext always
// carries (`sessionID`, `model`, `agent`, `tools`, `options`).
function contextEvent({ sessionID = "ctx-s1", userText = "", system = [], extraMessages = [] } = {}) {
  return {
    sessionID,
    agent: "build",
    model: { providerID: "fakeprov", id: "fakemodel" },
    system,
    messages: [...extraMessages, { role: "user", content: [{ type: "text", text: userText }] }],
    tools: {},
    options: {},
  };
}

// ---------------------------------------------------------------------------
// 1. Full plugin lifecycle: registration shape, tool-call observation
//    (scrubbed + clipped), ignoreTools, prompt observation, observePrompts:
//    false, the /instinct-status command, and cleanup disposal.
// ---------------------------------------------------------------------------
{
  const { projectDir, dataDir } = makeProjectAndData("hooks");
  // Board refresh is unrelated to this section's assertions and would add
  // a real python subprocess call plus filesystem reads of the host's own
  // task-observer / skill-creator directories; disabled here and tested on
  // its own, with controlled fixtures, in section 6 below. Maintenance's
  // own timer is harmless either way (see cleanup() below), but is also
  // unrelated to these assertions.
  const options = { python: "python3", dataDir, board: { enabled: false } };
  const harness = createPluginHarness(projectDir, options);

  const cleanup = await setup(harness.ctx);
  assert.equal(typeof cleanup, "function", "setup returns a cleanup function");
  assert.equal(typeof harness.toolHooks["execute.before"], "function", "execute.before hook registered");
  assert.equal(typeof harness.toolHooks["execute.after"], "function", "execute.after hook registered");
  assert.equal(typeof harness.sessionHooks.prompt, "function", "observe.js's prompt hook registered when observePrompts is on");
  assert.equal(typeof harness.sessionHooks.context, "function", "inject.js's context hook registered when inject.enabled is on");

  const commandNames = harness.commandDefs.map((def) => def.name).sort();
  assert.deepEqual(
    commandNames,
    ["board", "evolve", "instinct-export", "instinct-import", "instinct-observe", "instinct-projects", "instinct-prune", "instinct-status", "promote"].sort(),
    "all nine slash commands registered",
  );
  assert.equal(harness.toolDefs.length, 1, "one tool registered");
  assert.equal(harness.toolDefs[0].id, "instincts", "tool id is instincts");

  const project = await resolveProject(harness.ctx, options);

  await harness.toolHooks["execute.before"]({
    tool: "bash",
    sessionID: "s1",
    agent: "build",
    messageID: "m1",
    id: "t1",
    input: { command: "curl -H 'Authorization: Bearer abcDEF1234567890xyz' https://example.com" },
  });
  await harness.toolHooks["execute.after"]({
    tool: "bash",
    sessionID: "s1",
    agent: "build",
    status: "completed",
    result: { content: "ok, api_key: supersecrettoken12345" },
  });
  // Ignored by default ignoreTools: neither call should append a line.
  await harness.toolHooks["execute.before"]({ tool: "instincts", sessionID: "s1", agent: "build" });
  await harness.toolHooks["execute.after"]({ tool: "instincts", sessionID: "s1", agent: "build", status: "completed", result: { content: "x" } });
  await harness.toolHooks["execute.before"]({ tool: "todowrite", sessionID: "s1", agent: "build", input: { todos: [] } });
  // Array content and error status both feed describeOutput's other branches.
  await harness.toolHooks["execute.after"]({
    tool: "read",
    sessionID: "s1",
    agent: "build",
    status: "completed",
    result: { content: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }] },
  });
  await harness.toolHooks["execute.after"]({
    tool: "bash",
    sessionID: "s1",
    agent: "build",
    status: "error",
    error: { message: "command failed" },
  });
  await harness.sessionHooks.prompt({
    sessionID: "s1",
    messageID: "m2",
    prompt: { text: "use my token: ghp_1234567890ABCDEFGHijklmnop please" },
  });
  // Oversized input is clipped before it ever reaches disk.
  await harness.toolHooks["execute.before"]({
    tool: "write",
    sessionID: "s1",
    agent: "build",
    input: { content: "x".repeat(10_000) },
  });

  const lines = await readJsonLines(project.observations_file);
  assert.equal(lines.length, 6, "ignored tools contributed no observation lines");

  const toolStart = lines.find((line) => line.event === "tool_start" && line.tool === "bash");
  assert.equal(toolStart.session, "s1");
  assert.equal(toolStart.agent, "build");
  assert.equal(toolStart.project_id, project.id);
  assert.equal(toolStart.project_name, project.name);
  assert.ok(!toolStart.input.includes("abcDEF1234567890xyz"), "bearer token scrubbed from tool_start input");
  assert.ok(toolStart.input.includes("[REDACTED]"), "redaction marker present");
  assert.ok(!Number.isNaN(Date.parse(toolStart.timestamp)), "timestamp is ISO-8601");

  const bashCompletions = lines.filter((line) => line.event === "tool_complete" && line.tool === "bash");
  assert.equal(bashCompletions.length, 2, "both bash tool_complete observations recorded");
  const toolComplete = bashCompletions.find((line) => !line.output.startsWith("[error]"));
  assert.ok(toolComplete.output.includes("[REDACTED]"), "tool_complete output scrubbed");
  assert.ok(!toolComplete.output.includes("supersecrettoken12345"), "raw secret absent from tool_complete output");

  const arrayContent = lines.find((line) => line.tool === "read");
  assert.equal(arrayContent.output, "part one\npart two", "array content parts joined");

  const errorLine = bashCompletions.find((line) => line.output.startsWith("[error]"));
  assert.equal(errorLine.output, "[error] command failed");

  const promptLine = lines.find((line) => line.event === "user_prompt");
  assert.ok(promptLine, "prompt recorded as user_prompt");
  assert.equal(promptLine.session, "s1");
  assert.ok(!promptLine.text.includes("ghp_1234567890ABCDEFGHijklmnop"), "prompt token scrubbed");
  assert.ok(promptLine.text.length <= 2000, "prompt text clipped to 2000 chars");

  const clippedLine = lines.find((line) => line.tool === "write");
  assert.ok(clippedLine.input.length <= 5000, "oversized input clipped to 5000 chars");

  // observePrompts: false must skip registering observe.js's own "prompt"
  // hook; inject.js registers its own "context" hook independently
  // (inject.enabled defaults to true, unrelated to observePrompts): with
  // both off, no session hook at all is registered; with only
  // observePrompts off, exactly one ("context") is, and firing it never
  // appends an observation (that is observe.js's job, and it never ran).
  const { projectDir: noPromptDir, dataDir: noPromptData } = makeProjectAndData("no-prompt");
  const noPromptHarness = createPluginHarness(noPromptDir, {
    python: "python3",
    dataDir: noPromptData,
    observePrompts: false,
    inject: { enabled: false },
    board: { enabled: false },
  });
  const noPromptCleanup = await setup(noPromptHarness.ctx);
  assert.equal(
    noPromptHarness.sessionHooks.prompt,
    undefined,
    "no 'prompt' hook at all when observePrompts is false",
  );
  assert.equal(
    noPromptHarness.sessionHooks.context,
    undefined,
    "no 'context' hook at all when inject.enabled is false",
  );
  await noPromptCleanup();

  const { projectDir: injectOnlyDir, dataDir: injectOnlyData } = makeProjectAndData("no-observe-prompts");
  const injectOnlyHarness = createPluginHarness(injectOnlyDir, {
    python: "python3",
    dataDir: injectOnlyData,
    observePrompts: false,
    board: { enabled: false },
  });
  const injectOnlyCleanup = await setup(injectOnlyHarness.ctx);
  assert.equal(injectOnlyHarness.sessionHooks.prompt, undefined, "with observePrompts off, no 'prompt' hook is registered at all");
  assert.equal(
    injectOnlyHarness.sessionHookLists.context?.length,
    1,
    "with observePrompts off, injection's 'context' hook is still registered",
  );
  const injectOnlyProject = await resolveProject(injectOnlyHarness.ctx, { python: "python3", dataDir: injectOnlyData });
  await injectOnlyHarness.sessionHooks.context(contextEvent({ sessionID: "s2", userText: "anything at all" }));
  const injectOnlyLines = await readJsonLines(injectOnlyProject.observations_file).catch(() => []);
  assert.equal(injectOnlyLines.length, 0, "with observePrompts off, firing the context hook never becomes a user_prompt observation");
  await injectOnlyCleanup();

  // /instinct-status runs the CLI directly and posts a synthetic reply;
  // it must never go through ctx.session.prompt.
  const statusCommand = harness.commandDefs.find((def) => def.name === "instinct-status");
  await statusCommand.execute({ sessionID: "cmd-session", prompt: { text: "" } });
  const statusReply = harness.syntheticCalls.find((call) => call.sessionID === "cmd-session");
  assert.ok(statusReply, "instinct-status posted a synthetic reply");
  assert.equal(statusReply.resume, false, "synthetic reply never resumes the agent");
  assert.equal(statusReply.delivery, "queue");
  assert.equal(statusReply.description, PKG_NAME);
  assert.ok(statusReply.text.includes("No instincts found"), "status reflects the empty instinct store");
  assert.equal(harness.promptCalls.length, 0, "ctx.session.prompt is never called");

  // The instincts tool itself only exposes the read-only subset and never
  // forwards --force, --generate, or --output. Every path returns a
  // Tool.Result object ({ content }); the host rejects bare strings.
  const instinctsTool = harness.toolDefs[0];
  const call = async (input) => {
    const result = await instinctsTool.execute(input);
    assert.equal(typeof result, "object", "tool returns a Tool.Result object");
    assert.equal(typeof result.content, "string", "Tool.Result carries string content");
    return result.content;
  };
  assert.ok((await call({ action: "status" })).includes("No instincts found"), "tool status call reaches the real CLI");
  assert.equal(await call({ action: "import" }), "Action not permitted for the instincts tool: import");
  assert.equal(await call({ action: "status", args: "--force" }), "The instincts tool never passes --force.");
  assert.equal(
    await call({ action: "evolve", args: "--generate" }),
    "The instincts tool cannot generate evolved structures (--generate is not permitted).",
  );
  assert.equal(
    await call({ action: "export", args: "--output somewhere.yaml" }),
    "The instincts tool exports to stdout only (no --output).",
  );
  const dryRunPromote = await call({ action: "promote" });
  assert.ok(dryRunPromote.length > 0, "promote through the tool runs (forced --dry-run) and returns CLI text");

  await cleanup();
  assert.ok(harness.registrations.length > 0, "cleanup had registrations to dispose");
  assert.ok(harness.registrations.every((registration) => registration.disposed), "cleanup disposed every registration");
}

// ---------------------------------------------------------------------------
// 2. Observer: threshold gating, <instinct> block validation (good body,
//    a stray '---' in the body, an invalid id, and a duplicate of an
//    inherited instinct), forced project scope, and the log/notify side
//    effects of a run.
// ---------------------------------------------------------------------------
{
  const { projectDir, dataDir } = makeProjectAndData("observer");
  const options = {
    python: "python3",
    dataDir,
    observer: { enabled: true, model: "fakeprov/fakemodel", runIntervalMinutes: 5, minObservations: 3, maxAnalysisLines: 300, notify: true },
  };

  const syntheticCalls = [];
  let generateCalls = 0;
  const modelOutput = buildFakeObserverOutput();
  const ctx = {
    location: { directory: projectDir },
    generate: {
      text: async (args) => {
        generateCalls += 1;
        assert.deepEqual(args.model, { providerID: "fakeprov", id: "fakemodel" }, "observer.model parsed into providerID/id");
        return { text: modelOutput };
      },
    },
    session: {
      synthetic: async (input) => {
        syntheticCalls.push(input);
        return {};
      },
    },
  };

  const observer = createObserver(ctx, options);
  const project = await resolveProject(ctx, options);

  // A pre-existing inherited instinct with the same id as one of the
  // fake model's "valid" blocks exercises the inherited-dedup rule.
  await writeInstinct(
    project.instincts_inherited,
    { id: "grep-before-edit", trigger: "when editing unfamiliar files", confidence: 0.6, domain: "workflow", scope: "project" },
    "# Grep Before Edit\n\n## Action\nSearch before editing.\n",
  );

  for (let i = 0; i < 2; i++) {
    await appendObservation(project, { event: "tool_start", tool: "edit", session: "obs-session", agent: "build", project_id: project.id, project_name: project.name, input: `edit ${i}` });
  }
  await observer.maybeRun("obs-session");
  assert.equal(generateCalls, 0, "observer does not run below minObservations");

  await appendObservation(project, { event: "tool_start", tool: "edit", session: "obs-session", agent: "build", project_id: project.id, project_name: project.name, input: "edit 2" });
  // Hooks fire concurrently; three overlapping triggers must produce one
  // run. A fresh observer instance for this check: `observer`'s own
  // per-instance, 30s line-count throttle would otherwise still be
  // holding the stale 2-line count it read a moment ago in the assertion
  // above, masking the observation just appended.
  const thresholdObserver = createObserver(ctx, options);
  await Promise.all([
    thresholdObserver.maybeRun("obs-session"),
    thresholdObserver.maybeRun("obs-session"),
    thresholdObserver.maybeRun("obs-session"),
  ]);
  assert.equal(generateCalls, 1, "observer runs once the threshold is met, and only once under concurrent triggers");

  const writtenFiles = await fs.readdir(project.instincts_personal);
  assert.deepEqual(writtenFiles, ["prefer-functional-components.md"], "only the one fully-valid, non-duplicate block was written");

  const writtenContent = await fs.readFile(path.join(project.instincts_personal, "prefer-functional-components.md"), "utf8");
  assert.ok(writtenContent.includes("scope: project"), "scope forced to project");
  assert.ok(writtenContent.includes(`project_id: ${project.id}`), "project_id stamped on the written instinct");
  assert.ok(writtenContent.includes(`project_name: ${project.name}`), "project_name stamped on the written instinct");
  assert.ok(writtenContent.includes('summary: "Use functional components with hooks."'), "the model's summary field is kept");
  assert.ok(/created: \d{4}-\d{2}-\d{2}T/.test(writtenContent), "a created: timestamp is stamped at write time");

  const logContent = await fs.readFile(path.join(project.project_dir, "observer.log"), "utf8");
  assert.ok(/run: 1 written, 3 rejected, model fakeprov\/fakemodel/.test(logContent), `observer.log recorded the run: ${logContent}`);
  assert.ok(logContent.includes(" ids: prefer-functional-components"), `observer.log carries the written ids suffix: ${logContent}`);
  assert.ok(
    logContent.includes(
      " rejected: grep-before-edit: duplicate of an inherited instinct; body contains a '---' line; invalid id: Not_A_Valid_ID!",
    ),
    `observer.log carries the rejection reasons suffix: ${logContent}`,
  );

  const notice = syntheticCalls.find((call) => call.sessionID === "obs-session");
  assert.ok(notice, "observer posted a notify synthetic for the background run");
  assert.equal(notice.resume, false);
  assert.equal(notice.delivery, "queue");
  assert.ok(notice.text.includes("1 written, 3 rejected"), "notify summary matches the log line");

  // The run above just wrote lastRunAt into .observer-state.json; a fresh
  // observer instance for the same project must now reject on the interval
  // gate alone without ever reading, let alone re-counting, the
  // observations file.
  const gatedObserver = createObserver(ctx, options);
  assert.equal(gatedObserver._countLineReads(), 0, "fresh observer instance starts with zero observation-file reads");
  await gatedObserver.maybeRun("obs-session");
  assert.equal(generateCalls, 1, "interval gate rejects the run without calling generate.text again");
  assert.equal(gatedObserver._countLineReads(), 0, "interval gate short-circuits before counting observation lines");

  // -------------------------------------------------------------------------
  // 3. cli.js argv/path allowlists, reusing this project so the final
  //    real-CLI call can report the instinct this test just wrote.
  // -------------------------------------------------------------------------
  const pathEscape = await runCli(options, "export", "--output ../escape.yaml", { directory: projectDir });
  assert.ok(pathEscape.includes("escapes the project directory"), `export --output path traversal rejected: ${pathEscape}`);

  const repeatedFlag = await runCli(options, "export", "--output a.yaml --output b.yaml", { directory: projectDir });
  assert.ok(repeatedFlag.includes("given more than once"), `repeated flag rejected: ${repeatedFlag}`);

  const unknownFlag = await runCli(options, "status", "--not-a-real-flag", { directory: projectDir });
  assert.ok(unknownFlag.includes("Flag not permitted"), `unknown flag rejected: ${unknownFlag}`);

  const unknownAction = await runCli(options, "nuke", "", { directory: projectDir });
  assert.ok(unknownAction.includes("Unknown instincts action"), `unknown action rejected: ${unknownAction}`);

  const noProjectsSubcommand = await runCli(options, "projects", "delete some-id --force", { directory: projectDir });
  assert.ok(noProjectsSubcommand.toLowerCase().includes("not permitted"), `projects delete/merge/gc unreachable: ${noProjectsSubcommand}`);

  const statusOutput = await runCli(options, "status", "", { directory: projectDir });
  assert.ok(statusOutput.includes("prefer-functional-components"), "real instinct-cli.py status reports the instinct this test wrote");
  assert.ok(statusOutput.includes("2 total"), `instinct-cli.py count agrees with what this test wrote (1 personal + 1 inherited): ${statusOutput}`);
}

// ---------------------------------------------------------------------------
// 2b. lib/observer.js's parseInstinctBlock: the `summary:` field is
//     required (missing / over 160 chars rejected, over 120 trimmed at
//     parse time), and a trigger carrying a leaked trailing `confidence:`
//     (or domain:/scope:/source:) fragment is rejected outright.
// ---------------------------------------------------------------------------
{
  const goodBlock = [
    "---",
    "id: good-instinct",
    'trigger: "run tests before pushing"',
    "confidence: 0.7",
    "domain: workflow",
    'summary: "Run the test suite before every push."',
    "---",
    "# Good",
    "",
    "## Action",
    "Run tests first.",
  ].join("\n");
  const parsedGood = parseInstinctBlock(goodBlock);
  assert.equal(parsedGood.error, undefined, "a fully valid block (with summary) parses without error");
  assert.equal(parsedGood.fields.summary, "Run the test suite before every push.");

  const leakedTrigger = [
    "---",
    "id: leaky",
    'trigger: "run tests before pushing, confidence: 0.9"',
    "confidence: 0.7",
    "domain: workflow",
    'summary: "Run tests."',
    "---",
    "# Leaky",
    "",
    "## Action",
    "Run tests first.",
  ].join("\n");
  const parsedLeaked = parseInstinctBlock(leakedTrigger);
  assert.ok(
    parsedLeaked.error?.includes("leaked frontmatter field"),
    `a trigger carrying a trailing 'confidence:' fragment is rejected: ${parsedLeaked.error}`,
  );

  const missingSummary = ["---", "id: no-summary", 'trigger: "run tests before pushing"', "confidence: 0.7", "domain: workflow", "---", "# No Summary", "", "## Action", "Run tests first."].join(
    "\n",
  );
  const parsedMissing = parseInstinctBlock(missingSummary);
  assert.ok(parsedMissing.error?.includes("missing summary"), `a block with no summary field is rejected: ${parsedMissing.error}`);

  const longSummary = [
    "---",
    "id: long-summary",
    'trigger: "run tests before pushing"',
    "confidence: 0.7",
    "domain: workflow",
    `summary: "${"x".repeat(161)}"`,
    "---",
    "# Long",
    "",
    "## Action",
    "Run tests first.",
  ].join("\n");
  const parsedLong = parseInstinctBlock(longSummary);
  assert.ok(parsedLong.error?.includes("too long"), `a summary over 160 chars is rejected: ${parsedLong.error}`);

  const clippableSummary = [
    "---",
    "id: clip-summary",
    'trigger: "run tests before pushing"',
    "confidence: 0.7",
    "domain: workflow",
    `summary: "${"y".repeat(130)}"`,
    "---",
    "# Clip",
    "",
    "## Action",
    "Run tests first.",
  ].join("\n");
  const parsedClip = parseInstinctBlock(clippableSummary);
  assert.equal(parsedClip.error, undefined, "a summary between 120 and 160 chars is trimmed, not rejected");
  assert.equal(parsedClip.fields.summary.length, 120, "a long-but-under-160 summary is trimmed to 120 at write time");
}

// ---------------------------------------------------------------------------
// 2c. lib/observer.js's missing-summary backfill: an existing personal
//     instinct with no `summary:` field gets listed in the next observer
//     run's prompt (a "## Missing Summaries" section), even with zero new
//     observations, instructing the model to add only a summary.
// ---------------------------------------------------------------------------
{
  const { projectDir, dataDir } = makeProjectAndData("missing-summary");
  const options = {
    python: "python3",
    dataDir,
    observer: { enabled: true, model: "fakeprov/fakemodel", runIntervalMinutes: 5, minObservations: 20, maxAnalysisLines: 300, notify: false },
    maintenance: { ...MAINTENANCE_DEFAULTS },
  };
  const fixedCreated = new Date(Date.now() - 45 * 86400000).toISOString();
  let capturedPrompt = "";
  const backfillResponse = `<instinct>\n---\nid: legacy-habit\ntrigger: "legacy trigger text"\nconfidence: 0.6\ndomain: misc\nsummary: "Do the legacy thing."\n---\n# Legacy\n\n## Action\nDo the legacy thing.\n</instinct>`;
  const ctx = {
    location: { directory: projectDir },
    generate: {
      text: async (args) => {
        capturedPrompt = args.prompt;
        return { text: backfillResponse };
      },
    },
    session: { synthetic: async () => ({}) },
  };
  const project = await resolveProject(ctx, options);
  await writeInstinct(
    project.instincts_personal,
    { id: "legacy-habit", trigger: "legacy trigger text", confidence: 0.6, domain: "misc", created: fixedCreated },
    "# Legacy\n\n## Action\nDo the legacy thing.\n",
  );

  const observer = createObserver(ctx, options);
  const summary = await observer.run("sess-missing", { notify: false });
  assert.ok(capturedPrompt.includes("## Missing Summaries"), "an existing instinct with no summary triggers the backfill prompt section");
  assert.ok(capturedPrompt.includes("legacy-habit"), "the missing-summary section names the instinct");
  assert.ok(!summary.includes("run skipped"), "a run with zero new observations but a missing summary still executes");

  const backfilledContent = await fs.readFile(path.join(project.instincts_personal, "legacy-habit.md"), "utf8");
  assert.ok(backfilledContent.includes('summary: "Do the legacy thing."'), "the resubmitted block's summary is written");
  assert.ok(backfilledContent.includes(`created: ${fixedCreated}`), "a summary-only backfill preserves the instinct's original created: date instead of resetting its age");
}

// ---------------------------------------------------------------------------
// 4. project.js: concurrent first resolveProject calls for a directory with
//    no cache entry yet share one in-flight resolution, i.e. spawn one
//    python subprocess rather than one per caller. Counted by pointing
//    options.python at a wrapper script (under the scratch root) that
//    tallies its own invocations before exec'ing the real interpreter.
// ---------------------------------------------------------------------------
{
  const { projectDir, dataDir } = makeProjectAndData("concurrent-resolve");
  const spawnCountFile = path.join(path.dirname(projectDir), "spawn-count");
  fsSync.writeFileSync(spawnCountFile, "");
  const countingPython = path.join(path.dirname(projectDir), "counting-python.sh");
  fsSync.writeFileSync(countingPython, `#!/bin/sh\necho x >> '${spawnCountFile}'\nexec python3 "$@"\n`);
  fsSync.chmodSync(countingPython, 0o755);

  const options = { python: countingPython, dataDir };
  const ctx = { location: { directory: projectDir } };

  const results = await Promise.all([
    resolveProject(ctx, options),
    resolveProject(ctx, options),
    resolveProject(ctx, options),
  ]);
  assert.ok(
    results.every((info) => info.id === results[0].id),
    "all concurrent first-time resolveProject calls for the same directory resolve to the same project",
  );
  const spawnCount = (await fs.readFile(spawnCountFile, "utf8")).split("\n").filter((line) => line.trim().length > 0).length;
  assert.equal(spawnCount, 1, "concurrent first resolveProject calls for one directory share a single python subprocess");
}

// ---------------------------------------------------------------------------
// 5. tui.js: importing it outside the TUI never throws, and setup() with a
//    stub ctx that has no ui.slot returns a disposer without ever importing
//    sidebar.js (which needs the host's @opentui/solid / solid-js and would
//    throw in this plain-node test run if it were loaded).
// ---------------------------------------------------------------------------
{
  const tuiPlugin = (await import("./tui.js")).default;
  assert.equal(tuiPlugin.id, PKG_NAME, "tui companion shares the plugin id");
  assert.equal(typeof tuiPlugin.setup, "function", "tui companion exports setup");

  const cleanup = await tuiPlugin.setup({});
  assert.equal(typeof cleanup, "function", "tui setup returns a disposer even with no ui.slot");
  await cleanup();
}

// ---------------------------------------------------------------------------
// 6. Board state builder (lib/board.js): given 3 personal instinct files
//    across two domains (confidences 0.9/0.85/0.6), a fake observer.log
//    (3 lines), .observer-state.json / observations.jsonl, a
//    task-observer fixture (3 open files with skills and dates
//    today/3 days ago/30 days ago, plus 1 parked), and an eval fixture
//    (x-workspace/iteration-2/benchmark.json with a failing expectation,
//    mirroring the schema skill-creator writes), produces the expected
//    richer facts (including the 0.7.0 additions: readyToShare,
//    firedToday, awaitingFirstUse, skillCandidates, maintenance), writes
//    board-state.json atomically under the ~50 KB budget, and writes a
//    pointer file that resolves back to it the same way the TUI side's
//    own hashing would.
// ---------------------------------------------------------------------------
{
  const { refreshBoardState } = await import("./lib/board.js");
  const { pointerFilePath } = await import("./lib/board-pointer.js");

  const { projectDir, dataDir } = makeProjectAndData("board");
  const taskObserverRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "task-observer-"));
  const evalRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "eval-"));

  const options = {
    python: "python3",
    dataDir,
    observer: { runIntervalMinutes: 10 },
    board: { observationsRoot: taskObserverRoot, evalRoots: [evalRoot] },
  };
  const ctx = { location: { directory: projectDir } };
  const project = await resolveProject(ctx, options);

  // Three personal instinct files, two domains, three distinct
  // confidences; no inherited, no global-personal files. mtimes are set
  // explicitly (rather than trusted to real wall-clock write order) so
  // the "newest instinct" fact is deterministic.
  await writeInstinct(project.instincts_personal, { id: "alpha-instinct", trigger: "a", confidence: 0.9, domain: "workflow" }, "# Alpha\n");
  await writeInstinct(project.instincts_personal, { id: "beta-instinct", trigger: "b", confidence: 0.85, domain: "workflow" }, "# Beta\n");
  await writeInstinct(project.instincts_personal, { id: "gamma-instinct", trigger: "c", confidence: 0.6, domain: "tooling" }, "# Gamma\n");
  const now = Date.now();
  const touch = (id, daysAgo) => {
    const when = new Date(now - daysAgo * 86400000);
    fsSync.utimesSync(path.join(project.instincts_personal, `${id}.md`), when, when);
  };
  touch("alpha-instinct", 3);
  touch("beta-instinct", 1);
  touch("gamma-instinct", 0);

  // Fake observer state: 5 lines counted 2 minutes ago, 10-minute
  // interval, so the next run is eligible in 8 minutes.
  const lastRunAt = new Date(now - 2 * 60000).toISOString();
  await fs.mkdir(project.project_dir, { recursive: true });
  await fs.writeFile(path.join(project.project_dir, ".observer-state.json"), JSON.stringify({ lastRunAt, lastLineCount: 5 }), "utf8");
  // 19 observation lines on disk now: 14 pending since the last run.
  await fs.writeFile(project.observations_file, Array.from({ length: 19 }, (_, i) => JSON.stringify({ n: i })).join("\n") + "\n", "utf8");

  // Fake observer.log: 3 runs, summing to 3 written and 3 rejected; the
  // ids/rejected-reasons suffixes (lib/observer.js) are present but never
  // parsed back out by lib/board.js's RUN_LINE match.
  await fs.writeFile(
    path.join(project.project_dir, "observer.log"),
    [
      "2026-10-01T00:00:00.000Z run: 2 written, 1 rejected, model fakeprov/fakemodel ids: a,b rejected: x",
      "2026-10-02T00:00:00.000Z run: 1 written, 0 rejected, model fakeprov/fakemodel ids: c",
      "2026-10-03T00:00:00.000Z run: 0 written, 2 rejected, model fakeprov/fakemodel rejected: y; z",
    ].join("\n") + "\n",
    "utf8",
  );

  // task-observer fixture: 3 open files (one explicit status, one by
  // omission, one explicit) with skills and three distinct dates, plus 1
  // parked file excluded from every one of the new facts below.
  const today = new Date(now).toISOString().slice(0, 10);
  const threeDaysAgo = new Date(now - 3 * 86400000).toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
  const logDir = path.join(taskObserverRoot, "skill-observations", "observation-log");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, "0001-open.md"),
    `---\nstatus: open\ntitle: "Open A"\nskill: [workflow, tooling]\ndate: ${today}\n---\nbody\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(logDir, "0002-open-by-omission.md"),
    `---\ntitle: "Open B"\nskill: [workflow]\ndate: ${threeDaysAgo}\n---\nbody\n`,
    "utf8",
  );
  await fs.writeFile(path.join(logDir, "0003-parked.md"), "---\nstatus: parked\n---\nbody\n", "utf8");
  await fs.writeFile(
    path.join(logDir, "0004-open-old.md"),
    `---\nstatus: open\ntitle: "Open D"\nskill: [workflow]\ndate: ${thirtyDaysAgo}\n---\nbody\n`,
    "utf8",
  );
  await fs.writeFile(path.join(taskObserverRoot, "skill-observations", "last-review-date.txt"), "2026-10-01\n", "utf8");
  await fs.mkdir(path.join(taskObserverRoot, "skill-updates"), { recursive: true });
  await fs.writeFile(
    path.join(taskObserverRoot, "skill-updates", "PENDING.md"),
    [
      "# Staged updates manifest",
      "",
      "## 2026-10-01-a (first): installed",
      "- done",
      "",
      "## 2026-10-02-b (second): staged",
      "- pending",
      "",
      "## 2026-10-03-c (third): staged",
      "- pending",
      "",
    ].join("\n"),
    "utf8",
  );

  // Eval fixture: mirrors the schema skill-creator writes at
  // <workspace>/iteration-N/benchmark.json, verified against a live run's
  // output.
  const evalTimestamp = new Date(now - 2 * 86400000).toISOString();
  const iterationDir = path.join(evalRoot, "x-workspace", "iteration-2");
  await fs.mkdir(iterationDir, { recursive: true });
  await fs.writeFile(
    path.join(iterationDir, "benchmark.json"),
    JSON.stringify({
      metadata: { skill_name: "pr", timestamp: evalTimestamp, evals_run: [1, 2], runs_per_configuration: 2 },
      runs: [
        { configuration: "with_skill", expectations: [{ text: "Output is valid", passed: true, evidence: "ok" }] },
        { configuration: "without_skill", expectations: [{ text: "Handles edge case", passed: false, evidence: "missing branch" }] },
        { configuration: "with_skill", expectations: [{ text: "Output is valid", passed: true, evidence: "ok" }] },
        { configuration: "without_skill", expectations: [{ text: "Handles edge case", passed: false, evidence: "missing branch" }] },
      ],
      run_summary: {
        without_skill: { pass_rate: { mean: 0.08, stddev: 0.02 } },
        with_skill: { pass_rate: { mean: 0.92, stddev: 0.03 } },
        delta: { pass_rate: "+0.84" },
      },
    }),
    "utf8",
  );

  const state = await refreshBoardState(ctx, options);

  assert.equal(state.instincts.project, 3, "three personal instincts counted");
  assert.equal(state.instincts.inherited, 0);
  assert.equal(state.instincts.global, 0, "no global-personal instinct files");
  assert.equal(state.instincts.lastRun, lastRunAt);
  assert.equal(state.instincts.pendingObservations, 14, "19 lines on disk minus 5 counted last run");
  assert.equal(
    state.instincts.nextRunEligibleAt,
    new Date(new Date(lastRunAt).getTime() + 10 * 60000).toISOString(),
    "next run eligible 10 minutes after lastRunAt",
  );
  assert.equal(state.instincts.readyToShare, 2, "0.9 and 0.85 both clear the 0.8 promote threshold and neither is in the (empty) global bucket");
  assert.equal(state.instincts.newestId, "gamma-instinct", "gamma-instinct has the latest mtime (touched to 'now')");
  assert.ok(typeof state.instincts.newestAt === "string" && !Number.isNaN(Date.parse(state.instincts.newestAt)));
  assert.equal(state.instincts.runs, 3, "3 observer.log run lines");
  assert.equal(state.instincts.written, 3, "2 + 1 + 0 written summed across the 3 run lines");
  assert.equal(state.instincts.rejected, 3, "1 + 0 + 2 rejected summed across the 3 run lines");
  assert.deepEqual(
    state.instincts.list.map((inst) => ({ id: inst.id, confidence: inst.confidence, domain: inst.domain, trigger: inst.trigger })),
    [
      { id: "alpha-instinct", confidence: 0.9, domain: "workflow", trigger: "a" },
      { id: "beta-instinct", confidence: 0.85, domain: "workflow", trigger: "b" },
      { id: "gamma-instinct", confidence: 0.6, domain: "tooling", trigger: "c" },
    ],
    "instincts.list sorted by confidence desc",
  );
  assert.equal(state.instincts.lastWriteAt, "2026-10-02T00:00:00.000Z", "lastWriteAt is the timestamp of the most recent run line with written > 0");
  assert.equal(state.instincts.lastObservedAt, null, "no .activity.json written in this fixture, so lastObservedAt stays null");
  assert.equal(state.instincts.appliedToday, 0, "no .activity.json written in this fixture, so appliedToday stays 0");
  assert.equal(state.instincts.firedToday, 0, "no .activity.json written in this fixture, so firedToday stays 0");
  assert.equal(state.instincts.awaitingFirstUse, 0, "no instincts/pending directory exists yet");
  assert.equal(state.instincts.skillCandidates, 0, "no evolved/ candidate files exist yet");
  assert.equal(state.instincts.candidatesPath, project.evolved_dir, "the hint path is the project's own evolved dir");
  assert.deepEqual(
    state.instincts.maintenance,
    { lastRunAt: null, lastEvolveAt: null, counts7d: { promoted: 0, archived: 0, merged: 0, pruned: 0, candidates: 0, repaired: 0 } },
    "no maintenance.log yet, so the maintenance summary is all-empty",
  );

  assert.equal(state.observations.available, true);
  assert.equal(state.observations.open, 3, "two explicit opens plus the file with no status line");
  assert.equal(state.observations.parked, 1);
  assert.equal(state.observations.lastReview, "2026-10-01");
  assert.equal(state.observations.staged, 2, "1 of 3 headings says installed");
  assert.equal(state.observations.addedToday, 1, "only the today-dated open file counts");
  assert.equal(state.observations.added7d, 2, "today + 3-days-ago open files fall within the 7-day window");
  assert.equal(state.observations.warning, false, "only 3 open observations, well under the 100-open warning threshold");

  assert.equal(state.evals.available, true);
  assert.equal(state.evals.skill, "pr");
  assert.equal(state.evals.withSkill, 0.92);
  assert.equal(state.evals.baseline, 0.08);
  assert.equal(state.evals.baselineKind, "without", "without_skill baseline config reads as the 'without' naming convention");
  assert.equal(state.evals.timestamp, evalTimestamp);

  // The state file and pointer file are both written, atomically, and the
  // pointer resolves back to the exact state file path.
  const stateFile = path.join(project.project_dir, "board-state.json");
  const onDisk = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.deepEqual(onDisk, state, "board-state.json on disk matches the returned state");
  assert.ok(Buffer.byteLength(JSON.stringify(state), "utf8") < 50 * 1024, "board-state.json stays comfortably under the ~50 KB budget");

  const pointerPath = pointerFilePath(options, projectDir);
  const pointer = JSON.parse(await fs.readFile(pointerPath, "utf8"));
  assert.equal(pointer.boardStatePath, stateFile, "pointer file resolves to the real state file");
}

// ---------------------------------------------------------------------------
// 6b. lib/board-observations.js's `warning` fact (open > 100 and the last
//     review is never or stale): exercised directly, since building 101
//     files through the full board builder above would only restate the
//     same open-file loop at a hundred-times scale.
// ---------------------------------------------------------------------------
{
  const { readTaskObserverSummary } = await import("./lib/board-observations.js");

  const warnRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "task-observer-warn-"));
  const logDir = path.join(warnRoot, "skill-observations", "observation-log");
  await fs.mkdir(logDir, { recursive: true });
  for (let i = 0; i < 101; i++) {
    await fs.writeFile(path.join(logDir, `${String(i).padStart(4, "0")}-open.md`), "---\nstatus: open\n---\nbody\n", "utf8");
  }
  const noReview = await readTaskObserverSummary(warnRoot);
  assert.equal(noReview.open, 101);
  assert.equal(noReview.warning, true, "over 100 open and a never-reviewed backlog warns");

  await fs.writeFile(path.join(warnRoot, "skill-observations", "last-review-date.txt"), `${new Date().toISOString().slice(0, 10)}\n`, "utf8");
  const freshReview = await readTaskObserverSummary(warnRoot);
  assert.equal(freshReview.warning, false, "over 100 open but reviewed today does not warn");
}

// ---------------------------------------------------------------------------
// 6c. lib/board-evals.js's `runs` fallback formula (runs_per_configuration *
//     evals_run.length * 2) for benchmark.json shapes that omit the full
//     per-run `runs` array, and a benchmark.json with no failing
//     expectation at all (firstFailure stays null).
// ---------------------------------------------------------------------------
{
  const { readEvalsSummary } = await import("./lib/board-evals.js");

  const evalRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "eval-fallback-"));
  const iterationDir = path.join(evalRoot, "y-workspace", "iteration-1");
  await fs.mkdir(iterationDir, { recursive: true });
  await fs.writeFile(
    path.join(iterationDir, "benchmark.json"),
    JSON.stringify({
      metadata: { skill_name: "no-runs-array", evals_run: [1, 2, 3], runs_per_configuration: 2 },
      run_summary: {
        without_skill: { pass_rate: { mean: 0.1 } },
        with_skill: { pass_rate: { mean: 0.9 } },
      },
    }),
    "utf8",
  );
  const fallback = await readEvalsSummary([evalRoot]);
  assert.equal(fallback.runs, 12, "2 runs_per_configuration * 3 evals_run * 2 configurations");
  assert.equal(fallback.firstFailure, null, "no runs array at all means no failure to report");
  assert.deepEqual(fallback.stddev, { with: null, baseline: null }, "no stddev reported in this shape");

  const noneRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "eval-none-"));
  const noneResult = await readEvalsSummary([noneRoot]);
  assert.equal(noneResult.runs, null, "no benchmark.json at all: runs stays null rather than 0");
  assert.equal(noneResult.firstFailure, null);
}

// ---------------------------------------------------------------------------
// 7. /board summary text (lib/board-format.js) must never throw, including
//    when the board has not been written yet or every block reports itself
//    unavailable, and must use the same block labels/wording as the
//    sidebar panel (lib/board-text.js), just as plain text with dot-filled
//    alignment and a trailing legend row.
// ---------------------------------------------------------------------------
{
  const { formatBoardSummary } = await import("./lib/board-format.js");

  let missing;
  assert.doesNotThrow(() => {
    missing = formatBoardSummary(null, {});
  }, "missing board state never throws");
  assert.equal(typeof missing, "string");
  assert.ok(missing.includes("Board state not written yet"));

  const everythingUnavailable = {
    updatedAt: new Date().toISOString(),
    instincts: null,
    observations: { open: 0, parked: 0, lastReview: null, staged: 0, root: "/nowhere", available: false },
    evals: { skill: null, delta: null, withSkill: null, baseline: null, baselineKind: null, iteration: null, path: null, available: false },
  };
  let summary;
  assert.doesNotThrow(() => {
    summary = formatBoardSummary(everythingUnavailable, {});
  }, "an all-unavailable board state never throws");
  assert.equal(typeof summary, "string");
  assert.ok(summary.includes("Learned habits"), "the instincts block renders under its plain-language label");
  assert.ok(summary.includes("Skill notes"), "the observations block renders under its plain-language label");
  assert.ok(summary.includes("Skill test"), "the evals block (no skill name on record) renders as the bare 'Skill test' label");
  assert.ok(summary.includes("none"), "an unavailable block's headline reads 'none'");
  assert.ok(summary.includes("active") && summary.includes("needs attention") && summary.includes("stale"), "the legend row is always appended");
  assert.ok(!/[\u2014\u2013]/.test(summary), "/board text never contains an em or en dash");

  const disabledSections = formatBoardSummary(everythingUnavailable, { board: { sections: { instincts: false, observations: false, evals: false } } });
  assert.equal(disabledSections, "No board sections enabled.", "every block can be hidden independently");
}

// ---------------------------------------------------------------------------
// 8. lib/board-text.js: the structured block model and alignRow helper
//    shared by the sidebar panel and /board, exercised directly (pure
//    functions, no ctx needed). Covers all three glyph states for the
//    instincts block, hint-row presence/omission, the observations and
//    evals blocks' own glyph rules, and alignRow's right-alignment math.
// ---------------------------------------------------------------------------
{
  const { alignRow, buildEvalsBlock, buildInstinctsBlock, buildObservationsBlock, GLYPH_CHAR, LEGEND, PANEL_WIDTH } = await import("./lib/board-text.js");

  // --- alignRow -------------------------------------------------------
  assert.equal(alignRow("open", "398", { fill: "." }), `open ${".".repeat(PANEL_WIDTH - "open".length - "398".length - 2)} 398`);
  assert.equal(alignRow("a", "b").length, PANEL_WIDTH, "space-fill pads the full row out to PANEL_WIDTH");
  assert.ok(alignRow("a".repeat(50), "b").endsWith(" b"), "a label longer than the width still keeps at least one gap before the value");
  assert.equal(alignRow("label", "value", { width: 10, fill: "." }), "label . value", "a too-narrow width still keeps the minimum single fill character");

  // --- buildInstinctsBlock: three glyph states -------------------------
  const activeModel = buildInstinctsBlock({
    project: 10,
    inherited: 4,
    global: 2,
    observerEnabled: true,
    lastRun: new Date().toISOString(),
    nextRunEligibleAt: new Date(Date.now() + 3 * 60000).toISOString(),
    readyToShare: 0,
  });
  assert.equal(activeModel.glyph, "active", "observer enabled and run recently reads active");
  assert.equal(activeModel.headline, "16", "headline is project+inherited+global");
  assert.ok(activeModel.rows.some((row) => row.label === "ready to share globally" && row.value === "0"), "a zero (known) readyToShare still renders its own row");
  assert.ok(!activeModel.rows.some((row) => row.hint), "no hint row when readyToShare is 0");
  assert.ok(activeModel.rows.some((row) => row.label === "next learning run"), "next learning run shown when enabled and scheduled");

  const attentionModelDisabled = buildInstinctsBlock({ project: 1, inherited: 0, global: 0, observerEnabled: false, lastRun: new Date().toISOString() });
  assert.equal(attentionModelDisabled.glyph, "attention", "observer disabled reads attention even with a recent lastRun");

  const attentionModelStaleRun = buildInstinctsBlock({
    project: 1,
    inherited: 0,
    global: 0,
    observerEnabled: true,
    lastRun: new Date(Date.now() - 25 * 3600000).toISOString(),
  });
  assert.equal(attentionModelStaleRun.glyph, "attention", "a last run older than 24h reads attention");

  const staleModel = buildInstinctsBlock({ project: 1, inherited: 0, global: 0, observerEnabled: true, lastRun: null });
  assert.equal(staleModel.glyph, "stale", "never run yet reads stale (no data to judge freshness)");

  const unavailableInstincts = buildInstinctsBlock(null);
  assert.equal(unavailableInstincts.glyph, "stale");
  assert.equal(unavailableInstincts.headline, "none");
  assert.deepEqual(unavailableInstincts.rows, []);

  // --- hint rows: "ready to share globally" and "skill candidates" ----
  const withShareHint = buildInstinctsBlock({ project: 5, inherited: 0, global: 0, observerEnabled: true, lastRun: new Date().toISOString(), readyToShare: 4 });
  const shareRowIndex = withShareHint.rows.findIndex((row) => row.label === "ready to share globally");
  assert.equal(withShareHint.rows[shareRowIndex].value, "4");
  assert.equal(withShareHint.rows[shareRowIndex + 1]?.hint, "run /promote to share them", "the hint row immediately follows the row it annotates");

  const withCandidates = buildInstinctsBlock({
    project: 5,
    inherited: 0,
    global: 0,
    observerEnabled: true,
    lastRun: new Date().toISOString(),
    readyToShare: 0,
    skillCandidates: 2,
    candidatesPath: "/tmp/evolved",
  });
  const candidatesRowIndex = withCandidates.rows.findIndex((row) => row.label === "skill candidates");
  assert.equal(withCandidates.rows[candidatesRowIndex].value, "2");
  assert.equal(withCandidates.rows[candidatesRowIndex + 1]?.hint, "see /tmp/evolved");

  const withoutCandidates = buildInstinctsBlock({ project: 5, inherited: 0, global: 0, observerEnabled: true, lastRun: new Date().toISOString(), readyToShare: 0, skillCandidates: 0 });
  assert.ok(!withoutCandidates.rows.some((row) => row.label === "skill candidates"), "skillCandidates: 0 omits the row entirely");

  // --- activity rows omitted at zero, shown when positive --------------
  const noActivity = buildInstinctsBlock({ project: 1, inherited: 0, global: 0, observerEnabled: true, lastRun: new Date().toISOString(), appliedToday: 0, firedToday: 0 });
  assert.ok(!noActivity.rows.some((row) => row.label === "added to prompts today"));
  assert.ok(!noActivity.rows.some((row) => row.label === "used by the agent today"));
  const withActivity = buildInstinctsBlock({ project: 1, inherited: 0, global: 0, observerEnabled: true, lastRun: new Date().toISOString(), appliedToday: 5, firedToday: 2 });
  assert.ok(withActivity.rows.some((row) => row.label === "added to prompts today" && row.value === "5"));
  assert.ok(withActivity.rows.some((row) => row.label === "used by the agent today" && row.value === "2"));

  // --- "kept tidy" summary row: omitted when all-zero, joined otherwise
  const keptTidyEmpty = buildInstinctsBlock({ project: 1, inherited: 0, global: 0, observerEnabled: true, lastRun: new Date().toISOString(), maintenance: { counts7d: { promoted: 0, archived: 0, merged: 0, pruned: 0, candidates: 0, repaired: 0 } } });
  assert.ok(!keptTidyEmpty.rows.some((row) => row.label === "kept tidy"), "an all-zero week omits the 'kept tidy' row");
  const keptTidySome = buildInstinctsBlock({ project: 1, inherited: 0, global: 0, observerEnabled: true, lastRun: new Date().toISOString(), maintenance: { counts7d: { promoted: 1, archived: 2, merged: 0, pruned: 0, candidates: 0, repaired: 0 } } });
  const keptTidyRow = keptTidySome.rows.find((row) => row.label === "kept tidy");
  assert.equal(keptTidyRow.value, "promoted 1, archived 2", "zero items are omitted, nonzero ones joined in a fixed order");

  // --- buildObservationsBlock ------------------------------------------
  assert.deepEqual(buildObservationsBlock(null), { key: "observations", label: "Skill notes", available: false, glyph: "stale", headline: "none", rows: [] });
  const notesActive = buildObservationsBlock({ available: true, open: 42, added7d: 9, lastReview: new Date().toISOString(), warning: false });
  assert.equal(notesActive.glyph, "active");
  assert.equal(notesActive.headline, "42");
  assert.deepEqual(notesActive.rows.map((row) => row.label), ["open", "added this week", "last reviewed"]);
  const notesAttention = buildObservationsBlock({ available: true, open: 398, added7d: 158, lastReview: null, warning: true });
  assert.equal(notesAttention.glyph, "attention");
  assert.equal(notesAttention.rows.find((row) => row.label === "last reviewed").value, "never");

  // --- buildEvalsBlock ---------------------------------------------------
  const evalsNone = buildEvalsBlock(null);
  assert.equal(evalsNone.label, "Skill test", "no eval data at all reads as the bare label");
  assert.equal(evalsNone.glyph, "stale");
  assert.equal(evalsNone.headline, "none");

  const evalsNoSkillName = buildEvalsBlock({ available: true, skill: null, withSkill: 0.9, baseline: 0.1, timestamp: new Date().toISOString() });
  assert.equal(evalsNoSkillName.label, "Skill test", "available data with no skill name on record still reads as the bare label");
  assert.equal(evalsNoSkillName.glyph, "stale");

  const evalsFresh = buildEvalsBlock({ available: true, skill: "pr", withSkill: 0.92, baseline: 0.08, baselineKind: "without", timestamp: new Date(Date.now() - 2 * 86400000).toISOString() });
  assert.equal(evalsFresh.label, "Skill test (pr)");
  assert.equal(evalsFresh.glyph, "active", "a benchmark under 7 days old reads active");
  assert.deepEqual(evalsFresh.rows, [{ label: "with skill", value: "92%" }, { label: "without", value: "8%" }]);

  const evalsStale = buildEvalsBlock({ available: true, skill: "pr", withSkill: 0.92, baseline: 0.08, baselineKind: "without", timestamp: new Date(Date.now() - 9 * 86400000).toISOString() });
  assert.equal(evalsStale.glyph, "stale", "a benchmark over 7 days old reads stale");

  const evalsOldNaming = buildEvalsBlock({ available: true, skill: "pr", withSkill: 0.92, baseline: 0.08, baselineKind: "old", timestamp: new Date().toISOString() });
  assert.deepEqual(evalsOldNaming.rows, [{ label: "new", value: "92%" }, { label: "old", value: "8%" }], "the 'old_skill' naming reads 'new'/'old' instead of 'with skill'/'without'");

  // --- shared glyph/legend constants ------------------------------------
  assert.deepEqual(GLYPH_CHAR, { active: "\u25cf", attention: "\u25cf", stale: "\u25cb" });
  assert.deepEqual(LEGEND.map((entry) => entry.glyph), ["active", "attention", "stale"]);
}

// ---------------------------------------------------------------------------
// 9. lib/board-interaction.js: the sidebar panel's collapsible state is
//    pure (no solid-js/opentui), so its defaults and persisted-snapshot
//    merge can be asserted directly here even though sidebar.js itself
//    cannot be imported in this plain-node run (section 5 above).
// ---------------------------------------------------------------------------
{
  const { defaultInteractionState, mergeInteractionState, BOARD_BLOCK_KEYS, BOARD_STORAGE_KEY } = await import("./lib/board-interaction.js");

  assert.equal(BOARD_STORAGE_KEY, "mighty-instincts.board");
  assert.deepEqual(BOARD_BLOCK_KEYS, ["instincts", "observations", "evals"]);

  const expanded = defaultInteractionState({});
  assert.equal(expanded.panelOpen, true, "the panel header always starts open");
  assert.deepEqual(expanded.blocks, { instincts: true, observations: true, evals: true }, "board.compact defaults to false, so every block starts expanded");

  const compact = defaultInteractionState({ board: { compact: true } });
  assert.equal(compact.panelOpen, true, "board.compact never collapses the header, only blocks");
  assert.deepEqual(compact.blocks, { instincts: false, observations: false, evals: false }, "board.compact: true seeds every block collapsed");

  assert.deepEqual(mergeInteractionState(expanded, null), expanded, "no persisted snapshot keeps the defaults");
  assert.deepEqual(mergeInteractionState(expanded, "not json"), expanded, "unparseable persisted JSON keeps the defaults");
  assert.deepEqual(mergeInteractionState(expanded, 42), expanded, "a non-object, non-string persisted value keeps the defaults");

  const persistedString = JSON.stringify({ panelOpen: false, blocks: { instincts: false, observations: "nope", bogusKey: true } });
  const merged = mergeInteractionState(expanded, persistedString);
  assert.equal(merged.panelOpen, false, "a persisted panelOpen boolean overrides the default, even read back as a JSON string");
  assert.deepEqual(
    merged.blocks,
    { instincts: false, observations: true, evals: true },
    "a persisted boolean overrides one block; a non-boolean value and an unknown key are both ignored, leaving the rest at their defaults",
  );

  const mergedFromObject = mergeInteractionState(compact, { blocks: { evals: true } });
  assert.equal(mergedFromObject.panelOpen, true, "mergeInteractionState also accepts an already-parsed object, not just a JSON string");
  assert.deepEqual(mergedFromObject.blocks, { instincts: false, observations: false, evals: true }, "merging over a compact-seeded default only changes the one block the snapshot named");
}

// ---------------------------------------------------------------------------
// 10. lib/activity.js: recordObserved always flushes on its first call for
//     a project, then throttles to at most once per 10s; recordApplied's
//     and recordFired's writes are never throttled and never clobber
//     lastObservedAt or each other; readActivitySnapshot always reads
//     straight from disk and is date-scoped (a stale appliedDate/firedDate
//     reads as 0 "today").
// ---------------------------------------------------------------------------
{
  const { recordObserved, recordApplied, recordFired, readActivitySnapshot } = await import("./lib/activity.js");

  const { projectDir } = makeProjectAndData("activity");
  await fs.mkdir(projectDir, { recursive: true });

  const before = await readActivitySnapshot(projectDir);
  assert.equal(before.lastObservedAt, null, "no .activity.json yet: lastObservedAt starts null");
  assert.equal(before.appliedToday, 0, "no .activity.json yet: appliedToday starts 0");
  assert.equal(before.firedToday, 0, "no .activity.json yet: firedToday starts 0");

  await recordObserved(projectDir);
  const firstWrite = JSON.parse(await fs.readFile(path.join(projectDir, ".activity.json"), "utf8"));
  assert.ok(typeof firstWrite.lastObservedAt === "string" && !Number.isNaN(Date.parse(firstWrite.lastObservedAt)), "the first recordObserved call always flushes to disk");

  await recordObserved(projectDir); // immediate second call, still inside the 10s throttle window
  const secondWrite = JSON.parse(await fs.readFile(path.join(projectDir, ".activity.json"), "utf8"));
  assert.equal(secondWrite.lastObservedAt, firstWrite.lastObservedAt, "a second call inside the 10s throttle window does not flush again");

  await recordApplied(projectDir, 2);
  await recordApplied(projectDir, 3);
  await recordFired(projectDir);
  await recordFired(projectDir, 2);
  const afterApplied = await readActivitySnapshot(projectDir);
  assert.equal(afterApplied.appliedToday, 5, "recordApplied accumulates within the same day");
  assert.equal(afterApplied.firedToday, 3, "recordFired accumulates within the same day, independently of appliedToday");
  assert.ok(
    typeof afterApplied.lastObservedAt === "string" && !Number.isNaN(Date.parse(afterApplied.lastObservedAt)),
    "recordApplied/recordFired's writes never clobber lastObservedAt with null/undefined",
  );
  assert.ok(Date.parse(afterApplied.lastObservedAt) >= Date.parse(firstWrite.lastObservedAt), "lastObservedAt never moves backwards");

  // A stale appliedDate/firedDate (e.g. from before midnight UTC) must
  // read as 0 for "today" rather than passed through as-is.
  const activityPath = path.join(projectDir, ".activity.json");
  const stale = JSON.parse(await fs.readFile(activityPath, "utf8"));
  stale.appliedDate = "2000-01-01";
  stale.appliedToday = 99;
  stale.firedDate = "2000-01-01";
  stale.firedToday = 99;
  await fs.writeFile(activityPath, JSON.stringify(stale), "utf8");
  const afterStaleDate = await readActivitySnapshot(projectDir);
  assert.equal(afterStaleDate.appliedToday, 0, "appliedToday from a different (stale) date reads as 0 for today");
  assert.equal(afterStaleDate.firedToday, 0, "firedToday from a different (stale) date reads as 0 for today");
}

// ---------------------------------------------------------------------------
// 11. lib/inject.js pure functions: candidate selection (confidence
//     filter, inject.exclude, malformed-trigger skip, sort, max cap), the
//     1200-char injected-block budget (dropping the lowest-confidence
//     entry first), and the word-overlap helpers lib/maintain.js's steps
//     and the fired-count bump are keyed on.
// ---------------------------------------------------------------------------
{
  const { selectForInjection, formatInjectionBlock, significantWords, sharedSignificantWordCount, significantWordOverlapRatio, DEFAULT_INJECT_OPTIONS } = await import(
    "./lib/inject.js"
  );

  assert.deepEqual(DEFAULT_INJECT_OPTIONS, { enabled: true, max: 5, minConfidence: 0.8, exclude: [] });

  const pool = [
    { id: "a", trigger: "alpha trigger", confidence: 0.95 },
    { id: "b", trigger: "beta trigger", confidence: 0.9 },
    { id: "c", trigger: "gamma trigger", confidence: 0.85 },
    { id: "d", trigger: "delta trigger", confidence: 0.81 },
    { id: "e", trigger: "epsilon trigger", confidence: 0.8 },
    { id: "f", trigger: "zeta trigger", confidence: 0.79 }, // below minConfidence
  ];

  const selected = selectForInjection(pool, { max: 5, minConfidence: 0.8 });
  assert.deepEqual(selected.map((inst) => inst.id), ["a", "b", "c", "d", "e"], "qualifying instincts, sorted by confidence desc, capped at max");

  const capped = selectForInjection(pool, { max: 2, minConfidence: 0.8 });
  assert.deepEqual(capped.map((inst) => inst.id), ["a", "b"], "max caps the selection even when more instincts qualify");

  const excluded = selectForInjection(pool, { max: 5, minConfidence: 0.8, exclude: ["b", "d"] });
  assert.deepEqual(excluded.map((inst) => inst.id), ["a", "c", "e"], "inject.exclude removes ids before sorting/capping");

  assert.deepEqual(selectForInjection([], {}), [], "an empty pool selects nothing");

  let malformedCalls = 0;
  const poolWithMalformed = [
    ...pool,
    { id: "bad-conf", trigger: "do this when confidence: 0.9 shows up", confidence: 0.99 },
    { id: "bad-domain", trigger: "note the domain: tooling marker", confidence: 0.98 },
  ];
  const withMalformed = selectForInjection(poolWithMalformed, { max: 10, minConfidence: 0.8 }, { onMalformed: () => { malformedCalls += 1; } });
  assert.ok(
    !withMalformed.some((inst) => inst.id === "bad-conf" || inst.id === "bad-domain"),
    "a trigger containing a 'confidence:'/'domain:' pair is treated as malformed and skipped",
  );
  assert.equal(malformedCalls, 2, "onMalformed is called once per skipped malformed candidate");

  const smallEntries = [
    { id: "a", trigger: "alpha trigger", summary: "do the alpha thing" },
    { id: "b", trigger: "beta trigger", summary: "do the beta thing" },
  ];
  const smallBlock = formatInjectionBlock(smallEntries);
  assert.ok(smallBlock.text.startsWith("<instincts> learned habits for this project\n"), "block opens with the plain-language description line");
  assert.ok(smallBlock.text.endsWith("\n</instincts>"), "block still closes with </instincts>");
  assert.ok(smallBlock.text.includes("- do the alpha thing"), "each line is '- <summary>' only (no trigger prefix)");
  assert.deepEqual(smallBlock.ids, ["a", "b"]);
  assert.ok(smallBlock.text.length <= 1200);

  const longSummary = "x".repeat(500);
  const oversizedEntries = [
    { id: "big1", trigger: "t1", summary: longSummary },
    { id: "big2", trigger: "t2", summary: longSummary },
    { id: "big3", trigger: "t3", summary: longSummary },
  ];
  const trimmedBlock = formatInjectionBlock(oversizedEntries);
  assert.ok(trimmedBlock.text.length <= 1200, "the block is trimmed to stay under the 1200-char budget");
  assert.ok(!trimmedBlock.ids.includes("big3"), "the lowest-confidence (last, assuming callers pass entries sorted desc) entry is dropped first");

  const singleOversized = formatInjectionBlock([{ id: "huge", trigger: "t", summary: "y".repeat(2000) }]);
  assert.equal(singleOversized, null, "formatInjectionBlock returns null when even a single entry cannot fit the budget");

  assert.deepEqual(
    [...significantWords("Grep before editing unfamiliar files")].sort(),
    ["editing", "files", "unfamiliar"].sort(),
    "words under 5 letters ('grep') and stopwords ('before') are excluded",
  );
  assert.equal(
    sharedSignificantWordCount("grep unfamiliar repository before editing", "please grep this unfamiliar repository before editing anything"),
    3,
    "shared significant words: unfamiliar, repository, editing",
  );
  assert.equal(
    sharedSignificantWordCount("totally unrelated trigger text", "please grep this unfamiliar repository before editing anything"),
    0,
    "no shared significant words",
  );

  assert.equal(
    significantWordOverlapRatio("grep before editing unfamiliar repository files", "grep before editing unfamiliar repository code"),
    1,
    "every significant word of the shorter side (3) is present in the longer side",
  );
  assert.equal(significantWordOverlapRatio("totally unrelated text", "please grep this unfamiliar repository"), 0, "no overlap at all");
  assert.equal(significantWordOverlapRatio("", "anything"), 0, "an empty side has no significant words to overlap on");
}

// ---------------------------------------------------------------------------
// 11b. lib/store.js's summary helpers (the "summary fallback" lib/inject.js
//      uses for an instinct written before 0.7.0, with no `summary:` field
//      of its own): the first sentence of its `## Action` section, clipped
//      to 120 chars, falling back further to the old title/first-line
//      behaviour when there is no Action section at all.
// ---------------------------------------------------------------------------
{
  const { clipSummary, firstActionSentence, readInstinctSummaryLine } = await import("./lib/store.js");

  assert.equal(clipSummary("short"), "short");
  assert.equal(clipSummary("x".repeat(130)), "x".repeat(120), "clipSummary trims to 120 chars by default");

  const withAction = "# Title\n\n## Action\nSearch the repository with grep before editing unfamiliar files. Then proceed.\n";
  assert.equal(
    firstActionSentence(withAction),
    "Search the repository with grep before editing unfamiliar files.",
    "only the first sentence of the Action section is kept",
  );

  const longAction = `# Title\n\n## Action\n${"x".repeat(200)} is one very long sentence without punctuation\n`;
  assert.equal(firstActionSentence(longAction).length, 120, "a sentence with no terminator is clipped to 120 chars");

  const noAction = "# Just A Title\n\nNo Action section here.\n";
  assert.equal(firstActionSentence(noAction), "Just A Title", "falls back to the title when there is no Action section");

  const { projectDir } = makeProjectAndData("summary-fallback");
  const dir = path.join(projectDir, "instincts", "personal");
  await writeInstinct(dir, { id: "no-summary-habit", trigger: "t", confidence: 0.8, domain: "misc" }, withAction);
  const fallbackLine = await readInstinctSummaryLine(dir, "no-summary-habit", undefined);
  assert.equal(fallbackLine, "Search the repository with grep before editing unfamiliar files.", "readInstinctSummaryLine falls back to firstActionSentence when no summary: field is given");

  const withSummaryField = await readInstinctSummaryLine(dir, "no-summary-habit", "Already have a summary.");
  assert.equal(withSummaryField, "Already have a summary.", "an explicit summary (e.g. the frontmatter field) short-circuits the fallback entirely");
}

// ---------------------------------------------------------------------------
// 12. lib/observe.js's stripInjectedBlock: removes an injected
//     `<instincts>...</instincts>` block (and the blank line(s) before
//     it), so a residual block from before 0.7.0 (when injection still
//     edited prompt text) is still stripped the same way. 0.7.0 itself
//     never writes into prompt text at all (lib/inject.js now uses the
//     "context" hook's `system` array), which is why this is "harmless"
//     now rather than load-bearing: kept for defence, exercised directly
//     since nothing in the live pipeline still produces this shape.
// ---------------------------------------------------------------------------
{
  const { stripInjectedBlock } = await import("./lib/observe.js");

  const injected = "fix the flaky test\n\n<instincts>\n- grep before edit: search first\n- another one: do the thing\n</instincts>";
  assert.equal(stripInjectedBlock(injected), "fix the flaky test", "the injected block and the blank line before it are removed");

  const noBlock = "just a normal prompt with no injection";
  assert.equal(stripInjectedBlock(noBlock), noBlock, "a prompt with no injected block is returned unchanged");

  const multiline = "first line\nsecond line\n\n<instincts>\n- a: b\n</instincts>\n";
  assert.equal(stripInjectedBlock(multiline), "first line\nsecond line", "trailing newlines after the block are also removed");
}

// ---------------------------------------------------------------------------
// 13. lib/inject.js live wiring via the "context" hook: registerInject's
//     session.hook("context", ...) pushes exactly one SystemPart onto
//     `event.system` for qualifying instincts (never editing `messages`),
//     counts the injection in .activity.json, bumps `fired` on the
//     matching instinct's own frontmatter (and records it in
//     .activity.json's firedToday), considers a pending instinct for
//     firing without ever injecting it, and skips entirely when the
//     latest user Message carries loop/ulw metadata.
// ---------------------------------------------------------------------------
{
  const { registerInject } = await import("./lib/inject.js");

  const { projectDir, dataDir } = makeProjectAndData("inject-live");
  const options = { python: "python3", dataDir, inject: { enabled: true, max: 5, minConfidence: 0.8 } };
  const hooks = {};
  const ctx = {
    location: { directory: projectDir },
    session: {
      hook: async (name, cb) => {
        hooks[name] = cb;
        return { dispose: async () => {} };
      },
    },
  };

  const project = await resolveProject(ctx, options);
  await writeInstinct(
    project.instincts_personal,
    { id: "grep-before-edit", trigger: "grep unfamiliar repository before editing", confidence: 0.9, domain: "workflow" },
    "# Grep Before Edit\n\n## Action\nSearch the repository with grep before editing unfamiliar files.\n",
  );
  await writeInstinct(
    project.instincts_personal,
    { id: "low-confidence", trigger: "something else entirely", confidence: 0.4, domain: "misc" },
    "# Low Confidence\n\n## Action\nShould never be injected.\n",
  );
  const pendingDir = siblingInstinctsDir(project, "pending");
  await writeInstinct(
    pendingDir,
    { id: "pending-habit", trigger: "grep unfamiliar repository before editing pending", confidence: 0.5, domain: "workflow" },
    "# Pending\n\n## Action\nNot yet proven.\n",
  );

  await registerInject(ctx, options);
  assert.equal(typeof hooks.context, "function", "registerInject registered a session.hook('context') callback");

  const event = contextEvent({ sessionID: "inject-s1", userText: "please grep this unfamiliar repository before editing anything" });
  const originalMessages = event.messages;
  await hooks.context(event);

  assert.equal(event.system.length, 1, "exactly one SystemPart was pushed");
  assert.equal(event.system[0].type, "text");
  assert.ok(event.system[0].text.startsWith("<instincts> learned habits for this project"), "the injected block opens with the plain-language description line");
  assert.ok(
    event.system[0].text.includes("Search the repository with grep before editing unfamiliar files."),
    "injected block carries the qualifying instinct's summary (fallback: first Action sentence)",
  );
  assert.ok(!event.system[0].text.includes("Should never be injected"), "the below-threshold instinct was never selected for injection");
  assert.strictEqual(event.messages, originalMessages, "the messages array itself is never mutated");

  const activity = JSON.parse(await fs.readFile(path.join(project.project_dir, ".activity.json"), "utf8"));
  assert.equal(activity.appliedToday, 1, "one injection counted for today in .activity.json");
  assert.equal(activity.firedToday, 2, "two fired-count bumps counted for today: the injected instinct and the pending one both matched this message");

  const writtenContent = await fs.readFile(path.join(project.instincts_personal, "grep-before-edit.md"), "utf8");
  assert.ok(/fired:\s*1/.test(writtenContent), "fired bumped to 1: the latest user message shares 3+ significant words with the trigger");

  const pendingContent = await fs.readFile(path.join(pendingDir, "pending-habit.md"), "utf8");
  assert.ok(/fired:\s*1/.test(pendingContent), "the pending instinct's fired count is bumped too, even though it was never injected");

  const loopEvent = contextEvent({ sessionID: "inject-s1", userText: "grep the repository before editing" });
  loopEvent.messages[loopEvent.messages.length - 1].metadata = { opencode_loop_v2: true };
  await hooks.context(loopEvent);
  assert.deepEqual(loopEvent.system, [], "a loop re-prompt (opencode_loop_v2 metadata on the latest user message) is never injected into");

  const ulwEvent = contextEvent({ sessionID: "inject-s1", userText: "grep the repository before editing" });
  ulwEvent.messages[ulwEvent.messages.length - 1].metadata = { ulw: "active" };
  await hooks.context(ulwEvent);
  assert.deepEqual(ulwEvent.system, [], "a ulw re-prompt (ulw metadata on the latest user message) is never injected into");

  // fired must not bump again on a message that shares no significant
  // words with the trigger, even though the instinct still qualifies and
  // gets injected.
  const unrelatedEvent = contextEvent({ sessionID: "inject-s1", userText: "please summarise the quarterly numbers" });
  await hooks.context(unrelatedEvent);
  assert.equal(unrelatedEvent.system.length, 1, "the instinct is still injected even when unrelated to the prompt");
  const contentAfterUnrelated = await fs.readFile(path.join(project.instincts_personal, "grep-before-edit.md"), "utf8");
  assert.ok(/fired:\s*1/.test(contentAfterUnrelated), "fired stays at 1: an unrelated message never bumps it");
}

// ---------------------------------------------------------------------------
// 14. lib/maintain.js: every maintenance step against a temp data dir.
//     promote across two fake projects (exact-id match), prune an old
//     pending file (plus a soon-to-expire warning and an unaffected
//     fresh one), decay to archive (and a lighter decay that only lowers
//     confidence), dedupe merging a near-duplicate, evolve clustering
//     three related instincts into one candidate file, classifyNewInstinct's
//     "50% rule", graduatePendingStep promoting a fired pending instinct,
//     and repairStep cleaning a leaked trigger (idempotently).
// ---------------------------------------------------------------------------
{
  const maintRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "maintenance-"));

  // --- promote: two fake project stores, same id, both confident -------
  const homunculus = path.join(maintRoot, "homunculus");
  const projectsRoot = path.join(homunculus, "projects");
  const personalA = path.join(projectsRoot, "proj-a", "instincts", "personal");
  const personalB = path.join(projectsRoot, "proj-b", "instincts", "personal");
  await fs.mkdir(personalA, { recursive: true });
  await fs.mkdir(personalB, { recursive: true });
  const sharedFields = { id: "shared-pattern", trigger: "always run the full test suite before pushing commits", domain: "workflow", summary: "Run the test suite before pushing.", created: new Date().toISOString() };
  await writeInstinct(personalA, { ...sharedFields, confidence: 0.9 }, "# Shared\n\n## Action\nRun tests before every push.\n");
  await writeInstinct(personalB, { ...sharedFields, confidence: 0.85 }, "# Shared\n\n## Action\nRun tests before every push.\n");

  const promoteOptions = { dataDir: homunculus };
  const promoteLog = [];
  const promoted = await promoteStep(promoteOptions, { log: (line) => promoteLog.push(line) });
  assert.equal(promoted, 1, "one instinct promoted: same id, confidence >= 0.8, found in 2 distinct project stores");
  const globalPersonalDir = path.join(homunculus, "instincts", "personal");
  assert.deepEqual(await fs.readdir(globalPersonalDir), ["shared-pattern.md"]);
  const globalContent = await fs.readFile(path.join(globalPersonalDir, "shared-pattern.md"), "utf8");
  assert.ok(globalContent.includes("scope: global"), "the promoted copy carries scope: global");
  assert.ok(!globalContent.includes("project_id"), "project-specific fields are dropped from the promoted copy");
  assert.ok(promoteLog.some((line) => line.includes("promote: copied shared-pattern to global store (found in 2 projects)")));

  const secondPromote = await promoteStep(promoteOptions, { log: () => {} });
  assert.equal(secondPromote, 0, "an instinct already in the global store is never promoted twice");

  // --- prune: an old pending file, one within the warning window, one fresh
  const pruneProject = {
    project_dir: path.join(maintRoot, "proj-prune"),
    instincts_personal: path.join(maintRoot, "proj-prune", "instincts", "personal"),
    evolved_dir: path.join(maintRoot, "proj-prune", "evolved"),
  };
  const prunePendingDir = siblingInstinctsDir(pruneProject, "pending");
  await fs.mkdir(prunePendingDir, { recursive: true });
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  await writeInstinct(prunePendingDir, { id: "old-pending", trigger: "t1", confidence: 0.5, domain: "misc", summary: "s1", created: daysAgo(40) }, "# Old\n");
  await writeInstinct(prunePendingDir, { id: "warn-pending", trigger: "t2", confidence: 0.5, domain: "misc", summary: "s2", created: daysAgo(25) }, "# Warn\n");
  await writeInstinct(prunePendingDir, { id: "fresh-pending", trigger: "t3", confidence: 0.5, domain: "misc", summary: "s3", created: daysAgo(2) }, "# Fresh\n");

  const pruneLog = [];
  const pruned = await pruneStep(pruneProject, { log: (line) => pruneLog.push(line) });
  assert.equal(pruned, 1, "only the 40-day-old pending file (TTL 30 days) is pruned");
  assert.deepEqual((await fs.readdir(prunePendingDir)).sort(), ["fresh-pending.md", "warn-pending.md"]);
  assert.ok(pruneLog.some((line) => line.includes("prune: deleted old-pending")));
  assert.ok(pruneLog.some((line) => line.includes("prune: warning warn-pending expires in")), "a file within 7 days of expiry logs a warning instead of deleting");

  // --- decay: one drops below 0.4 (archived), one stays above (lowered),
  //     one never fired=0 but already has fired>0 (left untouched)
  const decayProject = {
    project_dir: path.join(maintRoot, "proj-decay"),
    instincts_personal: path.join(maintRoot, "proj-decay", "instincts", "personal"),
    evolved_dir: path.join(maintRoot, "proj-decay", "evolved"),
  };
  await fs.mkdir(decayProject.instincts_personal, { recursive: true });
  const archiveWorthy = daysAgo(30 + 3 * 7); // 3 full weeks past the 30-day grace period
  const lightlyOld = daysAgo(30 + 1 * 7);
  await writeInstinct(decayProject.instincts_personal, { id: "stale-habit", trigger: "t", confidence: 0.5, domain: "misc", summary: "s", created: archiveWorthy }, "# Stale\n");
  await writeInstinct(decayProject.instincts_personal, { id: "lightly-old", trigger: "t", confidence: 0.6, domain: "misc", summary: "s", created: lightlyOld }, "# Lightly\n");
  await writeInstinct(decayProject.instincts_personal, { id: "proven-habit", trigger: "t", confidence: 0.5, domain: "misc", summary: "s", created: archiveWorthy, fired: 3 }, "# Proven\n");

  const decayLog = [];
  const { archived, decayed } = await decayStep(decayProject, { log: (line) => decayLog.push(line) });
  assert.equal(archived, 1, "stale-habit drops from 0.5 to 0.35 (3 weeks * 0.05) and crosses the 0.4 archive threshold");
  assert.equal(decayed, 1, "lightly-old drops from 0.6 to 0.55 and stays in personal");
  const decayArchiveDir = siblingInstinctsDir(decayProject, "archive");
  assert.deepEqual(await fs.readdir(decayArchiveDir), ["stale-habit.md"]);
  assert.ok(!(await fs.readdir(decayProject.instincts_personal)).includes("stale-habit.md"), "archived, never deleted outright: moved out of personal");
  const lightlyOldContent = await fs.readFile(path.join(decayProject.instincts_personal, "lightly-old.md"), "utf8");
  assert.ok(/confidence:\s*0\.55/.test(lightlyOldContent));
  const provenContent = await fs.readFile(path.join(decayProject.instincts_personal, "proven-habit.md"), "utf8");
  assert.ok(/confidence:\s*0\.5(\s|$)/.test(provenContent), "a fired instinct is never decayed, regardless of age");
  assert.ok(decayLog.some((line) => line.includes("decay: archived stale-habit")));
  assert.ok(decayLog.some((line) => line.includes("decay: lowered lightly-old confidence to 0.55")));

  // --- dedupe: a near-duplicate merges into the existing file -----------
  const dedupeProject = path.join(maintRoot, "proj-dedupe", "instincts", "personal");
  await fs.mkdir(dedupeProject, { recursive: true });
  await writeInstinct(
    dedupeProject,
    { id: "existing-habit", trigger: "grep before editing unfamiliar repository files", confidence: 0.6, domain: "workflow", summary: "Grep before editing unfamiliar files.", created: new Date().toISOString() },
    "# Existing\n\n## Action\nGrep first.\n\n## Evidence\n- Observed 3 times\n",
  );
  const dedupeLog = [];
  const merged = await dedupeOrMerge(
    dedupeProject,
    { id: "new-habit", trigger: "grep before editing unfamiliar repository code", confidence: 0.7, summary: "Grep." },
    "# New\n\n## Action\nGrep.\n\n## Evidence\n- Observed 2 more times\n",
    { log: (line) => dedupeLog.push(line) },
  );
  assert.equal(merged, true, "overlapping trigger+summary merges into the existing instinct instead of writing a new file");
  assert.deepEqual(await fs.readdir(dedupeProject), ["existing-habit.md"], "no new-habit.md was ever written");
  const mergedContent = await fs.readFile(path.join(dedupeProject, "existing-habit.md"), "utf8");
  assert.ok(/confidence:\s*0\.65/.test(mergedContent), "confidence raised by 0.05");
  assert.ok(mergedContent.includes('summary: "Grep."'), "a shorter new summary replaces the existing (longer) one");
  assert.ok(mergedContent.includes("Observed 3 times") && mergedContent.includes("Observed 2 more times"), "the new evidence paragraph is appended to the existing ## Evidence section");
  assert.ok(dedupeLog.some((line) => line.includes("dedupe: merged new-habit into existing-habit")));

  // --- evolve: three overlapping testing-domain instincts cluster -------
  const evolveProject = {
    project_dir: path.join(maintRoot, "proj-evolve"),
    instincts_personal: path.join(maintRoot, "proj-evolve", "instincts", "personal"),
    evolved_dir: path.join(maintRoot, "proj-evolve", "evolved"),
  };
  await fs.mkdir(evolveProject.instincts_personal, { recursive: true });
  for (let i = 0; i < 3; i++) {
    await writeInstinct(
      evolveProject.instincts_personal,
      {
        id: `testing-habit-${i}`,
        trigger: `always run the full test suite before merging pull request number ${i}`,
        confidence: 0.6,
        domain: "testing",
        summary: `Run the full test suite before merging pull request ${i}.`,
        created: new Date().toISOString(),
      },
      `# Testing ${i}\n\n## Action\nRun tests.\n`,
    );
  }
  const evolveLog = [];
  const { candidates } = await evolveStep(evolveProject, { log: (line) => evolveLog.push(line) });
  assert.equal(candidates, 1, "three overlapping testing-domain instincts cluster into exactly one candidate file");
  const evolvedFiles = await fs.readdir(evolveProject.evolved_dir);
  assert.equal(evolvedFiles.length, 1);
  const evolvedContent = await fs.readFile(path.join(evolveProject.evolved_dir, evolvedFiles[0]), "utf8");
  assert.ok(evolvedContent.includes("testing-habit-0") && evolvedContent.includes("testing-habit-1") && evolvedContent.includes("testing-habit-2"));
  assert.ok(evolvedContent.includes("Suggested SKILL.md description"));
  assert.ok(evolveLog.some((line) => line.includes("evolve: wrote cluster")));

  // --- classifyNewInstinct: the "50% rule" ------------------------------
  assert.equal(classifyNewInstinct({ confidence: 0.5 }, "# Body\n\n## Action\nDo it.\n"), "pending", "exactly 0.5 confidence with no Evidence section goes to pending");
  assert.equal(classifyNewInstinct({ confidence: 0.5 }, "# Body\n\n## Action\nDo it.\n\n## Evidence\n- seen\n"), "personal", "an Evidence section exempts it from the pending rule even at 0.5");
  assert.equal(classifyNewInstinct({ confidence: 0.51 }, "# Body\n"), "personal", "anything other than exactly 0.5 confidence is never routed to pending");

  // --- graduatePendingStep: fired promotes a pending instinct to personal
  const graduateProject = {
    project_dir: path.join(maintRoot, "proj-graduate"),
    instincts_personal: path.join(maintRoot, "proj-graduate", "instincts", "personal"),
    evolved_dir: path.join(maintRoot, "proj-graduate", "evolved"),
  };
  await fs.mkdir(graduateProject.instincts_personal, { recursive: true });
  const graduatePendingDir = siblingInstinctsDir(graduateProject, "pending");
  await writeInstinct(graduatePendingDir, { id: "unused-pending", trigger: "t", confidence: 0.5, domain: "misc", summary: "s", created: new Date().toISOString() }, "# Unused\n");
  await writeInstinct(graduatePendingDir, { id: "used-pending", trigger: "t", confidence: 0.5, domain: "misc", summary: "s", created: new Date().toISOString(), fired: 2 }, "# Used\n");
  const graduateLog = [];
  const graduated = await graduatePendingStep(graduateProject, { log: (line) => graduateLog.push(line) });
  assert.equal(graduated, 1, "only the pending instinct that has fired at least once graduates");
  assert.deepEqual((await fs.readdir(graduatePendingDir)).sort(), ["unused-pending.md"]);
  assert.deepEqual(await fs.readdir(graduateProject.instincts_personal), ["used-pending.md"]);
  assert.ok(graduateLog.some((line) => line.includes("pending: promoted used-pending to personal (fired 2)")));

  // --- repairStep: a leaked trailing frontmatter fragment in the trigger
  const repairProject = {
    project_dir: path.join(maintRoot, "proj-repair"),
    instincts_personal: path.join(maintRoot, "proj-repair", "instincts", "personal"),
    evolved_dir: path.join(maintRoot, "proj-repair", "evolved"),
  };
  await fs.mkdir(repairProject.instincts_personal, { recursive: true });
  await writeInstinct(
    repairProject.instincts_personal,
    { id: "leaky-trigger", trigger: "grep before editing unfamiliar files, confidence: 0.8", confidence: 0.8, domain: "workflow", summary: "Grep first.", created: new Date().toISOString() },
    "# Leaky\n",
  );
  const repairLog = [];
  const repaired = await repairStep(repairProject, { log: (line) => repairLog.push(line) });
  assert.equal(repaired, 1);
  const repairedContent = await fs.readFile(path.join(repairProject.instincts_personal, "leaky-trigger.md"), "utf8");
  assert.ok(repairedContent.includes('trigger: "grep before editing unfamiliar files"'), "the trigger is cleaned back to just the real trigger text");
  assert.ok(!repairedContent.includes("files, confidence"), "the leaked trailing fragment is gone");
  assert.ok(repairLog.some((line) => line.includes("repair: cleaned trigger of leaky-trigger")));

  const secondRepair = await repairStep(repairProject, { log: () => {} });
  assert.equal(secondRepair, 0, "repairStep is idempotent: a clean trigger never matches the leaked-suffix pattern again");
}

function buildFakeObserverOutput() {
  const valid = `---
id: prefer-functional-components
trigger: "when creating react components"
confidence: 0.7
domain: code-style
summary: "Use functional components with hooks."
---
# Prefer Functional Components

## Action
Use functional components with hooks instead of classes.

## Evidence
- Observed 5 times across this session`;

  // Shares an id with the inherited instinct seeded above, so it must be
  // rejected as a duplicate rather than written. Needs a valid summary of
  // its own so it reaches that check instead of failing parsing first.
  const duplicateOfInherited = `---
id: grep-before-edit
trigger: "when editing unfamiliar files"
confidence: 0.6
domain: workflow
summary: "Search before editing unfamiliar files."
---
# Grep Before Edit

## Action
Search with Grep before editing.

## Evidence
- Observed 4 times`;

  const badBody = `---
id: bad-body-instinct
trigger: "when doing something"
confidence: 0.5
domain: general
---
# Bad Body

## Action
---
This body illegally contains a frontmatter delimiter.`;

  const badId = `---
id: Not_A_Valid_ID!
trigger: "when doing something else"
confidence: 0.5
domain: general
---
# Bad Id

## Action
This id fails the ^[a-z0-9][a-z0-9-]{1,63}$ pattern.`;

  return [valid, duplicateOfInherited, badBody, badId].map((block) => `<instinct>\n${block}\n</instinct>`).join("\n\n");
}
