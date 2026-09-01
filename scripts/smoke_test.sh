#!/usr/bin/env bash
# Smoke test for the sprint lifecycle script: exercises the full happy path,
# both fail-loops, the close refusal (both gates, and the user-authorization
# requirement), and the standard edge cases (bad verdict, skipping a phase,
# closing early, empty title). Exits non-zero on the first unexpected result.
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

# Content hash of every file under docs/sprints/, used to assert a command
# (like `gates`) that claims to be read-only actually didn't write anything.
sprints_hash() {
  find docs/sprints -type f -exec sha256sum {} \; | sort | sha256sum
}

# ship's tree-hash check needs a real git repo to resolve commits against,
# entirely local to the sandbox, never the invoking repo.
git init -q
git config user.email "smoke-test@example.com"
git config user.name "Smoke Test"
git add -A
git commit -q -m "sandbox baseline"

# docs/sprints/ doesn't exist yet at this point in the sandbox, so this also
# covers the "no state directory at all" path, not just "zero completed
# sprints with a state dir present".
echo "== gates: zero completed sprints prints a clean no-data message, not zeroes or a traceback =="
$SCRIPT gates > /tmp/gates_out.txt 2>&1 || fail "gates exited non-zero with no sprint data"
grep -q "Nothing to aggregate" /tmp/gates_out.txt || fail "gates zero-data message missing"
grep -qE "Traceback" /tmp/gates_out.txt && fail "gates raised a traceback on zero completed sprints"
# Sprint 7, Req 6: "there is nothing here" is the exact sentence that
# produced every one of the wrong readings this sprint exists to fix —
# this is the only point in this script where zero sprints exist at all,
# so it's the only place cmd_status/cmd_list/cmd_gates's "no data yet"
# branches (as opposed to load_state's "no state file for sprint N",
# checked separately below once sprints exist) can be exercised.
grep -qF "fully-completely-smoke" /tmp/gates_out.txt || fail "gates' no-data message doesn't name the tree it looked in"
grep -q "branch:" /tmp/gates_out.txt || fail "gates' no-data message doesn't name the branch"
rm -f /tmp/gates_out.txt

echo "== status/list: zero sprints also names the tree (sprint 7, Req 6) =="
$SCRIPT status > /tmp/out.txt 2>&1 || fail "status with no id and no sprints exited non-zero"
grep -q "No sprints yet in" /tmp/out.txt || fail "status's no-sprints message doesn't name the tree"
grep -qF "fully-completely-smoke" /tmp/out.txt || fail "status's no-sprints message doesn't actually name this sandbox"

$SCRIPT list > /tmp/out.txt 2>&1 || fail "list with no sprints exited non-zero"
grep -q "No sprints yet in" /tmp/out.txt || fail "list's no-sprints message doesn't name the tree"
grep -qF "fully-completely-smoke" /tmp/out.txt || fail "list's no-sprints message doesn't actually name this sandbox"
rm -f /tmp/out.txt

echo "== tree-naming degrades gracefully when git itself is unavailable, never crashing a read-only command (Req 7) =="
PY3_DIR="$(dirname "$(command -v python3)")"
NOGIT_PATH_OUT=$(PATH="$PY3_DIR" $SCRIPT status 2>&1) || fail "status crashed when git was unavailable on PATH"
echo "$NOGIT_PATH_OUT" | grep -qE "Traceback" && fail "status raised a traceback when git was unavailable on PATH"
echo "$NOGIT_PATH_OUT" | grep -q "branch unknown" || fail "status should degrade to 'branch unknown' when git can't be found, not omit the tree entirely or crash"

# Captures the numeric sprint id `new` just created from its own stdout,
# rather than assuming IDs increment one-per-test. Some tests below create a
# sprint without ever `start`-ing it (the injection regression test), which
# shifts every later hand-counted ID by one; that drift previously caused a
# later test block to accidentally re-`start` (and wipe the history of) an
# unrelated sprint from an earlier block. Reading the real ID back out
# instead of counting by hand makes that class of bug impossible.
new_sprint() {
  local out id
  out=$($SCRIPT new "$@")
  id=$(echo "$out" | grep -oE 'Created sprint [0-9]+' | grep -oE '[0-9]+')
  [ -n "$id" ] || fail "could not parse a sprint id out of 'new' output: $out"
  echo "$id"
}

echo "== happy path with both fail-loops =="
SPRINT_1=$(new_sprint "Smoke test sprint" --epic "CI")
$SCRIPT start "$SPRINT_1" > /dev/null
$SCRIPT qa1 "$SPRINT_1" --verdict FAIL --notes "expected fail" > /dev/null
git commit -q --allow-empty -m "address QA1 feedback for sprint $SPRINT_1"
$SCRIPT qa1 "$SPRINT_1" --verdict PASS --notes "ok" > /dev/null
$SCRIPT dev-done "$SPRINT_1" > /dev/null
AUDITED_COMMIT_1=$(git rev-parse HEAD)
$SCRIPT ship "$SPRINT_1" --commit "$AUDITED_COMMIT_1" > /dev/null
$SCRIPT liveqa "$SPRINT_1" --deployed-commit "$AUDITED_COMMIT_1" --verdict FAIL --notes "expected fail" > /dev/null
git commit -q --allow-empty -m "fix for sprint $SPRINT_1"
FIX_COMMIT_1=$(git rev-parse HEAD)
$SCRIPT reship "$SPRINT_1" --commit "$FIX_COMMIT_1" > /dev/null
$SCRIPT liveqa "$SPRINT_1" --deployed-commit "$FIX_COMMIT_1" --verdict PASS --notes "ok" > /dev/null

echo "== complete refuses (no override) without a non-empty --user-said, even with both gates PASS =="
$SCRIPT complete "$SPRINT_1" > /tmp/out.txt 2>&1 && fail "complete succeeded with no --user-said at all, despite both gates passing" || true
grep -q -- "--user-said is required" /tmp/out.txt || fail "missing --user-said refusal message missing"

$SCRIPT complete "$SPRINT_1" --user-said "   " > /tmp/out.txt 2>&1 && fail "complete succeeded with a whitespace-only --user-said" || true
grep -q -- "--user-said is required" /tmp/out.txt || fail "whitespace-only --user-said refusal message missing"
rm -f /tmp/out.txt

$SCRIPT complete "$SPRINT_1" --user-said "close sprint 1, both gates look good" > /dev/null
STATUS=$($SCRIPT status "$SPRINT_1")
echo "$STATUS" | grep -q "Phase: complete" || fail "sprint $SPRINT_1 did not reach complete"
echo "$STATUS" | grep -q "QA1 audit result: PASS" || fail "qa1 result not recorded"
echo "$STATUS" | grep -q "LiveQA live result: PASS" || fail "liveqa result not recorded"
$SCRIPT status "$SPRINT_1" --verbose | grep -q "close sprint 1, both gates look good" || fail "the --user-said text was not recorded in the sprint's history"

echo "== completion actually relocates the file and updates its frontmatter, not just the phase =="
DONE_FILE=$(find docs/sprints/3-done -name "sprint-${SPRINT_1}_*.md" 2>/dev/null)
[ -n "$DONE_FILE" ] || fail "sprint $SPRINT_1's file was not moved to docs/sprints/3-done/"
[ ! -e "docs/sprints/2-in-progress/sprint-${SPRINT_1}_smoke-test-sprint.md" ] || fail "sprint $SPRINT_1's file is still in 2-in-progress/"
grep -q '^status: done$' "$DONE_FILE" || fail "sprint $SPRINT_1's file frontmatter status was not updated to done"

