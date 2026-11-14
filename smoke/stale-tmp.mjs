// lib/maintain.js's cleanStaleTmpStep (the tooling reviewer's backlog B20,
// the sibling of mighty-reviewer's 0.14.0 store prune): the plugin's atomic
// writers name their temporary file `<name>.tmp-<pid>-<ms>-<n>`
// (lib/store.js uniqueSuffix), and a write that dies before its rename
// leaves one behind. Maintenance removes those older than an hour in the
// store's root, the project's folder, its evolved folder and its instinct
// folders (personal, inherited, pending, archive), and only those: a fresh
// one (a write in flight), a file of another shape (an owner's
// `report.tmp-2026-11-14` included), a folder and a symlink stay. A dry run
// removes nothing. The removals are logged and counted apart, never in
// the run line's `cleaned`, which keeps meaning stale projects (the
// critic's P3s on f21eb8e..b49551d).
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { MAINTENANCE_DEFAULTS, runMaintenance } from "../lib/maintain.js";

export async function run({ assert, TEMP_ROOT }) {
  const root = path.join(TEMP_ROOT, "stale-tmp");
  await fs.rm(root, { recursive: true, force: true });
  const home = path.join(root, "homunculus");
  const projectDir = path.join(home, "projects", "p-stale");
  const project = {
    id: "p-stale",
    name: "p-stale",
    root: path.join(root, "repo"),
    project_dir: projectDir,
    instincts_personal: path.join(projectDir, "instincts", "personal"),
    instincts_inherited: path.join(projectDir, "instincts", "inherited"),
    evolved_dir: path.join(projectDir, "evolved"),
    observations_file: path.join(projectDir, "observations.jsonl"),
  };
  const pendingDir = path.join(projectDir, "instincts", "pending");
  const archiveDir = path.join(projectDir, "instincts", "archive");
  for (const dir of [project.instincts_personal, project.instincts_inherited, pendingDir, archiveDir, project.evolved_dir, project.root]) await fs.mkdir(dir, { recursive: true });

  const twoHoursAgo = Date.now() - 2 * 3600 * 1000;
  const plant = async (file, mtimeMs, content = "{") => {
    await fs.writeFile(file, content);
    await fs.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
    return file;
  };
  const stale = [
    await plant(path.join(projectDir, `.observer-state.json.tmp-111-${twoHoursAgo}-1`), twoHoursAgo),
    await plant(path.join(project.evolved_dir, `.workflow-0000aaaa.md.tmp-222-${twoHoursAgo}-2`), twoHoursAgo),
    await plant(path.join(home, `.projects.json.tmp-333-${twoHoursAgo}-3`), twoHoursAgo),
    await plant(path.join(projectDir, `board-state.json.tmp-444-${twoHoursAgo}-4`), twoHoursAgo),
    await plant(path.join(project.instincts_personal, `.some-instinct.md.tmp-881-${twoHoursAgo}-1`), twoHoursAgo),
    await plant(path.join(project.instincts_inherited, `.other.md.tmp-882-${twoHoursAgo}-2`), twoHoursAgo),
    await plant(path.join(pendingDir, `.waiting.md.tmp-883-${twoHoursAgo}-3`), twoHoursAgo),
    await plant(path.join(archiveDir, `.old.md.tmp-884-${twoHoursAgo}-4`), twoHoursAgo),
  ];
  const kept = [
    await plant(path.join(projectDir, `.usage.json.tmp-555-${Date.now()}-5`), Date.now()),
    await plant(path.join(projectDir, "notes.tmp"), twoHoursAgo),
    await plant(path.join(projectDir, "observer-state.json.tmp"), twoHoursAgo),
    await plant(path.join(projectDir, "report.tmp-2026-11-14"), twoHoursAgo),
    await plant(path.join(project.evolved_dir, "workflow-0000aaaa.md"), twoHoursAgo, "---\n"),
  ];
  const dirLike = path.join(projectDir, `.dir.tmp-666-${twoHoursAgo}-6`);
  await fs.mkdir(dirLike);
  await fs.utimes(dirLike, twoHoursAgo / 1000, twoHoursAgo / 1000);
  // Old itself (lutimes), so only the regular-file check keeps it.
  const linkLike = path.join(projectDir, `.link.tmp-777-${twoHoursAgo}-7`);
  fsSync.symlinkSync(kept[1], linkLike);
  await fs.lutimes(linkLike, twoHoursAgo / 1000, twoHoursAgo / 1000);

  const only = { ...MAINTENANCE_DEFAULTS, promote: false, prune: false, decay: false, dedupe: false, evolve: false, repair: false, cleanupProjects: false };
  const dry = await runMaintenance({ dataDir: home }, project, { ...only, dryRun: true });
  assert.equal(dry.tmpRemoved, stale.length, `a dry run counts the stale files apart: ${dry.tmpRemoved}`);
  assert.equal(dry.cleaned, 0, "and never in cleaned, which counts stale projects");
  for (const file of stale) assert.ok(fsSync.existsSync(file), `and removes none of them: ${path.basename(file)}`);

  const counts = await runMaintenance({ dataDir: home }, project, only);
  assert.equal(counts.tmpRemoved, stale.length, `maintenance counts the stale temporary files it removed: ${counts.tmpRemoved}`);
  assert.equal(counts.cleaned, 0, "and leaves cleaned to stale projects");
  for (const file of stale) assert.ok(!fsSync.existsSync(file), `a stale temporary file of the plugin's own shape is removed: ${path.basename(file)}`);
  for (const file of kept) assert.ok(fsSync.existsSync(file), `a fresh one, or a file of another shape, stays: ${path.basename(file)}`);
  assert.ok(fsSync.existsSync(dirLike), "a folder with that name stays");
  assert.ok(fsSync.lstatSync(linkLike).isSymbolicLink(), "and so does a symlink with that name");
  const logText = await fs.readFile(path.join(projectDir, "maintenance.log"), "utf8");
  assert.ok(logText.includes("removed stale temporary file"), "the maintenance log names each removal");
  assert.ok(/run: promoted 0, archived 0, merged 0, pruned 0, candidates 0, repaired 0, cleaned 0/.test(logText), "the run line's cleaned stays 0");
  await fs.rm(root, { recursive: true, force: true });
}
