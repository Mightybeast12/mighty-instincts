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
  cleanupProjectsStep,
  decayStep,
  dedupeOrMerge,
  evolveStep,
  graduatePendingStep,
  promoteStep,
  pruneCandidatesStep,
  pruneStep,
  repairStep,
  runMaintenance,
} from "./lib/maintain.js";
import {
  findCandidateById,
  hashContent,
  loadCandidates,
  renderCandidateBody,
  resolveEvolveTargets,
  selectCandidateKind,
  writeCandidate,
} from "./lib/candidates.js";
import { bumpUsage, commandNameFromPromptText, readUsage } from "./lib/usage.js";
import { registerCommands } from "./lib/commands.js";
import {
  REVIEW_DEFAULTS,
  buildReviewPermissions,
  buildReviewPrompt,
  createReviewController,
  readReviewGate,
} from "./lib/review.js";

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
  const createCalls = [];

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
      // lib/review.js's controller only ever reaches these once a review
      // is actually due; every full-plugin test below keeps review either
      // disabled or pointed at an empty observationsRoot, so these exist
      // only so a real host-shaped ctx.session is here if that ever did
      // fire, rather than throwing "create is not a function".
      create: async (input) => {
        createCalls.push(input);
        return { id: "ses_fake-review" };
      },
      get: async () => null,
      interrupt: async () => ({ interrupted: true }),
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
    // No event bridge in this harness: lib/review.js's controller falls
    // back to polling ctx.session.get, which is harmless here since the
    // same fixtures below never let a review actually spawn.
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

  return { ctx, registrations, toolHooks, sessionHooks, sessionHookLists, commandDefs, toolDefs, syntheticCalls, promptCalls, createCalls };
}

// Minimal pushable async event bus for lib/review.js's controller tests:
// stands in for a real host's ctx.event.subscribe({signal}) async
// iterable. push() feeds one event to whichever `next()` call is
// currently pending (or queues it if none is), mirroring how a real
// event stream delivers events whenever they occur, not on a fixed
// schedule.
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

// Polls `predicate` until it is true or `timeoutMs` elapses: the
// controller's own completion handling runs through a background
// ctx.event.subscribe consumer loop plus several real fs.promises calls,
// so a fixed-length sleep would either be flaky (too short) or slow the
// suite down for no reason (padded long); polling a concrete condition
// is both faster and deterministic.
async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
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
    [
      "board",
      "evolve",
      "evolve-archive",
      "evolve-install",
      "evolve-list",
      "evolve-reject",
      "evolve-show",
      "instinct-export",
      "instinct-import",
      "instinct-observe",
      "instinct-projects",
      "instinct-prune",
      "instinct-status",
      "promote",
      "skill-review",
    ].sort(),
    "all fifteen slash commands registered",
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
  assert.equal(statusReply.resume, true, "a typed command's reply resumes immediately instead of waiting for the next turn");
  assert.equal(statusReply.delivery, "queue");
  assert.equal(statusReply.description, PKG_NAME);
  assert.ok(statusReply.text.includes("No instincts found"), "status reflects the empty instinct store");
  assert.equal(harness.promptCalls.length, 0, "ctx.session.prompt is never called");

  // /evolve without --generate previews lib/evolve-preview.js's own
  // deterministic clusters and never shells out to instinct-cli.py at
  // all (an empty project has nothing to cluster, so it reads as "no
  // clusters yet"); only --generate still delegates to the real CLI.
  const evolveCommand = harness.commandDefs.find((def) => def.name === "evolve");
  await evolveCommand.execute({ sessionID: "cmd-session", prompt: { text: "" } });
  const evolvePreviewReply = harness.syntheticCalls.filter((call) => call.sessionID === "cmd-session").pop();
  assert.ok(evolvePreviewReply.text.includes("No instinct clusters found yet"), "the no-flag preview path runs lib/evolve-preview.js, not instinct-cli.py");
  assert.equal(evolvePreviewReply.resume, true, "the evolve preview still posts as a resumed, direct reply, same as every other command");

  await evolveCommand.execute({ sessionID: "cmd-session", prompt: { text: "--generate" } });
  const evolveGenerateReply = harness.syntheticCalls.filter((call) => call.sessionID === "cmd-session").pop();
  assert.ok(
    !evolveGenerateReply.text.includes("No instinct clusters found yet"),
    "--generate still delegates to instinct-cli.py's own evolve output, not lib/evolve-preview.js's sentinel text",
  );

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
// 1a. lib/commands.js's postResult: long output (most commonly
//     /instinct-status against a project with many instincts) used to be
//     posted as one oversized synthetic message that the host silently
//     cuts off mid-entry. Over SYNTHETIC_MESSAGE_CAP, it is now split at
//     instinct-cli.py's own entry boundaries (a blank line right before a
//     confidence-bar line, e.g. "████████░░") into several consecutive
//     messages, each prefixed "(part N of M)", never cutting an entry's
//     own lines apart. Exercised with a fake 30-entry CLI output, so this
//     never depends on the real python CLI producing enough real
//     instincts to cross the cap.
// ---------------------------------------------------------------------------
{
  const { postResult, splitForSyntheticMessage, SYNTHETIC_MESSAGE_CAP } = await import("./lib/commands.js");

  assert.equal(SYNTHETIC_MESSAGE_CAP, 12000, "conservative assumed cap (no documented limit for ctx.session.synthetic's own text field)");

  function fakeEntry(i) {
    return [
      `    ████████░░  80%  habit-${i} [project]`,
      `              trigger: always run the full smoke test suite before pushing any change to branch number ${i} in this long-running repository`,
      `              action: run npm test and npm run lint before opening a pull request for change number ${i} in this project`,
    ].join("\n");
  }
  const fakeStatus = [
    "============================================================",
    "  INSTINCT STATUS - 30 total",
    "============================================================",
    "",
    "## PROJECT-SCOPED (demo)",
    "",
    ...Array.from({ length: 30 }, (_, i) => fakeEntry(i)),
  ].join("\n\n");
  // A smaller, explicit cap than the real default (SYNTHETIC_MESSAGE_CAP,
  // asserted above) makes splitting deterministic here without needing an
  // implausibly large 30-entry fixture to naturally cross 12000 chars.
  const TEST_CAP = 3000;
  assert.ok(fakeStatus.length > TEST_CAP, "the fake 30-entry fixture is deliberately bigger than the test cap, so splitting actually has to happen");

  // --- the pure split function itself -----------------------------------
  const underCap = splitForSyntheticMessage("short output", TEST_CAP);
  assert.deepEqual(underCap, ["short output"], "text under the cap is returned as a single, unmodified part");

  const parts = splitForSyntheticMessage(fakeStatus, TEST_CAP);
  assert.ok(parts.length > 1, "the 30-entry fixture is split into more than one part");
  for (const part of parts) assert.ok(part.length <= TEST_CAP, "every part fits within the cap");
  assert.equal(parts.join("\n\n"), fakeStatus, "rejoining every part on the same separator it was split on reproduces the original text exactly");
  // Every entry's own three lines must land in exactly one part: splitting
  // at the wrong place (mid-entry) would separate a "habit-N [project]"
  // bar line from its own "trigger:"/"action:" continuation lines.
  for (let i = 0; i < 30; i++) {
    const entry = fakeEntry(i);
    assert.ok(parts.some((part) => part.includes(entry)), `entry ${i} lands whole inside exactly one part`);
  }

  // With no entry boundary to split at (no bar-style lines at all),
  // oversized text is kept whole rather than cut at an arbitrary offset.
  assert.deepEqual(splitForSyntheticMessage("no bar lines here, just one long line".repeat(50), 50).length, 1);

  // --- postResult: each part posted as its own synthetic message,
  //     consecutively, each labelled "(part N of M)" -------------------
  const { ctx } = createPluginHarness(path.join(TEMP_ROOT, "postresult-split"), {});
  const syntheticCalls = [];
  ctx.session.synthetic = async (input) => {
    syntheticCalls.push(input);
    return {};
  };
  await postResult(ctx, "split-session", fakeStatus, TEST_CAP);
  assert.equal(syntheticCalls.length, parts.length, "one synthetic message per split part");
  syntheticCalls.forEach((call, index) => {
    assert.equal(call.sessionID, "split-session");
    assert.equal(call.resume, true);
    assert.equal(call.delivery, "queue");
    assert.ok(call.text.startsWith(`(part ${index + 1} of ${parts.length})\n`), `message ${index} carries its own '(part N of M)' prefix`);
    assert.ok(call.text.includes(parts[index]), "the message's own part is wrapped in the usual code fence");
  });

  // Short output (the common case) still posts as exactly one message,
  // with no "(part N of M)" prefix at all, using the real default cap.
  const shortCalls = [];
  const shortCtx = createPluginHarness(path.join(TEMP_ROOT, "postresult-short"), {}).ctx;
  shortCtx.session.synthetic = async (input) => {
    shortCalls.push(input);
    return {};
  };
  await postResult(shortCtx, "s", "No instincts found.");
  assert.equal(shortCalls.length, 1);
  assert.ok(!shortCalls[0].text.includes("part 1 of"), "short output never gets a '(part N of M)' prefix");
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
  assert.equal(state.instincts.minObservations, 20, "default minObservations (options.observer here sets no override)");
  assert.equal(
    state.instincts.nextRunEligibleAt,
    new Date(new Date(lastRunAt).getTime() + 10 * 60000).toISOString(),
    "next run eligible 10 minutes after lastRunAt",
  );
  assert.equal(state.instincts.nextRunReady, false, "the interval gate alone (2 of 10 minutes elapsed) is not enough to be ready yet");
  assert.equal(state.instincts.readyToShare, 2, "0.9 and 0.85 both clear the 0.8 promote threshold and neither is in the (empty) global bucket");
  assert.equal(state.instincts.habitsInPrompts, 2, "alpha (0.9) and beta (0.85) clear the default 0.8 inject.minConfidence; gamma (0.6) does not");
  assert.deepEqual(state.instincts.firedTodayTop, [], "no .activity.json written in this fixture, so nothing fired today");
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
  assert.equal(state.instincts.firedThisWeek, 0, "no .activity.json written in this fixture, so firedThisWeek stays 0");
  assert.equal(state.instincts.awaitingFirstUse, 0, "no instincts/pending directory exists yet");
  assert.equal(state.instincts.skillCandidates, 0, "no evolved/ candidate files exist yet");
  assert.equal(state.instincts.candidatesPath, project.evolved_dir, "the hint path is the project's own evolved dir");
  assert.deepEqual(
    state.instincts.maintenance,
    { lastRunAt: null, lastEvolveAt: null, lastCleanupAt: null, counts7d: { promoted: 0, archived: 0, merged: 0, pruned: 0, candidates: 0, repaired: 0, cleaned: 0 } },
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
// 6a. lib/board.js's nextRunReady/nextRunEligibleAt gate (observer.js's own
//     thresholdsMet(): interval AND minObservations, not the interval
//     alone): a long-idle lastRunAt (interval long since elapsed) used to
//     leave nextRunEligibleAt reading as a stale, confusing duration once
//     relativeTime (direction-free) formatted it; "ready" now covers the
//     "both gates already pass" case explicitly, and the gap once left
//     open when only the observation count is still outstanding (there is
//     no future timestamp to compute an ETA from) now reads as a concrete
//     "after N more events (M so far)" instead of omitting the row.
// ---------------------------------------------------------------------------
{
  const { refreshBoardState } = await import("./lib/board.js");

  const { projectDir, dataDir } = makeProjectAndData("board-ready");
  const options = { python: "python3", dataDir, observer: { enabled: true, runIntervalMinutes: 5, minObservations: 10 }, board: { enabled: true } };
  const ctx = { location: { directory: projectDir } };
  const project = await resolveProject(ctx, options);

  // lastRunAt a full day ago: the 5-minute interval gate is long since
  // elapsed either way, so these two cases differ only in whether enough
  // observations have piled up since.
  const staleLastRunAt = new Date(Date.now() - 86400000).toISOString();
  await fs.mkdir(project.project_dir, { recursive: true });
  await fs.writeFile(path.join(project.project_dir, ".observer-state.json"), JSON.stringify({ lastRunAt: staleLastRunAt, lastLineCount: 0 }), "utf8");

  // Case 1: 12 pending lines, minObservations 10: both gates pass, so the
  // board reads "ready" instead of some stale duration.
  await fs.writeFile(project.observations_file, Array.from({ length: 12 }, (_, i) => JSON.stringify({ n: i })).join("\n") + "\n", "utf8");
  const readyState = await refreshBoardState(ctx, options);
  assert.equal(readyState.instincts.nextRunReady, true, "interval elapsed and minObservations met: ready now");
  assert.equal(readyState.instincts.nextRunEligibleAt, null, "no future ETA needed once already ready");

  // Case 2: only 4 pending lines (minObservations still 10): the interval
  // gate alone is not the whole story, and there is no future timestamp to
  // predict when enough new activity will arrive, so neither "ready" nor
  // a relativeTime ETA is shown; the gate instead reads as a concrete
  // "N more events needed" count.
  await fs.writeFile(project.observations_file, Array.from({ length: 4 }, (_, i) => JSON.stringify({ n: i })).join("\n") + "\n", "utf8");
  const waitingState = await refreshBoardState(ctx, options);
  assert.equal(waitingState.instincts.nextRunReady, false, "interval elapsed but minObservations not met: not ready");
  assert.equal(waitingState.instincts.nextRunEligibleAt, null, "no ETA exists for 'waiting on more activity'; it is not a time-bound wait");
  assert.equal(waitingState.instincts.minObservations, 10, "the gate's own minObservations is carried onto the board state too");
  assert.equal(waitingState.instincts.pendingObservations, 4);

  const { buildInstinctsBlock } = await import("./lib/board-text.js");
  assert.ok(
    buildInstinctsBlock(readyState.instincts).rows.some((row) => row.label === "next learning run" && row.value === "ready"),
    "the sidebar/board block model shows 'ready' instead of a relativeTime duration",
  );
  assert.ok(
    buildInstinctsBlock(waitingState.instincts).rows.some((row) => row.label === "next learning run" && row.value === "after 6 more events (4 so far)"),
    "with no ETA and not ready, the row reads as a concrete 'N more events needed' count instead of being omitted",
  );
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
// 6d. lib/board-evals.js's root priority and fixture filtering: the first
//     configured root wins outright (its own newest file), even against a
//     strictly newer benchmark.json under a later, smoke-test-fixture-
//     looking root; only once the first root has nothing at all does a
//     later root get searched, with fixture-looking paths skipped there.
//     Mirrors the real bug this fixed: a live board's default roots are
//     [~/.config/opencode/skills, $TMPDIR/opencode], and this very file's
//     own fixtures (made under exactly the second one) were what a live
//     board picked up instead of a real skill-creator run.
// ---------------------------------------------------------------------------
{
  const { readEvalsSummary } = await import("./lib/board-evals.js");

  const realRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "real-skills-"));
  const realIterationDir = path.join(realRoot, "pr-workspace", "iteration-1");
  await fs.mkdir(realIterationDir, { recursive: true });
  const realTimestamp = new Date(Date.now() - 86400000).toISOString();
  await fs.writeFile(
    path.join(realIterationDir, "benchmark.json"),
    JSON.stringify({
      metadata: { skill_name: "real-pr-skill", timestamp: realTimestamp, evals_run: [1], runs_per_configuration: 1 },
      run_summary: { without_skill: { pass_rate: { mean: 0.2 } }, with_skill: { pass_rate: { mean: 0.8 } } },
    }),
    "utf8",
  );

  // A smoke-test-fixture-looking root (an "eval-<id>" directory, exactly
  // the shape smoke-test.mjs's own mkdtempSync calls create under the
  // default temp root), holding a strictly newer benchmark.json than the
  // real root above.
  const fixtureRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "eval-"));
  const fixtureIterationDir = path.join(fixtureRoot, "fixture-workspace", "iteration-1");
  await fs.mkdir(fixtureIterationDir, { recursive: true });
  await fs.writeFile(
    path.join(fixtureIterationDir, "benchmark.json"),
    JSON.stringify({
      metadata: { skill_name: "no-runs-array", timestamp: new Date().toISOString(), evals_run: [1], runs_per_configuration: 1 },
      run_summary: { without_skill: { pass_rate: { mean: 0.1 } }, with_skill: { pass_rate: { mean: 0.9 } } },
    }),
    "utf8",
  );

  const result = await readEvalsSummary([realRoot, fixtureRoot]);
  assert.equal(result.skill, "real-pr-skill", "the first configured root's own benchmark wins outright, even though the second root's file is newer");
  assert.equal(result.timestamp, realTimestamp);

  // The same fixture-looking root is still read normally when it is the
  // only (first) root configured: fixture filtering only ever applies to
  // a root beyond the first, never to the one the caller explicitly
  // pointed at.
  const fixtureOnly = await readEvalsSummary([fixtureRoot]);
  assert.equal(fixtureOnly.skill, "no-runs-array", "a fixture-looking root is still read when it is the only (first) root configured");
}