echo "== gates: one completed sprint (with a GT fail after a normal ship) is an audited miss, not a rate =="
GATES_HASH_BEFORE=$(sprints_hash)
GATES_OUT=$($SCRIPT gates)
GATES_HASH_AFTER=$(sprints_hash)
[ "$GATES_HASH_BEFORE" = "$GATES_HASH_AFTER" ] || fail "gates modified docs/sprints/ (should be strictly read-only)"
echo "$GATES_OUT" | grep -q "single data point, not a rate" || fail "gates didn't flag a single completed sprint as non-statistical"
echo "$GATES_OUT" | grep -q "Audited miss.*: 1 — sprints: ${SPRINT_1}$" || fail "gates didn't count sprint $SPRINT_1's GT fail (after a normal ship) as an audited miss"
echo "$GATES_OUT" | grep -q "Unaudited-fix miss.*: 0 " || fail "gates should show zero unaudited-fix misses so far"
echo "$GATES_OUT" | grep -q "LiveQA: 1 of 1 — sprints: \[${SPRINT_1}\]" || fail "gates didn't record sprint $SPRINT_1 under LiveQA's non-PASS catch"
echo "$GATES_OUT" | grep -q "QA1: 1 of 1 — sprints: \[${SPRINT_1}\]" || fail "gates should count sprint $SPRINT_1 under QA1's non-PASS catch (it had an initial FAIL round)"

echo "== refusal paths =="
SPRINT_2=$(new_sprint "Edge case sprint")
$SCRIPT start "$SPRINT_2" > /dev/null

$SCRIPT qa1 "$SPRINT_2" --verdict MAYBE > /tmp/out.txt 2>&1 && fail "bad verdict was accepted" || true
grep -q "Verdict must be one of" /tmp/out.txt || fail "bad verdict error message missing"

$SCRIPT ship "$SPRINT_2" --commit x > /tmp/out.txt 2>&1 && fail "shipped before qa1/dev-done" || true
grep -q "Pipeman can't ship yet" /tmp/out.txt || fail "ship-too-early error message missing"

$SCRIPT complete "$SPRINT_2" --user-said "trying to close it early" > /tmp/out.txt 2>&1 && fail "closed before any gate passed" || true
grep -q "not ready to close" /tmp/out.txt || fail "early-complete error message missing"

echo "" > /tmp/blank.txt
$SCRIPT new --title-file /tmp/blank.txt > /tmp/out.txt 2>&1 && fail "empty title was accepted" || true
grep -q "title cannot be empty" /tmp/out.txt || fail "empty-title error message missing"

$SCRIPT status 999 > /tmp/out.txt 2>&1 && fail "nonexistent sprint returned success" || true
grep -q "No state file for sprint 999" /tmp/out.txt || fail "nonexistent-sprint error message missing"
# Sprint 7, Req 6: load_state's absence message must name which tree it
# looked in — this is the exact sentence a wrong-checkout status read
# produced four confidently-wrong answers against before this sprint.
grep -qF "fully-completely-smoke" /tmp/out.txt || fail "load_state's absence message doesn't name the tree it looked in"
grep -q "branch:" /tmp/out.txt || fail "load_state's absence message doesn't name the branch"

echo "== injection regression: malicious text via --title-file must be inert =="
rm -f /tmp/PWNED
printf 'Fix login"; touch /tmp/PWNED; echo "done' > /tmp/evil.txt
$SCRIPT new --title-file /tmp/evil.txt > /dev/null
[ -f /tmp/PWNED ] && fail "injection payload executed, --title-file did not neutralize it"
rm -f /tmp/evil.txt /tmp/PWNED /tmp/out.txt

echo "== two independent sprints running concurrently =="
SPRINT_A=$(new_sprint "Parallel sprint A")
$SCRIPT start "$SPRINT_A" > /dev/null
SPRINT_B=$(new_sprint "Parallel sprint B")
$SCRIPT start "$SPRINT_B" > /dev/null
$SCRIPT qa1 "$SPRINT_A" --verdict PASS --notes ok > /dev/null
$SCRIPT status "$SPRINT_B" | grep -q "Phase: dev_build" || fail "sprint $SPRINT_B state was affected by sprint $SPRINT_A's transition"

echo "== dev-done refuses (no override) if the sprint file changed since QA1's PASS =="
SPRINT_STALE=$(new_sprint "Stale audit sprint")
$SCRIPT start "$SPRINT_STALE" > /dev/null
$SCRIPT qa1 "$SPRINT_STALE" --verdict PASS --notes "looked good" > /dev/null
STALE_FILE=$(find docs/sprints/2-in-progress -name "sprint-${SPRINT_STALE}_*.md")
echo "### Requirements amended after audit" >> "$STALE_FILE"

$SCRIPT dev-done "$SPRINT_STALE" > /tmp/out.txt 2>&1 && fail "dev-done succeeded despite sprint file changing after QA1's PASS" || true
grep -q "has changed since QA1's PASS" /tmp/out.txt || fail "stale-audit refusal message missing"
grep -q "\-\-override" /tmp/out.txt && fail "refusal message must not offer an override"

$SCRIPT qa1 "$SPRINT_STALE" --verdict PASS --notes "re-audited the amendment" > /dev/null
$SCRIPT dev-done "$SPRINT_STALE" > /dev/null || fail "dev-done still refused after a fresh QA1 PASS on the current file"
rm -f /tmp/out.txt

echo "== ship refuses (no override) if the commit's content differs from what QA1 audited =="
SPRINT_DRIFT=$(new_sprint "Commit drift sprint")
$SCRIPT start "$SPRINT_DRIFT" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_DRIFT initial work"
$SCRIPT qa1 "$SPRINT_DRIFT" --verdict PASS --notes "looked good" > /dev/null
$SCRIPT dev-done "$SPRINT_DRIFT" > /dev/null
# a real content change lands after QA1's PASS, unaudited
echo "sneaky change" > sneaky.txt
git add sneaky.txt
git commit -q -m "unaudited change after QA1 PASS"
DRIFTED_COMMIT=$(git rev-parse HEAD)

$SCRIPT ship "$SPRINT_DRIFT" --commit "$DRIFTED_COMMIT" > /tmp/out.txt 2>&1 && fail "ship succeeded on a commit QA1 never audited" || true
grep -q "doesn't match what QA1 audited" /tmp/out.txt || fail "commit-drift refusal message missing"
grep -q "\-\-override" /tmp/out.txt && fail "commit-drift refusal message must not offer an override"

echo "== ship tolerates a content-preserving amend/rebase after a fresh QA1 PASS (tree hash, not commit SHA) =="
$SCRIPT qa1 "$SPRINT_DRIFT" --verdict PASS --notes "re-audited the sneaky change" > /dev/null
$SCRIPT dev-done "$SPRINT_DRIFT" > /dev/null   # a fresh qa1 PASS resets phase, dev-done must be re-run before ship
# simulate Pipeman's documented squash/rebase step: same file content, new SHA
git commit -q --amend -m "sprint $SPRINT_DRIFT work (squashed for history hygiene)"
AMENDED_COMMIT=$(git rev-parse HEAD)
[ "$AMENDED_COMMIT" != "$DRIFTED_COMMIT" ] || fail "test setup broken: amend did not change the commit SHA"
$SCRIPT ship "$SPRINT_DRIFT" --commit "$AMENDED_COMMIT" > /dev/null || fail "ship refused a content-identical commit just because rebase/amend changed its SHA"
rm -f /tmp/out.txt

