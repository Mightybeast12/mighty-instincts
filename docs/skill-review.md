# Skill review

This page covers the scheduler options, the spawned session's permissions, what it stages, the `/skill-review status|install|undo` procedure (including the seed check, backups, and undo), and the completion notice. See [../README.md](../README.md) for the rest of the plugin.

The task-observer skill (installed separately; see its own SKILL.md) keeps an open backlog of observations about every other installed skill, meant to be reviewed on a cadence with its own `references/weekly-review.md` procedure. Once turned on, this plugin can run that procedure for you: once the backlog is due, it spawns a headless OpenCode session (`ctx.session.create` + `ctx.session.prompt`, the same v2 API the board and observer use, `lib/review.js` `run`) that loads the task-observer skill and works through a bounded slice of the oldest open observations, then tracks that session through to completion.

## Scheduler options

`REVIEW_DEFAULTS` (`lib/review.js`):

```json
{
  "enabled": false,
  "cadenceDays": 7,
  "sliceSize": 10,
  "cooldownHours": 24,
  "timeoutMinutes": 90,
  "startupDelaySeconds": 120,
  "pollMinutes": 15,
  "model": null,
  "agent": null,
  "externalDirectories": []
}
```

`review.enabled` is `false` by default; unlike the maintenance sweep, which writes automatically by default, a scheduled review spawns a real headless session that works for a while, so this one stays opt-in. `/skill-review` triggers one run on demand (ignoring the cadence and cooldown, but not a review already in progress), independent of `review.enabled`.

| Option | Description |
| --- | --- |
| `cadenceDays` | Minimum days since the last review before another one is due. |
| `sliceSize` | How many of the oldest open observations (by id, plus anything that restates one of them) one review run is scoped to. |
| `cooldownHours` | Minimum time between attempts, independent of the cadence (covers a run that was skipped or failed quickly). |
| `timeoutMinutes` | How long a lock (and the spawned session itself) is allowed to run before it is considered stale, replaceable by the next attempt, and interrupted. |
| `startupDelaySeconds` | How long after plugin setup the first scheduled check runs. |
| `pollMinutes` | How often the scheduled check re-runs after that first one. |
| `model` | `"provider/model"` for the spawned session. Unset uses the host's default model. |
| `agent` | Agent name for the spawned session. Unset uses the host's default agent. |
| `externalDirectories` | Extra absolute paths (or ones starting with `~/`) the spawned session may read from outside the task-observer workspace, beyond `~/.config/opencode` and `~/.cache/opencode/npm` (always allowed, so the session can load skills and plugin code). |

The lock (`review-lock.json`) and the append-only attempt log (`review-runs.log`) both live under `<task-observer root>/skill-observations/.mighty-instincts/`, next to (never inside) the skill's own `skill-observations/` state, since several OpenCode instances on the same machine can share that workspace: the lock is created with an exclusive write (`lib/review.js` `createLockFile`), so whichever instance wins the race blocks every other one until it finishes or its `timeoutMinutes` elapses.

## Permissions of the spawned session

Last-match-wins, OpenCode 2's own resolution order (`lib/review.js` `buildReviewPermissions`):

- Editing is denied everywhere except inside the task-observer workspace (`root`).
- Reading outside the workspace is denied everywhere except `~/.config/opencode`, `~/.cache/opencode/npm`, and anything listed in `review.externalDirectories`.
- Shell is allowed outright, since the review procedure runs bash snippets and a headless session has nobody to answer an "ask" permission prompt.

The edit deny and the prompt's own instructions are what actually keep the review inside the workspace; shell can still write elsewhere through means an edit permission does not cover.

## What it stages

The session is instructed (`lib/review.js` `buildReviewPrompt`) to:

- Load the task-observer skill, then its `references/weekly-review.md`, in scheduled autonomous mode.
- Scope the run to the `sliceSize` oldest open observations by id, plus any open observation that restates one of them.
- Stage every skill change as a copy under `<root>/skill-updates/<date>/`, and record it in `<root>/skill-updates/PENDING.md`.
- Never edit an installed skill file, an AGENTS.md, or anything outside the workspace (enforced by the permission deny above too).
- Set each reviewed observation's status (`actioned`, `declined`, `parked`, or `superseded`) with `resolved:`/`resolution:`; anything needing the owner's decision stays open, listed under "Skipped (needs manual review)".
- Finish by writing today's date to `last-review-date.txt` and the review summary to `skill-observations/review-reports/<date>.md`.

