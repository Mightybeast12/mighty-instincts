#!/usr/bin/env bash
set -euo pipefail

# check.sh - the one gate scripts/release.sh, .githooks/pre-commit, and
# .github/workflows/publish.yml all run through, so there is exactly one
# place that decides what "green" means for this repo.
#
# Install the pre-commit hook with:
#   npm run hooks
#
# Usage: scripts/check.sh [--only <stage>[,<stage>...]] [--staged]
#                          [--allow-missing-bun] [--self-test]
#
# Stages (run in this order unless --only narrows the list):
#   syntax    node --check on every tracked .js/.mjs file (or, with
#             --staged, on the staged .js/.mjs blobs read via
#             `git show :<path>`, not whatever is currently sitting on
#             disk)
#   smoke     node smoke-test.mjs, then bun smoke-test.mjs; the bun run
#             fails the stage unless bun is missing AND
#             --allow-missing-bun was passed, in which case it is skipped
#             with a loud notice instead of silently passing
#   dashes    no em dash (U+2014) or en dash (U+2013) in tracked
#             .js/.mjs/.md/.json/.sh/.yml files, plus .githooks/pre-commit
#             (vendor/ and .slim/ excluded; with --staged, the staged
#             blobs for that same file set, again via `git show`); the
#             byte-sequence detector proves itself against a scratch
#             fixture before it is trusted against the repo
#   skeleton  scripts/sync-skeleton.sh --check against the sibling repo
#             this skeleton is shared with; skipped with a loud notice
#             when the sibling directory cannot be found
#
# Flags:
#   --only <stage>[,<stage>,...]   run only the named stage(s) (always in
#                                  the canonical order above, regardless
#                                  of the order given here)
#   --staged                       syntax and dashes scan
#                                  `git diff --cached --name-only
#                                  --diff-filter=ACMR` instead of every
#                                  tracked file, and judge each file's
#                                  staged blob (`git show :<path>`)
#                                  rather than its working tree copy, so
#                                  a partially staged file (git add -p)
#                                  is judged on what is actually about
#                                  to be committed (used by the
#                                  pre-commit hook; smoke and skeleton
#                                  ignore this flag, they always run
#                                  against the full tree/sibling)
#   --allow-missing-bun           let the smoke stage pass when bun is
#                                  not on PATH, instead of failing
#   --self-test                   run only the dash detector's own
#                                  positive self-test and exit; every
#                                  other flag is ignored
#
# Every stage is a real gate: a failure exits non-zero and stops the
# caller immediately, it never just prints and carries on.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

STAGES_ALL=(syntax smoke dashes skeleton)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

function log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
function log_warn() { echo -e "${YELLOW}[WARN]${NC} $1" >&2; }
function log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

function usage() {
    echo "Usage: $0 [--only <stage>[,<stage>...]] [--staged] [--allow-missing-bun] [--self-test]"
    echo ""
    echo "Stages: ${STAGES_ALL[*]}"
}

function resolve_bin() {
    local name="$1"
    if command -v "$name" >/dev/null 2>&1; then
        command -v "$name"
        return 0
    fi
    if [[ -x "/opt/homebrew/bin/$name" ]]; then
        echo "/opt/homebrew/bin/$name"
        return 0
    fi
    return 1
}

function require_deps() {
    command -v git >/dev/null 2>&1 || { log_error "git is required"; exit 1; }
    NODE_BIN="$(resolve_bin node)" \
        || { log_error "node not found on PATH or at /opt/homebrew/bin/node"; exit 1; }
}

ONLY=""
STAGED=0
ALLOW_MISSING_BUN=0
SELF_TEST=0

function parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --only)
                [[ $# -ge 2 ]] || { log_error "--only requires an argument"; exit 1; }
                ONLY="$2"
                shift 2
                ;;
            --only=*)
                ONLY="${1#--only=}"
                shift
                ;;
            --staged)
                STAGED=1
                shift
                ;;
            --allow-missing-bun)
                ALLOW_MISSING_BUN=1
                shift
                ;;
            --self-test)
                SELF_TEST=1
                shift
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            *)
                log_error "Unknown argument: $1"
                usage
                exit 1
                ;;
        esac
    done
}

# scratch_dir - a fresh directory for files this script creates at run
# time, nested the same way smoke-test.mjs nests its own fixtures
# (os.tmpdir()/opencode/...) instead of writing straight into the bare
# system temp root.
function scratch_dir() {
    local base="${TMPDIR:-/tmp}/opencode"
    mkdir -p "$base"
    mktemp -d "$base/mighty-instincts-check.XXXXXX"
}

