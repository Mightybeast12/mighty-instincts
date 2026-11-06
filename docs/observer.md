# Observer

This page covers the background instinct-distillation run: events, thresholds, defaults, the model requirement, the backoff table, the zero-write damper, the notify rule, and what gets written where. See [../README.md](../README.md) for the rest of the plugin.

## Defaults

`OBSERVER_DEFAULTS` (`lib/observer.js`):

```json
{
  "enabled": false,
  "runIntervalMinutes": 15,
  "minObservations": 40,
  "maxAnalysisLines": 300,
  "maxAnalysisBytes": 32768,
  "notify": true
}
```

`model` is omitted above: its real default is unset (`undefined`, not `null`), since JSON cannot carry `undefined`. See "The model requirement" below.

The observer is off by default. It is one of two background steps that actually call a model (the other is the headless session `/skill-review` spawns, see [skill-review.md](skill-review.md)); the observer specifically is also the one that writes new instincts, so it stays opt-in even though the maintenance sweep (see [maintenance.md](maintenance.md)) and prompt injection are both on by default.

## The model requirement

`observer.model` must be a `"provider/model"` string (`lib/observer.js` `parseModelRef`). Left unset, a run attempt stops before calling the model, logs and posts a one-time notice, and every later attempt is skipped at the gate until the option is set and the plugin restarted (`lib/observer.js` `handleModelUnset`). The exact notice text (`lib/observer.js` `MODEL_UNSET_MESSAGE`):

> mighty-instincts: learning runs are paused because observer.model is not set. Add "observer": { "model": "<provider>/<model>" } to the plugin options in opencode.json (a cheap model is enough) and restart.

`/instinct observer on` shows the same sentence when enabling finds no model configured (`lib/commands-instinct.js` `verbObserver`). `lib/health.js`'s doctor check flags `observer.enabled: true` with no model the same way (see [board.md](board.md)'s Health block).

## What runs, in order (`lib/observer.js` `runOnceInner`)

Every observed tool call or prompt checks, cheapest first, against `.observer-state.json` (`lib/observer.js` `evaluateObserverGate`):

1. A consecutive-failure backoff (below) has not yet expired.
2. Enough time has passed since the last run (`runIntervalMinutes`, default 15).
3. Enough new observations have piled up since then (`minObservations`, default 40, doubled to 80 once two runs in a row have each written 0 new instincts, until a run writes something again: the "zero-write damper").
4. Once a previous attempt has already discovered `observer.model` is unset, that hold lifts as soon as `observer.model` parses as a valid `provider/model` string again; it does not wait for a run to actually succeed first (in practice this still needs a restart, since nothing in this plugin ever sets `observer.model` itself while running, see "The model requirement" below).

Once every gate passes, the plugin first gives any personal instinct with no `summary:` field (written before 0.7.0, imported, or hand-written) the first sentence of its own `## Action`, without a model call and without touching its body (`lib/observer.js` `backfillMissingSummaries`). Then:

1. Reads the most recent observation lines, capped at `maxAnalysisLines` (default 300) and `maxAnalysisBytes` (default 32768): the tail is read newest-first until that byte budget is spent, then reordered oldest-first before the model sees it (`lib/observer.js` `buildAnalysisView`), plus the existing instinct list (id, trigger, confidence; never the bodies), so the model updates instincts instead of duplicating them.
2. If `observer.model` is still unset at this point, the run stops here (see "The model requirement" above).
3. Calls `ctx.generate.text({ prompt, model })` once, with no tools available to the model (`lib/observer.js`).
4. Parses `<instinct>...</instinct>` blocks out of the response and validates each one (`lib/observer.js` `parseInstinctBlock`): id (pattern `^[a-z0-9][a-z0-9-]{1,63}$`), trigger (rejected outright if it carries a leaked `confidence:`/`domain:`/`scope:`/`source:` fragment), confidence (0 to 1), domain, `summary` (one imperative sentence, required, rejected over 160 characters, trimmed to 120), and no stray `---` in the body.
5. Checks each valid instinct against the existing personal store for a dedupe/merge match (`lib/maintain.js` `dedupeOrMerge`; see "Dedupe thresholds" below).
6. Writes anything left to `instincts/personal/`, except an instinct with confidence `<= 0.5`, which goes to `instincts/pending/` instead (`lib/observer.js` via `classifyNewInstinct`, `lib/maintain.js`): the "50% rule", unproven until it is actually used once.
7. Logs the result to `observer.log`, runs the maintenance sweep, refreshes the board state, and posts a summary into the session when `observer.notify` is true (see "Notify" below).

## Backoff table

A failure anywhere from the model call through the final state save backs off the next attempt (`lib/observer.js` `BACKOFF_STEPS_MS`, `lib/observer.js` `handleRunFailure`):

| Consecutive failure | Next attempt allowed after |
| --- | --- |
| 1st | 5 minutes |
| 2nd | 15 minutes |
| 3rd and every one after | 60 minutes |

A success resets the streak to 0. The first failure of a streak also posts a one-time notice (background run only; a manual `/instinct-observe` or `/instinct observe` gets the same information back as its own reply either way).

## The zero-write damper

Once two runs in a row have each written 0 new instincts, `minObservations` doubles (default 40 -> 80) until a run writes something again (`lib/observer.js`, tracked as `lastWrittenCounts` in `.observer-state.json`).

## Notify rule

`observer.notify` posts a synthetic summary message into the triggering session after a background run. For the background run specifically (not a manual `/instinct-observe`), this is skipped when the run wrote 0 new instincts (`lib/observer.js` `shouldNotify = wantsNotify(...) && (notify === true || written > 0)`); a consecutive-failure notice still posts regardless, once, on the first failure of a streak. A manual trigger (`notify: true`) always gets its reply.

## What is written where

| File | What |
| --- | --- |
| `observer.log` | One line per run: `<iso> run: <N> written, <N> rejected, model <provider/model>`, with ` ids: <id>,<id>,...` and ` rejected: <reason>; ...` suffixes when applicable (`lib/observer.js`). |
| `.observer-state.json` | Last run time, last line count, consecutive failure count, next allowed attempt, the model-unset block flag, and the last two runs' written counts (`lib/observer-state.js`). |
| `instincts/personal/<id>.md` | A newly written, confident-enough instinct. |
| `instincts/pending/<id>.md` | A newly written instinct with confidence `<= 0.5` (the 50% rule). |

See [data-layout.md](data-layout.md) for the full on-disk layout.

## Cost

This is at most one `generate.text` call per interval, on whatever model is set in `observer.model`. `/instinct observe` (and the deprecated `/instinct-observe` alias) run the same logic on demand, bypassing the interval/count/backoff gates (it still needs `observer.model` set, and still stops with the same notice if it is not).
