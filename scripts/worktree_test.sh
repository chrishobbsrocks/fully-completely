#!/usr/bin/env bash
# Test for scripts/dev2_worktree.sh: verifies it creates a real, isolated
# git worktree on the expected branch, reuses it on a second call instead
# of recreating it, and rejects a bad sprint id. Exits non-zero on the
# first unexpected result.
#
# Mirrors smoke_test.sh's sandboxing rule: dev2_worktree.sh creates its
# worktree as a *sibling* of whatever repo it's run from
# ($(dirname "$REPO_ROOT")/<repo>-devteam2-sprint-<id>), so this test runs
# it against a throwaway clone of this repo in a temp directory, never
# against the actual repo you're invoking this test from. Do not repoint
# this at $REPO_ROOT directly, that would create and destroy worktrees
# next to whatever real checkout is running the test.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

SANDBOX_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/fully-completely-worktree-test.XXXXXX")"
CLONE="$SANDBOX_PARENT/repo"
cleanup() { rm -rf "$SANDBOX_PARENT"; }
trap cleanup EXIT

fail() { echo "WORKTREE TEST FAILED: $1" >&2; exit 1; }

git clone --quiet "$REPO_ROOT" "$CLONE"
git -C "$CLONE" config user.email "worktree-test@example.com"
git -C "$CLONE" config user.name "Worktree Test"

echo "== creates a new worktree on a new branch =="
OUTPUT=$(cd "$CLONE" && bash scripts/dev2_worktree.sh 42)
echo "$OUTPUT" | grep -q "Dev Team 2 worktree ready" || fail "expected ready message missing: $OUTPUT"

EXPECTED_DIR="$SANDBOX_PARENT/repo-devteam2-sprint-42"
[ -d "$EXPECTED_DIR" ] || fail "worktree directory was not created at $EXPECTED_DIR"
git -C "$CLONE" show-ref --verify --quiet "refs/heads/devteam2/sprint-42" || fail "branch devteam2/sprint-42 was not created"
BRANCH_IN_WORKTREE="$(git -C "$EXPECTED_DIR" rev-parse --abbrev-ref HEAD)"
[ "$BRANCH_IN_WORKTREE" = "devteam2/sprint-42" ] || fail "worktree is checked out on '$BRANCH_IN_WORKTREE', not devteam2/sprint-42"

echo "== reuses the same worktree on a second call instead of recreating it =="
OUTPUT2=$(cd "$CLONE" && bash scripts/dev2_worktree.sh 42)
echo "$OUTPUT2" | grep -q "Worktree already exists, reusing it." || fail "second call did not report reuse: $OUTPUT2"

echo "== rejects a non-numeric sprint id =="
set +e
(cd "$CLONE" && bash scripts/dev2_worktree.sh abc) > /tmp/wt_out.txt 2>&1
BAD_ID_STATUS=$?
set -e
[ "$BAD_ID_STATUS" -ne 0 ] || fail "non-numeric sprint id was accepted"
grep -q "must be a positive integer" /tmp/wt_out.txt || fail "bad sprint id error message missing"
rm -f /tmp/wt_out.txt

echo "== rejects a missing sprint id argument =="
set +e
(cd "$CLONE" && bash scripts/dev2_worktree.sh) > /tmp/wt_out2.txt 2>&1
NO_ARG_STATUS=$?
set -e
[ "$NO_ARG_STATUS" -ne 0 ] || fail "missing sprint id argument was accepted"
grep -q "Usage:" /tmp/wt_out2.txt || fail "missing-argument usage message missing"
rm -f /tmp/wt_out2.txt

echo "ALL WORKTREE TESTS PASSED"
