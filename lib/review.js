// Automatic, scheduled review of the task-observer skill's own observation
// backlog. When the backlog is due (readReviewGate below), the controller
// spawns a headless OpenCode session through the v2 plugin API
// (ctx.session.create + ctx.session.prompt) that runs the skill's own
// weekly-review procedure against a bounded slice, and tracks that session
// through to completion (ctx.event.subscribe, with a polling fallback).
// Off by default, like every other automatic write/delete this plugin can
// do (see lib/plugin.js's mergeOptions); a human can still trigger one run
// on demand with /skill-review (lib/commands.js) regardless of that flag.
//
// The task-observer workspace (resolveReviewRoot below, the same
// resolution lib/board.js uses for board.observationsRoot) is shared
// across every OpenCode instance on this machine that has this plugin
// installed, so the lock file under skill-observations/.mighty-instincts/
// is a cross-process guard, not merely an in-memory flag: it is created
// with an exclusive `wx` write, and EEXIST means another instance already
// won the race (or is still inside a live lock's timeout window).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readTaskObserverSummary } from "./board-observations.js";
import { resolveObservationsRoot } from "./board.js";
import { parseModelRef } from "./observer.js";
import { PKG_NAME } from "./pkg.js";
import { describeError } from "./util.js";

export const REVIEW_DEFAULTS = {
  enabled: false,
  cadenceDays: 7,
  sliceSize: 10,
  cooldownHours: 24,
  timeoutMinutes: 90,
  startupDelaySeconds: 120,
  pollMinutes: 15,
  model: null,
  agent: null,
  externalDirectories: [],
};

const MS_PER_DAY = 86400000;
const STATE_DIR_NAME = ".mighty-instincts";
const LOCK_FILE_NAME = "review-lock.json";
const RUNS_LOG_NAME = "review-runs.log";
// Mirrors ~/dev/mighty-reviewer/v2.js's own IDLE_EVENTS set (read-only
// reference, not imported): the event names a v2 host's
// ctx.event.subscribe stream uses to mark a session as no longer running.
const IDLE_EVENTS = new Set(["session.idle", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]);
// How often the completion fallback polls ctx.session.get when the host's
// ctx.event API is unavailable; only engaged while a review session is
// actually in flight (see ensureCompletionWatch below).
const FALLBACK_POLL_MS = 60000;

export function resolveReviewRoot(options) {
  return resolveObservationsRoot(options);
}

function stateDir(root) {
  return path.join(root, "skill-observations", STATE_DIR_NAME);
}

function lockFile(root) {
  return path.join(stateDir(root), LOCK_FILE_NAME);
}

function runsLogFile(root) {
  return path.join(stateDir(root), RUNS_LOG_NAME);
}

function lastReviewDateFile(root) {
  return path.join(root, "skill-observations", "last-review-date.txt");
}

async function appendRunsLog(root, line) {
  await fs.mkdir(stateDir(root), { recursive: true });
  await fs.appendFile(runsLogFile(root), `${new Date().toISOString()} ${line}\n`, "utf8");
}

async function readLastReviewFile(root) {
  try {
    return (await fs.readFile(lastReviewDateFile(root), "utf8")).trim();
  } catch {
    return null;
  }
}

function reviewAgeDays(lastReview, now) {
  if (!lastReview || lastReview.toLowerCase() === "never") return Infinity;
  const parsed = Date.parse(lastReview);
  if (Number.isNaN(parsed)) return Infinity;
  return (now - parsed) / MS_PER_DAY;
}

async function readLockState(root, cfg, now) {
  let raw;
  try {
    raw = await fs.readFile(lockFile(root), "utf8");
  } catch {
    return null;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // Corrupt contents: nothing trustworthy left to report, so this is
    // treated the same as a stale lock (replaceable, not live).
    return { live: false, data: null };
  }
  const startedAt = Date.parse(data?.startedAt);
  const live = !Number.isNaN(startedAt) && now - startedAt < cfg.timeoutMinutes * 60000;
  return { live, data };
}