echo "== dev-done/ship give a distinct 'nothing recorded' message for a pre-upgrade sprint missing the hash fields =="
SPRINT_LEGACY=$(new_sprint "Legacy sprint")
$SCRIPT start "$SPRINT_LEGACY" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_LEGACY work"
$SCRIPT qa1 "$SPRINT_LEGACY" --verdict PASS --notes "looked good" > /dev/null
LEGACY_STATE="docs/sprints/state/sprint-${SPRINT_LEGACY}.json"
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

$SCRIPT dev-done "$SPRINT_LEGACY" > /tmp/out.txt 2>&1 && fail "dev-done succeeded on a sprint with no recorded audit hash" || true
grep -q "no QA1-audited sprint-file hash on record" /tmp/out.txt || fail "legacy-sprint dev-done message missing"
grep -q "has changed since QA1's PASS" /tmp/out.txt && fail "legacy sprint should not be told the file 'changed', nothing was ever recorded to compare against"

$SCRIPT qa1 "$SPRINT_LEGACY" --verdict PASS --notes "re-audited under the upgraded script" > /dev/null
$SCRIPT dev-done "$SPRINT_LEGACY" > /dev/null || fail "dev-done still failed after a fresh QA1 PASS backfilled the hash fields"

# repeat the same distinction one step later, for ship's tree-hash field
python3 -c "
import json
p = '$LEGACY_STATE'
s = json.load(open(p))
del s['qa1_audited_tree_hash']
json.dump(s, open(p, 'w'), indent=2)
"
LEGACY_COMMIT=$(git rev-parse HEAD)
$SCRIPT ship "$SPRINT_LEGACY" --commit "$LEGACY_COMMIT" > /tmp/out.txt 2>&1 && fail "ship succeeded on a sprint with no recorded audited commit" || true
grep -q "no QA1-audited commit on record" /tmp/out.txt || fail "legacy-sprint ship message missing"
grep -q "doesn't match what QA1 audited" /tmp/out.txt && fail "legacy sprint should not be told the commit 'doesn't match', nothing was ever recorded to compare against"
rm -f /tmp/out.txt

echo "== a custom template containing literal braces doesn't break sprint creation =="
printf '\n### Example config\n```json\n{ "key": "value" }\n```\n' >> templates/sprint-template.md
$SCRIPT new "Brace test sprint" > /dev/null || fail "sprint creation broke on a template containing literal { }"

echo "== concurrent writes to the same sprint don't corrupt state or lose an update (file locking) =="
SPRINT_RACE=$(new_sprint "Race sprint")
$SCRIPT start "$SPRINT_RACE" > /dev/null
( $SCRIPT qa1 "$SPRINT_RACE" --verdict FAIL --notes "race A" > /dev/null 2>&1 ) &
RACE_PID1=$!
( $SCRIPT qa1 "$SPRINT_RACE" --verdict CONDITIONAL --notes "race B" > /dev/null 2>&1 ) &
RACE_PID2=$!
wait "$RACE_PID1" "$RACE_PID2"
RACE_STATUS=$($SCRIPT status "$SPRINT_RACE" --verbose)
echo "$RACE_STATUS" | grep -q "rounds: 2" || fail "concurrent qa1 writes lost an update, expected audit_rounds: 2"
python3 -c "import json; json.load(open('docs/sprints/state/sprint-${SPRINT_RACE}.json'))" || fail "sprint $SPRINT_RACE state file is corrupted JSON after concurrent writes"

echo "== override refuses without the exact --confirm value, and without a --reason =="
SPRINT_OVR_REFUSAL=$(new_sprint "Override refusal sprint")
$SCRIPT start "$SPRINT_OVR_REFUSAL" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_OVR_REFUSAL work"
$SCRIPT qa1 "$SPRINT_OVR_REFUSAL" --verdict PASS --notes "looked good" > /dev/null

$SCRIPT override "$SPRINT_OVR_REFUSAL" --gate dev-done-hash --reason "test" --confirm YES > /tmp/out.txt 2>&1 && fail "override succeeded with the wrong --confirm value" || true
grep -q "must be exactly the literal word OVERRIDE" /tmp/out.txt || fail "wrong-confirm refusal message missing"

$SCRIPT override "$SPRINT_OVR_REFUSAL" --gate dev-done-hash --confirm OVERRIDE > /tmp/out.txt 2>&1 && fail "override succeeded with an empty --reason" || true
grep -q -- "--reason is required" /tmp/out.txt || fail "empty-reason refusal message missing"
rm -f /tmp/out.txt

echo "== override unsticks a stale sprint-file hash, and is permanently logged with the given reason =="
STALE_FILE_OVR=$(find docs/sprints/2-in-progress -name "sprint-${SPRINT_OVR_REFUSAL}_*.md")
echo "### amendment after audit" >> "$STALE_FILE_OVR"
$SCRIPT dev-done "$SPRINT_OVR_REFUSAL" > /tmp/out.txt 2>&1 && fail "dev-done succeeded despite a stale hash (test setup broken)" || true
grep -q "has changed since QA1's PASS" /tmp/out.txt || fail "expected stale-hash refusal did not occur"

$SCRIPT override "$SPRINT_OVR_REFUSAL" --gate dev-done-hash --reason "reviewed the amendment personally, cosmetic only" --confirm OVERRIDE > /dev/null || fail "override refused despite a valid --confirm and --reason"
$SCRIPT dev-done "$SPRINT_OVR_REFUSAL" > /dev/null || fail "dev-done still refused after a valid override re-stamped the hash"
OVERRIDE_STATUS=$($SCRIPT status "$SPRINT_OVR_REFUSAL" --verbose)
echo "$OVERRIDE_STATUS" | grep -q "human-override" || fail "override was not recorded in the sprint's history"
echo "$OVERRIDE_STATUS" | grep -q "reviewed the amendment personally" || fail "override reason was not recorded in the sprint's history"
rm -f /tmp/out.txt

echo "== dev-done-hash override refuses on the right sprint but the wrong phase, with an accurate message (not 'no PASS') =="
$SCRIPT override "$SPRINT_OVR_REFUSAL" --gate dev-done-hash --reason "trying to re-use this gate after dev-done already succeeded" --confirm OVERRIDE > /tmp/out.txt 2>&1 && fail "dev-done-hash override succeeded on a sprint already past qa1_audit phase" || true
grep -q "no QA1 PASS on record" /tmp/out.txt && fail "wrong-phase refusal must not claim there's no PASS on record, this sprint has one"
grep -q "not qa1_audit" /tmp/out.txt || fail "wrong-phase refusal message missing or not phase-specific"
rm -f /tmp/out.txt

