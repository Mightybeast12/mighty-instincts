// Observer failure backoff, the observer.model-unset block, the
// written-count notify gate, the zero-write damper, and
// lib/plugin.js's validateOptions/DEFAULT_OPTIONS.
// See smoke-test.mjs's own section 2 (createObserver, parseInstinctBlock)
// for the pre-existing threshold/dedupe/notify coverage this file does
// not repeat.
import fs from "node:fs/promises";
import path from "node:path";
import { createObserver, evaluateObserverGate } from "../lib/observer.js";
import { readObserverState, saveObserverState } from "../lib/observer-state.js";
import { resolveProject } from "../lib/project.js";
import { appendObservation } from "../lib/store.js";
import { DEFAULT_OPTIONS, validateOptions } from "../lib/plugin.js";

export async function run({ assert, makeProjectAndData }) {
  await testFailureBackoff({ assert, makeProjectAndData });
  await testAfterRunGating({ assert, makeProjectAndData });
  await testDiskErrorDuringWrite({ assert, makeProjectAndData });
  await testModelUnset({ assert, makeProjectAndData });
  await testZeroWriteDamper({ assert, makeProjectAndData });
  await testWrittenCountNotifyGate({ assert, makeProjectAndData });
  testValidateOptionsAndDefaults({ assert });
  testEvaluateObserverGate({ assert });
}

async function addLines(project, count, offset = 0) {
  for (let i = 0; i < count; i++) {
    await appendObservation(project, {
      event: "tool_start",
      tool: "edit",
      session: "s1",
      agent: "build",
      project_id: project.id,
      project_name: project.name,
      input: `line-${offset + i}`,
    });
  }
}

// Runs `fn` with console.warn replaced by a collector, for a fixture
// that deliberately induces a failure lib/observer.js's own catch
// blocks (maybeRun's, in particular) report through console.warn:
// without this, that expected failure's Error object (and its full
// stack trace) prints into the suite's own output, which reads as a
// crash even though every assertion below still passes. console.warn
// is always restored, even if `fn` throws, so this never changes what
// a real run logs; it only keeps a deliberately induced test failure
// out of the suite's own printed output.
async function withCapturedWarnings(fn) {
  const captured = [];
  const original = console.warn;
  console.warn = (...args) => {
    captured.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
  };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return captured.join("\n");
}

