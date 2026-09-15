'use strict';
// Sprint 25, Req 1: a best-effort, warn-only record of which role most
// recently launched in this tree -- explicitly NOT a lease. Rejected on
// reasoning both this project and the downstream consumer who reported the
// collision agreed on: a lease goes stale the moment a session crashes or
// is killed without a clean exit, and a session can start outside this
// launcher entirely (a human running `claude` directly, some other tool),
// so any record here is incomplete by construction -- an incomplete record
// presented as authoritative ("nobody else is working here") is exactly
// the confidently-wrong failure mode this whole project exists to remove.
// What this file actually provides: the single fact "a claim for this role
// was most recently recorded at this timestamp, by this session" -- read,
// warn, and move on. The reader decides whether that timestamp means
// anything; this file never tries to.
//
// Deliberately per-ROLE, not per-sprint: the reported collision (two Dev
// Team 1 sessions building the same sprint concurrently) was a role-in-
// tree collision, not a sprint-specific one -- the same role launched
// twice is the shape that matters here, regardless of which sprint either
// session happens to be working. A sprint-level record is Req 2's own,
// separate question, answered in scripts/sprint_lifecycle.py.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Sprint 25, Req 3: stated here, in code, not only in the sprint file --
// four separate comments in this project have had to be corrected for
// claiming more coverage than the evidence supported (see run-role.js's
// own history: the redirect-confinement claim, the "directory
// confinement" phrase, the CLI-argv-greedy hazard, the permission-
// findings "survived unchanged" claim). Named plainly so this is not the
// fifth: this module can only ever see launches that went through
// recordRoleClaim() below, i.e. launches that went through run-role.js
// itself. A session started directly via `claude`, or through any other
// tool, writes nothing here and is completely invisible to it. It also
// only ever sees LAUNCH TIME -- the moment this function runs, before the
// session does anything else. The actual collision this sprint was
// reported against happened DURING a build, with no lifecycle command and
// no new launch in between; this record could not have caught that
// moment and does not claim to. It surfaces the conflict at the NEXT
// launch or the next command that reads it, never at the first keystroke
// of the second session's own edits.
const CLAIMS_RELATIVE_PATH = path.join('.claude', 'role-claims.json');

// FULLY_COMPLETELY_ROLE_CLAIMS_PATH_OVERRIDE: an explicit escape hatch,
// checked first, for exactly one purpose -- this project's own test suite
// runs many real, separate `run-role.js` subprocess invocations against
// this repo's own real tree (see launcher_test.js's runRoleCli()), and
// without this override every one of those runs would share a single
// real `.claude/role-claims.json`, so the SECOND test to launch any given
// role would see the FIRST test's claim and print a warning neither test
// expects or wants -- polluting this repo's own real working tree with
// real test artifacts in the process. runRoleCli() sets this to a fresh
// scratch path per invocation specifically to prevent that. Not read
// anywhere else in this module's own logic; a real launch never sets it
// and always resolves the path from repoRoot below, exactly as if this
// override didn't exist.
function claimsFilePath(repoRoot) {
  if (process.env.FULLY_COMPLETELY_ROLE_CLAIMS_PATH_OVERRIDE) {
    return process.env.FULLY_COMPLETELY_ROLE_CLAIMS_PATH_OVERRIDE;
  }
  return path.join(repoRoot, CLAIMS_RELATIVE_PATH);
}