# file_has_dash <file> - true (exit 0) when the file contains an em dash
# (U+2014) or en dash (U+2013). Matches the UTF-8 byte sequences
# directly, under LC_ALL=C, rather than using grep -P (which does not
# exist on macOS's BSD grep) and rather than \| inside a basic regex
# (also a GNU-only extension: BSD grep silently matches nothing and
# exits 1, which a caller that pipes it through 2>/dev/null misreads as
# "no dashes found"). -E with a plain | is portable across BSD and GNU
# grep.
function file_has_dash() {
    LC_ALL=C grep -qE $'\xe2\x80\x93|\xe2\x80\x94' "$1"
}

# dash_self_test - proves file_has_dash actually catches a dash before
# any real scan trusts it: writes a scratch fixture containing an en
# dash and requires the detector to flag it. A detector that only
# prints a result without ever being proven against a known positive
# is not a gate.
function dash_self_test() {
    local dir
    dir="$(scratch_dir)"
    local fixture="$dir/en-dash-fixture.txt"
    printf 'a sentence with an en dash \xe2\x80\x93 right in it\n' > "$fixture"

    local caught=0
    if file_has_dash "$fixture"; then
        caught=1
    fi
    rm -rf "$dir"

    if [[ "$caught" -ne 1 ]]; then
        log_error "dash detector broken: failed to catch an en dash in its own positive self-test fixture"
        return 1
    fi
    log_info "dashes: self-test passed (detector caught an en dash in a scratch fixture)"
}

function stage_syntax() {
    local label="tracked"
    local files
    local staged_root=""
    if [[ "$STAGED" -eq 1 ]]; then
        label="staged"
        files="$(git -C "$REPO_DIR" diff --cached --name-only --diff-filter=ACMR -- '*.js' '*.mjs' || true)"
        staged_root="$(scratch_dir)"
        # node --check reads the nearest package.json to tell ESM from CJS;
        # without it a .js blob parses as CommonJS and every `import` fails.
        git -C "$REPO_DIR" show :package.json > "$staged_root/package.json" 2>/dev/null \
            || cp "$REPO_DIR/package.json" "$staged_root/package.json"
    else
        files="$(git -C "$REPO_DIR" ls-files -- '*.js' '*.mjs')"
    fi

    local count=0
    local file check_path
    while IFS= read -r file; do
        [[ -z "$file" ]] && continue
        if [[ -n "$staged_root" ]]; then
            # Read the staged blob (git show :<path>), not the working
            # tree copy: a partially staged file (git add -p) can have
            # unstaged edits on disk that differ from what is actually
            # about to be committed, and this gate must judge the
            # latter. `git show` is an external command, so `||
            # continue` here is safe: it is only shell *functions*
            # invoked in a test context (||, if, while) that run with
            # -e silently suppressed for their entire body (see
            # run_stage above); a plain external command has no such
            # hazard.
            check_path="$staged_root/$file"
            mkdir -p "$(dirname "$check_path")"
            git -C "$REPO_DIR" show ":$file" > "$check_path" 2>/dev/null || continue
        else
            [[ -f "$REPO_DIR/$file" ]] || continue
            check_path="$REPO_DIR/$file"
        fi
        count=$((count + 1))
        "$NODE_BIN" --check "$check_path"
    done <<< "$files"

    if [[ -n "$staged_root" ]]; then
        rm -rf "$staged_root"
    fi

    log_info "syntax: node --check passed on $count $label .js/.mjs file(s)"
}

function stage_smoke() {
    log_info "smoke: running smoke-test.mjs under node..."
    (cd "$REPO_DIR" && "$NODE_BIN" smoke-test.mjs)
    log_info "smoke: node smoke-test.mjs passed"

    if command -v bun >/dev/null 2>&1; then
        log_info "smoke: running smoke-test.mjs under bun..."
        (cd "$REPO_DIR" && bun smoke-test.mjs)
        log_info "smoke: bun smoke-test.mjs passed"
    elif [[ "$ALLOW_MISSING_BUN" -eq 1 ]]; then
        log_warn "smoke: bun not found on PATH, SKIPPING the bun run because --allow-missing-bun was passed"
    else
        log_error "smoke: bun not found on PATH; install bun or pass --allow-missing-bun to skip the bun run deliberately"
        return 1
    fi
}

