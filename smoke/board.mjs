// lib/board.js (and its own board-observations.js/board-evals.js/health.js
// helpers): the real promote count, the candidate-preview rows, the
// observer-state-driven hints, the Health block, and the per-file/
// per-directory caches each of those reads through.
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { _boardCacheStats, _resetBoardCaches, refreshBoardState } from "../lib/board.js";
import { resolveProject } from "../lib/project.js";
import { writeInstinct } from "../lib/store.js";
import { writeCandidate } from "../lib/candidates.js";
import { buildInstinctsBlock, buildObservationsBlock, buildHealthBlock } from "../lib/board-text.js";
import { _observationsCacheStats, _resetObservationsCache, readTaskObserverSummary } from "../lib/board-observations.js";
import { readEvalsSummary } from "../lib/board-evals.js";
import { collectHealth, _resetPythonProbeCache } from "../lib/health.js";

export async function run({ assert, makeProjectAndData, TEMP_ROOT }) {
  // -------------------------------------------------------------------------
  // Hint row when the observer is disabled: buildInstinctsBlock reads
  // straight off state.instincts.observerEnabled, so disabling it through
  // a real refreshBoardState call ends up with the same actionable hint
  // row the pure block-builder tests exercise directly.
  // -------------------------------------------------------------------------
  {
    const { projectDir, dataDir } = makeProjectAndData("board-disabled-hint");
    const options = { python: "python3", dataDir, observer: { enabled: false }, board: { enabled: true } };
    const ctx = { location: { directory: projectDir } };
    const state = await refreshBoardState(ctx, options);
    assert.equal(state.instincts.observerEnabled, false);
    const block = buildInstinctsBlock(state.instincts);
    assert.ok(
      block.rows.some((row) => row.hint === "learning off: /instinct observer on (needs observer.model)"),
      "a disabled observer's hint row survives the real board.js -> board-text.js pipeline",
    );
  }

  // -------------------------------------------------------------------------
  // Blocked/failed rows from a seeded .observer-state.json: board.js reads
  // these straight off lib/observer-state.js's own readObserverState
  // (blocked, failures, nextAttemptAfter, lastWrittenCounts), and the
  // model-unset hold and failure backoff both keep nextRunReady from ever
  // reading "ready" while either is in effect.
  // -------------------------------------------------------------------------
  {
    const { projectDir, dataDir } = makeProjectAndData("board-blocked-failed");
    const options = { python: "python3", dataDir, observer: { enabled: true, runIntervalMinutes: 5, minObservations: 5 }, board: { enabled: true } };
    const ctx = { location: { directory: projectDir } };
    const project = await resolveProject(ctx, options);
    await fs.mkdir(project.project_dir, { recursive: true });
    const nextAttemptAfter = new Date(Date.now() + 5 * 60000).toISOString();
    await fs.writeFile(
      path.join(project.project_dir, ".observer-state.json"),
      JSON.stringify({
        lastRunAt: new Date(Date.now() - 3600000).toISOString(),
        lastLineCount: 0,
        lastAttemptAt: new Date().toISOString(),
        failures: 2,
        nextAttemptAfter,
        blocked: null,
        lastWrittenCounts: [],
      }),
      "utf8",
    );
    await fs.writeFile(project.observations_file, Array.from({ length: 50 }, (_, i) => JSON.stringify({ n: i })).join("\n") + "\n", "utf8");

    const state = await refreshBoardState(ctx, options);
    assert.equal(state.instincts.failures, 2);
    assert.equal(state.instincts.nextAttemptAfter, nextAttemptAfter);
    assert.equal(state.instincts.nextRunReady, false, "the failure backoff alone keeps nextRunReady false even though the interval has long elapsed and observations are plentiful");

    const block = buildInstinctsBlock(state.instincts);
    assert.ok(block.rows.some((row) => row.hint === "last learning run failed (2), retry 5m"), "the failures hint names the count and a relative retry time");

    // Now the model-unset hold, on a fresh project (no backoff this time).
    const { projectDir: modelUnsetDir, dataDir: modelUnsetData } = makeProjectAndData("board-model-unset");
    const modelUnsetOptions = { python: "python3", dataDir: modelUnsetData, observer: { enabled: true, runIntervalMinutes: 5, minObservations: 5 }, board: { enabled: true } };
    const modelUnsetCtx = { location: { directory: modelUnsetDir } };
    const modelUnsetProject = await resolveProject(modelUnsetCtx, modelUnsetOptions);
    await fs.mkdir(modelUnsetProject.project_dir, { recursive: true });
    await fs.writeFile(
      path.join(modelUnsetProject.project_dir, ".observer-state.json"),
      JSON.stringify({ lastRunAt: new Date(Date.now() - 3600000).toISOString(), lastLineCount: 0, lastAttemptAt: null, failures: 0, nextAttemptAfter: null, blocked: "model-unset", lastWrittenCounts: [] }),
      "utf8",
    );
    await fs.writeFile(modelUnsetProject.observations_file, Array.from({ length: 50 }, (_, i) => JSON.stringify({ n: i })).join("\n") + "\n", "utf8");
    const modelUnsetState = await refreshBoardState(modelUnsetCtx, modelUnsetOptions);
    assert.equal(modelUnsetState.instincts.blocked, "model-unset");
    assert.equal(modelUnsetState.instincts.nextRunReady, false, "the model-unset hold keeps nextRunReady false even though the interval and observation-count gates both pass");
    const modelUnsetBlock = buildInstinctsBlock(modelUnsetState.instincts);
    assert.ok(modelUnsetBlock.rows.some((row) => row.hint === "learning paused: set observer.model"), "blocked: model-unset gets its own hint row through the real pipeline too");
  }

  // -------------------------------------------------------------------------
  // The real promote count: one instinct qualifies by confidence >= 0.9
  // and fired >= 3 (lib/maintain.js's promoteStep own fired-proven path);
  // a second, lower-confidence instinct with plenty of its own fired count
  // does not, since that path's confidence floor (0.9) is independent of
  // how many times a lower-confidence instinct fired.
  // -------------------------------------------------------------------------
  {
    const { projectDir, dataDir } = makeProjectAndData("board-promote-count");
    const options = { python: "python3", dataDir, board: { enabled: true } };
    const ctx = { location: { directory: projectDir } };
    const project = await resolveProject(ctx, options);
    await writeInstinct(project.instincts_personal, { id: "qualifies", trigger: "t1", confidence: 0.95, domain: "workflow", fired: 5 }, "# Qualifies\n");
    await writeInstinct(project.instincts_personal, { id: "not-confident-enough", trigger: "t2", confidence: 0.6, domain: "workflow", fired: 10 }, "# Not confident\n");

    const state = await refreshBoardState(ctx, options);
    assert.equal(state.instincts.readyToShare, 1, "only the confidence>=0.9-and-fired>=3 instinct qualifies; a merely-often-fired low-confidence one does not");
  }

  // -------------------------------------------------------------------------
  // proposedList and numbered rows from a seeded evolved/ dir: the same
  // 1-based numbering lib/candidates.js's numberCandidates gives /evolve's
  // own picks (proposed first, created asc then id asc, then installed),
  // carried straight through board.js into board-state.json and rendered
  // by board-text.js as "<n> <id> [<kind>], <members> habits: /evolve <n>"
  // rows, plus one combined installed/unused summary line.
  // -------------------------------------------------------------------------
  {
    const { projectDir, dataDir } = makeProjectAndData("board-evolved");
    const options = { python: "python3", dataDir, board: { enabled: true } };
    const ctx = { location: { directory: projectDir } };
    const project = await resolveProject(ctx, options);

    const candidate = (id, status, created, members, kind) => ({
      id,
      kind,
      status,
      created,
      members,
      summary: `Summary for ${id}.`,
      suggested_name: id,
    });
    await writeCandidate(project.evolved_dir, candidate("z-second", "proposed", "2026-01-02T00:00:00.000Z", ["a", "b", "c"], "rule"), "- a rule\n");
    await writeCandidate(project.evolved_dir, candidate("a-first", "proposed", "2026-01-01T00:00:00.000Z", ["d", "e", "f", "g"], "skill"), "# A skill\n");
    await writeCandidate(project.evolved_dir, candidate("installed-one", "installed", "2026-01-03T00:00:00.000Z", ["h", "i", "j"], "command"), "# A command\n");
    await writeCandidate(project.evolved_dir, candidate("archived-one", "archived", "2026-01-04T00:00:00.000Z", ["k", "l", "m"], "skill"), "# Archived\n");

    const state = await refreshBoardState(ctx, options);
    assert.deepEqual(
      state.instincts.proposedList.map((entry) => ({ index: entry.index, id: entry.id, kind: entry.kind, members: entry.members })),
      [
        { index: 1, id: "a-first", kind: "skill", members: ["d", "e", "f", "g"] },
        { index: 2, id: "z-second", kind: "rule", members: ["a", "b", "c"] },
      ],
      "proposedList is ordered created asc then id asc, 1-based, and never includes installed/archived candidates",
    );
    assert.equal(state.instincts.installedFromHabits, 1);

    const block = buildInstinctsBlock(state.instincts);
    const hints = block.rows.filter((row) => "hint" in row).map((row) => row.hint);
    assert.ok(hints.includes("1 a-first [skill], 4 habits: /evolve 1"), `proposed candidate 1's numbered row matches /evolve's own numbering: ${hints.join(" | ")}`);
    assert.ok(hints.includes("2 z-second [rule], 3 habits: /evolve 2"), `proposed candidate 2's numbered row matches /evolve's own numbering: ${hints.join(" | ")}`);
    assert.ok(hints.some((hint) => hint.startsWith("installed from habits 1 ")), "the installed/unused summary folds into one line");
  }

  // -------------------------------------------------------------------------
  // Staged row from a fixture PENDING.md: lib/board-observations.js counts
  // "staged" headings (anything not already installed/consumed/superseded)
  // and board-text.js renders it as its own hint row with the attention
  // glyph, naming the exact PENDING.md path.
  // -------------------------------------------------------------------------
  {
    const taskObserverRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "board-staged-"));
    await fs.mkdir(path.join(taskObserverRoot, "skill-updates"), { recursive: true });
    const pendingPath = path.join(taskObserverRoot, "skill-updates", "PENDING.md");
    await fs.writeFile(
      pendingPath,
      ["# Staged updates", "", "## one: installed", "- done", "", "## two: staged", "- pending", "", "## three: staged", "- pending", ""].join("\n"),
      "utf8",
    );

    const summary = await readTaskObserverSummary(taskObserverRoot);
    assert.equal(summary.staged, 2);
    assert.equal(summary.pendingPath, pendingPath);

    const block = buildObservationsBlock(summary);
    assert.equal(block.glyph, "attention", "a non-zero staged count reads attention even when nothing else about the backlog does");
    assert.ok(block.rows.some((row) => row.hint === `staged skill updates 2: see ${pendingPath}`), "the staged row names the count and the real PENDING.md path");
  }

  // -------------------------------------------------------------------------
  // collectHealth: a bogus python path, a configured-but-missing
  // observationsRoot, and options._warnings passed straight through; and
  // the model-unset warning clears once observer.model is set even though
  // a stale .observer-state.json still says blocked: "model-unset" (it
  // must never latch).
  // -------------------------------------------------------------------------
  {
    _resetPythonProbeCache();
    const bogusPython = path.join(TEMP_ROOT, "no-such-python-binary-at-all");
    const missingRoot = path.join(TEMP_ROOT, "no-such-observations-root");
    const health = await collectHealth({
      options: { python: bogusPython, board: { observationsRoot: missingRoot }, _warnings: ["option 'foo' is not recognised"] },
      project: null,
      observerState: null,
      observationsRoot: missingRoot,
      evalRoots: [],
    });
    assert.ok(health.some((entry) => entry.key === "python" && entry.level === "attention"), "a python binary that cannot even be spawned reads as a health entry");
    assert.ok(
      health.some((entry) => entry.key === "observations-root" && entry.message.includes(missingRoot)),
      "a configured-but-missing observationsRoot reads as its own health entry naming the path",
    );
    assert.ok(health.some((entry) => entry.key === "warning-0" && entry.message === "option 'foo' is not recognised"), "options._warnings entries pass through verbatim");

    // Non-latching: a stale blocked: "model-unset" in observerState must
    // never override the model actually being set right now.
    const clearedHealth = await collectHealth({
      options: { python: "python3", observer: { enabled: true, model: "fakeprov/fakemodel" } },
      observerState: { blocked: "model-unset", failures: 0, nextAttemptAfter: null },
      evalRoots: [],
    });
    assert.ok(!clearedHealth.some((entry) => entry.key === "observer-model"), "the model-unset warning clears as soon as observer.model is set, even with a stale blocked flag on record");

    const stillUnsetHealth = await collectHealth({
      options: { python: "python3", observer: { enabled: true, model: undefined } },
      observerState: null,
      evalRoots: [],
    });
    assert.ok(stillUnsetHealth.some((entry) => entry.key === "observer-model"), "a genuinely unset model still warns with no state involved at all");

    const buildHealthEntries = buildHealthBlock(health);
    assert.equal(buildHealthEntries.available, true);
    assert.equal(buildHealthBlock([]).available, false, "an empty health array reads as unavailable, so the sidebar never shows an empty Health block");
  }

  // -------------------------------------------------------------------------
  // observer state is read once per refresh independent of section
  // toggles: health's own model-unset check must still see the real
  // .observer-state.json even when the instincts section itself is off.
  // -------------------------------------------------------------------------
  {
    const { projectDir, dataDir } = makeProjectAndData("board-health-no-instincts-section");
    const options = {
      python: "python3",
      dataDir,
      observer: { enabled: true, model: undefined },
      board: { enabled: true, sections: { instincts: false, observations: false, evals: false } },
    };
    const ctx = { location: { directory: projectDir } };
    const state = await refreshBoardState(ctx, options);
    assert.equal(state.instincts, undefined, "the instincts section itself is genuinely off");
    assert.ok(state.health?.some((entry) => entry.key === "observer-model"), "Health still sees the real observer config/state even though the instincts section that would normally carry it is disabled");
  }

  // -------------------------------------------------------------------------
  // Caches: an unchanged observations.jsonl and an unchanged homunculus
  // are never re-read on a second refresh; appending to the observations
  // file, or adding a new personal instinct (which changes its containing
  // directory's own mtime), is seen on the very next one.
  // -------------------------------------------------------------------------
  {
    _resetBoardCaches();
    const { projectDir, dataDir } = makeProjectAndData("board-caches");
    const options = { python: "python3", dataDir, board: { enabled: true } };
    const ctx = { location: { directory: projectDir } };
    const project = await resolveProject(ctx, options);
    await fs.writeFile(project.observations_file, Array.from({ length: 5 }, (_, i) => JSON.stringify({ n: i })).join("\n") + "\n", "utf8");

    const first = await refreshBoardState(ctx, options);
    const afterFirst = _boardCacheStats();
    assert.equal(afterFirst.observationLineReads, 1, "the first refresh reads the observations file once");
    assert.equal(afterFirst.promoteReadyReads, 1, "the first refresh computes the real promote count once");
    assert.equal(first.instincts.pendingObservations, 5);

    const second = await refreshBoardState(ctx, options);
    const afterSecond = _boardCacheStats();
    assert.equal(afterSecond.observationLineReads, 1, "a second refresh with nothing changed never re-reads the observations file");
    assert.equal(afterSecond.promoteReadyReads, 1, "a second refresh with nothing changed never re-walks the homunculus for the promote count");
    assert.equal(second.instincts.pendingObservations, 5);

    // A changed observations.jsonl (new size and mtime) is seen on the
    // very next refresh.
    await fs.appendFile(project.observations_file, `${JSON.stringify({ n: "new" })}\n`, "utf8");
    const third = await refreshBoardState(ctx, options);
    assert.equal(_boardCacheStats().observationLineReads, 2, "appending to the observations file busts the cache on the next refresh");
    assert.equal(third.instincts.pendingObservations, 6, "the new line is actually counted, not just the cache invalidated");

    // A newly written instinct changes its personal directory's own
    // mtime, which is part of the promote-ready signature, so the cached
    // count is recomputed (even though, in this fixture, the count itself
    // is still 0: the new instinct is well under the fired-proven path's
    // own confidence floor).
    await writeInstinct(project.instincts_personal, { id: "new-instinct", trigger: "t", confidence: 0.5, domain: "misc" }, "# New\n");
    await refreshBoardState(ctx, options);
    assert.equal(_boardCacheStats().promoteReadyReads, 2, "a new instinct file busts the promote-ready cache on the next refresh");
  }

  // -------------------------------------------------------------------------
  // lib/board-observations.js's own per-file cache: an unchanged
  // observation-log directory is never re-read on a second call, and a
  // file rewritten in place (same name, new content, no rename at all) is
  // still seen on the next one, since the cache key is each file's own
  // (size, mtimeMs), not the containing directory's.
  // -------------------------------------------------------------------------
  {
    _resetObservationsCache();
    const root = fsSync.mkdtempSync(path.join(TEMP_ROOT, "board-obs-cache-"));
    const logDir = path.join(root, "skill-observations", "observation-log");
    await fs.mkdir(logDir, { recursive: true });
    const filePath = path.join(logDir, "0001-open.md");
    await fs.writeFile(filePath, "---\nstatus: open\nskill: [workflow]\n---\nbody\n", "utf8");

    const firstSummary = await readTaskObserverSummary(root);
    assert.equal(firstSummary.open, 1);
    const afterFirst = _observationsCacheStats().frontmatterReads;
    assert.ok(afterFirst >= 1, "the first scan reads the new file's frontmatter at least once");

    const secondSummary = await readTaskObserverSummary(root);
    assert.equal(secondSummary.open, 1);
    assert.equal(_observationsCacheStats().frontmatterReads, afterFirst, "a second scan of the same unchanged file never re-reads its frontmatter");

    // Rewritten in place: same path, no rename, but the content (and so
    // the file's own size/mtime) changes.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fs.writeFile(filePath, "---\nstatus: parked\nskill: [workflow]\n---\nbody changed in place\n", "utf8");
    const thirdSummary = await readTaskObserverSummary(root);
    assert.equal(thirdSummary.open, 0, "an in-place edit (no rename) is still seen on the next scan");
    assert.equal(thirdSummary.parked, 1);
    assert.equal(_observationsCacheStats().frontmatterReads, afterFirst + 1, "the in-place edit busts exactly this one file's own cache entry");
  }

  // -------------------------------------------------------------------------
  // lib/board-evals.js's findBenchmarks is deliberately not cached (a new
  // benchmark can land two directory levels below the root, in a brand
  // new iteration-N directory, without ever touching the root's own
  // mtime): every call re-walks, so a nested addition is always seen,
  // never just on whichever call happens to bust some cache key.
  // -------------------------------------------------------------------------
  {
    const evalRoot = fsSync.mkdtempSync(path.join(TEMP_ROOT, "board-eval-nested-"));
    const firstIterationDir = path.join(evalRoot, "a-workspace", "iteration-1");
    await fs.mkdir(firstIterationDir, { recursive: true });
    await fs.writeFile(
      path.join(firstIterationDir, "benchmark.json"),
      JSON.stringify({
        metadata: { skill_name: "first", timestamp: new Date().toISOString(), evals_run: [1], runs_per_configuration: 1 },
        run_summary: { without_skill: { pass_rate: { mean: 0.1 } }, with_skill: { pass_rate: { mean: 0.9 } } },
      }),
      "utf8",
    );
    const firstResult = await readEvalsSummary([evalRoot]);
    assert.equal(firstResult.skill, "first");

    // A second iteration directory added under the *same* workspace: the
    // workspace directory's own mtime changes, but neither `evalRoot`
    // itself nor any new top-level entry does.
    const secondIterationDir = path.join(evalRoot, "a-workspace", "iteration-2");
    await fs.mkdir(secondIterationDir, { recursive: true });
    await fs.writeFile(
      path.join(secondIterationDir, "benchmark.json"),
      JSON.stringify({
        metadata: { skill_name: "second", timestamp: new Date().toISOString(), evals_run: [1], runs_per_configuration: 1 },
        run_summary: { without_skill: { pass_rate: { mean: 0.2 } }, with_skill: { pass_rate: { mean: 0.95 } } },
      }),
      "utf8",
    );
    const secondResult = await readEvalsSummary([evalRoot]);
    assert.equal(secondResult.skill, "second", "a new iteration directory nested under an existing workspace is seen on the very next call, with no cache to bust");
  }
}
