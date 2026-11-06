// Prompt injection: appends a small `<instincts>` system-context block
// (one summary line per eligible instinct) to every outgoing model
// request, so the agent sees what this plugin has learned without the
// user having to ask, and without ever touching the user's own prompt
// text. Deterministic and model-free: this reads already-written instinct
// files only, same as the board; the only thing that calls a model is
// lib/observer.js's distillation run.
//
// Delivery: `ctx.session.hook("context", ...)` (SessionContext, see
// @opencode/plugin's dist/promise/session.d.ts), not the "prompt" hook.
// "context" fires once per request, right before the model sees it, with
// the already-assembled `system: Array<SystemPart>` and `messages` for
// that request; this plugin pushes one more SystemPart (`{ type: "text",
// text }`) rather than editing `messages` or any prompt text. That makes
// the old per-session "first prompt, then every N" cadence (0.6.0/early
// 0.7.0 drafts) moot: every request gets a freshly computed block from
// whatever instinct files exist right now, so there is no mutable prompt
// text to avoid double-injecting into and no cadence state to track.
import fs from "node:fs/promises";
import path from "node:path";
import { resolveProject, siblingInstinctsDir } from "./project.js";
import { resolveHomunculusDir } from "./homunculus-dir.js";
import { listInstincts, readInstinctSummaryLine, bumpFiredCount } from "./store.js";
import { recordApplied, recordFired } from "./activity.js";
import { readSettings, settingsFilePath } from "./settings.js";
import { PKG_NAME } from "./pkg.js";

export const DEFAULT_INJECT_OPTIONS = { enabled: true, max: 5, minConfidence: 0.8, exclude: [] };

const BLOCK_CHAR_BUDGET = 1200;
const OPEN_LINE = "<instincts> learned habits for this project";
const CLOSE_TAG = "</instincts>";
const MIN_WORD_LEN = 5;
const MIN_SHARED_WORDS = 3;
// Beside .activity.json (lib/activity.js), not inside it: this is a plain
// append-only log for humans eyeballing it, not a counter the board or
// any other code path reads back.
const FIRED_MISS_LOG_FILE = "fired-misses.log";
const FIRED_MISS_LOG_CAP = 200;
// A trigger that still contains one of these as a "key:" pair almost
// always means frontmatter leaked into the field (a parser bug upstream,
// or a hand-edited instinct file), not a real trigger description; such
// candidates are skipped rather than injected verbatim. lib/observer.js's
// parser now rejects a newly-written instinct with this shape outright
// (0.7.0); this stays as a defence for files written before that fix, or
// written by hand.
const MALFORMED_TRIGGER_PATTERN = /\b(confidence|domain|scope|source)\s*:/i;

let warnedMalformedTrigger = false;
function warnMalformedTriggerOnce(inst) {
  if (warnedMalformedTrigger) return;
  warnedMalformedTrigger = true;
  console.warn(`[${PKG_NAME}] skipping instinct with a malformed (frontmatter-looking) trigger: ${inst?.id ?? "(unknown id)"}`);
}

// Common long words that would otherwise count as "significant" by length
// alone; excluded so the fired-word match (see sharedSignificantWordCount)
// reflects real topical overlap rather than shared filler.
const STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "before",
  "being",
  "below",
  "between",
  "could",
  "during",
  "every",
  "first",
  "found",
  "going",
  "never",
  "often",
  "other",
  "really",
  "should",
  "their",
  "there",
  "these",
  "those",
  "through",
  "under",
  "until",
  "where",
  "which",
  "while",
  "would",
]);

export async function registerInject(ctx, options) {
  const cfg = { ...DEFAULT_INJECT_OPTIONS, ...(options.inject ?? {}) };
  if (cfg.enabled === false) return [];

  const registration = await ctx.session.hook("context", async (event) => {
    try {
      await handleContext(ctx, options, cfg, event);
    } catch (error) {
      console.warn(`[${PKG_NAME}] prompt injection failed`, error);
    }
  });
  return [registration];
}

