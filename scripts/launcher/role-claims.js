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

// Sprint 38 fix round (LiveQA round 1 finding): FC: Start All launches
// all six roles at essentially the same instant, each independently
// read-modify-writing the SAME .claude/role-claims.json with no
// coordination at all. Confirmed live and in scratch installs: launching
// six roles concurrently loses 3-5 of the 6 claim records on both 0.2.11
// and 0.2.12 (the last writer's own full read-then-write silently
// discards whatever any OTHER concurrent writer had already saved,
// classic lost-update). On 0.2.11 this was cosmetic (a surviving STALE
// record still fired the NOTE unconditionally, so losing records only
// ever produced FEWER warnings, never a wrong one). Sprint 38's own Req 1
// changed that: a record now gets read for pid liveness, so a role whose
// record was overwritten with someone ELSE's now-dead pid (or simply
// missing) reads as "the previous session has ended" even while THAT
// role's own current session is genuinely running -- exactly the
// dangerous silencing direction Req 1a exists to forbid, now reachable
// through ordinary concurrent use, not a contrived edge case.
//
// FIX: an exclusive, atomic file lock around the whole read-modify-write,
// using `fs.openSync(lockPath, 'wx')` -- O_CREAT|O_EXCL on POSIX,
// CREATE_NEW on Windows -- a well-established, dependency-free,
// genuinely cross-platform mutual-exclusion primitive (no native addon,
// no new package; this project's own established preference). A holder
// that crashes or is killed before releasing leaves the lock file behind
// forever otherwise, so a lock older than LOCK_STALE_MS is treated as
// abandoned and stolen -- generous compared to how fast the actual
// critical section runs (read one small JSON file, mutate one key,
// write it back), short enough that a genuinely crashed holder never
// blocks the others for long. Bounded overall wait (LOCK_MAX_WAIT_MS):
// this function must never hang a launch indefinitely -- Sprint 25's own
// "it warns; it never gates" extends to blocking, not only to write
// failure, so giving up and proceeding UNLOCKED (same risk as before this
// fix, not a new one) is the correct failure mode over hanging forever.
// `Atomics.wait` on a throwaway SharedArrayBuffer is a genuine, CPU-idle
// synchronous sleep -- confirmed directly, no native dependency -- used
// instead of a busy-spin while retrying, since this function's own
// call site (run-role.js's synchronous preflight, before any async work
// begins) has no access to `await`.
const LOCK_SUFFIX = '.lock';
const LOCK_STALE_MS = 10000;
const LOCK_MAX_WAIT_MS = 3000;
const LOCK_RETRY_INTERVAL_MS = 20;

function syncSleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    // Atomics.wait can refuse to run on the main thread in some
    // embeddings -- if so, fall through immediately rather than throw;
    // the retry loop above still bounds total wait time either way.
  }
}

// Returns the lock path on success (pass it to releaseClaimsLock when
// done), or null if the lock could not be acquired within
// LOCK_MAX_WAIT_MS or for any other reason (permissions, a filesystem
// that doesn't support exclusive create, etc.) -- callers proceed
// WITHOUT the lock in that case, exactly as unprotected as this file was
// before this fix, never blocking or failing the launch over it.
function acquireClaimsLock(repoRoot) {
  const lockPath = claimsFilePath(repoRoot) + LOCK_SUFFIX;
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      const fd = fs.openSync(lockPath, 'wx');
      fs.closeSync(fd);
      return lockPath;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return null; // some other failure -- don't block on it
      try {
        const beforeStat = fs.statSync(lockPath);
        const age = Date.now() - beforeStat.mtimeMs;
        if (age > LOCK_STALE_MS) {
          // QA1 live-loop finding (round 2): a plain `unlinkSync` here
          // raced with ANOTHER process also stealing the same stale
          // lock -- both could compute `age > LOCK_STALE_MS` from the
          // same stale stat(), then one unlinks and re-creates its own
          // fresh lock, and the other's later, unconditional unlink
          // deletes that freshly-created lock out from under its
          // rightful holder.
          //
          // QA1 live-loop finding (round 3): swapping the unlink for a
          // `renameSync` onto a per-process-unique path, on its own,
          // does NOT actually close this -- confirmed by QA1 directly,
          // by interleaving two real `acquireClaimsLock` calls. `rename`
          // is atomic in the sense that only one caller's rename can
          // succeed against a given SOURCE PATH at a given instant, but
          // it has no idea WHICH FILE is at that path when it runs: the
          // staleness decision above is made from a stat() taken before
          // the rename, and by the time the rename actually executes,
          // some OTHER process may have already completed its own full
          // steal-and-recreate cycle at this exact path -- meaning our
          // rename call still "succeeds", but it just moved away that
          // other process's brand-new, legitimately-held lock, not the
          // stale one we actually staleness-checked. THE FIX: verify,
          // after the rename, that the file we actually moved is still
          // the SAME one this attempt staleness-checked -- inode identity
          // (stable across a same-filesystem rename, and never coincides
          // between two different files a filesystem hands out at
          // meaningfully close times) is the real guarantee here; mtime
          // is compared too only as cheap corroboration. A mismatch means
          // we grabbed someone else's fresh lock by accident: put it back
          // exactly where it was and retry from scratch, never treating
          // this as a successful acquisition.
          const stolenPath = `${lockPath}.stolen-${process.pid}-${Date.now()}`;
          try {
            fs.renameSync(lockPath, stolenPath);
          } catch (_) {
            continue; // someone else already claimed it -- try openSync('wx') again
          }
          let afterStat;
          try {
            afterStat = fs.statSync(stolenPath);
          } catch (_) {
            continue; // vanished already -- try again
          }
          const sameFile = afterStat.ino === beforeStat.ino && afterStat.mtimeMs === beforeStat.mtimeMs;
          if (!sameFile) {
            try {
              fs.renameSync(stolenPath, lockPath); // hand it back to its rightful holder
            } catch (_) {
              // Couldn't restore it (already gone, or the path is now
              // occupied by yet another fresh lock) -- nothing more this
              // attempt can safely do; either way, we acquired nothing.
            }
            continue;
          }
          try {
            fs.unlinkSync(stolenPath);
          } catch (_) {
            // Already gone -- nothing left to clean up.
          }
          continue;
        }
      } catch (_) {
        continue; // the lock vanished between EEXIST and stat -- try again
      }
      if (Date.now() >= deadline) return null;
      syncSleep(LOCK_RETRY_INTERVAL_MS);
    }
  }
}