// ---------------------------------------------------------------------------
// 7. /board summary text (lib/board-format.js): a brief, explanatory chat
//    reply (glyph, then a padded label, then each block's key facts on one
//    headline line, then indented plain-language body lines), not the
//    sidebar's table-like rows. Must never throw, including when the board
//    has not been written yet or every block reports itself unavailable,
//    must read its facts through lib/board-text.js's own block builders (so
//    it can never show a glyph/availability state the sidebar itself would
//    disagree with), and must end with the same legend row the sidebar
//    panel's own footer uses.
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
  assert.ok(summary.startsWith("\u25cb Learned habits"), "circle before the label, even for an unavailable block");
  assert.ok(summary.includes("active") && summary.includes("needs attention") && summary.includes("stale"), "the legend row is always appended");
  assert.ok(!/[\u2014\u2013]/.test(summary), "/board text never contains an em or en dash");

  const disabledSections = formatBoardSummary(everythingUnavailable, { board: { sections: { instincts: false, observations: false, evals: false } } });
  assert.equal(disabledSections, "No board sections enabled.", "every block can be hidden independently");

  // A fuller, "everything available" state exercises the actual
  // explanatory content: the headline's total/in-prompts/used-today(week)
  // figures, the "Most used today:" list (counts differ, so it is not
  // "Used today:"), the next-run phrasing, and the compact /promote hint.
  const richState = {
    updatedAt: new Date().toISOString(),
    instincts: {
      project: 10,
      inherited: 4,
      global: 2,
      observerEnabled: true,
      nextRunReady: true,
      lastRun: new Date().toISOString(),
      habitsInPrompts: 6,
      readyToShare: 3,
      firedToday: 4,
      firedThisWeek: 14,
      firedTodayTop: [
        { id: "grep-before-edit", count: 3, summary: "Search the repo before editing unfamiliar files." },
        { id: "run-tests-first", count: 1, summary: "Run the test suite before pushing." },
      ],
    },
    observations: { open: 398, parked: 12, lastReview: null, staged: 2, added7d: 158, available: true, warning: false },
    evals: {
      skill: "pr",
      delta: 0.84,
      withSkill: 0.92,
      baseline: 0.08,
      baselineKind: "without",
      iteration: 2,
      path: "/x/benchmark.json",
      available: true,
      timestamp: new Date(Date.now() - 2 * 86400000).toISOString(),
    },
  };
  const richSummary = formatBoardSummary(richState, {});
  assert.ok(richSummary.startsWith("\u25cf Learned habits"), "circle before the label");
  assert.ok(richSummary.includes("16 total, 6 in prompts, 4 used today (14 this week)"), "the headline carries project+inherited+global, live eligibility, and today/this-week fired counts");
  assert.ok(
    richSummary.includes("Most used today: grep-before-edit (3x): Search the repo before editing unfamiliar files."),
    "counts differ (3x vs 1x), so the list reads 'Most used today:', each entry carrying its id, fired count, and summary",
  );
  assert.ok(richSummary.includes("run-tests-first (1x): Run the test suite before pushing."), "every fired-today habit is listed, not just the first");
  assert.ok(richSummary.includes("Next learning run ready. 3 ready: /promote."), "nextRunReady reads as 'ready', and the /promote hint rides the same line once readyToShare is positive");
  assert.ok(richSummary.includes("398 open, 158 this week, never reviewed."), "Skill notes stays a single headline line");
  assert.ok(
    richSummary.includes("the skill lifts the pass rate from 8% without to 92% with it, 2d ago."),
    "Skill test names the comparison (with vs without) and the verdict (improved), not just the two raw percentages",
  );
  assert.ok(!/[\u2014\u2013]/.test(richSummary), "/board text never contains an em or en dash");

  const noHabitsToday = formatBoardSummary({ ...richState, instincts: { ...richState.instincts, firedTodayTop: [] } }, {});
  assert.ok(noHabitsToday.includes("No habits fired today yet."), "an empty top-habits list reads as a plain sentence, not an empty list header");

  // "Used today:" (no "Top"/"Most") once every listed habit fired exactly
  // once: nothing to rank, so the wording never implies an ordering.
  const allOnesSummary = formatBoardSummary(
    { ...richState, instincts: { ...richState.instincts, firedTodayTop: [{ id: "habit-a", count: 1, summary: "Do A." }, { id: "habit-b", count: 1, summary: "Do B." }] } },
    {},
  );
  assert.ok(allOnesSummary.includes("Used today: habit-a (1x): Do A."), "every count is 1: 'Used today:', not 'Most used today:'");
  assert.ok(!allOnesSummary.includes("Most used today:"));
  assert.ok(allOnesSummary.includes("habit-b (1x): Do B."));

  // The three next-learning-run phrasings: "ready" (above), "in <rel>"
  // (still waiting on the interval), and "after N more events (M so
  // far)" (interval elapsed, but not enough observed yet).
  const waitingOnIntervalSummary = formatBoardSummary(
    {
      ...richState,
      instincts: { ...richState.instincts, nextRunReady: false, nextRunEligibleAt: new Date(Date.now() + 5 * 60000).toISOString(), readyToShare: 0 },
    },
    {},
  );
  assert.ok(waitingOnIntervalSummary.includes("Next learning run in 5m."), "still waiting on the interval itself reads 'in <rel>'");

  const waitingOnEventsSummary = formatBoardSummary(
    {
      ...richState,
      instincts: { ...richState.instincts, nextRunReady: false, nextRunEligibleAt: null, minObservations: 20, pendingObservations: 6, readyToShare: 0 },
    },
    {},
  );
  assert.ok(waitingOnEventsSummary.includes("Next learning run after 14 more events (6 so far)."), "the interval has elapsed but minObservations has not: a concrete count, not a vague 'waiting on more activity'");
  assert.ok(!waitingOnEventsSummary.includes("ready:"), "no /promote hint when readyToShare is 0");

  // Skill notes: ": review overdue" appended only when the warning flag
  // (lib/board-observations.js's own open>100-and-stale-review rule) is set.
  const overdueSummary = formatBoardSummary({ ...richState, observations: { ...richState.observations, open: 467, added7d: 167, warning: true } }, {});
  assert.ok(overdueSummary.includes("467 open, 167 this week, never reviewed: review overdue."), "the warning flag appends ': review overdue' to the same headline line");

  // Skill test: both runs at the ceiling reads "saturated" (not just "no
  // change"), a stale glyph, and names what was compared (with vs
  // without) and why the near-zero difference does not mean the skill
  // did nothing: the evals themselves cannot separate the two runs.
  const noDifferenceSummary = formatBoardSummary(
    { ...richState, evals: { ...richState.evals, withSkill: 1, baseline: 1, timestamp: new Date(Date.now() - 4 * 86400000).toISOString() } },
    {},
  );
  assert.ok(
    noDifferenceSummary.includes("\u25cb Skill test (pr)  100% both with and without the skill: the evals cannot tell them apart, 4d ago. Add harder cases."),
    "both runs at the ceiling reads 'saturated' with a stale (hollow) glyph, matching the target format exactly",
  );

  // Skill test: the same "both at the ceiling" scenario, but for
  // skill-creator's "old_skill" naming (comparing the same skill against
  // its own previous version, not with/without it): "old and new both
  // pass", and the glyph stays stale no matter how old the benchmark is.
  const saturatedOldVsNew = formatBoardSummary(
    { ...richState, evals: { ...richState.evals, baselineKind: "old", withSkill: 1, baseline: 1, timestamp: new Date(Date.now() - 8 * 86400000).toISOString() } },
    {},
  );
  assert.ok(
    saturatedOldVsNew.includes("the last edit changed nothing the evals can see: old and new both pass 100%, 8d ago. The evals are saturated; add harder cases."),
    "old vs new, both at the ceiling: 'saturated', naming that this benchmark compares old and new versions of the same skill",
  );

  // Skill test: old vs new, a real rise (not saturated, not just inside
  // the no-change band): 'improved', and an active (solid) glyph while
  // the benchmark is still fresh.
  const improvedOldVsNew = formatBoardSummary(
    { ...richState, evals: { ...richState.evals, baselineKind: "old", withSkill: 1, baseline: 0.67, timestamp: new Date(Date.now() - 1 * 86400000).toISOString() } },
    {},
  );
  assert.ok(
    improvedOldVsNew.includes("\u25cf Skill test (pr)  the last edit raised the pass rate from 67% (old) to 100% (new), 1d ago."),
    "old vs new, a real rise: 'improved', with an active glyph while fresh",
  );

  // Skill test: with vs without, a near-zero difference that is not at
  // the ceiling: 'no change', distinct wording (and reasoning) from
  // 'saturated'.
  const noChangeWithVsWithout = formatBoardSummary(
    { ...richState, evals: { ...richState.evals, withSkill: 0.5, baseline: 0.5, timestamp: new Date().toISOString() } },
    {},
  );
  assert.ok(
    noChangeWithVsWithout.includes("the skill makes no measurable difference: 50% with it, 50% without,"),
    "with vs without, a near-zero (not at the ceiling) difference reads 'no change', not 'saturated'",
  );

  // Skill test: with vs without, a real drop: 'worse', and a stale glyph
  // even though the benchmark itself is fresh (only a fresh 'improved'
  // ever reads active).
  const worseWithVsWithout = formatBoardSummary(
    { ...richState, evals: { ...richState.evals, withSkill: 0.83, baseline: 1, timestamp: new Date(Date.now() - 1 * 86400000).toISOString() } },
    {},
  );
  assert.ok(
    worseWithVsWithout.includes("\u25cb Skill test (pr)  the skill lowers the pass rate from 100% without to 83% with it, 1d ago."),
    "with vs without, a real drop: 'worse', with a stale glyph even though the benchmark itself is fresh",
  );
}

