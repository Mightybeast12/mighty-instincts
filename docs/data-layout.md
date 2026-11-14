# Data layout

This page lists every file this plugin writes, with its path. See [../README.md](../README.md) for the rest of the plugin.

Everything lands in ECC's existing on-disk layout so `instinct-cli.py` (and anything else that reads it) sees the same data; the only additions are the bookkeeping files marked below. Project identity (`<project-hash>`) is resolved by calling ECC's own `detect_project()` in `vendor/ecc/instinct-cli.py` (`lib/project.js`), so this plugin and the CLI agree unless resolution fails, in which case a warning is logged and the shared `global` bucket is used (`lib/project.js` `globalFallback`).

The root directory below is the `dataDir` option when set (an absolute path), else `$XDG_DATA_HOME/ecc-homunculus`, else `~/.local/share/ecc-homunculus` (`lib/homunculus-dir.js` `resolveHomunculusDir`). The one Python subprocess this plugin runs sees the same directory through the `CLV2_HOMUNCULUS_DIR` environment variable instead (`lib/project.js` `buildPythonEnv`), so the two never disagree about where it is.

```
<homunculus>/
├── projects.json                           # ECC's own project registry; cleanupProjects edits it
├── instincts/                              # the shared global bucket, readable by every project
│   ├── personal/<id>.md                    # written by promoteStep / /promote, or /instinct import --scope global
│   ├── inherited/<id>.md
│   └── archive/<id>.md
├── board-pointer-<sha256(project directory)[0:12]>.json   # plugin addition: points at a project's board-state.json
├── archive/projects/<project-hash>/        # plugin addition: cleanupProjects archives a stale, zero-instinct project dir here; never deleted
└── projects/<project-hash>/
    ├── observations.jsonl          # tool_start / tool_complete / user_prompt records
    ├── observations.archive/       # rotated out at 10 MB
    ├── observer.log                # plugin addition: one line per observer run
    ├── maintenance.log             # plugin addition: one line per maintenance event
    ├── .observer-state.json        # plugin addition: last run time + line count for the gate
    ├── .activity.json              # plugin addition: last-observed/applied/fired-today/fired-this-week counters
    ├── .settings.json              # plugin addition: persisted observer on/off + muted instinct ids
    ├── fired-misses.log            # plugin addition: near-miss (1-2 shared word) fired-match log, capped at 200 lines
    ├── board-state.json            # plugin addition: the board's three-block summary
    ├── usage.json                  # plugin addition: skill/command/agent usage counts
    ├── evolved/<cluster-id>.md     # plugin addition: candidates proposed/installed/archived by the evolve lifecycle
    └── instincts/
        ├── personal/<id>.md        # written by the observer
        ├── inherited/<id>.md       # written by /instinct import
        ├── pending/<id>.md         # unproven instincts (the 50% rule); never injected
        └── archive/<id>.md         # instincts the maintenance loop decayed below 0.4 confidence, or /instinct wrong archived; never deleted
```

When project resolution fails (python not found on `PATH`, or any other `detect_project()` error), `lib/project.js`'s `globalFallback` sets `project_dir` to the homunculus directory itself, so every file listed under `projects/<project-hash>/` above is instead written directly at the homunculus root; `instincts_personal`/`instincts_inherited` likewise point at the same `instincts/personal`/`instincts/inherited` shown above. In this fallback, the per-project bookkeeping and the shared global bucket end up sharing one directory.

## File reference

