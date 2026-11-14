# Board

This page covers the sidebar board panel and the `/board` chat summary: every row, glyph, hint, and the Health block. See [../README.md](../README.md) for the rest of the plugin.

## What writes it, and how often

The server half (`lib/board.js`) computes a per-project `board-state.json` on plugin setup, after every observer run, and on a timer (`board.refreshSeconds`, default 30 seconds). The TUI sidebar panel polls that same file every 1 second; `/board` reads it fresh on request. Both the sidebar panel (`sidebar.js`) and `/board` (`lib/commands.js`'s `buildBoardCommand`, `lib/board-format.js`) render from the exact same block model (`lib/board-text.js`), so the two never disagree about what a given state means. They just say it differently: the sidebar is a dot-aligned 36-column panel, `/board` is a short, explanatory chat paragraph per block.

## Glyphs

Every block has a status circle (`lib/board-text.js` `GLYPH_CHAR`):

| Glyph | Meaning |
| --- | --- |
| `\u25cf` solid (active colour) | Active and healthy. |
| `\u25cf` solid (attention colour) | Needs attention. |
| `\u25cb` hollow | Stale: no data yet, or too old to trust. |

The legend row at the bottom of an expanded panel (`lib/board-text.js` `LEGEND`) spells all three out.

## The sidebar layout

Fully expanded, the panel reads like this (`lib/board.js` builds the facts, `lib/board-text.js` builds the rows, `sidebar.js` lays them out as boxes):

```
▾ Mighty Instincts v0.12.0
  ▾ Learned habits               ● 16
      habits in prompts               6
      used today / this week      2 / 9
      ready to share globally         4
        /promote
      next learning run            in 3m
      1 shell-safety-habits [rule], 3 habits: /evolve 1
      installed from habits            1 (0 unused): /evolve
  ▾ Skill notes                  ● 398
      open                           398
      added this week                158
      last reviewed                 never
  ▾ Skill test (pr)               ○ 2d
      new                           100%
      old                           100%
      verdict                   saturated
  ▾ Health                        ● 1
      observer enabled with no model: set observer.model
```

The panel header and every block title are clickable, collapsing the whole panel or just that block down to one line; the header also shows the installed version (`lib/pkg.js`'s `PKG_VERSION`). A Health row only ever appears when `collectHealth` actually found something to flag (`lib/board-text.js` `buildHealthBlock`); a project with nothing misconfigured never shows that block at all.

## Rows, by block

### Learned habits (`lib/board-text.js` `buildInstinctsBlock`)

| Row | Meaning |
| --- | --- |
| headline count | Every instinct this project can see: project + inherited + global (`lib/board.js`). |
| **habits in prompts** | A live eligibility count for injection right now: confidence `>= inject.minConfidence`, not excluded, not pending (`lib/board.js`, reusing `lib/inject.js`'s own `selectForInjection`). Not a per-day tally; it can rise or fall between refreshes as instincts are learned, decayed, or promoted. |
| **used today / this week** | How many times an included or still-pending instinct's trigger actually matched something typed today, and the same total summed over the last 7 days (`lib/activity.js`'s `firedToday`/`firedThisWeek`). |
| **ready to share globally** | The real cross-project `promoteStep` dry-run count (`lib/board.js` `countPromoteReady`/`countPromoteReadyCached`), not a confidence-only guess: nonzero here is exactly how many instincts `/promote` would copy right now. Shows a `/promote` hint when nonzero (`lib/board-text.js`). |
| **next learning run** | One of several states, see "Next learning run" below (`lib/board-text.js`). |
| numbered candidate rows | Up to 3 of the still-`proposed` evolve candidates (`PROPOSED_ROWS_SHOWN`, `lib/board-text.js`), each `<n> <id> [<kind>], <count> habits: /evolve <n>`; `<n>` is a valid `/evolve <n>` pick right away. |
| **installed from habits** | How many candidates are installed as a real skill, command, agent, or AGENTS.md rule, with how many of those have had zero uses in `prune.unusedDays` days (default 30) in parentheses (`lib/board-text.js`). |
| **awaiting first use** | Instincts the observer was not confident enough about to call "learned" yet (the 50% rule; see [observer.md](observer.md)); they graduate once used once (`lib/board-text.js`). |
| **kept tidy** | What the maintenance loop did in the last 7 days: `promoted`, `archived`, `merged`, `pruned`, `candidates`, `repaired`, `cleaned`, whichever are nonzero (`lib/board-text.js` `formatKeptTidy`). |
| top-habits rows | The top 5 instincts this project trusts most, by confidence, `<pct>% <id>` (`TOP_HABITS_SHOWN`, `lib/board-text.js`). |

#### Next learning run

Reads one of (`lib/board-text.js`):

- `ready`, once both the interval and the observation-count gates have cleared.
- `in <duration>`, while only the interval is still outstanding.
- `after N more events (M so far)`, once the interval has elapsed but not enough new activity has accumulated yet.
- `learning off: /instinct observer on (needs observer.model)`, while `observer.enabled` is `false`.
- `learning paused: set observer.model`, once a run has discovered the model option is unset.
- `last learning run failed (N), retry <relative>`, after a consecutive `generate.text` failure.

The paused/failed hints can appear alongside any of the first three, since the backoff clock can clear before a scheduled run next succeeds. See [observer.md](observer.md) for the full gate.

### Skill notes (`lib/board-text.js` `buildObservationsBlock`)

The task-observer skill's own open backlog (read-only; this plugin never writes into that skill's workspace, `lib/board-observations.js`):

| Row | Meaning |
| --- | --- |
| **open** | Observations with `status: open` (or no status line at all). |
| **added this week** | Opened in the last 7 days. |
| **last reviewed** | When the backlog was last reviewed by a human, or `never`. |
| **staged skill updates** (hint, only when nonzero) | Drafted skill updates sitting in `skill-updates/PENDING.md`, waiting for a human to run `/skill-review install` (`lib/board-text.js`). A nonzero count also flips this block's glyph to attention. |

The glyph reads attention when `open > 100` and the last review is never or more than 7 days old (`lib/board-observations.js` `WARNING_OPEN_THRESHOLD`/`WARNING_REVIEW_DAYS`), or when anything is staged.

### Skill test (`lib/board-text.js` `buildEvalsBlock`)

The newest skill-creator benchmark found under the configured eval roots (see [data-layout.md](data-layout.md) for the search order). Named `Skill test (<skill>)` once a benchmark exists; `Skill test` with headline `none` otherwise.

| Row | Meaning |
| --- | --- |
| **with skill** / **without**, or **new** / **old** | The two pass rates compared: skill included vs. removed, or (skill-creator's `old_skill` naming) the edited skill vs. its own previous version. |
| **verdict** | `saturated` (both runs already at or above 99.5%, `EVAL_SATURATED_THRESHOLD`, so the evals cannot separate them at all), `no change` (a difference under 5 points, `EVAL_NO_DIFFERENCE_THRESHOLD`, but not at the ceiling), `improved` (5+ points higher; the only verdict with an active glyph, and only while the benchmark is still fresh), or `worse` (5+ points lower). |

A benchmark older than 7 days (`EVAL_STALE_MS`) reads stale regardless of verdict.

### Health (`lib/health.js` `collectHealth`)

Shown only when there is something to flag:

| Check | Message |
| --- | --- |
| python not found | "python not found: habits are saved to the shared global bucket; set the python option" |
| data dir not writable | "data dir not writable: `<path>`" |
| `board.observationsRoot` configured but missing | "observationsRoot configured but missing: `<path>`" (only once the user has pointed it somewhere; the unconfigured default never existing yet is not flagged) |
| observer enabled with no model | "observer enabled with no model: set observer.model" |
| no eval found under any configured root | "eval roots missing: no skill-creator benchmark found under `<roots>`" (informational, not urgent) |
| an option validation warning | Whatever `lib/plugin.js`'s `validateOptions` found (an unknown key, or a value of the wrong type) |

## The `/board` chat summary

`/board` does not reproduce the sidebar's dot-aligned layout: it replies with a circle and a padded label, then each block's key facts on one headline line, then a sentence or two of plain-language context underneath (`lib/board-format.js` `formatBoardSummary`). It reads something like:

```
● Learned habits   29 total, 10 in prompts, 3 used today (14 this week)
  Habits are patterns learned from your activity; one counts as used once per prompt you type in a top-level session whose wording shares 3 or more significant words with the habit's trigger; subagent and other child sessions (any session with a parentID) are not counted.
  Used today: absolute-node-path-when-shell-lacks-node (1x): Use the absolute Homebrew node path for all node calls.
              fff-grep-anchor-fallback-to-read (1x): Read the named file directly with a windowed Read.
  Next learning run after 14 more events (6 so far). 10 ready: /promote.
  Skill candidates: 2 proposed from your habits, pick one with /evolve <n>; 1 installed (0 unused): /evolve.

● Skill notes      467 open, 167 this week, never reviewed: review overdue.

○ Skill test (pr)  the last edit changed nothing the evals can see: old and new both pass 100%, 8d ago. The evals are saturated; add harder cases.

● Health           1 item needs attention
  observer enabled with no model: set observer.model

● active  ● needs attention  ○ stale
```

The "Used today:" list reads "Most used today:" instead whenever two listed habits fired a different number of times, is capped at 5, and each summary is clipped at a word boundary at 100 characters (`lib/board-format.js`, `lib/store.js` `clipSummaryWordBoundary`): this reply has no 36-column sidebar budget to justify a hard character cut.