async function handleContext(ctx, options, cfg, event) {
  const project = await resolveProject(ctx, options);
  const message = latestUserMessage(event.messages);

  // Best-effort: an opencode-loop/ulw automated re-prompt is not a fresh
  // user request. The "context" hook has no `metadata` of its own (unlike
  // the "prompt" hook lib/observe.js still uses for observation), so this
  // checks the resulting user Message's own `metadata` field instead
  // (@opencode/ai's Message schema carries one); when a host does not
  // propagate the originating prompt's metadata that far, this simply
  // never trips, and injection runs every turn instead, which is safe
  // either way since nothing here ever mutates what the user sees.
  if (isAutomatedReprompt(message)) return;

  const latestUserText = messageText(message);

  // The "context" hook fires once per request, and a single user turn
  // can produce many requests (one per tool-call step the agent takes
  // before replying), every one of them carrying the same latest user
  // message. Without this dedupe, one prompt followed by 15 tool steps
  // would bump `fired` (and log a fired-miss) 16 times instead of once,
  // and count 16 (instead of 1) applied injections for the same prompt
  // in .activity.json's appliedToday. Injection itself (event.system
  // below) still runs on every request regardless, since the model
  // needs the block on every step, not just the first.
  const isNewPrompt = isNewPromptForSession(event.sessionID, latestUserText);

  // Child sessions (subagents, critics, observers) have their "user"
  // messages written by the orchestrating model, not the human at the
  // keyboard. Those prompts tend to be long and keyword-dense and would
  // match instinct triggers far more often than real human input, so a
  // child session still sees the injected block (useful context for its
  // own model call) but never counts as a human having used a habit.
  const isChild = await isChildSession(ctx, event.sessionID);
  const shouldBumpFired = isNewPrompt && !isChild;

  const pool = await collectPool(project, options);
  const muted = await mutedListCached(project.project_dir);
  const effectiveCfg = muted.length > 0 ? { ...cfg, exclude: mergeExclude(cfg.exclude, muted) } : cfg;

  if (pool.length > 0) {
    const selected = selectForInjection(pool, effectiveCfg, { onMalformed: warnMalformedTriggerOnce });
    if (selected.length > 0) {
      const entries = await buildEntries(selected);
      const block = formatInjectionBlock(entries);
      if (block) {
        if (!Array.isArray(event.system)) event.system = [];
        event.system.push({ type: "text", text: block.text });
        // The "context" hook fires once per request, and one user turn can
        // produce many requests (see isNewPrompt above); appliedToday is a
        // per-day *prompt* counter for the board, not a per-request one, so
        // only the first of those requests (the real new prompt) counts it.
        if (isNewPrompt) await recordApplied(project.project_dir, block.ids.length);
        const firedIds = shouldBumpFired ? await bumpFiredForMatches(project, entries, block.ids, latestUserText) : undefined;
        // Recorded for real, top-level sessions only: a child session
        // (subagent, critic, observer) can burst through many "context"
        // requests in a short span, and recording every one of them into
        // the same bounded per-session map (recordInjected below) would
        // evict a real top-level session's own `why` record purely from
        // that burst, never from the top-level session's own activity.
        if (!isChild) recordInjected(event.sessionID, entries.filter((entry) => block.ids.includes(entry.id)), project, options, firedIds);
      }
    }
  }

  // Pending instincts (lib/maintain.js's "50% rule") are never injected,
  // but still need to accumulate `fired` so lib/maintain.js's
  // graduatePendingStep can promote them to personal once used.
  if (shouldBumpFired) await bumpPendingFired(project, latestUserText);
}

// Merges `/instinct mute`'s persisted ids (lib/settings.js) into the
// configured exclude list for one selectForInjection call, without
// mutating either input array: a muted id is skipped the same way an
// explicitly `inject.exclude`d one already is, whether it lives in this
// project's own personal/inherited store or the shared global one.
function mergeExclude(exclude, muted) {
  const set = new Set(Array.isArray(exclude) ? exclude : DEFAULT_INJECT_OPTIONS.exclude);
  for (const id of muted) set.add(id);
  return [...set];
}

// A Map capped at `cap` entries, evicting the least-recently-touched key
// once a new one would push it past the cap: every `set` (including one
// that overwrites an existing key) moves that key to the most-recently-
// touched end, so a session still active now is never the one evicted
// just because its first entry happened to be inserted long ago. Backs
// every bounded per-session cache in this module (isNewPromptForSession's
// lastSeenPrompt, isChildSession's childSessionCache, recordInjected's
// lastInjectedBySession), so a long-running host process serving many
// sessions never grows any one of them without bound.
function boundedMap(cap) {
  const map = new Map();
  return {
    has(key) {
      return map.has(key);
    },
    get(key) {
      return map.get(key);
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      if (map.size > cap) map.delete(map.keys().next().value);
    },
  };
}

