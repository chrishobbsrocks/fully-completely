#!/usr/bin/env bash
# Smoke test for the sprint lifecycle script: exercises the full happy path,
# both fail-loops, the two-gate refusal, and the standard edge cases (bad
# verdict, skipping a phase, closing early, empty title). Exits non-zero on
# the first unexpected result. Safe to run repeatedly, cleans up after
# itself.
set -euo pipefail

cd "$(dirname "$0")/.."
SCRIPT="python3 scripts/sprint_lifecycle.py"

cleanup() {
  rm -rf docs/sprints/1-todo/* docs/sprints/2-in-progress/* docs/sprints/3-done/* \
         docs/sprints/4-blocked/* docs/sprints/5-abandoned/* docs/sprints/state/* \
         docs/sprints/registry.json
  for d in 0-backlog 1-todo 2-in-progress 3-done 4-blocked 5-abandoned state; do
    touch "docs/sprints/$d/.gitkeep"
  done
}
trap cleanup EXIT
cleanup

fail() { echo "SMOKE TEST FAILED: $1" >&2; exit 1; }

echo "== happy path with both fail-loops =="
$SCRIPT new "Smoke test sprint" --epic "CI" > /dev/null
$SCRIPT start 1 > /dev/null
$SCRIPT qa1 1 --verdict FAIL --notes "expected fail" > /dev/null
$SCRIPT qa1 1 --verdict PASS --notes "ok" > /dev/null
$SCRIPT dev-done 1 > /dev/null
$SCRIPT ship 1 --commit smoke1 > /dev/null
$SCRIPT groundtruth 1 --verdict FAIL --notes "expected fail" > /dev/null
$SCRIPT reship 1 --commit smoke2 > /dev/null
$SCRIPT groundtruth 1 --verdict PASS --notes "ok" > /dev/null
$SCRIPT qa1-final 1 --verdict PASS --notes "ok" > /dev/null
$SCRIPT complete 1 > /dev/null
STATUS=$($SCRIPT status 1)
echo "$STATUS" | grep -q "Phase: complete" || fail "sprint 1 did not reach complete"
echo "$STATUS" | grep -q "QA1 audit result: PASS" || fail "qa1 result not recorded"
echo "$STATUS" | grep -q "GroundTruth live result: PASS" || fail "groundtruth result not recorded"

echo "== refusal paths =="
$SCRIPT new "Edge case sprint" > /dev/null
$SCRIPT start 2 > /dev/null

$SCRIPT qa1 2 --verdict MAYBE > /tmp/out.txt 2>&1 && fail "bad verdict was accepted" || true
grep -q "Verdict must be one of" /tmp/out.txt || fail "bad verdict error message missing"

$SCRIPT ship 2 --commit x > /tmp/out.txt 2>&1 && fail "shipped before qa1/dev-done" || true
grep -q "Pipeman can't ship yet" /tmp/out.txt || fail "ship-too-early error message missing"

$SCRIPT complete 2 > /tmp/out.txt 2>&1 && fail "closed before any gate passed" || true
grep -q "not ready to close" /tmp/out.txt || fail "early-complete error message missing"

echo "" > /tmp/blank.txt
$SCRIPT new --title-file /tmp/blank.txt > /tmp/out.txt 2>&1 && fail "empty title was accepted" || true
grep -q "title cannot be empty" /tmp/out.txt || fail "empty-title error message missing"

$SCRIPT status 999 > /tmp/out.txt 2>&1 && fail "nonexistent sprint returned success" || true
grep -q "No state file for sprint 999" /tmp/out.txt || fail "nonexistent-sprint error message missing"

echo "== injection regression: malicious text via --title-file must be inert =="
rm -f /tmp/PWNED
printf 'Fix login"; touch /tmp/PWNED; echo "done' > /tmp/evil.txt
$SCRIPT new --title-file /tmp/evil.txt > /dev/null
[ -f /tmp/PWNED ] && fail "injection payload executed, --title-file did not neutralize it"
rm -f /tmp/evil.txt /tmp/PWNED /tmp/out.txt

echo "== two independent sprints running concurrently =="
$SCRIPT new "Parallel sprint A" > /dev/null   # sprint 3
$SCRIPT start 3 > /dev/null
$SCRIPT new "Parallel sprint B" > /dev/null   # sprint 4
$SCRIPT start 4 > /dev/null
$SCRIPT qa1 3 --verdict PASS --notes ok > /dev/null
$SCRIPT status 4 | grep -q "Phase: dev_build" || fail "sprint 4 state was affected by sprint 3's transition"

echo "ALL SMOKE TESTS PASSED"
