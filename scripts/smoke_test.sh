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

# Sprint 24, Req 2: check_ci_status() shells out to the real `gh` CLI, and
# this sandbox is a throwaway `git init` repo with no GitHub remote at
# all -- confirmed directly that real `gh` fails fast and cleanly against
# exactly that shape ("failed to determine base repo: no git remotes
# found", non-zero exit, no hang, no network attempt), which is why every
# OTHER `ship` call in this file below, unmodified, safely lands on
# CI_STATUS_UNDETERMINABLE and never gates -- this sandbox needing no
# retrofit anywhere else is itself evidence the undeterminable path is
# safe by default. But testing the RED and "success with no real steps"
# paths needs a `gh` that can actually claim a run exists. Faithful to
# this project's own precedent for exactly this shape of problem
# (launcher_test.js's withFakeClaude(): a fake executable installed at
# the front of PATH only for the specific invocation under test, real
# subprocess behaviour underneath, never left in place for any other
# test in this file): a fake `gh`, controlled by $FAKE_GH_MODE, prepended
# to PATH only on the individual command lines that need it below.
FAKE_GH_DIR="$SANDBOX/.fake-gh"
mkdir -p "$FAKE_GH_DIR"
cat > "$FAKE_GH_DIR/gh" <<'FAKEGH'
#!/usr/bin/env bash
case "$1 $2" in
  "run list")
    case "${FAKE_GH_MODE:-}" in
      pending) echo '[{"databaseId":1,"conclusion":null,"status":"in_progress","workflowName":"CI"}]' ;;
      red) echo '[{"databaseId":1,"conclusion":"failure","status":"completed","workflowName":"CI"}]' ;;
      no-steps) echo '[{"databaseId":1,"conclusion":"success","status":"completed","workflowName":"CI"}]' ;;
      green) echo '[{"databaseId":1,"conclusion":"success","status":"completed","workflowName":"CI"}]' ;;
      *) echo "[]" ;;
    esac
    ;;
  "run view")
    case "${FAKE_GH_MODE:-}" in
      no-steps) echo '{"jobs":[{"name":"build","conclusion":"success","steps":[{"name":"Set up job","status":"completed","conclusion":"success"},{"name":"npm ci","status":"completed","conclusion":"skipped"},{"name":"Complete job","status":"completed","conclusion":"success"}]}]}' ;;
      green) echo '{"jobs":[{"name":"build","conclusion":"success","steps":[{"name":"Set up job","status":"completed","conclusion":"success"},{"name":"Run tests","status":"completed","conclusion":"success"}]}]}' ;;
      *) echo '{"jobs":[]}' ;;
    esac
    ;;
  *) exit 1 ;;
esac
FAKEGH
chmod +x "$FAKE_GH_DIR/gh"

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

echo "== sprint 15, Req 4: ship --commit HEAD prints the resolved SHA, not the literal ref =="
SHIP_OUT_1=$($SCRIPT ship "$SPRINT_1" --commit HEAD 2>&1)
echo "$SHIP_OUT_1" | grep -qF "shipped (commit ${AUDITED_COMMIT_1})" || \
  fail "ship --commit HEAD should print the resolved SHA ($AUDITED_COMMIT_1) -- got: $SHIP_OUT_1"
echo "$SHIP_OUT_1" | grep -qF "shipped (commit HEAD)" && \
  fail "ship --commit HEAD printed the raw ref 'HEAD' instead of resolving it -- Req 4 regression"

$SCRIPT liveqa "$SPRINT_1" --deployed-commit "$AUDITED_COMMIT_1" --verdict FAIL --notes "expected fail" > /dev/null
git commit -q --allow-empty -m "fix for sprint $SPRINT_1"
FIX_COMMIT_1=$(git rev-parse HEAD)

echo "== sprint 15, Req 2: reship states plainly that the commit is unaudited and the live-loop audit is available, without implying LiveQA substitutes for QA1 =="
RESHIP_OUT_1=$($SCRIPT reship "$SPRINT_1" --commit "$FIX_COMMIT_1" 2>&1)
echo "$RESHIP_OUT_1" | grep -qF "fix reshipped (commit ${FIX_COMMIT_1})" || \
  fail "reship should also print the resolved SHA, same fix as ship -- got: $RESHIP_OUT_1"
echo "$RESHIP_OUT_1" | grep -q "has NOT been through QA1's static audit" || \
  fail "reship's output should say plainly this commit hasn't been through QA1's audit"
echo "$RESHIP_OUT_1" | grep -q "/sprint-qa1 will record a live-loop audit" || \
  fail "reship's output should name that the live-loop audit is available for this commit"
echo "$RESHIP_OUT_1" | grep -q "not a substitute for one" || \
  fail "reship's output should foreclose the LiveQA-substitutes-for-QA1 conflation, not just avoid repeating it"
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
echo "$GATES_OUT" | grep -q "Audited miss.*: 1 - sprints: ${SPRINT_1}$" || fail "gates didn't count sprint $SPRINT_1's GT fail (after a normal ship) as an audited miss"
echo "$GATES_OUT" | grep -q "Unaudited-fix miss.*: 0 " || fail "gates should show zero unaudited-fix misses so far"
echo "$GATES_OUT" | grep -q "LiveQA: 1 of 1 - sprints: \[${SPRINT_1}\]" || fail "gates didn't record sprint $SPRINT_1 under LiveQA's non-PASS catch"
echo "$GATES_OUT" | grep -q "QA1: 1 of 1 - sprints: \[${SPRINT_1}\]" || fail "gates should count sprint $SPRINT_1 under QA1's non-PASS catch (it had an initial FAIL round)"

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
echo "$FINAL_GATES_OUT" | grep -q "dev-done-hash overrides: 1 - sprints: ${SPRINT_GATES_OVR}" || fail "gates should count sprint $SPRINT_GATES_OVR's dev-done-hash override under hash-drift frequency"
echo "$FINAL_GATES_OUT" | grep -q "ship-hash overrides: 1 - sprints: ${SPRINT_SHIP_OVR_MISS}" || fail "gates should count sprint $SPRINT_SHIP_OVR_MISS's ship-hash override under hash-drift frequency"
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

# Sprint 24, Req 1: this MUST be a real content change, not
# --allow-empty. An empty commit has byte-identical tree content to its
# parent, and under Req 1's new content-based comparison that is now
# correctly ACCEPTED as a bookkeeping-only difference (see the dedicated
# test for exactly that below) — so an empty commit no longer exercises
# "genuinely different deployment," it would exercise the opposite case
# and this test would start passing for the wrong reason (or rather,
# stop refusing at all, which a naive `|| true` here would silently
# paper over). A real product-code line is what still has to refuse,
# unconditionally, per this Req's own FAIL-level acceptance criterion.
echo "unaudited product change, never shipped for this sprint" > "sprint24-unshipped-product-change.txt"
git add "sprint24-unshipped-product-change.txt"
git commit -q -m "an unrelated later commit, never shipped for this sprint"
UNSHIPPED_COMMIT=$(git rev-parse HEAD)
$SCRIPT liveqa "$SPRINT_GT_CHECK" --deployed-commit "$UNSHIPPED_COMMIT" --verdict PASS --notes "tested the wrong thing" \
  > /tmp/out.txt 2>&1 && fail "liveqa accepted a --deployed-commit that was never shipped for this sprint" || true
grep -q "doesn't match what Pipeman actually shipped" /tmp/out.txt || fail "deployed-commit mismatch refusal message missing"
grep -q "$GT_SHIPPED_COMMIT" /tmp/out.txt || fail "mismatch refusal should name the commit that was actually shipped"
grep -q "$UNSHIPPED_COMMIT" /tmp/out.txt || fail "mismatch refusal should name the commit that was actually tested"
# Sprint 24, Req 1: the message must name which paths actually differ,
# not just that the hashes do.
grep -q "sprint24-unshipped-product-change.txt" /tmp/out.txt || fail "mismatch refusal should name the differing path (Req 1)"
rm -f /tmp/out.txt

echo "== liveqa refuses a --deployed-commit that doesn't resolve to a real commit =="
$SCRIPT liveqa "$SPRINT_GT_CHECK" --deployed-commit not-a-real-commit --verdict PASS --notes ok \
  > /tmp/out.txt 2>&1 && fail "liveqa accepted a --deployed-commit that doesn't resolve" || true
grep -q "does not resolve to a real commit" /tmp/out.txt || fail "unresolvable deployed-commit refusal message missing"
rm -f /tmp/out.txt

echo "== sprint 24, Req 1: liveqa ACCEPTS a --deployed-commit that differs from last_shipped_commit only by bookkeeping content =="
SPRINT_LIVEQA_BOOKKEEPING=$(new_sprint "LiveQA bookkeeping-tolerance sprint")
$SCRIPT start "$SPRINT_LIVEQA_BOOKKEEPING" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_LIVEQA_BOOKKEEPING work"
$SCRIPT qa1 "$SPRINT_LIVEQA_BOOKKEEPING" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_LIVEQA_BOOKKEEPING" > /dev/null
LIVEQA_BOOKKEEPING_SHIPPED=$(git rev-parse HEAD)
$SCRIPT ship "$SPRINT_LIVEQA_BOOKKEEPING" --commit "$LIVEQA_BOOKKEEPING_SHIPPED" > /dev/null
# Same technique as sprint 13's own ship-side bookkeeping-tolerance test
# above (SPRINT_BOOKKEEPING): a real, unrelated sprint gets registered —
# exactly the shape of what this lifecycle itself writes as bookkeeping,
# landing on top before deployment, reproducing Context's Finding A
# scenario (bookkeeping commit on top of the real shipped commit) rather
# than a synthetic stand-in for it.
new_sprint "Another unrelated bookkeeping sprint" > /dev/null
git add docs/sprints
git commit -q -m "bookkeeping: registered another sprint, landed on top of the deploy"
LIVEQA_BOOKKEEPING_DEPLOYED=$(git rev-parse HEAD)
[ "$LIVEQA_BOOKKEEPING_SHIPPED" != "$LIVEQA_BOOKKEEPING_DEPLOYED" ] || \
  fail "test setup broken: the bookkeeping commit didn't actually create a new SHA"
$SCRIPT liveqa "$SPRINT_LIVEQA_BOOKKEEPING" --deployed-commit "$LIVEQA_BOOKKEEPING_DEPLOYED" --verdict PASS --notes "content matched" \
  > /tmp/out.txt 2>&1 || fail "liveqa refused a --deployed-commit that differs from last_shipped_commit only by bookkeeping content (Req 1 regression) -- output: $(cat /tmp/out.txt)"
grep -q "bookkeeping only" /tmp/out.txt || fail "liveqa's bookkeeping-only acceptance message is missing"
grep -qF "$LIVEQA_BOOKKEEPING_DEPLOYED" /tmp/out.txt || fail "liveqa's bookkeeping-only acceptance doesn't name the deployed commit"
$SCRIPT status "$SPRINT_LIVEQA_BOOKKEEPING" 2>&1 | grep -q "LiveQA live result: PASS" || \
  fail "the bookkeeping-tolerant liveqa verdict wasn't actually recorded"
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
$SCRIPT status "$SPRINT_GT_CHECK" 2>/dev/null | grep -q "Code has changed since the last recorded LiveQA verdict - not yet re-tested." || \
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
# Sprint 25, Req 2: last_claim now legitimately changes on EVERY
# save_state() call, stamped uniformly regardless of which command wrote
# -- excluded here the same way history already is, for the identical
# reason: it's expected to change, on purpose, every time. Not asserted
# that ts itself differs here: now() has one-second resolution and two
# calls this close together can legitimately land in the same second --
# that the mechanism actually stamps a fresh value is proven separately,
# with an explicit before/after env override, in this file's own
# dedicated sprint-25 Req 2 tests below.
ignored_fields = ('history', 'last_claim')
before_no_history = {k: v for k, v in before.items() if k not in ignored_fields}
after_no_history = {k: v for k, v in after.items() if k not in ignored_fields}
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