// ---------------------------------------------------------------------------
// 7a. lib/board.js's firedTodayTop: capped at 5 (not 3), sorted by count
//     desc then id, and clipped at a word boundary (lib/store.js's
//     clipSummaryWordBoundary) at 100 chars, not mid-word, since the
//     /board chat reply has no 36-column sidebar budget to justify a hard
//     character cut. Exercised end to end through lib/activity.js's
//     recordFired and lib/board.js's refreshBoardState, with a fake CLI
//     output irrelevant here (this is the board, not /instinct-status).
// ---------------------------------------------------------------------------
{
  const { refreshBoardState } = await import("./lib/board.js");
  const { recordFired } = await import("./lib/activity.js");

  const { projectDir, dataDir } = makeProjectAndData("board-fired-top");
  const options = { python: "python3", dataDir, board: { enabled: true } };
  const ctx = { location: { directory: projectDir } };
  const project = await resolveProject(ctx, options);

  const longSummary =
    "Always search the entire repository with grep for every existing usage of a helper before editing or renaming it so nothing downstream silently breaks";
  await writeInstinct(project.instincts_personal, { id: "habit-0", trigger: "t0", confidence: 0.9, domain: "workflow", summary: longSummary }, "# 0\n");
  for (let i = 1; i <= 5; i++) {
    await writeInstinct(project.instincts_personal, { id: `habit-${i}`, trigger: `t${i}`, confidence: 0.9, domain: "workflow", summary: `Do habit ${i}.` }, `# ${i}\n`);
  }

  // habit-0: 5x, habit-1: 4x, habit-2: 3x, habit-3: 2x, habit-4 and
  // habit-5: 1x each (a tie broken by id, so habit-4 edges out habit-5
  // for the 5th and final slot).
  await recordFired(project.project_dir, "habit-0", 5);
  await recordFired(project.project_dir, "habit-1", 4);
  await recordFired(project.project_dir, "habit-2", 3);
  await recordFired(project.project_dir, "habit-3", 2);
  await recordFired(project.project_dir, "habit-4", 1);
  await recordFired(project.project_dir, "habit-5", 1);

  const state = await refreshBoardState(ctx, options);
  assert.equal(state.instincts.firedTodayTop.length, 5, "capped at 5, not 3");
  assert.deepEqual(
    state.instincts.firedTodayTop.map((entry) => entry.id),
    ["habit-0", "habit-1", "habit-2", "habit-3", "habit-4"],
    "sorted by count desc, ties broken by id; habit-5 (the 6th, tied at 1x) is dropped",
  );
  assert.equal(state.instincts.firedToday, 16, "5+4+3+2+1+1 fired today, summed across every id");
  assert.equal(state.instincts.firedThisWeek, 16, "the same activity, all today, sums into the 7-day rollup too");

  const longEntry = state.instincts.firedTodayTop.find((entry) => entry.id === "habit-0");
  assert.ok(longEntry.summary.length <= 100, "clipped at (or under) 100 chars");
  assert.ok(longSummary.startsWith(longEntry.summary), "the clip is a clean prefix of the original text");
  assert.ok(!/\s$/.test(longEntry.summary), "no trailing space left behind by backing off to the last word boundary");
  assert.ok(longSummary[longEntry.summary.length] === undefined || longSummary[longEntry.summary.length] === " ", "the cut lands exactly on a word boundary, never mid-word");
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
  assert.equal(withCandidates.rows[candidatesRowIndex + 1]?.hint, "run /evolve-list");

  const withoutCandidates = buildInstinctsBlock({ project: 5, inherited: 0, global: 0, observerEnabled: true, lastRun: new Date().toISOString(), readyToShare: 0, skillCandidates: 0 });
  assert.ok(!withoutCandidates.rows.some((row) => row.label === "skill candidates"), "skillCandidates: 0 omits the row entirely");

  // --- "installed from habits" and "unused candidates" (0.8.0's evolve
  //     lifecycle rows): both omitted at 0, both shown with the right
  //     hint text once nonzero -----------------------------------------
  const withInstalledAndUnused = buildInstinctsBlock({
    project: 5,
    inherited: 0,
    global: 0,
    observerEnabled: true,
    lastRun: new Date().toISOString(),
    installedFromHabits: 3,
    unusedCandidates: 1,
  });
  assert.ok(withInstalledAndUnused.rows.some((row) => row.label === "installed from habits" && row.value === "3"));
  const unusedRowIndex = withInstalledAndUnused.rows.findIndex((row) => row.label === "unused candidates");
  assert.equal(withInstalledAndUnused.rows[unusedRowIndex].value, "1");
  assert.equal(withInstalledAndUnused.rows[unusedRowIndex + 1]?.hint, "see /evolve-list");

  const withoutInstalledOrUnused = buildInstinctsBlock({
    project: 5,
    inherited: 0,
    global: 0,
    observerEnabled: true,
    lastRun: new Date().toISOString(),
    installedFromHabits: 0,
    unusedCandidates: 0,
  });
  assert.ok(!withoutInstalledOrUnused.rows.some((row) => row.label === "installed from habits"), "installedFromHabits: 0 omits the row entirely");
  assert.ok(!withoutInstalledOrUnused.rows.some((row) => row.label === "unused candidates"), "unusedCandidates: 0 omits the row entirely");

  // --- "habits in prompts": a live eligibility count, shown even at 0
  //     (unlike "used today / this week", a per-day/per-week tally that
  //     still hides when nothing fired this week) -----------------------
  const noHabitsInPrompts = buildInstinctsBlock({ project: 1, inherited: 0, global: 0, observerEnabled: true, lastRun: new Date().toISOString(), habitsInPrompts: 0, firedToday: 0, firedThisWeek: 0 });
  assert.ok(noHabitsInPrompts.rows.some((row) => row.label === "habits in prompts" && row.value === "0"), "a zero (known) habitsInPrompts still renders its own row");
  assert.ok(!noHabitsInPrompts.rows.some((row) => row.label === "used today / this week"), "firedThisWeek 0 still omits its own row");
  const withHabitsInPrompts = buildInstinctsBlock({ project: 1, inherited: 0, global: 0, observerEnabled: true, lastRun: new Date().toISOString(), habitsInPrompts: 5, firedToday: 2, firedThisWeek: 9 });
  assert.ok(withHabitsInPrompts.rows.some((row) => row.label === "habits in prompts" && row.value === "5"));
  assert.ok(withHabitsInPrompts.rows.some((row) => row.label === "used today / this week" && row.value === "2 / 9"), "the row combines today's count and the 7-day rollup as 'today / week'");
  const noHabitsInPromptsField = buildInstinctsBlock({ project: 1, inherited: 0, global: 0, observerEnabled: true, lastRun: new Date().toISOString() });
  assert.ok(!noHabitsInPromptsField.rows.some((row) => row.label === "habits in prompts"), "habitsInPrompts missing entirely (e.g. an older board-state.json) omits the row rather than showing a bare 'null'");

  // --- "next learning run": "ready" takes priority over a computed ETA,
  //     which itself now reads "in <rel>"; once neither applies, the
  //     minObservations gate (not the interval) renders as a concrete
  //     "after N more events (M so far)" instead of the row being
  //     omitted ---------------------------------------------------------
  const readyModel = buildInstinctsBlock({ project: 1, inherited: 0, global: 0, observerEnabled: true, lastRun: new Date().toISOString(), nextRunReady: true, nextRunEligibleAt: null });
  assert.ok(readyModel.rows.some((row) => row.label === "next learning run" && row.value === "ready"), "nextRunReady shows 'ready', not a duration");
  const etaModel = buildInstinctsBlock({
    project: 1,
    inherited: 0,
    global: 0,
    observerEnabled: true,
    lastRun: new Date().toISOString(),
    nextRunReady: false,
    nextRunEligibleAt: new Date(Date.now() + 3 * 60000).toISOString(),
  });
  assert.ok(etaModel.rows.some((row) => row.label === "next learning run" && row.value === "in 3m"), "a future ETA reads 'in <rel>', with the direction word baked in");
  const noEtaModel = buildInstinctsBlock({ project: 1, inherited: 0, global: 0, observerEnabled: true, lastRun: new Date().toISOString(), nextRunReady: false, nextRunEligibleAt: null });
  assert.ok(!noEtaModel.rows.some((row) => row.label === "next learning run"), "neither ready, a known ETA, nor a minObservations/pendingObservations count: the row is omitted entirely");
  const gateCountModel = buildInstinctsBlock({
    project: 1,
    inherited: 0,
    global: 0,
    observerEnabled: true,
    lastRun: new Date().toISOString(),
    nextRunReady: false,
    nextRunEligibleAt: null,
    minObservations: 20,
    pendingObservations: 6,
  });
  assert.ok(
    gateCountModel.rows.some((row) => row.label === "next learning run" && row.value === "after 14 more events (6 so far)"),
    "the interval has elapsed but minObservations has not: a concrete 'N more events needed' count, not an omitted row",
  );

  // --- "kept tidy" summary row: omitted when all-zero, joined otherwise
  const keptTidyEmpty = buildInstinctsBlock({ project: 1, inherited: 0, global: 0, observerEnabled: true, lastRun: new Date().toISOString(), maintenance: { counts7d: { promoted: 0, archived: 0, merged: 0, pruned: 0, candidates: 0, repaired: 0, cleaned: 0 } } });
  assert.ok(!keptTidyEmpty.rows.some((row) => row.label === "kept tidy"), "an all-zero week omits the 'kept tidy' row");
  const keptTidySome = buildInstinctsBlock({ project: 1, inherited: 0, global: 0, observerEnabled: true, lastRun: new Date().toISOString(), maintenance: { counts7d: { promoted: 1, archived: 2, merged: 0, pruned: 0, candidates: 0, repaired: 0, cleaned: 3 } } });
  const keptTidyRow = keptTidySome.rows.find((row) => row.label === "kept tidy");
  assert.equal(keptTidyRow.value, "promoted 1, archived 2, cleaned 3", "zero items are omitted, nonzero ones (including the new 'cleaned' count) joined in a fixed order");

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
  assert.equal(evalsNone.verdict, null, "nothing to compare: no verdict");

  const evalsNoSkillName = buildEvalsBlock({ available: true, skill: null, withSkill: 0.9, baseline: 0.1, timestamp: new Date().toISOString() });
  assert.equal(evalsNoSkillName.label, "Skill test", "available data with no skill name on record still reads as the bare label");
  assert.equal(evalsNoSkillName.glyph, "stale");

  const evalsFresh = buildEvalsBlock({ available: true, skill: "pr", withSkill: 0.92, baseline: 0.08, baselineKind: "without", timestamp: new Date(Date.now() - 2 * 86400000).toISOString() });
  assert.equal(evalsFresh.label, "Skill test (pr)");
  assert.equal(evalsFresh.glyph, "active", "a benchmark under 7 days old reads active");
  assert.equal(evalsFresh.comparison, "with vs without");
  assert.deepEqual(evalsFresh.rows, [{ label: "with skill", value: "92%" }, { label: "without", value: "8%" }, { label: "verdict", value: "improved" }], "the verdict row always comes after both percentage rows");

  const evalsStale = buildEvalsBlock({ available: true, skill: "pr", withSkill: 0.92, baseline: 0.08, baselineKind: "without", timestamp: new Date(Date.now() - 9 * 86400000).toISOString() });
  assert.equal(evalsStale.glyph, "stale", "a benchmark over 7 days old reads stale");

  const evalsOldNaming = buildEvalsBlock({ available: true, skill: "pr", withSkill: 0.92, baseline: 0.08, baselineKind: "old", timestamp: new Date().toISOString() });
  assert.equal(evalsOldNaming.comparison, "old vs new", "the 'old_skill' naming reads as the 'old vs new' comparison");
  assert.deepEqual(evalsOldNaming.rows, [{ label: "new", value: "92%" }, { label: "old", value: "8%" }, { label: "verdict", value: "improved" }], "the 'old_skill' naming reads 'new'/'old' instead of 'with skill'/'without', and still carries the verdict row");

  // --- buildEvalsBlock: "no measurable difference" (|with - baseline| <
  //     0.05) reads stale even though the benchmark itself is fresh, and
  //     a negative difference (the skill measured worse) reads stale too,
  //     even well outside that narrow band -------------------------------
  const evalsNoDifference = buildEvalsBlock({ available: true, skill: "pr", withSkill: 1, baseline: 1, baselineKind: "without", timestamp: new Date(Date.now() - 4 * 86400000).toISOString() });
  assert.equal(evalsNoDifference.glyph, "stale", "a fresh benchmark with no measurable difference still reads stale");
  assert.equal(evalsNoDifference.noMeasurableDifference, true);
  assert.equal(evalsNoDifference.verdict, "saturated", "both runs at the ceiling: verdict is 'saturated', not just 'no change'");

  const evalsSmallPositive = buildEvalsBlock({ available: true, skill: "pr", withSkill: 0.52, baseline: 0.5, baselineKind: "without", timestamp: new Date().toISOString() });
  assert.equal(evalsSmallPositive.noMeasurableDifference, true, "a +0.02 difference is still inside the 0.05 'no measurable difference' band");
  assert.equal(evalsSmallPositive.glyph, "stale");
  assert.equal(evalsSmallPositive.verdict, "no change", "a small difference that is not at the ceiling: 'no change', not 'saturated'");

  const evalsRegression = buildEvalsBlock({ available: true, skill: "pr", withSkill: 0.4, baseline: 0.8, baselineKind: "without", timestamp: new Date().toISOString() });
  assert.equal(evalsRegression.glyph, "stale", "a large negative difference (the skill measured worse) reads stale too, not just the near-zero band");
  assert.equal(evalsRegression.noMeasurableDifference, false, "a large regression is not worded as 'no measurable difference'; it is just stale");
  assert.equal(evalsRegression.verdict, "worse");

  const evalsRealImprovement = buildEvalsBlock({ available: true, skill: "pr", withSkill: 0.92, baseline: 0.08, baselineKind: "without", timestamp: new Date().toISOString() });
  assert.equal(evalsRealImprovement.glyph, "active", "a real, fresh improvement still reads active");
  assert.equal(evalsRealImprovement.noMeasurableDifference, false);
  assert.equal(evalsRealImprovement.verdict, "improved");
  assert.deepEqual(evalsRealImprovement.rows.map((row) => row.label), ["with skill", "without", "verdict"], "the verdict row always comes after both percentage rows");

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
//     lastObservedAt or each other; recordFired also tracks a per-id
//     breakdown (firedByIdToday) alongside the aggregate, for the /board
//     chat summary's "top habits used today" list; readActivitySnapshot
//     always reads straight from disk and is date-scoped (a stale
//     appliedDate/firedDate reads as 0 "today", and firedByIdToday resets
//     with it).
// ---------------------------------------------------------------------------
{
  const { recordObserved, recordApplied, recordFired, readActivitySnapshot } = await import("./lib/activity.js");

  const { projectDir } = makeProjectAndData("activity");
  await fs.mkdir(projectDir, { recursive: true });

  const before = await readActivitySnapshot(projectDir);
  assert.equal(before.lastObservedAt, null, "no .activity.json yet: lastObservedAt starts null");
  assert.equal(before.appliedToday, 0, "no .activity.json yet: appliedToday starts 0");
  assert.equal(before.firedToday, 0, "no .activity.json yet: firedToday starts 0");
  assert.equal(before.firedThisWeek, 0, "no .activity.json yet: firedThisWeek starts 0");
  assert.deepEqual(before.firedByIdToday, {}, "no .activity.json yet: firedByIdToday starts empty");

  await recordObserved(projectDir);
  const firstWrite = JSON.parse(await fs.readFile(path.join(projectDir, ".activity.json"), "utf8"));
  assert.ok(typeof firstWrite.lastObservedAt === "string" && !Number.isNaN(Date.parse(firstWrite.lastObservedAt)), "the first recordObserved call always flushes to disk");

  await recordObserved(projectDir); // immediate second call, still inside the 10s throttle window
  const secondWrite = JSON.parse(await fs.readFile(path.join(projectDir, ".activity.json"), "utf8"));
  assert.equal(secondWrite.lastObservedAt, firstWrite.lastObservedAt, "a second call inside the 10s throttle window does not flush again");

  await recordApplied(projectDir, 2);
  await recordApplied(projectDir, 3);
  await recordFired(projectDir, "habit-a");
  await recordFired(projectDir, "habit-b", 2);
  await recordFired(projectDir, "habit-a"); // fires again: its own per-id count accumulates independently of habit-b's
  const afterApplied = await readActivitySnapshot(projectDir);
  assert.equal(afterApplied.appliedToday, 5, "recordApplied accumulates within the same day");
  assert.equal(afterApplied.firedToday, 4, "recordFired's aggregate accumulates within the same day, independently of appliedToday");
  assert.equal(afterApplied.firedThisWeek, 4, "the same day's total also lands in the 7-day rollup (today is within the last 7 days)");
  assert.deepEqual(afterApplied.firedByIdToday, { "habit-a": 2, "habit-b": 2 }, "per-id fired-today counts accumulate alongside the aggregate");
  assert.ok(
    typeof afterApplied.lastObservedAt === "string" && !Number.isNaN(Date.parse(afterApplied.lastObservedAt)),
    "recordApplied/recordFired's writes never clobber lastObservedAt with null/undefined",
  );
  assert.ok(Date.parse(afterApplied.lastObservedAt) >= Date.parse(firstWrite.lastObservedAt), "lastObservedAt never moves backwards");

  // A stale appliedDate/firedDate (e.g. from before midnight UTC) must
  // read as 0 for "today" rather than passed through as-is, and
  // firedByIdToday must reset with it rather than leaking yesterday's ids.
  const activityPath = path.join(projectDir, ".activity.json");
  const stale = JSON.parse(await fs.readFile(activityPath, "utf8"));
  stale.appliedDate = "2000-01-01";
  stale.appliedToday = 99;
  stale.firedDate = "2000-01-01";
  stale.firedToday = 99;
  stale.firedByIdToday = { "stale-habit": 99 };
  await fs.writeFile(activityPath, JSON.stringify(stale), "utf8");
  const afterStaleDate = await readActivitySnapshot(projectDir);
  assert.equal(afterStaleDate.appliedToday, 0, "appliedToday from a different (stale) date reads as 0 for today");
  assert.equal(afterStaleDate.firedToday, 0, "firedToday from a different (stale) date reads as 0 for today");
  assert.deepEqual(afterStaleDate.firedByIdToday, {}, "firedByIdToday from a different (stale) date reads as empty for today");
  assert.equal(afterStaleDate.firedThisWeek, 4, "firedThisWeek is tracked per real calendar day (firedByDay), independently of the stale firedDate/firedToday override above");
}

// ---------------------------------------------------------------------------
// 10a. lib/activity.js: firedByDay keeps at most FIRED_HISTORY_DAYS (7)
//      days, today inclusive; a day older than that is excluded from
//      firedThisWeek and pruned from the file on the very next
//      recordFired write, so this file never grows unbounded.
// ---------------------------------------------------------------------------
{
  const { recordFired, readActivitySnapshot } = await import("./lib/activity.js");

  const { projectDir: historyDir } = makeProjectAndData("activity-history");
  await fs.mkdir(historyDir, { recursive: true });
  const historyPath = path.join(historyDir, ".activity.json");

  const today = new Date().toISOString().slice(0, 10);
  const withinWindow = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const outsideWindow = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  await fs.writeFile(historyPath, JSON.stringify({ firedByDay: { [outsideWindow]: 50, [withinWindow]: 7 } }), "utf8");

  const beforeRecord = await readActivitySnapshot(historyDir);
  assert.equal(beforeRecord.firedThisWeek, 7, "a day 10 days ago is outside the 7-day window and never counted");

  await recordFired(historyDir, "habit-x", 2);
  const afterRecord = await readActivitySnapshot(historyDir);
  assert.equal(afterRecord.firedThisWeek, 9, "7 (3 days ago) + 2 (today) once the new fire lands");

  const onDisk = JSON.parse(await fs.readFile(historyPath, "utf8"));
  assert.deepEqual(
    Object.keys(onDisk.firedByDay).sort(),
    [withinWindow, today].sort(),
    "the 10-days-ago entry is pruned from disk on the very next write, keeping the file from growing unbounded",
  );
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
// 13a. lib/inject.js's fired-miss logging (fired-misses.log, beside
//      .activity.json): a candidate whose trigger shares exactly 1 or 2
//      significant words with the latest message (just under
//      MIN_SHARED_WORDS, so it never actually fires) is logged there with
//      its id, the shared-word count, and the words themselves, for
//      tuning the firing threshold later; a message sharing 0 words logs
//      nothing (not "every near-zero candidate", only near misses), and
//      the log stays capped at 200 lines (oldest dropped first).
// ---------------------------------------------------------------------------
{
  const { registerInject } = await import("./lib/inject.js");

  const { projectDir, dataDir } = makeProjectAndData("inject-miss");
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

  await registerInject(ctx, options);

  // Shares exactly 2 significant words with the trigger (unfamiliar,
  // repository; "editing" is not in this message, "before" and "grep"
  // are never significant at all): a near miss, just under
  // MIN_SHARED_WORDS (3).
  const nearMissEvent = contextEvent({ sessionID: "miss-s1", userText: "the unfamiliar repository needs cleanup" });
  await hooks.context(nearMissEvent);

  const missLogPath = path.join(project.project_dir, "fired-misses.log");
  const missLogContent = await fs.readFile(missLogPath, "utf8");
  const missLines = missLogContent.split("\n").filter((line) => line.trim().length > 0);
  assert.equal(missLines.length, 1, "exactly one near miss logged");
  assert.ok(missLines[0].includes("id=grep-before-edit"), "the log line names the candidate id");
  assert.ok(missLines[0].includes("count=2"), "the log line carries the shared-word count");
  assert.ok(missLines[0].includes("words=unfamiliar,repository"), "the log line names the actual shared words");

  const instinctAfterNearMiss = await fs.readFile(path.join(project.instincts_personal, "grep-before-edit.md"), "utf8");
  assert.ok(!/fired:/.test(instinctAfterNearMiss), "a near miss (below MIN_SHARED_WORDS) never bumps the instinct's own fired count");

  // A message sharing 0 significant words with the trigger logs nothing
  // at all: only near misses (1 or 2 shared words) are worth logging.
  const noOverlapEvent = contextEvent({ sessionID: "miss-s1", userText: "please summarise the quarterly numbers" });
  await hooks.context(noOverlapEvent);
  const stillOneLine = (await fs.readFile(missLogPath, "utf8")).split("\n").filter((line) => line.trim().length > 0);
  assert.equal(stillOneLine.length, 1, "a message with zero shared words never adds a line");

  // The log stays capped at 200 lines: pre-seed it at exactly the cap,
  // then one more near miss must push out the oldest line rather than
  // growing past it.
  const seeded = Array.from({ length: 200 }, (_, i) => `seed-line-${i}`).join("\n");
  await fs.writeFile(missLogPath, `${seeded}\n`, "utf8");
  await hooks.context(contextEvent({ sessionID: "miss-s1", userText: "the unfamiliar repository needs cleanup again" }));
  const cappedLines = (await fs.readFile(missLogPath, "utf8")).split("\n").filter((line) => line.trim().length > 0);
  assert.equal(cappedLines.length, 200, "the log never grows past 200 lines");
  assert.ok(!cappedLines.includes("seed-line-0"), "the oldest line is dropped once the cap is exceeded");
  assert.ok(cappedLines[cappedLines.length - 1].includes("id=grep-before-edit"), "the newest near miss is the last line");

  // Two near misses in the very same request (bumpFiredForMatches runs
  // its per-entry checks via Promise.all) must both land: the
  // read-modify-write against fired-misses.log is serialized per project
  // directory precisely so two near misses racing on the same file never
  // let one overwrite the other.
  await fs.writeFile(missLogPath, "", "utf8");
  await writeInstinct(
    project.instincts_personal,
    { id: "verify-coverage", trigger: "always verify coverage thresholds before merging pull request", confidence: 0.9, domain: "testing" },
    "# Verify Coverage\n\n## Action\nVerify coverage thresholds before merging.\n",
  );
  // Shares exactly 2 words with grep-before-edit's trigger (unfamiliar,
  // repository) and exactly 1 with verify-coverage's (coverage): both
  // near misses, triggered from the same context-hook call.
  await hooks.context(contextEvent({ sessionID: "miss-s1", userText: "the unfamiliar repository also needs extra coverage review" }));
  const concurrentLines = (await fs.readFile(missLogPath, "utf8")).split("\n").filter((line) => line.trim().length > 0);
  assert.equal(concurrentLines.length, 2, "both near misses from the same request are logged, neither lost to a write race");
  assert.ok(concurrentLines.some((line) => line.includes("id=grep-before-edit") && line.includes("count=2")));
  assert.ok(concurrentLines.some((line) => line.includes("id=verify-coverage") && line.includes("count=1")));
}

// ---------------------------------------------------------------------------
// 13b. lib/evolve-preview.js: buildEvolveClusters groups personal
//      instincts the same way lib/maintain.js's evolveStep does (domain,
//      then significant-word overlap), and additionally computes each
//      cluster's average confidence, a deterministic "why" (the words
//      every member's own text actually shares), and a size-based
//      suggested form (rule < command < skill); formatEvolvePreview then
//      renders the top N (0 = no cap), always ending with the --generate
//      hint, and reads as "no clusters yet" when none qualify.
// ---------------------------------------------------------------------------
{
  const { buildEvolveClusters, formatEvolvePreview } = await import("./lib/evolve-preview.js");

  const evolvePreviewRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "evolve-preview-"));
  const evolvePreviewProject = {
    project_dir: evolvePreviewRoot,
    instincts_personal: path.join(evolvePreviewRoot, "instincts", "personal"),
    evolved_dir: path.join(evolvePreviewRoot, "evolved"),
  };
  await fs.mkdir(evolvePreviewProject.instincts_personal, { recursive: true });

  // 5-member "workflow" cluster: every trigger shares the same
  // significant words (only the trailing index digit differs, and digits
  // alone never clear MIN_WORD_LEN), so clusterItems groups all 5
  // together. 5 members sits above the "rule" cutoff and at or below the
  // "command" cutoff, so it should suggest "command".
  for (let i = 0; i < 5; i++) {
    await writeInstinct(
      evolvePreviewProject.instincts_personal,
      {
        id: `workflow-habit-${i}`,
        trigger: `always check the shared repository configuration before merging branch ${i}`,
        confidence: 0.6 + i * 0.05, // 0.6, 0.65, 0.7, 0.75, 0.8: average 0.7
        domain: "workflow",
        summary: `Check the shared repository configuration ${i}.`,
        created: new Date().toISOString(),
      },
      `# Workflow ${i}\n`,
    );
  }

  // 3-member "testing" cluster: at or below the "rule" cutoff, so it
  // should suggest "rule" instead.
  for (let i = 0; i < 3; i++) {
    await writeInstinct(
      evolvePreviewProject.instincts_personal,
      {
        id: `testing-habit-${i}`,
        trigger: `always verify coverage thresholds before merging pull request ${i}`,
        confidence: 0.9,
        domain: "testing",
        summary: `Verify coverage thresholds ${i}.`,
        created: new Date().toISOString(),
      },
      `# Testing ${i}\n`,
    );
  }

  const clusters = await buildEvolveClusters(evolvePreviewProject);
  assert.equal(clusters.length, 2, "two domains, each forming exactly one qualifying cluster");

  assert.equal(clusters[0].domain, "workflow", "the bigger cluster (5 members) sorts first");
  assert.equal(clusters[0].size, 5);
  assert.deepEqual(clusters[0].memberIds, ["workflow-habit-0", "workflow-habit-1", "workflow-habit-2", "workflow-habit-3", "workflow-habit-4"]);
  assert.equal(clusters[0].avgConfidence, 0.7, "average of 0.6/0.65/0.7/0.75/0.8");
  assert.equal(clusters[0].form, "command", "5 members: above the rule cutoff, at or below the command cutoff");
  assert.equal(clusters[0].why, "always, branch, check, configuration", "top 4 words every member shares, alphabetical among ties");

  assert.equal(clusters[1].domain, "testing");
  assert.equal(clusters[1].size, 3);
  assert.equal(clusters[1].form, "rule", "3 members: at or below the rule cutoff");
  assert.equal(clusters[1].why, "always, coverage, merging, request");

  const limited = formatEvolvePreview(clusters, { limit: 1 });
  assert.ok(limited.startsWith("1 of 2 cluster(s) found:"), "the header's own total still counts every qualifying cluster, even when limit trims the list shown");
  assert.ok(!limited.includes("testing-habit-0"), "the second cluster's members are not shown when limit=1");
  assert.ok(limited.endsWith("Run /evolve --generate to write these as candidate structures under evolved/."), "the preview always ends with the --generate hint");

  const unlimited = formatEvolvePreview(clusters, { limit: 0 });
  assert.ok(unlimited.includes("workflow-habit-0") && unlimited.includes("testing-habit-0"), "limit 0 shows every qualifying cluster");

  const defaulted = formatEvolvePreview(clusters);
  assert.ok(defaulted.startsWith("2 of 2 cluster(s) found:"), "with only 2 qualifying clusters, the default limit (3) shows both");

  const empty = formatEvolvePreview([], {});
  assert.ok(empty.includes("No instinct clusters found yet"), "no qualifying clusters at all reads as a plain 'nothing yet' message");
  assert.ok(!/[\u2014\u2013]/.test(empty) && !/[\u2014\u2013]/.test(unlimited), "the evolve preview text never contains an em or en dash");
}