| File | Written by | Notes |
| --- | --- | --- |
| `observations.jsonl` | `lib/store.js` `appendObservation` | One JSON line per tool call or prompt; scrubbed and clipped. |
| `observations.archive/*.jsonl` | `lib/store.js` `archiveIfOversized` | Rotated out once `observations.jsonl` passes 10 MB. |
| `observer.log` | `lib/observer.js` `appendLog` | `<iso> run: <N> written, <N> rejected, model <provider/model>`, with `ids:`/`rejected:` suffixes. See [observer.md](observer.md). |
| `maintenance.log` | `lib/maintain.js` `appendMaintenanceLog` | One line per maintenance event, plus one `run: ...` summary per sweep. See [maintenance.md](maintenance.md). |
| `.observer-state.json` | `lib/observer-state.js` | Last run time, line count, failure streak, backoff deadline, model-unset block flag. |
| `.activity.json` | `lib/activity.js` | `lastObservedAt`, `appliedToday`, `firedToday`, `firedThisWeek`, `firedByIdToday`, `firedByDay`. |
| `.settings.json` | `lib/settings.js` | `{ observer: { enabled? }, muted: string[] }`. See [instinct.md](instinct.md). |
| `fired-misses.log` | `lib/inject.js` | Capped at 200 lines; never read back by this plugin. |
| `board-state.json` | `lib/board.js` `writeBoardState` | See [board.md](board.md). |
| `usage.json` | `lib/usage.js` | `{ skills: { id: {count, last} }, commands: {...}, agents: {...} }`. |
| `evolved/<cluster-id>.md` | `lib/candidates.js` `writeCandidate` | See [evolve.md](evolve.md). |
| `instincts/personal/<id>.md` | `lib/store.js` `writeInstinct` | The observer's own confident-enough instincts. |
| `instincts/inherited/<id>.md` | `vendor/ecc/instinct-cli.py` (via `/instinct import`) | |
| `instincts/pending/<id>.md` | `lib/store.js`, routed by `lib/maintain.js` `classifyNewInstinct` | The 50% rule. |
| `instincts/archive/<id>.md` | `lib/maintain.js` `decayStep`, `lib/commands-instinct.js` `verbWrong` | Never deleted. |
| `board-pointer-<hash>.json` | `lib/board.js`, `lib/board-pointer.js` | Lets the TUI half find `board-state.json` without running python. |
| `archive/projects/<id>/` | `lib/maintain.js` `cleanupProjectsStep` | Never deleted outright. |
| `<name>.tmp-<pid>-<ms>-<n>`, `.<name>.tmp-<pid>-<ms>-<n>` | every atomic writer (`lib/store.js` `uniqueSuffix`), renamed over its target | A write that died before its rename leaves one; `lib/maintain.js` `cleanStaleTmpStep` removes those older than an hour here, in `evolved/` and at the homunculus root (counted in the run line's `cleaned`). |

## Shared global bucket and registry

These live directly at the homunculus root, not under any one project's `projects/<project-hash>/`:

| File | Written by | Notes |
| --- | --- | --- |
| `projects.json` | ECC's own registry (`vendor/ecc/instinct-cli.py`); entries removed by `lib/maintain.js` `cleanupProjectsStep` | `{ id: { id, name, root, remote, created_at, last_seen } }`. |
| `instincts/personal/<id>.md` | `lib/maintain.js` `promoteStep`, `/promote`, or `vendor/ecc/instinct-cli.py` (`/instinct import --scope global`) | The shared bucket every project's injection pool also reads from. |
| `instincts/inherited/<id>.md`, `instincts/archive/<id>.md` | Same writers as the per-project siblings above, scoped to the global bucket | `/instinct wrong`/`unmute` and `decayStep` read and write the global archive the same way they do a project's own. |

## Outside the homunculus directory

| File | Written by | Notes |
| --- | --- | --- |
| `<skills\|commands\|agents dir>/<name>[/SKILL.md]` | `lib/candidates.js` `installCandidateArtifact` | Only via `/evolve <n\|id> install`. See [evolve.md](evolve.md). |
| `<project root>/AGENTS.md` | `lib/candidates.js` (rule kind) | Appended under `## Learned rules (mighty-instincts)`, bracketed by HTML comment markers. |
| `<task-observer root>/skill-updates/<date>/...`, `PENDING.md`, `backups/...`, `review-reports/<date>.md` | The spawned review session, plus `lib/review-install.js` for install/undo | See [skill-review.md](skill-review.md). This is a separate workspace from the homunculus directory above, resolved the same way `board.observationsRoot` is (`lib/board.js` `resolveObservationsRoot`); default `~/.local/share/opencode/task-observer`. |

Task-observer's own workspace layout (read-only for the board, read-write for a spawned review session), from `lib/review-install.js`'s header comments and `parsePending`:

```
<task-observer root>/
├── skill-observations/
│   ├── observation-log/*.md         # frontmatter: status, title, skill, date
│   ├── last-review-date.txt
│   ├── review-reports/<date>.md
│   └── .mighty-instincts/           # this plugin's own cross-process state, next to (never inside) the skill's own state
│       ├── review-lock.json
│       └── review-runs.log
└── skill-updates/
    ├── PENDING.md                   # one "## <id> (<description>): <status phrase>" heading per staged batch
    ├── <date>/<skill>/SKILL.md      # staged skill copies
    └── backups/
        ├── .install-log.json
        └── <backupDirName>/<skill>/SKILL.md
```
