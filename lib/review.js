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
import { describeError, noticeDescription } from "./util.js";

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
// The title and metadata every review session this controller spawns
// (`run`'s own ctx.session.create call below) carries; also used to
// recognise and exclude a review session (this run's own, or a stale
// earlier one still sitting in the list) as a completion-notice target,
// so a review session is never told about its own completion.
const REVIEW_SESSION_TITLE = "Skill review (mighty-instincts)";
const REVIEW_METADATA_KEY = "mighty-instincts";
const REVIEW_METADATA_KIND = "skill-review";
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

// `open`, `staged`, `lastReview`, and `lock` are always computed (not
// short-circuited by whichever condition decides `due`) so a caller
// showing status (the /skill-review status argument, or the controller's
// own status()) always has the full picture, not just the first failing
// reason's own facts. `staged` is the same PENDING.md heading count
// board-observations.js's own board row reads (readTaskObserverSummary
// is the one place both derive it from), so lib/commands-maintain.js's
// `/skill-review install` listing and the board's staged row never
// disagree on how many updates are waiting.
export async function readReviewGate(root, cfg, now = Date.now()) {
  const merged = { ...REVIEW_DEFAULTS, ...cfg };
  const summary = await readTaskObserverSummary(root);
  const lastReview = summary.lastReview;
  const ageDays = reviewAgeDays(lastReview, now);
  const lockState = await readLockState(root, merged, now);
  const lastAttemptAt = await readLastAttempt(root);
  const cooldownActive = Boolean(lastAttemptAt) && now - Date.parse(lastAttemptAt) < merged.cooldownHours * 3600000;
  const lock = lockState?.live ? lockState.data : null;
  const base = { open: summary.open, staged: summary.staged, lastReview, lock };

  if (summary.open <= 0) {
    return { due: false, reason: "no open observations", ...base };
  }
  if (ageDays < merged.cadenceDays) {
    return {
      due: false,
      reason: `last review (${lastReview ?? "never"}) is within the ${merged.cadenceDays}-day cadence`,
      ...base,
    };
  }
  if (lock) {
    return {
      due: false,
      reason: `a review session is already running (locked at ${lock.startedAt})`,
      ...base,
    };
  }
  if (cooldownActive) {
    return {
      due: false,
      reason: `last attempt (${lastAttemptAt}) is within the ${merged.cooldownHours}h cooldown`,
      ...base,
    };
  }
  return { due: true, reason: "due", ...base };
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

// Re-exported for existing callers: the implementation lives in
// lib/review-install.js now (board-observations.js imports
// listStaged/parsePending from review-install.js, and review-install.js
// needs this very function, so keeping it here would make review.js,
// review-install.js, and board-observations.js import each other in a
// circle; review-install.js has no reason to import anything from this
// module back).
export { resolveLiveSkillsDir } from "./review-install.js";

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

function sessionUpdatedAt(session) {
  const updated = Number(session?.time?.updated);
  if (Number.isFinite(updated)) return updated;
  const created = Number(session?.time?.created);
  return Number.isFinite(created) ? created : 0;
}

// Mirrors lib/inject.js's isChildSession (same parentID check, over
// @opencode/client's SessionInfo shape), applied to a whole session list
// instead of one lookup.
function isTopLevelSession(session) {
  return !(typeof session?.parentID === "string" && session.parentID.length > 0);
}

// True for a session this controller itself spawned for a skill review
// (REVIEW_SESSION_TITLE/REVIEW_METADATA_KIND, set at creation below):
// metadata is the more specific signal (a title match alone could in
// principle coincide with an unrelated session a person named by hand),
// checked first; title is the fallback for a host whose ctx.session.list
// does not return metadata on every entry.
function isReviewSession(session) {
  if (session?.metadata?.[REVIEW_METADATA_KEY]?.kind === REVIEW_METADATA_KIND) return true;
  return session?.title === REVIEW_SESSION_TITLE;
}

// The newest top-level session the host currently lists (ctx.session.list),
// for the scheduled-run completion notice below: nobody necessarily typed
// anything to trigger a scheduled review, so there is no sessionID to
// reply to the way a manual /skill-review's own `reply()` call has one;
// the most recently updated non-child session is the closest stand-in for
// "wherever the owner is probably looking right now". `excludeId` is the
// review session that just finished: it is still top-level and (being the
// session that was just actively working) often the most recently
// updated one, so without this it would end up notifying itself. Any
// *other* review session still lingering in the list (this controller's
// own previous run, title/metadata-tagged but a different id) is excluded
// too, by isReviewSession, for the same reason. Never throws: a host with
// no ctx.session.list, a failing call, or a list with no eligible session
// at all all return null, and the caller logs instead.
async function newestTopLevelSessionID(ctx, excludeId) {
  if (typeof ctx?.session?.list !== "function") return null;
  let result;
  try {
    result = await ctx.session.list({});
  } catch (error) {
    console.warn(`[${PKG_NAME}] skill review completion notice: ctx.session.list failed`, error);
    return null;
  }
  // ctx.session.list may return the array directly or `{ data: [...] }`,
  // the same tolerance lib/inject.js's isChildSession already carries for
  // ctx.session.get.
  const sessions = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : [];
  const eligible = sessions.filter((session) => session?.id !== excludeId && !isReviewSession(session) && isTopLevelSession(session));
  if (eligible.length === 0) return null;
  // The host documents this list as already sorted by most recently
  // updated; sorted again here (by the same time.updated, falling back to
  // time.created) rather than trusting that ordering alone, since nothing
  // about ctx.session.list's own contract guarantees it on every host.
  eligible.sort((a, b) => sessionUpdatedAt(b) - sessionUpdatedAt(a));
  return eligible[0]?.id ?? null;
}

// Posted once a *scheduled* review session finishes (see `run`'s own
// replySessionID == null tracking below): scheduled runs otherwise reply
// to nobody at all, leaving staged skill updates sitting unreported until
// someone happens to run /skill-review status. `staged` comes from the
// same readTaskObserverSummary this module's own readReviewGate reads,
// so this always agrees with board-observations.js's own staged row.
// `finishedId` is the review session that just finished, excluded from
// the candidate list (see newestTopLevelSessionID above): without it,
// the finished review session itself is almost always the most recently
// updated top-level session, and would otherwise be told about its own
// completion.
async function postCompletionNotice(ctx, reviewRoot, finishedId) {
  let staged = 0;
  try {
    staged = (await readTaskObserverSummary(reviewRoot)).staged;
  } catch (error) {
    console.warn(`[${PKG_NAME}] skill review completion notice: staged count read failed`, error);
  }
  const text = `Skill review finished: ${staged} staged update(s) await /skill-review install`;
  const sessionID = await newestTopLevelSessionID(ctx, finishedId);
  if (!sessionID) {
    console.warn(`[${PKG_NAME}] ${text} (no top-level session available to notify)`);
    return;
  }
  try {
    await ctx.session.synthetic({ sessionID, text, description: noticeDescription(text), delivery: "queue", resume: false });
  } catch (error) {
    console.warn(`[${PKG_NAME}] skill review completion notice failed`, error);
  }
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
  let currentRunUnattended = false;
  let preRunLastReview = null;
  let skillsDirsPromise = null;

  function skillsDirs() {
    if (!skillsDirsPromise) skillsDirsPromise = defaultSkillsDirs();
    return skillsDirsPromise;
  }

  async function reply(sessionID, text) {
    if (!sessionID) return;
    try {
      await ctx.session.synthetic({ sessionID, text, description: noticeDescription(text), delivery: "queue", resume: false });
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
    const notifyUnattended = currentRunUnattended;
    await finalizeRun(id, outcome);
    // Only a *scheduled* run (nobody gave `run()` a sessionID to reply to)
    // gets this notice: a manual /skill-review already told the person who
    // typed it that the session started, and its own completion is theirs
    // to check with /skill-review status. `id` (the review session that
    // just finished) is excluded from the candidate list so it is never
    // told about its own completion (see postCompletionNotice).
    if (notifyUnattended) await postCompletionNotice(ctx, reviewRoot, id);
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

    // A review with nothing open to review never starts, force or not:
    // `force` only ever means "ignore the cadence and cooldown", never
    // "ignore reality". gate.open (and gate.reason, always "no open
    // observations" together) are computed unconditionally by
    // readReviewGate, so this check runs ahead of the `!force` branch
    // below, which would otherwise skip straight past it on a forced call.
    if (gate.open <= 0) {
      await reply(replySessionID, `Skill review not started: ${gate.reason}`);
      return { spawned: false, reason: gate.reason };
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
        title: REVIEW_SESSION_TITLE,
        ...(cfg.agent ? { agent: cfg.agent } : {}),
        ...(modelRef ? { model: modelRef } : {}),
        permissions: buildReviewPermissions({ root: reviewRoot, externalDirectories: cfg.externalDirectories, skillsDirs: await skillsDirs() }),
        metadata: { [REVIEW_METADATA_KEY]: { kind: REVIEW_METADATA_KIND, startedAt } },
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
      currentRunUnattended = replySessionID == null;
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