echo "== sprint 15, Req 1: the live-loop audit branch now also accepts complete_ready -- QA1's own method: seed exactly this shape, diff the WHOLE state file, only history may change =="
[ "$(python3 -c "import json; print(json.load(open('$LL_STATE'))['phase'])")" = "complete_ready" ] || \
  fail "test setup broken: sprint $SPRINT_LL should be at complete_ready after its PASS above, before /sprint-complete runs"
cp "$LL_STATE" /tmp/ll_ready_before.json

READY_OUT=$($SCRIPT qa1 "$SPRINT_LL" --verdict PASS --notes "live-loop audit at complete_ready" 2>&1)
echo "$READY_OUT" | grep -q "RECORD, not a" || fail "complete_ready live-loop audit output should say plainly it's a record, not a gate verdict"
echo "$READY_OUT" | grep -q "Both gates already passed" || fail "complete_ready live-loop audit output should say both gates already passed, not point at another LiveQA retest that isn't coming"

python3 -c "
import json
before = json.load(open('/tmp/ll_ready_before.json'))
after = json.load(open('$LL_STATE'))
protected = ['phase', 'qa1_audit_result', 'audit_rounds', 'qa1_audit_file_hash', 'qa1_audited_tree_hash']
for field in protected:
    if before[field] != after[field]:
        raise SystemExit(f'protected field {field} changed: {before[field]!r} -> {after[field]!r}')
# Sprint 25, Req 2: same exclusion as the first live-loop diff check above
# -- last_claim legitimately changes on every save_state() call now (not
# asserted here that ts itself differs -- now() has one-second resolution
# and this file's own dedicated Req 2 tests prove the stamping directly).
ignored_fields = ('history', 'last_claim')
before_no_history = {k: v for k, v in before.items() if k not in ignored_fields}
after_no_history = {k: v for k, v in after.items() if k not in ignored_fields}
if before_no_history != after_no_history:
    raise SystemExit(f'a field outside the five named ones changed too: before={before_no_history} after={after_no_history}')
if len(after['history']) != len(before['history']) + 1:
    raise SystemExit(f'expected exactly one new history event, before={len(before[\"history\"])} after={len(after[\"history\"])}')
if after['history'][-1]['event'] == 'audit':
    raise SystemExit('a complete_ready live-loop audit must use a name distinct from gate 1\'s \"audit\", or cmd_gates would count it')
" || fail "complete_ready live-loop audit state diff check failed -- see message above"
rm -f /tmp/ll_ready_before.json

$SCRIPT complete "$SPRINT_LL" --user-said "close it, the live-loop audits above are just records" > /dev/null

echo "== sprint 15, Req 1: complete is NOT included -- a live-loop audit against an already-closed sprint is refused, and nothing is written =="
cp "$LL_STATE" /tmp/ll_closed_before.json
$SCRIPT qa1 "$SPRINT_LL" --verdict PASS --notes "trying to audit a closed sprint" > /tmp/out.txt 2>&1 && \
  fail "qa1 succeeded recording a live-loop audit against sprint $SPRINT_LL, already complete" || true
diff -q /tmp/ll_closed_before.json "$LL_STATE" > /dev/null || fail "a refused live-loop audit against a closed sprint must not write anything"
rm -f /tmp/out.txt /tmp/ll_closed_before.json
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

echo "== sprint 13, Req 1 (Finding A): a bookkeeping-only change (docs/sprints/) after QA1's PASS does NOT invalidate the audit =="
SPRINT_BOOKKEEPING=$(new_sprint "Bookkeeping-only sprint")
$SCRIPT start "$SPRINT_BOOKKEEPING" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_BOOKKEEPING initial work"
$SCRIPT qa1 "$SPRINT_BOOKKEEPING" --verdict PASS --notes "looked good" > /dev/null
$SCRIPT dev-done "$SPRINT_BOOKKEEPING" > /dev/null
# Real lifecycle bookkeeping lands after the PASS: an entirely unrelated
# sprint gets created (a registry.json update plus a new file, both
# entirely under docs/sprints/), then committed — exactly the shape of
# what the lifecycle itself writes, and exactly what sprints 6, 8 and 10
# each hit against this same sprint's real audit.
new_sprint "Unrelated bookkeeping sprint" > /dev/null
git add docs/sprints
git commit -q -m "bookkeeping: registered another sprint"
BOOKKEEPING_COMMIT=$(git rev-parse HEAD)
$SCRIPT ship "$SPRINT_BOOKKEEPING" --commit "$BOOKKEEPING_COMMIT" > /tmp/out.txt 2>&1 || \
  fail "ship refused a commit whose only change was under docs/sprints/ (Req 1 regression) — output: $(cat /tmp/out.txt)"
rm -f /tmp/out.txt
# The commit just shipped also carries a genuine docs/sprints/.locks/*.lock
# file — every qa1/dev-done/ship call above acquires and releases one, and
# the lock FILE itself is never deleted (see locked()'s own docstring) —
# so this same assertion already covers the exclusion list's .locks/*
# pattern, not just registry.json/state/*.json/*/*.md. QA1's own first
# version of this fix passed this exact test while excluding a whole
# blanket "docs/sprints/" prefix; a real lock file created during THIS
# test run is what caught that the narrowed list initially missed
# docs/sprints/.locks/* too, before this comment or the fix existed.
git ls-tree -r "$BOOKKEEPING_COMMIT" --name-only | grep -q "^docs/sprints/\.locks/" || \
  fail "test setup broken: expected at least one docs/sprints/.locks/*.lock file in the shipped commit"

echo "== sprint 13, Req 1 (QA1 round 1's own finding): a shipped .gitkeep file is NOT in the exclusion list — an unaudited change to one still refuses =="
SPRINT_GITKEEP=$(new_sprint "Gitkeep regression sprint")
$SCRIPT start "$SPRINT_GITKEEP" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_GITKEEP initial work"
$SCRIPT qa1 "$SPRINT_GITKEEP" --verdict PASS --notes "looked good" > /dev/null
$SCRIPT dev-done "$SPRINT_GITKEEP" > /dev/null
# A phase-folder .gitkeep genuinely ships (install.js's own skeleton,
# confirmed against the real published tarball by QA1) — it is NOT one of
# .npmignore's docs/sprints/-specific exclusions, unlike registry.json,
# state/*.json, and the phase folders' own sprint *.md files. An
# unaudited byte appended to one must still be caught.
mkdir -p docs/sprints/4-blocked
printf '\n' >> docs/sprints/4-blocked/.gitkeep
git add docs/sprints/4-blocked/.gitkeep
git commit -q -m "unaudited change to a SHIPPED .gitkeep file"
GITKEEP_DRIFT_COMMIT=$(git rev-parse HEAD)
$SCRIPT ship "$SPRINT_GITKEEP" --commit "$GITKEEP_DRIFT_COMMIT" > /tmp/out.txt 2>&1 && \
  fail "ship succeeded on an unaudited change to a real, shipped .gitkeep file (Req 1's exclusion list is still too broad)" || true
grep -q "doesn't match what QA1 audited" /tmp/out.txt || fail "gitkeep-drift refusal message missing"
rm -f /tmp/out.txt

echo "== sprint 13, Req 1: a source change (outside docs/sprints/) after QA1's PASS still refuses, no override — the preserved protection =="
SPRINT_SOURCE_DRIFT=$(new_sprint "Source drift sprint (sprint 13)")
$SCRIPT start "$SPRINT_SOURCE_DRIFT" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_SOURCE_DRIFT initial work"
$SCRIPT qa1 "$SPRINT_SOURCE_DRIFT" --verdict PASS --notes "looked good" > /dev/null
$SCRIPT dev-done "$SPRINT_SOURCE_DRIFT" > /dev/null
echo "unaudited source change" > "sprint13-sneaky-source.txt"
git add "sprint13-sneaky-source.txt"
git commit -q -m "unaudited SOURCE change after QA1 PASS"
SOURCE_DRIFT_COMMIT=$(git rev-parse HEAD)
$SCRIPT ship "$SPRINT_SOURCE_DRIFT" --commit "$SOURCE_DRIFT_COMMIT" > /tmp/out.txt 2>&1 && \
  fail "ship succeeded on an unaudited SOURCE change — Req 1's relaxation leaked beyond docs/sprints/" || true
grep -q "doesn't match what QA1 audited" /tmp/out.txt || fail "sprint 13 source-drift refusal message missing"
rm -f /tmp/out.txt

echo "== sprint 13, Req 2: verify-publish is a real, wired-up command — refuses cleanly with no shipped commit on record =="
SPRINT_VERIFY_PUBLISH=$(new_sprint "Verify publish precondition sprint")
$SCRIPT start "$SPRINT_VERIFY_PUBLISH" > /dev/null
$SCRIPT verify-publish "$SPRINT_VERIFY_PUBLISH" > /tmp/out.txt 2>&1 && \
  fail "verify-publish succeeded with no shipped commit on record (test setup broken)" || true
grep -q "no shipped commit on record" /tmp/out.txt || fail "verify-publish's no-shipped-commit refusal message missing"
rm -f /tmp/out.txt

echo "== sprint 13, Req 3 (Finding C): status warns on a real cross-tree divergence, stays silent when trees agree, and never gates qa1 =="
SPRINT_WT=$(new_sprint "Worktree divergence sprint")
$SCRIPT start "$SPRINT_WT" > /dev/null
git add -A
git commit -q -m "commit sprint $SPRINT_WT's file so a second worktree can see it"

OTHER_WT="$(mktemp -d "${TMPDIR:-/tmp}/fully-completely-smoke-wt.XXXXXX")"
git worktree add -q -b smoke-wt-branch "$OTHER_WT" > /dev/null

# No divergence yet: the second worktree's copy is byte-identical.
$SCRIPT status "$SPRINT_WT" > /tmp/out.txt 2>&1
grep -q "WARNING" /tmp/out.txt && fail "status warned about worktree divergence when the files are actually identical"
rm -f /tmp/out.txt

# Amend the sprint file in the OTHER worktree only — a real cross-tree
# divergence, the exact scenario that had Dev Team building sprint 11
# against a spec amended on a different branch.
OTHER_WT_SPRINT_FILE=$(find "$OTHER_WT/docs/sprints/2-in-progress" -name "sprint-${SPRINT_WT}_*.md")
echo "### amended only in the other worktree" >> "$OTHER_WT_SPRINT_FILE"

$SCRIPT status "$SPRINT_WT" > /tmp/out.txt 2>&1 || fail "status failed once a second worktree existed with a diverged file"
grep -q "WARNING" /tmp/out.txt || fail "status did not warn about a real cross-tree divergence"
# Match on the mktemp basename, not the full $OTHER_WT path: the warning
# names the RESOLVED path (worktree_divergence_warning() calls .resolve()
# so /tmp vs /private/tmp-style symlink aliases compare equal), which can
# legitimately differ textually from $OTHER_WT's own unresolved form on
# macOS — the basename survives that resolution either way.
grep -q "$(basename "$OTHER_WT")" /tmp/out.txt || fail "divergence warning did not name the diverging worktree"
rm -f /tmp/out.txt