// ---------------------------------------------------------------------------
// 13c. lib/inject.js's per-turn dedupe and child-session skip (both fix
//      inflated `fired` counts): the "context" hook fires once per
//      request, so the same latest user message repeated across several
//      requests in one turn (tool-call steps) must only bump `fired`
//      once; a different latest user message bumps it again; a child
//      session (session.get resolves a parentID) is still injected into
//      but never bumps `fired`; and a session.get that throws is treated
//      as top-level (fired still bumps) rather than silently suppressed.
// ---------------------------------------------------------------------------
{
  const { registerInject } = await import("./lib/inject.js");

  function makeInjectHarness(projectDir, sessionGet) {
    const hooks = {};
    const ctx = {
      location: { directory: projectDir },
      session: {
        hook: async (name, cb) => {
          hooks[name] = cb;
          return { dispose: async () => {} };
        },
        ...(sessionGet ? { get: sessionGet } : {}),
      },
    };
    return { ctx, hooks };
  }

  // --- same sessionID, same latest user text, twice: fired bumps once ---
  {
    const { projectDir, dataDir } = makeProjectAndData("inject-dedupe-same");
    const options = { python: "python3", dataDir, inject: { enabled: true, max: 5, minConfidence: 0.8 } };
    const { ctx, hooks } = makeInjectHarness(projectDir);

    const project = await resolveProject(ctx, options);
    await writeInstinct(
      project.instincts_personal,
      { id: "grep-before-edit", trigger: "grep unfamiliar repository before editing", confidence: 0.9, domain: "workflow" },
      "# Grep Before Edit\n\n## Action\nSearch the repository with grep before editing unfamiliar files.\n",
    );

    await registerInject(ctx, options);
    const text = "please grep this unfamiliar repository before editing anything";

    await hooks.context(contextEvent({ sessionID: "turn-s1", userText: text }));
    await hooks.context(contextEvent({ sessionID: "turn-s1", userText: text }));

    const content = await fs.readFile(path.join(project.instincts_personal, "grep-before-edit.md"), "utf8");
    assert.ok(/fired:\s*1/.test(content), "two requests carrying the same latest user message (simulating tool-call steps within one turn) bump fired exactly once, not twice");

    const activity = JSON.parse(await fs.readFile(path.join(project.project_dir, ".activity.json"), "utf8"));
    assert.equal(activity.appliedToday, 2, "injection itself still runs on every request: both requests counted in appliedToday");
    assert.equal(activity.firedToday, 1, "firedToday only counts the first of the two identical-text requests");
  }

  // --- same sessionID, a different latest user text: fired bumps again ---
  {
    const { projectDir, dataDir } = makeProjectAndData("inject-dedupe-diff");
    const options = { python: "python3", dataDir, inject: { enabled: true, max: 5, minConfidence: 0.8 } };
    const { ctx, hooks } = makeInjectHarness(projectDir);

    const project = await resolveProject(ctx, options);
    await writeInstinct(
      project.instincts_personal,
      { id: "grep-before-edit", trigger: "grep unfamiliar repository before editing", confidence: 0.9, domain: "workflow" },
      "# Grep Before Edit\n\n## Action\nSearch the repository with grep before editing unfamiliar files.\n",
    );

    await registerInject(ctx, options);

    await hooks.context(contextEvent({ sessionID: "turn-s2", userText: "please grep this unfamiliar repository before editing anything" }));
    await hooks.context(contextEvent({ sessionID: "turn-s2", userText: "grep the unfamiliar repository before editing again, differently" }));

    const content = await fs.readFile(path.join(project.instincts_personal, "grep-before-edit.md"), "utf8");
    assert.ok(/fired:\s*2/.test(content), "a genuinely new prompt (different latest user text) in the same session bumps fired again, for a total of 2");
  }

  // --- child session: still injected, never bumps fired ---
  {
    const { projectDir, dataDir } = makeProjectAndData("inject-child");
    const options = { python: "python3", dataDir, inject: { enabled: true, max: 5, minConfidence: 0.8 } };
    const sessionGet = async ({ sessionID }) => ({ data: { id: sessionID, parentID: "ses_parent" } });
    const { ctx, hooks } = makeInjectHarness(projectDir, sessionGet);

    const project = await resolveProject(ctx, options);
    await writeInstinct(
      project.instincts_personal,
      { id: "grep-before-edit", trigger: "grep unfamiliar repository before editing", confidence: 0.9, domain: "workflow" },
      "# Grep Before Edit\n\n## Action\nSearch the repository with grep before editing unfamiliar files.\n",
    );

    await registerInject(ctx, options);
    const event = contextEvent({ sessionID: "child-s1", userText: "please grep this unfamiliar repository before editing anything" });
    await hooks.context(event);

    assert.equal(event.system.length, 1, "a child session's request still receives the injected block");
    assert.ok(event.system[0].text.includes("Search the repository with grep before editing unfamiliar files."), "the injected block carries the qualifying instinct even for a child session");

    const content = await fs.readFile(path.join(project.instincts_personal, "grep-before-edit.md"), "utf8");
    assert.ok(!/fired:/.test(content), "a child session (session.get resolves a parentID) never bumps fired, even on a wording match");

    const activity = JSON.parse(await fs.readFile(path.join(project.project_dir, ".activity.json"), "utf8"));
    assert.equal(activity.appliedToday, 1, "appliedToday still counts the child session's injection");
    assert.equal(Number(activity.firedToday) || 0, 0, "firedToday stays 0 for a child session");
  }

  // --- session.get throws: treated as top-level, fired still bumps ---
  {
    const { projectDir, dataDir } = makeProjectAndData("inject-session-get-throws");
    const options = { python: "python3", dataDir, inject: { enabled: true, max: 5, minConfidence: 0.8 } };
    const sessionGet = async () => {
      throw new Error("session lookup unavailable");
    };
    const { ctx, hooks } = makeInjectHarness(projectDir, sessionGet);

    const project = await resolveProject(ctx, options);
    await writeInstinct(
      project.instincts_personal,
      { id: "grep-before-edit", trigger: "grep unfamiliar repository before editing", confidence: 0.9, domain: "workflow" },
      "# Grep Before Edit\n\n## Action\nSearch the repository with grep before editing unfamiliar files.\n",
    );

    await registerInject(ctx, options);
    await hooks.context(contextEvent({ sessionID: "throws-s1", userText: "please grep this unfamiliar repository before editing anything" }));

    const content = await fs.readFile(path.join(project.instincts_personal, "grep-before-edit.md"), "utf8");
    assert.ok(/fired:\s*1/.test(content), "a session.get that throws is treated as top-level (not a child), so fired still bumps");
  }

  // --- fired-miss log: a repeated request never appends a second miss line ---
  {
    const { projectDir, dataDir } = makeProjectAndData("inject-dedupe-miss-log");
    const options = { python: "python3", dataDir, inject: { enabled: true, max: 5, minConfidence: 0.8 } };
    const { ctx, hooks } = makeInjectHarness(projectDir);

    const project = await resolveProject(ctx, options);
    await writeInstinct(
      project.instincts_personal,
      { id: "grep-before-edit", trigger: "grep unfamiliar repository before editing", confidence: 0.9, domain: "workflow" },
      "# Grep Before Edit\n\n## Action\nSearch the repository with grep before editing unfamiliar files.\n",
    );

    await registerInject(ctx, options);
    // Shares exactly 2 significant words (unfamiliar, repository): a near
    // miss, logged to fired-misses.log instead of bumping fired.
    const nearMissText = "the unfamiliar repository needs cleanup";
    await hooks.context(contextEvent({ sessionID: "turn-miss-1", userText: nearMissText }));
    await hooks.context(contextEvent({ sessionID: "turn-miss-1", userText: nearMissText }));

    const missLogPath = path.join(project.project_dir, "fired-misses.log");
    const missLines = (await fs.readFile(missLogPath, "utf8")).split("\n").filter((line) => line.trim().length > 0);
    assert.equal(missLines.length, 1, "a repeated request carrying the same near-miss text never appends a second miss line");
  }
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

  // --- promote: second qualification path (0.8.2) - confidence >= 0.9
  //     and fired >= 3 in a single project, no cross-project
  //     corroboration needed at all ---------------------------------------
  const provenHome = path.join(maintRoot, "homunculus-proven");
  const provenPersonal = path.join(provenHome, "projects", "proj-solo", "instincts", "personal");
  await fs.mkdir(provenPersonal, { recursive: true });
  await writeInstinct(
    provenPersonal,
    { id: "proven-on-its-own", trigger: "always run the full build before tagging a release", confidence: 0.95, domain: "release", summary: "Run the full build before tagging a release.", fired: 4, created: new Date().toISOString() },
    "# Proven\n\n## Action\nRun the full build.\n",
  );
  // Confident enough for the cross-project path's own floor (>= 0.8) but
  // not proven enough for path 2 (fired < 3): never promoted by either path.
  await writeInstinct(
    provenPersonal,
    { id: "confident-but-unused", trigger: "unrelated pattern nobody has actually used yet", confidence: 0.85, domain: "misc", summary: "Do the unrelated thing.", fired: 0, created: new Date().toISOString() },
    "# Confident but unused\n",
  );
  const provenOptions = { dataDir: provenHome };
  const provenLog = [];
  const provenPromoted = await promoteStep(provenOptions, { log: (line) => provenLog.push(line) });
  assert.equal(provenPromoted, 1, "exactly one instinct promotes: confidence >= 0.9 and fired >= 3, alone in its own project");
  const provenGlobalDir = path.join(provenHome, "instincts", "personal");
  assert.deepEqual(await fs.readdir(provenGlobalDir), ["proven-on-its-own.md"], "only the proven-on-its-own instinct is copied to the global store");
  const provenGlobalContent = await fs.readFile(path.join(provenGlobalDir, "proven-on-its-own.md"), "utf8");
  assert.ok(provenGlobalContent.includes("scope: global"));
  assert.ok(
    provenLog.some((line) => line.includes("promote: copied proven-on-its-own to global store (confidence 0.95 >= 0.9 and fired 4 >= 3 in")),
    "the log records which path qualified (confidence+fired, not cross-project corroboration)",
  );

  const secondProvenPromote = await promoteStep(provenOptions, { log: () => {} });
  assert.equal(secondProvenPromote, 0, "already-global instinct is never promoted a second time via either path");

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

  // --- dedupe: trigger/summary overlap is compared per-field (not
  //     concatenated), with a same-domain bonus that lowers the bar from
  //     60% to 45% on either field --------------------------------------
  const domainBonusDir = path.join(maintRoot, "proj-dedupe-domain", "instincts", "personal");
  await fs.mkdir(domainBonusDir, { recursive: true });
  await writeInstinct(domainBonusDir, { id: "zeta-existing", trigger: "zephyr quartz falcon meadow cobalt lumen", confidence: 0.6, domain: "alpha-domain" }, "# Zeta\n");
  const domainBonusLog = [];
  const mergedSameDomain = await dedupeOrMerge(
    domainBonusDir,
    { id: "zeta-same-domain", trigger: "zephyr quartz falcon basalt tundra canyon", confidence: 0.5, domain: "alpha-domain" },
    "# Same domain\n",
    { log: (line) => domainBonusLog.push(line) },
  );
  assert.equal(mergedSameDomain, true, "50% trigger overlap alone would not qualify (< 60%), but the same-domain bonus (>= 45%) does");
  assert.deepEqual(await fs.readdir(domainBonusDir), ["zeta-existing.md"], "merged into the existing file; no second file written");
  assert.ok(domainBonusLog.some((line) => line.includes("dedupe: merged zeta-same-domain into zeta-existing")));

  const diffDomainDir = path.join(maintRoot, "proj-dedupe-domain-diff", "instincts", "personal");
  await fs.mkdir(diffDomainDir, { recursive: true });
  await writeInstinct(diffDomainDir, { id: "zeta-existing-2", trigger: "zephyr quartz falcon meadow cobalt lumen", confidence: 0.6, domain: "alpha-domain" }, "# Zeta 2\n");
  const notMergedDiffDomain = await dedupeOrMerge(
    diffDomainDir,
    { id: "zeta-diff-domain", trigger: "zephyr quartz falcon basalt tundra canyon", confidence: 0.5, domain: "beta-domain" },
    "# Diff domain\n",
    { log: () => {} },
  );
  assert.equal(notMergedDiffDomain, false, "the same 50% overlap does not qualify without a shared domain (below the plain 60% threshold)");
  assert.deepEqual(await fs.readdir(diffDomainDir), ["zeta-existing-2.md"], "dedupeOrMerge never writes anything itself when no merge target is found");

  // --- dedupe: three related smoke-test habits, processed in sequence
  //     the way lib/observer.js's write path would, all merge into one
  //     file -----------------------------------------------------------
  const smokeDedupeDir = path.join(maintRoot, "proj-dedupe-smoke", "instincts", "personal");
  await fs.mkdir(smokeDedupeDir, { recursive: true });
  await writeInstinct(
    smokeDedupeDir,
    {
      id: "rerun-smoke-test-after-each-edit-batch",
      trigger: "rerun the smoke test suite after editing each batch of files",
      confidence: 0.6,
      domain: "testing",
      summary: "Rerun the smoke test suite after each edit batch.",
      created: new Date().toISOString(),
    },
    "# Rerun after each batch\n",
  );
  const smokeDedupeLog = [];
  const mergedFlakeCheck = await dedupeOrMerge(
    smokeDedupeDir,
    {
      id: "smoke-test-flake-check-load-then-rerun",
      trigger: "rerun the smoke test suite to check for flaky results",
      confidence: 0.65,
      domain: "testing",
      summary: "Rerun the smoke test suite to check for flaky results.",
    },
    "# Flake check\n",
    { log: (line) => smokeDedupeLog.push(line) },
  );
  assert.equal(mergedFlakeCheck, true, "smoke-test-flake-check-load-then-rerun merges into the existing rerun-smoke-test-after-each-edit-batch file");
  const mergedRunUnderNodeAndBun = await dedupeOrMerge(
    smokeDedupeDir,
    {
      id: "smoke-test-run-under-node-and-bun",
      trigger: "rerun the smoke test suite under both node and bun runtimes",
      confidence: 0.7,
      domain: "testing",
      summary: "Rerun the smoke test suite under node and bun.",
    },
    "# Run under node and bun\n",
    { log: (line) => smokeDedupeLog.push(line) },
  );
  assert.equal(mergedRunUnderNodeAndBun, true, "smoke-test-run-under-node-and-bun also merges into the same file");
  assert.deepEqual(
    await fs.readdir(smokeDedupeDir),
    ["rerun-smoke-test-after-each-edit-batch.md"],
    "all three smoke-test habits end up as exactly one file, never three",
  );
  assert.ok(smokeDedupeLog.some((line) => line.includes("dedupe: merged smoke-test-flake-check-load-then-rerun into rerun-smoke-test-after-each-edit-batch")));
  assert.ok(smokeDedupeLog.some((line) => line.includes("dedupe: merged smoke-test-run-under-node-and-bun into rerun-smoke-test-after-each-edit-batch")));

  // --- evolve: three overlapping testing-domain instincts propose one
  //     rule candidate (<= 3 members); re-running leaves it alone, and
  //     archiving it blocks the same cluster from ever coming back ------
  const evolveProject = {
    project_dir: path.join(maintRoot, "proj-evolve"),
    root: path.join(maintRoot, "proj-evolve"),
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
  assert.ok(evolvedContent.includes("kind: rule"), "3 members (at or below the rule cutoff) proposes a rule candidate");
  assert.ok(evolvedContent.includes("status: proposed"));
  assert.ok(evolvedContent.includes("suggested_name: testing"));
  assert.ok(evolveLog.some((line) => line.includes("evolve: wrote cluster")));

  const evolveLog2 = [];
  const second = await evolveStep(evolveProject, { log: (line) => evolveLog2.push(line) });
  assert.equal(second.candidates, 0, "re-running evolve against the exact same instincts proposes nothing new");
  assert.equal((await fs.readdir(evolveProject.evolved_dir)).length, 1, "still exactly one candidate file, never duplicated");
  assert.ok(evolveLog2.some((line) => line.includes("evolve: checked, no new clusters")));

  const [proposedCandidate] = await loadCandidates(evolveProject.evolved_dir);
  await writeCandidate(evolveProject.evolved_dir, { ...proposedCandidate.fields, status: "archived", reason: "test" }, proposedCandidate.body);
  const evolveLog3 = [];
  const third = await evolveStep(evolveProject, { log: (line) => evolveLog3.push(line) });
  assert.equal(third.candidates, 0, "an archived candidate blocks its own cluster from ever being re-proposed");
  assert.ok(evolveLog3.some((line) => line.includes("evolve: skipped cluster")));
  assert.equal((await fs.readdir(evolveProject.evolved_dir)).length, 1, "still only the one, now-archived, candidate file");

  // --- classifyNewInstinct: the "50% rule" (0.8.2: confidence <= 0.5
  //     always goes to pending, regardless of an Evidence section; only
  //     an instinct that has already fired is exempt) -------------------
  assert.equal(classifyNewInstinct({ confidence: 0.5 }), "pending", "confidence <= 0.5 goes to pending");
  assert.equal(classifyNewInstinct({ confidence: 0.3 }), "pending", "well below 0.5 goes to pending too, not just exactly 0.5");
  assert.equal(classifyNewInstinct({ confidence: 0.5 }, 0), "pending", "an Evidence section no longer exempts a <= 0.5 instinct from the pending rule");
  assert.equal(classifyNewInstinct({ confidence: 0.5 }, 2), "personal", "already fired at least once (existingFired > 0): never demoted back to pending");
  assert.equal(classifyNewInstinct({ confidence: 0.51 }), "personal", "anything above 0.5 confidence is never routed to pending");

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

  // --- repairStep: a leaked trailing frontmatter fragment in the trigger,
  //     plus (0.8.2) a personal instinct that never should have landed
  //     there under the current 50% rule (confidence <= 0.5, never fired)
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
  await writeInstinct(
    repairProject.instincts_personal,
    { id: "stale-unproven", trigger: "t", confidence: 0.4, domain: "misc", summary: "s", created: new Date().toISOString() },
    "# Stale unproven\n",
  );
  await writeInstinct(
    repairProject.instincts_personal,
    { id: "proven-despite-low-confidence", trigger: "t", confidence: 0.3, domain: "misc", summary: "s", created: new Date().toISOString(), fired: 5 },
    "# Proven despite low confidence\n",
  );
  const repairLog = [];
  const repaired = await repairStep(repairProject, { log: (line) => repairLog.push(line) });
  assert.equal(repaired, 2, "the leaky trigger and the misclassified instinct both count; the already-fired one is left alone");
  const repairedContent = await fs.readFile(path.join(repairProject.instincts_personal, "leaky-trigger.md"), "utf8");
  assert.ok(repairedContent.includes('trigger: "grep before editing unfamiliar files"'), "the trigger is cleaned back to just the real trigger text");
  assert.ok(!repairedContent.includes("files, confidence"), "the leaked trailing fragment is gone");
  assert.ok(repairLog.some((line) => line.includes("repair: cleaned trigger of leaky-trigger")));

  const repairPendingDir = siblingInstinctsDir(repairProject, "pending");
  assert.deepEqual(await fs.readdir(repairPendingDir), ["stale-unproven.md"], "the misclassified instinct is moved to pending/, not deleted");
  assert.deepEqual(
    (await fs.readdir(repairProject.instincts_personal)).sort(),
    ["leaky-trigger.md", "proven-despite-low-confidence.md"].sort(),
    "the misclassified instinct is gone from personal/; the already-fired low-confidence one stays",
  );
  assert.ok(repairLog.some((line) => line.includes("repair: moved stale-unproven to pending (confidence <= 0.5, never fired)")));

  const secondRepair = await repairStep(repairProject, { log: () => {} });
  assert.equal(secondRepair, 0, "repairStep is idempotent: a clean trigger never matches the leaked-suffix pattern again, and the misclassified instinct is already gone from personal/");
}

// ---------------------------------------------------------------------------
// 14a. lib/maintain.js's cleanupProjectsStep (0.8.2): for every entry in
//      ECC's own projects registry (`<homunculus>/projects.json`) whose
//      root no longer exists, or lives under a temp directory, AND which
//      has 0 instincts, the entry is removed and its project directory
//      archived (never deleted outright) under `archive/projects/<id>/`.
//      A project kept resident outside any temp directory, and a
//      temp-rooted project that still has instincts, are both left alone.
// ---------------------------------------------------------------------------
{
  const cleanupHome = fsSync.mkdtempSync(path.join(TEMP_ROOT, "cleanup-projects-"));
  const projectsRoot = path.join(cleanupHome, "projects");
  const registryFile = path.join(cleanupHome, "projects.json");

  const vanishedRoot = path.join(cleanupHome, "vanished-project-root"); // never created: "gone"
  const tempWithInstinctsRoot = path.join(TEMP_ROOT, "cleanup-temp-with-instincts");
  const tempZeroInstinctsRoot = path.join(TEMP_ROOT, "cleanup-temp-zero-instincts");
  await fs.mkdir(tempWithInstinctsRoot, { recursive: true });
  await fs.mkdir(tempZeroInstinctsRoot, { recursive: true });

  const now = new Date().toISOString();
  const registry = {
    "keep-resident": { id: "keep-resident", name: "resident-kept", root: os.homedir(), remote: "", created_at: now, last_seen: now },
    "gone-root": { id: "gone-root", name: "vanished-gone", root: vanishedRoot, remote: "", created_at: now, last_seen: now },
    "temp-with-instincts": { id: "temp-with-instincts", name: "temp-but-used", root: tempWithInstinctsRoot, remote: "", created_at: now, last_seen: now },
    "temp-zero-instincts": { id: "temp-zero-instincts", name: "temp-and-unused", root: tempZeroInstinctsRoot, remote: "", created_at: now, last_seen: now },
  };
  await fs.mkdir(cleanupHome, { recursive: true });
  await fs.writeFile(registryFile, JSON.stringify(registry, null, 2), "utf8");

  // Every registered project gets a real project directory on disk, with
  // a marker file so an archived one can be proven to still hold its
  // real content (never deleted) after the move.
  for (const id of Object.keys(registry)) {
    const projectDir = path.join(projectsRoot, id);
    await fs.mkdir(path.join(projectDir, "instincts", "personal"), { recursive: true });
    await fs.writeFile(path.join(projectDir, "marker.txt"), id, "utf8");
  }
  // temp-with-instincts has an actual instinct on record, so cleanup must
  // leave it alone despite its root being under a temp directory.
  await writeInstinct(
    path.join(projectsRoot, "temp-with-instincts", "instincts", "personal"),
    { id: "still-used", trigger: "t", confidence: 0.6, domain: "misc", summary: "s" },
    "# Still used\n",
  );

  const cleanupLog = [];
  const cleaned = await cleanupProjectsStep({ dataDir: cleanupHome }, { log: (line) => cleanupLog.push(line) });
  assert.equal(cleaned, 2, "gone-root (root missing) and temp-zero-instincts (root under temp, 0 instincts) are both cleaned");

  const registryAfter = JSON.parse(await fs.readFile(registryFile, "utf8"));
  assert.deepEqual(Object.keys(registryAfter).sort(), ["keep-resident", "temp-with-instincts"], "only the two legitimately-kept entries remain in the registry");

  assert.ok(!(await fs.access(path.join(projectsRoot, "gone-root")).then(() => true, () => false)), "gone-root's project dir is gone from projects/");
  assert.ok(!(await fs.access(path.join(projectsRoot, "temp-zero-instincts")).then(() => true, () => false)), "temp-zero-instincts's project dir is gone from projects/");
  assert.ok(await fs.access(path.join(projectsRoot, "keep-resident")).then(() => true, () => false), "keep-resident's project dir is untouched");
  assert.ok(await fs.access(path.join(projectsRoot, "temp-with-instincts")).then(() => true, () => false), "temp-with-instincts's project dir is untouched (it still has an instinct)");

  const archivedGoneMarker = await fs.readFile(path.join(cleanupHome, "archive", "projects", "gone-root", "marker.txt"), "utf8");
  assert.equal(archivedGoneMarker, "gone-root", "the archived project dir's real content survives the move (archived, never deleted)");
  const archivedTempMarker = await fs.readFile(path.join(cleanupHome, "archive", "projects", "temp-zero-instincts", "marker.txt"), "utf8");
  assert.equal(archivedTempMarker, "temp-zero-instincts");

  assert.ok(cleanupLog.some((line) => line.includes("cleanup: archived project vanished-gone [gone-root] (root no longer exists, 0 instincts)")));
  assert.ok(cleanupLog.some((line) => line.includes("cleanup: archived project temp-and-unused [temp-zero-instincts] (root lives under a temp directory, 0 instincts)")));

  const secondCleanup = await cleanupProjectsStep({ dataDir: cleanupHome }, { log: (line) => cleanupLog.push(line) });
  assert.equal(secondCleanup, 0, "idempotent: nothing left to clean on a second pass");
  assert.ok(cleanupLog.some((line) => line.includes("cleanup: checked, nothing to remove")));

  // --- dryRun: logs what it would do, changes nothing on disk ----------
  const dryHome = fsSync.mkdtempSync(path.join(TEMP_ROOT, "cleanup-projects-dry-"));
  const dryRegistryFile = path.join(dryHome, "projects.json");
  const dryVanishedRoot = path.join(dryHome, "vanished");
  await fs.mkdir(path.join(dryHome, "projects", "dry-gone", "instincts", "personal"), { recursive: true });
  await fs.writeFile(dryRegistryFile, JSON.stringify({ "dry-gone": { id: "dry-gone", name: "dry-gone", root: dryVanishedRoot, remote: "", created_at: now, last_seen: now } }), "utf8");
  const dryLog = [];
  const dryCleaned = await cleanupProjectsStep({ dataDir: dryHome }, { dryRun: true, log: (line) => dryLog.push(line) });
  assert.equal(dryCleaned, 0, "dry run never reports anything actually cleaned");
  assert.ok(dryLog.some((line) => line.includes("cleanup: would archive project dry-gone [dry-gone]")));
  assert.ok(await fs.access(path.join(dryHome, "projects", "dry-gone")).then(() => true, () => false), "dry run never moves or deletes anything");
  const dryRegistryAfter = JSON.parse(await fs.readFile(dryRegistryFile, "utf8"));
  assert.ok(Object.hasOwn(dryRegistryAfter, "dry-gone"), "dry run never rewrites the registry");
}

// ---------------------------------------------------------------------------
// 14b. lib/maintain.js's runMaintenance wiring for cleanupProjects: the
//      sweep's own "run: ..., cleaned N" summary line and
//      readMaintenanceSummary's lastCleanupAt/counts7d.cleaned both come
//      from the exact same cleanupProjectsStep this plugin's own daily
//      gate reads back.
// ---------------------------------------------------------------------------
{
  const runRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "cleanup-run-maintenance-"));
  const runHome = path.join(runRoot, "homunculus");
  const runProject = { project_dir: path.join(runRoot, "project"), root: path.join(runRoot, "project"), id: "run-proj", instincts_personal: path.join(runRoot, "project", "instincts", "personal"), evolved_dir: path.join(runRoot, "project", "evolved") };
  await fs.mkdir(runProject.instincts_personal, { recursive: true });

  const staleRoot = path.join(TEMP_ROOT, "cleanup-run-maintenance-stale-root");
  await fs.mkdir(staleRoot, { recursive: true });
  await fs.mkdir(path.join(runHome, "projects", "stale-under-temp", "instincts", "personal"), { recursive: true });
  const now = new Date().toISOString();
  await fs.mkdir(runHome, { recursive: true });
  await fs.writeFile(path.join(runHome, "projects.json"), JSON.stringify({ "stale-under-temp": { id: "stale-under-temp", name: "stale", root: staleRoot, remote: "", created_at: now, last_seen: now } }), "utf8");

  const counts = await runMaintenance({ dataDir: runHome }, runProject, { ...MAINTENANCE_DEFAULTS, promote: false, prune: false, decay: false, dedupe: false, evolve: false, repair: false });
  assert.equal(counts.cleaned, 1, "runMaintenance's own counts include cleanupProjects' result");

  const logContent = await fs.readFile(path.join(runProject.project_dir, "maintenance.log"), "utf8");
  assert.ok(/run: promoted 0, archived 0, merged 0, pruned 0, candidates 0, repaired 0, cleaned 1/.test(logContent), `run summary line carries 'cleaned 1': ${logContent}`);

  const { readMaintenanceSummary } = await import("./lib/maintain.js");
  const summary = await readMaintenanceSummary(runProject);
  assert.ok(typeof summary.lastCleanupAt === "string" && !Number.isNaN(Date.parse(summary.lastCleanupAt)), "lastCleanupAt is tracked for the daily gate");
  assert.equal(summary.counts7d.cleaned, 1, "the 7-day rollup counts the cleaned project too");
}

