// Reads skill-creator's benchmark output for the board's Skill evals
// block: the newest `*-workspace/iteration-*/benchmark.json` under the
// configured roots, by mtime. Shape reference: skill-creator writes
// `{ metadata: { skill_name, timestamp, evals_run, runs_per_configuration },
// runs: [{ expectations: [{ text, passed, evidence }] }],
// run_summary: { <config>: { pass_rate: { mean, stddev } }, delta: { pass_rate } } }`
// where <config> keys vary by skill-creator version ("with_skill" vs.
// "without_skill" or "old_skill"); baselineKind records which of the two
// naming conventions the baseline key used, since lib/board-text.js words
// the fact line differently for "old_skill". `runs` is the full per-run,
// per-expectation detail (schemas.md's benchmark.json); some benchmark
// writers omit it and only report `metadata.evals_run`/`runs_per_configuration`,
// so `runs`/`firstFailure` below fall back accordingly.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function defaultEvalRoots() {
  const tmp = process.env.TMPDIR ?? os.tmpdir();
  return [path.join(os.homedir(), ".config", "opencode", "skills"), path.join(tmp, "opencode")];
}

export async function readEvalsSummary(roots) {
  const base = {
    skill: null,
    delta: null,
    withSkill: null,
    baseline: null,
    baselineKind: null,
    iteration: null,
    path: null,
    available: false,
    timestamp: null,
    runs: null,
    firstFailure: null,
    stddev: { with: null, baseline: null },
  };

  const candidates = [];
  for (const root of roots) {
    candidates.push(...(await findBenchmarks(root, 3)));
  }
  if (candidates.length === 0) return base;

  let newest = candidates[0];
  for (const candidate of candidates) {
    if (candidate.mtimeMs > newest.mtimeMs) newest = candidate;
  }

  const parsed = await parseBenchmark(newest.file);
  if (!parsed) return base;
  return { ...parsed, path: newest.file, available: true };
}

// Walks up to `depth` directory levels below `root` looking for a
// "*-workspace" directory, then collects every "iteration-*/benchmark.json"
// directly inside it (a fixed two levels, not subject to the depth cap).
async function findBenchmarks(root, depth) {
  const found = [];
  await walk(root, depth, found);
  return found;
}

async function walk(dir, remaining, found) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name.endsWith("-workspace")) {
      await collectIterations(full, found);
    } else if (remaining > 0) {
      await walk(full, remaining - 1, found);
    }
  }
}

async function collectIterations(workspaceDir, found) {
  let entries;
  try {
    entries = await fs.readdir(workspaceDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("iteration-")) continue;
    const file = path.join(workspaceDir, entry.name, "benchmark.json");
    try {
      const stat = await fs.stat(file);
      found.push({ file, mtimeMs: stat.mtimeMs });
    } catch {
      // No benchmark.json in this iteration directory yet.
    }
  }
}

async function parseBenchmark(file) {
  let data;
  try {
    data = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
  const summary = data?.run_summary ?? {};
  const configKeys = Object.keys(summary).filter((key) => key !== "delta");
  // "without_skill" also starts with "with", so matching that prefix alone
  // would misidentify the baseline as the "with skill" config whenever
  // both config names are present; excluding anything starting with
  // "without" disambiguates the two.
  const withKey = configKeys.find((key) => key.toLowerCase().startsWith("with") && !key.toLowerCase().startsWith("without"));
  const baseKey = configKeys.find((key) => key !== withKey);
  const metadata = data?.metadata ?? {};
  const runs = Array.isArray(data?.runs) ? data.runs : null;

  return {
    skill: metadata.skill_name ?? null,
    withSkill: numberOrNull(summary[withKey]?.pass_rate?.mean),
    baseline: numberOrNull(summary[baseKey]?.pass_rate?.mean),
    baselineKind: baseKey === "old_skill" ? "old" : "without",
    delta: parseDelta(summary.delta?.pass_rate),
    iteration: iterationFromPath(file),
    timestamp: typeof metadata.timestamp === "string" ? metadata.timestamp : null,
    runs: countRuns(runs, metadata),
    firstFailure: findFirstFailure(runs),
    stddev: {
      with: numberOrNull(summary[withKey]?.pass_rate?.stddev),
      baseline: numberOrNull(summary[baseKey]?.pass_rate?.stddev),
    },
  };
}

// `runs.length` when the full per-run array is present (every run of
// every eval, both configurations); otherwise `runs_per_configuration *
// evals_run.length * 2` (the two configurations) when both metadata
// fields are present; null when neither source is available.
function countRuns(runs, metadata) {
  if (Array.isArray(runs)) return runs.length;
  const perConfiguration = Number(metadata?.runs_per_configuration);
  const evalsRun = Array.isArray(metadata?.evals_run) ? metadata.evals_run.length : null;
  if (Number.isFinite(perConfiguration) && evalsRun !== null) return perConfiguration * evalsRun * 2;
  return null;
}

// The first expectation, across every run in file order, whose grading
// says `passed: false`; null when there is no `runs` array or nothing
// failed.
function findFirstFailure(runs) {
  if (!Array.isArray(runs)) return null;
  for (const run of runs) {
    const expectations = Array.isArray(run?.expectations) ? run.expectations : [];
    for (const expectation of expectations) {
      if (expectation?.passed === false) {
        return {
          text: typeof expectation.text === "string" ? expectation.text : null,
          evidence: typeof expectation.evidence === "string" ? expectation.evidence : null,
        };
      }
    }
  }
  return null;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseDelta(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function iterationFromPath(file) {
  const dirName = path.basename(path.dirname(file));
  const match = /^iteration-(\d+)$/.exec(dirName);
  return match ? Number(match[1]) : null;
}