# It must warn, never gate: qa1 must still be able to record a verdict,
# and must surface the same warning rather than silently swallowing it.
git commit -q --allow-empty -m "sprint $SPRINT_WT work"
$SCRIPT qa1 "$SPRINT_WT" --verdict PASS --notes "worktree warning present but must not block" > /tmp/out.txt 2>&1 || \
  fail "qa1 was blocked by a worktree divergence warning — Req 3 says warn, never gate"
grep -q "WARNING" /tmp/out.txt || fail "qa1 did not surface the same divergence warning"
rm -f /tmp/out.txt

git worktree remove --force "$OTHER_WT" > /dev/null 2>&1 || rm -rf "$OTHER_WT"
git branch -D smoke-wt-branch > /dev/null 2>&1 || true

echo "== sprint 14, Req 1: a missing --*-file path fails legibly, naming the path, instead of an unhandled crash =="
# This is resolve_text()'s own bug, fixed once and shared by every
# --*-file argument in the CLI (qa1/liveqa notes, complete's user-said,
# abort's reason, override's reason) — the failure LiveQA actually found
# on a default Windows box, where the historical /tmp/... example path
# doesn't exist and the whole process used to die with a bare Python
# traceback and nothing recorded. Exercised here via --reason-file
# (abort) and --user-said-file (complete), the two call sites that don't
# need a prior PASS/phase to reach.
MISSING_FILE_PATH="does-not-exist-$(date +%s).txt"
[ ! -e "$MISSING_FILE_PATH" ] || fail "test setup broken: $MISSING_FILE_PATH unexpectedly exists"

SPRINT_MISSING_FILE=$(new_sprint "Missing file sprint")
$SCRIPT start "$SPRINT_MISSING_FILE" > /dev/null
# Sprint 33, Req 2: --user-said is now checked before --reason, so a
# valid one must be supplied here to reach the --reason-file read this
# case actually exercises.
$SCRIPT abort "$SPRINT_MISSING_FILE" --user-said "yes, abandon it" --reason-file "$MISSING_FILE_PATH" > /tmp/out.txt 2>&1 && \
  fail "abort succeeded reading a --reason-file that doesn't exist (test setup broken)" || true
grep -qF "Could not read '$MISSING_FILE_PATH'" /tmp/out.txt || fail "abort's missing-reason-file message doesn't name the path"
grep -qi "traceback" /tmp/out.txt && fail "abort's missing-reason-file case raised a raw traceback instead of failing legibly"
rm -f /tmp/out.txt

# complete's own three-condition refusal is checked elsewhere; this only
# needs to confirm resolve_text() itself fails legibly for user-said-file
# specifically, so use a sprint that will refuse for an EARLIER reason
# (no QA1 PASS yet) if the file-read somehow didn't fail first — the file
# read happens before those checks, so this still isolates the right bug.
$SCRIPT complete "$SPRINT_MISSING_FILE" --user-said-file "$MISSING_FILE_PATH" > /tmp/out.txt 2>&1 && \
  fail "complete succeeded reading a --user-said-file that doesn't exist (test setup broken)" || true
grep -qF "Could not read '$MISSING_FILE_PATH'" /tmp/out.txt || fail "complete's missing-user-said-file message doesn't name the path"
grep -qi "traceback" /tmp/out.txt && fail "complete's missing-user-said-file case raised a raw traceback instead of failing legibly"
rm -f /tmp/out.txt

echo "== sprint 14, Req 1: a missing --title-file on 'new' fails legibly too, naming the path (cmd_new's own former duplicate bug) =="
$SCRIPT new --title-file "$MISSING_FILE_PATH" > /tmp/out.txt 2>&1 && \
  fail "new succeeded reading a --title-file that doesn't exist (test setup broken)" || true
grep -qF "Could not read '$MISSING_FILE_PATH'" /tmp/out.txt || fail "new's missing-title-file message doesn't name the path"
grep -qi "traceback" /tmp/out.txt && fail "new's missing-title-file case raised a raw traceback instead of failing legibly"
rm -f /tmp/out.txt

echo "== sprint 24, Req 2: ship refuses over a red CI run for the exact commit being shipped =="
SPRINT_CI=$(new_sprint "CI status sprint")
$SCRIPT start "$SPRINT_CI" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_CI work"
$SCRIPT qa1 "$SPRINT_CI" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_CI" > /dev/null
CI_COMMIT=$(git rev-parse HEAD)
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=red $SCRIPT ship "$SPRINT_CI" --commit "$CI_COMMIT" \
  > /tmp/out.txt 2>&1 && fail "ship succeeded despite a red CI run for the exact commit being shipped" || true
grep -q "CI is red for the exact commit being shipped" /tmp/out.txt || fail "ship's CI-red refusal message is missing"
grep -qF "$CI_COMMIT" /tmp/out.txt || fail "ship's CI-red refusal doesn't name the commit"
$SCRIPT status "$SPRINT_CI" 2>&1 | grep -q "Phase: dev_agreed_done" || \
  fail "a CI-red ship attempt must not have moved the sprint's phase"
rm -f /tmp/out.txt

echo "== sprint 24, Req 2: ship refuses when CI 'succeeded' but no step actually executed -- not merely that a run existed or finished =="
# This is the specific case the reporter's own two-day-red build was: npm
# ci exiting EUSAGE in 5-7 seconds, lint/test/build never running. A run
# whose own top-level conclusion still reads "success" (this fake
# simulates a workflow that's misconfigured to report success trivially)
# but whose only completed, non-skipped step is "Set up job" must still
# refuse -- a check satisfied by "a run exists" or "a run completed"
# would pass this exact case, which is the defect this Req exists to fix.
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=no-steps $SCRIPT ship "$SPRINT_CI" --commit "$CI_COMMIT" \
  > /tmp/out.txt 2>&1 && fail "ship succeeded on a run that reported success but never executed a real step" || true
grep -q "no real step actually executed" /tmp/out.txt || fail "ship's no-real-steps-executed refusal message is missing"
rm -f /tmp/out.txt

echo "== sprint 24, Req 2: an undeterminable CI status (no runs found) warns but does NOT gate -- the explicit decision this Req requires =="
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=none $SCRIPT ship "$SPRINT_CI" --commit "$CI_COMMIT" \
  > /tmp/out.txt 2>&1 || fail "ship refused when CI status was genuinely undeterminable -- a project with no CI, or CI this tool can't see, must not become unshippable by accident (Req 2)"
grep -q "WARNING: could not determine CI status" /tmp/out.txt || fail "ship's undeterminable-CI-status warning is missing"
grep -q "no CI runs found" /tmp/out.txt || fail "ship's undeterminable warning doesn't explain why"
$SCRIPT status "$SPRINT_CI" 2>&1 | grep -qE "Phase: (liveqa_live|groundtruth_live)" || \
  fail "ship should have proceeded (undeterminable does not gate) and moved phase to the LiveQA phase"
rm -f /tmp/out.txt

echo "== sprint 24, Req 2: a genuinely green CI run (real steps executed) ships cleanly =="
SPRINT_CI_GREEN=$(new_sprint "CI green sprint")
$SCRIPT start "$SPRINT_CI_GREEN" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_CI_GREEN work"
$SCRIPT qa1 "$SPRINT_CI_GREEN" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_CI_GREEN" > /dev/null
CI_GREEN_COMMIT=$(git rev-parse HEAD)
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=green $SCRIPT ship "$SPRINT_CI_GREEN" --commit "$CI_GREEN_COMMIT" \
  > /tmp/out.txt 2>&1 || fail "ship refused despite a genuinely green CI run with real steps executed -- output: $(cat /tmp/out.txt)"
grep -q "CI check:.*completed successfully with real steps executed" /tmp/out.txt || \
  fail "ship's green-CI confirmation message is missing"
rm -f /tmp/out.txt

echo "== sprint 24, Req 2: a run still in progress is undeterminable (does not gate), not red, and says so distinctly =="
SPRINT_CI_PENDING=$(new_sprint "CI pending sprint")
$SCRIPT start "$SPRINT_CI_PENDING" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_CI_PENDING work"
$SCRIPT qa1 "$SPRINT_CI_PENDING" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_CI_PENDING" > /dev/null
CI_PENDING_COMMIT=$(git rev-parse HEAD)
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=pending $SCRIPT ship "$SPRINT_CI_PENDING" --commit "$CI_PENDING_COMMIT" \
  > /tmp/out.txt 2>&1 || fail "ship refused on a run still in progress -- this tool has no wait/poll mechanism, an in-progress run is undeterminable, not red"
grep -q "WARNING: could not determine CI status" /tmp/out.txt || fail "ship's pending-run warning is missing"
grep -q "have not finished yet" /tmp/out.txt || fail "ship's pending-run warning doesn't say the run hasn't finished, distinct from no CI at all"
rm -f /tmp/out.txt

echo "== sprint 24, Req 4 (added mid-flight): reship refuses over a red CI run for the exact commit, same as ship =="
SPRINT_RESHIP_CI=$(new_sprint "Reship CI status sprint")
$SCRIPT start "$SPRINT_RESHIP_CI" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_RESHIP_CI work"
$SCRIPT qa1 "$SPRINT_RESHIP_CI" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_RESHIP_CI" > /dev/null
RESHIP_CI_SHIPPED=$(git rev-parse HEAD)
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=green $SCRIPT ship "$SPRINT_RESHIP_CI" --commit "$RESHIP_CI_SHIPPED" > /dev/null
# A reship needs the sprint mid the LiveQA fix loop, not complete_ready --
# record a FAIL first, same as every other reship setup in this file.
$SCRIPT liveqa "$SPRINT_RESHIP_CI" --deployed-commit "$RESHIP_CI_SHIPPED" --verdict FAIL --notes "found a bug" > /dev/null
git commit -q --allow-empty -m "fix for sprint $SPRINT_RESHIP_CI"
RESHIP_CI_FIX=$(git rev-parse HEAD)
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=red $SCRIPT reship "$SPRINT_RESHIP_CI" --commit "$RESHIP_CI_FIX" \
  > /tmp/out.txt 2>&1 && fail "reship succeeded despite a red CI run for the exact commit being reshipped (Req 4 regression)" || true
grep -q "CI is red for the exact commit being reshipped" /tmp/out.txt || fail "reship's CI-red refusal message is missing"
grep -qF "$RESHIP_CI_FIX" /tmp/out.txt || fail "reship's CI-red refusal doesn't name the commit"
STATUS_AFTER_RED_RESHIP=$($SCRIPT status "$SPRINT_RESHIP_CI" --verbose 2>&1)
echo "$STATUS_AFTER_RED_RESHIP" | grep -qF "$RESHIP_CI_FIX" && \
  fail "a CI-red reship attempt must not have recorded the fix commit as last_shipped_commit"
rm -f /tmp/out.txt

echo "== sprint 24, Req 4: reship refuses when CI 'succeeded' but no real step executed, same specificity as ship =="
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=no-steps $SCRIPT reship "$SPRINT_RESHIP_CI" --commit "$RESHIP_CI_FIX" \
  > /tmp/out.txt 2>&1 && fail "reship succeeded on a run that reported success but never executed a real step" || true
grep -q "no real step actually executed" /tmp/out.txt || fail "reship's no-real-steps-executed refusal message is missing"
rm -f /tmp/out.txt

echo "== sprint 24, Req 4: an undeterminable CI status warns but does not gate a reship either -- the same decision, not decided twice =="
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=none $SCRIPT reship "$SPRINT_RESHIP_CI" --commit "$RESHIP_CI_FIX" \
  > /tmp/out.txt 2>&1 || fail "reship refused when CI status was genuinely undeterminable -- Req 4 requires the identical decision cmd_ship makes"