// ---------------------------------------------------------------------------
// 15. lib/candidates.js's selectCandidateKind, exercised through evolveStep
//     against four domains: 4 members with run/check-verb summaries (->
//     command), 4 members without (-> skill), 6 members (-> skill
//     regardless of content), and 3 members mentioning delegation to a
//     specialist subagent (-> agent, overriding the <= 3 "rule" default).
//     Also covers the "update members in place" half of the no-duplicate
//     rule: growing the command cluster by one still-overlapping member
//     and re-running evolve updates that same candidate's members list
//     instead of writing a second file for it.
// ---------------------------------------------------------------------------
{
  const kindRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "evolve-kind-"));
  const kindProject = {
    project_dir: kindRoot,
    root: kindRoot,
    instincts_personal: path.join(kindRoot, "instincts", "personal"),
    evolved_dir: path.join(kindRoot, "evolved"),
  };
  await fs.mkdir(kindProject.instincts_personal, { recursive: true });

  async function seed(domain, count, { trigger, summary }) {
    for (let i = 0; i < count; i++) {
      await writeInstinct(
        kindProject.instincts_personal,
        {
          id: `${domain}-habit-${i}`,
          trigger: `${trigger} ${i}`,
          confidence: 0.6,
          domain,
          summary: `${summary} ${i}.`,
          created: new Date().toISOString(),
        },
        `# ${domain} ${i}\n`,
      );
    }
  }

  await seed("automation", 4, { trigger: "run the full linter and type checker before every commit", summary: "Run the linter and type checker before committing" });
  await seed("docs", 4, { trigger: "write clear documentation comments for every public function", summary: "Write clear documentation comments for public functions" });
  await seed("release", 6, { trigger: "tag a new release and update the changelog entry number", summary: "Tag a new release and update the changelog" });
  await seed("handoff", 3, { trigger: "delegate the heavy lifting to a specialist subagent for task", summary: "Delegate complex work to a specialist subagent" });

  await evolveStep(kindProject, { log: () => {} });
  const kindCandidates = await loadCandidates(kindProject.evolved_dir);
  assert.equal(kindCandidates.length, 4, "one candidate per domain");

  const byDomain = (prefix) => kindCandidates.find((c) => c.fields.members[0]?.startsWith(prefix));
  assert.equal(byDomain("automation-").fields.kind, "command", "4 members, summaries read as run/check steps -> command");
  assert.equal(byDomain("docs-").fields.kind, "skill", "4 members, no run/check verbs in the summaries -> skill");
  assert.equal(byDomain("release-").fields.kind, "skill", "6 members is always a skill, regardless of content");
  assert.equal(byDomain("handoff-").fields.kind, "agent", "delegation/specialist language overrides the <= 3 'rule' default");

  // Directly exercises selectCandidateKind with the same four shapes, so
  // the unit itself (not just evolveStep's end-to-end wiring) is pinned.
  const fakeMember = (id, summary) => ({ fields: { id, trigger: summary, summary } });
  assert.equal(selectCandidateKind([fakeMember("a", "Run the tests."), fakeMember("b", "Run the tests."), fakeMember("c", "Run the tests."), fakeMember("d", "Run the tests.")]), "command");
  assert.equal(selectCandidateKind([fakeMember("a", "Write docs."), fakeMember("b", "Write docs."), fakeMember("c", "Write docs."), fakeMember("d", "Write docs.")]), "skill");
  assert.equal(selectCandidateKind(Array.from({ length: 6 }, (_, i) => fakeMember(`x${i}`, "Write docs."))), "skill");
  assert.equal(selectCandidateKind([fakeMember("a", "Write docs.")]), "rule", "a single member with no delegation language is a rule");
  assert.equal(selectCandidateKind([fakeMember("a", "Hand this off to a specialist.")]), "agent", "delegation language wins even for a single member");

  // --- no-duplicate rule, "update members" half ------------------------
  const automationId = byDomain("automation-").fields.id;
  await seed("automation", 1, { trigger: "run the full linter and type checker before every commit", summary: "Run the linter and type checker before committing" });
  // The new member reuses index 0 as well (seed always starts at i=0), so
  // give it a distinct id by writing it directly instead of through seed().
  await writeInstinct(
    kindProject.instincts_personal,
    { id: "automation-habit-4", trigger: "run the full linter and type checker before every commit 4", confidence: 0.6, domain: "automation", summary: "Run the linter and type checker before committing 4.", created: new Date().toISOString() },
    "# automation 4\n",
  );
  const updateLog = [];
  const updateResult = await evolveStep(kindProject, { log: (line) => updateLog.push(line) });
  assert.equal(updateResult.candidates, 0, "growing an existing cluster never proposes a brand new candidate");
  const afterUpdate = await loadCandidates(kindProject.evolved_dir);
  assert.equal(afterUpdate.length, 4, "still exactly one candidate per domain, none duplicated");
  const updatedAutomation = afterUpdate.find((c) => c.fields.id === automationId);
  assert.equal(updatedAutomation.fields.members.length, 5, "the same candidate's members list grew in place");
  assert.ok(updatedAutomation.fields.members.includes("automation-habit-4"));
  assert.ok(updateLog.some((line) => line.includes(`evolve: updated cluster ${automationId} members (5 members)`)));
}

// ---------------------------------------------------------------------------
// 16. lib/usage.js: bumpUsage increments {count, last} per bucket+key,
//     concurrent bumps for the same key never lose an increment (the
//     same read-modify-write race lib/inject.js's fired-miss log already
//     guards against), readUsage always returns all three buckets even
//     when usage.json does not exist yet, and commandNameFromPromptText
//     parses a slash command's name and ignores everything else.
// ---------------------------------------------------------------------------
{
  const usageRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "usage-"));

  const empty = await readUsage(usageRoot);
  assert.deepEqual(empty, { skills: {}, commands: {}, agents: {} }, "no usage.json yet reads as all-empty, not a throw");

  await bumpUsage(usageRoot, "skills", "pr");
  await bumpUsage(usageRoot, "skills", "pr");
  const afterTwo = await readUsage(usageRoot);
  assert.equal(afterTwo.skills.pr.count, 2);
  assert.ok(typeof afterTwo.skills.pr.last === "string" && !Number.isNaN(Date.parse(afterTwo.skills.pr.last)));

  await Promise.all(Array.from({ length: 10 }, () => bumpUsage(usageRoot, "commands", "evolve-list")));
  const afterConcurrent = await readUsage(usageRoot);
  assert.equal(afterConcurrent.commands["evolve-list"].count, 10, "10 concurrent bumps for the same key never lose an increment");

  assert.equal(commandNameFromPromptText("/evolve-install abc"), "evolve-install");
  assert.equal(commandNameFromPromptText("/board"), "board");
  assert.equal(commandNameFromPromptText("  /evolve-list"), "evolve-list", "leading whitespace before the slash is tolerated");
  assert.equal(commandNameFromPromptText("not a command"), null);
  assert.equal(commandNameFromPromptText(""), null);
  assert.equal(commandNameFromPromptText(undefined), null);
}

