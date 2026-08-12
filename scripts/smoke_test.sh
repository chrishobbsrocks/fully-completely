#!/usr/bin/env bash
# Smoke test for the sprint lifecycle script: exercises the full happy path,
# both fail-loops, the two-gate refusal, and the standard edge cases (bad
# verdict, skipping a phase, closing early, empty title). Exits non-zero on
# the first unexpected result.
#
# Runs entirely inside a throwaway sandbox directory (mktemp -d), never
# against this repo's own docs/sprints/. Note that just `cd`-ing elsewhere
# before invoking the real script would NOT be enough: sprint_lifecycle.py
# resolves ROOT from Path(__file__).resolve().parent.parent, i.e. from
# where the *script file* lives, not the caller's working directory. So
# this test copies the script (and the sprint template) into the sandbox
# and runs that copy, which makes ROOT resolve inside the sandbox instead.
# This is not a style preference: a version of this file that rm -rf'd
# docs/sprints/ directly against the invoking repo has already destroyed a
# real downstream project's sprint history twice. Do not "simplify" this
# back to operating on whatever repo you happen to be standing in.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/fully-completely-smoke.XXXXXX")"
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT

mkdir -p "$SANDBOX/scripts" "$SANDBOX/templates"
cp "$REPO_ROOT/scripts/sprint_lifecycle.py" "$SANDBOX/scripts/sprint_lifecycle.py"
if [ -f "$REPO_ROOT/templates/sprint-template.md" ]; then
  cp "$REPO_ROOT/templates/sprint-template.md" "$SANDBOX/templates/sprint-template.md"
fi

cd "$SANDBOX"
SCRIPT="python3 scripts/sprint_lifecycle.py"

fail() { echo "SMOKE TEST FAILED: $1" >&2; exit 1; }

# ship's tree-hash check needs a real git repo to resolve commits against,
# entirely local to the sandbox, never the invoking repo.
git init -q
git config user.email "smoke-test@example.com"
git config user.name "Smoke Test"
git add -A
git commit -q -m "sandbox baseline"

echo "== happy path with both fail-loops =="
$SCRIPT new "Smoke test sprint" --epic "CI" > /dev/null
$SCRIPT start 1 > /dev/null
$SCRIPT qa1 1 --verdict FAIL --notes "expected fail" > /dev/null
git commit -q --allow-empty -m "address QA1 feedback for sprint 1"
$SCRIPT qa1 1 --verdict PASS --notes "ok" > /dev/null
$SCRIPT dev-done 1 > /dev/null
AUDITED_COMMIT_1=$(git rev-parse HEAD)
$SCRIPT ship 1 --commit "$AUDITED_COMMIT_1" > /dev/null
$SCRIPT groundtruth 1 --verdict FAIL --notes "expected fail" > /dev/null
$SCRIPT reship 1 --commit smoke2 > /dev/null
$SCRIPT groundtruth 1 --verdict PASS --notes "ok" > /dev/null
$SCRIPT complete 1 > /dev/null
STATUS=$($SCRIPT status 1)
echo "$STATUS" | grep -q "Phase: complete" || fail "sprint 1 did not reach complete"
echo "$STATUS" | grep -q "QA1 audit result: PASS" || fail "qa1 result not recorded"
echo "$STATUS" | grep -q "GroundTruth live result: PASS" || fail "groundtruth result not recorded"

echo "== completion actually relocates the file and updates its frontmatter, not just the phase =="
DONE_FILE=$(find docs/sprints/3-done -name 'sprint-1_*.md' 2>/dev/null)
[ -n "$DONE_FILE" ] || fail "sprint 1's file was not moved to docs/sprints/3-done/"
[ ! -e docs/sprints/2-in-progress/sprint-1_smoke-test-sprint.md ] || fail "sprint 1's file is still in 2-in-progress/"
grep -q '^status: done$' "$DONE_FILE" || fail "sprint 1's file frontmatter status was not updated to done"

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

echo "== dev-done refuses (no override) if the sprint file changed since QA1's PASS =="
$SCRIPT new "Stale audit sprint" > /dev/null   # sprint 5
$SCRIPT start 5 > /dev/null
$SCRIPT qa1 5 --verdict PASS --notes "looked good" > /dev/null
STALE_FILE=$(find docs/sprints/2-in-progress -name 'sprint-5_*.md')
echo "### Requirements amended after audit" >> "$STALE_FILE"

$SCRIPT dev-done 5 > /tmp/out.txt 2>&1 && fail "dev-done succeeded despite sprint file changing after QA1's PASS" || true
grep -q "has changed since QA1's PASS" /tmp/out.txt || fail "stale-audit refusal message missing"
grep -q "\-\-override" /tmp/out.txt && fail "refusal message must not offer an override"

$SCRIPT qa1 5 --verdict PASS --notes "re-audited the amendment" > /dev/null
$SCRIPT dev-done 5 > /dev/null || fail "dev-done still refused after a fresh QA1 PASS on the current file"
rm -f /tmp/out.txt