grep -q "WARNING: could not determine CI status" /tmp/out.txt || fail "reship's undeterminable-CI-status warning is missing"
grep -q "fix reshipped" /tmp/out.txt || fail "reship should have proceeded (undeterminable does not gate) -- its own success output is missing"
$SCRIPT status "$SPRINT_RESHIP_CI" --verbose 2>&1 | grep -qF "$RESHIP_CI_FIX" || \
  fail "reship should have recorded the fix commit as last_shipped_commit (undeterminable does not gate)"
rm -f /tmp/out.txt

echo "== sprint 24, Req 3: origin-ahead-of-record warns in status and liveqa, never gates, and doesn't misread as a bypassed push rule =="
SPRINT_ORIGIN=$(new_sprint "Origin-ahead sprint")
$SCRIPT start "$SPRINT_ORIGIN" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_ORIGIN work"
$SCRIPT qa1 "$SPRINT_ORIGIN" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_ORIGIN" > /dev/null
ORIGIN_SHIPPED_COMMIT=$(git rev-parse HEAD)
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=green $SCRIPT ship "$SPRINT_ORIGIN" --commit "$ORIGIN_SHIPPED_COMMIT" > /dev/null

# Simulate a second, real ship (often a headless Pipeman's own twin, per
# Finding C) landing on origin before this one's own bookkeeping caught
# up: a bare remote standing in for "origin", set up AFTER the commit
# this sprint already shipped, then advanced past it.
ORIGIN_BARE="$SANDBOX/.origin-bare.git"
git init -q --bare "$ORIGIN_BARE"
git remote add origin "$ORIGIN_BARE"
git push -q -u origin HEAD:main
echo "a second, real ship landing on origin" > "sprint24-second-ship.txt"
git add "sprint24-second-ship.txt"
git commit -q -m "a second, real ship (e.g. a headless Pipeman's own twin) landing on origin"
git push -q origin HEAD:main
# Deliberately do NOT run /sprint-ship for this second commit against
# THIS sprint's own record — that's the whole scenario: origin moved,
# last_shipped_commit did not, because cmd_ship's own state write for
# this second push hasn't happened (or belongs to a different sprint
# entirely; either way, this sprint's own record is now behind origin).

STATUS_ORIGIN_OUT=$($SCRIPT status "$SPRINT_ORIGIN" 2>&1)
echo "$STATUS_ORIGIN_OUT" | grep -q "carries 1 commit beyond this sprint's own recorded last_shipped_commit" || \
  fail "status did not surface the origin-ahead drift (Req 3) -- output: $STATUS_ORIGIN_OUT"
# The message legitimately CONTAINS the word "bypassed" -- as part of an
# explicit denial ("does NOT mean someone bypassed..."), the same
# foreclose-the-conflation wording pipeman.md itself already uses
# elsewhere. The actual test is that the denial is there, explicit and
# unambiguous, not that the word never appears.
echo "$STATUS_ORIGIN_OUT" | grep -q "does NOT mean someone bypassed" || \
  fail "status's origin-ahead warning should explicitly foreclose the bypassed-push-rule misreading, not just avoid repeating it"

# Warns, never gates: liveqa against the ORIGINAL shipped commit must
# still succeed cleanly despite origin now being ahead of the record.
LIVEQA_ORIGIN_OUT=$($SCRIPT liveqa "$SPRINT_ORIGIN" --deployed-commit "$ORIGIN_SHIPPED_COMMIT" --verdict PASS --notes ok 2>&1) || \
  fail "liveqa refused (or otherwise failed) solely because origin is ahead of the record -- Req 3 must never gate on this -- output: $LIVEQA_ORIGIN_OUT"
echo "$LIVEQA_ORIGIN_OUT" | grep -q "carries 1 commit beyond this sprint's own recorded last_shipped_commit" || \
  fail "liveqa did not surface the origin-ahead drift while reading last_shipped_commit to make a decision (Req 3)"

echo "== sprint 24, Req 3: origin-ahead-of-record warning is silent when there's nothing to report =="
SPRINT_ORIGIN_CLEAN=$(new_sprint "Origin clean sprint")
$SCRIPT start "$SPRINT_ORIGIN_CLEAN" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_ORIGIN_CLEAN work"
$SCRIPT qa1 "$SPRINT_ORIGIN_CLEAN" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_ORIGIN_CLEAN" > /dev/null
ORIGIN_CLEAN_COMMIT=$(git rev-parse HEAD)
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=green $SCRIPT ship "$SPRINT_ORIGIN_CLEAN" --commit "$ORIGIN_CLEAN_COMMIT" > /dev/null
git push -q origin HEAD:main
$SCRIPT status "$SPRINT_ORIGIN_CLEAN" 2>&1 | grep -q "carries.*commit.*beyond" && \
  fail "status warned about origin drift when origin and the record actually agree (false positive)"

echo "== sprint 25, Req 2: a write command's session identity, when the environment provides one, is recorded and surfaced by status (read-only) =="
SPRINT_CLAIM=$(new_sprint "Session claim sprint")
$SCRIPT start "$SPRINT_CLAIM" > /dev/null
CLAUDE_CODE_SESSION_ID="test-session-abc123" CLAUDE_CODE_AGENT="test-agent-xyz" \
  $SCRIPT qa1 "$SPRINT_CLAIM" --verdict PASS --notes ok > /dev/null
CLAIM_STATUS_OUT=$($SCRIPT status "$SPRINT_CLAIM" 2>&1)
echo "$CLAIM_STATUS_OUT" | grep -q "Last touched by: test-agent-xyz, session test-session-abc123" || \
  fail "status did not surface the recorded claim's exact agent/session (Req 2) -- output: $CLAIM_STATUS_OUT"

echo "== sprint 25, Req 2: an honest 'no session identity available' when the environment provides none, not a silently missing line =="
env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_AGENT $SCRIPT dev-done "$SPRINT_CLAIM" > /dev/null
NOSESSION_STATUS_OUT=$($SCRIPT status "$SPRINT_CLAIM" 2>&1)
echo "$NOSESSION_STATUS_OUT" | grep -q "Last touched by: (unknown" || \
  fail "status did not honestly report a missing session identity -- output: $NOSESSION_STATUS_OUT"

echo "== sprint 25, Req 2: status itself never writes a claim -- it stays read-only =="
STATUS_HASH_BEFORE=$(sha256sum "docs/sprints/state/sprint-${SPRINT_CLAIM}.json" | cut -d' ' -f1)
$SCRIPT status "$SPRINT_CLAIM" > /dev/null 2>&1
STATUS_HASH_AFTER=$(sha256sum "docs/sprints/state/sprint-${SPRINT_CLAIM}.json" | cut -d' ' -f1)
[ "$STATUS_HASH_BEFORE" = "$STATUS_HASH_AFTER" ] || fail "status must never modify the sprint's own state file (Req 2's own explicit instruction)"

echo "== sprint 25, Req 4: rename updates registry, frontmatter and filename together, and preserves the original title =="
SPRINT_RENAME=$(new_sprint "Original working title")
$SCRIPT start "$SPRINT_RENAME" > /dev/null
RENAME_FILE_BEFORE=$($SCRIPT status "$SPRINT_RENAME" > /dev/null 2>&1; find docs/sprints/2-in-progress -name "sprint-${SPRINT_RENAME}_*.md")
[ -n "$RENAME_FILE_BEFORE" ] || fail "test setup broken: could not find sprint $SPRINT_RENAME's file before renaming"

$SCRIPT rename "$SPRINT_RENAME" --title "A narrower, more accurate title" > /tmp/out.txt 2>&1 || \
  fail "rename failed -- output: $(cat /tmp/out.txt)"
grep -q 'renamed: "Original working title" -> "A narrower, more accurate title"' /tmp/out.txt || \
  fail "rename's own confirmation message is missing or wrong"
rm -f /tmp/out.txt

RENAME_FILE_AFTER=$(find docs/sprints/2-in-progress -name "sprint-${SPRINT_RENAME}_*.md")
[ "$RENAME_FILE_AFTER" != "$RENAME_FILE_BEFORE" ] || fail "the filename did not actually change"
[ -f "$RENAME_FILE_AFTER" ] || fail "the new filename does not exist on disk"
[ ! -f "$RENAME_FILE_BEFORE" ] || fail "the old filename still exists on disk -- rename should move, not copy"
echo "$RENAME_FILE_AFTER" | grep -q "narrower-more-accurate-title" || fail "the new filename doesn't reflect the new title"

grep -q 'title: "A narrower, more accurate title"' "$RENAME_FILE_AFTER" || fail "the frontmatter's title: line was not updated"
grep -q 'original_title: "Original working title"' "$RENAME_FILE_AFTER" || fail "the frontmatter's original_title: line is missing or wrong"

REGISTRY_TITLE=$(python3 -c "import json; print(json.load(open('docs/sprints/registry.json'))['sprints']['${SPRINT_RENAME}']['title'])")
[ "$REGISTRY_TITLE" = "A narrower, more accurate title" ] || fail "registry title was not updated to the new title"
REGISTRY_ORIGINAL=$(python3 -c "import json; print(json.load(open('docs/sprints/registry.json'))['sprints']['${SPRINT_RENAME}']['original_title'])")
[ "$REGISTRY_ORIGINAL" = "Original working title" ] || fail "registry did not preserve the original title"

STATE_TITLE=$(python3 -c "import json; print(json.load(open('docs/sprints/state/sprint-${SPRINT_RENAME}.json'))['title'])")
[ "$STATE_TITLE" = "A narrower, more accurate title" ] || fail "state.json's own title was not updated"

echo "== sprint 25, Req 4: renaming a second time still preserves the TRUE original title, not just the pre-rename one =="
$SCRIPT rename "$SPRINT_RENAME" --title "Yet another title" > /dev/null
SECOND_RENAME_ORIGINAL=$(python3 -c "import json; print(json.load(open('docs/sprints/registry.json'))['sprints']['${SPRINT_RENAME}']['original_title'])")
[ "$SECOND_RENAME_ORIGINAL" = "Original working title" ] || \
  fail "a second rename overwrote original_title with the intermediate name instead of preserving the true original"

echo "== sprint 25, Req 4: rename refuses an empty title, and refuses renaming to the same title =="
$SCRIPT rename "$SPRINT_RENAME" --title "" > /tmp/out.txt 2>&1 && fail "rename accepted an empty title" || true
grep -q "cannot be empty" /tmp/out.txt || fail "empty-title refusal message missing"
rm -f /tmp/out.txt
$SCRIPT rename "$SPRINT_RENAME" --title "Yet another title" > /tmp/out.txt 2>&1 && fail "rename accepted renaming to the exact current title" || true
grep -q "already titled" /tmp/out.txt || fail "same-title refusal message missing"
rm -f /tmp/out.txt