function releaseClaimsLock(lockPath) {
  if (!lockPath) return;
  try {
    fs.unlinkSync(lockPath);
  } catch (_) {
    // Already gone (e.g. raced with a staleness steal from another
    // process) -- nothing left to clean up.
  }
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

// Sprint 38, second fix round (QA1 live-loop finding): a stored claim
// used to be ONE object per role, unconditionally overwritten by every
// new launch -- which meant a role's record could only ever remember its
// single MOST RECENT launch, never an earlier one that might still be
// running. Real repro QA1 found: launch A (still running); launch B while
// A is up (correctly warns, then B itself exits); launch C, with A
// CONFIRMED still alive -- no warning, because B's own now-dead pid had
// already silently replaced A's still-live record the moment B launched.
// That's an ordinary duplicate-tab-then-relaunch sequence, not a contrived
// edge case, and it's exactly the silencing direction Req 1a forbids,
// reached a second way.
//
// FIX: a role's claims are now a LIST, not a single record. Every launch
// prunes only the entries POSITIVELY confirmed gone (the identical bar
// Req 1a already sets for warning -- an undeterminable entry is kept,
// never discarded on a guess) and appends its own new claim, so a still-
// running earlier launch's record survives a later launch's own claim
// being written, and is only ever dropped once IT is confirmed to have
// exited. `normalizeClaimList` reads a pre-0.2.13 single-object record (or
// a bare object passed directly by a caller/test) as a one-element list,
// so an existing role-claims.json from an older install, and every
// existing single-object call site in this project's own test suite,
// both keep working unchanged.
function normalizeClaimList(raw) {
  if (Array.isArray(raw)) return raw.filter((c) => c && typeof c === 'object');
  if (raw && typeof raw === 'object') return [raw];
  return [];
}

// Whether `claim` carries a pid this file could ever actually check again
// later -- the exact same numeric/positive-integer test isPidAlive() itself
// applies before it will even attempt a probe. A pre-0.2.13 record has no
// `pid` key at all (0.2.10/0.2.11's own shape), so isPidAlive() on it can
// only ever return `null` (undeterminable) -- FOREVER, not just on this one
// check -- since there is no pid to ever positively confirm as gone. See
// recordRoleClaim's own comment for why that distinction matters.
function hasTrackablePid(claim) {
  const pid = claim && claim.pid;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

// Records that `roleId` is launching now, in `repoRoot`, returning every
// PRIOR claim for that role not yet confirmed to have exited (see
// normalizeClaimList's own comment above) so the caller can decide what to
// print -- an empty array when none survive, including a role's first-
// ever launch. `sessionId` is caller-supplied rather than generated in
// here, so a caller with a real, already-computed identifier (the
// interactive path's own deterministic UUIDv5 from session.js) can pass
// that instead of a second, unrelated one -- this function only ever
// records whatever identity it's given, it does not mint identity itself
// except via the `nowFn`/id fallback a caller can also override for tests.
//
// Sprint 38, Req 1: also records `pid` (the CALLING process's own pid --
// run-role.js's own launcher process, not the `claude` child it goes on
// to spawn) -- `roleClaimWarning()` below reads this back on the NEXT
// launch to determine whether the previous session has demonstrably
// ended. Defaults to `process.pid`, overridable (like `now`) so a test
// can record an already-known, controlled pid instead of this process's
// own.
function recordRoleClaim(roleId, repoRoot, { sessionId, now = () => new Date(), pid = process.pid } = {}) {
  // Sprint 38 fix round: the read-modify-write below is now guarded by
  // acquireClaimsLock()/releaseClaimsLock() -- see their own comment for
  // the concurrent-launch data-loss finding this closes. Falls through
  // and proceeds UNLOCKED if the lock can't be acquired at all (permission
  // failure, no space for the lock file, etc.) -- no worse than this
  // function's own behavior before this fix, never a reason to fail the
  // launch.
  const lockPath = acquireClaimsLock(repoRoot);
  try {
    const claims = readClaims(repoRoot);
    const existingList = normalizeClaimList(claims[roleId]);
    // Every entry not yet POSITIVELY confirmed dead -- what THIS launch
    // warns the caller about. Includes a pid-less (pre-0.2.13) entry:
    // Req 1a says undeterminable must still warn.
    const notConfirmedDead = existingList.filter((claim) => isPidAlive(claim && claim.pid) !== false);
    // QA1 live-loop finding (round 3): what actually gets WRITTEN BACK for
    // FUTURE launches to see is narrower than the above -- an upgraded
    // install's pre-0.2.13 claim has no pid at all, so isPidAlive() on it
    // can never resolve to `false`; keeping it in `notConfirmedDead`
    // forever (as the second fix round's own code did) meant it was
    // never pruned, and every relaunch warned about it, permanently --
    // the exact F6 regression this whole sprint exists to fix, reached a
    // third way. This launch still warns about it (notConfirmedDead,
    // returned below, still includes it), but it is dropped from what
    // gets persisted: only entries with a real, trackable pid -- ones
    // that could, in principle, later be positively confirmed dead --
    // survive into the file. A modern (has-a-pid) entry whose liveness is
    // merely undeterminable RIGHT NOW (a platform check that failed this
    // one time) is NOT dropped here -- unlike a pid-less record, it has
    // real information to re-check on a later launch, so it keeps its
    // chance to eventually resolve to `false` and be pruned for real.
    const persistable = notConfirmedDead.filter(hasTrackablePid);
    claims[roleId] = [...persistable, { sessionId: sessionId || null, startedAt: now().toISOString(), pid }];
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
    return notConfirmedDead;
  } finally {
    releaseClaimsLock(lockPath);
  }
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
// Sprint 38, Req 1: also returns null -- suppressing the NOTE -- once
// EVERY entry in `previousClaims` is POSITIVELY confirmed no longer
// running (isPidAlive() returns exactly `false` for each). Any entry
// still running, or undeterminable (an old-format record with no `pid` at
// all, or a platform/check failure), keeps the NOTE firing: Req 1a's own
// instruction is that absence of the NOTE must never be inferred from
// anything less than a positive determination, for every recorded launch,
// not only the most recent one.
//
// `previousClaims` accepts a single claim object (this function's own
// original shape, and every existing direct caller/test in this project),
// a list of them (recordRoleClaim's own current return value -- see its
// comment for why a role can have more than one surviving claim), or
// null/undefined -- `normalizeClaimList` handles all three identically.
//
// Sprint 38, second fix round (QA1 live-loop finding): when more than one
// prior claim survives, the message still centers on the most recently
// recorded one (last in the list -- recordRoleClaim appends, never
// reorders) since that's almost always the one whoever reads this NOTE
// just tried to relaunch over, and names how many OTHER still-open
// claims exist alongside it rather than silently picking one and hiding
// the rest.
function roleClaimWarning(roleLabel, previousClaims) {
  const stillOpen = normalizeClaimList(previousClaims).filter((claim) => isPidAlive(claim && claim.pid) !== false);
  if (stillOpen.length === 0) return null;
  const mostRecent = stillOpen[stillOpen.length - 1];
  const otherCount = stillOpen.length - 1;
  const otherClause = otherCount > 0
    ? ` (plus ${otherCount} other earlier ${otherCount === 1 ? 'session' : 'sessions'} recorded here and not yet confirmed to have ended)`
    : '';
  return (
    `NOTE: another ${roleLabel} session was recorded starting at ` +
    `${mostRecent.startedAt} in this same tree${mostRecent.sessionId ? ` (session ${mostRecent.sessionId})` : ''}${otherClause}. ` +
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
  acquireClaimsLock,
  releaseClaimsLock,
};