function stage_dashes() {
    dash_self_test || { log_error "dashes: refusing to trust a broken detector"; return 1; }

    local label="tracked"
    local files
    local staged_root=""
    if [[ "$STAGED" -eq 1 ]]; then
        label="staged"
        files="$(git -C "$REPO_DIR" diff --cached --name-only --diff-filter=ACMR -- \
            '*.js' '*.mjs' '*.md' '*.json' '*.sh' '*.yml' '.githooks/pre-commit' \
            ':!:vendor/**' ':!:.slim/**' || true)"
        staged_root="$(scratch_dir)"
    else
        files="$(git -C "$REPO_DIR" ls-files -- \
            '*.js' '*.mjs' '*.md' '*.json' '*.sh' '*.yml' '.githooks/pre-commit' \
            ':!:vendor/**' ':!:.slim/**')"
    fi

    local offenders=""
    local count=0
    local file scan_path
    while IFS= read -r file; do
        [[ -z "$file" ]] && continue
        if [[ -n "$staged_root" ]]; then
            # Same reasoning as stage_syntax above: judge the staged
            # blob, not whatever is currently sitting on disk.
            scan_path="$staged_root/$file"
            mkdir -p "$(dirname "$scan_path")"
            git -C "$REPO_DIR" show ":$file" > "$scan_path" 2>/dev/null || continue
        else
            [[ -f "$REPO_DIR/$file" ]] || continue
            scan_path="$REPO_DIR/$file"
        fi
        count=$((count + 1))
        if file_has_dash "$scan_path"; then
            offenders+="$file"$'\n'
        fi
    done <<< "$files"

    if [[ -n "$staged_root" ]]; then
        rm -rf "$staged_root"
    fi

    if [[ -n "$offenders" ]]; then
        log_error "dashes: em dash (U+2014) or en dash (U+2013) found in:"
        echo "$offenders" >&2
        return 1
    fi
    log_info "dashes: no em or en dashes found in $count $label file(s)"
}

function stage_skeleton() {
    local rc=0
    bash "$SCRIPT_DIR/sync-skeleton.sh" --check || rc=$?
    case "$rc" in
        0)
            log_info "skeleton: no drift against the sibling repo"
            return 0
            ;;
        2)
            log_warn "skeleton: sibling repo directory not found; SKIPPING the skeleton check"
            return 2
            ;;
        *)
            log_error "skeleton: drift found between this repo and the sibling (diff above)"
            return 1
            ;;
    esac
}

# run_stage <name> - runs stage_<name> and turns its exit code into a
# one-line PASS/SKIP/FAIL summary, exiting on FAIL.
#
# The stage is run as `( set -e; stage_fn )` rather than plain
# `stage_fn || rc=$?`: a function call on the left of `||` (or inside an
# `if`/`while` test) runs with -e suppressed for every command in its
# *entire* body, not just the top-level call, which is exactly the trap
# that let a crashing node/bun smoke run still log "passed" and return
# 0 here. A fresh `( set -e; ... )` subshell re-enables -e for the
# stage's own commands while still letting this function observe and
# react to its exit code afterwards instead of being torn down by it.
function run_stage() {
    local name="$1"
    local rc=0
    set +e
    ( set -e; "stage_$name" )
    rc=$?
    set -e
    case "$rc" in
        0) log_info "[check] PASS: $name" ;;
        2) log_warn "[check] SKIP: $name" ;;
        *)
            log_error "[check] FAIL: $name"
            exit 1
            ;;
    esac
}

function main() {
    parse_args "$@"
    require_deps

    if [[ "$SELF_TEST" -eq 1 ]]; then
        if dash_self_test; then
            exit 0
        fi
        exit 1
    fi

    local -a requested
    if [[ -n "$ONLY" ]]; then
        IFS=',' read -ra requested <<< "$ONLY"
    else
        requested=("${STAGES_ALL[@]}")
    fi

    local r
    for r in "${requested[@]}"; do
        case "$r" in
            syntax|smoke|dashes|skeleton) ;;
            *)
                log_error "Unknown stage: $r (expected one of: ${STAGES_ALL[*]})"
                exit 1
                ;;
        esac
    done

    # Always run requested stages in the canonical order above,
    # regardless of the order --only listed them in.
    local -a stages=()
    local s
    for s in "${STAGES_ALL[@]}"; do
        for r in "${requested[@]}"; do
            if [[ "$r" == "$s" ]]; then
                stages+=("$s")
                break
            fi
        done
    done

    for s in "${stages[@]}"; do
        run_stage "$s"
    done

    log_info "check.sh: all requested stages passed (${stages[*]})"
}

main "$@"