echo "== sprint 25, Req 4: rename does NOT touch phase, verdicts, or history =="
$SCRIPT qa1 "$SPRINT_RENAME" --verdict PASS --notes "before another rename" > /dev/null
PHASE_BEFORE=$($SCRIPT status "$SPRINT_RENAME" 2>&1 | grep "^Phase:")
HISTORY_LEN_BEFORE=$(python3 -c "import json; print(len(json.load(open('docs/sprints/state/sprint-${SPRINT_RENAME}.json'))['history']))")
$SCRIPT rename "$SPRINT_RENAME" --title "Renamed once more, post-PASS" > /dev/null
PHASE_AFTER=$($SCRIPT status "$SPRINT_RENAME" 2>&1 | grep "^Phase:")
[ "$PHASE_BEFORE" = "$PHASE_AFTER" ] || fail "rename changed the sprint's phase -- must not (Req 4)"
HISTORY_LEN_AFTER=$(python3 -c "import json; print(len(json.load(open('docs/sprints/state/sprint-${SPRINT_RENAME}.json'))['history']))")
[ "$HISTORY_LEN_BEFORE" = "$HISTORY_LEN_AFTER" ] || fail "rename appended to history -- must not (Req 4)"
QA1_RESULT_AFTER=$($SCRIPT status "$SPRINT_RENAME" 2>&1 | grep "^QA1 audit result:")
echo "$QA1_RESULT_AFTER" | grep -q "PASS" || fail "rename changed the recorded QA1 verdict -- must not (Req 4)"

echo "== sprint 25, Req 4: THE HASH QUESTION, TESTED NOT ASSUMED -- a rename after a QA1 PASS DOES require a fresh QA1 look, and this is the intended, correct behaviour =="
# A fresh, dedicated sprint, isolated from the phase/history test above
# (whose own rename of $SPRINT_RENAME already made ITS file stale relative
# to ITS own QA1 PASS by design -- that's the same mechanism this test
# checks directly and deliberately, not a bug to route around here).
SPRINT_RENAME_HASH=$(new_sprint "Hash gate rename sprint")
$SCRIPT start "$SPRINT_RENAME_HASH" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_RENAME_HASH work"
$SCRIPT qa1 "$SPRINT_RENAME_HASH" --verdict PASS --notes ok > /dev/null
$SCRIPT rename "$SPRINT_RENAME_HASH" --title "Renamed between QA1 PASS and dev-done" > /dev/null
$SCRIPT dev-done "$SPRINT_RENAME_HASH" > /tmp/out.txt 2>&1 && \
  fail "dev-done succeeded despite the sprint file changing (the rename itself) after QA1's PASS -- the hash gate should have caught this, per Req 4's own tested decision" || true
grep -q "requirements may have been amended after the audit" /tmp/out.txt || \
  fail "dev-done's refusal after a post-PASS rename doesn't give the expected reason -- output: $(cat /tmp/out.txt)"
rm -f /tmp/out.txt
# And the documented recovery path works: a fresh QA1 look on the CURRENT
# (renamed) file, then dev-done succeeds.
$SCRIPT qa1 "$SPRINT_RENAME_HASH" --verdict PASS --notes "re-audited the renamed file" > /dev/null
$SCRIPT dev-done "$SPRINT_RENAME_HASH" > /tmp/out.txt 2>&1 || \
  fail "dev-done still refused after a fresh QA1 PASS on the current (renamed) file -- output: $(cat /tmp/out.txt)"
rm -f /tmp/out.txt

echo "== sprint 25, Req 4: renaming BEFORE any QA1 PASS has nothing to invalidate =="
SPRINT_RENAME_EARLY=$(new_sprint "Pre-audit rename sprint")
$SCRIPT start "$SPRINT_RENAME_EARLY" > /dev/null
$SCRIPT rename "$SPRINT_RENAME_EARLY" --title "Renamed before QA1 ever looked" > /tmp/out.txt 2>&1 || \
  fail "rename before any audit failed -- output: $(cat /tmp/out.txt)"
rm -f /tmp/out.txt
git commit -q --allow-empty -m "sprint $SPRINT_RENAME_EARLY work"
$SCRIPT qa1 "$SPRINT_RENAME_EARLY" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_RENAME_EARLY" > /tmp/out.txt 2>&1 || \
  fail "dev-done refused for a sprint renamed before QA1 ever audited it -- nothing should be invalidated here -- output: $(cat /tmp/out.txt)"
rm -f /tmp/out.txt

echo "== sprint 25, Req 4: rename refuses cleanly for an unknown sprint id =="
$SCRIPT rename 999999 --title "Doesn't matter" > /tmp/out.txt 2>&1 && fail "rename succeeded for a nonexistent sprint id" || true
grep -q "not found in registry" /tmp/out.txt || fail "unknown-sprint-id refusal message missing"
rm -f /tmp/out.txt

echo "== sprint 27, Req 1: sprint_lifecycle.py itself performs zero git commit/add calls (static, mechanical, FAIL-level per QA1's own criterion) =="
grep -qE '"git",\s*"(commit|add)"|'"'"'git'"'"',\s*'"'"'(commit|add)'"'"'' "$REPO_ROOT/scripts/sprint_lifecycle.py" && \
  fail "sprint_lifecycle.py contains a git commit/add call -- this property must stay at zero (Req 1)"

echo "== sprint 27, Req 1: a writing command prints the completion notice, naming exactly what it wrote =="
SPRINT_NOTICE=$(new_sprint "Completion notice sprint")
$SCRIPT start "$SPRINT_NOTICE" > /tmp/out.txt 2>&1 || fail "start failed -- output: $(cat /tmp/out.txt)"
grep -q "^Wrote: " /tmp/out.txt || fail "start did not print the completion notice (Req 1)"
grep -q "sprint-${SPRINT_NOTICE}_" /tmp/out.txt || fail "the notice doesn't name the sprint file it moved/wrote"
grep -q "docs/sprints/registry.json" /tmp/out.txt || fail "the notice doesn't name registry.json"
grep -q "docs/sprints/state/sprint-${SPRINT_NOTICE}.json" /tmp/out.txt || fail "the notice doesn't name the new state file"
grep -qi "not committed" /tmp/out.txt || fail "the notice doesn't say these are uncommitted"
# The notice must read as a receipt, not an alarm -- read cold, per QA1's
# own acceptance criterion.
grep -qi "warning\|drift\|error" /tmp/out.txt && \
  fail "the completion notice reads like a problem report rather than a statement of what just happened (Req 1's own tone requirement)"
rm -f /tmp/out.txt
# And the notice is honest -- these files really are uncommitted right now.
git status --porcelain "docs/sprints/state/sprint-${SPRINT_NOTICE}.json" | grep -q "^??" || \
  fail "test setup broken: the state file the notice named should genuinely be untracked"

echo "== sprint 27, Req 1: a read-only command prints no completion notice =="
$SCRIPT status "$SPRINT_NOTICE" > /tmp/out.txt 2>&1 || fail "status failed"
grep -q "^Wrote: " /tmp/out.txt && fail "status (read-only) printed a completion notice -- it must never write anything (Req 1)"
rm -f /tmp/out.txt
$SCRIPT list > /tmp/out.txt 2>&1 || fail "list failed"
grep -q "^Wrote: " /tmp/out.txt && fail "list (read-only) printed a completion notice"
rm -f /tmp/out.txt
$SCRIPT gates > /tmp/out.txt 2>&1 || fail "gates failed"
grep -q "^Wrote: " /tmp/out.txt && fail "gates (read-only) printed a completion notice"
rm -f /tmp/out.txt

echo "== sprint 27, Req 1: the notice still fires (an honest receipt for what DID land) even when the command later refuses =="
$SCRIPT qa1 "$SPRINT_NOTICE" --verdict BOGUS --notes "invalid verdict, should refuse after nothing further is written" \
  > /tmp/out.txt 2>&1 && fail "qa1 accepted an invalid verdict (test setup broken)" || true
grep -q "^Wrote: " /tmp/out.txt && fail "a refused command with NOTHING written must not print a notice -- nothing landed on disk"
rm -f /tmp/out.txt

echo "== sprint 27, Req 3: cmd_liveqa RECORDS a sprint file amended since QA1's PASS -- it does not refuse =="
SPRINT_DRIFT_LQ=$(new_sprint "LiveQA sprint-file drift sprint")
$SCRIPT start "$SPRINT_DRIFT_LQ" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_DRIFT_LQ work"
$SCRIPT qa1 "$SPRINT_DRIFT_LQ" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_DRIFT_LQ" > /dev/null
DRIFT_LQ_COMMIT=$(git rev-parse HEAD)
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=green $SCRIPT ship "$SPRINT_DRIFT_LQ" --commit "$DRIFT_LQ_COMMIT" > /dev/null

# Amend the sprint file itself -- exactly Finding B's own scenario: a
# Master Controller (or anyone) editing the file during the live-test
# window, no lifecycle command involved.
DRIFT_LQ_FILE=$(find docs/sprints/2-in-progress -name "sprint-${SPRINT_DRIFT_LQ}_*.md")
[ -n "$DRIFT_LQ_FILE" ] || fail "test setup broken: could not find sprint $SPRINT_DRIFT_LQ's file"
printf '\n**Amended mid-flight, discovered an unsatisfiable acceptance criterion.**\n' >> "$DRIFT_LQ_FILE"

LQ_DRIFT_OUT=$($SCRIPT liveqa "$SPRINT_DRIFT_LQ" --deployed-commit "$DRIFT_LQ_COMMIT" --verdict PASS --notes "live test itself was fine" 2>&1)
LQ_DRIFT_STATUS=$?
[ "$LQ_DRIFT_STATUS" -eq 0 ] || fail "liveqa REFUSED over a sprint file amended since QA1's PASS -- Req 3 is explicit this must never refuse (FAIL-level) -- output: $LQ_DRIFT_OUT"
echo "$LQ_DRIFT_OUT" | grep -q "has changed since QA1's PASS" || \
  fail "liveqa's own verdict output doesn't surface the sprint-file drift (Req 3) -- output: $LQ_DRIFT_OUT"
# Not a die()-style refusal -- no "ERROR:" prefix (die()'s own, checked
# elsewhere throughout this file) and the verdict itself still printed as
# a real PASS below, not just a non-zero-exit check in isolation.
echo "$LQ_DRIFT_OUT" | grep -q "^ERROR:" && \
  fail "liveqa's drift notice came through die()'s own refusal path -- output: $LQ_DRIFT_OUT"
echo "$LQ_DRIFT_OUT" | grep -q "PASSED" || \
  fail "liveqa's own verdict output doesn't confirm the PASS went through -- output: $LQ_DRIFT_OUT"
# Recorded in the durable history, not only printed once and lost.
python3 -c "
import json
state = json.load(open('docs/sprints/state/sprint-${SPRINT_DRIFT_LQ}.json'))
events = [h['event'] for h in state['history']]
assert 'sprint_file_drift_since_audit' in events, f'drift event missing from history: {events}'
assert state['groundtruth_result'] == 'PASS', f'the live-test verdict itself was not recorded: {state[\"groundtruth_result\"]!r}'
assert state['phase'] == 'complete_ready', f'a PASS verdict should still move the sprint to complete_ready, drift or not: {state[\"phase\"]!r}'
"
$SCRIPT status "$SPRINT_DRIFT_LQ" 2>&1 | grep -q "LiveQA live result: PASS" || \
  fail "the live-test PASS itself must still be recorded and visible, drift or not"

echo "== sprint 27, Req 3: a sprint file UNCHANGED since QA1's PASS gets no drift note =="
SPRINT_NODRIFT_LQ=$(new_sprint "LiveQA no-drift sprint")
$SCRIPT start "$SPRINT_NODRIFT_LQ" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_NODRIFT_LQ work"
$SCRIPT qa1 "$SPRINT_NODRIFT_LQ" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_NODRIFT_LQ" > /dev/null
NODRIFT_LQ_COMMIT=$(git rev-parse HEAD)
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=green $SCRIPT ship "$SPRINT_NODRIFT_LQ" --commit "$NODRIFT_LQ_COMMIT" > /dev/null
NODRIFT_OUT=$($SCRIPT liveqa "$SPRINT_NODRIFT_LQ" --deployed-commit "$NODRIFT_LQ_COMMIT" --verdict PASS --notes ok 2>&1)
echo "$NODRIFT_OUT" | grep -q "has changed since QA1's PASS" && \
  fail "liveqa reported sprint-file drift when the file genuinely never changed (false positive)"
