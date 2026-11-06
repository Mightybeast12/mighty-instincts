// Slash commands for the maintenance family: `/maintain` (the sweep
// lib/maintain.js's runMaintenance already runs on a timer, now runnable
// on demand, with a dry-run preview that no longer needs two config
// edits and two restarts), `/promote` (replacing instinct-cli.py's own
// passthrough with lib/maintain.js's own cross-project/fired-proof
// promoteStep, which the passthrough's rule disagreed with), and an
// extended `/skill-review` that adds `install`/`undo` on top of the
// existing trigger/status lib/commands.js already registers.
//
// buildMaintenanceCommands returns command definitions in the same shape
// lib/commands.js's own registerCommands assembles through
// ctx.command.transform's `editor.add`; the orchestrator folds this
// module's output in there (replacing CLI_COMMANDS' own `promote` entry
// and commands.js's own buildSkillReviewCommand) rather than this module
// registering anything on its own. `deps.liveSkillsDir` is a test seam
// only (threaded down into lib/review-install.js's own planInstall/
// undoLast): every real caller omits it and `/skill-review install`/
// `undo` resolve the real, symlink-resolved skills directory.
import fs from "node:fs/promises";
import path from "node:path";
import { tokenizeArgv } from "./cli.js";
import { postResult } from "./reply.js";
import {
  MAINTENANCE_DEFAULTS,
  promoteStep,
  pruneStep,
  runMaintenance,
} from "./maintain.js";
import { resolveProject } from "./project.js";
import { resolveReviewRoot } from "./review.js";
import { applyInstall, listStaged, parsePending, planInstall, undoLast } from "./review-install.js";
import { describeError } from "./util.js";

export function buildMaintenanceCommands(ctx, options, deps = {}) {
  const { review, liveSkillsDir } = deps;
  const commands = [buildMaintainCommand(ctx, options), buildPromoteCommand(ctx, options)];
  if (review) commands.push(buildSkillReviewCommand(ctx, options, review, liveSkillsDir));
  return commands;
}

// ------------------------------------------------------------- /maintain

function buildMaintainCommand(ctx, options) {
  return {
    name: "maintain",
    description:
      "Run the maintenance sweep now (promote/prune/decay/evolve/repair/cleanup). `--dry-run` previews every step, including evolve/cleanup regardless of today's weekly/daily gate, without changing anything. `prune [--dry-run]` runs only the pending-instinct prune.",
    async execute({ sessionID, prompt }) {
      const tokens = tokenizeArgv(prompt?.text ?? "");
      const dryRun = tokens.includes("--dry-run");
      try {
        const project = await resolveProject(ctx, options);
        if (tokens[0] === "prune") {
          await postResult(ctx, sessionID, await runPruneOnly(project, dryRun));
          return;
        }
        await postResult(ctx, sessionID, await runFullSweep(options, project, dryRun));
      } catch (error) {
        await postResult(ctx, sessionID, describeError(error));
      }
    },
  };
}

// Exported for lib/commands.js's `/instinct-prune` deprecated alias,
// which needs this same prune-only reply text (with its own deprecation
// notice prefixed) without delegating to `/maintain`'s own execute(),
// which already posts its own un-prefixed reply directly and has
// nothing to return for a caller to prefix.
export async function runPruneOnly(project, dryRun) {
  const lines = [];
  const pruned = await pruneStep(project, { dryRun, log: (line) => lines.push(line) });
  const wouldDelete = lines.filter((line) => line.includes("would delete")).length;
  const summary = dryRun ? `prune: would delete ${wouldDelete}` : `prune: deleted ${pruned}`;
  return [...lines, summary].join("\n");
}

async function runFullSweep(options, project, dryRun) {
  const cfg = { ...MAINTENANCE_DEFAULTS, ...(options.maintenance ?? {}) };
  const lines = [];
  // `force: dryRun` makes a preview cover every step (including evolve
  // and cleanupProjects) regardless of today's own weekly/daily gate;
  // a real (non-dry-run) /maintain still respects those gates, same as
  // the background sweep does. `onLog` already receives the final
  // "run: ..." summary line (lib/maintain.js's own runMaintenance logs
  // it through the same callback as every step), so `lines` alone is
  // the full reply.
  await runMaintenance(options, project, cfg, { dryRun: dryRun ? true : undefined, force: dryRun, onLog: (line) => lines.push(line) });
  return lines.join("\n");
}

// -------------------------------------------------------------- /promote

function buildPromoteCommand(ctx, options) {
  return {
    name: "promote",
    description:
      "Preview (default) or run (`--yes`) promoting project-scoped instincts that qualify to global scope: cross-project corroboration, or confident and proven on its own.",
    async execute({ sessionID, prompt }) {
      const yes = tokenizeArgv(prompt?.text ?? "").includes("--yes");
      try {
        const lines = [];
        const promoted = await promoteStep(options, { dryRun: !yes, log: (line) => lines.push(line) });
        const summary = yes ? `promote: promoted ${promoted}` : `promote: ${lines.length} would be promoted`;
        const body = lines.length > 0 ? lines.join("\n") : "promote: nothing qualifies right now";
        await postResult(ctx, sessionID, `${summary}\n${body}`);
      } catch (error) {
        await postResult(ctx, sessionID, describeError(error));
      }
    },
  };
}