## `/skill-review status|install|undo`

| Command | Does |
| --- | --- |
| `/skill-review` | Run the backlog review now in a headless session, ignoring the cadence and cooldown (but not a review already in progress) (`lib/commands-maintain.js` `buildSkillReviewCommand`). |
| `/skill-review status` | Report the open count, staged count, last review date, whether a run is due, and any in-flight session id (`lib/commands-maintain.js` `formatReviewStatus`). |
| `/skill-review install [n\|all]` | With no argument, list staged updates. `install <n>` or `install all` installs them (see "Install procedure" below). |
| `/skill-review undo` | Reverts the most recently installed update, unconditionally overwriting any hand edit made to the live file since. |

### Install procedure, including the seed check

For each staged skill copy (`<root>/skill-updates/<entry.id>/<skill>/SKILL.md`), `planInstall` (`lib/review-install.js`) checks whether the live skill file still matches a "seed" snapshot: a `<skill>.pre-*` sibling directory, or the specific one an "Install" clause in the batch's own README/PENDING.md names. That seed is staged by the task-observer skill's own weekly-review procedure as its diff baseline when it drafts an update, not by this plugin: `collectSeedCandidates` only ever reads whichever seed the procedure already left behind. If the live file's content equals a seed snapshot exactly, the install proceeds; if it does not (someone edited the live file by hand since staging), the install is refused for that skill, with a `+N/-N` line-diff summary against the seed. When no seed snapshot can be found at all (the procedure never staged one for this skill, or it has since been removed), the install is refused with "no seed snapshot found for this skill" instead.

"Live" here means `~/.config/opencode/skills`, resolved through its own realpath first (`resolveLiveSkillsDir`): a symlinked or dotfiles-managed `~/.config/opencode` is checked through to the real directory it points at, falling back to the unresolved path if that lookup itself fails.

An entry installs atomically or not at all: if any staged skill in it fails the seed check, the whole entry is refused, nothing is written (`lib/review-install.js`).

### Backups and undo

Installing backs up the live file's current content to `<root>/skill-updates/backups/<backupDirName>/<skill>/SKILL.md` before writing the staged copy over it, then records the operation (including that backup directory name) in `<root>/skill-updates/backups/.install-log.json` (`lib/review-install.js` `applyInstall`). `/skill-review undo` pops the most recent entry from that log and restores every one of its skills from its own backup directory, then marks the entry `[undone <date> by mighty-instincts]` in PENDING.md so it is staged again (`lib/review-install.js` `undoLast`). A second `undo` reaches back to whichever operation is now last, so two installs of the same skill chain back correctly.

Each install or undo also appends an annotation to the entry's own PENDING.md heading (`[installed <date> by mighty-instincts]` or `[undone <date> by mighty-instincts]`), which always wins over the file's own free-text status phrase when deciding whether an entry is still "staged" (`lib/review-install.js` `parsePending`/`isStagedHeading`).

## Completion notice

A *scheduled* review (nobody gave `run()` a sessionID to reply to) posts a completion notice once the session finishes, to the newest top-level session the host currently lists, excluding the review session itself (`lib/review.js` `postCompletionNotice`, `lib/review.js` `newestTopLevelSessionID`): "Skill review finished: `<N>` staged update(s) await /skill-review install". This needs `ctx.session.list`: when the host has no such method, the call fails, or the list has no eligible session once the review session itself is excluded, the notice is only logged (`console.warn`), never posted anywhere. `ctx.session.list` is not scoped to one project, so the session it notifies can belong to a different project than the one the review ran against. A manual `/skill-review` already told the person who typed it that the session started; its own completion is theirs to check with `/skill-review status`. A forced run refuses outright when there is nothing open to review, regardless of `force` (`lib/review.js`).