// ---------------------------------------------------------------------------
// 17. lib/commands.js's candidate-lifecycle commands, against a temp HOME
//     set through `evolve.targets` (an absolute dir per
//     skill/command/agent, an absolute file for rule): /evolve-install's
//     two-step confirm (preview without --yes installs nothing; --yes
//     installs for every kind, including the AGENTS.md rule append, each
//     carrying candidate_id/project_id/members markers and an
//     installed_hash), /evolve-show and /evolve-list <id> rendering the
//     same detail, refusing to overwrite a hand-written file (even one
//     whose own prose merely mentions the marker text), refusing a file
//     that belongs to a different candidate_id, /evolve-reject archiving
//     a proposed candidate (and refusing to "reject" an installed one),
//     and /evolve-archive removing an installed file only when ownership
//     and content both still match, leaving a hand-edited one in place
//     with a reason instead.
// ---------------------------------------------------------------------------
{
  const { projectDir: cmdProjectDir, dataDir: cmdDataDir } = makeProjectAndData("evolve-commands");
  const tmpHome = fsSync.mkdtempSync(path.join(TEMP_ROOT, "evolve-home-"));
  const targets = {
    skill: path.join(tmpHome, "skills"),
    command: path.join(tmpHome, "commands"),
    agent: path.join(tmpHome, "agents"),
    rule: path.join(tmpHome, "AGENTS.md"),
  };
  const cmdOptions = { python: "python3", dataDir: cmdDataDir, evolve: { targets } };
  const cmdCtx = { location: { directory: cmdProjectDir } };
  const cmdProject = await resolveProject(cmdCtx, cmdOptions);

  const harness = createPluginHarness(cmdProjectDir, cmdOptions);
  await registerCommands(harness.ctx, cmdOptions, { run: async () => {} }, { refresh: async () => null });
  const findCmd = (name) => harness.commandDefs.find((def) => def.name === name);
  const lastReply = () => harness.syntheticCalls.at(-1).text;

  async function seedCandidate(kind, id, suggestedName, members) {
    const cluster = members.map((memberId) => ({ fields: { id: memberId, trigger: `trigger for ${memberId}`, summary: `Do the ${memberId} thing.` } }));
    const body = renderCandidateBody(kind, "testing", cluster, suggestedName);
    await writeCandidate(
      cmdProject.evolved_dir,
      { id, kind, status: "proposed", created: new Date().toISOString(), members, summary: "A test candidate.", suggested_name: suggestedName },
      body,
    );
  }

  // --- /evolve-install without --yes: previews, writes nothing --------
  await seedCandidate("skill", "skillcand1", "my-skill", ["m1", "m2", "m3", "m4"]);
  await findCmd("evolve-install").execute({ sessionID: "s1", prompt: { text: "skillcand1" } });
  const previewReply = lastReply();
  assert.ok(previewReply.includes("kind: skill") && previewReply.includes("--- body ---"), "the preview shows kind and the full drafted body");
  assert.ok(previewReply.includes("Re-run with --yes to install."), "no --yes: stops with the re-run instruction");
  await assert.rejects(fs.access(path.join(targets.skill, "my-skill", "SKILL.md")), "nothing was written without --yes");
  const stillProposed = await findCandidateById(cmdProject.evolved_dir, "skillcand1");
  assert.equal(stillProposed.fields.status, "proposed", "previewing never changes the candidate's own status");

  // /evolve-show renders the identical detail, on demand, without --yes
  // ever being relevant to it (it never appends the install re-run hint).
  await findCmd("evolve-show").execute({ sessionID: "s1", prompt: { text: "skillcand1" } });
  const showReply = lastReply();
  assert.ok(previewReply.startsWith(showReply.slice(0, -4)), "/evolve-install's own preview starts with /evolve-show's exact detail");
  assert.ok(!showReply.includes("Re-run with --yes to install."), "/evolve-show never appends the install re-run hint");

  // /evolve-list <id> renders the same detail too.
  await findCmd("evolve-list").execute({ sessionID: "s1", prompt: { text: "skillcand1" } });
  assert.equal(lastReply(), showReply, "/evolve-list <id> is another alias for the same single-candidate detail");

  // --- /evolve-install --yes: skill, command, agent, and the AGENTS.md rule
  await findCmd("evolve-install").execute({ sessionID: "s1", prompt: { text: "skillcand1 --yes" } });
  assert.ok(lastReply().includes("Restart OpenCode to load it."), "install ends with the restart instruction");
  const skillFile = path.join(targets.skill, "my-skill", "SKILL.md");
  const skillContent = await fs.readFile(skillFile, "utf8");
  assert.ok(skillContent.includes("name: my-skill"));
  assert.ok(skillContent.includes("generated_by: mighty-instincts"));
  assert.ok(skillContent.includes("candidate_id: skillcand1"));
  assert.ok(skillContent.includes(`project_id: ${cmdProject.id}`));
  assert.ok(skillContent.includes("members: [m1, m2, m3, m4]"));
  const skillCandidateAfter = await findCandidateById(cmdProject.evolved_dir, "skillcand1");
  assert.equal(skillCandidateAfter.fields.status, "installed");
  assert.ok(typeof skillCandidateAfter.fields.installed_at === "string");
  assert.equal(skillCandidateAfter.fields.installed_hash, hashContent(skillContent), "installed_hash matches exactly what was written");

  await seedCandidate("command", "cmdcand1", "my-cmd", ["m1", "m2"]);
  await findCmd("evolve-install").execute({ sessionID: "s1", prompt: { text: "cmdcand1 --yes" } });
  const cmdFile = path.join(targets.command, "my-cmd.md");
  const cmdContent = await fs.readFile(cmdFile, "utf8");
  assert.ok(cmdContent.includes("description:"));
  assert.ok(cmdContent.includes("generated_by: mighty-instincts"));
  assert.ok(cmdContent.includes("candidate_id: cmdcand1"));

  await seedCandidate("agent", "agentcand1", "my-agent", ["m1"]);
  await findCmd("evolve-install").execute({ sessionID: "s1", prompt: { text: "agentcand1 --yes" } });
  const agentFile = path.join(targets.agent, "my-agent.md");
  const agentContent = await fs.readFile(agentFile, "utf8");
  assert.ok(agentContent.includes("mode: subagent"));
  assert.ok(agentContent.includes("candidate_id: agentcand1"));

  await seedCandidate("rule", "rulecand1", "my-rule", ["m1", "m2"]);
  await findCmd("evolve-install").execute({ sessionID: "s1", prompt: { text: "rulecand1 --yes" } });
  const ruleContent = await fs.readFile(targets.rule, "utf8");
  assert.ok(ruleContent.includes("## Learned rules (mighty-instincts)"));
  assert.ok(ruleContent.includes(`<!-- generated_by: mighty-instincts candidate_id: rulecand1 project_id: ${cmdProject.id} -->`));
  assert.ok(ruleContent.includes("<!-- /generated_by: mighty-instincts candidate_id: rulecand1 -->"));
  const ruleCandidateAfter = await findCandidateById(cmdProject.evolved_dir, "rulecand1");
  assert.equal(ruleCandidateAfter.fields.status, "installed");

  // --- refuse to overwrite a hand-written file, even one whose own
  //     prose merely mentions the marker text (not a real frontmatter
  //     field) ---------------------------------------------------------
  await fs.mkdir(path.join(targets.skill, "hand-written"), { recursive: true });
  await fs.writeFile(
    path.join(targets.skill, "hand-written", "SKILL.md"),
    "---\nname: hand-written\ndescription: a human wrote this\n---\n\nSee generated_by: mighty-instincts for how that other plugin works. Do not touch.\n",
    "utf8",
  );
  await seedCandidate("skill", "skillcand2", "hand-written", ["m1", "m2", "m3", "m4"]);
  await findCmd("evolve-install").execute({ sessionID: "s2", prompt: { text: "skillcand2 --yes" } });
  const refuseReply = lastReply();
  assert.ok(refuseReply.includes("Refused:") && refuseReply.includes("not written by mighty-instincts"), "marker text merely in the body's prose is never mistaken for a real marker");
  const untouched = await fs.readFile(path.join(targets.skill, "hand-written", "SKILL.md"), "utf8");
  assert.ok(untouched.includes("Do not touch."), "the hand-written file is left exactly as it was");
  const skillCandidate2After = await findCandidateById(cmdProject.evolved_dir, "skillcand2");
  assert.equal(skillCandidate2After.fields.status, "proposed", "a refused install never flips the candidate's own status");

  // --- refuse a file that is genuinely ours, but for a different
  //     candidate_id (e.g. a leftover from an earlier, differently-
  //     proposed cluster that happened to pick the same suggested_name)
  // -------------------------------------------------------------------
  await fs.mkdir(path.join(targets.skill, "shared-name"), { recursive: true });
  await fs.writeFile(
    path.join(targets.skill, "shared-name", "SKILL.md"),
    `---\nname: shared-name\ndescription: owned by another candidate\ngenerated_by: mighty-instincts\ncandidate_id: some-other-candidate\nproject_id: ${cmdProject.id}\nmembers: [x1]\n---\n\nBody.\n`,
    "utf8",
  );
  await seedCandidate("skill", "skillcand3", "shared-name", ["m1", "m2", "m3", "m4"]);
  await findCmd("evolve-install").execute({ sessionID: "s2", prompt: { text: "skillcand3 --yes" } });
  assert.ok(lastReply().includes("Refused:"), "a file genuinely ours, but for a different candidate_id, is still refused");
  const untouchedOther = await fs.readFile(path.join(targets.skill, "shared-name", "SKILL.md"), "utf8");
  assert.ok(untouchedOther.includes("owned by another candidate"), "the other candidate's installed file is left exactly as it was");

  // --- /evolve-reject: proposed -> archived with a reason ---------------
  await seedCandidate("rule", "rejectcand1", "reject-me", ["m1", "m2"]);
  await findCmd("evolve-reject").execute({ sessionID: "s3", prompt: { text: "rejectcand1 not useful here" } });
  assert.ok(lastReply().includes("Archived candidate 'rejectcand1' (reason: not useful here)."));
  const rejectedCandidate = await findCandidateById(cmdProject.evolved_dir, "rejectcand1");
  assert.equal(rejectedCandidate.fields.status, "archived");
  assert.equal(rejectedCandidate.fields.reason, "not useful here");

  await findCmd("evolve-reject").execute({ sessionID: "s3", prompt: { text: "cmdcand1" } });
  assert.ok(lastReply().includes("use /evolve-archive to remove it instead"), "rejecting an already-installed candidate points at /evolve-archive instead");

  // --- /evolve-archive: removes the installed file when ownership and
  //     content both still match, but leaves a hand-edited one in place
  //     with a reason --------------------------------------------------
  await findCmd("evolve-archive").execute({ sessionID: "s4", prompt: { text: "cmdcand1" } });
  assert.ok(lastReply().includes(`Removed ${cmdFile}`));
  await assert.rejects(fs.readFile(cmdFile, "utf8"), "the installed command file is actually gone");
  const archivedCmdCandidate = await findCandidateById(cmdProject.evolved_dir, "cmdcand1");
  assert.equal(archivedCmdCandidate.fields.status, "archived");

  // my-agent.md still carries its own marker, but its content no longer
  // hashes to what was installed: archive must leave it in place.
  await fs.writeFile(agentFile, `${agentContent}\n\nA human added this line after install.\n`, "utf8");
  await findCmd("evolve-archive").execute({ sessionID: "s5", prompt: { text: "agentcand1" } });
  const archiveBlockedReply = lastReply();
  assert.ok(archiveBlockedReply.includes("left in place") && archiveBlockedReply.includes("hand-edited"), "a hash mismatch is reported as hand-edited, not as a missing marker");
  const agentFileStillThere = await fs.readFile(agentFile, "utf8");
  assert.ok(agentFileStillThere.includes("A human added this line after install."), "the hand-edited agent file is never deleted");
  const archivedAgentCandidate = await findCandidateById(cmdProject.evolved_dir, "agentcand1");
  assert.equal(archivedAgentCandidate.fields.status, "archived", "the candidate itself is still archived even though its file was left alone");

  // --- /evolve-list: a quick sanity check on the summary line ----------
  await findCmd("evolve-list").execute({ sessionID: "s6", prompt: { text: "" } });
  const listReply = lastReply();
  assert.ok(/\d+ candidate\(s\): \d+ proposed, \d+ installed, \d+ archived\./.test(listReply));
  assert.ok(listReply.includes("skillcand1 [skill] status=installed"));

  await Promise.allSettled(harness.registrations.map((registration) => registration?.dispose?.()));
}

// ---------------------------------------------------------------------------
// 17a. lib/candidates.js's bracketed rule markers (P1 fix): installing two
//      rule candidates under the same AGENTS.md heading, then archiving
//      one, must never disturb the other's block or any hand-written
//      text under that same heading. Also covers idempotent re-install
//      (a retried /evolve-install for a block already present never
//      duplicates it) and CRLF preservation.
// ---------------------------------------------------------------------------
{
  const { appendRuleBlock, removeRuleBlock } = await import("./lib/candidates.js");

  let agentsContent = "# My Project\n\nSome existing instructions.\n";
  agentsContent = appendRuleBlock(agentsContent, "cand-a", "proj-1", "- Rule A text.");
  agentsContent = appendRuleBlock(agentsContent, "cand-b", "proj-1", "- Rule B text.");
  // A human adds their own paragraph right under the heading, between
  // the two generated blocks' neighbourhood, exactly the kind of content
  // the old "consume to the next blank line" removal used to eat.
  agentsContent += "\n- A hand-written rule a human added here.\n";

  assert.ok(agentsContent.includes("Some existing instructions."), "pre-existing file content survives the first append");
  assert.ok(agentsContent.includes("Rule A text.") && agentsContent.includes("Rule B text."));

  const { content: afterArchiveB, removed } = removeRuleBlock(agentsContent, "cand-b");
  assert.equal(removed, true);
  assert.ok(afterArchiveB.includes("Rule A text."), "archiving candidate B leaves candidate A's block intact");
  assert.ok(!afterArchiveB.includes("Rule B text."), "candidate B's own block is actually gone");
  assert.ok(afterArchiveB.includes("A hand-written rule a human added here."), "a human's own text under the heading survives byte for byte");
  assert.ok(afterArchiveB.includes("Some existing instructions."), "content above the heading is untouched");

  // Idempotent re-append: a retried install (e.g. after a crash between
  // writing AGENTS.md and flipping the candidate's own status) never
  // duplicates the block. Each block carries exactly one start marker
  // and one end marker, both naming the candidate_id, so a single block
  // matches this twice; re-appending must leave that count unchanged.
  const beforeReappendCount = (afterArchiveB.match(/candidate_id: cand-a\b/g) ?? []).length;
  assert.equal(beforeReappendCount, 2, "one start marker and one end marker for candidate A's own block");
  const reAppended = appendRuleBlock(afterArchiveB, "cand-a", "proj-1", "- Rule A text.");
  assert.equal((reAppended.match(/candidate_id: cand-a\b/g) ?? []).length, 2, "re-appending a block that is already present never duplicates its markers");
  assert.equal(reAppended, afterArchiveB, "re-appending an already-present block changes nothing at all");

  // CRLF preservation: a Windows-style AGENTS.md keeps CRLF throughout,
  // including the newly appended block.
  const crlfContent = "# Title\r\n\r\nExisting line.\r\n";
  const crlfAppended = appendRuleBlock(crlfContent, "cand-crlf", "proj-1", "- CRLF rule.");
  assert.ok(crlfAppended.includes("Existing line.\r\n"), "pre-existing CRLF lines are untouched");
  assert.ok(!crlfAppended.replace(/\r\n/g, "").includes("\n"), "no bare LF is introduced into an all-CRLF file");
  const { content: crlfRemoved } = removeRuleBlock(crlfAppended, "cand-crlf");
  assert.ok(crlfRemoved.includes("Existing line.\r\n") && !crlfRemoved.includes("CRLF rule."));
}

// ---------------------------------------------------------------------------
// 17b. Cross-project clobber protection (P2/P3): two unrelated projects
//      whose `evolve.targets.skill` happens to point at the exact same
//      shared directory (the realistic case: the real default
//      `~/.config/opencode/skills` is shared across every project on a
//      machine). Installing candidate B from project 2 must never
//      overwrite or archive-delete candidate A's file from project 1,
//      even though both are genuinely "generated_by: mighty-instincts".
// ---------------------------------------------------------------------------
{
  const sharedHome = fsSync.mkdtempSync(path.join(TEMP_ROOT, "cross-project-home-"));
  const sharedTargets = { skill: path.join(sharedHome, "skills"), command: path.join(sharedHome, "commands"), agent: path.join(sharedHome, "agents"), rule: path.join(sharedHome, "AGENTS.md") };

  const { projectDir: proj1Dir, dataDir: proj1Data } = makeProjectAndData("cross-proj-1");
  const { projectDir: proj2Dir, dataDir: proj2Data } = makeProjectAndData("cross-proj-2");
  const options1 = { python: "python3", dataDir: proj1Data, evolve: { targets: sharedTargets } };
  const options2 = { python: "python3", dataDir: proj2Data, evolve: { targets: sharedTargets } };
  const project1 = await resolveProject({ location: { directory: proj1Dir } }, options1);
  const project2 = await resolveProject({ location: { directory: proj2Dir } }, options2);
  assert.notEqual(project1.id, project2.id, "the two fixture projects really do have distinct ids");

  const harness1 = createPluginHarness(proj1Dir, options1);
  await registerCommands(harness1.ctx, options1, { run: async () => {} }, { refresh: async () => null });
  const harness2 = createPluginHarness(proj2Dir, options2);
  await registerCommands(harness2.ctx, options2, { run: async () => {} }, { refresh: async () => null });

  const cluster = (memberId) => [{ fields: { id: memberId, trigger: `t ${memberId}`, summary: `Do ${memberId}.` } }];
  await writeCandidate(
    project1.evolved_dir,
    { id: "proj1-cand", kind: "skill", status: "proposed", created: new Date().toISOString(), members: ["m1"], summary: "s", suggested_name: "shared" },
    renderCandidateBody("skill", "testing", cluster("m1"), "shared"),
  );
  await writeCandidate(
    project2.evolved_dir,
    { id: "proj2-cand", kind: "skill", status: "proposed", created: new Date().toISOString(), members: ["m2"], summary: "s", suggested_name: "shared" },
    renderCandidateBody("skill", "testing", cluster("m2"), "shared"),
  );

  await harness1.commandDefs.find((def) => def.name === "evolve-install").execute({ sessionID: "p1", prompt: { text: "proj1-cand --yes" } });
  const installedByProj1 = await fs.readFile(path.join(sharedTargets.skill, "shared", "SKILL.md"), "utf8");
  assert.ok(installedByProj1.includes(`project_id: ${project1.id}`));

  await harness2.commandDefs.find((def) => def.name === "evolve-install").execute({ sessionID: "p2", prompt: { text: "proj2-cand --yes" } });
  const refusedReply = harness2.syntheticCalls.at(-1).text;
  assert.ok(refusedReply.includes("Refused:"), "project 2 cannot install over project 1's own candidate at the shared path");
  const stillProj1 = await fs.readFile(path.join(sharedTargets.skill, "shared", "SKILL.md"), "utf8");
  assert.equal(stillProj1, installedByProj1, "project 1's installed file is byte-for-byte unchanged");
  const proj2CandidateAfter = await findCandidateById(project2.evolved_dir, "proj2-cand");
  assert.equal(proj2CandidateAfter.fields.status, "proposed", "the refused install never flips project 2's own candidate status");

  // Project 2 cannot archive-delete project 1's file either, even if it
  // somehow ends up marked "installed" locally (e.g. a stale copy of
  // its own evolved/ record from before a project id changed).
  await writeCandidate(
    project2.evolved_dir,
    { id: "proj2-cand", kind: "skill", status: "installed", created: new Date().toISOString(), members: ["m2"], summary: "s", suggested_name: "shared", project_id: project2.id, installed_at: new Date().toISOString() },
    renderCandidateBody("skill", "testing", cluster("m2"), "shared"),
  );
  await harness2.commandDefs.find((def) => def.name === "evolve-archive").execute({ sessionID: "p2", prompt: { text: "proj2-cand" } });
  const archiveReply2 = harness2.syntheticCalls.at(-1).text;
  assert.ok(archiveReply2.includes("left in place"), "project 2 can never archive-delete a file owned by project 1's candidate_id/project_id");
  const stillProj1AfterArchive = await fs.readFile(path.join(sharedTargets.skill, "shared", "SKILL.md"), "utf8");
  assert.equal(stillProj1AfterArchive, installedByProj1, "project 1's file survives project 2's archive attempt too");

  await Promise.allSettled([...harness1.registrations, ...harness2.registrations].map((registration) => registration?.dispose?.()));
}