python3 -c "
import json
state = json.load(open('docs/sprints/state/sprint-${SPRINT_NODRIFT_LQ}.json'))
events = [h['event'] for h in state['history']]
assert 'sprint_file_drift_since_audit' not in events, f'a drift event was recorded when nothing drifted: {events}'
"

MAIN_BRANCH=$(git rev-parse --abbrev-ref HEAD)

echo "== sprint 28, Req 1: no workflows configured at all still ships as the benign undeterminable case (baseline, unaffected by the split) =="
SPRINT_CI_NOWF=$(new_sprint "CI no-workflows sprint")
$SCRIPT start "$SPRINT_CI_NOWF" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_CI_NOWF work, deliberately no .github/workflows/"
$SCRIPT qa1 "$SPRINT_CI_NOWF" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_CI_NOWF" > /dev/null
CI_NOWF_COMMIT=$(git rev-parse HEAD)
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=none $SCRIPT ship "$SPRINT_CI_NOWF" --commit "$CI_NOWF_COMMIT" \
  > /tmp/out.txt 2>&1 || fail "ship refused with no workflows configured at all -- must stay the benign undeterminable case (sprint 24's own rule)"
grep -q "no CI is configured" /tmp/out.txt || fail "ship's no-workflows-at-all warning doesn't say CI genuinely isn't configured"
rm -f /tmp/out.txt

echo "== sprint 28, Req 1: workflows configured but no CI run found for the commit is graded RED (refuses), NOT the benign undeterminable case =="
SPRINT_CI_SPLIT=$(new_sprint "CI split sprint")
$SCRIPT start "$SPRINT_CI_SPLIT" > /dev/null
mkdir -p .github/workflows
echo "name: ci" > .github/workflows/ci.yml
git add .github/workflows
git commit -q -m "sprint $SPRINT_CI_SPLIT: a workflow file exists, no run will ever exist for this fake commit"
$SCRIPT qa1 "$SPRINT_CI_SPLIT" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_CI_SPLIT" > /dev/null
CI_SPLIT_COMMIT=$(git rev-parse HEAD)
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=none $SCRIPT ship "$SPRINT_CI_SPLIT" --commit "$CI_SPLIT_COMMIT" \
  > /tmp/out.txt 2>&1 && fail "ship succeeded when workflows are configured but no CI run was found for the commit -- must refuse, not silently proceed" || true
grep -q "workflows are configured" /tmp/out.txt || fail "ship's workflows-configured-no-run refusal doesn't name the case"
grep -q "indistinguishable from a pipeline broken" /tmp/out.txt || fail "ship's workflows-configured-no-run refusal doesn't explain why this isn't benign"
$SCRIPT status "$SPRINT_CI_SPLIT" 2>&1 | grep -q "Phase: dev_agreed_done" || \
  fail "a workflows-configured-no-run ship attempt must not have moved the sprint's phase"
rm -f /tmp/out.txt

echo "== sprint 28, Req 1: the same sprint still ships cleanly once a run genuinely exists and is green -- not a permanent lockout =="
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=green $SCRIPT ship "$SPRINT_CI_SPLIT" --commit "$CI_SPLIT_COMMIT" \
  > /tmp/out.txt 2>&1 || fail "ship refused a workflows-configured commit with a genuinely green run -- output: $(cat /tmp/out.txt)"
rm -f /tmp/out.txt

echo "== sprint 28, Req 1: reship gets the identical workflows-configured-no-run treatment as ship (same question, same answer) =="
SPRINT_RESHIP_SPLIT=$(new_sprint "Reship CI split sprint")
$SCRIPT start "$SPRINT_RESHIP_SPLIT" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_RESHIP_SPLIT work"
$SCRIPT qa1 "$SPRINT_RESHIP_SPLIT" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_RESHIP_SPLIT" > /dev/null
RESHIP_SPLIT_SHIPPED=$(git rev-parse HEAD)
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=green $SCRIPT ship "$SPRINT_RESHIP_SPLIT" --commit "$RESHIP_SPLIT_SHIPPED" > /dev/null
$SCRIPT liveqa "$SPRINT_RESHIP_SPLIT" --deployed-commit "$RESHIP_SPLIT_SHIPPED" --verdict FAIL --notes "found a bug" > /dev/null
git commit -q --allow-empty -m "fix for sprint $SPRINT_RESHIP_SPLIT, workflows are already configured by now"
RESHIP_SPLIT_FIX=$(git rev-parse HEAD)
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=none $SCRIPT reship "$SPRINT_RESHIP_SPLIT" --commit "$RESHIP_SPLIT_FIX" \
  > /tmp/out.txt 2>&1 && fail "reship succeeded when workflows are configured but no CI run was found for the commit (Req 1 regression)" || true
grep -q "workflows are configured" /tmp/out.txt || fail "reship's workflows-configured-no-run refusal doesn't name the case"
rm -f /tmp/out.txt

echo "== sprint 28, Req 2: ship refuses when --commit is not reachable from HEAD, before ever recording it as last_shipped_commit =="
SPRINT_UNREACH=$(new_sprint "Unreachable commit sprint")
$SCRIPT start "$SPRINT_UNREACH" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_UNREACH work"
$SCRIPT qa1 "$SPRINT_UNREACH" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_UNREACH" > /dev/null
UNREACH_MAIN_HEAD=$(git rev-parse HEAD)
# A real, valid commit object that is nonetheless not an ancestor of HEAD:
# branch off, add an empty commit (same tree content as its parent, so the
# ship gate's own tree-hash check still matches the audited tree and lets
# execution reach the reachability check being tested here), then return to
# the main branch WITHOUT that commit ever merging in. Left on its own
# branch rather than deleted -- reachable from HEAD is what's being tested,
# not reachable from anywhere at all, and a throwaway sandbox needs no
# cleanup beyond the final rm -rf.
git checkout -q -b unreachable-throwaway
git commit -q --allow-empty -m "a commit that will never be on $MAIN_BRANCH"
UNREACHABLE_COMMIT=$(git rev-parse HEAD)
git checkout -q "$MAIN_BRANCH"
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=green $SCRIPT ship "$SPRINT_UNREACH" --commit "$UNREACHABLE_COMMIT" \
  > /tmp/out.txt 2>&1 && fail "ship succeeded for a commit that is not reachable from HEAD" || true
grep -q "is not reachable from HEAD" /tmp/out.txt || fail "ship's unreachable-commit refusal message is missing"
$SCRIPT status "$SPRINT_UNREACH" --verbose 2>&1 | grep -qF "$UNREACHABLE_COMMIT" && \
  fail "an unreachable commit must never be recorded as last_shipped_commit"
$SCRIPT status "$SPRINT_UNREACH" 2>&1 | grep -q "Phase: dev_agreed_done" || \
  fail "a ship refused for unreachability must not have moved the sprint's phase"
rm -f /tmp/out.txt

echo "== sprint 28, Req 2: the same sprint ships fine once given a genuinely reachable commit -- not a permanent lockout =="
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=green $SCRIPT ship "$SPRINT_UNREACH" --commit "$UNREACH_MAIN_HEAD" \
  > /tmp/out.txt 2>&1 || fail "ship refused a genuinely reachable commit -- output: $(cat /tmp/out.txt)"
rm -f /tmp/out.txt

echo "== sprint 28, Req 3: repoint-shipped-commit re-points last_shipped_commit to a patch-id-equivalent (relocated) commit, and records the equivalence =="
SPRINT_REPOINT=$(new_sprint "Repoint sprint")
$SCRIPT start "$SPRINT_REPOINT" > /dev/null
echo "repoint sprint content" > "repoint-${SPRINT_REPOINT}.txt"
git add "repoint-${SPRINT_REPOINT}.txt"
git commit -q -m "sprint $SPRINT_REPOINT work"
$SCRIPT qa1 "$SPRINT_REPOINT" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_REPOINT" > /dev/null
REPOINT_ORIGINAL=$(git rev-parse HEAD)
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=green $SCRIPT ship "$SPRINT_REPOINT" --commit "$REPOINT_ORIGINAL" > /dev/null

# Simulate the Context Finding B shape: a rebase relocates the exact same
# patch onto a different base (unrelated work landing underneath it) --
# cherry-pick, which by construction preserves patch content while
# changing the commit's parent (and therefore its own SHA and tree).
git checkout -q -b repoint-relocated "${REPOINT_ORIGINAL}~1"
git commit -q --allow-empty -m "unrelated work underneath, simulating the moved base"
git cherry-pick "$REPOINT_ORIGINAL" > /dev/null
REPOINT_RELOCATED=$(git rev-parse HEAD)
git checkout -q "$MAIN_BRANCH"

$SCRIPT repoint-shipped-commit "$SPRINT_REPOINT" --commit "$REPOINT_RELOCATED" \
  > /tmp/out.txt 2>&1 || fail "repoint-shipped-commit refused a genuinely patch-id-equivalent relocated commit -- output: $(cat /tmp/out.txt)"
grep -q "re-pointed" /tmp/out.txt || fail "repoint's success message is missing"
grep -qF "$REPOINT_RELOCATED" /tmp/out.txt || fail "repoint's success message doesn't name the new commit"
$SCRIPT status "$SPRINT_REPOINT" --verbose 2>&1 | grep -qF "$REPOINT_RELOCATED" || \
  fail "repoint should have updated last_shipped_commit to the relocated commit"
python3 -c "
import json
state = json.load(open('docs/sprints/state/sprint-${SPRINT_REPOINT}.json'))
events = [h['event'] for h in state['history']]
assert 'repointed_shipped_commit' in events, f'no repointed_shipped_commit event recorded: {events}'
last = [h for h in state['history'] if h['event'] == 'repointed_shipped_commit'][-1]
assert '$REPOINT_ORIGINAL' in last['detail'], f'repoint history entry does not name the old commit: {last[\"detail\"]}'
assert '$REPOINT_RELOCATED' in last['detail'], f'repoint history entry does not name the new commit: {last[\"detail\"]}'
assert 'patch_id' in last['detail'], f'repoint history entry does not record the patch-id: {last[\"detail\"]}'
"
rm -f /tmp/out.txt

echo "== sprint 28, Req 3: repoint-shipped-commit refuses a commit whose patch-id does NOT match -- FAIL, no override =="
echo "totally different content" > "repoint-unrelated-${SPRINT_REPOINT}.txt"
git add "repoint-unrelated-${SPRINT_REPOINT}.txt"
git commit -q -m "unrelated commit, not the same patch at all"
REPOINT_UNRELATED=$(git rev-parse HEAD)
$SCRIPT repoint-shipped-commit "$SPRINT_REPOINT" --commit "$REPOINT_UNRELATED" \
  > /tmp/out.txt 2>&1 && fail "repoint-shipped-commit succeeded on a commit whose patch-id does not match -- must refuse, no override" || true
grep -q "is NOT the same patch as" /tmp/out.txt || fail "repoint's patch-id-mismatch refusal message is missing"
$SCRIPT status "$SPRINT_REPOINT" --verbose 2>&1 | grep -qF "$REPOINT_UNRELATED" && \
  fail "a patch-id-mismatched commit must never be recorded as last_shipped_commit"
