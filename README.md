# mighty-instincts

An [OpenCode](https://opencode.ai) V2 plugin that observes session activity (tool calls and prompts) into a per-project log, periodically has a cheap model distil that log into small learned "instincts," and exposes [ECC](https://github.com/affaan-m/ECC)'s instinct CLI as slash commands. Nothing becomes live automatically on the write side: `/evolve` only writes inert markdown, and the observer is off by default. On the read side, the plugin injects a small `<instincts>` block into outgoing prompts by default (`inject.enabled: true`); this costs no model call of its own, since it only reads instinct files this plugin (or `/instinct-import`) already wrote.

On the OpenCode 2 TUI it also adds a small, collapsible sidebar board summarising three sources of the user's own observation/improvement tooling: **Instincts** (this plugin's own counts and observer status), **Skill observations** (the task-observer skill's open/parked backlog and staged updates), and **Skill evals** (skill-creator's latest benchmark result). Hosts without the sidebar can run `/board` for the same summary as plain text.

## Install

> `opencode-instincts` was this package's previous name. If your `opencode.json` still references it, replace it with `mighty-instincts`.

Add the plugin to your `opencode.json` (project or global at `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["mighty-instincts"]
}
```

To set options, use the object form instead of the bare string:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "mighty-instincts",
      "options": {
        "observer": { "enabled": true, "model": "anthropic/claude-haiku-4-5" }
      }
    }
  ]
}
```

Restart OpenCode. Requires Python 3 on `PATH` (the plugin runs ECC's vendored `instinct-cli.py` as a subprocess; nothing else is installed). On the OpenCode 2 TUI the sidebar board (`mighty-instincts/tui`) loads alongside the server plugin automatically; no extra configuration is needed.

### Options

All options are optional; defaults shown:

```json
{
  "disabled": false,
  "dataDir": null,
  "python": "python3",
  "observePrompts": true,
  "ignoreTools": ["todowrite", "todoread", "question", "instincts"],
  "ignoreAgents": [],
  "observer": {
    "enabled": false,
    "model": null,
    "runIntervalMinutes": 5,
    "minObservations": 20,
    "maxAnalysisLines": 300,
    "notify": true
  },
  "inject": {
    "enabled": true,
    "max": 5,
    "minConfidence": 0.8,
    "exclude": []
  },
  "board": {
    "enabled": true,
    "sections": { "instincts": true, "observations": true, "evals": true },
    "refreshSeconds": 30,
    "observationsRoot": null,
    "evalRoots": null,
    "compact": false
  }
}
```

| Option | Description |
| --- | --- |
| `disabled` | Skip registering everything (hooks, commands, tool, board). |
| `dataDir` | Absolute path to use instead of the default ECC data directory; relative values are ignored with a warning. Maps to `CLV2_HOMUNCULUS_DIR` for the vendored CLI. |
| `python` | Python interpreter to run `instinct-cli.py` with. |
| `observePrompts` | Record user prompt text (scrubbed, clipped to 2000 chars) as `user_prompt` observations. |
| `ignoreTools` / `ignoreAgents` | Tool names / agent names to never observe. |
| `observer.enabled` | Turn on the background distillation run described below. |
| `observer.model` | `"provider/model"` to run `generate.text` with. When unset, the host's default model is used (and a one-time warning is logged). |
| `observer.runIntervalMinutes` / `observer.minObservations` | Minimum time and minimum new observation count between automatic runs. |
| `observer.maxAnalysisLines` | How many of the most recent observation lines to show the model per run. |
| `observer.notify` | Post a synthetic summary message into the triggering session after a background run. |
| `inject.enabled` | Append a small `<instincts>` block (trigger + a one-line gist of each instinct's `## Action` section) to outgoing prompts. On by default; set to `false` to turn it off entirely. |
| `inject.max` | Maximum number of instincts appended per prompt, highest confidence first. |
| `inject.minConfidence` | Minimum confidence an instinct needs to be eligible for injection. |
| `inject.exclude` | Array of instinct ids to never inject, even if they otherwise qualify. |
| `board.enabled` | Turn the sidebar board and the `/board` command off entirely. |
| `board.sections.instincts` / `.observations` / `.evals` | Show or hide one block of the board. |
| `board.compact` | Start every board block collapsed to its title line only; still expandable by clicking. Does not affect the panel header. |
| `board.refreshSeconds` | How often the board state file is recomputed on a timer (it is also refreshed on plugin setup and after every observer run). |
| `board.observationsRoot` | Absolute path (or one starting with `~/`) to the task-observer skill's data directory. Defaults to `~/.local/share/opencode/task-observer`. |
| `board.evalRoots` | Array of absolute paths (or ones starting with `~/`) to search for skill-creator benchmark output. Defaults to `["~/.config/opencode/skills", "$TMPDIR/opencode"]`. |

## The board

The board is a small, read-only summary of three sources, written by the server half of the plugin to a per-project `board-state.json` file and polled every 30 seconds (or refreshed on request) by the TUI sidebar panel and by `/board`:

- **Instincts**: how many instincts this plugin has learned (project + inherited + global), how many of those look ready to promote (confidence >= 0.8), their domains, and the observer's run/written/rejected tally plus when it next runs.
- **Skill observations**: the task-observer skill's open backlog count and last review date, the busiest skills in that backlog, and how recently observations were added.
- **Skill evals**: the newest benchmark the skill-creator skill produced (skill name, iteration, age, run count, and the two pass rates it compared).

Each block is independently optional (`board.sections`) and shows `!` / "not found" when its data source is not present (observations/evals only; the instincts block is always this plugin's own data). The Skill observations block also shows a `!` warning glyph on its first line when the open backlog is large (over 100) and has gone unreviewed (never, or more than 7 days ago).

In the sidebar, the panel header and every block title are clickable: the header collapses the whole panel down to that one line, and a block title collapses just that block down to its title line. Fact lines themselves are plain text (no further detail view). Both default to expanded (`board.compact: true` starts blocks collapsed instead); whichever state you leave them in is remembered across restarts. The header also shows the installed version (`Mighty Instincts v0.6.0`); the Instincts title pulses (`·`/`•`/`●`/`•`, cycling every 500ms) while an observation has landed in the last 60 seconds, and briefly switches to the success color for 5 seconds right after the observer writes a new instinct. Fully expanded, the panel reads:

```
▾ Mighty Instincts v0.6.0
  ▾ Instincts ● · haiku observer
    9 learned, 4 ready to promote
    workflow 6 · tooling 2 · tool-usage 1
    12 runs, 19 written, 0 rejected · next 3m
    applied 2 today
    learned prefer-functional-components 4m ago
  ▾ Skill observations · task-observer
  ! 398 open, review never
    verification-planning 260 · programming 38
    +43 today, +158 this week · newest 2h
  ▾ Skill evals · skill-creator
    pr, iteration 2 · 2d old, n=4
    92% with skill, 8% without
```

### Where the board state lives

```
${CLV2_HOMUNCULUS_DIR or $XDG_DATA_HOME/ecc-homunculus or ~/.local/share/ecc-homunculus}/
├── board-pointer-<sha256(project directory)[0:12]>.json   # points at the file below
└── projects/<project-hash>/
    └── board-state.json
```

The TUI half knows the real project directory (`ctx.location.directory`) but not `<project-hash>` (ECC's own git-remote hash, resolved by a python subprocess the server half already runs). So the server half also writes a small pointer file, named only from a hash of the real directory path, holding the absolute path of the real state file. Both halves resolve the pointer file's own location the same way (the ECC data directory default chain above), so the TUI never needs to run python itself.

## What gets written, and where

Everything lands in ECC's existing on-disk layout so `instinct-cli.py` (and anything else that reads it) sees the same data; the only additions are the bookkeeping files marked below:

```
${CLV2_HOMUNCULUS_DIR or $XDG_DATA_HOME/ecc-homunculus or ~/.local/share/ecc-homunculus}/
└── projects/<project-hash>/
    ├── observations.jsonl          # tool_start / tool_complete / user_prompt records
    ├── observations.archive/       # rotated out at 10 MB
    ├── observer.log                # plugin addition: one line per observer run
    ├── .observer-state.json        # plugin addition: last run time + line count for the gate
    ├── .activity.json              # plugin addition: last-observed time + today's injection count
    ├── board-state.json            # plugin addition: the board's three-block summary
    └── instincts/
        ├── personal/<id>.md        # written by the observer
        └── inherited/<id>.md       # written by `/instinct-import`
```

`observer.log` carries one line per run: `<iso> run: <N> written, <N> rejected, model <provider/model>`, with ` ids: <id>,<id>,...` appended when any instinct was written and ` rejected: <reason>; <reason>; ...` appended when any block was rejected. Both suffixes are for anyone reading the file by hand; the board only ever parses the fixed `run: N written, N rejected, model ` prefix, so older log lines without the suffixes still parse the same way.

Project identity (the `<project-hash>` above, or the shared `global` bucket when there is no git project) is resolved by calling ECC's own `detect_project()` in `vendor/ecc/instinct-cli.py`, so this plugin and the CLI agree unless resolution fails, in which case a warning is logged and the shared global bucket is used.

## Commands

| Command | Does |
| --- | --- |
| `/instinct-status` | Show instinct status (project-scoped + global). |
| `/instinct-import <file\|url> [--dry-run] [--min-confidence N] [--scope project\|global]` | Import instincts from a local file or an `https://` URL. |
| `/instinct-export [--output file] [--domain d] [--min-confidence N] [--scope project\|global\|all]` | Export instincts to stdout or a file. |
| `/evolve [--generate] [--limit N]` | Cluster instincts into skill/command/agent candidates; `--generate` writes them under `evolved/`. |
| `/promote [id] [--dry-run]` | Promote a specific instinct, or auto-promote everything that qualifies, to global scope. |
| `/instinct-projects` | List known projects and their instinct counts. |
| `/instinct-prune [--dry-run] [--max-age N]` | Delete pending instincts older than the TTL. |
| `/instinct-observe` | Run the observer right now, ignoring the enabled/interval/threshold gates. |
| `/board` | Show the board summary as plain text (Instincts, Skill observations, Skill evals). |

Every command above runs `instinct-cli.py` directly and posts its output back into the session as a synthetic message (`resume: false`); none of them start a model turn. `/instinct-import` and `/promote` pass `--force`, since typing the command is the confirmation that would otherwise come from the CLI's own `y/N` prompt.

## The `instincts` tool

The plugin also registers a tool named `instincts` that the agent can call mid-turn. It only exposes the read-only subset of the CLI: `status`, `projects`, `export` (to stdout only, no `--output`), `evolve` (preview only, no `--generate`), `promote --dry-run`, and `prune --dry-run`. It never passes `--force` and can never import, write, or delete anything.

## Observer behaviour and cost

When `observer.enabled` is `true`, every observed tool call or prompt checks whether enough time (`runIntervalMinutes`) and enough new observations (`minObservations`) have passed since the last run. When both are true, the plugin:

1. Reads the most recent observation lines (clipped per-field and capped in total size) plus the existing instinct list, so the model updates instincts instead of duplicating them.
2. Calls `ctx.generate.text({ prompt, model })` once, with no tools available to the model.
3. Parses `<instinct>...</instinct>` blocks out of the response, validates each one (id, trigger, confidence, domain, no stray `---` in the body), and writes the valid ones to `instincts/personal/`.
4. Logs the result to `observer.log`, refreshes the board state, and, if `observer.notify` is true, posts a summary into the session.

This is at most one `generate.text` call per interval, on whatever model you set in `observer.model`. `/instinct-observe` runs the same logic on demand, bypassing the enabled/interval/threshold gates (it still needs a model, from `observer.model` or the host default).

## Prompt injection

When `inject.enabled` is `true` (the default), every outgoing prompt is checked against this project's instincts plus the shared global bucket. Up to `inject.max` instincts (default 5) meeting `inject.minConfidence` (default 0.8), excluding any id listed in `inject.exclude`, are appended to the prompt text as:

```
<instincts>
- <trigger>: <first line of the instinct's ## Action section, or its title>
...
</instincts>
```

The whole block is kept under 1200 characters, dropping the lowest-confidence entries first if it would not otherwise fit. No model call is involved: this only reads instinct files already on disk. Injection is skipped when the prompt already carries this plugin's own `mightyInstincts` metadata (so a re-prompt is never injected twice), when it carries `opencode_loop_v2` or `ulw` metadata (a loop/ultrawork re-prompt, not a fresh request), or when the project has no instincts at all. A trigger that still contains a stray `confidence:` or `domain:` (frontmatter that leaked into the field) is treated as malformed and skipped, with a one-time warning logged.

Each successful injection is counted in `.activity.json` (`appliedToday`, reset at UTC midnight) and shown on the board as `applied N today`. When an injected instinct's `trigger` shares at least 3 significant words (5+ letters, case-insensitive, common filler words removed) with the prompt that triggered it, that instinct's `fired` count (in its own frontmatter) is incremented; it is not currently shown anywhere in the sidebar, but is visible in the instinct file's own frontmatter. The observer never sees the injected block itself: it is stripped from the prompt text before that text is logged as a `user_prompt` observation, so distillation always runs on what the user actually typed.

## Privacy

- Observations contain scrubbed tool inputs/outputs and prompt text (the same credential-redaction pattern ECC's shell hook uses), clipped to a few thousand characters each.
- Everything stays on disk under the data directory above. Nothing is sent anywhere except the one `generate.text` call per observer run, which goes to whichever model you configured. Prompt injection never calls a model.
- Only instincts (small learned patterns), never raw observations, can be exported with `/instinct-export`.
- The board state file contains only counts, dates, and short status strings (no observation or finding text).

## How this differs from ECC

ECC's `continuous-learning-v2` skill is built for Claude Code: a bash hook (`observe.sh`) appends observations on every `PreToolUse`/`PostToolUse` event, and a separate daemon (`observer-loop.sh`) periodically spawns a real Claude Code sub-agent (with `Read`/`Write` tools) that analyzes observations and writes instinct files itself.

OpenCode has no hook-daemon model and `ctx.generate.text` has no tools, so this plugin:

- Observes through OpenCode's own `tool.hook`/`session.hook("prompt")` instead of a shell script.
- Runs the observer in-process, as a single `generate.text` call triggered from inside the plugin (no daemon, no separate process to start or supervise). Since the model has no tools, the plugin itself parses the model's markdown output and writes the instinct files.
- Installs nothing beyond the plugin itself: no hooks are added to any Claude Code `settings.json`, no scripts are copied anywhere.

`vendor/ecc/instinct-cli.py` (status/import/export/evolve/promote/projects/prune) is used unmodified, so instincts written by this plugin are fully compatible with ECC's own tooling.

## Attribution

The instinct model, CLI, and observer prompt are from [affaan-m/ECC](https://github.com/affaan-m/ECC), vendored verbatim at commit `ef648e01899ba3e8dc6371642deaaf64b4477775` (MIT License; see `NOTICE`).

## Licence

MIT. See `LICENSE`.