async function readLastAttempt(root) {
  let content;
  try {
    content = await fs.readFile(runsLogFile(root), "utf8");
  } catch {
    return null;
  }
  let latest = null;
  for (const line of content.split("\n")) {
    const match = /^(\S+) started /.exec(line);
    if (!match) continue;
    const parsed = Date.parse(match[1]);
    if (Number.isNaN(parsed)) continue;
    if (!latest || parsed > Date.parse(latest)) latest = match[1];
  }
  return latest;
}

// `open`, `lastReview`, and `lock` are always computed (not short-circuited
// by whichever condition decides `due`) so a caller showing status (the
// /skill-review status argument, or the controller's own status()) always
// has the full picture, not just the first failing reason's own facts.
export async function readReviewGate(root, cfg, now = Date.now()) {
  const merged = { ...REVIEW_DEFAULTS, ...cfg };
  const summary = await readTaskObserverSummary(root);
  const lastReview = summary.lastReview;
  const ageDays = reviewAgeDays(lastReview, now);
  const lockState = await readLockState(root, merged, now);
  const lastAttemptAt = await readLastAttempt(root);
  const cooldownActive = Boolean(lastAttemptAt) && now - Date.parse(lastAttemptAt) < merged.cooldownHours * 3600000;
  const lock = lockState?.live ? lockState.data : null;

  if (summary.open <= 0) {
    return { due: false, reason: "no open observations", open: summary.open, lastReview, lock };
  }
  if (ageDays < merged.cadenceDays) {
    return {
      due: false,
      reason: `last review (${lastReview ?? "never"}) is within the ${merged.cadenceDays}-day cadence`,
      open: summary.open,
      lastReview,
      lock,
    };
  }
  if (lock) {
    return {
      due: false,
      reason: `a review session is already running (locked at ${lock.startedAt})`,
      open: summary.open,
      lastReview,
      lock,
    };
  }
  if (cooldownActive) {
    return {
      due: false,
      reason: `last attempt (${lastAttemptAt}) is within the ${merged.cooldownHours}h cooldown`,
      open: summary.open,
      lastReview,
      lock,
    };
  }
  return { due: true, reason: "due", open: summary.open, lastReview, lock };
}

export function buildReviewPrompt({ root, sliceSize, date }) {
  const logDir = path.join(root, "skill-observations", "observation-log");
  const updatesDir = path.join(root, "skill-updates", date);
  const pendingFile = path.join(root, "skill-updates", "PENDING.md");
  const reportFile = path.join(root, "skill-observations", "review-reports", `${date}.md`);

  return [
    "You are running the task-observer skill's scheduled autonomous review. mighty-instincts spawned this session and nobody is watching it: never ask a question, never wait for input, never use the question tool.",
    "Load the task-observer skill, then load its references/weekly-review.md and follow it in scheduled autonomous mode.",
    `Workspace (pinned, never derive it from the cwd): ${root}. The observation log is ${logDir}/.`,
    `Scope this run to a bounded slice: the ${sliceSize} oldest OPEN observations by id, plus any open observation that restates one of them. Leave every other observation untouched.`,
    `Stage every skill change as a copy under ${updatesDir}/ and record it in ${pendingFile}. Never edit an installed skill file, an AGENTS.md, or anything outside ${root}; this session's permissions deny edits outside the workspace.`,
    "For each reviewed observation set status actioned, declined, parked or superseded with resolved: and resolution: as the procedure says. Anything that needs the owner's decision stays open and is listed under Skipped (needs manual review).",
    `Finish with the procedure's Step 7: write ${date} to ${lastReviewDateFile(root)}, then write the review summary to ${reportFile} (create the directory if missing). Stop once the summary is written.`,
  ].join("\n\n");
}

// Mirrors ~/dev/mighty-reviewer/v2.js's expandHome/toExternalDirectoryResource
// exactly (same glob-detection), reimplemented here rather than imported:
// that repo is read-only reference for this plugin, never a dependency.
function expandHomePath(dir) {
  if (dir === "~") return os.homedir();
  if (dir.startsWith("~/")) return path.join(os.homedir(), dir.slice(2));
  return dir;
}