// handleContext's per-turn dedupe: keyed on sessionID, so the SAME latest
// user message seen across many "context" requests within one turn
// (tool-call steps) only counts as "new" once.
const LAST_SEEN_PROMPT_CAP = 200;
const lastSeenPrompt = boundedMap(LAST_SEEN_PROMPT_CAP);

function isNewPromptForSession(sessionID, latestUserText) {
  if (typeof sessionID !== "string" || sessionID.length === 0) return true;
  const isNew = lastSeenPrompt.get(sessionID) !== latestUserText;
  lastSeenPrompt.set(sessionID, latestUserText);
  return isNew;
}

// Whether `sessionID` is a child session (has a parentID), per
// @opencode/client's SessionInfo. A session's parent never changes once
// set, so the answer is cached per sessionID after the first lookup
// (one RPC per session, not per request); bounded the same way as
// lastSeenPrompt above. Any failure (no session.get on this ctx, or the
// RPC itself throwing) is treated as "not a child" so a lookup problem
// never silently disables fired-counting for a real top-level session.
const CHILD_SESSION_CACHE_CAP = 200;
const childSessionCache = boundedMap(CHILD_SESSION_CACHE_CAP);

async function isChildSession(ctx, sessionID) {
  if (!sessionID || typeof ctx?.session?.get !== "function") return false;
  if (childSessionCache.has(sessionID)) return childSessionCache.get(sessionID);
  let isChild = false;
  try {
    const result = await ctx.session.get({ sessionID });
    // ctx.session.get may return the SessionInfo directly or
    // `{ data: SessionInfo }`, depending on the adapter.
    const info = result?.data ?? result;
    isChild = typeof info?.parentID === "string" && info.parentID.length > 0;
  } catch {
    isChild = false;
  }
  childSessionCache.set(sessionID, isChild);
  return isChild;
}

function latestUserMessage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return messages[i];
  }
  return null;
}