function readClaims(repoRoot) {
  try {
    const raw = fs.readFileSync(claimsFilePath(repoRoot), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    // Missing file, unreadable, or not valid JSON -- every one of those
    // means "no claims recorded yet," never a crash. This is advisory
    // bookkeeping, not a gate; it must never be the reason a launch fails.
    return {};
  }
}

// Records that `roleId` is launching now, in `repoRoot`, returning
// whatever claim existed for that role BEFORE this call (or null if none
// did) so the caller can decide what to print. `sessionId` is caller-
// supplied rather than generated in here, so a caller with a real,
// already-computed identifier (the interactive path's own deterministic
// UUIDv5 from session.js) can pass that instead of a second, unrelated
// one -- this function only ever records whatever identity it's given,
// it does not mint identity itself except via the `nowFn`/id fallback a
// caller can also override for tests.
//
// Sprint 38, Req 1: also records `pid` (the CALLING process's own pid --
// run-role.js's own launcher process, not the `claude` child it goes on
// to spawn) -- `roleClaimWarning()` below reads this back on the NEXT
// launch to determine whether the previous session has demonstrably
// ended. Defaults to `process.pid`, overridable (like `now`) so a test
// can record an already-known, controlled pid instead of this process's
// own.
function recordRoleClaim(roleId, repoRoot, { sessionId, now = () => new Date(), pid = process.pid } = {}) {
  const claims = readClaims(repoRoot);
  const previous = Object.prototype.hasOwnProperty.call(claims, roleId) ? claims[roleId] : null;
  claims[roleId] = { sessionId: sessionId || null, startedAt: now().toISOString(), pid };
  try {
    const file = claimsFilePath(repoRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(claims, null, 2) + '\n');
  } catch (_) {
    // Sprint 25, Req 1's own "it warns; it never gates" -- a write
    // failure (read-only filesystem, permissions, disk full) must never
    // block a launch. The launch proceeds either way; only the record of
    // it may be missing this once.
  }
  return previous;
}

// Sprint 38, Req 1/1a/1b: whether `pid` demonstrably still refers to a
// running process, as a real, observable fact -- not a guess, and never
// a lease that goes stale on its own. Returns:
//   true  -- the process genuinely still exists and is running.
//   false -- POSITIVELY confirmed gone. The only value that may ever
//            suppress the NOTE (Req 1a: absence of the NOTE must rest on
//            a positive determination, never an assumption).
//   null  -- undeterminable (no pid recorded at all -- Req 1c's own
//            0.2.10-and-earlier record shape; a check that can't be
//            performed on this platform; any unexpected failure). Every
//            null MUST be treated as "still running" by the caller --
//            this is what keeps 1a's own promise: an old-format or
//            unreadable record still warns, exactly as it did before
//            this sprint.
//
// ESTABLISHED BY RUNNING (Req 1b's own explicit instruction), on macOS,
// not assumed from POSIX signal semantics in the abstract:
//   - `process.kill(pid, 0)` is the standard existence probe (throws
//     ESRCH when truly gone, EPERM when it exists but is owned by
//     someone else -- still running either way) -- confirmed directly:
//     spawn a real child, confirm no throw while it runs, SIGKILL it,
//     confirm ESRCH shortly after.
//   - THE REAL HAZARD, found by running it, not by reasoning about
//     kill(2): `process.kill(pid, 0)` CANNOT tell a genuinely-running
//     process apart from a ZOMBIE (already exited, only awaiting reap by
//     its own parent) -- confirmed directly: SIGKILL a real child, then
//     immediately probe with `process.kill(child.pid, 0)` before the
//     event loop has reaped it -- no throw, indistinguishable from
//     alive. `ps -o stat= -p <pid>` reports state `Z` for that exact
//     process at that exact moment, which `kill(pid, 0)` alone has no
//     way to see. A launcher that has just exited (including via the
//     orphan guard's own SIGTERM/SIGHUP handling in run-role.js, which
//     DOES run in exactly the terminal-close/trash-can shutdown path
//     Req 1 targets -- confirmed directly with a real pseudo-terminal,
//     `pty.fork()`, closing the master side to simulate a VS Code
//     terminal disposing its pty: both the launcher and its child
//     process were gone within about a second, the launcher passing
//     through a zombie state first) would otherwise be misread as
//     "still running" by kill(pid,0) alone for as long as its own parent
//     takes to reap it -- exactly the false-positive direction Req 1
//     exists to fix, not the dangerous one, but real enough that this
//     function checks for it explicitly rather than leaving it to chance.
//   - Windows has no POSIX zombie state at all (a terminated process is
//     simply gone once nothing holds its handle open), so the extra `ps`
//     check below is POSIX-only, skipped entirely on win32 -- NOT
//     independently measured on Windows in this session; `process.kill`
//     signal-0 existence checking is Node's own documented cross-platform
//     behaviour, not this project's own finding, and LiveQA's own Req 1
//     live criteria for this sprint specifically re-confirms it there
//     (`Get-Process` state at each step) rather than this comment simply
//     asserting it holds.
//   - A residual, named limitation, not implied coverage: a `kill -9
//     <launcher-pid>` aimed at ONLY the launcher's specific pid (not
//     through a terminal's process-group signalling, which the pty test
//     above confirms reaches both processes together) bypasses the
//     orphan guard entirely -- SIGKILL cannot be caught by any process,
//     the same limitation run-role.js's own installOrphanGuard comment
//     already names -- and can leave the child genuinely orphaned and
//     running while the launcher's own pid is gone. This function would
//     read that as "not running" and the NOTE would be wrongly
//     suppressed in that one specific, already out-of-normal-control
//     scenario (this project's own established position, stated in
//     run-role.js, is that a targeted SIGKILL to the launcher is outside
//     what cleanup code can ever guarantee). Not the F6 workshop
//     scenario (trash-can, Terminate All Tasks), which goes through the
//     terminal/process-group path this function correctly detects.
function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err && err.code === 'ESRCH') return false;
    if (err && err.code === 'EPERM') return true;
    return null;
  }
  if (process.platform === 'win32') return true;
  let ps;
  try {
    ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
  } catch (_) {
    return reprobeAfterUnusablePs(pid);
  }
  if (ps.error) return reprobeAfterUnusablePs(pid);
  const stat = (ps.stdout || '').trim();
  if (ps.status !== 0 || !stat) {
    // QA1 round 1 FINDING, FIXED HERE: this used to collapse straight to
    // `false` ("gone by the time ps checked") the instant `ps` gave back
    // anything other than a usable STAT column -- but a non-zero ps exit
    // does NOT always mean the pid is gone; it can just as easily mean
    // this platform's `ps` cannot answer the question at all. Demonstrated
    // directly: BusyBox ps (Alpine and many slim containers/devcontainers)
    // has no `-p` flag -- `ps -o stat= -p <pid>` against a REAL, currently
    // running process prints BusyBox's own usage text and exits 1, the
    // exact shape this branch used to read as "confirmed gone". Running
    // the real code with a `ps` shimmed to behave the same way reproduced
    // it end to end: process.kill(pid,0) correctly said the process was
    // running, and this function still returned `false`, silencing the
    // NOTE for a session that was genuinely still alive -- precisely the
    // dangerous direction Req 1a forbids ("every undeterminable branch
    // falls through to the NOTE"). Fixed by never trusting a `ps` that
    // couldn't answer: re-probe existence directly instead of guessing
    // from `ps`'s own failure.
    return reprobeAfterUnusablePs(pid);
  }
  return !stat.startsWith('Z');
}