echo "== ship refuses (no override) if the commit's content differs from what QA1 audited =="
$SCRIPT new "Commit drift sprint" > /dev/null   # sprint 6
$SCRIPT start 6 > /dev/null
git commit -q --allow-empty -m "sprint 6 initial work"
$SCRIPT qa1 6 --verdict PASS --notes "looked good" > /dev/null
$SCRIPT dev-done 6 > /dev/null
# a real content change lands after QA1's PASS, unaudited
echo "sneaky change" > sneaky.txt
git add sneaky.txt
git commit -q -m "unaudited change after QA1 PASS"
DRIFTED_COMMIT=$(git rev-parse HEAD)

$SCRIPT ship 6 --commit "$DRIFTED_COMMIT" > /tmp/out.txt 2>&1 && fail "ship succeeded on a commit QA1 never audited" || true
grep -q "doesn't match what QA1 audited" /tmp/out.txt || fail "commit-drift refusal message missing"
grep -q "\-\-override" /tmp/out.txt && fail "commit-drift refusal message must not offer an override"

echo "== ship tolerates a content-preserving amend/rebase after a fresh QA1 PASS (tree hash, not commit SHA) =="
$SCRIPT qa1 6 --verdict PASS --notes "re-audited the sneaky change" > /dev/null
$SCRIPT dev-done 6 > /dev/null   # a fresh qa1 PASS resets phase, dev-done must be re-run before ship
# simulate Pipeman's documented squash/rebase step: same file content, new SHA
git commit -q --amend -m "sprint 6 work (squashed for history hygiene)"
AMENDED_COMMIT=$(git rev-parse HEAD)
[ "$AMENDED_COMMIT" != "$DRIFTED_COMMIT" ] || fail "test setup broken: amend did not change the commit SHA"
$SCRIPT ship 6 --commit "$AMENDED_COMMIT" > /dev/null || fail "ship refused a content-identical commit just because rebase/amend changed its SHA"
rm -f /tmp/out.txt

echo "== dev-done/ship give a distinct 'nothing recorded' message for a pre-upgrade sprint missing the hash fields =="
$SCRIPT new "Legacy sprint" > /dev/null   # sprint 7
$SCRIPT start 7 > /dev/null
git commit -q --allow-empty -m "sprint 7 work"
$SCRIPT qa1 7 --verdict PASS --notes "looked good" > /dev/null
LEGACY_STATE="docs/sprints/state/sprint-7.json"
# simulate a sprint that PASSed under a version of this script from before
# the hash fields existed, by stripping them out of an otherwise-valid PASS
python3 -c "
import json
p = '$LEGACY_STATE'
s = json.load(open(p))
del s['qa1_audit_file_hash']
del s['qa1_audited_tree_hash']
json.dump(s, open(p, 'w'), indent=2)
"

$SCRIPT dev-done 7 > /tmp/out.txt 2>&1 && fail "dev-done succeeded on a sprint with no recorded audit hash" || true
grep -q "no QA1-audited sprint-file hash on record" /tmp/out.txt || fail "legacy-sprint dev-done message missing"
grep -q "has changed since QA1's PASS" /tmp/out.txt && fail "legacy sprint should not be told the file 'changed', nothing was ever recorded to compare against"

$SCRIPT qa1 7 --verdict PASS --notes "re-audited under the upgraded script" > /dev/null
$SCRIPT dev-done 7 > /dev/null || fail "dev-done still failed after a fresh QA1 PASS backfilled the hash fields"

# repeat the same distinction one step later, for ship's tree-hash field
python3 -c "
import json
p = '$LEGACY_STATE'
s = json.load(open(p))
del s['qa1_audited_tree_hash']
json.dump(s, open(p, 'w'), indent=2)
"
LEGACY_COMMIT=$(git rev-parse HEAD)
$SCRIPT ship 7 --commit "$LEGACY_COMMIT" > /tmp/out.txt 2>&1 && fail "ship succeeded on a sprint with no recorded audited commit" || true
grep -q "no QA1-audited commit on record" /tmp/out.txt || fail "legacy-sprint ship message missing"
grep -q "doesn't match what QA1 audited" /tmp/out.txt && fail "legacy sprint should not be told the commit 'doesn't match', nothing was ever recorded to compare against"
rm -f /tmp/out.txt

echo "== a custom template containing literal braces doesn't break sprint creation =="
printf '\n### Example config\n```json\n{ "key": "value" }\n```\n' >> templates/sprint-template.md
$SCRIPT new "Brace test sprint" > /dev/null || fail "sprint creation broke on a template containing literal { }"

