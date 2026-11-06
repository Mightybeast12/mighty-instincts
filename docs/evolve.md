# Evolve: from habits to skills

This page covers the candidate lifecycle, the `/evolve` grammar, the TUI picker, install locations and markers, usage tracking, and pruning. See [../README.md](../README.md) for the rest of the plugin.

Nothing this plugin learns ever becomes a real skill, command, agent, or AGENTS.md rule by itself. The weekly `evolve` maintenance step only ever *proposes* a candidate (`lib/maintain.js` `evolveStep`); everything past that point is a command you type.

## Lifecycle

A candidate moves through exactly three statuses, stored on the candidate file itself (`<project data dir>/evolved/<cluster-id>.md`, frontmatter `status:`; `lib/candidates.js` `CANDIDATE_STATUSES`):

| Status | Meaning |
| --- | --- |
| proposed | The weekly evolve step wrote (or updated) it. Nothing outside `evolved/` exists yet. |
| installed | `/evolve <n\|id> install` copied its drafted artefact to a real location; `installed_at` is stamped. |
| archived | Either rejected before ever being installed (`/evolve <n\|id> reject`, with an optional reason) or removed after being installed (`/evolve <n\|id> archive`). An archived candidate blocks its own cluster from ever being re-proposed. |

Re-running the weekly evolve step (or `/evolve now`) never duplicates a candidate: if a freshly computed cluster's members overlap an existing candidate's own members by 70% or more (`CANDIDATE_MEMBER_OVERLAP_THRESHOLD`, `lib/maintain.js`), that candidate's `members` list is refreshed in place instead of a second candidate being written for the same cluster.

## Kinds

Each cluster of 3+ related instincts (`EVOLVE_MIN_CLUSTER_SIZE`, `lib/maintain.js`) sharing significant trigger/summary words (`EVOLVE_OVERLAP_THRESHOLD = 0.3`, `lib/maintain.js`) is proposed as one of four kinds, chosen from the cluster's own size and content, with no model call (`lib/candidates.js` `selectCandidateKind`):

| Cluster | Kind |
| --- | --- |
| 3 members | **rule**: a 1-3 line AGENTS.md snippet, one bullet per member. |
| 4-5 members, summaries read as run/check/verify/test/lint/build/scan steps | **command**: a `commands/<name>.md` draft (`description:` frontmatter, then the steps). |
| 4-5 members, otherwise | **skill**: a full `SKILL.md` draft (`name:`/`description:` frontmatter, member summaries as `## Rules`). |
| 6+ members | **skill**. |
| any size, if a member mentions delegation or a specialist role | **agent**: an agent markdown draft (`description:`/`mode: subagent` frontmatter, member summaries as responsibilities). This overrides every size rule above. |

## The `/evolve` grammar

Token order is free (`/evolve install 2` is the same as `/evolve 2 install`); a bare digit is a pick index, a verb word is the verb, and the first remaining token is the pick id (`lib/evolve-command.js` `EVOLVE_VERBS`/`USAGE`, `lib/evolve-command.js` `parseEvolveArgs`).