echo "== override on a sprint QA1 never actually passed still refuses (it overrides drift, not a missing PASS) =="
SPRINT_NEVER_AUDITED=$(new_sprint "Never audited sprint")
$SCRIPT start "$SPRINT_NEVER_AUDITED" > /dev/null
$SCRIPT override "$SPRINT_NEVER_AUDITED" --gate dev-done-hash --reason "trying to skip QA1 entirely" --confirm OVERRIDE > /tmp/out.txt 2>&1 && fail "override let a sprint bypass QA1 entirely" || true
grep -q "no QA1 PASS on record" /tmp/out.txt || fail "no-real-PASS refusal message missing"
rm -f /tmp/out.txt

echo "== ship-hash override refuses in the wrong phase (the precondition that keeps it from bypassing QA1) =="
SPRINT_SHIP_WRONG_PHASE=$(new_sprint "Ship override wrong phase sprint")
$SCRIPT start "$SPRINT_SHIP_WRONG_PHASE" > /dev/null
$SCRIPT override "$SPRINT_SHIP_WRONG_PHASE" --gate ship-hash --reason "trying to stamp a ship hash before dev work is even agreed done" --confirm OVERRIDE > /tmp/out.txt 2>&1 && fail "ship-hash override succeeded on a sprint not yet dev_agreed_done" || true
grep -q "not ready to ship" /tmp/out.txt || fail "ship-hash wrong-phase refusal message missing"
rm -f /tmp/out.txt

echo "== override unsticks a commit-content mismatch at ship time, and is permanently logged with the given reason =="
SPRINT_SHIP_OVR=$(new_sprint "Ship override sprint")
$SCRIPT start "$SPRINT_SHIP_OVR" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_SHIP_OVR initial work"
$SCRIPT qa1 "$SPRINT_SHIP_OVR" --verdict PASS --notes "looked good" > /dev/null
$SCRIPT dev-done "$SPRINT_SHIP_OVR" > /dev/null
echo "unaudited" > "sprint${SPRINT_SHIP_OVR}-sneaky.txt"
git add "sprint${SPRINT_SHIP_OVR}-sneaky.txt"
git commit -q -m "unaudited change after PASS"
SHIP_OVERRIDE_COMMIT=$(git rev-parse HEAD)

$SCRIPT ship "$SPRINT_SHIP_OVR" --commit "$SHIP_OVERRIDE_COMMIT" > /tmp/out.txt 2>&1 && fail "ship succeeded despite a content mismatch (test setup broken)" || true
grep -q "doesn't match what QA1 audited" /tmp/out.txt || fail "expected ship-time content-mismatch refusal did not occur"

$SCRIPT override "$SPRINT_SHIP_OVR" --gate ship-hash --reason "reviewed the extra commit personally, safe to ship" --confirm OVERRIDE > /dev/null || fail "ship-hash override refused despite a valid --confirm and --reason"
$SCRIPT ship "$SPRINT_SHIP_OVR" --commit "$SHIP_OVERRIDE_COMMIT" > /dev/null || fail "ship still refused after a valid ship-hash override"
SHIP_OVERRIDE_STATUS=$($SCRIPT status "$SPRINT_SHIP_OVR" --verbose)
echo "$SHIP_OVERRIDE_STATUS" | grep -q "human-override" || fail "ship-hash override was not recorded in the sprint's history"
echo "$SHIP_OVERRIDE_STATUS" | grep -q "reviewed the extra commit personally" || fail "ship-hash override reason was not recorded in the sprint's history"
rm -f /tmp/out.txt

echo "== gates: a GT fail after a reship is an unaudited-fix miss, never folded into the audited bucket =="
SPRINT_UNAUDITED=$(new_sprint "Unaudited fix miss sprint")
$SCRIPT start "$SPRINT_UNAUDITED" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_UNAUDITED work"
$SCRIPT qa1 "$SPRINT_UNAUDITED" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_UNAUDITED" > /dev/null
UNAUDITED_COMMIT=$(git rev-parse HEAD)
$SCRIPT ship "$SPRINT_UNAUDITED" --commit "$UNAUDITED_COMMIT" > /dev/null
$SCRIPT liveqa "$SPRINT_UNAUDITED" --deployed-commit "$UNAUDITED_COMMIT" --verdict FAIL --notes "first fail, audited miss" > /dev/null
git commit -q --allow-empty -m "fix1 for sprint $SPRINT_UNAUDITED"
FIX1_COMMIT=$(git rev-parse HEAD)
$SCRIPT reship "$SPRINT_UNAUDITED" --commit "$FIX1_COMMIT" > /dev/null
$SCRIPT liveqa "$SPRINT_UNAUDITED" --deployed-commit "$FIX1_COMMIT" --verdict FAIL --notes "second fail, unaudited miss" > /dev/null
git commit -q --allow-empty -m "fix2 for sprint $SPRINT_UNAUDITED"
FIX2_COMMIT=$(git rev-parse HEAD)
$SCRIPT reship "$SPRINT_UNAUDITED" --commit "$FIX2_COMMIT" > /dev/null
$SCRIPT liveqa "$SPRINT_UNAUDITED" --deployed-commit "$FIX2_COMMIT" --verdict PASS --notes ok > /dev/null
$SCRIPT complete "$SPRINT_UNAUDITED" --user-said "close it, both misses are understood" > /dev/null

echo "== gates: a completed sprint that needed a dev-done-hash override is counted under hash-drift, not miscounted as a gate override =="
SPRINT_GATES_OVR=$(new_sprint "Gates override sprint")
$SCRIPT start "$SPRINT_GATES_OVR" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_GATES_OVR work"
$SCRIPT qa1 "$SPRINT_GATES_OVR" --verdict PASS --notes ok > /dev/null
GATES_OVR_FILE=$(find docs/sprints/2-in-progress -name "sprint-${SPRINT_GATES_OVR}_*.md")
echo "### amended after audit" >> "$GATES_OVR_FILE"
$SCRIPT override "$SPRINT_GATES_OVR" --gate dev-done-hash --reason "reviewed, cosmetic only" --confirm OVERRIDE > /dev/null
$SCRIPT dev-done "$SPRINT_GATES_OVR" > /dev/null
GATES_OVR_COMMIT=$(git rev-parse HEAD)
$SCRIPT ship "$SPRINT_GATES_OVR" --commit "$GATES_OVR_COMMIT" > /dev/null
$SCRIPT liveqa "$SPRINT_GATES_OVR" --deployed-commit "$GATES_OVR_COMMIT" --verdict PASS --notes ok > /dev/null
$SCRIPT complete "$SPRINT_GATES_OVR" --user-said "close it" > /dev/null