// ---------------------------------------------------------------------------
// 1. Failure backoff: a thrown ctx.generate.text sets failures/nextAttemptAfter
//    and posts one notice; a second maybeRun inside the backoff window never
//    calls the model again; once the window has passed (simulated by writing
//    a past nextAttemptAfter straight into .observer-state.json), it retries,
//    and a success resets the streak.
// ---------------------------------------------------------------------------
async function testFailureBackoff({ assert, makeProjectAndData }) {
  const { projectDir, dataDir } = makeProjectAndData("observer-backoff");
  const options = {
    python: "python3",
    dataDir,
    observer: { enabled: true, model: "fakeprov/fakemodel", runIntervalMinutes: 5, minObservations: 3, maxAnalysisLines: 300, notify: true },
  };
  let generateCalls = 0;
  const syntheticCalls = [];
  const ctx = {
    location: { directory: projectDir },
    generate: {
      text: async () => {
        generateCalls += 1;
        if (generateCalls === 1) throw new Error("the model is unavailable");
        return { text: "<none/>" };
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
  await addLines(project, 3);

  // The model throw below is expected: maybeRun's own catch reports it
  // through console.warn, which would otherwise print the full Error
  // (and its stack) into the suite's own output for a failure this
  // test deliberately causes.
  const firstFailureWarning = await withCapturedWarnings(() => observer.maybeRun("obs-session"));
  assert.equal(generateCalls, 1, "the first maybeRun past threshold calls the model once");
  assert.ok(firstFailureWarning.includes("the model is unavailable"), `the expected failure's console.warn is captured, not printed: ${firstFailureWarning}`);

  const afterFirstFailure = await readObserverState(project.project_dir);
  assert.equal(afterFirstFailure.failures, 1, "one consecutive failure recorded");
  assert.ok(typeof afterFirstFailure.nextAttemptAfter === "string" && !Number.isNaN(Date.parse(afterFirstFailure.nextAttemptAfter)), "nextAttemptAfter is a real timestamp");
  assert.ok(new Date(afterFirstFailure.nextAttemptAfter).getTime() > Date.now(), "nextAttemptAfter is in the future right after the first failure");

  const logContent = await readLog(project.project_dir);
  const failureLines = logContent.split("\n").filter((line) => line.includes("run failed"));
  assert.equal(failureLines.length, 1, "exactly one 'run failed' line logged");
  assert.ok(failureLines[0].includes("attempt 1") && failureLines[0].includes("next after"), `the log line carries the attempt count and the next-attempt time: ${failureLines[0]}`);

  assert.equal(syntheticCalls.length, 1, "exactly one notice posted for the first failure of the streak");
  assert.equal(syntheticCalls[0].resume, false);
  assert.ok(syntheticCalls[0].text.includes("run failed"), "the notice itself carries the failure text");

  // A second maybeRun inside the backoff window never calls the model
  // again, and posts no further notice.
  await observer.maybeRun("obs-session");
  assert.equal(generateCalls, 1, "a second maybeRun still inside the backoff window never calls the model");
  assert.equal(syntheticCalls.length, 1, "still only one notice while backed off");

  // Simulate the window having passed by writing a past nextAttemptAfter
  // straight into .observer-state.json, the same shape a real clock tick
  // would eventually produce.
  const state = await readObserverState(project.project_dir);
  await saveObserverState(project.project_dir, { ...state, nextAttemptAfter: new Date(Date.now() - 1000).toISOString() });

  await observer.maybeRun("obs-session");
  assert.equal(generateCalls, 2, "once the backoff window has passed, maybeRun retries and calls the model again");

  const afterSuccess = await readObserverState(project.project_dir);
  assert.equal(afterSuccess.failures, 0, "a successful run resets the failure streak");
  assert.equal(afterSuccess.nextAttemptAfter, null, "a successful run clears nextAttemptAfter");
  assert.equal(syntheticCalls.length, 1, "the successful retry wrote 0 instincts, so the per-run notify stays suppressed");
}

// ---------------------------------------------------------------------------
// 1a. afterRun (board refresh + forced maintenance) only runs once a run
//     actually reached the model call and completed it: never on a
//     thrown ctx.generate.text call, never on the "no observations"
//     early return, and never on the observer.model-unset early return
//     (those last two never even call the model).
// ---------------------------------------------------------------------------
async function testAfterRunGating({ assert, makeProjectAndData }) {
  // --- a thrown ctx.generate.text call --------------------------------
  {
    const { projectDir, dataDir } = makeProjectAndData("observer-afterrun-throw");
    const options = {
      python: "python3",
      dataDir,
      observer: { enabled: true, model: "fakeprov/fakemodel", runIntervalMinutes: 0, minObservations: 1, maxAnalysisLines: 300, notify: false },
    };
    let shouldThrow = true;
    const ctx = {
      location: { directory: projectDir },
      generate: {
        text: async () => {
          if (shouldThrow) throw new Error("boom");
          return { text: "<none/>" };
        },
      },
      session: { synthetic: async () => ({}) },
    };
    let afterRunCalls = 0;
    const observer = createObserver(ctx, options, { afterRun: async () => { afterRunCalls += 1; } });
    const project = await resolveProject(ctx, options);
    await addLines(project, 1);

    let threw = false;
    try {
      await observer.run("s1", { notify: false });
    } catch (error) {
      threw = true;
      assert.ok(error.message.includes("run failed"), `the re-thrown error carries the streak info: ${error.message}`);
    }
    assert.ok(threw, "run() re-throws after ctx.generate.text throws");
    assert.equal(afterRunCalls, 0, "afterRun is skipped after a run that threw");

    shouldThrow = false;
    await observer.run("s1", { notify: false });
    assert.equal(afterRunCalls, 1, "afterRun runs after a run that reached the model call and completed");
  }

  // --- the "no observations" early return: never reaches the model ---
  {
    const { projectDir, dataDir } = makeProjectAndData("observer-afterrun-empty");
    const options = {
      python: "python3",
      dataDir,
      observer: { enabled: true, model: "fakeprov/fakemodel", runIntervalMinutes: 0, minObservations: 1, maxAnalysisLines: 300, notify: false },
    };
    const ctx = {
      location: { directory: projectDir },
      generate: {
        text: async () => {
          throw new Error("must never be called: there is nothing to analyse");
        },
      },
      session: { synthetic: async () => ({}) },
    };
    let afterRunCalls = 0;
    const observer = createObserver(ctx, options, { afterRun: async () => { afterRunCalls += 1; } });
    await resolveProject(ctx, options); // no observations appended at all

    const summary = await observer.run("s1", { notify: false });
    assert.ok(summary.includes("No observations recorded yet"), "the empty-observations early return still returns its own summary");
    assert.equal(afterRunCalls, 0, "afterRun never fires on a run that found nothing to analyse, so it never forces a board refresh plus a full maintenance sweep for nothing");
  }

  // --- the observer.model-unset early return: never reaches the model
  {
    const { projectDir, dataDir } = makeProjectAndData("observer-afterrun-model-unset");
    const options = {
      python: "python3",
      dataDir,
      observer: { enabled: true, model: undefined, runIntervalMinutes: 0, minObservations: 1, maxAnalysisLines: 300, notify: false },
    };
    const ctx = {
      location: { directory: projectDir },
      generate: {
        text: async () => {
          throw new Error("must never be called: observer.model is unset");
        },
      },
      session: { synthetic: async () => ({}) },
    };
    let afterRunCalls = 0;
    const observer = createObserver(ctx, options, { afterRun: async () => { afterRunCalls += 1; } });
    const project = await resolveProject(ctx, options);
    await addLines(project, 1);

    const summary = await observer.run("s1", { notify: false });
    assert.ok(summary.includes("observer.model"), "the model-unset early return still returns its own sentence");
    assert.equal(afterRunCalls, 0, "afterRun never fires on a run that never reached the model call");
  }
}

// ---------------------------------------------------------------------------
// 1b. A disk error after the model call (writeInstinct's target directory
//     made unwritable) goes through the exact same failure handler as a
//     thrown ctx.generate.text call: the backoff state, the "run failed"
//     log line, and the one-time notice all still happen, even though the
//     model itself returned a perfectly valid block.
// ---------------------------------------------------------------------------
async function testDiskErrorDuringWrite({ assert, makeProjectAndData }) {
  // chmod 0o500 (below) is meaningless to root, which ignores file
  // permission bits entirely, so the write would succeed and this
  // fixture's whole premise (an EACCES disk error) would never happen.
  if (process.getuid?.() === 0) {
    console.log("smoke/observer.mjs: skipping testDiskErrorDuringWrite (running as root, which ignores file permissions)");
    return;
  }

  const { projectDir, dataDir } = makeProjectAndData("observer-disk-error");
  const options = {
    python: "python3",
    dataDir,
    observer: { enabled: true, model: "fakeprov/fakemodel", runIntervalMinutes: 0, minObservations: 1, maxAnalysisLines: 300, notify: true },
  };
  const syntheticCalls = [];
  const validBlock = [
    "<instinct>",
    "---",
    "id: disk-error-habit",
    'trigger: "always test disk errors"',
    "confidence: 0.8",
    "domain: workflow",
    'summary: "Handle disk errors during writes."',
    "---",
    "# Disk Error",
    "",
    "## Action",
    "Do the thing.",
    "</instinct>",
  ].join("\n");
  const ctx = {
    location: { directory: projectDir },
    generate: { text: async () => ({ text: validBlock }) },
    session: {
      synthetic: async (input) => {
        syntheticCalls.push(input);
        return {};
      },
    },
  };
  const project = await resolveProject(ctx, options);
  await addLines(project, 1);

  // The target directory exists but is read-only: writeInstinct's own
  // fs.mkdir(dir, { recursive: true }) is a no-op on an existing
  // directory (so that line alone never fails), but its fs.writeFile for
  // the new instinct's tmp file does, with a permission error, after the
  // model has already returned a fully valid block.
  await fs.mkdir(project.instincts_personal, { recursive: true });
  await fs.chmod(project.instincts_personal, 0o500);

  const observer = createObserver(ctx, options);
  let warning = "";
  try {
    // maybeRun (the background path, same as a thrown ctx.generate.text
    // call): the error is caught and logged internally, never thrown out
    // to the caller, but reported through console.warn, which is
    // expected here and captured instead of printed (see
    // withCapturedWarnings above).
    warning = await withCapturedWarnings(() => observer.maybeRun("s1"));
  } finally {
    await fs.chmod(project.instincts_personal, 0o700);
  }
  assert.ok(
    warning.includes("EACCES") || warning.toLowerCase().includes("permission denied"),
    `the expected write failure's console.warn is captured, not printed: ${warning}`,
  );

  const state = await readObserverState(project.project_dir);
  assert.equal(state.failures, 1, "the write failure is recorded in the backoff state, same as a thrown generate.text call");
  assert.ok(typeof state.nextAttemptAfter === "string" && !Number.isNaN(Date.parse(state.nextAttemptAfter)), "a backoff window is scheduled after the write failure");

  const logContent = await readLog(project.project_dir);
  assert.ok(logContent.includes("run failed"), "the write failure is logged the same way a model failure is");

  assert.equal(syntheticCalls.length, 1, "the write failure also posts the same one-time notice a model failure would");
  assert.ok(syntheticCalls[0].text.includes("run failed"), "the notice carries the write failure text, the same shape a model failure's notice would");
}

// ---------------------------------------------------------------------------
// 2. observer.model unset: the model is never called; the first time
//    thresholds are met, one notice (mentioning observer.model) is posted
//    and state.blocked is recorded; later background triggers stay quiet,
//    but a manual run (notify: true) always gets the same sentence.
// ---------------------------------------------------------------------------
async function testModelUnset({ assert, makeProjectAndData }) {
  const { projectDir, dataDir } = makeProjectAndData("observer-model-unset");
  const options = {
    python: "python3",
    dataDir,
    observer: { enabled: true, model: undefined, runIntervalMinutes: 5, minObservations: 2, maxAnalysisLines: 300, notify: true },
  };
  let modelCalls = 0;
  const syntheticCalls = [];
  const ctx = {
    location: { directory: projectDir },
    generate: {
      text: async () => {
        modelCalls += 1;
        return { text: "<none/>" };
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
  await addLines(project, 2);

  await observer.maybeRun("s1");
  assert.equal(modelCalls, 0, "the model is never called when observer.model is unset");
  assert.equal(syntheticCalls.length, 1, "exactly one notice the first time thresholds are met with no model configured");
  assert.ok(syntheticCalls[0].text.includes("observer.model"), `the notice mentions observer.model: ${syntheticCalls[0].text}`);
  assert.equal(syntheticCalls[0].resume, false);

  const state = await readObserverState(project.project_dir);
  assert.equal(state.blocked, "model-unset", "state records the model-unset block");

  await observer.maybeRun("s1");
  assert.equal(modelCalls, 0);
  assert.equal(syntheticCalls.length, 1, "the background path only ever posts the one-time notice");

  const manualResult = await observer.run("s1", { notify: true });
  assert.equal(modelCalls, 0, "a manual run still never calls the model while observer.model is unset");
  assert.equal(syntheticCalls.length, 2, "manual /instinct-observe gets the same notice again, every time");
  assert.ok(syntheticCalls[1].text.includes("observer.model"));
  assert.ok(manualResult.includes("observer.model"), "/instinct-observe's own reply carries the same sentence");
}

// ---------------------------------------------------------------------------
// 3. The bounded zero-write damper: two completed runs that both wrote 0
//    instincts double the minObservations bar for the next run.
// ---------------------------------------------------------------------------
async function testZeroWriteDamper({ assert, makeProjectAndData }) {
  const { projectDir, dataDir } = makeProjectAndData("observer-damper");
  const options = {
    python: "python3",
    dataDir,
    observer: { enabled: true, model: "fakeprov/fakemodel", runIntervalMinutes: 0, minObservations: 3, maxAnalysisLines: 300, notify: false },
  };
  let modelCalls = 0;
  const ctx = {
    location: { directory: projectDir },
    generate: {
      text: async () => {
        modelCalls += 1;
        return { text: "<none/>" };
      },
    },
    session: { synthetic: async () => ({}) },
  };
  const project = await resolveProject(ctx, options);

  await addLines(project, 5, 0);
  await createObserver(ctx, options).run("s1", { notify: false });
  await addLines(project, 5, 5);
  await createObserver(ctx, options).run("s1", { notify: false });
  assert.equal(modelCalls, 2, "two completed runs, each writing 0");

  const state = await readObserverState(project.project_dir);
  assert.deepEqual(state.lastWrittenCounts, [0, 0], "both zero-write runs tracked in state");

  // Each maybeRun check below uses a brand-new observer instance: the
  // per-instance 30s line-count throttle would otherwise mask the lines
  // just appended (see smoke-test.mjs section 2's own comment on this).
  await addLines(project, 3, 10);
  await createObserver(ctx, options).maybeRun("s1");
  assert.equal(modelCalls, 2, "3 pending is only minObservations, not the doubled 2x bar the damper now requires");

  await addLines(project, 3, 13);
  await createObserver(ctx, options).maybeRun("s1");
  assert.equal(modelCalls, 3, "6 pending clears the doubled bar, so the damper lifts and the run proceeds");
}

// ---------------------------------------------------------------------------
// 4. The per-run notify only posts once written > 0 for a background run
//    (notify left undefined); a manual run (notify: true) always posts.
// ---------------------------------------------------------------------------
async function testWrittenCountNotifyGate({ assert, makeProjectAndData }) {
  const { projectDir, dataDir } = makeProjectAndData("observer-notify-gate");
  const options = {
    python: "python3",
    dataDir,
    observer: { enabled: true, model: "fakeprov/fakemodel", runIntervalMinutes: 0, minObservations: 1, maxAnalysisLines: 300, notify: true },
  };
  let responseText = "<none/>";
  const syntheticCalls = [];
  const ctx = {
    location: { directory: projectDir },
    generate: { text: async () => ({ text: responseText }) },
    session: {
      synthetic: async (input) => {
        syntheticCalls.push(input);
        return {};
      },
    },
  };
  const project = await resolveProject(ctx, options);
  await addLines(project, 1);

  const observer = createObserver(ctx, options);
  await observer.run("s1", {});
  assert.equal(syntheticCalls.length, 0, "a background-style run (notify left undefined) that wrote 0 instincts stays quiet");

  await addLines(project, 1, 1);
  responseText = [
    "<instinct>",
    "---",
    "id: notify-habit",
    'trigger: "always notify on write"',
    "confidence: 0.8",
    "domain: workflow",
    'summary: "Notify when something is written."',
    "---",
    "# Notify",
    "",
    "## Action",
    "Do the thing.",
    "</instinct>",
  ].join("\n");
  await observer.run("s1", {});
  assert.equal(syntheticCalls.length, 1, "once a run writes at least one instinct, the notice is posted");

  // A manual run (notify: true) always posts, even when written is 0.
  responseText = "<none/>";
  await observer.run("s1", { notify: true });
  assert.equal(syntheticCalls.length, 2, "notify: true keeps posting the full reply regardless of how much was written");
}

// ---------------------------------------------------------------------------
// 5. lib/plugin.js's validateOptions: unknown keys, near-miss keys (with a
//    suggestion), wrong types, and a clean bill for valid options; and the
//    new DEFAULT_OPTIONS values themselves.
// ---------------------------------------------------------------------------
function testValidateOptionsAndDefaults({ assert }) {
  assert.equal(DEFAULT_OPTIONS.observer.runIntervalMinutes, 15, "default run interval raised from 5 to 15 minutes");
  assert.equal(DEFAULT_OPTIONS.observer.minObservations, 40, "default minObservations raised from 20 to 40");
  assert.equal(DEFAULT_OPTIONS.observer.maxAnalysisBytes, 32768, "the former hardcoded 64KB analysis cap is now a 32KB option default");

  assert.deepEqual(validateOptions({}), [], "no options at all: nothing to warn about");
  assert.deepEqual(
    validateOptions({ observer: { enabled: true, model: "x/y", runIntervalMinutes: 10, minObservations: 5, maxAnalysisLines: 100, maxAnalysisBytes: 1000, notify: false } }),
    [],
    "a fully valid observer block warns about nothing",
  );

  assert.deepEqual(
    validateOptions({ totallyBogusKey: true }),
    ["unknown option totallyBogusKey"],
    "an unrelated key with no close match warns plainly, with no suggestion",
  );

  assert.deepEqual(
    validateOptions({ observer: { enable: true } }),
    ["unknown option observer.enable (did you mean observer.enabled?)"],
    "a near-miss key suggests the real one",
  );

  assert.deepEqual(
    validateOptions({ observer: { runIntervalMinutes: "10" } }),
    ["observer.runIntervalMinutes should be a number, got string"],
    "a known key with the wrong type warns about the type, not the key",
  );

  assert.deepEqual(
    validateOptions({ board: { sections: { instincct: true } } }),
    ["unknown option board.sections.instincct (did you mean board.sections.instincts?)"],
    "nested group keys (board.sections, evolve.targets, ...) are validated with the same dotted-path suggestion",
  );

  assert.deepEqual(
    validateOptions({ prune: { auto: "yes" } }),
    ["prune.auto should be a boolean, got string"],
    "prune's own keys are covered too",
  );
}

// ---------------------------------------------------------------------------
// 6. evaluateObserverGate: the single pure implementation of the
//    background-run gate, reachable in every one of its own reason
//    states, using DEFAULT_OPTIONS.observer whenever a number is absent
//    from options (never a different hardcoded fallback), and treating
//    runIntervalMinutes: 0 as "no interval" even when lastRunAt is this
//    instant.
// ---------------------------------------------------------------------------
function testEvaluateObserverGate({ assert }) {
  const readyOptions = { observer: { enabled: true, model: "prov/model", runIntervalMinutes: 0, minObservations: 5 } };

  // --- disabled ---------------------------------------------------------
  const disabled = evaluateObserverGate({ state: {}, options: { observer: { enabled: false } }, pendingCount: 1000 });
  assert.equal(disabled.ready, false);
  assert.equal(disabled.reason, "disabled");
  assert.equal(disabled.required, DEFAULT_OPTIONS.observer.minObservations, "required still reflects the default even while disabled");

  // options.observer missing entirely reads the same as enabled: false.
  const noObserverBlock = evaluateObserverGate({ state: {}, options: {}, pendingCount: 1000 });
  assert.equal(noObserverBlock.reason, "disabled");

  // --- backoff ------------------------------------------------------------
  const futureAttempt = new Date(Date.now() + 5 * 60000).toISOString();
  const backoff = evaluateObserverGate({ state: { nextAttemptAfter: futureAttempt }, options: readyOptions, pendingCount: 1000 });
  assert.equal(backoff.ready, false);
  assert.equal(backoff.reason, "backoff");
  assert.equal(backoff.nextAttemptAfter, futureAttempt, "the gate's own nextAttemptAfter is carried through unchanged");

  // A past nextAttemptAfter never blocks.
  const pastAttempt = new Date(Date.now() - 5 * 60000).toISOString();
  const pastBackoff = evaluateObserverGate({ state: { nextAttemptAfter: pastAttempt }, options: readyOptions, pendingCount: 1000 });
  assert.notEqual(pastBackoff.reason, "backoff", "a nextAttemptAfter already in the past never blocks");

  // --- interval -------------------------------------------------------
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60000).toISOString();
  const interval = evaluateObserverGate({
    state: { lastRunAt: fiveMinutesAgo },
    options: { observer: { enabled: true, model: "prov/model", runIntervalMinutes: 15, minObservations: 5 } },
    pendingCount: 1000,
  });
  assert.equal(interval.ready, false);
  assert.equal(interval.reason, "interval");

  // --- runIntervalMinutes: 0 means no interval, even with lastRunAt set
  //     to this very instant: the exact case another lane's own copy of
  //     this gate got wrong by falling back to a nonzero default. -------
  const zeroInterval = evaluateObserverGate({
    state: { lastRunAt: new Date().toISOString() },
    options: readyOptions,
    pendingCount: 1000,
  });
  assert.equal(zeroInterval.ready, true, "runIntervalMinutes: 0 never blocks on the interval, no matter how recent lastRunAt is");
  assert.equal(zeroInterval.reason, "ready");

  // --- pending (not enough) ---------------------------------------------
  const pending = evaluateObserverGate({ state: {}, options: readyOptions, pendingCount: 3 });
  assert.equal(pending.ready, false);
  assert.equal(pending.reason, "pending");
  assert.equal(pending.required, 5);

  // The zero-write damper doubles `required`.
  const dampedPending = evaluateObserverGate({ state: { lastWrittenCounts: [0, 0] }, options: readyOptions, pendingCount: 6 });
  assert.equal(dampedPending.ready, false);
  assert.equal(dampedPending.reason, "pending");
  assert.equal(dampedPending.required, 10, "two zero-write runs double minObservations to 10");
  const dampedReady = evaluateObserverGate({ state: { lastWrittenCounts: [0, 0] }, options: readyOptions, pendingCount: 10 });
  assert.equal(dampedReady.ready, true, "10 pending clears the doubled bar");

  // --- model-unset --------------------------------------------------------
  const modelUnsetOptions = { observer: { enabled: true, model: undefined, runIntervalMinutes: 0, minObservations: 1 } };
  const modelUnset = evaluateObserverGate({ state: { blocked: "model-unset" }, options: modelUnsetOptions, pendingCount: 1000 });
  assert.equal(modelUnset.ready, false);
  assert.equal(modelUnset.reason, "model-unset");

  // The very first time the model is unset (not yet blocked), every
  // other gate still decides the outcome: here they all pass, so this
  // reads "ready", not "model-unset", the same thing thresholdsMet has
  // always done (one run gets through to discover and record the block).
  const modelUnsetFirstTime = evaluateObserverGate({ state: {}, options: modelUnsetOptions, pendingCount: 1000 });
  assert.equal(modelUnsetFirstTime.reason, "ready", "not yet blocked: the model-unset reason only appears once state.blocked already records it");

  // --- ready --------------------------------------------------------------
  const ready = evaluateObserverGate({ state: {}, options: readyOptions, pendingCount: 10 });
  assert.equal(ready.ready, true);
  assert.equal(ready.reason, "ready");
  assert.equal(ready.required, 5);

  // --- defaults used when options omit numbers entirely ------------------
  const onlyEnabledAndModel = { observer: { enabled: true, model: "prov/model" } };
  const defaultedPending = evaluateObserverGate({ state: {}, options: onlyEnabledAndModel, pendingCount: 10 });
  assert.equal(defaultedPending.required, DEFAULT_OPTIONS.observer.minObservations, "minObservations falls back to DEFAULT_OPTIONS.observer, not some other hardcoded number");
  const defaultedInterval = evaluateObserverGate({
    state: { lastRunAt: new Date(Date.now() - 5 * 60000).toISOString() },
    options: onlyEnabledAndModel,
    pendingCount: 1000,
  });
  assert.equal(
    defaultedInterval.reason,
    "interval",
    `runIntervalMinutes falls back to DEFAULT_OPTIONS.observer.runIntervalMinutes (${DEFAULT_OPTIONS.observer.runIntervalMinutes}m), which 5 minutes ago has not cleared`,
  );
}

async function readLog(projectDir) {
  try {
    return await fs.readFile(path.join(projectDir, "observer.log"), "utf8");
  } catch {
    return "";
  }
}