function messageText(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function isAutomatedReprompt(message) {
  const metadata = message?.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  return Boolean(metadata.opencode_loop_v2 ?? metadata.ulw);
}

// `/instinct mute`'s persisted list (lib/settings.js's `.settings.json`),
// cached per settings file path and re-read only when the file's own
// mtime changes: a `fs.stat` is cheap enough to do on every "context"
// request, but re-parsing the file every time is not, and this plugin's
// own writes to it (lib/commands-instinct.js's mute/unmute/wrong) always
// go through writeSettings's tmp-then-rename, which always moves the
// file's mtime.
const mutedListCache = new Map(); // settings file path -> { mtimeMs, muted }

async function mutedListCached(projectDir) {
  const file = settingsFilePath(projectDir);
  let mtimeMs;
  try {
    mtimeMs = (await fs.stat(file)).mtimeMs;
  } catch {
    mutedListCache.delete(file);
    return [];
  }
  const cached = mutedListCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.muted;
  const settings = await readSettings(projectDir);
  const muted = Array.isArray(settings.muted) ? settings.muted : [];
  mutedListCache.set(file, { mtimeMs, muted });
  return muted;
}

// The four directories the injection pool is assembled from (this
// project's own personal/inherited stores, the shared global personal
// store, and the pending store firing-without-injecting reads): cached
// per directory, keyed on that directory's own mtimeMs with a
// POOL_CACHE_TTL_MS trust window, so a single turn's several "context"
// requests (one per tool-call step) do not each re-read and re-parse
// every one of them from scratch. A `fs.stat` (cheap) runs on every
// access regardless, so a real change (this plugin's own writes always
// rename-replace a file, which always moves the parent directory's
// mtime) is picked up on the very next access no matter how recently the
// entry was cached; the TTL only bounds how long a mtime-unchanged entry
// is trusted without that re-check being backed by a fresh
// listInstincts() read too, as a defence against a filesystem whose
// mtime resolution is too coarse to tell two back-to-back writes apart.
// `invalidateInjectPool` (lib/commands-instinct.js's own keep/wrong/
// unmute, which rewrite a file under one of these same four directories)
// clears every entry outright, for a guarantee that never depends on
// timestamp resolution at all.
const POOL_CACHE_TTL_MS = 5000;
const poolDirCache = new Map(); // dir -> { mtimeMs, list, expiresAt }
let poolDirReads = 0;

async function cachedListInstincts(dir) {
  let mtimeMs;
  try {
    mtimeMs = (await fs.stat(dir)).mtimeMs;
  } catch {
    // A directory that does not exist yet (inherited/pending stores are
    // never created proactively) has nothing worth caching; listInstincts
    // itself already tolerates the same ENOENT, returning [].
    poolDirCache.delete(dir);
    return listInstincts(dir);
  }
  const now = Date.now();
  const cached = poolDirCache.get(dir);
  if (cached && cached.mtimeMs === mtimeMs && now < cached.expiresAt) return cached.list;

  poolDirReads += 1;
  const list = await listInstincts(dir);
  poolDirCache.set(dir, { mtimeMs, list, expiresAt: now + POOL_CACHE_TTL_MS });
  return list;
}

// Exported for lib/commands-instinct.js: forces the very next read of
// every one of the four pooled directories to bypass this cache
// entirely, so a /instinct keep|wrong|unmute call (each of which
// rewrites a file directly under one of them) is reflected in the next
// injected prompt immediately, rather than whenever this cache's own
// mtime check or TTL would next have noticed on its own.
export function invalidateInjectPool() {
  poolDirCache.clear();
}

// Test seam only (smoke/instinct.mjs): lets a test prove this cache is
// actually skipping the expensive listInstincts() read on a repeat
// access, and actually stops skipping it once invalidateInjectPool() (or
// a real mtime change) forces a fresh one.
export function _injectPoolCacheStats() {
  return { poolDirReads };
}
export function _resetInjectPoolCache() {
  poolDirReads = 0;
  poolDirCache.clear();
}

async function collectPool(project, options) {
  const globalDir = path.join(resolveHomunculusDir(options), "instincts", "personal");
  const [personal, inherited, global] = await Promise.all([
    cachedListInstincts(project.instincts_personal),
    cachedListInstincts(project.instincts_inherited),
    cachedListInstincts(globalDir),
  ]);
  // Promotion copies an instinct to the global store under the same id;
  // the project copy wins, as in instinct-cli.py's load_all_instincts.
  const projectIds = new Set([...personal, ...inherited].map((inst) => inst.id));
  return [
    ...tagSourceDir(personal, project.instincts_personal),
    ...tagSourceDir(inherited, project.instincts_inherited),
    ...tagSourceDir(global.filter((inst) => !projectIds.has(inst.id)), globalDir),
  ];
}

function tagSourceDir(list, dir) {
  return list.map((inst) => ({ ...inst, sourceDir: dir }));
}

// Pure, exported for smoke-test.mjs: given a pool of instinct records
// (each with at least `id`, `trigger`, and `confidence`), picks up to
// `cfg.max` meeting `cfg.minConfidence`, highest confidence first, after
// dropping `cfg.exclude`d ids and any malformed (frontmatter-looking)
// trigger. `onMalformed(inst)`, when given, is called once per skipped
// malformed candidate so the caller can log it; it is never required for
// the filtering itself.
export function selectForInjection(pool, cfg = {}, { onMalformed } = {}) {
  const max = Number.isFinite(cfg.max) && cfg.max > 0 ? cfg.max : DEFAULT_INJECT_OPTIONS.max;
  const minConfidence = Number.isFinite(cfg.minConfidence) ? cfg.minConfidence : DEFAULT_INJECT_OPTIONS.minConfidence;
  const exclude = new Set(Array.isArray(cfg.exclude) ? cfg.exclude : DEFAULT_INJECT_OPTIONS.exclude);
  const warn = typeof onMalformed === "function" ? onMalformed : () => {};

  return pool
    .filter((inst) => !exclude.has(inst.id))
    .filter((inst) => {
      if (!isMalformedTrigger(inst.trigger)) return true;
      warn(inst);
      return false;
    })
    .filter((inst) => (Number(inst.confidence) || 0) >= minConfidence)
    .slice()
    .sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0))
    .slice(0, max);
}

function isMalformedTrigger(trigger) {
  return typeof trigger === "string" && MALFORMED_TRIGGER_PATTERN.test(trigger);
}

async function buildEntries(selected) {
  return Promise.all(
    selected.map(async (inst) => {
      const trigger = typeof inst.trigger === "string" && inst.trigger.length > 0 ? inst.trigger : inst.id;
      let summary = "";
      if (inst.sourceDir) {
        try {
          summary = await readInstinctSummaryLine(inst.sourceDir, inst.id, inst.summary);
        } catch {
          summary = "";
        }
      }
      return {
        id: inst.id,
        trigger,
        summary: summary || trigger,
        confidence: Number(inst.confidence) || 0,
        sourceDir: inst.sourceDir,
      };
    }),
  );
}

