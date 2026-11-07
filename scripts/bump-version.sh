#!/usr/bin/env bash
# bump-version.sh <old> <new> - update every place outside package.json
# that names the package version. scripts/release.sh calls this right
# after `npm version`, when the script exists, and commits what it changed.
#
# This repo: the panel-header example "Mighty Instincts v<old>" in
# README.md and docs/board.md, and CHANGELOG.md's "## Unreleased" heading,
# which becomes "## v<new> (<date>)". smoke/readme.mjs checks both.
set -euo pipefail

OLD="${1:?usage: bump-version.sh <old-version> <new-version>}"
NEW="${2:?usage: bump-version.sh <old-version> <new-version>}"
REPO_DIR="${BUMP_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

function replace_in() {
    local file="$1" from="$2" to="$3"
    grep -qF -- "$from" "$file" || { echo "bump-version: '$from' not found in $file" >&2; return 1; }
    FROM="$from" TO="$to" perl -0pi -e 's/\Q$ENV{FROM}\E/$ENV{TO}/g' "$file"
}

replace_in "$REPO_DIR/README.md" "Mighty Instincts v$OLD" "Mighty Instincts v$NEW"
replace_in "$REPO_DIR/docs/board.md" "Mighty Instincts v$OLD" "Mighty Instincts v$NEW"
replace_in "$REPO_DIR/CHANGELOG.md" "## Unreleased" "## v$NEW ($(date +%F))"

echo "bump-version: $OLD -> $NEW in README.md, docs/board.md, CHANGELOG.md"
