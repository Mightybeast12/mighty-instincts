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
import { createObserver } from "./lib/observer.js";
import { resolveProject } from "./lib/project.js";
import { appendObservation, writeInstinct } from "./lib/store.js";
import { runCli } from "./lib/cli.js";
import { PKG_NAME } from "./lib/pkg.js";

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
// command.transform.
function createPluginHarness(directory, options) {
  const registrations = [];
  const toolHooks = {};
  const sessionHooks = {};
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
        sessionHooks[name] = cb;
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

  return { ctx, registrations, toolHooks, sessionHooks, commandDefs, toolDefs, syntheticCalls, promptCalls };
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
  // its own, with controlled fixtures, in section 5 below.
  const options = { python: "python3", dataDir, board: { enabled: false } };
  const harness = createPluginHarness(projectDir, options);

  const cleanup = await setup(harness.ctx);
  assert.equal(typeof cleanup, "function", "setup returns a cleanup function");
  assert.equal(typeof harness.toolHooks["execute.before"], "function", "execute.before hook registered");
  assert.equal(typeof harness.toolHooks["execute.after"], "function", "execute.after hook registered");
  assert.equal(typeof harness.sessionHooks.prompt, "function", "prompt hook registered when observePrompts is on");

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

  // observePrompts: false must skip registering the prompt hook entirely.
  const { projectDir: noPromptDir, dataDir: noPromptData } = makeProjectAndData("no-prompt");
  const noPromptHarness = createPluginHarness(noPromptDir, { python: "python3", dataDir: noPromptData, observePrompts: false, board: { enabled: false } });
  const noPromptCleanup = await setup(noPromptHarness.ctx);
  assert.equal(noPromptHarness.sessionHooks.prompt, undefined, "prompt hook not registered when observePrompts is false");
  await noPromptCleanup();

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
  // fake model's "valid" blocks exercises the inherited-dedup rule (F6c).
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
  // per-instance, 30s line-count throttle (F1, lib/observer.js) would
  // otherwise still be holding the stale 2-line count it read a moment ago
  // in the assertion above, masking the observation just appended.
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
  // gate alone (F1) without ever reading, let alone re-counting, the
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
// 4. project.js: concurrent first resolveProject calls for a directory with
//    no cache entry yet share one in-flight resolution (F6), i.e. spawn one
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
//    richer facts, writes board-state.json atomically under the ~50 KB
//    budget, and writes a pointer file that resolves back to it the same
//    way the TUI side's own hashing would.
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
  // output (metadata.skill_name/timestamp; runs[].expectations[]; the
  // "with"-prefixed config and the other one's pass_rate.mean/stddev;
  // run_summary.delta.pass_rate). The baseline config here is
  // "without_skill" (the common naming), so state.evals.baselineKind
  // should read "without"; the "old_skill" naming (baselineKind "old") is
  // covered directly against lib/board-text.js in section 8 below, since
  // board-evals.js's branch on the two names is a one-line condition not
  // worth a second full fixture directory for.
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
  assert.equal(state.instincts.readyToPromote, 2, "0.9 and 0.85 both clear the 0.8 PROMOTE_CONFIDENCE threshold");
  assert.deepEqual(
    state.instincts.domains,
    [
      { name: "workflow", count: 2 },
      { name: "tooling", count: 1 },
    ],
    "domains tallied across all 3 instincts and sorted desc",
  );
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
    "instincts.list sorted by confidence desc, for the detail panel",
  );

  assert.equal(state.observations.available, true);
  assert.equal(state.observations.open, 3, "two explicit opens plus the file with no status line");
  assert.equal(state.observations.parked, 1);
  assert.equal(state.observations.lastReview, "2026-10-01");
  assert.equal(state.observations.staged, 2, "1 of 3 headings says installed");
  assert.deepEqual(
    state.observations.topSkills,
    [
      { skill: "workflow", count: 3 },
      { skill: "tooling", count: 1 },
    ],
    "topSkills tallied over the 3 OPEN files only, sorted desc",
  );
  assert.deepEqual(state.observations.skills, state.observations.topSkills, "only 2 distinct skills exist, so skills (all) equals topSkills");
  assert.equal(state.observations.addedToday, 1, "only the today-dated open file counts");
  assert.equal(state.observations.added7d, 2, "today + 3-days-ago open files fall within the 7-day window");
  assert.equal(state.observations.newestTitle, "Open A", "Open A carries the max (today's) date");
  assert.ok(typeof state.observations.newestAt === "string" && !Number.isNaN(Date.parse(state.observations.newestAt)));
  assert.deepEqual(
    state.observations.newest.map((entry) => entry.title),
    ["Open A", "Open B", "Open D"],
    "newest sorted desc by date, parked file excluded",
  );
  assert.equal(state.observations.warning, false, "only 3 open observations, well under the 100-open warning threshold");

  assert.equal(state.evals.available, true);
  assert.equal(state.evals.skill, "pr");
  assert.equal(state.evals.iteration, 2);
  assert.equal(state.evals.withSkill, 0.92);
  assert.equal(state.evals.baseline, 0.08);
  assert.equal(state.evals.baselineKind, "without", "without_skill baseline config reads as the 'without' naming convention");
  assert.equal(state.evals.delta, 0.84);
  assert.equal(state.evals.timestamp, evalTimestamp);
  assert.equal(state.evals.runs, 4, "runs.length is used directly when the runs array is present");
  assert.deepEqual(
    state.evals.firstFailure,
    { text: "Handles edge case", evidence: "missing branch" },
    "the first run with a failing expectation, in file order",
  );
  assert.deepEqual(state.evals.stddev, { with: 0.03, baseline: 0.02 });

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
//    unavailable, and must use the same titles/wording as the sidebar
//    panel (lib/board-text.js), just as plain text.
// ---------------------------------------------------------------------------
{
  const { formatBoardSummary } = await import("./lib/board-format.js");

  let missing;
  assert.doesNotThrow(() => {
    missing = formatBoardSummary(null, {});
  }, "missing board state never throws");
  assert.equal(typeof missing, "string");

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
  assert.ok(summary.includes("not found"), "unavailable observations/evals blocks render as 'not found'");
  assert.ok(summary.includes("not available"), "a missing instincts section (no available flag of its own) renders as 'not available'");
  assert.ok(summary.includes("Instincts \u00b7 observer"), "instincts title falls back to the bare 'observer' tool name with no model configured");
  assert.ok(summary.includes("Skill observations \u00b7 task-observer"), "/board uses the same renamed title as the sidebar panel");
  assert.ok(summary.includes("Skill evals \u00b7 skill-creator"), "/board uses the same renamed title as the sidebar panel");
  assert.ok(!/[\u2014\u2013]/.test(summary), "/board text never contains an em or en dash");

  const disabledSections = formatBoardSummary(everythingUnavailable, { board: { sections: { instincts: false, observations: false, evals: false } } });
  assert.equal(disabledSections, "No board sections enabled.", "every block can be hidden independently");
}