// Pure, exported for smoke-test.mjs: renders the `<instincts>` block from
// already-built {id, trigger, summary} entries (assumed sorted highest
// confidence first), dropping the lowest-confidence entry (the tail of a
// desc-sorted list) until the whole block fits BLOCK_CHAR_BUDGET. Returns
// null when even a single entry cannot fit.
export function formatInjectionBlock(entries) {
  let list = entries.slice();
  while (list.length > 0) {
    const lines = list.map((entry) => `- ${entry.summary}`);
    const text = [OPEN_LINE, ...lines, CLOSE_TAG].join("\n");
    if (text.length <= BLOCK_CHAR_BUDGET) {
      return { text, ids: list.map((entry) => entry.id) };
    }
    list = list.slice(0, -1);
  }
  return null;
}

// Pure, exported for smoke-test.mjs and lib/maintain.js: words of at
// least MIN_WORD_LEN letters/digits, lower-cased, with common long filler
// words removed.
export function significantWords(text) {
  const matches = String(text ?? "")
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  if (!matches) return new Set();
  return new Set(matches.filter((word) => word.length >= MIN_WORD_LEN && !STOPWORDS.has(word)));
}

export function sharedSignificantWords(a, b) {
  const wordsA = significantWords(a);
  const wordsB = significantWords(b);
  const shared = [];
  for (const word of wordsA) {
    if (wordsB.has(word)) shared.push(word);
  }
  return shared;
}

export function sharedSignificantWordCount(a, b) {
  return sharedSignificantWords(a, b).length;
}

// Pure, exported for lib/maintain.js and smoke-test.mjs: shared
// significant words as a fraction of the smaller side's own
// significant-word count. Used wherever a match needs to scale with how
// much of the *shorter* text matched (promote's cross-project trigger
// match, dedupe's trigger+summary match, evolve's loose domain
// clustering) rather than a fixed word count, which sharedSignificantWordCount
// (above, used for fired-matching against a whole prompt) intentionally
// still uses.
export function significantWordOverlapRatio(a, b) {
  const wordsA = significantWords(a);
  const wordsB = significantWords(b);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) shared += 1;
  }
  return shared / Math.min(wordsA.size, wordsB.size);
}

// Returns the ids actually bumped (never bumped() === false, which only
// ever means a race against this exact id's own file disappearing
// between the pool read and this write), so lib/commands-instinct.js's
// `/instinct why` can report exactly which habits fired on the latest
// prompt, not just which ones were merely eligible.
async function bumpFiredForMatches(project, entries, injectedIds, latestUserText) {
  const injected = new Set(injectedIds);
  const fired = [];
  await Promise.all(
    entries
      .filter((entry) => injected.has(entry.id) && entry.sourceDir)
      .map(async (entry) => {
        const shared = sharedSignificantWords(entry.trigger, latestUserText);
        if (shared.length >= MIN_SHARED_WORDS) {
          try {
            const bumped = await bumpFiredCount(entry.sourceDir, entry.id);
            if (bumped) {
              await recordFired(project.project_dir, entry.id);
              fired.push(entry.id);
            }
          } catch (error) {
            console.warn(`[${PKG_NAME}] fired-count update failed for ${entry.id}`, error);
          }
        } else if (shared.length > 0) {
          await recordFiredMiss(project.project_dir, entry.id, shared);
        }
      }),
  );
  return fired;
}

// Per-session record of the latest injected block, for `/instinct why`
// (lib/commands-instinct.js): which ids were injected, at what
// confidence, from which of the three source kinds, when, and which of
// them actually fired on the last real prompt (as opposed to merely
// having been eligible). Bounded the same way lastSeenPrompt/
// childSessionCache above are (boundedMap).
const INJECTED_RECORD_CAP = 50;
const lastInjectedBySession = boundedMap(INJECTED_RECORD_CAP); // sessionID -> { ids: [{id, confidence, source}], at, fired: string[] }

// Exported for lib/commands-instinct.js, which labels a `keep`/`wrong`
// target's own source kind the same way: "personal" for this project's
// own store, "inherited" for a copy promoted or imported into it,
// "global" for the shared bucket every project can see, "unknown" for
// anything else (a directory this module never pooled from at all).
export function classifySourceDir(sourceDir, project, options) {
  if (sourceDir === project.instincts_personal) return "personal";
  if (sourceDir === project.instincts_inherited) return "inherited";
  if (sourceDir === path.join(resolveHomunculusDir(options), "instincts", "personal")) return "global";
  return "unknown";
}