function toExternalResource(dir) {
  const expanded = expandHomePath(dir);
  if (/[*?[\]{}]/.test(expanded)) return expanded;
  return expanded.endsWith("/") ? `${expanded}*` : `${expanded}/*`;
}

// OpenCode 2 permission rulesets resolve last-match-wins (same note as
// v2.js carries at its buildExternalDirectoryPermissions): the broad deny
// has to be listed first and the narrow allows after it, or the deny's "*"
// would always be the highest-index match.
export function buildReviewPermissions({ root, externalDirectories = [], skillsDirs = [] } = {}) {
  const rootResource = toExternalResource(root);
  const rules = [];

  rules.push({ action: "edit", resource: "*", effect: "deny" });
  rules.push({ action: "edit", resource: rootResource, effect: "allow" });

  rules.push({ action: "external_directory", resource: "*", effect: "deny" });
  rules.push({ action: "external_directory", resource: rootResource, effect: "allow" });
  for (const dir of skillsDirs) {
    if (typeof dir === "string" && dir) rules.push({ action: "external_directory", resource: toExternalResource(dir), effect: "allow" });
  }
  for (const dir of externalDirectories) {
    if (typeof dir === "string" && dir) rules.push({ action: "external_directory", resource: toExternalResource(dir), effect: "allow" });
  }

  // The review procedure's own steps run bash snippets (mkdir -p under the
  // workspace, moving a staged file, and so on), and this session is
  // headless: nobody is there to answer an "ask" permission prompt, so
  // shell itself is allowed outright. The edit deny above and the
  // prompt's own instructions ("never edit an installed skill file...")
  // are the two layers actually keeping a shell command from writing
  // somewhere it should not; shell can still write outside root through
  // means the edit permission does not cover (a redirect, a move), the
  // same trade-off v2.js documents for its own headless review sessions.
  rules.push({ action: "shell", resource: "*", effect: "allow" });

  return rules;
}

async function defaultSkillsDirs() {
  const configDir = path.join(os.homedir(), ".config", "opencode");
  const npmCacheDir = path.join(os.homedir(), ".cache", "opencode", "npm");
  const dirs = [configDir];
  try {
    const real = await fs.realpath(configDir);
    if (real !== configDir) dirs.push(real);
  } catch {
    // Not present (or a broken symlink) on this machine: nothing to add.
  }
  dirs.push(npmCacheDir);
  return dirs;
}

