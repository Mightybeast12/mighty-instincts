# Maintenance

This page covers the background sweep's steps and numbers, the `/maintain` and `/promote` commands, and dry-run. See [../README.md](../README.md) for the rest of the plugin.

A background sweep keeps the instinct stores tidy without anyone ever running a command. It runs right after every observer run, and otherwise at least every `maintenance.intervalHours` (default 24), guarded against overlapping with itself (`lib/maintain.js` `createMaintenanceController`). Every step below is on by default (`MAINTENANCE_DEFAULTS`, `lib/maintain.js`) and logs what it did to `maintenance.log`; any one can be turned off independently (`maintenance.promote: false`, etc.).

```json
{
  "intervalHours": 24,
  "dryRun": false,
  "promote": true,
  "prune": true,
  "decay": true,
  "dedupe": true,
  "evolve": true,
  "repair": true,
  "cleanupProjects": true
}
```

## Steps, in run order

Run order follows `runMaintenance` (`lib/maintain.js`): repair, prune, decay, promote, graduate-pending, then evolve and cleanupProjects (both gated on their own cadence).

### promote (`lib/maintain.js` `promoteStep`)

Either of two independent qualification paths copies an instinct to the shared global bucket, whichever one it clears first:

| Path | Qualifies when |
| --- | --- |
| Cross-project corroboration (ECC's own rule) | Confident enough (`>= 0.8`, `PROMOTE_CONFIDENCE_THRESHOLD`) and whose id (or a trigger with 70%+ word overlap, `PROMOTE_TRIGGER_OVERLAP_THRESHOLD`) appears in 2+ distinct project stores (`PROMOTE_MIN_PROJECTS`). |
| Proven on its own, no corroboration needed | Confidence `>= 0.9` (`PROMOTE_FIRED_CONFIDENCE_THRESHOLD`) and fired `>= 3` times (`PROMOTE_FIRED_THRESHOLD`), in a single project. |

Neither path promotes an instinct whose trigger names a repository (any project name in `projects.json`, or the instinct's own `project_name`, as a whole word; `lib/maintain.js` `namesRepository`), since a global copy is injected into every project, nor an id found in an `instincts/archive/` folder (the global one or any project's), so a retired copy is never brought back. Reimplemented directly over `projects/*/instincts/personal/*.md`; never shells out to Python for this.

### prune (`lib/maintain.js` `pruneStep`)

Deletes files in `instincts/pending/` older than 30 days (`PENDING_TTL_DAYS`, ECC's own default pending TTL); logs a warning for ones within 7 days of expiring (`PENDING_EXPIRY_WARNING_DAYS`).

### decay (`lib/maintain.js` `decayStep`)

A personal instinct that has never fired, past 30 days old (`DECAY_GRACE_DAYS`), loses 0.05 confidence (`DECAY_STEP`) per full week since its last decay; once that drops it below 0.4 (`DECAY_ARCHIVE_THRESHOLD`) it is moved (never deleted) to `instincts/archive/`.

### dedupe (`lib/maintain.js` `dedupeOrMerge`)

Before the observer writes a new instinct, it is compared against every existing personal instinct on trigger-vs-trigger OR summary-vs-summary word overlap: a close match (`>= 60%` on either field, `DEDUPE_OVERLAP_THRESHOLD`, or `>= 45%` on either field when both also share the same domain, `DEDUPE_SAME_DOMAIN_OVERLAP_THRESHOLD`, and `>= 35%` overlap between the two `## Action` sections, `DEDUPE_ACTION_OVERLAP_THRESHOLD`) gets its confidence raised and the new evidence appended, keeping its own summary, instead of creating a near-duplicate file. The Action check keeps two instincts that only share the project's own words apart; an instinct with no Action is never merged.

### evolve (`lib/maintain.js` `evolveStep`)

Groups personal instincts by domain and by word overlap into clusters of 3+ (`EVOLVE_MIN_CLUSTER_SIZE`, `EVOLVE_OVERLAP_THRESHOLD = 0.3`), and proposes (or updates) one candidate per cluster under `evolved/<cluster-id>.md` (no model call). Runs at most once a week (`EVOLVE_INTERVAL_MS`), regardless of how often the sweep itself runs. See [evolve.md](evolve.md) for the full lifecycle.

### repair (`lib/maintain.js` `repairStep`)

A one-off, idempotent cleanup pass over the personal store: cleans a trigger carrying a leaked trailing frontmatter fragment (e.g. `..., confidence: 0.8`), the shape a parser bug before 0.7.0 (or a hand-edited file) could leave behind; and moves a personal instinct with confidence `<= 0.5` that has never fired into `instincts/pending/`, the 50% rule applied retroactively to anything that landed in personal before that rule covered it.

### cleanupProjects (`lib/maintain.js` `cleanupProjectsStep`)

Runs at most once a day (`CLEANUP_PROJECTS_INTERVAL_MS`). For every entry in ECC's own projects registry (`projects.json`) whose root no longer exists, or lives under the OS temp directory, and which has 0 instincts of its own, the registry entry is removed and its project directory is archived (never deleted outright) to `archive/projects/<id>/`.

## `/maintain` and `/promote`

| Command | Does |
| --- | --- |
| `/maintain [--dry-run]` | Run the full sweep now: promote/prune/decay/evolve/repair/cleanup. `--dry-run` previews every step, including evolve/cleanup regardless of today's weekly/daily gate, without changing anything (`lib/commands-maintain.js` `buildMaintainCommand`/`runFullSweep`). |
| `/maintain prune [--dry-run]` | Runs only the pending-instinct prune (`lib/commands-maintain.js` `runPruneOnly`). `/instinct-prune` forwards here for one release. |
| `/promote [--yes]` | Preview (default) or run (`--yes`) promoting project-scoped instincts that qualify to global scope, using the same `promoteStep` rule as the sweep (`lib/commands-maintain.js` `buildPromoteCommand`). |

## Trying it safely (dry-run)

Set `"maintenance": { "dryRun": true }` to see exactly what the next sweep would do without changing anything: every line it would otherwise log to `maintenance.log` is prefixed `would` instead (`would promote: ...`, `would archive: ...`, `would merge ... into ...`, and so on), with no file written, moved, or deleted. Turn it back to `false` (the default) once satisfied with what it shows. `/maintain --dry-run` gets the same preview on demand, forcing the weekly/daily gated steps (evolve, cleanupProjects) open for that one preview regardless of today's actual cadence (`lib/maintain.js` the `force`/`dryRun` overrides).