// ---------------------------------------------------------- /skill-review

function buildSkillReviewCommand(ctx, options, review, liveSkillsDir) {
  return {
    name: "skill-review",
    description:
      "Run the task-observer backlog review now (headless session); `status` shows whether one is due or running; `install [n|all]` lists or installs staged skill updates; `undo` reverts the most recently installed one, unconditionally overwriting any hand edit made to the live file since.",
    async execute({ sessionID, prompt }) {
      const tokens = tokenizeArgv(prompt?.text ?? "");
      const sub = tokens[0];
      try {
        if (sub === "status") {
          await postResult(ctx, sessionID, formatReviewStatus(await review.status()));
          return;
        }
        if (sub === "install") {
          await postResult(ctx, sessionID, await handleInstall(options, tokens[1], liveSkillsDir));
          return;
        }
        if (sub === "undo") {
          await postResult(ctx, sessionID, await handleUndo(options, liveSkillsDir));
          return;
        }
        // No subcommand: the same manual trigger lib/commands.js's own
        // buildSkillReviewCommand used (review.run posts its own
        // synthetic started/not-started reply; nothing further here on
        // success, only on a thrown error that never reached that reply).
        await review.run({ force: true, sessionID });
      } catch (error) {
        await postResult(ctx, sessionID, describeError(error));
      }
    },
  };
}

function formatReviewStatus(gate) {
  const lines = [`open: ${gate.open}`, `staged: ${gate.staged}`, `last review: ${gate.lastReview ?? "never"}`, `due: ${gate.due ? "yes" : "no"} (${gate.reason})`];
  if (gate.sessionID) lines.push(`in-flight session: ${gate.sessionID}`);
  return lines.join("\n");
}

async function readStagedEntries(root) {
  const pendingFile = path.join(root, "skill-updates", "PENDING.md");
  let text;
  try {
    text = await fs.readFile(pendingFile, "utf8");
  } catch {
    return [];
  }
  return listStaged(parsePending(text));
}

function formatStagedList(staged) {
  if (staged.length === 0) return "No staged skill updates awaiting install.";
  const lines = ["Staged skill updates awaiting install:"];
  for (const { number, entry } of staged) {
    const label = entry.description ? `${entry.id} (${entry.description})` : entry.id;
    lines.push(`${number}. ${label}`);
  }
  lines.push("", "Install one with `/skill-review install <n>`, or all of them with `/skill-review install all`.");
  return lines.join("\n");
}

function formatPlanRefusal(plan) {
  const lines = [`${plan.id}: refused, not installed`];
  if (plan.reason) lines.push(`  ${plan.reason}`);
  for (const skill of plan.skills) {
    if (skill.ok) continue;
    lines.push(`  ${skill.skill}: ${skill.reason}${skill.diffSummary ? ` (${skill.diffSummary})` : ""}`);
  }
  return lines.join("\n");
}

function formatInstallResult(result) {
  const lines = [`${result.installed ? "installed" : "refused"}`];
  for (const skill of result.skills) {
    if (result.installed) lines.push(`  ${skill.skill}: +${skill.added}/-${skill.removed} lines`);
    else if (!skill.ok) lines.push(`  ${skill.skill}: ${skill.reason}${skill.diffSummary ? ` (${skill.diffSummary})` : ""}`);
  }
  return lines.join("\n");
}

async function handleInstall(options, arg, liveSkillsDir) {
  const root = resolveReviewRoot(options);
  const staged = await readStagedEntries(root);

  if (!arg) return formatStagedList(staged);

  if (arg === "all") {
    if (staged.length === 0) return "No staged skill updates awaiting install.";
    const results = [];
    for (const { entry } of staged) {
      const plan = await planInstall(root, entry, { liveSkillsDir });
      if (!plan.ok) {
        results.push(formatPlanRefusal(plan));
        continue;
      }
      const result = await applyInstall(root, entry, plan);
      results.push(`${entry.id}:\n${formatInstallResult(result)}`);
    }
    return results.join("\n\n");
  }

  const number = Number.parseInt(arg, 10);
  if (!Number.isInteger(number) || number < 1 || number > staged.length) {
    return `/skill-review install: ${arg} is not a valid staged entry number (there ${staged.length === 1 ? "is" : "are"} ${staged.length} staged).`;
  }
  const { entry } = staged[number - 1];
  const plan = await planInstall(root, entry, { liveSkillsDir });
  if (!plan.ok) return formatPlanRefusal(plan);
  const result = await applyInstall(root, entry, plan);
  return `${entry.id}:\n${formatInstallResult(result)}`;
}

async function handleUndo(options, liveSkillsDir) {
  const root = resolveReviewRoot(options);
  const result = await undoLast(root, { liveSkillsDir });
  if (!result.restored) return `/skill-review undo: ${result.reason}`;
  const lines = [`${result.entryId}: undone`];
  for (const skill of result.skills) {
    lines.push(skill.restored ? `  ${skill.skill}: restored from backup` : `  ${skill.skill}: ${skill.reason}`);
  }
  return lines.join("\n");
}