// ---------------------------------------------------------------------------
// 17c. Install-time filesystem safety (P3): a symlink at the install
//      target is refused outright for a skill/command/agent (never
//      followed, never replaced), and a rule's AGENTS.md write goes
//      through atomicWriteAgentsFile, which resolves a symlinked
//      AGENTS.md to its real file (writing through it, not replacing
//      the symlink) and writes via tmp-then-rename in that real
//      directory.
// ---------------------------------------------------------------------------
{
  const symlinkHome = fsSync.mkdtempSync(path.join(TEMP_ROOT, "symlink-home-"));
  const targets = { skill: path.join(symlinkHome, "skills"), command: path.join(symlinkHome, "commands"), agent: path.join(symlinkHome, "agents"), rule: path.join(symlinkHome, "AGENTS.md") };
  const { projectDir, dataDir } = makeProjectAndData("symlink-install");
  const options = { python: "python3", dataDir, evolve: { targets } };
  const ctx = { location: { directory: projectDir } };
  const project = await resolveProject(ctx, options);

  const harness = createPluginHarness(projectDir, options);
  await registerCommands(harness.ctx, options, { run: async () => {} }, { refresh: async () => null });

  // A symlink sitting at the would-be skill target, pointing somewhere
  // else entirely.
  const elsewhere = path.join(symlinkHome, "elsewhere.txt");
  await fs.writeFile(elsewhere, "not a skill\n", "utf8");
  await fs.mkdir(path.join(targets.skill, "linked"), { recursive: true });
  await fs.symlink(elsewhere, path.join(targets.skill, "linked", "SKILL.md"));

  await writeCandidate(
    project.evolved_dir,
    { id: "symcand1", kind: "skill", status: "proposed", created: new Date().toISOString(), members: ["m1"], summary: "s", suggested_name: "linked" },
    renderCandidateBody("skill", "testing", [{ fields: { id: "m1", trigger: "t", summary: "Do it." } }], "linked"),
  );
  await harness.commandDefs.find((def) => def.name === "evolve-install").execute({ sessionID: "s1", prompt: { text: "symcand1 --yes" } });
  const symlinkReply = harness.syntheticCalls.at(-1).text;
  assert.ok(symlinkReply.includes("Refused:") && symlinkReply.includes("symlink"), "install never follows or replaces a symlinked target");
  assert.equal(await fs.readFile(elsewhere, "utf8"), "not a skill\n", "the symlink's real target is completely untouched");

  // AGENTS.md as a symlink: the rule install writes through to the real
  // file, in its real directory, rather than replacing the symlink.
  const realAgentsDir = fsSync.mkdtempSync(path.join(TEMP_ROOT, "real-agents-dir-"));
  const realAgentsFile = path.join(realAgentsDir, "AGENTS.md");
  await fs.writeFile(realAgentsFile, "# Real file\n", "utf8");
  await fs.symlink(realAgentsFile, targets.rule);

  await writeCandidate(
    project.evolved_dir,
    { id: "rulesym1", kind: "rule", status: "proposed", created: new Date().toISOString(), members: ["m1", "m2"], summary: "s", suggested_name: "rulesym" },
    renderCandidateBody("rule", "testing", [{ fields: { id: "m1", trigger: "t", summary: "Do it." } }, { fields: { id: "m2", trigger: "t", summary: "Do it too." } }], "rulesym"),
  );
  await harness.commandDefs.find((def) => def.name === "evolve-install").execute({ sessionID: "s2", prompt: { text: "rulesym1 --yes" } });
  const ruleSymReply = harness.syntheticCalls.at(-1).text;
  assert.ok(ruleSymReply.includes("Restart OpenCode to load it."), "a symlinked AGENTS.md is written through, not refused");
  assert.ok(fsSync.lstatSync(targets.rule).isSymbolicLink(), "the symlink itself is still a symlink (never replaced by a real file)");
  const realContent = await fs.readFile(realAgentsFile, "utf8");
  assert.ok(realContent.includes("# Real file") && realContent.includes("## Learned rules (mighty-instincts)"), "the real target file received the new content, alongside what it already had");

  await Promise.allSettled(harness.registrations.map((registration) => registration?.dispose?.()));
}

// ---------------------------------------------------------------------------
// 18. lib/observe.js's usage tracking (0.8.0): a `skill` tool call counts
//     into usage.json's `skills` bucket by input.id, a `subagent`/`task`
//     tool call counts into `agents` by input.agent, and a slash-command
//     prompt counts into `commands` by name, all independent of whether
//     the name happens to match something this plugin generated. Once an
//     installed candidate's own suggested_name is used this way, every
//     one of its member instincts gets `fired` bumped (the same feedback
//     lib/inject.js's own trigger-match path uses), so the habits behind
//     a useful artefact are exempt from decayStep.
// ---------------------------------------------------------------------------
{
  const { projectDir: obsProjectDir, dataDir: obsDataDir } = makeProjectAndData("usage-observe");
  const obsOptions = { python: "python3", dataDir: obsDataDir, board: { enabled: false } };
  const harness = createPluginHarness(obsProjectDir, obsOptions);
  const cleanup = await setup(harness.ctx);
  const project = await resolveProject(harness.ctx, obsOptions);

  // A member instinct the installed "skill" candidate below points back
  // to; feedback should bump its `fired` count once the skill is used.
  await writeInstinct(
    project.instincts_personal,
    { id: "member-habit", trigger: "member trigger", confidence: 0.7, domain: "testing", summary: "Member habit.", created: new Date().toISOString() },
    "# Member\n",
  );
  await writeCandidate(
    project.evolved_dir,
    { id: "usagecand1", kind: "skill", status: "installed", created: new Date().toISOString(), members: ["member-habit"], summary: "s", suggested_name: "used-skill", installed_at: new Date().toISOString() },
    renderCandidateBody("skill", "testing", [{ fields: { id: "member-habit", trigger: "t", summary: "Member habit." } }], "used-skill"),
  );

  await harness.toolHooks["execute.before"]({ tool: "skill", sessionID: "u1", agent: "build", input: { id: "used-skill" } });
  await harness.toolHooks["execute.before"]({ tool: "subagent", sessionID: "u1", agent: "build", input: { agent: "explore" } });
  await harness.sessionHooks.prompt({ prompt: { text: "/evolve-list" }, sessionID: "u1" });

  const usageAfter = await readUsage(project.project_dir);
  assert.equal(usageAfter.skills["used-skill"].count, 1, "the skill tool's own call counted by input.id");
  assert.equal(usageAfter.agents.explore.count, 1, "the subagent tool's own call counted by input.agent");
  assert.equal(usageAfter.commands["evolve-list"].count, 1, "a slash-command prompt counted by its command name");

  const memberAfter = await fs.readFile(path.join(project.instincts_personal, "member-habit.md"), "utf8");
  assert.ok(/fired:\s*1/.test(memberAfter), "using the installed candidate's own suggested_name bumped its member instinct's fired count");

  // P2 fix: a host naming its skill tool's id field `name`, or its
  // subagent tool's agent field `subagent_type`, is still counted.
  await harness.toolHooks["execute.before"]({ tool: "skill", sessionID: "u2", agent: "build", input: { name: "used-skill" } });
  await harness.toolHooks["execute.before"]({ tool: "task", sessionID: "u2", agent: "build", input: { subagent_type: "explore" } });
  const usageAfterFallback = await readUsage(project.project_dir);
  assert.equal(usageAfterFallback.skills["used-skill"].count, 2, "input.name is accepted when input.id is absent");
  assert.equal(usageAfterFallback.agents.explore.count, 2, "input.subagent_type is accepted when input.agent is absent, on the 'task' tool name too");

  await cleanup();
}

// ---------------------------------------------------------------------------
// 18a. lib/candidates.js's loadCandidates validation (P3): a candidate
//      file with a malformed id, a filename that does not match its own
//      `id:` field, or a malformed `suggested_name` is skipped (with a
//      warning) instead of being loaded, since both fields end up as
//      real filesystem path segments (installPathFor).
// ---------------------------------------------------------------------------
{
  const validateRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "candidate-validate-"));
  const goodId = "good-cand-12345678";
  await writeCandidate(
    validateRoot,
    { id: goodId, kind: "skill", status: "proposed", created: new Date().toISOString(), members: ["m1"], summary: "s", suggested_name: "good-name" },
    renderCandidateBody("skill", "testing", [{ fields: { id: "m1", trigger: "t", summary: "Do it." } }], "good-name"),
  );
  // A malformed id (path-traversal-shaped), written directly rather than
  // through writeCandidate (which would itself just slugify-sanitised
  // input never produces this id in the first place; this stands in for
  // a hand-edited or otherwise-untrusted file on disk).
  await fs.writeFile(
    path.join(validateRoot, "..bad.md"),
    "---\nid: ../../etc/passwd\nkind: skill\nstatus: proposed\nmembers: []\nsuggested_name: x\n---\n\nbody\n",
    "utf8",
  );
  // Filename does not match its own id.
  await writeCandidate(
    validateRoot,
    { id: "mismatched-id", kind: "skill", status: "proposed", created: new Date().toISOString(), members: ["m1"], summary: "s", suggested_name: "mismatched" },
    "body",
  );
  await fs.rename(path.join(validateRoot, "mismatched-id.md"), path.join(validateRoot, "renamed-after-write.md"));
  // Malformed suggested_name.
  await writeCandidate(
    validateRoot,
    { id: "bad-suggested-name", kind: "skill", status: "proposed", created: new Date().toISOString(), members: ["m1"], summary: "s", suggested_name: "../../escape" },
    "body",
  );

  const loaded = await loadCandidates(validateRoot);
  assert.deepEqual(loaded.map((c) => c.fields.id), [goodId], "only the well-formed candidate is loaded; the malformed-id, filename-mismatched, and malformed-suggested_name files are all skipped");
}

// ---------------------------------------------------------------------------
// 18b. lib/maintain.js's evolveStep (P3): re-reads a candidate from disk
//      right before patching its `members`, rather than trusting the
//      snapshot taken at the top of the run, so a concurrent status
//      change (e.g. a /evolve-archive that ran in between) is never
//      silently overwritten or resurrected.
// ---------------------------------------------------------------------------
{
  const raceRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "evolve-race-"));
  const raceProject = { project_dir: raceRoot, root: raceRoot, id: "race-proj", instincts_personal: path.join(raceRoot, "instincts", "personal"), evolved_dir: path.join(raceRoot, "evolved") };
  await fs.mkdir(raceProject.instincts_personal, { recursive: true });

  for (let i = 0; i < 3; i++) {
    await writeInstinct(
      raceProject.instincts_personal,
      { id: `race-habit-${i}`, trigger: `always run the race suite before merging pull request ${i}`, confidence: 0.6, domain: "racing", summary: `Run the race suite ${i}.`, created: new Date().toISOString() },
      `# Race ${i}\n`,
    );
  }
  await evolveStep(raceProject, { log: () => {} });
  const [proposedRace] = await loadCandidates(raceProject.evolved_dir);
  assert.equal(proposedRace.fields.status, "proposed");

  // Simulates a concurrent /evolve-archive finishing between evolveStep's
  // own snapshot and the member-update write: archive the candidate by
  // hand, then grow the cluster by one member and re-run evolveStep.
  await writeCandidate(raceProject.evolved_dir, { ...proposedRace.fields, status: "archived", reason: "concurrent archive" }, proposedRace.body);
  await writeInstinct(
    raceProject.instincts_personal,
    { id: "race-habit-3", trigger: "always run the race suite before merging pull request 3", confidence: 0.6, domain: "racing", summary: "Run the race suite 3.", created: new Date().toISOString() },
    "# Race 3\n",
  );

  const raceLog = [];
  await evolveStep(raceProject, { log: (line) => raceLog.push(line) });
  const afterRace = await findCandidateById(raceProject.evolved_dir, proposedRace.fields.id);
  assert.equal(afterRace.fields.status, "archived", "a concurrently archived candidate is never resurrected by a later member update");
  assert.equal(afterRace.fields.members.length, 3, "its members list is untouched (never patched onto a status that already moved on)");
  assert.ok(raceLog.some((line) => line.includes("evolve: skipped cluster") && line.includes("previously archived")), "the archived-blocks-reproposal path, not the update path, is what actually ran here");
}

// ---------------------------------------------------------------------------
// 18c. lib/candidates.js's resolveEvolveTargets (P3): a relative
//      `evolve.targets.*` value (even after `~` expansion) is rejected
//      with a warning naming which target, and the real default
//      location is used instead rather than resolving against some
//      arbitrary cwd.
// ---------------------------------------------------------------------------
{
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  let targets;
  try {
    targets = resolveEvolveTargets({ evolve: { targets: { skill: "relative/skills", command: "~/also/relative/../../etc", agent: "/already/absolute/agents", rule: "~/relative-after-tilde" } } });
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(targets.skillDir.endsWith(`${path.sep}.config${path.sep}opencode${path.sep}skills`), "a relative skill target falls back to the real default");
  assert.equal(targets.agentDir, "/already/absolute/agents", "an already-absolute target is used as given");
  assert.ok(warnings.some((line) => line.includes("evolve.targets.skill") && line.includes("absolute")));
  // `~/also/relative/../../etc` expands to an absolute path (home is
  // absolute, `~/` always resolves to one), so it is accepted, not
  // warned about; only a value that stays relative after expansion is.
  assert.ok(path.isAbsolute(targets.commandDir));
}

// ---------------------------------------------------------------------------
// 19. lib/maintain.js's pruneCandidatesStep: an installed candidate with
//     zero uses in `prune.unusedDays` days is flagged (report-only,
//     nothing touched) by default, and only archived + its installed
//     file removed once `prune.auto` is explicitly on; a rule candidate
//     is never flagged at all (no runtime usage signal to judge it by),
//     and a candidate installed too recently to judge yet is left alone
//     either way. Also covers the P2/P3 hardening: a failure uninstalling
//     one candidate (lib/candidates.js's uninstallCandidateArtifact
//     throwing) is logged and skipped, never aborting the rest of the
//     sweep, and auto mode refuses to touch a kind whose entire usage
//     bucket is empty (a dead signal, not proof of disuse).
// ---------------------------------------------------------------------------
{
  const pruneRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "prune-candidates-"));
  const pruneHome = fsSync.mkdtempSync(path.join(TEMP_ROOT, "prune-home-"));
  const pruneProject = { project_dir: pruneRoot, root: pruneRoot, id: "prune-proj", instincts_personal: path.join(pruneRoot, "instincts", "personal"), evolved_dir: path.join(pruneRoot, "evolved") };
  const pruneTargets = { skill: path.join(pruneHome, "skills"), command: path.join(pruneHome, "commands"), agent: path.join(pruneHome, "agents"), rule: path.join(pruneHome, "AGENTS.md") };
  const pruneOptions = { prune: { unusedDays: 30 } };
  const longAgo = new Date(Date.now() - 40 * 86400000).toISOString();

  async function installFixtureSkill(id, suggestedName) {
    const cluster = [{ fields: { id: "m1", trigger: "t", summary: "Do it." } }];
    const body = renderCandidateBody("skill", "testing", cluster, suggestedName);
    await writeCandidate(
      pruneProject.evolved_dir,
      { id, kind: "skill", status: "installed", created: longAgo, members: ["m1"], summary: "s", suggested_name: suggestedName, project_id: pruneProject.id, installed_at: longAgo },
      body,
    );
    const installPath = path.join(pruneTargets.skill, suggestedName, "SKILL.md");
    await fs.mkdir(path.dirname(installPath), { recursive: true });
    await fs.writeFile(installPath, body.replace("---\n", `---\ngenerated_by: mighty-instincts\ncandidate_id: ${id}\nproject_id: ${pruneProject.id}\nmembers: [m1]\n`), "utf8");
    return installPath;
  }

  await installFixtureSkill("unused-cand", "unused-skill");
  const recentPath = await installFixtureSkill("recent-cand", "recent-skill");
  await bumpUsage(pruneProject.project_dir, "skills", "recent-skill");
  // A candidate installed too recently to have had a fair chance yet,
  // even though it has never been used: never flagged either.
  const tooNewFields = { id: "too-new-cand", kind: "skill", status: "installed", created: new Date().toISOString(), members: ["m1"], summary: "s", suggested_name: "too-new-skill", project_id: pruneProject.id, installed_at: new Date().toISOString() };
  await writeCandidate(pruneProject.evolved_dir, tooNewFields, renderCandidateBody("skill", "testing", [{ fields: { id: "m1", trigger: "t", summary: "Do it." } }], "too-new-skill"));

  // A candidate whose installed "file" is actually a directory: reading
  // it to check ownership throws (EISDIR), simulating any real-world
  // failure (permissions, a half-written file, anything) uninstalling
  // one specific candidate.
  const brokenInstallPath = path.join(pruneTargets.skill, "broken-skill", "SKILL.md");
  await fs.mkdir(brokenInstallPath, { recursive: true });
  await writeCandidate(
    pruneProject.evolved_dir,
    { id: "broken-cand", kind: "skill", status: "installed", created: longAgo, members: ["m1"], summary: "s", suggested_name: "broken-skill", project_id: pruneProject.id, installed_at: longAgo },
    renderCandidateBody("skill", "testing", [{ fields: { id: "m1", trigger: "t", summary: "Do it." } }], "broken-skill"),
  );

  const flagLog = [];
  const flagged = await pruneCandidatesStep(pruneProject, { ...pruneOptions, evolve: { targets: pruneTargets } }, { log: (line) => flagLog.push(line) });
  assert.equal(flagged.flagged, 2, "the long-installed, never-recently-used candidates are flagged (unused-cand and broken-cand)");
  assert.equal(flagged.archived, 0, "report-only by default: nothing is archived");
  assert.ok(flagLog.some((line) => line.includes("prune: flagged unused candidate unused-cand")));
  const stillInstalled = await findCandidateById(pruneProject.evolved_dir, "unused-cand");
  assert.equal(stillInstalled.fields.status, "installed", "flagging alone never changes the candidate's status");
  await fs.access(path.join(pruneTargets.skill, "unused-skill", "SKILL.md")); // still there

  const autoLog = [];
  const autoOptions = { prune: { unusedDays: 30, auto: true }, evolve: { targets: pruneTargets } };
  const autoResult = await pruneCandidatesStep(pruneProject, autoOptions, { log: (line) => autoLog.push(line) });
  assert.equal(autoResult.archived, 1, "exactly the one candidate whose uninstall actually succeeded is archived (broken-cand's failure never blocks it)");
  const nowArchived = await findCandidateById(pruneProject.evolved_dir, "unused-cand");
  assert.equal(nowArchived.fields.status, "archived");
  assert.equal(nowArchived.fields.reason, "auto-pruned: unused");
  await assert.rejects(fs.access(path.join(pruneTargets.skill, "unused-skill", "SKILL.md")), "prune.auto also removed the installed file");
  await fs.access(recentPath); // the recently-used candidate's file is untouched
  const recentStillInstalled = await findCandidateById(pruneProject.evolved_dir, "recent-cand");
  assert.equal(recentStillInstalled.fields.status, "installed", "a candidate used within the window is never flagged or archived");
  const tooNewStill = await findCandidateById(pruneProject.evolved_dir, "too-new-cand");
  assert.equal(tooNewStill.fields.status, "installed", "a too-recently-installed candidate is never flagged or archived either");
  assert.ok(autoLog.some((line) => line.includes("prune: auto-archived unused candidate unused-cand")));

  // broken-cand's own failure is logged, but never thrown: the step
  // (and the loop inside it) completed and returned normally despite it.
  const brokenStill = await findCandidateById(pruneProject.evolved_dir, "broken-cand");
  assert.equal(brokenStill.fields.status, "installed", "a candidate whose uninstall threw is left exactly as it was, to retry next sweep");
  assert.ok(autoLog.some((line) => line.includes("prune: failed to auto-archive broken-cand")), "the per-candidate failure is logged by name");
}

