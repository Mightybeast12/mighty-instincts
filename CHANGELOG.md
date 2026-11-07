# Changelog

One entry per release tag (`git tag --sort=-v:refname`), newest first. Each bullet is one of `git log <previous-tag>..<tag> --format=%s`; the bare "Release X" version-bump commit is omitted wherever a tag also has a substantive commit, and the Unreleased bullets below are condensed summaries, not verbatim commit subjects.

## Unreleased

- Read `prune.unusedDays` through one `resolveUnusedDays` helper everywhere.
- Rewrite the README as a front door, move detail to docs/, add a CHANGELOG: README.md is the install page (defaults block, options table, command table, aliases, board, privacy, development); docs/ holds board, observer, evolve, instinct, maintenance, skill-review, data-layout and ecc; `smoke/readme.mjs` fails the suite when the README or docs drift from the code.
- Add /instinct and /maintain families, skill review install, TUI evolve picker: `/instinct <verb>` replaces the five hyphenated commands (kept as deprecated aliases) with status/projects/export/import/observe plus why/keep/wrong/mute/unmute/observer on|off/doctor/help; `/maintain [--dry-run]` and `/maintain prune` run the sweep (or just the pending prune) on demand; `/promote` now uses the real `promoteStep` rule instead of the Python passthrough; `/skill-review install [n|all]` and `/skill-review undo` install or revert staged skill updates after a seed-vs-live check, with per-operation backups; the OpenCode 2 TUI's `/evolve` (no arguments) opens a pick-a-candidate/action/confirm dialog.
- Unify /evolve, harden the observer, make the board actionable, add one CI gate: `/evolve` became one command (dashboard, detail, `<n|id> install|reject|archive`, `now`, `clusters`), replacing five separate commands kept as deprecated aliases; the observer's failures now back off 5/15/60 minutes and `observer.model` is required with a one-time notice; the board's hint rows name the exact command to run and gained a Health block; `scripts/check.sh` added as the one gate behind the pre-commit hook, `release.sh`, and CI.

## v0.10.0 (2026-11-06)

- Show notice content in the OpenCode 2 chat row instead of the bare package name.

## v0.9.3 (2026-11-02)

- Make the release CI gate wait for the pushed commit's own run.
- Require the Actions to share a subject before dedupe merges.
- Never promote a repository-named or retired instinct to the global store.
- Never let the model replace an instinct body it was never shown.

## v0.9.2 (2026-11-02)

- Inject an instinct once when the project and global stores both hold it.
- Stop dedupe merging an instinct's own update into another instinct.

## v0.9.1 (2026-10-26)

- Explain the Skill test comparison and verdict on the board.

## v0.9.0 (2026-10-25)

- Add automatic scheduled skill review and `/skill-review` command.

## v0.8.3 (2026-10-23)

- Count a habit as used once per human prompt; visible CLI output clip.

## v0.8.2 (2026-10-23)

- Clearer `/board`, honest eval glyph, pending rule, dedupe, promotion and cleanup fixes.

## v0.8.1 (2026-10-23)

- Add `scripts/release.sh`.

## v0.8.0 (2026-10-23)

- From habits to skills: candidate lifecycle with confirmed installs.

## v0.7.1 (2026-10-22)

- Immediate command output, explanatory `/board` and `/evolve`, panel fixes.

## v0.7.0 (2026-10-21)

- Plain-language panel, invisible injection, hands-off maintenance.

## v0.6.0 (2026-10-20)

- Activity, prompt injection and fired tracking; drop the detail panel.

## v0.5.1 (2026-10-20)

- Make the detail panel closable.

## v0.5.0 (2026-10-20)

- Richer board facts and a detail panel.

## v0.4.0 (2026-10-20)

- Redesign the sidebar board: collapsible blocks, plain wording, no Review.

## v0.3.0 (2026-10-20)

- Release 0.3.0.
- Keep Python bytecode out of the npm tarball.
- Rename to mighty-instincts and add the sidebar board.
- Tighten the observer gate, CLI argument handling, and project resolution.
- Port ECC continuous-learning-v2 to the OpenCode V2 plugin API.