echo "== concurrent writes to the same sprint don't corrupt state or lose an update (file locking) =="
$SCRIPT new "Race sprint" > /dev/null   # sprint 9
$SCRIPT start 9 > /dev/null
( $SCRIPT qa1 9 --verdict FAIL --notes "race A" > /dev/null 2>&1 ) &
RACE_PID1=$!
( $SCRIPT qa1 9 --verdict CONDITIONAL --notes "race B" > /dev/null 2>&1 ) &
RACE_PID2=$!
wait "$RACE_PID1" "$RACE_PID2"
RACE_STATUS=$($SCRIPT status 9 --verbose)
echo "$RACE_STATUS" | grep -q "rounds: 2" || fail "concurrent qa1 writes lost an update, expected audit_rounds: 2"
python3 -c "import json; json.load(open('docs/sprints/state/sprint-9.json'))" || fail "sprint 9 state file is corrupted JSON after concurrent writes"

echo "== override refuses without the exact --confirm value, and without a --reason =="
$SCRIPT new "Override refusal sprint" > /dev/null   # sprint 10
$SCRIPT start 10 > /dev/null
git commit -q --allow-empty -m "sprint 10 work"
$SCRIPT qa1 10 --verdict PASS --notes "looked good" > /dev/null

$SCRIPT override 10 --gate dev-done-hash --reason "test" --confirm YES > /tmp/out.txt 2>&1 && fail "override succeeded with the wrong --confirm value" || true
grep -q "must be exactly the literal word OVERRIDE" /tmp/out.txt || fail "wrong-confirm refusal message missing"

$SCRIPT override 10 --gate dev-done-hash --confirm OVERRIDE > /tmp/out.txt 2>&1 && fail "override succeeded with an empty --reason" || true
grep -q -- "--reason is required" /tmp/out.txt || fail "empty-reason refusal message missing"
rm -f /tmp/out.txt

echo "== override unsticks a stale sprint-file hash, and is permanently logged with the given reason =="
STALE_FILE_10=$(find docs/sprints/2-in-progress -name 'sprint-10_*.md')
echo "### amendment after audit" >> "$STALE_FILE_10"
$SCRIPT dev-done 10 > /tmp/out.txt 2>&1 && fail "dev-done succeeded despite a stale hash (test setup broken)" || true
grep -q "has changed since QA1's PASS" /tmp/out.txt || fail "expected stale-hash refusal did not occur"

$SCRIPT override 10 --gate dev-done-hash --reason "reviewed the amendment personally, cosmetic only" --confirm OVERRIDE > /dev/null || fail "override refused despite a valid --confirm and --reason"
$SCRIPT dev-done 10 > /dev/null || fail "dev-done still refused after a valid override re-stamped the hash"
OVERRIDE_STATUS=$($SCRIPT status 10 --verbose)
echo "$OVERRIDE_STATUS" | grep -q "human-override" || fail "override was not recorded in the sprint's history"
echo "$OVERRIDE_STATUS" | grep -q "reviewed the amendment personally" || fail "override reason was not recorded in the sprint's history"
rm -f /tmp/out.txt

echo "== override on a sprint QA1 never actually passed still refuses (it overrides drift, not a missing PASS) =="
$SCRIPT new "Never audited sprint" > /dev/null   # sprint 11
$SCRIPT start 11 > /dev/null
$SCRIPT override 11 --gate dev-done-hash --reason "trying to skip QA1 entirely" --confirm OVERRIDE > /tmp/out.txt 2>&1 && fail "override let a sprint bypass QA1 entirely" || true
grep -q "no QA1 PASS on record" /tmp/out.txt || fail "no-real-PASS refusal message missing"
rm -f /tmp/out.txt

echo "== override unsticks a commit-content mismatch at ship time =="
$SCRIPT new "Ship override sprint" > /dev/null   # sprint 12
$SCRIPT start 12 > /dev/null
git commit -q --allow-empty -m "sprint 12 initial work"
$SCRIPT qa1 12 --verdict PASS --notes "looked good" > /dev/null
$SCRIPT dev-done 12 > /dev/null
echo "unaudited" > sprint12-sneaky.txt
git add sprint12-sneaky.txt
git commit -q -m "unaudited change after PASS"
SHIP_OVERRIDE_COMMIT=$(git rev-parse HEAD)

$SCRIPT ship 12 --commit "$SHIP_OVERRIDE_COMMIT" > /tmp/out.txt 2>&1 && fail "ship succeeded despite a content mismatch (test setup broken)" || true
grep -q "doesn't match what QA1 audited" /tmp/out.txt || fail "expected ship-time content-mismatch refusal did not occur"

$SCRIPT override 12 --gate ship-hash --reason "reviewed the extra commit personally, safe to ship" --confirm OVERRIDE > /dev/null || fail "ship-hash override refused despite a valid --confirm and --reason"
$SCRIPT ship 12 --commit "$SHIP_OVERRIDE_COMMIT" > /dev/null || fail "ship still refused after a valid ship-hash override"
rm -f /tmp/out.txt

echo "ALL SMOKE TESTS PASSED"