$SCRIPT status "$SPRINT_REPOINT" --verbose 2>&1 | grep -qF "$REPOINT_RELOCATED" || \
  fail "last_shipped_commit should still be the relocated commit after a refused repoint attempt"
rm -f /tmp/out.txt

echo "== sprint 28, Req 3: repoint-shipped-commit works on an already-COMPLETE sprint, not just mid-liveqa -- the whole reason it exists (Context Finding B) =="
$SCRIPT liveqa "$SPRINT_REPOINT" --deployed-commit "$REPOINT_RELOCATED" --verdict PASS --notes ok > /dev/null
printf 'closing repoint sprint for the test\n' > /tmp/user_said_repoint.txt
$SCRIPT complete "$SPRINT_REPOINT" --user-said-file /tmp/user_said_repoint.txt > /dev/null
$SCRIPT status "$SPRINT_REPOINT" 2>&1 | grep -q "Phase: complete" || fail "test setup: sprint should be complete before this check"
$SCRIPT reship "$SPRINT_REPOINT" --commit "$REPOINT_RELOCATED" > /tmp/out.txt 2>&1 && \
  fail "test setup check: reship should refuse on a complete sprint, it succeeded instead" || true
git checkout -q -b repoint-relocated-2 "${REPOINT_ORIGINAL}~1"
git commit -q --allow-empty -m "different unrelated work underneath, second relocation"
git cherry-pick "$REPOINT_ORIGINAL" > /dev/null
REPOINT_RELOCATED_2=$(git rev-parse HEAD)
git checkout -q "$MAIN_BRANCH"
$SCRIPT repoint-shipped-commit "$SPRINT_REPOINT" --commit "$REPOINT_RELOCATED_2" \
  > /tmp/out.txt 2>&1 || fail "repoint-shipped-commit refused on a complete sprint -- this is exactly the dead end it exists to fix. output: $(cat /tmp/out.txt)"
$SCRIPT status "$SPRINT_REPOINT" --verbose 2>&1 | grep -qF "$REPOINT_RELOCATED_2" || \
  fail "repoint should have updated last_shipped_commit even on a complete sprint"
rm -f /tmp/out.txt /tmp/user_said_repoint.txt

echo "== sprint 28, Req 4: the ship gate's own tree comparison is unaffected -- patch-id appears nowhere in git_tree_hash_excluding's call graph =="
if grep -n "patch.id\|patch_id" scripts/sprint_lifecycle.py | grep -qi "git_tree_hash_excluding\|cmd_ship\b"; then
  fail "patch-id logic appears to have leaked into the ship gate's tree comparison (Req 4 regression) -- see the matching grep line above"
fi

echo "== sprint 28, Req 3: repoint-shipped-commit refuses cleanly when the sprint has no last_shipped_commit to re-point =="
SPRINT_NOREPOINT=$(new_sprint "No repoint target sprint")
$SCRIPT start "$SPRINT_NOREPOINT" > /dev/null
$SCRIPT repoint-shipped-commit "$SPRINT_NOREPOINT" --commit "$MAIN_BRANCH" \
  > /tmp/out.txt 2>&1 && fail "repoint-shipped-commit succeeded on a sprint with no last_shipped_commit on record" || true
grep -q "nothing to re-point" /tmp/out.txt || fail "repoint's no-last-shipped-commit refusal message is missing"
rm -f /tmp/out.txt

echo "== sprint 29, Req 1/2: a sprint closed only in another worktree is surfaced from here (state + registry), on status (both forms) and list =="
SPRINT_STATE_WT=$(new_sprint "State divergence sprint")
$SCRIPT start "$SPRINT_STATE_WT" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_STATE_WT work"
$SCRIPT qa1 "$SPRINT_STATE_WT" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_STATE_WT" > /dev/null
STATE_WT_COMMIT=$(git rev-parse HEAD)
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=green $SCRIPT ship "$SPRINT_STATE_WT" --commit "$STATE_WT_COMMIT" > /dev/null
# A new worktree checks out committed history only, never another
# worktree's uncommitted files -- sprint_lifecycle.py's own writes never
# get here any other way, same reason sprint 13's own worktree test
# commits before branching (line ~980, above).
git add -A
git commit -q -m "commit sprint $SPRINT_STATE_WT's shipped state so a second worktree starts from it"

STATE_WT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fully-completely-smoke-state-wt.XXXXXX")"
git worktree add -q -b smoke-state-wt-branch "$STATE_WT_DIR" > /dev/null
STATE_WT_SCRIPT="python3 $STATE_WT_DIR/scripts/sprint_lifecycle.py"

# Close it fully, but ONLY inside the other worktree -- nothing here ever
# commits or pushes that close, exactly the stranding Finding A describes
# ("/sprint-complete correctly writes where it runs; the close commit
# never reaches main"). sprint_lifecycle.py never touches git itself, so
# these writes sit as plain uncommitted files in $STATE_WT_DIR the whole
# time -- state_divergence_warning() reads worktree files directly, not
# through git, which is exactly why it can see this at all.
$STATE_WT_SCRIPT liveqa "$SPRINT_STATE_WT" --deployed-commit "$STATE_WT_COMMIT" --verdict PASS --notes ok > /dev/null
printf 'closing for the divergence test\n' > /tmp/state_wt_user_said.txt
$STATE_WT_SCRIPT complete "$SPRINT_STATE_WT" --user-said-file /tmp/state_wt_user_said.txt > /dev/null

# This tree's own phase must be completely unaffected by a close that
# happened only in the other worktree.
$SCRIPT status "$SPRINT_STATE_WT" 2>&1 | grep -qE "Phase: (liveqa_live|groundtruth_live)" || \
  fail "test setup: this tree's own phase should be unaffected by a close in the other worktree"

STATUS_STATE_OUT=$($SCRIPT status "$SPRINT_STATE_WT" 2>&1)
# Deliberately NOT asserting a bare `grep -q "WARNING"` here on its own:
# QA1 round 1 found that assertion still passes even with
# state_divergence_warning() fully dead, because worktree_divergence_warning()
# (sprint 13's own sprint-FILE check) happens to ALSO fire on this exact
# incident, since /sprint-complete changes the sprint file's frontmatter
# too -- see state_divergence_warning()'s own docstring. Asserting the
# PHASE and the worktree PATH below is what actually pins the new code,
# since sprint 13's own warning never mentions either.
echo "$STATUS_STATE_OUT" | grep -q "phase 'complete'" || \
  fail "status <id>'s state-divergence warning doesn't name the other tree's phase -- output: $STATUS_STATE_OUT"
echo "$STATUS_STATE_OUT" | grep -qF "$(basename "$STATE_WT_DIR")" || \
  fail "status <id>'s state-divergence warning doesn't name the diverging worktree's path"

$SCRIPT list 2>&1 | grep -E "^ *${SPRINT_STATE_WT} " -A1 | grep -q "WARNING" || \
  fail "list did not surface the stranded close next to the sprint it applies to (Req 2)"
$SCRIPT status 2>&1 | grep -F "Sprint ${SPRINT_STATE_WT}:" -A1 | grep -q "WARNING" || \
  fail "status with no id did not surface the stranded close (Req 2)"

git worktree remove --force "$STATE_WT_DIR" > /dev/null 2>&1 || rm -rf "$STATE_WT_DIR"
rm -f /tmp/state_wt_user_said.txt

echo "== sprint 29, Req 1/2 (QA1 round 1 finding): the worktree-created-BEFORE-start order -- this tree never has a state file at all for the sprint's entire life =="
# CLAUDE.md's own documented order for Dev Team 2: create the sprint,
# then /sprint-worktree "before Dev Team 2 starts building", THEN start
# there. cmd_new writes a registry entry and no state file; cmd_start
# writes the state file wherever it runs -- so under this order, THIS
# tree never has a local state file for this sprint at all, the exact
# path state_divergence_warning()'s original early return silently
# swallowed (QA1 round 1: reproduced end to end, isolated to
# scripts/sprint_lifecycle.py's own early `if not this_state_path.exists():
# return None`, before the registry comparison ever ran).
SPRINT_WT_FIRST=$(new_sprint "Worktree-created-first sprint")
git add -A
git commit -q -m "commit sprint $SPRINT_WT_FIRST's registry entry (no state file yet -- not started here)"

WT_FIRST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fully-completely-smoke-wt-first.XXXXXX")"
git worktree add -q -b smoke-wt-first-branch "$WT_FIRST_DIR" > /dev/null
WT_FIRST_SCRIPT="python3 $WT_FIRST_DIR/scripts/sprint_lifecycle.py"

# Everything -- start through complete -- happens ONLY in the worktree.
# This tree (main) never runs /sprint-start for this sprint at all.
$WT_FIRST_SCRIPT start "$SPRINT_WT_FIRST" > /dev/null
(cd "$WT_FIRST_DIR" && git commit -q --allow-empty -m "sprint $SPRINT_WT_FIRST work")
$WT_FIRST_SCRIPT qa1 "$SPRINT_WT_FIRST" --verdict PASS --notes ok > /dev/null
$WT_FIRST_SCRIPT dev-done "$SPRINT_WT_FIRST" > /dev/null
WT_FIRST_COMMIT=$(cd "$WT_FIRST_DIR" && git rev-parse HEAD)
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=green $WT_FIRST_SCRIPT ship "$SPRINT_WT_FIRST" --commit "$WT_FIRST_COMMIT" > /dev/null
$WT_FIRST_SCRIPT liveqa "$SPRINT_WT_FIRST" --deployed-commit "$WT_FIRST_COMMIT" --verdict PASS --notes ok > /dev/null
printf 'closing for the worktree-first test\n' > /tmp/wt_first_user_said.txt
$WT_FIRST_SCRIPT complete "$SPRINT_WT_FIRST" --user-said-file /tmp/wt_first_user_said.txt > /dev/null

# Confirm the test's own premise: main genuinely has no state file for
# this sprint, ever, not just "hasn't been read yet".
[ -f "docs/sprints/state/sprint-${SPRINT_WT_FIRST}.json" ] && \
  fail "test setup: this tree should have NO state file for this sprint (it was never /sprint-start'ed here)"

$SCRIPT list 2>&1 | grep -E "^ *${SPRINT_WT_FIRST} " -A1 | grep -q "WARNING" || \
  fail "list did not surface a sprint closed in a worktree that was never started here (QA1 round 1 finding)"
$SCRIPT status 2>&1 | grep -F "Sprint ${SPRINT_WT_FIRST}:" -A1 | grep -q "WARNING" || \
  fail "status with no id did not surface a sprint closed in a worktree that was never started here (QA1 round 1 finding)"

STATUS_WT_FIRST_OUT=$($SCRIPT status "$SPRINT_WT_FIRST" 2>&1) && \
  fail "status <id> should refuse (no local state file exists here at all) -- it succeeded instead"
echo "$STATUS_WT_FIRST_OUT" | grep -qi "run /sprint-start" && \
  fail "status <id>'s refusal still tells the reader to start a sprint that's already been closed elsewhere -- the exact misleading message QA1 flagged"
echo "$STATUS_WT_FIRST_OUT" | grep -q "exists in 1 other worktree" || \
  fail "status <id>'s refusal doesn't name that the sprint exists elsewhere -- output: $STATUS_WT_FIRST_OUT"
echo "$STATUS_WT_FIRST_OUT" | grep -q "phase 'complete'" || \
  fail "status <id>'s refusal doesn't name the other tree's phase -- output: $STATUS_WT_FIRST_OUT"

git worktree remove --force "$WT_FIRST_DIR" > /dev/null 2>&1 || rm -rf "$WT_FIRST_DIR"
rm -f /tmp/wt_first_user_said.txt

