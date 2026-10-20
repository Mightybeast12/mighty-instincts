// Prompt injection: appends a small `<instincts>` block (trigger + a one-
// line gist of each instinct's `## Action` section) to outgoing prompts
// that look relevant, so the agent sees what this plugin has learned
// without the user having to ask. Deterministic and model-free: this
// reads already-written instinct files only, same as the board; the only
// thing that calls a model is lib/observer.js's distillation run.
import path from "node:path";
import { resolveProject } from "./project.js";
import { resolveHomunculusDir } from "./homunculus-dir.js";
import { listInstincts, readInstinctSummary, bumpFiredCount } from "./store.js";
import { recordApplied } from "./activity.js";
import { PKG_NAME } from "./pkg.js";

export const DEFAULT_INJECT_OPTIONS = { enabled: true, max: 5, minConfidence: 0.8, exclude: [] };

const BLOCK_CHAR_BUDGET = 1200;
const OPEN_TAG = "<instincts>";
const CLOSE_TAG = "</instincts>";
const MIN_WORD_LEN = 5;
const MIN_SHARED_WORDS = 3;
// A trigger that still contains one of these as a "key:" pair almost
// always means frontmatter leaked into the field (a parser bug upstream,
// or a hand-edited instinct file), not a real trigger description; such
// candidates are skipped rather than injected verbatim.
const MALFORMED_TRIGGER_PATTERN = /\b(confidence|domain)\s*:/i;

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

  const registration = await ctx.session.hook("prompt", async (event) => {
    try {
      await handlePrompt(ctx, options, cfg, event);
    } catch (error) {
      console.warn(`[${PKG_NAME}] prompt injection failed`, error);
    }
  });
  return [registration];
}

async function handlePrompt(ctx, options, cfg, event) {
  const metadata = event.metadata ?? {};
  // Never re-inject into a prompt this plugin already injected into, and
  // never inject into an opencode-loop or ulw re-prompt (neither is a
  // fresh user request).
  if (metadata.mightyInstincts || metadata.opencode_loop_v2 || metadata.ulw) return;

  const text = event.prompt?.text;
  if (typeof text !== "string" || text.length === 0) return;

  const project = await resolveProject(ctx, options);
  const pool = await collectPool(project, options);
  if (pool.length === 0) return;

  const selected = selectForInjection(pool, cfg, { onMalformed: warnMalformedTriggerOnce });
  if (selected.length === 0) return;

  const entries = await buildEntries(selected);
  const block = formatInjectionBlock(entries);
  if (!block) return;

  event.prompt.text = `${text}\n\n${block.text}`;
  event.metadata = { ...metadata, mightyInstincts: { injected: block.ids } };

  await recordApplied(project.project_dir, block.ids.length);
  await bumpFiredForMatches(entries, block.ids, text);
}

async function collectPool(project, options) {
  const globalDir = path.join(resolveHomunculusDir(options), "instincts", "personal");
  const [personal, inherited, global] = await Promise.all([
    listInstincts(project.instincts_personal),
    listInstincts(project.instincts_inherited),
    listInstincts(globalDir),
  ]);
  return [
    ...tagSourceDir(personal, project.instincts_personal),
    ...tagSourceDir(inherited, project.instincts_inherited),
    ...tagSourceDir(global, globalDir),
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
      let line = "";
      if (inst.sourceDir) {
        try {
          line = await readInstinctSummary(inst.sourceDir, inst.id);
        } catch {
          line = "";
        }
      }
      return {
        id: inst.id,
        trigger,
        line: line || trigger,
        confidence: Number(inst.confidence) || 0,
        sourceDir: inst.sourceDir,
      };
    }),
  );
}

// Pure, exported for smoke-test.mjs: renders the `<instincts>` block from
// already-built {id, trigger, line} entries (assumed sorted highest
// confidence first), dropping the lowest-confidence entry (the tail of a
// desc-sorted list) until the whole block fits BLOCK_CHAR_BUDGET. Returns
// null when even a single entry cannot fit.
export function formatInjectionBlock(entries) {
  let list = entries.slice();
  while (list.length > 0) {
    const lines = list.map((entry) => `- ${entry.trigger}: ${entry.line}`);
    const text = [OPEN_TAG, ...lines, CLOSE_TAG].join("\n");
    if (text.length <= BLOCK_CHAR_BUDGET) {
      return { text, ids: list.map((entry) => entry.id) };
    }
    list = list.slice(0, -1);
  }
  return null;
}

// Pure, exported for smoke-test.mjs: words of at least MIN_WORD_LEN
// letters/digits, lower-cased, with common long filler words removed.
export function significantWords(text) {
  const matches = String(text ?? "")
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  if (!matches) return new Set();
  return new Set(matches.filter((word) => word.length >= MIN_WORD_LEN && !STOPWORDS.has(word)));
}

export function sharedSignificantWordCount(a, b) {
  const wordsA = significantWords(a);
  const wordsB = significantWords(b);
  let count = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) count += 1;
  }
  return count;
}

async function bumpFiredForMatches(entries, injectedIds, promptText) {
  const injected = new Set(injectedIds);
  await Promise.all(
    entries
      .filter((entry) => injected.has(entry.id) && entry.sourceDir)
      .filter((entry) => sharedSignificantWordCount(entry.trigger, promptText) >= MIN_SHARED_WORDS)
      .map((entry) =>
        bumpFiredCount(entry.sourceDir, entry.id).catch((error) => {
          console.warn(`[${PKG_NAME}] fired-count update failed for ${entry.id}`, error);
        }),
      ),
  );
}