| Command | Does |
| --- | --- |
| `/evolve` | Dashboard: every candidate (proposed/installed/archived), with status, kind, member count, usage, and age; falls back to the deterministic cluster preview when nothing is proposed yet. Changes nothing. |
| `/evolve <n\|id>` | Detail of one candidate: kind, target path, members, full drafted body, plus a next-step hint line. `n` is the number shown by the dashboard (or the board's own numbered hints); `id` works too and never goes stale. Changes nothing. |
| `/evolve <n\|id> install` | Look-before-leap install (see below). |
| `/evolve <n\|id> reject [why]` | Archive a `proposed` candidate without installing it, with an optional reason; every token after `reject` is taken verbatim as the reason, however it looks. |
| `/evolve <n\|id> archive` | Archive any non-archived candidate; for an installed one, also removes the file it installed, but only when ownership and content still match exactly what was installed. |
| `/evolve now` | Run the weekly `evolve` (propose/refresh candidates from today's clusters) and `pruneCandidates` maintenance steps immediately. |
| `/evolve clusters [N]` | The deterministic preview (no model call, no `instinct-cli.py`) of today's top instinct clusters: member ids, average confidence, a "why" naming the words they share, and a suggested form sized by cluster. `--limit N` is also accepted. |

### Look-before-leap install

`install` is deliberately look-before-leap (`lib/evolve-command.js` `runInstall`): the first call against a candidate (or any call after its body changed since) only re-renders that same detail and asks for the command again ("Run `/evolve <ref> install` again to install."); a repeat against that exact, unchanged candidate is what actually writes it, as a real skill, command, agent, or AGENTS.md rule. This guarantees there is always a preview (what it is, where it would go, every member instinct behind it, and its full body) immediately before the write, within the same running process. Refuses outright if the target is a symlink, or already exists and was not written by this plugin for this exact candidate (see "Install locations and markers" below).

The five commands `/evolve-list [id]`, `/evolve-show <id>`, `/evolve-install <id> [--yes]`, `/evolve-reject <id> [reason]`, and `/evolve-archive <id>`, from v0.10.0 and earlier, remain registered for one release as deprecated aliases that forward their old argv shape straight into the grammar above, each prefixing its reply with a one-line deprecation notice (`lib/commands.js`).

## The TUI picker

On the OpenCode 2 TUI, typing `/evolve` with no arguments opens a pick-a-candidate / pick-an-action / confirm flow instead of the server's text dashboard, so a human never types an id or a 1-based index by hand (`tui.js` `mountEvolvePicker`/`runEvolvePicker`, `lib/evolve-picker.js`). Every write still happens through the server's own `/evolve` command with its own gates; the picker only ever assembles the exact `/evolve ...` text that command already accepts (`lib/evolve-picker.js` `commandTextFor`) and dispatches it through `ctx.client.session.command()`, the same call a typed slash command resolves to. Feature-detected on `ctx.keymap.layer`, `ctx.ui.dialog.select`, and `ctx.ui.slot`; any one missing and nothing here mounts, leaving the server's own dashboard untouched.

Flow: pick a candidate (or "propose from clusters" / "show clusters" / "open the text dashboard"), then pick an action (show / install / reject / archive, filtered by the candidate's own status the same way the server would refuse them), confirm when the action needs one, then dispatch. Install's confirm message never promises a write on that exact confirm ("Shows the detail first; pick Install again to write it."), since the picker cannot tell from its own side whether a given dispatch landed on the arming half or the writing half of the server's look-before-leap gate.

### Open question: slash-name precedence

No documented rule covers what happens when a server-registered command (`lib/commands.js`) and a TUI keymap layer's `slash: { name: "evolve" }` (`tui.js`) share the exact same name. Two outcomes are possible: either the TUI layer wins the name, in which case any non-empty typed input is forwarded unchanged to the server command, so `/evolve 2 install` typed by hand behaves identically to before; or the server command wins outright, in which case the picker never activates and typing `/evolve` falls back to the pre-existing text dashboard. `tui.js` is written so either outcome is safe, but which one actually happens could not be confirmed without a live TUI host.

## Install locations and markers

| Kind | Default location | Override |
| --- | --- | --- |
| skill | `~/.config/opencode/skills/<suggested_name>/SKILL.md` | `evolve.targets.skill` (an absolute directory) |
| command | `~/.config/opencode/commands/<suggested_name>.md` | `evolve.targets.command` |
| agent | `~/.config/opencode/agents/<suggested_name>.md` | `evolve.targets.agent` |
| rule | `<project root>/AGENTS.md`, appended under `## Learned rules (mighty-instincts)` | `evolve.targets.rule` (an absolute file) |

(`lib/candidates.js` `resolveEvolveTargets`/`installPathFor`/`resolveRuleFile`.) Every `evolve.targets.*` override must be absolute once `~` is expanded; a relative value is rejected (with a one-time warning naming which target) and the real default location is used instead.

Every file `install` writes carries three identifying fields in its own frontmatter (`lib/candidates.js` `GENERATED_BY_MARKER`/`injectGeneratedMarkers`): `generated_by: mighty-instincts`, `candidate_id: <this candidate's id>`, and `project_id: <the project that installed it>`, plus `members: [<member instinct ids>]`. A rule's AGENTS.md snippet carries the same `candidate_id`/`project_id` pair instead, on a bracketing pair of HTML comments (`lib/candidates.js`), so removing one candidate's rule can never eat into a neighbouring one's, or into text typed by hand under that heading. `install` also records a sha256 `installed_hash` of exactly what it wrote.

Before touching anything, `install` and `archive` both check: the target is not a symlink; its frontmatter (or, for a rule, its start marker) carries this exact `candidate_id` and `project_id`; and, for `archive` only, that the file's content still hashes to its own recorded `installed_hash` (otherwise a human has edited it since, and it is left alone) (`lib/candidates.js`). Any mismatch refuses the write (install) or leaves the file in place with a note (archive); the file is never silently clobbered or deleted.

## Usage tracking

`<project data dir>/usage.json` counts every skill/command/agent actually used, generated by this plugin or not: the `skill` tool's own calls by `input.id` (or `input.name`), slash commands by name whenever a prompt starts with `/`, and subagent spawns (`subagent`/`task` tool) by `input.agent` (or `input.subagent_type`) (`lib/observe.js` `trackToolUsage`/`trackCommandUsage`, `lib/usage.js` `bumpUsage`). This depends on the host naming its tools and input fields one of those ways; a host that names them differently simply never registers usage for that kind, which is why pruning below treats a kind's entirely-empty usage bucket as "the signal looks dead", not as proof every installed candidate of that kind is unused (`lib/usage.js` `isUsageBucketEmpty`). `/evolve`'s dashboard and the board both read an installed candidate's own usage back by its `suggested_name`.

Command-usage counting runs inside the same `observePrompts` gate as prompt observation (`lib/observe.js` `trackCommandUsage` is only ever called from the `observePrompts` branch of `registerObserve`): setting `observePrompts: false` also turns off command-usage counting, so every installed command candidate's usage bucket looks entirely empty, which is exactly the "signal looks dead" case pruning above refuses to act on.

### Feedback

Whenever an installed candidate's `suggested_name` is actually used, every one of its member instincts gets its `fired` count bumped, wherever that member lives (project personal, inherited, or the shared global bucket) (`lib/observe.js` `applyCandidateFeedback`). A member that has fired at least once is exempt from the maintenance loop's `decay` step, so the habits behind a useful artefact never decay just because people now reach for the artefact instead of the injected instinct directly.

## Pruning (report-only by default)

The weekly evolve step also runs `pruneCandidates` (`lib/maintain.js` `pruneCandidatesStep`): any *installed* candidate with zero uses in `prune.unusedDays` days (default 30, and only once it has been installed at least that long) is flagged, never touched, unless `prune.auto` is explicitly turned on, in which case it is archived and its installed file removed (the same ownership- and hash-gated removal `archive` does). Even in auto mode, a kind whose usage bucket is entirely empty is never auto-archived, and every candidate is handled in its own try/catch, so one failure is logged and skipped rather than aborting the rest of the sweep. Rule candidates are never flagged this way: an AGENTS.md line has no runtime "it was used" signal to measure. `/evolve`'s dashboard separately reports hand-written assets (skills/commands/agents that never carried the `generated_by` marker in the first place) with zero uses in the same window, under "unused (not generated)" (`lib/evolve-command.js`); these are never archived or removed, automatically or otherwise, since this plugin did not write them.
