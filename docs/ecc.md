# How this differs from ECC

This page covers how this plugin's implementation differs from upstream ECC's own `continuous-learning-v2` skill. See [../README.md](../README.md) for the rest of the plugin.

ECC's `continuous-learning-v2` skill is built for Claude Code: a bash hook (`observe.sh`) appends observations on every `PreToolUse`/`PostToolUse` event, and a separate daemon (`observer-loop.sh`) periodically spawns a real Claude Code sub-agent (with `Read`/`Write` tools) that analyzes observations and writes instinct files itself.

OpenCode has no hook-daemon model and `ctx.generate.text` has no tools, so this plugin:

- Observes through OpenCode's own `tool.hook`/`session.hook("prompt")` instead of a shell script (`lib/observe.js`).
- Injects through `session.hook("context")` instead of editing prompt text, and runs its own maintenance sweep (promote/prune/decay/dedupe/evolve/repair/cleanupProjects) in-process on a timer, instead of relying on someone to run the CLI's equivalent commands by hand (`lib/inject.js`, `lib/maintain.js`).
- Runs the observer in-process, as a single `generate.text` call triggered from inside the plugin (no daemon, no separate process to start or supervise). Since the model has no tools, the plugin itself parses the model's markdown output and writes the instinct files (`lib/observer.js`).
- Installs nothing beyond the plugin itself: no hooks are added to any Claude Code `settings.json`, no scripts are copied anywhere.

`vendor/ecc/instinct-cli.py` (status/import/export/evolve/promote/projects/prune) is used unmodified, so instincts written by this plugin are fully compatible with ECC's own tooling. The vendored CLI's own `evolve --generate` is never run by this plugin: the `/evolve` lifecycle (see [evolve.md](evolve.md)) is a separate, JS-only reimplementation that the CLI's own evolve output was never wired to read.

The instinct model, CLI, and observer prompt are from [affaan-m/ECC](https://github.com/affaan-m/ECC), vendored verbatim at commit `ef648e01899ba3e8dc6371642deaaf64b4477775` (MIT License; see `NOTICE`).