// Called only when `ps` itself could not be trusted (missing, erroring, or
// -- BusyBox's own shape -- simply incompatible with the flags used
// above), immediately after `process.kill(pid, 0)` already succeeded once.
// Re-probes existence directly rather than guessing from `ps`'s own
// failure: if the process has genuinely exited in the brief window since
// the first probe, THIS probe will now correctly see ESRCH (a real, fresh
// fact, not a stale one) and return `false`; any other outcome (still
// alive, or a probe that itself can't answer) returns `null` -- Req 1a's
// own "undeterminable still warns" rule, never a guessed `false`.
function isPidAliveRaw(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return false;
    return null;
  }
}
function reprobeAfterUnusablePs(pid) {
  const result = isPidAliveRaw(pid);
  return result === false ? false : null;
}

// Sprint 25, Req 1's own required wording: names the blind spot in the
// message itself, not only in a code comment nobody launching a role will
// ever read. Returns null (nothing to print) when there is no previous
// claim to warn about -- the common, correct case for a role's first
// launch in a tree.
//
// Sprint 38, Req 1: also returns null -- suppressing the NOTE -- when
// `previousClaim.pid` is POSITIVELY confirmed no longer running
// (isPidAlive() returns exactly `false`). Every other outcome (still
// running, or undeterminable -- an old-format record with no `pid` at
// all, or a platform/check failure) still prints the identical wording
// this function always has: Req 1a's own instruction is that absence of
// the NOTE must never be inferred from anything less than a positive
// determination, and the existing wording about what this record cannot
// see already states that honestly -- it does not need new wording for
// the undeterminable case, only to keep firing in it.
function roleClaimWarning(roleLabel, previousClaim) {
  if (!previousClaim) return null;
  if (isPidAlive(previousClaim.pid) === false) return null;
  return (
    `NOTE: another ${roleLabel} session was recorded starting at ` +
    `${previousClaim.startedAt} in this same tree${previousClaim.sessionId ? ` (session ${previousClaim.sessionId})` : ''}. ` +
    'This may be exactly what you intended (a second, deliberately separate session on a ' +
    'different sprint, or a session someone restarted) or a genuine collision -- this record ' +
    'only sees launches that went through this script, and only at the moment of launch, so a ' +
    'session started another way, or a collision that began mid-build with no new launch, is ' +
    'invisible to it. Silence never means "nobody else is working here." Launching anyway -- ' +
    'this never blocks.'
  );
}

module.exports = {
  CLAIMS_RELATIVE_PATH,
  claimsFilePath,
  readClaims,
  recordRoleClaim,
  roleClaimWarning,
  isPidAlive,
};