// ---------------------------------------------------------------------------
// 19a. pruneCandidatesStep's auto mode refuses to touch an entire kind
//      whose usage bucket is completely empty: that almost certainly
//      means the usage *signal* for that kind is dead (a host naming its
//      skill tool, or its input field, differently than lib/observe.js
//      expects), not that every installed candidate of that kind is
//      genuinely unused. Flagging (report-only) still happens either way.
// ---------------------------------------------------------------------------
{
  const deadRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "prune-dead-signal-"));
  const deadHome = fsSync.mkdtempSync(path.join(TEMP_ROOT, "prune-dead-home-"));
  const deadProject = { project_dir: deadRoot, root: deadRoot, id: "dead-proj", instincts_personal: path.join(deadRoot, "instincts", "personal"), evolved_dir: path.join(deadRoot, "evolved") };
  const deadTargets = { skill: path.join(deadHome, "skills"), command: path.join(deadHome, "commands"), agent: path.join(deadHome, "agents"), rule: path.join(deadHome, "AGENTS.md") };
  const longAgo = new Date(Date.now() - 40 * 86400000).toISOString();

  const cluster = [{ fields: { id: "m1", trigger: "t", summary: "Do it." } }];
  const body = renderCandidateBody("skill", "testing", cluster, "dead-signal-skill");
  await writeCandidate(
    deadProject.evolved_dir,
    { id: "dead-signal-cand", kind: "skill", status: "installed", created: longAgo, members: ["m1"], summary: "s", suggested_name: "dead-signal-skill", project_id: deadProject.id, installed_at: longAgo },
    body,
  );
  const deadInstallPath = path.join(deadTargets.skill, "dead-signal-skill", "SKILL.md");
  await fs.mkdir(path.dirname(deadInstallPath), { recursive: true });
  await fs.writeFile(deadInstallPath, body.replace("---\n", `---\ngenerated_by: mighty-instincts\ncandidate_id: dead-signal-cand\nproject_id: ${deadProject.id}\nmembers: [m1]\n`), "utf8");
  // usage.json is never written at all for this project: the `skills`
  // bucket is entirely empty, not merely missing this one candidate.

  const autoLog = [];
  const autoResult = await pruneCandidatesStep(deadProject, { prune: { unusedDays: 30, auto: true }, evolve: { targets: deadTargets } }, { log: (line) => autoLog.push(line) });
  assert.equal(autoResult.flagged, 1, "still flagged (report-only detection does not depend on the signal being trustworthy)");
  assert.equal(autoResult.archived, 0, "auto mode never archives a candidate of a kind whose usage bucket is entirely empty");
  assert.ok(autoLog.some((line) => line.includes("skipped auto-archiving dead-signal-cand") && line.includes("usage bucket is entirely empty")));
  const stillInstalled = await findCandidateById(deadProject.evolved_dir, "dead-signal-cand");
  assert.equal(stillInstalled.fields.status, "installed");
  await fs.access(deadInstallPath); // never removed
}

// ---------------------------------------------------------------------------
// 20. lib/review.js's readReviewGate: due/not-due decisions over the
//     task-observer workspace's own open-observation count, last review
//     date, lock file, and runs log, checked in the priority order
//     readReviewGate itself documents (open count, then cadence, then
//     lock, then cooldown).
// ---------------------------------------------------------------------------
{
  const gateCfg = { ...REVIEW_DEFAULTS, cadenceDays: 7, cooldownHours: 24, timeoutMinutes: 90 };

  // Never reviewed, 3 open -> due.
  const dueRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "review-gate-due-"));
  const dueLogDir = path.join(dueRoot, "skill-observations", "observation-log");
  await fs.mkdir(dueLogDir, { recursive: true });
  for (let i = 0; i < 3; i++) {
    await fs.writeFile(path.join(dueLogDir, `000${i}-open.md`), "---\nstatus: open\n---\nbody\n", "utf8");
  }
  const dueGate = await readReviewGate(dueRoot, gateCfg);
  assert.equal(dueGate.due, true, "never reviewed with 3 open observations is due");
  assert.equal(dueGate.open, 3);
  assert.equal(dueGate.lastReview, null);

  // Reviewed today -> not due, reason names the cadence.
  await fs.writeFile(path.join(dueRoot, "skill-observations", "last-review-date.txt"), `${new Date().toISOString().slice(0, 10)}\n`, "utf8");
  const freshGate = await readReviewGate(dueRoot, gateCfg);
  assert.equal(freshGate.due, false);
  assert.ok(freshGate.reason.includes("cadence"), `reason should name the cadence: ${freshGate.reason}`);

  // 0 open -> not due.
  const emptyRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "review-gate-empty-"));
  await fs.mkdir(path.join(emptyRoot, "skill-observations", "observation-log"), { recursive: true });
  const emptyGate = await readReviewGate(emptyRoot, gateCfg);
  assert.equal(emptyGate.due, false);
  assert.equal(emptyGate.open, 0);
  assert.equal(emptyGate.reason, "no open observations");

  // Live lock (fresh startedAt) -> not due, reason names the lock.
  const lockRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "review-gate-lock-"));
  const lockLogDir = path.join(lockRoot, "skill-observations", "observation-log");
  await fs.mkdir(lockLogDir, { recursive: true });
  await fs.writeFile(path.join(lockLogDir, "0001-open.md"), "---\nstatus: open\n---\nbody\n", "utf8");
  const lockStateDir = path.join(lockRoot, "skill-observations", ".mighty-instincts");
  await fs.mkdir(lockStateDir, { recursive: true });
  await fs.writeFile(
    path.join(lockStateDir, "review-lock.json"),
    JSON.stringify({ startedAt: new Date().toISOString(), sessionID: "ses_abc", pid: 123, host: "test-host" }),
    "utf8",
  );
  const liveLockGate = await readReviewGate(lockRoot, gateCfg);
  assert.equal(liveLockGate.due, false);
  assert.ok(liveLockGate.reason.includes("locked"), `reason should name the lock: ${liveLockGate.reason}`);
  assert.equal(liveLockGate.lock?.sessionID, "ses_abc");

  // The same lock, but with a startedAt older than timeoutMinutes -> due
  // again (stale, no longer reported as live).
  await fs.writeFile(
    path.join(lockStateDir, "review-lock.json"),
    JSON.stringify({ startedAt: new Date(Date.now() - 200 * 60000).toISOString(), sessionID: "ses_old", pid: 123, host: "test-host" }),
    "utf8",
  );
  const staleLockGate = await readReviewGate(lockRoot, gateCfg);
  assert.equal(staleLockGate.due, true, "a lock older than timeoutMinutes no longer blocks the gate");
  assert.equal(staleLockGate.lock, null, "a stale lock is not reported as live");

  // Cooldown: a "started" runs-log line 1h ago, cooldownHours 24 -> not due.
  const cooldownRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "review-gate-cooldown-"));
  const cooldownLogDir = path.join(cooldownRoot, "skill-observations", "observation-log");
  await fs.mkdir(cooldownLogDir, { recursive: true });
  await fs.writeFile(path.join(cooldownLogDir, "0001-open.md"), "---\nstatus: open\n---\nbody\n", "utf8");
  const cooldownStateDir = path.join(cooldownRoot, "skill-observations", ".mighty-instincts");
  await fs.mkdir(cooldownStateDir, { recursive: true });
  const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
  await fs.writeFile(path.join(cooldownStateDir, "review-runs.log"), `${oneHourAgo} started session ses_recent\n`, "utf8");
  const cooldownGate = await readReviewGate(cooldownRoot, gateCfg);
  assert.equal(cooldownGate.due, false);
  assert.ok(cooldownGate.reason.includes("cooldown"), `reason should name the cooldown: ${cooldownGate.reason}`);
}

// ---------------------------------------------------------------------------
// 21. lib/review.js's buildReviewPrompt: the autonomous-review instructions
//     name the pinned workspace root, the bounded slice size, today's
//     date, and the guardrails a headless, unattended session needs
//     (never ask a question, where last-review-date.txt lives, where
//     staged skill changes land).
// ---------------------------------------------------------------------------
{
  const promptRoot = path.join(TEMP_ROOT, "review-prompt-root");
  const promptDate = "2026-10-25";
  const prompt = buildReviewPrompt({ root: promptRoot, sliceSize: 10, date: promptDate });
  assert.ok(prompt.includes(promptRoot), "prompt names the pinned workspace root");
  assert.ok(prompt.includes("10 oldest OPEN observations"), "prompt names the slice size");
  assert.ok(prompt.includes(promptDate), "prompt names today's date");
  assert.ok(prompt.includes("never ask a question"), "prompt forbids asking a question");
  assert.ok(prompt.includes("last-review-date.txt"), "prompt names the last-review-date file");
  assert.ok(prompt.includes("skill-updates"), "prompt names the staging directory");
}

// ---------------------------------------------------------------------------
// 22. lib/review.js's buildReviewPermissions: edits are denied everywhere
//     except inside the workspace root, external directory reads are
//     denied everywhere except the workspace root plus the caller-supplied
//     skills/external directories, and shell is allowed outright (the
//     review procedure runs bash snippets in a headless session that
//     cannot answer an ask prompt).
// ---------------------------------------------------------------------------
{
  const permRoot = path.join(TEMP_ROOT, "review-permissions-root");
  const rules = buildReviewPermissions({ root: permRoot, externalDirectories: ["/opt/extra"], skillsDirs: ["/Users/x/.config/opencode"] });

  const editRules = rules.filter((rule) => rule.action === "edit");
  assert.equal(editRules[0].resource, "*");
  assert.equal(editRules[0].effect, "deny");
  const editAllow = editRules.find((rule) => rule.effect === "allow" && rule.resource === `${permRoot}/*`);
  assert.ok(editAllow, "a later edit rule allows <root>/*");
  assert.ok(rules.indexOf(editRules[0]) < rules.indexOf(editAllow), "the root allow comes after the deny (last-match-wins)");

  const externalRules = rules.filter((rule) => rule.action === "external_directory");
  assert.equal(externalRules[0].resource, "*");
  assert.equal(externalRules[0].effect, "deny");
  assert.equal(rules.indexOf(externalRules[0]), rules.findIndex((rule) => rule.action === "external_directory"), "deny * is the first external_directory rule");
  assert.ok(externalRules.some((rule) => rule.effect === "allow" && rule.resource === `${permRoot}/*`));
  assert.ok(externalRules.some((rule) => rule.effect === "allow" && rule.resource === "/opt/extra/*"));
  assert.ok(externalRules.some((rule) => rule.effect === "allow" && rule.resource === "/Users/x/.config/opencode/*"));

  assert.deepEqual(rules.filter((rule) => rule.action === "shell"), [{ action: "shell", resource: "*", effect: "allow" }]);
}

// ---------------------------------------------------------------------------
// 23. lib/review.js's createReviewController, against a fake ctx: a forced
//     run spawns exactly one session, writes the lock and the "started"
//     runs-log line, a second forced run while that lock is live spawns
//     nothing further, and a simulated session-idle event (delivered
//     through the same ctx.event.subscribe bridge the controller itself
//     subscribes to) releases the lock, logs "finished ... completed",
//     and calls the afterRun hook exactly once.
// ---------------------------------------------------------------------------
{
  const reviewRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "review-controller-"));
  await fs.mkdir(path.join(reviewRoot, "skill-observations", "observation-log"), { recursive: true });
  await fs.writeFile(path.join(reviewRoot, "skill-observations", "observation-log", "0001-open.md"), "---\nstatus: open\n---\nbody\n", "utf8");

  const eventBus = createFakeEventBus();
  const createCalls = [];
  const promptCalls = [];
  let afterRunCalls = 0;

  const fakeCtx = {
    event: { subscribe: () => eventBus.subscribe() },
    session: {
      create: async (input) => {
        createCalls.push(input);
        return { id: "ses_review1" };
      },
      prompt: async (input) => {
        promptCalls.push(input);
        return {};
      },
      synthetic: async () => ({}),
      get: async () => {
        throw new Error("session.get should not be polled while the event bridge is available");
      },
      interrupt: async () => ({}),
    },
  };

  const reviewOptions = { board: { observationsRoot: reviewRoot }, review: { ...REVIEW_DEFAULTS, enabled: false } };
  const controller = createReviewController(fakeCtx, reviewOptions, {
    afterRun: async () => {
      afterRunCalls += 1;
    },
  });

  const firstRun = await controller.run({ force: true });
  assert.equal(firstRun.spawned, true);
  assert.equal(firstRun.sessionID, "ses_review1");
  assert.equal(createCalls.length, 1, "exactly one session.create call");
  assert.equal(promptCalls.length, 1, "exactly one session.prompt call");
  assert.equal(
    promptCalls[0].text,
    buildReviewPrompt({ root: reviewRoot, sliceSize: REVIEW_DEFAULTS.sliceSize, date: new Date().toISOString().slice(0, 10) }),
    "the prompt sent matches buildReviewPrompt's own output",
  );

  const lockPath = path.join(reviewRoot, "skill-observations", ".mighty-instincts", "review-lock.json");
  const lockContent = JSON.parse(await fs.readFile(lockPath, "utf8"));
  assert.equal(lockContent.sessionID, "ses_review1");

  const runsLogPath = path.join(reviewRoot, "skill-observations", ".mighty-instincts", "review-runs.log");
  const runsLogAfterStart = await fs.readFile(runsLogPath, "utf8");
  assert.ok(runsLogAfterStart.includes("started session ses_review1"));

  // A second forced run while the lock is live spawns nothing further.
  const secondRun = await controller.run({ force: true });
  assert.equal(secondRun.spawned, false);
  assert.equal(createCalls.length, 1, "still exactly one session.create call");

  // Simulate the review session finishing: the test writes
  // last-review-date.txt itself (standing in for the real session's own
  // Step 7 write), then pushes the same idle-shaped event the
  // controller's own ctx.event.subscribe bridge is listening for.
  const today = new Date().toISOString().slice(0, 10);
  await fs.writeFile(path.join(reviewRoot, "skill-observations", "last-review-date.txt"), `${today}\n`, "utf8");
  eventBus.push({ type: "session.idle", properties: { sessionID: "ses_review1" } });

  const lockRemoved = await waitFor(async () => {
    try {
      await fs.access(lockPath);
      return false;
    } catch {
      return true;
    }
  });
  assert.ok(lockRemoved, "the lock file is removed once the idle event is processed");

  const runsLogAfterFinish = await fs.readFile(runsLogPath, "utf8");
  assert.ok(runsLogAfterFinish.includes(`finished session ses_review1: completed, last-review-date now ${today}`));
  assert.equal(afterRunCalls, 1, "afterRun is called exactly once after the review finishes");

  controller.stop();
}

// ---------------------------------------------------------------------------
// 24. Plugin-level wiring (lib/plugin.js): /skill-review registers
//     regardless of review.enabled, a disabled (default) review never
//     calls ctx.session.create on its own, and turning review.enabled on
//     does not throw during setup (its real startup timer is left
//     untested here: see lib/review.js's own controller tests above for
//     the actual spawn/completion behaviour).
// ---------------------------------------------------------------------------
{
  const { projectDir, dataDir } = makeProjectAndData("review-plugin");
  // An observationsRoot that is never created keeps readReviewGate's
  // "no open observations" branch true even if the real
  // startupDelaySeconds timer below ever did fire before cleanup runs.
  const missingObservationsRoot = path.join(TEMP_ROOT, "review-plugin-missing-root");

  const disabledOptions = {
    python: "python3",
    dataDir,
    board: { enabled: false, observationsRoot: missingObservationsRoot },
  };
  const disabledHarness = createPluginHarness(projectDir, disabledOptions);
  const disabledCleanup = await setup(disabledHarness.ctx);
  assert.ok(disabledHarness.commandDefs.some((def) => def.name === "skill-review"), "/skill-review registers even when review.enabled is false (its default)");
  assert.equal(disabledHarness.createCalls.length, 0, "a disabled review controller never calls ctx.session.create on setup/start");
  await disabledCleanup();

  const { projectDir: enabledProjectDir, dataDir: enabledDataDir } = makeProjectAndData("review-plugin-enabled");
  const enabledOptions = {
    python: "python3",
    dataDir: enabledDataDir,
    board: { enabled: false, observationsRoot: missingObservationsRoot },
    review: { enabled: true, startupDelaySeconds: 0, pollMinutes: 60 },
  };
  const enabledHarness = createPluginHarness(enabledProjectDir, enabledOptions);
  // Only asserts that enabling review does not throw during setup; the
  // real startupDelaySeconds timer is not awaited (no real-timer waits in
  // this test), so whether it has fired yet by the time cleanup() runs
  // below is intentionally left unobserved.
  const enabledCleanup = await setup(enabledHarness.ctx);
  assert.equal(typeof enabledCleanup, "function", "setup still returns a cleanup function with review.enabled: true");
  assert.ok(enabledHarness.commandDefs.some((def) => def.name === "skill-review"));
  await enabledCleanup();
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