// ---------------------------------------------------------------------------
// 8. lib/board-text.js: the wording shared by the sidebar panel and
//    /board, exercised directly (pure functions, no ctx needed) across
//    every branch the redesign introduced. `assertShort` enforces the
//    <= 36 character budget on the lines where the fixture data below was
//    chosen to fit it; the instincts run-stats line and the "N inherited"
//    summary are excluded on purpose - both are fixed English wording
//    ("<n> runs, <n> written, <n> rejected \u00b7 next <rel>", "<n>
//    learned, <n> ready to promote, <n> inherited") that cannot drop
//    below ~37-42 characters even with every count at a single digit, so
//    their exact text is still asserted, just not against the bound.
// ---------------------------------------------------------------------------
{
  const { instinctsToolName, instinctsLines, observationsLines, evalsLines } = await import("./lib/board-text.js");

  const assertShort = (lines) => {
    for (const line of lines) assert.ok(line.length <= 36, `line exceeds 36 chars: ${JSON.stringify(line)} (${line.length})`);
  };

  assert.equal(instinctsToolName(null), "observer", "no instincts section at all falls back to 'observer'");
  assert.equal(instinctsToolName({ model: null }), "observer", "no model configured falls back to 'observer'");
  assert.equal(instinctsToolName({ model: "anthropic/claude-haiku-4-5" }), "haiku observer", "a haiku model reads as 'haiku observer'");
  assert.equal(instinctsToolName({ model: "ANTHROPIC/CLAUDE-HAIKU" }), "haiku observer", "the haiku match is case-insensitive");
  assert.equal(instinctsToolName({ model: "anthropic/claude-opus-4-1" }), "claude-opus-4-1", "a non-haiku model reads as its last path segment");
  assert.equal(instinctsToolName({ model: "fakemodel" }), "fakemodel", "a model id with no '/' is used as-is");

  assert.deepEqual(instinctsLines(null), ["not available"], "no instincts section renders a single fallback line");

  const neverRun = instinctsLines({
    project: 9,
    global: 0,
    inherited: 0,
    readyToPromote: 4,
    domains: [
      { name: "workflow", count: 6 },
      { name: "tooling", count: 2 },
    ],
    observerEnabled: true,
    lastRun: null,
    nextRunEligibleAt: null,
  });
  assert.deepEqual(
    neverRun,
    ["9 learned, 4 ready to promote", "workflow 6 \u00b7 tooling 2", "never run yet"],
    "never run yet takes priority over the run-stats wording",
  );
  assertShort(neverRun);

  const withInherited = instinctsLines({
    project: 5,
    global: 0,
    inherited: 2,
    readyToPromote: 1,
    domains: [{ name: "workflow", count: 7 }],
    observerEnabled: true,
    lastRun: new Date().toISOString(),
    nextRunEligibleAt: new Date(Date.now() + 3 * 60000).toISOString(),
    runs: 3,
    written: 4,
    rejected: 1,
  });
  assert.deepEqual(
    withInherited,
    ["7 learned, 1 ready to promote, 2 inherited", "workflow 7", "3 runs, 4 written, 1 rejected \u00b7 next 3m"],
    "inherited > 0 is appended, and the run-stats line always carries '\u00b7 next <rel>' once there is a lastRun",
  );
  assertShort([withInherited[1]]);

  const manyDomains = instinctsLines({
    project: 10,
    global: 0,
    inherited: 0,
    readyToPromote: 0,
    domains: [
      { name: "a", count: 4 },
      { name: "b", count: 3 },
      { name: "c", count: 2 },
      { name: "d", count: 1 },
    ],
    observerEnabled: true,
    lastRun: new Date().toISOString(),
    nextRunEligibleAt: null,
  });
  assert.equal(manyDomains[1], "a 4 \u00b7 b 3 \u00b7 c 2 \u00b7 +1 more", "more than 3 domains collapse to '+N more'");
  assert.equal(manyDomains[2], "0 runs, 0 written", "no nextRunEligibleAt omits the '\u00b7 next' suffix entirely");
  assertShort([manyDomains[1], manyDomains[2]]);

  assert.deepEqual(
    instinctsLines({ project: 5, global: 0, inherited: 0, readyToPromote: 0, domains: [], observerEnabled: false, lastRun: new Date().toISOString() }),
    ["5 learned, 0 ready to promote", "no domains yet", "observer off"],
    "observerEnabled: false always reads 'observer off', even with a lastRun on record",
  );

  assert.deepEqual(observationsLines(null), ["not found"]);
  assert.deepEqual(observationsLines({ available: false }), ["not found"]);

  const observations398 = observationsLines({
    available: true,
    open: 398,
    lastReview: null,
    topSkills: [
      { skill: "review", count: 12 },
      { skill: "testing", count: 4 },
    ],
    addedToday: 3,
    added7d: 9,
    newestAt: new Date(Date.now() - 2 * 3600000).toISOString(),
  });
  assert.deepEqual(
    observations398,
    ["398 open, review never", "review 12 \u00b7 testing 4", "+3 today, +9 this week \u00b7 newest 2h"],
    "no last-review date reads 'review never'",
  );
  assertShort(observations398);

  const longSkillName = observationsLines({
    available: true,
    open: 1,
    lastReview: new Date(Date.now() - 3 * 86400000).toISOString(),
    topSkills: [{ skill: "a-very-long-skill-name-indeed", count: 1 }],
    addedToday: 0,
    added7d: 0,
    newestAt: null,
  });
  assert.equal(longSkillName[0], "1 open, review 3d ago");
  assert.equal(longSkillName[1], "a-very-long-skill-nam\u2026 1", "a skill name over 22 chars is truncated with an ellipsis");
  assert.equal(longSkillName[2], "+0 today, +0 this week \u00b7 newest never", "no newestAt reads 'newest never'");
  assertShort([longSkillName[0], longSkillName[1]]);

  assert.deepEqual(evalsLines(null), ["not found"]);
  assert.deepEqual(evalsLines({ available: false }), ["not found"]);

  const prEval = evalsLines({
    available: true,
    skill: "pr",
    iteration: 2,
    withSkill: 0.92,
    baseline: 0.08,
    baselineKind: "without",
    timestamp: new Date(Date.now() - 2 * 86400000).toISOString(),
    runs: 4,
  });
  assert.deepEqual(
    prEval,
    ["pr, iteration 2 \u00b7 2d old, n=4", "92% with skill, 8% without"],
    "the default/'without_skill' naming reads 'with skill'/'without', with age and run count appended",
  );
  assertShort(prEval);

  assert.deepEqual(
    evalsLines({ available: true, skill: "pr", iteration: 2, withSkill: 0.92, baseline: 0.08, baselineKind: "old" }),
    ["pr, iteration 2", "92% new, 8% old"],
    "the 'old_skill' naming reads 'new'/'old' instead, and with no timestamp/runs the '\u00b7 ...' suffix is omitted entirely",
  );
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

function buildFakeObserverOutput() {
  const valid = `---
id: prefer-functional-components
trigger: "when creating react components"
confidence: 0.7
domain: code-style
---
# Prefer Functional Components

## Action
Use functional components with hooks instead of classes.

## Evidence
- Observed 5 times across this session`;

  // Shares an id with the inherited instinct seeded above, so it must be
  // rejected as a duplicate rather than written.
  const duplicateOfInherited = `---
id: grep-before-edit
trigger: "when editing unfamiliar files"
confidence: 0.6
domain: workflow
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
