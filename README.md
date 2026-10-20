# mighty-instincts

An [OpenCode](https://opencode.ai) V2 plugin that observes session activity (tool calls and prompts) into a per-project log, periodically has a cheap model distil that log into small learned "instincts," and exposes [ECC](https://github.com/affaan-m/ECC)'s instinct CLI as slash commands. Nothing becomes live on its own: `/evolve` only writes inert markdown, the observer is off by default, and the plugin never injects instincts into a prompt.

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
| `board.enabled` | Turn the sidebar board and the `/board` command off entirely. |
| `board.sections.instincts` / `.observations` / `.evals` | Show or hide one block of the board. |
| `board.compact` | Start every board block collapsed to its title line only; still expandable by clicking. Does not affect the panel header. |
| `board.refreshSeconds` | How often the board state file is recomputed on a timer (it is also refreshed on plugin setup and after every observer run). |
| `board.observationsRoot` | Absolute path (or one starting with `~/`) to the task-observer skill's data directory. Defaults to `~/.local/share/opencode/task-observer`. |
| `board.evalRoots` | Array of absolute paths (or ones starting with `~/`) to search for skill-creator benchmark output. Defaults to `["~/.config/opencode/skills", "$TMPDIR/opencode"]`. |

## The board

The board is a small, read-only summary of three sources, written by the server half of the plugin to a per-project `board-state.json` file and polled every 30 seconds (or refreshed on request) by the TUI sidebar panel and by `/board`:

- **Instincts**: this plugin's own project/inherited/global instinct counts, when the observer last ran, how many observations are pending, and when the observer is next eligible to run.
- **Skill observations**: the task-observer skill's open/parked observation counts, the last backlog review date, and how many staged skill updates are still pending.
- **Skill evals**: the newest benchmark the skill-creator skill produced (skill name, iteration, and the two pass rates it compared).

Each block is independently optional (`board.sections`) and shows `!` / "not found" when its data source is not present (observations/evals only; the instincts block is always this plugin's own data).

In the sidebar, the panel header and every block title are clickable: the header collapses the whole panel down to that one line, and a block title collapses just that block down to its title line. Both default to expanded (`board.compact: true` starts blocks collapsed instead); whichever state you leave them in is remembered across restarts. Fully expanded, the panel reads:

```
▾ Mighty Instincts
▾ Instincts · haiku observer
  5 learned here, 0 global
  next run in 3m, 14 new events
▾ Skill observations · task-observer
  308 open, 2 parked
  last review 3d ago, 1 staged
▾ Skill evals · skill-creator
  pr, iteration 2
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
    ├── board-state.json            # plugin addition: the board's three-block summary
    └── instincts/
        ├── personal/<id>.md        # written by the observer
        └── inherited/<id>.md       # written by `/instinct-import`
```

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

Every command runs `instinct-cli.py` directly and posts its output back into the session as a synthetic message (`resume: false`); none of them start a model turn. `/instinct-import` and `/promote` pass `--force`, since typing the command is the confirmation that would otherwise come from the CLI's own `y/N` prompt.

## The `instincts` tool

The plugin also registers a tool named `instincts` that the agent can call mid-turn. It only exposes the read-only subset of the CLI: `status`, `projects`, `export` (to stdout only, no `--output`), `evolve` (preview only, no `--generate`), `promote --dry-run`, and `prune --dry-run`. It never passes `--force` and can never import, write, or delete anything.

## Observer behaviour and cost

When `observer.enabled` is `true`, every observed tool call or prompt checks whether enough time (`runIntervalMinutes`) and enough new observations (`minObservations`) have passed since the last run. When both are true, the plugin:

1. Reads the most recent observation lines (clipped per-field and capped in total size) plus the existing instinct list, so the model updates instincts instead of duplicating them.
2. Calls `ctx.generate.text({ prompt, model })` once, with no tools available to the model.
3. Parses `<instinct>...</instinct>` blocks out of the response, validates each one (id, trigger, confidence, domain, no stray `---` in the body), and writes the valid ones to `instincts/personal/`.
4. Logs the result to `observer.log`, refreshes the board state, and, if `observer.notify` is true, posts a summary into the session.

This is at most one `generate.text` call per interval, on whatever model you set in `observer.model`. `/instinct-observe` runs the same logic on demand, bypassing the enabled/interval/threshold gates (it still needs a model, from `observer.model` or the host default).

## Privacy

- Observations contain scrubbed tool inputs/outputs and prompt text (the same credential-redaction pattern ECC's shell hook uses), clipped to a few thousand characters each.
- Everything stays on disk under the data directory above. Nothing is sent anywhere except the one `generate.text` call per observer run, which goes to whichever model you configured.
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