echo "== sprint 29, Req 1/2: identical state across trees produces no warning, on status (both forms) and list =="
SPRINT_STATE_CLEAN=$(new_sprint "State agreement sprint")
$SCRIPT start "$SPRINT_STATE_CLEAN" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_STATE_CLEAN work"
$SCRIPT qa1 "$SPRINT_STATE_CLEAN" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_STATE_CLEAN" > /dev/null
git add -A
git commit -q -m "commit sprint $SPRINT_STATE_CLEAN's state so a second worktree starts from an identical copy"

STATE_CLEAN_WT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fully-completely-smoke-state-clean-wt.XXXXXX")"
git worktree add -q -b smoke-state-clean-wt-branch "$STATE_CLEAN_WT_DIR" > /dev/null

$SCRIPT status "$SPRINT_STATE_CLEAN" 2>&1 | grep -q "WARNING" && \
  fail "status <id> warned about state divergence when the other worktree's state is genuinely identical"
$SCRIPT list 2>&1 | grep -E "^ *${SPRINT_STATE_CLEAN} " -A1 | grep -q "WARNING" && \
  fail "list warned about state divergence when the other worktree's state is genuinely identical"
$SCRIPT status 2>&1 | grep -F "Sprint ${SPRINT_STATE_CLEAN}:" -A1 | grep -q "WARNING" && \
  fail "status with no id warned about state divergence when the other worktree's state is genuinely identical"

git worktree remove --force "$STATE_CLEAN_WT_DIR" > /dev/null 2>&1 || rm -rf "$STATE_CLEAN_WT_DIR"

echo "== sprint 29, Req 3: a branch tip moving off last_shipped_commit during liveqa_live is detected and the landed commit is named, including a docs-only push =="
SPRINT_TIPMOVE=$(new_sprint "Tip move sprint")
$SCRIPT start "$SPRINT_TIPMOVE" > /dev/null
git commit -q --allow-empty -m "sprint $SPRINT_TIPMOVE work"
$SCRIPT qa1 "$SPRINT_TIPMOVE" --verdict PASS --notes ok > /dev/null
$SCRIPT dev-done "$SPRINT_TIPMOVE" > /dev/null
TIPMOVE_COMMIT=$(git rev-parse HEAD)
PATH="$FAKE_GH_DIR:$PATH" FAKE_GH_MODE=green $SCRIPT ship "$SPRINT_TIPMOVE" --commit "$TIPMOVE_COMMIT" > /dev/null
git push -q origin HEAD:main

# A push touching ONLY docs/sprints/ -- inside sprint 13's own
# SHIP_HASH_EXCLUDE_PATTERNS, so no content-based comparison anywhere
# could ever see this land. This is Finding B's own motivating incident
# (commit 4d67199, touching only docs/sprints/1-todo/... and
# registry.json), reproduced directly rather than assumed equivalent.
echo "placeholder" > "docs/sprints/1-todo/tipmove-placeholder-${SPRINT_TIPMOVE}.md"
git add "docs/sprints/1-todo/tipmove-placeholder-${SPRINT_TIPMOVE}.md"
git commit -q -m "docs-only bookkeeping landing during sprint ${SPRINT_TIPMOVE}'s live gate"
TIPMOVE_DOCS_COMMIT=$(git rev-parse HEAD)
git push -q origin HEAD:main

LIVEQA_TIPMOVE_OUT=$($SCRIPT liveqa "$SPRINT_TIPMOVE" --deployed-commit "$TIPMOVE_COMMIT" --verdict PASS --notes ok 2>&1) || \
  fail "liveqa refused (or failed) solely because the branch tip moved during the live gate -- Req 3 must never gate on this -- output: $LIVEQA_TIPMOVE_OUT"
echo "$LIVEQA_TIPMOVE_OUT" | grep -q "carries 1 commit beyond this sprint's own recorded last_shipped_commit" || \
  fail "liveqa did not detect the branch tip moving off last_shipped_commit during the live gate (Req 3) -- output: $LIVEQA_TIPMOVE_OUT"
echo "$LIVEQA_TIPMOVE_OUT" | grep -qF "${TIPMOVE_DOCS_COMMIT:0:7}" || \
  fail "liveqa's tip-move warning doesn't name the actual commit that landed (Req 3: 'say which commits landed since') -- output: $LIVEQA_TIPMOVE_OUT"
rm -f "docs/sprints/1-todo/tipmove-placeholder-${SPRINT_TIPMOVE}.md"

echo "== sprint 33, Req 2: abort refuses with no --user-said, before any state or file mutation, and names /sprint-block as the alternative =="
SPRINT_ABORT=$(new_sprint "Abort gate sprint")
$SCRIPT start "$SPRINT_ABORT" > /dev/null
$SCRIPT abort "$SPRINT_ABORT" --reason "no real content exists" \
  > /tmp/out.txt 2>&1 && fail "abort succeeded with no --user-said -- Req 2 must refuse, no override" || true
grep -q "\-\-user-said is required and must be non-empty" /tmp/out.txt || fail "abort's missing-user-said refusal message is missing"
grep -qF "/sprint-block ${SPRINT_ABORT} --reason" /tmp/out.txt || fail "abort's refusal doesn't name /sprint-block as the alternative (Req 5)"
$SCRIPT status "$SPRINT_ABORT" 2>&1 | grep -q "Phase: dev_build" || fail "a refused abort must not have mutated state"
ABORT_REFUSED_FILE=$(python3 -c "import json; print(json.load(open('docs/sprints/registry.json'))['sprints']['${SPRINT_ABORT}']['file'])")
echo "$ABORT_REFUSED_FILE" | grep -q "2-in-progress/" || fail "a refused abort must not have moved the sprint file -- got: $ABORT_REFUSED_FILE"
[ -f "$ABORT_REFUSED_FILE" ] || fail "the registry's recorded file path doesn't exist on disk after a refused abort: $ABORT_REFUSED_FILE"
rm -f /tmp/out.txt

echo "== sprint 33, Req 3: abort refuses with --user-said but no --reason -- '(none given)' can no longer be produced =="
$SCRIPT abort "$SPRINT_ABORT" --user-said "yes, abandon it" \
  > /tmp/out.txt 2>&1 && fail "abort succeeded with no --reason -- Req 3 must refuse" || true
grep -q "\-\-reason is required and must be non-empty" /tmp/out.txt || fail "abort's missing-reason refusal message is missing"
rm -f /tmp/out.txt

echo "== sprint 33, Req 1: a successful abort records the REAL actor, never the hardcoded 'human' =="
CLAUDE_CODE_AGENT="dev-team-1" $SCRIPT abort "$SPRINT_ABORT" --user-said "yes, abandon it" --reason "no real content exists" \
  > /tmp/out.txt 2>&1 || fail "abort with both arguments present should have succeeded -- output: $(cat /tmp/out.txt)"
grep -q "none given" /tmp/out.txt && fail "'(none given)' must no longer be producible (Req 3)"
python3 -c "
import json
state = json.load(open('docs/sprints/state/sprint-${SPRINT_ABORT}.json'))
last = state['history'][-1]
assert last['event'] == 'aborted', f'expected an aborted event, got {last}'
assert last['actor'] == 'dev-team-1', f'actor must be the real CLAUDE_CODE_AGENT value, not \"human\": {last}'
"
$SCRIPT status "$SPRINT_ABORT" 2>&1 | grep -q "Phase: dev_build" && fail "abort should have moved the sprint out of dev_build"
rm -f /tmp/out.txt

echo "== sprint 33, Req 4: block refuses with no --reason, and requires no --user-said (non-destructive) =="
SPRINT_BLOCK=$(new_sprint "Block sprint")
$SCRIPT start "$SPRINT_BLOCK" > /dev/null
$SCRIPT block "$SPRINT_BLOCK" \
  > /tmp/out.txt 2>&1 && fail "block succeeded with no --reason -- must refuse" || true
grep -q "\-\-reason is required and must be non-empty" /tmp/out.txt || fail "block's missing-reason refusal message is missing"
rm -f /tmp/out.txt

echo "== sprint 33, Req 4: block returns the sprint to the planner -- id preserved, never moved to 5-abandoned, analysis retrievable, real actor recorded =="
CLAUDE_CODE_AGENT="qa1" $SCRIPT block "$SPRINT_BLOCK" --reason "cards.json content does not exist yet, cannot build without it" \
  > /tmp/out.txt 2>&1 || fail "block with a real reason should have succeeded -- output: $(cat /tmp/out.txt)"
grep -q "returned to the planner" /tmp/out.txt || fail "block's success message is missing"
grep -q "cards.json content does not exist" /tmp/out.txt || fail "block's success output doesn't echo the analysis"

BLOCK_FILE=$(python3 -c "import json; print(json.load(open('docs/sprints/registry.json'))['sprints']['${SPRINT_BLOCK}']['file'])")
echo "$BLOCK_FILE" | grep -q "4-blocked/" || fail "block did not move the file to docs/sprints/4-blocked/ -- got: $BLOCK_FILE"
echo "$BLOCK_FILE" | grep -q "5-abandoned" && fail "block must never move anything to 5-abandoned"
[ -f "$BLOCK_FILE" ] || fail "the registry's recorded file path doesn't actually exist on disk: $BLOCK_FILE"

python3 -c "
import json
reg = json.load(open('docs/sprints/registry.json'))
entry = reg['sprints']['${SPRINT_BLOCK}']
assert entry['status'] == 'blocked', f'registry status must be blocked, not: {entry[\"status\"]}'
assert entry['status'] != 'abandoned'
state = json.load(open('docs/sprints/state/sprint-${SPRINT_BLOCK}.json'))
assert state['phase'] == 'blocked', f'phase must be blocked: {state}'
assert state['id'] == ${SPRINT_BLOCK}, 'sprint id must be preserved'
last = state['history'][-1]
assert last['event'] == 'blocked', f'expected a blocked event: {last}'
assert last['actor'] == 'qa1', f'actor must be the real CLAUDE_CODE_AGENT value: {last}'
assert 'cards.json content does not exist' in last['detail'], f'analysis must be recorded in history: {last}'
"

BLOCK_STATUS_OUT=$($SCRIPT status "$SPRINT_BLOCK" --verbose 2>&1)
echo "$BLOCK_STATUS_OUT" | grep -q "cards.json content does not exist" || \
  fail "the stated analysis must be retrievable from /sprint-status --verbose alone (Req 4's own LiveQA criterion) -- output: $BLOCK_STATUS_OUT"
rm -f /tmp/out.txt

echo "== sprint 33, Req 6: re-filing a blocked sprint is /sprint-start again, with no special handling =="
$SCRIPT start "$SPRINT_BLOCK" > /tmp/out.txt 2>&1 || fail "re-starting a blocked sprint should succeed like any other start -- output: $(cat /tmp/out.txt)"
python3 -c "
import json
reg = json.load(open('docs/sprints/registry.json'))
entry = reg['sprints']['${SPRINT_BLOCK}']
assert entry['status'] == 'in_progress', f'restarted sprint should be in_progress: {entry[\"status\"]}'
assert '2-in-progress/' in entry['file'], f'restarted sprint file should be back in 2-in-progress/: {entry[\"file\"]}'
state = json.load(open('docs/sprints/state/sprint-${SPRINT_BLOCK}.json'))
assert state['phase'] == 'dev_build', f'restarted sprint should be back in dev_build: {state[\"phase\"]}'
"
rm -f /tmp/out.txt

echo "ALL SMOKE TESTS PASSED"
