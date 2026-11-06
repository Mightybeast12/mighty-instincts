# Instinct

This page covers the `/instinct <verb>` command family, `.settings.json`, why/keep/wrong semantics, muting, doctor, and injection's rules and fired heuristic. See [../README.md](../README.md) for the rest of the plugin.

## Verbs

One command, `/instinct <verb> [args]` (`lib/commands-instinct.js` the `VERBS` table, also the dispatch table), run with no arguments (or `help`) for the full list:

| Verb | Usage | Does |
| --- | --- | --- |
| status | `status` | Show ECC instinct status (project-scoped + global). |
| projects | `projects` | List known projects and their instinct counts. |
| export | `export [...]` | Export instincts to stdout or a file. |
| import | `import <file\|url> [...]` | Import instincts from a local file or an https URL. |
| observe | `observe` | Run the instinct observer now, ignoring the configured thresholds. |
| why | `why` | Show the ids, confidence and source of the latest injected block for this session, and which ids fired on the last prompt. |
| keep | `keep <id>` | Confirm an instinct was useful: bumps its fired count and raises its confidence by 0.05 (capped at 0.95). |
| wrong | `wrong <id>` | Archive an instinct and mute it so no copy of it is injected again (undo: `/instinct unmute <id>`). |
| mute | `mute <id>` | Skip an id for injection, without archiving its file. |
| unmute | `unmute <id>` | Un-skip a muted id, restoring it from the archive if `wrong` put it there. |
| observer | `observer on\|off` | Turn the background observer on or off; persisted across restarts and applied immediately. |
| doctor | `doctor` | Run the board's own health checks, plus the observer gate's current verdict. |
| help | `help` | List every registered command and `/instinct` verb (also runs for the bare `/instinct`). |

The five commands `/instinct-status`, `/instinct-import`, `/instinct-export`, `/instinct-projects`, and `/instinct-observe`, from v0.10.0 and earlier, remain registered for one release as deprecated aliases that forward their argv text onto the matching verb through the same dispatcher (`lib/commands.js` `INSTINCT_ALIASES`). `/instinct-prune` is not part of this family; it forwards into `/maintain prune` instead (see [maintenance.md](maintenance.md)).

## `.settings.json`

Lives at `<project.project_dir>/.settings.json`, written atomically (`lib/settings.js`):

```json
{
  "observer": { "enabled": true },
  "muted": ["some-instinct-id"]
}
```

`observer.enabled`, when present, overrides `opencode.json`'s own `observer.enabled` for this project, applied to the live `options` object immediately with no restart needed (`lib/settings.js` `applyRuntimeSettings`). `muted` is the list `/instinct mute`/`wrong`/`unmute` maintain; it is merged into `inject.exclude` for injection purposes (`lib/inject.js` `mergeExclude`). A missing or corrupt file reads back as empty defaults rather than throwing.

## `why`, `keep`, `wrong` semantics

| Verb | Does |
| --- | --- |
| why | Reports the most recent injected block for this session (from `lib/inject.js`'s in-memory `lastInjected`), listing each injected id with its confidence percentage and source (`personal`/`inherited`/`global`), then which of them actually fired on the last prompt (`lib/commands-instinct.js` `formatWhy`). |
| keep | Bumps the instinct's `fired` count, then raises its confidence by 0.05 (capped at 0.95), and invalidates the injection pool cache so the change is reflected on the very next request. Works on an instinct in this project's personal/inherited store or the shared global store; refuses (with a pointer to edit by hand) when the id lives inside a multi-block file (an ECC import/export batch) (`lib/commands-instinct.js` `verbKeep`). |
| wrong | Moves the instinct's file to the sibling `archive/` directory (never deletes it) and adds the id to `.settings.json`'s `muted` list, so no copy of it (personal, inherited, or global) is injected again. `/instinct unmute <id>` reverses both halves: it removes the id from `muted` and, if `wrong` archived a copy, restores it from whichever archive (project or global) actually holds it (`lib/commands-instinct.js` `verbWrong`). |

## Muting

`mute`/`unmute` only touch `.settings.json`'s `muted` list; they never move or archive a file (`lib/commands-instinct.js`). A muted id is excluded from injection exactly like one listed in `inject.exclude`, whether it lives in this project's own store or the shared global one.

## `doctor`

Runs the board's own health checks (`lib/health.js`'s `collectHealth`, see [board.md](board.md)'s Health block) plus the observer gate's current verdict (ready, or blocked with a reason) (`lib/commands-instinct.js` `verbDoctor`). When the gate reads `disabled`, it also names whether `.settings.json` is the thing overriding `opencode.json`'s own `observer.enabled`, so the two possible causes of "disabled" are never ambiguous.

## Injection rules

When `inject.enabled` is `true` (the default), every outgoing model request is checked against this project's instincts plus the shared global bucket (`lib/inject.js` `registerInject`/`handleContext`). Up to `inject.max` instincts (default 5) meeting `inject.minConfidence` (default 0.8), excluding any id listed in `inject.exclude` or muted, are added as one more system-context entry:

```
<instincts> learned habits for this project
- <one-line summary of what to do>
...
</instincts>
```

This runs on `ctx.session.hook("context", ...)`, not `"prompt"`: it only ever appends to the request's own `system` array, right before the model sees it, and never edits the user's prompt text or message history (`lib/inject.js`). Because of that there is no cadence to configure and nothing to track between requests; every request gets a block built fresh from whatever instinct files exist right now. The whole block is kept under 1200 characters (`BLOCK_CHAR_BUDGET`, `lib/inject.js` `formatInjectionBlock`), dropping the lowest-confidence entries first if it would not otherwise fit. No model call is involved: this only reads instinct files already on disk. Injection is skipped when the latest user message in the request carries `opencode_loop_v2` or `ulw` metadata (a loop/ultrawork re-prompt, not a fresh request), or when the project has no instincts at all. A trigger that still contains a stray `confidence:`/`domain:`/`scope:`/`source:` is treated as malformed and skipped, with a one-time warning logged.

Each line's summary is the instinct's own `summary:` frontmatter field (one imperative sentence, at most 120 characters); for an instinct written before 0.7.0 with no `summary:` of its own, it falls back to the first sentence of the `## Action` section, clipped to 120 characters (`lib/store.js` `firstActionSentence`).

## The fired heuristic

When an included instinct's `trigger` shares at least 3 significant words (5+ letters, case-insensitive, common filler words removed; `MIN_WORD_LEN`/`MIN_SHARED_WORDS`, `lib/inject.js`) with the latest user message, that instinct's `fired` count is incremented, and the day's total plus a rolling 7-day total are both kept in `.activity.json` (`lib/inject.js` `bumpFiredForMatches`, `lib/activity.js` `recordFired`), shown on the board as "used today / this week". A pending instinct (the 50% rule) is checked for firing exactly the same way, but is never included in the injected block itself; once it fires, the maintenance loop promotes it to a real instinct (`lib/maintain.js` `graduatePendingStep`). This is counted once per human prompt in a top-level session, never per tool-call step within that same turn, and never for a subagent or other child session (one with a parentID, `lib/inject.js` `isChildSession`). A headless top-level session, one with no parentID at all, has no human typing into it either, but is still counted the same as any other top-level session: `isChildSession` only ever checks for a parentID, so this plugin's own `/skill-review` session (spawned with no parent) counts too.

A candidate that shares 1 or 2 significant words (just under the 3-word threshold) is logged instead to `fired-misses.log` (id, shared-word count, the words themselves; capped at 200 lines), for tuning that threshold later; nothing in this plugin ever reads that log back (`lib/inject.js`).