echo "== gates: a GT fail after a ship-hash-overridden ship is NOT an audited miss (content that shipped was never QA1's) =="
SPRINT_SHIP_OVR_MISS=$(new_sprint "Ship override miss sprint")
$SCRIPT start "$SPRINT_SHIP_OVR_MISS" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_SHIP_OVR_MISS initial work"
$SCRIPT qa1 "$SPRINT_SHIP_OVR_MISS" --verdict PASS --notes "looked good" > /dev/null
$SCRIPT dev-done "$SPRINT_SHIP_OVR_MISS" > /dev/null
echo "unaudited content" > "sprint${SPRINT_SHIP_OVR_MISS}-drift.txt"
git add "sprint${SPRINT_SHIP_OVR_MISS}-drift.txt"
git commit -q -m "unaudited change after PASS"
DRIFT_COMMIT=$(git rev-parse HEAD)
$SCRIPT ship "$SPRINT_SHIP_OVR_MISS" --commit "$DRIFT_COMMIT" > /tmp/out.txt 2>&1 && fail "ship succeeded on drifted content (test setup broken)" || true
$SCRIPT override "$SPRINT_SHIP_OVR_MISS" --gate ship-hash --reason "reviewed the drift personally, safe to ship" --confirm OVERRIDE > /dev/null
$SCRIPT ship "$SPRINT_SHIP_OVR_MISS" --commit "$DRIFT_COMMIT" > /dev/null
$SCRIPT liveqa "$SPRINT_SHIP_OVR_MISS" --deployed-commit "$DRIFT_COMMIT" --verdict FAIL --notes "GT caught what QA1 never actually saw" > /dev/null
git commit -q --allow-empty -m "fix for sprint $SPRINT_SHIP_OVR_MISS"
SHIP_OVR_MISS_FIX_COMMIT=$(git rev-parse HEAD)
$SCRIPT reship "$SPRINT_SHIP_OVR_MISS" --commit "$SHIP_OVR_MISS_FIX_COMMIT" > /dev/null
$SCRIPT liveqa "$SPRINT_SHIP_OVR_MISS" --deployed-commit "$SHIP_OVR_MISS_FIX_COMMIT" --verdict PASS --notes ok > /dev/null
$SCRIPT complete "$SPRINT_SHIP_OVR_MISS" --user-said "close it" > /dev/null
rm -f /tmp/out.txt

echo "== gates: final aggregate across every completed sprint, still strictly read-only =="
FINAL_HASH_BEFORE=$(sprints_hash)
FINAL_GATES_OUT=$($SCRIPT gates)
FINAL_HASH_AFTER=$(sprints_hash)
[ "$FINAL_HASH_BEFORE" = "$FINAL_HASH_AFTER" ] || fail "gates modified docs/sprints/ on the multi-sprint aggregate (should be strictly read-only)"

echo "$FINAL_GATES_OUT" | grep -q "Gates aggregate over 4 completed sprints" || fail "gates should count exactly 4 completed sprints (sprints in other phases, aborted, or mid-loop must be excluded)"
echo "$FINAL_GATES_OUT" | grep -q "Audited miss.*sprints: ${SPRINT_1}, ${SPRINT_UNAUDITED}\$" || fail "gates' audited-miss bucket should list only sprint $SPRINT_1 and sprint $SPRINT_UNAUDITED's first GT fail — a ship-hash-overridden ship must NOT count as audited"
echo "$FINAL_GATES_OUT" | grep -q "Unaudited-fix miss.*sprints: ${SPRINT_UNAUDITED}\$" || fail "gates' unaudited-fix-miss bucket should list only sprint $SPRINT_UNAUDITED, never sprint $SPRINT_1 or sprint $SPRINT_SHIP_OVR_MISS"
echo "$FINAL_GATES_OUT" | grep -q "UNCLASSIFIED" || fail "gates should flag the ship-hash-overridden sprint's GT fail as unclassified, not silently fold it into audited miss"
echo "$FINAL_GATES_OUT" | grep -q "sprint ${SPRINT_SHIP_OVR_MISS}: .*ship-hash.*was human-overridden" || fail "gates' unclassified note for sprint $SPRINT_SHIP_OVR_MISS should explain why (ship-hash override), not just flag it"
echo "$FINAL_GATES_OUT" | grep -q "dev-done-hash overrides: 1 — sprints: ${SPRINT_GATES_OVR}" || fail "gates should count sprint $SPRINT_GATES_OVR's dev-done-hash override under hash-drift frequency"
echo "$FINAL_GATES_OUT" | grep -q "ship-hash overrides: 1 — sprints: ${SPRINT_SHIP_OVR_MISS}" || fail "gates should count sprint $SPRINT_SHIP_OVR_MISS's ship-hash override under hash-drift frequency"
echo "$FINAL_GATES_OUT" | grep -qE "sprint ${SPRINT_GATES_OVR}: audit_rounds=1, live_test_rounds=1" || fail "gates' round-count distribution for sprint $SPRINT_GATES_OVR is wrong"

echo "== gates: an unparseable verdict format is flagged and excluded, never silently counted as a catch =="
SPRINT_CORRUPT_VERDICT=$(new_sprint "Corrupt verdict sprint")
$SCRIPT start "$SPRINT_CORRUPT_VERDICT" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_CORRUPT_VERDICT work"
$SCRIPT qa1 "$SPRINT_CORRUPT_VERDICT" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_CORRUPT_VERDICT" > /dev/null
CORRUPT_COMMIT=$(git rev-parse HEAD)
$SCRIPT ship "$SPRINT_CORRUPT_VERDICT" --commit "$CORRUPT_COMMIT" > /dev/null
$SCRIPT liveqa "$SPRINT_CORRUPT_VERDICT" --deployed-commit "$CORRUPT_COMMIT" --verdict PASS --notes ok > /dev/null
$SCRIPT complete "$SPRINT_CORRUPT_VERDICT" --user-said "close it" > /dev/null

# Simulate hand-corrupted state (or a future format change) rather than
# anything sprint_lifecycle.py itself would ever write.
CORRUPT_STATE="docs/sprints/state/sprint-${SPRINT_CORRUPT_VERDICT}.json"
python3 -c "
import json
p = '$CORRUPT_STATE'
s = json.load(open(p))
for h in s['history']:
    if h['event'] == 'audit':
        h['detail'] = 'garbled text with no leading verdict token'
json.dump(s, open(p, 'w'), indent=2)
"

CORRUPT_GATES_OUT=$($SCRIPT gates 2>&1)
echo "$CORRUPT_GATES_OUT" | grep -q "Traceback" && fail "gates crashed on an unparseable verdict format"
echo "$CORRUPT_GATES_OUT" | grep -q "WARNING: sprint ${SPRINT_CORRUPT_VERDICT} has a 'audit' event with an unrecognized verdict format" \
  || fail "gates should warn about the unparseable verdict instead of silently guessing"