// `firedIds`, when given, replaces the record's own `fired` list
// outright (this request actually re-evaluated firing, i.e. a genuine
// new prompt in a non-child session); left undefined (every other
// request within the same turn, see shouldBumpFired above), the
// previous record's `fired` list carries over unchanged, since nothing
// about which ids fired on the *last prompt* changed just because
// another tool-call step happened.
function recordInjected(sessionID, entries, project, options, firedIds) {
  if (typeof sessionID !== "string" || sessionID.length === 0) return;
  const previous = lastInjectedBySession.get(sessionID);
  const record = {
    ids: entries.map((entry) => ({ id: entry.id, confidence: entry.confidence, source: classifySourceDir(entry.sourceDir, project, options) })),
    at: new Date().toISOString(),
    fired: Array.isArray(firedIds) ? firedIds : previous?.fired ?? [],
  };
  lastInjectedBySession.set(sessionID, record);
}

// Exported for lib/commands-instinct.js's `/instinct why`: the latest
// injected-block record for `sessionID`, or null when nothing has ever
// been injected into that session (including a session this process has
// never seen at all).
export function lastInjected(sessionID) {
  return lastInjectedBySession.get(sessionID) ?? null;
}

// Pending instincts (lib/maintain.js's "50% rule") are considered for
// firing on every request, exactly like the main pool, but are never
// added to `event.system`.
async function bumpPendingFired(project, latestUserText) {
  if (typeof latestUserText !== "string" || latestUserText.length === 0) return;
  const pendingDir = siblingInstinctsDir(project, "pending");
  const pending = await cachedListInstincts(pendingDir);
  await Promise.all(
    pending
      .filter((inst) => typeof inst.trigger === "string")
      .map(async (inst) => {
        const shared = sharedSignificantWords(inst.trigger, latestUserText);
        if (shared.length >= MIN_SHARED_WORDS) {
          try {
            const bumped = await bumpFiredCount(pendingDir, inst.id);
            if (bumped) await recordFired(project.project_dir, inst.id);
          } catch (error) {
            console.warn(`[${PKG_NAME}] pending fired-count update failed for ${inst.id}`, error);
          }
        } else if (shared.length > 0) {
          await recordFiredMiss(project.project_dir, inst.id, shared);
        }
      }),
  );
}

// Logs a "near miss": a candidate whose trigger shared 1 or 2 significant
// words with the latest message, just under MIN_SHARED_WORDS, so it never
// actually fired. Purely for tuning MIN_SHARED_WORDS (or the firing rule
// in general) later by eyeballing what almost matched and on which words;
// nothing in this plugin ever reads this log back. Read-modify-write
// rather than a plain append so the file stays capped at
// FIRED_MISS_LOG_CAP lines (oldest dropped first) instead of growing
// unbounded on a long-running project.
//
// Serialized per project directory (firedMissQueues below): a single
// request's bumpFiredForMatches can call this for several near-miss
// entries at once (Promise.all), all against the same shared file; two
// read-modify-writes racing on that one file would otherwise let the
// second overwrite the first's append instead of both landing.
const fileMissQueues = new Map();

async function recordFiredMiss(projectDir, id, words) {
  const previous = fileMissQueues.get(projectDir) ?? Promise.resolve();
  const next = previous.then(() => appendFiredMiss(projectDir, id, words));
  // Queued regardless of outcome, so one failed write never jams every
  // write after it for the rest of the process's lifetime.
  fileMissQueues.set(projectDir, next.catch(() => {}));
  await next;
}

async function appendFiredMiss(projectDir, id, words) {
  try {
    const file = path.join(projectDir, FIRED_MISS_LOG_FILE);
    let existing = "";
    try {
      existing = await fs.readFile(file, "utf8");
    } catch {
      // No log yet: starts empty.
    }
    const lines = existing.split("\n").filter((line) => line.trim().length > 0);
    lines.push(`${new Date().toISOString()} id=${id} count=${words.length} words=${words.join(",")}`);
    const capped = lines.slice(-FIRED_MISS_LOG_CAP);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(file, `${capped.join("\n")}\n`, "utf8");
  } catch (error) {
    console.warn(`[${PKG_NAME}] fired-miss log write failed for ${id}`, error);
  }
}