async function createLockFile(root, cfg, data) {
  await fs.mkdir(stateDir(root), { recursive: true });
  try {
    await fs.writeFile(lockFile(root), JSON.stringify(data, null, 2), { encoding: "utf8", flag: "wx" });
    return;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  // Lost the create race, or an old lock is still sitting there: a stale
  // one (older than cfg.timeoutMinutes) is replaced; a live one means
  // another instance is genuinely running a review right now, reported
  // back as the same EEXIST a caller already knows how to handle.
  const state = await readLockState(root, cfg, Date.now());
  if (state?.live) {
    const err = new Error("a review lock is already live");
    err.code = "EEXIST";
    throw err;
  }
  await fs.rm(lockFile(root), { force: true });
  await fs.writeFile(lockFile(root), JSON.stringify(data, null, 2), { encoding: "utf8", flag: "wx" });
}

async function rewriteLockFile(root, data) {
  await fs.mkdir(stateDir(root), { recursive: true });
  await fs.writeFile(lockFile(root), JSON.stringify(data, null, 2), "utf8");
}

async function releaseLockFile(root) {
  try {
    await fs.unlink(lockFile(root));
  } catch {
    // Already gone (a stale lock was replaced, or this run never reached
    // the point of creating one): nothing left to clean up.
  }
}

function extractIdleSessionID(raw) {
  const envelope = raw?.payload ?? raw;
  const source = envelope?.type === "sync" && envelope.syncEvent ? envelope.syncEvent : envelope;
  const type = typeof source?.type === "string" ? source.type.replace(/\.1$/, "") : undefined;
  if (!type || !IDLE_EVENTS.has(type)) return null;
  return source?.data?.sessionID ?? source?.properties?.sessionID ?? null;
}

function isSessionFinished(session) {
  if (!session) return true;
  const status = session.status;
  if (status == null) return false;
  const type = typeof status === "string" ? status : status.type;
  return type !== "running" && type !== "busy" && type !== "working";
}

export function createReviewController(ctx, options, hooks = {}) {
  const cfg = { ...REVIEW_DEFAULTS, ...(options.review ?? {}) };
  const afterRun = typeof hooks.afterRun === "function" ? hooks.afterRun : () => {};
  const reviewRoot = resolveReviewRoot(options);

  let startupTimer = null;
  let scheduleInterval = null;
  let watchdogTimer = null;
  let eventBridgeStop = null;
  let completionPollTimer = null;
  let currentSessionID = null;
  let preRunLastReview = null;
  let skillsDirsPromise = null;

  function skillsDirs() {
    if (!skillsDirsPromise) skillsDirsPromise = defaultSkillsDirs();
    return skillsDirsPromise;
  }

  async function reply(sessionID, text) {
    if (!sessionID) return;
    try {
      await ctx.session.synthetic({ sessionID, text, description: PKG_NAME, delivery: "queue", resume: false });
    } catch (error) {
      console.warn(`[${PKG_NAME}] skill review reply failed`, error);
    }
  }

  function ensureCompletionWatch() {
    if (eventBridgeStop || completionPollTimer) return;
    if (typeof ctx.event?.subscribe === "function") {
      const controller = new AbortController();
      (async () => {
        try {
          for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
            const sessionID = extractIdleSessionID(raw);
            if (sessionID && sessionID === currentSessionID) await handleSessionFinished(sessionID);
          }
        } catch (error) {
          if (!controller.signal.aborted) console.warn(`[${PKG_NAME}] skill review event bridge failed`, error);
        }
      })();
      eventBridgeStop = () => controller.abort();
    } else {
      completionPollTimer = setInterval(() => void pollActiveSession(), FALLBACK_POLL_MS);
      completionPollTimer.unref?.();
    }
  }

  async function pollActiveSession() {
    const id = currentSessionID;
    if (!id) return;
    try {
      const session = await ctx.session.get({ sessionID: id });
      if (isSessionFinished(session)) await handleSessionFinished(id);
    } catch {
      // A missing session (deleted, or the host lost track of it) is also
      // "finished": there is nothing left to poll for.
      await handleSessionFinished(id);
    }
  }

  async function finalizeRun(id, outcome) {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
    try {
      await appendRunsLog(reviewRoot, `finished session ${id}: ${outcome}`);
    } catch (error) {
      console.warn(`[${PKG_NAME}] skill review runs log append failed`, error);
    }
    await releaseLockFile(reviewRoot);
    if (currentSessionID === id) currentSessionID = null;
    try {
      await afterRun();
    } catch (error) {
      console.warn(`[${PKG_NAME}] skill review afterRun hook failed`, error);
    }
  }

  async function handleSessionFinished(id) {
    let outcome = "finished without writing last-review-date";
    try {
      const newLastReview = await readLastReviewFile(reviewRoot);
      if (newLastReview && newLastReview !== preRunLastReview) outcome = `completed, last-review-date now ${newLastReview}`;
    } catch (error) {
      console.warn(`[${PKG_NAME}] skill review outcome check failed`, error);
    }
    await finalizeRun(id, outcome);
  }

  async function handleWatchdog(id) {
    try {
      await ctx.session.interrupt({ sessionID: id });
    } catch (error) {
      console.warn(`[${PKG_NAME}] skill review watchdog interrupt failed`, error);
    }
    await finalizeRun(id, "timed out");
  }

  async function run({ force = false, sessionID: replySessionID = null } = {}) {
    let gate;
    try {
      gate = await readReviewGate(reviewRoot, cfg);
    } catch (error) {
      console.warn(`[${PKG_NAME}] skill review gate check failed`, error);
      const reason = describeError(error);
      await reply(replySessionID, `Skill review not started: ${reason}`);
      return { spawned: false, reason };
    }

    // Force ignores the cadence and cooldown reasons, but a live lock
    // (gate.lock, always computed regardless of which reason decided
    // `due`) still blocks it: two concurrent reviews would fight over the
    // same workspace.
    if (!force && !gate.due) {
      await reply(replySessionID, `Skill review not started: ${gate.reason}`);
      return { spawned: false, reason: gate.reason };
    }
    if (gate.lock) {
      await reply(replySessionID, `Skill review not started: ${gate.reason}`);
      return { spawned: false, reason: gate.reason };
    }

    const startedAt = new Date().toISOString();
    const lockData = { startedAt, sessionID: null, pid: process.pid, host: os.hostname() };
    try {
      await createLockFile(reviewRoot, cfg, lockData);
    } catch (error) {
      const reason = error?.code === "EEXIST" ? "another instance already started a review" : describeError(error);
      if (error?.code !== "EEXIST") console.warn(`[${PKG_NAME}] skill review lock acquire failed`, error);
      await reply(replySessionID, `Skill review not started: ${reason}`);
      return { spawned: false, reason };
    }

    const date = startedAt.slice(0, 10);
    try {
      const modelRef = parseModelRef(cfg.model);
      const created = await ctx.session.create({
        title: "Skill review (mighty-instincts)",
        ...(cfg.agent ? { agent: cfg.agent } : {}),
        ...(modelRef ? { model: modelRef } : {}),
        permissions: buildReviewPermissions({ root: reviewRoot, externalDirectories: cfg.externalDirectories, skillsDirs: await skillsDirs() }),
        metadata: { "mighty-instincts": { kind: "skill-review", startedAt } },
      });
      const id = created?.id ?? created?.data?.id;
      if (!id) throw new Error("ctx.session.create returned no session id");

      preRunLastReview = gate.lastReview;
      await rewriteLockFile(reviewRoot, { ...lockData, sessionID: id });

      await ctx.session.prompt({
        sessionID: id,
        text: buildReviewPrompt({ root: reviewRoot, sliceSize: cfg.sliceSize, date }),
        delivery: "queue",
      });
      await appendRunsLog(reviewRoot, `started session ${id}`);

      currentSessionID = id;
      ensureCompletionWatch();
      watchdogTimer = setTimeout(() => void handleWatchdog(id), cfg.timeoutMinutes * 60000);
      watchdogTimer.unref?.();

      await reply(replySessionID, `Skill review started in session ${id} (slice of ${cfg.sliceSize} oldest open observations).`);
      return { spawned: true, sessionID: id };
    } catch (error) {
      console.warn(`[${PKG_NAME}] skill review spawn failed`, error);
      await releaseLockFile(reviewRoot);
      const reason = describeError(error);
      await reply(replySessionID, `Skill review not started: ${reason}`);
      return { spawned: false, reason };
    }
  }

  return {
    start() {
      if (!cfg.enabled || startupTimer || scheduleInterval) return;
      startupTimer = setTimeout(() => {
        startupTimer = null;
        void run({ force: false });
        scheduleInterval = setInterval(() => void run({ force: false }), cfg.pollMinutes * 60000);
        scheduleInterval.unref?.();
      }, cfg.startupDelaySeconds * 1000);
      startupTimer.unref?.();
    },
    stop() {
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
      if (scheduleInterval) {
        clearInterval(scheduleInterval);
        scheduleInterval = null;
      }
      if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
      if (eventBridgeStop) {
        eventBridgeStop();
        eventBridgeStop = null;
      }
      if (completionPollTimer) {
        clearInterval(completionPollTimer);
        completionPollTimer = null;
      }
    },
    run,
    async status() {
      const gate = await readReviewGate(reviewRoot, cfg);
      return { ...gate, sessionID: currentSessionID ?? gate.lock?.sessionID ?? null };
    },
  };
}