echo "$CORRUPT_GATES_OUT" | grep "^   QA1:" > /tmp/qa1_catch_line.txt
FOUND=$(python3 -c "
import re
line = open('/tmp/qa1_catch_line.txt').read()
print('MATCH' if re.search(r'\b${SPRINT_CORRUPT_VERDICT}\b', line) else 'NOMATCH')
")
[ "$FOUND" = "NOMATCH" ] || fail "gates should not count sprint ${SPRINT_CORRUPT_VERDICT} under QA1's catch rate from an unparseable verdict alone"
rm -f /tmp/qa1_catch_line.txt

echo "== liveqa refuses a --deployed-commit that doesn't match what Pipeman actually shipped =="
SPRINT_GT_CHECK=$(new_sprint "Deployed commit check sprint")
$SCRIPT start "$SPRINT_GT_CHECK" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_GT_CHECK work"
$SCRIPT qa1 "$SPRINT_GT_CHECK" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_GT_CHECK" > /dev/null
GT_SHIPPED_COMMIT=$(git rev-parse HEAD)
$SCRIPT ship "$SPRINT_GT_CHECK" --commit "$GT_SHIPPED_COMMIT" > /dev/null

git commit -q --allow-empty -m "an unrelated later commit, never shipped for this sprint"
UNSHIPPED_COMMIT=$(git rev-parse HEAD)
$SCRIPT liveqa "$SPRINT_GT_CHECK" --deployed-commit "$UNSHIPPED_COMMIT" --verdict PASS --notes "tested the wrong thing" \
  > /tmp/out.txt 2>&1 && fail "liveqa accepted a --deployed-commit that was never shipped for this sprint" || true
grep -q "doesn't match what Pipeman actually shipped" /tmp/out.txt || fail "deployed-commit mismatch refusal message missing"
grep -q "$GT_SHIPPED_COMMIT" /tmp/out.txt || fail "mismatch refusal should name the commit that was actually shipped"
grep -q "$UNSHIPPED_COMMIT" /tmp/out.txt || fail "mismatch refusal should name the commit that was actually tested"
rm -f /tmp/out.txt

echo "== liveqa refuses a --deployed-commit that doesn't resolve to a real commit =="
$SCRIPT liveqa "$SPRINT_GT_CHECK" --deployed-commit not-a-real-commit --verdict PASS --notes ok \
  > /tmp/out.txt 2>&1 && fail "liveqa accepted a --deployed-commit that doesn't resolve" || true
grep -q "does not resolve to a real commit" /tmp/out.txt || fail "unresolvable deployed-commit refusal message missing"
rm -f /tmp/out.txt

echo "== liveqa succeeds once --deployed-commit actually matches what was shipped =="
$SCRIPT liveqa "$SPRINT_GT_CHECK" --deployed-commit "$GT_SHIPPED_COMMIT" --verdict FAIL --notes "real bug found" > /dev/null || \
  fail "liveqa refused a --deployed-commit that genuinely matched the shipped commit"

echo "== status: no stale-test line right after a fresh verdict against the current ship =="
$SCRIPT status "$SPRINT_GT_CHECK" 2>/dev/null | grep -q "not yet re-tested" && \
  fail "status showed the stale-test line when the recorded verdict is current"

echo "== status: stale-test line appears once a reship lands after the last recorded verdict =="
git commit -q --allow-empty -m "fix for sprint $SPRINT_GT_CHECK"
GT_FIX_COMMIT=$(git rev-parse HEAD)
$SCRIPT reship "$SPRINT_GT_CHECK" --commit "$GT_FIX_COMMIT" > /dev/null
$SCRIPT status "$SPRINT_GT_CHECK" 2>/dev/null | grep -q "Code has changed since the last recorded LiveQA verdict — not yet re-tested." || \
  fail "status did not show the stale-test line after a reship with no fresh verdict yet"

echo "== status: stale-test line clears once a fresh verdict is recorded against the reshipped commit =="
$SCRIPT liveqa "$SPRINT_GT_CHECK" --deployed-commit "$GT_FIX_COMMIT" --verdict PASS --notes ok > /dev/null
$SCRIPT status "$SPRINT_GT_CHECK" 2>/dev/null | grep -q "not yet re-tested" && \
  fail "status still showed the stale-test line after a fresh verdict against the current ship"

echo "== liveqa refuses distinctly when no ship has ever been recorded for this sprint =="
SPRINT_GT_NOSHIP=$(new_sprint "No ship recorded sprint")
$SCRIPT start "$SPRINT_GT_NOSHIP" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_GT_NOSHIP work"
$SCRIPT qa1 "$SPRINT_GT_NOSHIP" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_GT_NOSHIP" > /dev/null
NOSHIP_COMMIT=$(git rev-parse HEAD)
$SCRIPT ship "$SPRINT_GT_NOSHIP" --commit "$NOSHIP_COMMIT" > /dev/null
# Simulate a pre-upgrade sprint (or a hand-edited state file) with no
# last_shipped_commit on record, same technique as the existing
# SPRINT_LEGACY scenario above for the other hash fields.
NOSHIP_STATE="docs/sprints/state/sprint-${SPRINT_GT_NOSHIP}.json"
python3 -c "
import json
p = '$NOSHIP_STATE'
s = json.load(open(p))
s['last_shipped_commit'] = None
json.dump(s, open(p, 'w'), indent=2)
"
$SCRIPT liveqa "$SPRINT_GT_NOSHIP" --deployed-commit "$NOSHIP_COMMIT" --verdict PASS --notes ok \
  > /tmp/out.txt 2>&1 && fail "liveqa succeeded with no last_shipped_commit on record" || true
grep -q "has no shipped commit on record" /tmp/out.txt || fail "no-ship-recorded refusal message missing"
grep -q "doesn't match what Pipeman actually shipped" /tmp/out.txt && \
  fail "no-ship-recorded refusal must be a distinct message from the mismatch refusal, not reuse it"
rm -f /tmp/out.txt

echo "== backward compat: the deprecated 'groundtruth' subcommand and the legacy 'groundtruth_live' phase string still work, one transition period after the LiveQA rename =="
SPRINT_LEGACY_NAME=$(new_sprint "Legacy GroundTruth name sprint")
$SCRIPT start "$SPRINT_LEGACY_NAME" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_LEGACY_NAME work"
$SCRIPT qa1 "$SPRINT_LEGACY_NAME" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_LEGACY_NAME" > /dev/null
LEGACY_NAME_COMMIT=$(git rev-parse HEAD)
$SCRIPT ship "$SPRINT_LEGACY_NAME" --commit "$LEGACY_NAME_COMMIT" > /dev/null

# Simulate an in-flight sprint that reached this phase before the rename,
# under the old phase string, rather than anything this version of the
# script would write going forward (cmd_ship always writes LIVEQA_PHASE now).
LEGACY_NAME_STATE="docs/sprints/state/sprint-${SPRINT_LEGACY_NAME}.json"
python3 -c "
import json
p = '$LEGACY_NAME_STATE'
s = json.load(open(p))
s['phase'] = 'groundtruth_live'
json.dump(s, open(p, 'w'), indent=2)
"
$SCRIPT status "$SPRINT_LEGACY_NAME" 2>/dev/null | grep -q "Phase: groundtruth_live" || \
  fail "test setup broken: legacy phase string wasn't actually written"

$SCRIPT groundtruth "$SPRINT_LEGACY_NAME" --deployed-commit "$LEGACY_NAME_COMMIT" --verdict PASS --notes ok \
  > /tmp/out.txt 2>&1 || fail "the deprecated 'groundtruth' subcommand no longer works against a sprint on the legacy 'groundtruth_live' phase"
grep -q "deprecated alias for 'liveqa'" /tmp/out.txt || fail "the deprecated 'groundtruth' subcommand should note it's a deprecated alias"
grep -q "LiveQA live test PASSED" /tmp/out.txt || fail "the deprecated 'groundtruth' subcommand didn't actually record the verdict"
$SCRIPT status "$SPRINT_LEGACY_NAME" 2>/dev/null | grep -q "Phase: complete_ready" || \
  fail "sprint stuck on the legacy phase string never reached complete_ready via the deprecated subcommand"
rm -f /tmp/out.txt

echo "== backward compat: the NEW 'liveqa' subcommand also works against a sprint still on the legacy 'groundtruth_live' phase =="
SPRINT_NEW_NAME_OLD_PHASE=$(new_sprint "New name legacy phase sprint")
$SCRIPT start "$SPRINT_NEW_NAME_OLD_PHASE" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_NEW_NAME_OLD_PHASE work"
$SCRIPT qa1 "$SPRINT_NEW_NAME_OLD_PHASE" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_NEW_NAME_OLD_PHASE" > /dev/null
NEW_NAME_OLD_PHASE_COMMIT=$(git rev-parse HEAD)
$SCRIPT ship "$SPRINT_NEW_NAME_OLD_PHASE" --commit "$NEW_NAME_OLD_PHASE_COMMIT" > /dev/null

# Same legacy-phase simulation as the scenario above, but this time paired
# with the NEW subcommand name, closing the other meaningful cell of the
# {old,new name} x {old,new phase} matrix (the two mechanisms are
# independent by construction, but that's a design claim until it's
# actually exercised).
NEW_NAME_OLD_PHASE_STATE="docs/sprints/state/sprint-${SPRINT_NEW_NAME_OLD_PHASE}.json"
python3 -c "
import json
p = '$NEW_NAME_OLD_PHASE_STATE'
s = json.load(open(p))
s['phase'] = 'groundtruth_live'
json.dump(s, open(p, 'w'), indent=2)
"
$SCRIPT status "$SPRINT_NEW_NAME_OLD_PHASE" 2>/dev/null | grep -q "Phase: groundtruth_live" || \
  fail "test setup broken: legacy phase string wasn't actually written"

$SCRIPT liveqa "$SPRINT_NEW_NAME_OLD_PHASE" --deployed-commit "$NEW_NAME_OLD_PHASE_COMMIT" --verdict PASS --notes ok \
  > /tmp/out.txt 2>&1 || fail "the new 'liveqa' subcommand doesn't recognize a sprint still on the legacy 'groundtruth_live' phase"
grep -q "deprecated alias" /tmp/out.txt && fail "the canonical 'liveqa' subcommand should never print the deprecation note"
grep -q "LiveQA live test PASSED" /tmp/out.txt || fail "the new 'liveqa' subcommand didn't actually record the verdict"
$SCRIPT status "$SPRINT_NEW_NAME_OLD_PHASE" 2>/dev/null | grep -q "Phase: complete_ready" || \
  fail "sprint stuck on the legacy phase string never reached complete_ready via the new subcommand"
rm -f /tmp/out.txt

# ---------------------------------------------------------------------------
# Sprint 7: the live-loop audit (Req 1/2/3/9) and the git-repository-cause
# distinction (Req 12). All added at the end of the file, deliberately —
# every earlier "gates" check above counts completed sprints by a hardcoded
# number, and every sprint this section completes happens after the last
# of those checks, so it can't perturb them.
# ---------------------------------------------------------------------------
echo "== live-loop audit: records without touching any gate-read field, verified by a full state diff (Req 1) =="
SPRINT_LL=$(new_sprint "Live loop audit sprint")
$SCRIPT start "$SPRINT_LL" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_LL work"
$SCRIPT qa1 "$SPRINT_LL" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_LL" > /dev/null
LL_COMMIT=$(git rev-parse HEAD)
$SCRIPT ship "$SPRINT_LL" --commit "$LL_COMMIT" > /dev/null
$SCRIPT liveqa "$SPRINT_LL" --deployed-commit "$LL_COMMIT" --verdict FAIL --notes "needs a live-loop audit" > /dev/null

# Now genuinely sitting at liveqa_live with a gate-1 PASS and both hashes
# populated — QA1's own verification method for Req 1: seed exactly this
# shape, diff the WHOLE state file before and after, don't just read the
# code (reading the diff is explicitly not sufficient per the sprint file).
LL_STATE="docs/sprints/state/sprint-${SPRINT_LL}.json"
cp "$LL_STATE" /tmp/ll_before.json

LL_OUT=$($SCRIPT qa1 "$SPRINT_LL" --verdict PASS --notes "live-loop audit" --commit "$LL_COMMIT" 2>&1)
echo "$LL_OUT" | grep -q "RECORD, not a" || fail "live-loop audit output should say plainly that this is a record, not a gate verdict"
echo "$LL_OUT" | grep -q "does not change the sprint's phase" || fail "live-loop audit output should say plainly it doesn't move the sprint"

python3 -c "
import json
before = json.load(open('/tmp/ll_before.json'))
after = json.load(open('$LL_STATE'))
protected = ['phase', 'qa1_audit_result', 'audit_rounds', 'qa1_audit_file_hash', 'qa1_audited_tree_hash']
for field in protected:
    if before[field] != after[field]:
        raise SystemExit(f'protected field {field} changed: {before[field]!r} -> {after[field]!r}')
before_no_history = {k: v for k, v in before.items() if k != 'history'}
after_no_history = {k: v for k, v in after.items() if k != 'history'}
if before_no_history != after_no_history:
    raise SystemExit(f'a field outside the five named ones changed too: before={before_no_history} after={after_no_history}')
if len(after['history']) != len(before['history']) + 1:
    raise SystemExit(f'expected exactly one new history event, before={len(before[\"history\"])} after={len(after[\"history\"])}')
new_event = after['history'][-1]
if new_event['event'] == 'audit':
    raise SystemExit('live-loop audit must use a name distinct from gate 1\'s \"audit\", or cmd_gates would count it')
if '$LL_COMMIT' not in new_event['detail']:
    raise SystemExit('the resolved --commit should appear in the live-loop audit event detail')
" || fail "live-loop audit state diff check failed — see message above"
rm -f /tmp/ll_before.json

echo "== live-loop audit: all three verdicts record; none of them change phase or move the sprint (Req 3) =="
for V in PASS CONDITIONAL FAIL; do
  BEFORE_PHASE=$(python3 -c "import json; print(json.load(open('$LL_STATE'))['phase'])")
  $SCRIPT qa1 "$SPRINT_LL" --verdict "$V" --notes "live-loop $V" > /tmp/out.txt 2>&1 || fail "live-loop qa1 with verdict $V should succeed"
  AFTER_PHASE=$(python3 -c "import json; print(json.load(open('$LL_STATE'))['phase'])")
  [ "$BEFORE_PHASE" = "$AFTER_PHASE" ] || fail "live-loop $V verdict changed phase from $BEFORE_PHASE to $AFTER_PHASE"
  [ "$AFTER_PHASE" = "liveqa_live" ] || fail "sprint $SPRINT_LL should still be in liveqa_live after a live-loop $V"
done
rm -f /tmp/out.txt

echo "== live-loop audit: an unresolvable --commit is refused, and nothing is written on refusal (Req 2) =="
cp "$LL_STATE" /tmp/ll_before2.json
$SCRIPT qa1 "$SPRINT_LL" --verdict PASS --notes "bad commit" --commit not-a-real-commit > /tmp/out.txt 2>&1 && fail "live-loop audit accepted an unresolvable --commit" || true
grep -q "does not resolve to a real commit" /tmp/out.txt || fail "live-loop audit's bad-commit refusal message missing"
diff -q /tmp/ll_before2.json "$LL_STATE" > /dev/null || fail "a refused live-loop --commit must not write anything to the state file"
rm -f /tmp/out.txt /tmp/ll_before2.json

echo "== live-loop audit: omitting --commit keeps working exactly as before (Req 2, additive-only argument) =="
$SCRIPT qa1 "$SPRINT_LL" --verdict PASS --notes "no commit given" > /tmp/out.txt 2>&1 || fail "live-loop audit without --commit should still succeed"
grep -q "RECORD, not a" /tmp/out.txt || fail "live-loop audit without --commit should still print the record-not-a-gate message"
rm -f /tmp/out.txt

echo "== qa1: a sprint in a phase neither set applies to still refuses, naming both valid phase sets (Req 4) =="
$SCRIPT qa1 "$SPRINT_1" --verdict PASS --notes "trying to audit an already-closed sprint" > /tmp/out.txt 2>&1 && \
  fail "qa1 succeeded against sprint $SPRINT_1, already in complete phase" || true
grep -q "dev_build" /tmp/out.txt || fail "qa1's refusal for an inapplicable phase should still name the gate-1 phase set"
grep -qi "live" /tmp/out.txt || fail "qa1's refusal for an inapplicable phase should also mention the live-loop phase set, now that two paths exist"
rm -f /tmp/out.txt

echo "== gates: a live-loop audit is never counted as a gate catch, even on a completed sprint (Req 9) =="
GATES_BEFORE_LL=$($SCRIPT gates)
git commit -q --allow-empty -m "fix for sprint $SPRINT_LL after the live loop"
LL_FIX_COMMIT=$(git rev-parse HEAD)
$SCRIPT reship "$SPRINT_LL" --commit "$LL_FIX_COMMIT" > /dev/null
$SCRIPT liveqa "$SPRINT_LL" --deployed-commit "$LL_FIX_COMMIT" --verdict PASS --notes ok > /dev/null
$SCRIPT complete "$SPRINT_LL" --user-said "close it, the live-loop audits above are just records" > /dev/null
GATES_AFTER_LL=$($SCRIPT gates)
echo "$GATES_AFTER_LL" | grep "^   QA1:" > /tmp/qa1_line.txt
grep -qE "\b${SPRINT_LL}\b" /tmp/qa1_line.txt && \
  fail "gates counted sprint $SPRINT_LL under QA1's catch rate — its only real gate-1 'audit' event was a single PASS; the live-loop PASS/CONDITIONAL/FAIL entries above must not count"
rm -f /tmp/qa1_line.txt

echo "== Req 12: a PASS with no git repository present says so, and ship blames the missing repo, not a missing QA1 pass =="
NOGIT_SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/fully-completely-smoke-nogit.XXXXXX")"
mkdir -p "$NOGIT_SANDBOX/scripts" "$NOGIT_SANDBOX/templates"
cp "$REPO_ROOT/scripts/sprint_lifecycle.py" "$NOGIT_SANDBOX/scripts/sprint_lifecycle.py"
if [ -f "$REPO_ROOT/templates/sprint-template.md" ]; then
  cp "$REPO_ROOT/templates/sprint-template.md" "$NOGIT_SANDBOX/templates/sprint-template.md"
fi
NOGIT_SCRIPT="python3 $NOGIT_SANDBOX/scripts/sprint_lifecycle.py"
# Deliberately no `git init` here — this directory is not a git repository
# at all, the exact scenario Req 12 exists for. ROOT resolves from where
# the script FILE lives (Path(__file__).resolve().parent.parent), not cwd,
# so running it from anywhere still points ROOT at $NOGIT_SANDBOX.

NOGIT_ID=$($NOGIT_SCRIPT new "No repo sprint" | grep -oE 'Created sprint [0-9]+' | grep -oE '[0-9]+')
$NOGIT_SCRIPT start "$NOGIT_ID" > /dev/null

NOGIT_QA1_OUT=$($NOGIT_SCRIPT qa1 "$NOGIT_ID" --verdict PASS --notes ok 2>&1)
echo "$NOGIT_QA1_OUT" | grep -q "QA1 audit PASSED" || fail "PASS itself should still succeed with no git repository present"
echo "$NOGIT_QA1_OUT" | grep -q "not a git repository" || fail "PASS with no repository present should say so plainly, not record None in silence"
$NOGIT_SCRIPT dev-done "$NOGIT_ID" > /dev/null || fail "dev-done should still succeed with no git repository present (it doesn't need one)"

$NOGIT_SCRIPT ship "$NOGIT_ID" --commit deadbeef > /tmp/out.txt 2>&1 && fail "ship succeeded with no git repository present" || true
grep -q "not a git repository" /tmp/out.txt || fail "ship's no-repo message should name the missing repository"
grep -q "no QA1-audited commit on record" /tmp/out.txt && fail "ship should blame the missing repository, not a missing QA1 pass — QA1 DID pass"
rm -f /tmp/out.txt

echo "== Req 12: reship and liveqa give the same no-repository message, not the generic 'doesn't resolve' one =="
NOGIT_ID2=$($NOGIT_SCRIPT new "No repo reship sprint" | grep -oE 'Created sprint [0-9]+' | grep -oE '[0-9]+')
$NOGIT_SCRIPT start "$NOGIT_ID2" > /dev/null
NOGIT_STATE2="$NOGIT_SANDBOX/docs/sprints/state/sprint-${NOGIT_ID2}.json"
python3 -c "
import json
p = '$NOGIT_STATE2'
s = json.load(open(p))
s['phase'] = 'liveqa_live'
json.dump(s, open(p, 'w'), indent=2)
"
$NOGIT_SCRIPT reship "$NOGIT_ID2" --commit deadbeef > /tmp/out.txt 2>&1 && fail "reship succeeded with no git repository present" || true
grep -q "not a git repository" /tmp/out.txt || fail "reship's no-repo message should name the missing repository"
rm -f /tmp/out.txt

$NOGIT_SCRIPT liveqa "$NOGIT_ID2" --deployed-commit deadbeef --verdict PASS --notes ok > /tmp/out.txt 2>&1 && fail "liveqa succeeded with no git repository present" || true
grep -q "not a git repository" /tmp/out.txt || fail "liveqa's no-repo message should name the missing repository"
rm -f /tmp/out.txt
rm -rf "$NOGIT_SANDBOX"

echo "== Req 12: behaviour inside a real git repository is unchanged — the existing 'no QA1-audited commit' message still fires there =="
SPRINT_REALREPO_NOQA1=$(new_sprint "Real repo no qa1 sprint")
$SCRIPT start "$SPRINT_REALREPO_NOQA1" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_REALREPO_NOQA1 work"
# Force phase to dev_agreed_done without a QA1 PASS ever landing on record,
# same hand-edit technique as SPRINT_LEGACY above, to reach cmd_ship's "no
# audited tree hash" branch inside a REAL repo, never touching the
# no-repository path at all.
REALREPO_NOQA1_STATE="docs/sprints/state/sprint-${SPRINT_REALREPO_NOQA1}.json"
python3 -c "
import json
p = '$REALREPO_NOQA1_STATE'
s = json.load(open(p))
s['phase'] = 'dev_agreed_done'
json.dump(s, open(p, 'w'), indent=2)
"
REALREPO_NOQA1_COMMIT=$(git rev-parse HEAD)
$SCRIPT ship "$SPRINT_REALREPO_NOQA1" --commit "$REALREPO_NOQA1_COMMIT" > /tmp/out.txt 2>&1 && \
  fail "ship succeeded with no QA1 audit ever recorded (test setup broken)" || true
grep -q "no QA1-audited commit on record" /tmp/out.txt || fail "ship's real-repo, no-QA1-pass message regressed"
grep -q "not a git repository" /tmp/out.txt && fail "ship should never claim no repository exists when it's running inside a real one"
rm -f /tmp/out.txt

echo "ALL SMOKE TESTS PASSED"
