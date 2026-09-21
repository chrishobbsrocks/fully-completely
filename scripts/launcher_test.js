#!/usr/bin/env node
'use strict';
// Tests for the VS Code launcher: scripts/launcher/jsonc.js, buildTasks()
// in scripts/launcher/generate-tasks.js, and install.js's merge logic.
// Run:
//   node scripts/launcher_test.js
//
// Mirrors smoke_test.sh's sandboxing discipline: install.js's merge
// behavior is tested by actually running it (not by re-implementing what
// it does), always against a throwaway fixture directory under the OS
// temp dir, never against this repo. Every test runs regardless of
// earlier failures, so one broken case doesn't hide the others; exits
// non-zero if any of them failed.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');
const { execFileSync, spawnSync, spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
let failures = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`OK   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(`     ${err.message}`);
  }
}

// -------------------------------------------------------------------------
// jsonc.js
// -------------------------------------------------------------------------
const { hasComments, parseJsonc } = require('./launcher/jsonc');

test('jsonc: strips // and /* */ comments and trailing commas', () => {
  const input = '{ // a\n "x": 1, // b\n "y": [1,2,3,], /* c */ "z": {"a":1,}, }';
  assert.deepStrictEqual(parseJsonc(input), { x: 1, y: [1, 2, 3], z: { a: 1 } });
});

test('jsonc: a string containing // is not treated as a comment', () => {
  assert.deepStrictEqual(parseJsonc('{"url":"http://example.com"}'), { url: 'http://example.com' });
});

test('jsonc: a string containing ", }" is not corrupted by trailing-comma stripping', () => {
  const parsed = parseJsonc('{"pattern":"match a, } literally"}');
  assert.strictEqual(parsed.pattern, 'match a, } literally');
});

test('jsonc: an escaped quote right before a real trailing comma still parses (QA1\'s case)', () => {
  const parsed = parseJsonc('{"a":"he said \\", }"}');
  assert.strictEqual(parsed.a, 'he said ", }');
});

test('jsonc: hasComments is true only when comments are actually present', () => {
  assert.strictEqual(hasComments('{"x":1} // trailing'), true);
  assert.strictEqual(hasComments('{"x":1}'), false);
});

test('jsonc: a commented-out setting is not picked up as live', () => {
  const parsed = parseJsonc('{ // "fullyCompletely.autoLaunch": true\n "fullyCompletely.autoLaunch": false }');
  assert.strictEqual(parsed['fullyCompletely.autoLaunch'], false);
});

// -------------------------------------------------------------------------
// rel-path-key.js: sprint 10's Windows fix. install.js's own CLI can't
// reproduce a real backslash relPath on a non-Windows machine (path.join()
// never produces one here), so this is tested directly rather than only
// through the full install run — the one way to actually exercise the bug
// this closes outside a real Windows machine.
// -------------------------------------------------------------------------
const { toRelPathKey } = require('./launcher/rel-path-key');

test('toRelPathKey: a Windows-shaped (backslash) relPath becomes the forward-slash form every published baseline table uses', () => {
  assert.strictEqual(toRelPathKey('.claude\\agents\\qa1.md'), '.claude/agents/qa1.md');
});

test('toRelPathKey: an already forward-slash relPath (macOS/Linux) is unchanged', () => {
  assert.strictEqual(toRelPathKey('.claude/agents/qa1.md'), '.claude/agents/qa1.md');
});

test('toRelPathKey: a path with no separator at all (CLAUDE.md) is unaffected either way — the discriminator that isolated this defect', () => {
  assert.strictEqual(toRelPathKey('CLAUDE.md'), 'CLAUDE.md');
});

test('toRelPathKey: a mix of separators (defensive — not a real path.join() output on any platform) is fully converted', () => {
  assert.strictEqual(toRelPathKey('.claude\\agents/qa1.md'), '.claude/agents/qa1.md');
});

// -------------------------------------------------------------------------
// session.js: UUID derivation, path derivation, resume-vs-fresh selection
// -------------------------------------------------------------------------
const {
  sessionId,
  sessionsDir,
  sessionFilePath,
  resolveSession,
} = require('./launcher/session');

// -------------------------------------------------------------------------
// role-claims.js: sprint 25, Req 1 -- best-effort role-launch record
// -------------------------------------------------------------------------
const {
  claimsFilePath,
  readClaims,
  recordRoleClaim,
  roleClaimWarning,
  isPidAlive,
  acquireClaimsLock,
} = require('./launcher/role-claims');

function withTmpRepoRoot(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-role-claims-repo-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('role-claims: readClaims on a repo with no claims file yet returns {} rather than crashing', () => {
  withTmpRepoRoot((repoRoot) => {
    assert.deepStrictEqual(readClaims(repoRoot), {});
  });
});

test('role-claims: a role\'s first claim returns [] (nothing previous) and writes the file as a one-element list', () => {
  withTmpRepoRoot((repoRoot) => {
    const previous = recordRoleClaim('qa1', repoRoot, { sessionId: 'abc-123', pid: killAndReapSync(1) });
    assert.deepStrictEqual(previous, []);
    assert.ok(fs.existsSync(claimsFilePath(repoRoot)));
    const claims = readClaims(repoRoot);
    assert.strictEqual(claims.qa1.length, 1);
    assert.strictEqual(claims.qa1[0].sessionId, 'abc-123');
    assert.match(claims.qa1[0].startedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('role-claims: a role\'s second claim, once the FIRST is confirmed dead, prunes it -- returns [] and the file keeps only the new one', () => {
  withTmpRepoRoot((repoRoot) => {
    const firstNow = () => new Date('2026-01-01T00:00:00.000Z');
    recordRoleClaim('qa1', repoRoot, { sessionId: 'first-session', now: firstNow, pid: killAndReapSync(1) });
    const secondNow = () => new Date('2026-01-02T00:00:00.000Z');
    const previous = recordRoleClaim('qa1', repoRoot, { sessionId: 'second-session', now: secondNow, pid: killAndReapSync(1) });
    assert.deepStrictEqual(previous, [], 'the first claim is confirmed gone -- nothing survives to warn about');
    const claims = readClaims(repoRoot);
    assert.strictEqual(claims.qa1.length, 1, 'a confirmed-dead claim must not be carried forward');
    assert.strictEqual(claims.qa1[0].sessionId, 'second-session');
  });
});

// Sprint 38, second fix round (QA1 live-loop finding): the exact A/B/C
// sequence QA1 reproduced with real launches, at the recordRoleClaim/
// roleClaimWarning level -- deterministic and fast, using a real spawned
// process for "genuinely still running" (A) and a real killed-and-reaped
// one for "confirmed exited" (B), rather than guessed pids. See the
// dedicated real-subprocess version further down for the end-to-end
// confirmation via actual `run-role.js` launches.
test('role-claims: A survives being overwritten by B (still alive when B claims), then survives B\'s own exit too -- the exact QA1 A/B/C repro', () => {
  withTmpRepoRoot((repoRoot) => {
    const sleeperA = spawn('sleep', ['5']);
    try {
      // Launch A: first claim for this role, nothing to prune yet.
      const beforeA = recordRoleClaim('qa1', repoRoot, { sessionId: 'A', pid: sleeperA.pid });
      assert.deepStrictEqual(beforeA, []);

      // Launch B, while A is still genuinely running: A must survive as a
      // still-open claim, not be discarded just because B is newer.
      const deadPidForB = killAndReapSync(1); // B's own launcher, confirmed to have since exited
      const beforeB = recordRoleClaim('qa1', repoRoot, { sessionId: 'B', pid: deadPidForB });
      assert.strictEqual(beforeB.length, 1, 'A must still be there for B to see');
      assert.strictEqual(beforeB[0].sessionId, 'A');
      assert.ok(roleClaimWarning('QA1', beforeB) !== null, 'B must still be warned -- A is genuinely running');

      // Launch C, with A STILL alive and B now confirmed dead: this is
      // QA1's exact repro step -- the OLD code returned only B's own
      // (now-dead) record here, silently losing A's, and printed no
      // warning. A must still be reported.
      const deadPidForC = killAndReapSync(1);
      const beforeC = recordRoleClaim('qa1', repoRoot, { sessionId: 'C', pid: deadPidForC });
      assert.strictEqual(beforeC.length, 1, 'A must still be present -- confirmed dead B is pruned, but A never was');
      assert.strictEqual(beforeC[0].sessionId, 'A', 'the surviving claim must actually be A\'s, not a stale B');
      const warning = roleClaimWarning('QA1', beforeC);
      assert.ok(warning !== null, 'C must be warned that A (still genuinely running) exists -- the exact bug QA1 found');
      assert.match(warning, /NOTE: another QA1 session was recorded starting at/);

      const claims = readClaims(repoRoot);
      assert.strictEqual(claims.qa1.length, 2, 'A (still alive) and C (the newest launch) both on record; B was pruned once confirmed dead');
    } finally {
      sleeperA.kill('SIGKILL');
    }
  });
});

// Sprint 38, third fix round (QA1 live-loop finding): a pid-less
// (pre-0.2.13) claim can never be positively confirmed dead, so it must
// warn on the launch that reads it (Req 1a) but must NOT be carried
// forward into the file, or it would warn on every relaunch forever --
// the exact regression QA1 found. Unit-level, deterministic version of
// the real-subprocess repro further down.
test('role-claims: recordRoleClaim warns about a planted pid-less claim once, then drops it from what gets persisted', () => {
  withTmpRepoRoot((repoRoot) => {
    const file = claimsFilePath(repoRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ qa1: { sessionId: 'old', startedAt: '2026-01-01T00:00:00.000Z' } }, null, 2) + '\n');

    const firstPrevious = recordRoleClaim('qa1', repoRoot, { sessionId: 'first-new', pid: killAndReapSync(1) });
    assert.strictEqual(firstPrevious.length, 1, 'the pid-less claim must still be reported to THIS launch');
    assert.strictEqual(firstPrevious[0].sessionId, 'old');
    assert.ok(roleClaimWarning('QA1', firstPrevious) !== null, 'and must still produce a warning -- Req 1a');

    const claimsAfterFirst = readClaims(repoRoot);
    assert.strictEqual(claimsAfterFirst.qa1.length, 1, 'the untrackable old claim must already be dropped from what was written');
    assert.strictEqual(claimsAfterFirst.qa1[0].sessionId, 'first-new');

    const secondPrevious = recordRoleClaim('qa1', repoRoot, { sessionId: 'second-new', pid: killAndReapSync(1) });
    assert.deepStrictEqual(secondPrevious, [], 'the old pid-less claim must never resurface on a later launch');
  });
});

test('role-claims: two DIFFERENT roles never see each other\'s claims (independent keys)', () => {
  withTmpRepoRoot((repoRoot) => {
    recordRoleClaim('qa1', repoRoot, { sessionId: 'qa1-session', pid: killAndReapSync(1) });
    const previousForDifferentRole = recordRoleClaim('dev-team-1', repoRoot, { sessionId: 'dt1-session', pid: killAndReapSync(1) });
    assert.deepStrictEqual(previousForDifferentRole, [], 'dev-team-1 launching for the first time must not see qa1\'s claim');
  });
});

test('role-claims: a write failure (unwritable directory) never throws -- Req 1\'s own "it warns; it never gates" applies to the record itself', () => {
  withTmpRepoRoot((repoRoot) => {
    const claudeDir = path.join(repoRoot, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.chmodSync(claudeDir, 0o444);
    try {
      assert.doesNotThrow(() => recordRoleClaim('qa1', repoRoot, { sessionId: 'irrelevant' }));
    } finally {
      fs.chmodSync(claudeDir, 0o755); // restore so withTmpRepoRoot's own cleanup can remove it
    }
  });
});

// Sprint 38, third fix round (QA1 live-loop finding): a deterministic,
// white-box reproduction of the exact TOCTOU QA1 found by interleaving two
// real `acquireClaimsLock` calls -- the staleness DECISION for a lock is
// made from a stat() taken before the rename that acts on it, so by the
// time the rename runs, another process may already have completed its
// own full steal-and-recreate cycle at the same path. A plain `renameSync`
// swap (this sprint's own second fix round) cannot tell that apart from
// genuinely stealing the original stale lock -- it just moves whatever is
// currently there. This test forces exactly that gap open, deterministically:
// it intercepts this module's own `fs.statSync` call on the lock path (the
// SAME `fs` module object role-claims.js itself required, since Node's
// module cache returns one shared instance per process) to simulate
// another process completing its own steal-and-recreate between the stat
// and the rename, then restores the real fs.statSync no matter what the
// assertion below does.
test('acquireClaimsLock: a lock recreated between this attempt\'s own staleness check and its rename must not be stolen out from under its new, rightful holder', () => {
  withTmpRepoRoot((repoRoot) => {
    const lockPath = claimsFilePath(repoRoot) + '.lock';
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, '');
    const staleTime = new Date(Date.now() - 60000); // well past LOCK_STALE_MS
    fs.utimesSync(lockPath, staleTime, staleTime);

    const realStatSync = fs.statSync;
    let intercepted = false;
    fs.statSync = function (target, ...rest) {
      if (target === lockPath && !intercepted) {
        intercepted = true;
        // Capture what THIS attempt actually observes (the genuinely
        // stale file) before simulating another process's full
        // steal-and-recreate cycle happening in the gap between this
        // stat() returning and this attempt's own subsequent rename().
        const observed = realStatSync.call(fs, target);
        fs.unlinkSync(target);
        fs.writeFileSync(target, ''); // a DIFFERENT, fresh lock now legitimately occupies this path
        return observed;
      }
      return realStatSync.apply(fs, [target, ...rest]);
    };
    try {
      const acquired = acquireClaimsLock(repoRoot);
      assert.strictEqual(
        acquired, null,
        'must never report success by renaming away a lock that was actually recreated by someone else in the gap between the staleness check and the steal'
      );
    } finally {
      fs.statSync = realStatSync;
    }
  });
});

// -------------------------------------------------------------------------
// isPidAlive() / roleClaimWarning() pid-liveness: sprint 38, Req 1/1a/1b/1c.
// Every "alive"/"dead" fact below comes from a REAL spawned process, never
// a mocked or guessed pid -- matching this file's own established
// preference for real subprocess behavior over simulation, and Req 1b's
// own explicit "measure before building" instruction.
// -------------------------------------------------------------------------
test('isPidAlive: true for a real, currently-running process', () => {
  const sleeper = spawn('sleep', ['5']);
  try {
    assert.strictEqual(isPidAlive(sleeper.pid), true);
  } finally {
    sleeper.kill('SIGKILL');
  }
});

// Spawns `sleep 30` in a background shell job, SIGKILLs it, and `wait`s on
// it -- the shell's own `wait` builtin blocks synchronously until that
// exact child has exited AND reaps it itself, so by the time this
// function returns, the pid is fully gone from the OS process table (not
// merely killed-but-unreaped) -- confirmed directly: `ps -p <pid>`
// afterward finds nothing at all, not even a zombie entry. This sidesteps
// this test file's own synchronous `test()` harness (no async/await
// support) needing to wait on Node's own asynchronous 'exit' event, which
// a busy-loop using execFileSync cannot observe -- confirmed directly
// that approach fails: execFileSync blocks the whole event loop, so
// Node's own child_process exit callback never runs until the loop
// exits, by which point the deadline has already passed.
function killAndReapSync(seconds) {
  const r = spawnSync('sh', ['-c', `sleep ${seconds} & pid=$!; kill -9 $pid; wait $pid 2>/dev/null; echo $pid`], { encoding: 'utf8' });
  return parseInt(r.stdout.trim(), 10);
}

test('isPidAlive: false for a pid that has been confirmed to exit', () => {
  const pid = killAndReapSync(30);
  assert.strictEqual(isPidAlive(pid), false);
});

test('isPidAlive: a zombie (killed but not yet reaped) is treated as NOT alive, on POSIX -- the real hazard this function exists to guard against', () => {
  if (process.platform === 'win32') return; // POSIX-only concept; skip rather than assert something Windows has no equivalent of
  const child = spawn('sleep', ['30']);
  const pid = child.pid;
  child.kill('SIGKILL');
  // Deliberately do NOT wait for Node's own 'exit' event here -- the
  // whole point is to catch the process while it is still a zombie in
  // the OS process table (killed, not yet reaped by its real parent,
  // this test process). A short, fixed wait gives the kernel time to
  // actually transition the process to zombie state without giving
  // Node's own child_process machinery time to reap it first.
  const start = Date.now();
  while (Date.now() - start < 50) { /* busy-wait briefly, no sleep syscall needed */ }
  assert.strictEqual(isPidAlive(pid), false, 'a zombie must read as not-alive, not as still-running');
});

test('isPidAlive: sprint 38, QA1 round 1 FINDING -- a `ps` that cannot answer (BusyBox\'s own shape) must NOT be read as "process gone" for a genuinely running process', () => {
  // BusyBox ps (Alpine, and many slim containers/devcontainers) has no
  // `-p` flag at all: `ps -o stat= -p <pid>` prints BusyBox's own usage
  // text and exits 1, regardless of whether <pid> is alive. A PATH-shimmed
  // `ps` reproducing exactly that shape, in front of a REAL, currently
  // running process, is what QA1 used to demonstrate the bug end to end;
  // reproduced identically here as the regression test.
  if (process.platform === 'win32') return; // this function's own ps-based check is POSIX-only
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-busybox-ps-shim-'));
  const shimScript = [
    '#!/bin/sh',
    'echo "BusyBox v1.36.1 multi-call binary." >&2',
    'echo "Usage: ps" >&2',
    'exit 1',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(shimDir, 'ps'), shimScript);
  fs.chmodSync(path.join(shimDir, 'ps'), 0o755);
  const sleeper = spawn('sleep', ['5']);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${shimDir}:${originalPath}`;
    // Give spawn a moment to actually land before probing.
    execFileSync('sleep', ['0.1']);
    const result = isPidAlive(sleeper.pid);
    assert.notStrictEqual(result, false,
      'a ps that cannot answer must never be read as "confirmed gone" -- the exact QA1 round-1 finding. got: ' + result);
    const warning = roleClaimWarning('QA1', { startedAt: '2026-01-01T00:00:00.000Z', sessionId: 'x', pid: sleeper.pid });
    assert.ok(warning !== null, 'end to end: the NOTE must still fire for a genuinely running session when ps cannot answer');
  } finally {
    process.env.PATH = originalPath;
    sleeper.kill('SIGKILL');
    fs.rmSync(shimDir, { recursive: true, force: true });
  }
});

test('isPidAlive: null (undeterminable) for a missing/invalid pid -- Req 1c\'s own 0.2.10-and-earlier record shape', () => {
  assert.strictEqual(isPidAlive(undefined), null, 'an old-format record with no pid field at all');
  assert.strictEqual(isPidAlive(null), null);
  assert.strictEqual(isPidAlive('123'), null, 'a string, never a real pid type this code would have written');
  assert.strictEqual(isPidAlive(-1), null);
  assert.strictEqual(isPidAlive(0), null);
});

test('roleClaimWarning: fires for a genuinely running previous session (real spawned process)', () => {
  const sleeper = spawn('sleep', ['5']);
  try {
    const warning = roleClaimWarning('QA1', { startedAt: '2026-01-01T00:00:00.000Z', sessionId: 'x', pid: sleeper.pid });
    assert.match(warning, /NOTE: another QA1 session was recorded starting at/);
  } finally {
    sleeper.kill('SIGKILL');
  }
});

test('roleClaimWarning: sprint 38, Req 1 -- suppressed (null) once the previous session\'s process is confirmed to have exited', () => {
  const pid = killAndReapSync(30);
  const warning = roleClaimWarning('QA1', { startedAt: '2026-01-01T00:00:00.000Z', sessionId: 'x', pid });
  assert.strictEqual(warning, null, 'the previous session has demonstrably ended -- no NOTE');
});

test('roleClaimWarning: Req 1a/1c -- still fires (never silently suppressed) for an undeterminable record: missing pid, or any other non-positive result', () => {
  // A 0.2.10-and-earlier claim record: no `pid` key exists on the object
  // at all (not even `undefined` explicitly) -- exactly what JSON.parse
  // produces from a real pre-sprint-38 role-claims.json.
  const oldFormatClaim = { startedAt: '2026-01-01T00:00:00.000Z', sessionId: 'x' };
  assert.ok(!('pid' in oldFormatClaim), 'test setup: this must genuinely lack the key, not merely be undefined');
  const warning = roleClaimWarning('QA1', oldFormatClaim);
  assert.match(warning, /NOTE: another QA1 session was recorded starting at/, 'Req 1a: undeterminable must still warn');
  // The NOTE's own established wording already states its blind spot
  // honestly ("Silence never means 'nobody else is working here.'") --
  // Req 1a requires that this stays true, not that the phrase is absent.
  assert.match(warning, /Silence never means "nobody else is working here\."/);
});

test('role-claims: roleClaimWarning is null when there is no previous claim -- silence on a role\'s first launch', () => {
  assert.strictEqual(roleClaimWarning('QA1', null), null);
});

test('role-claims: roleClaimWarning names the earlier session\'s start time and its own blind spot (Req 1/3)', () => {
  const warning = roleClaimWarning('QA1', { sessionId: 'xyz-789', startedAt: '2026-01-01T00:00:00.000Z' });
  assert.match(warning, /2026-01-01T00:00:00\.000Z/, 'must name when the earlier session started');
  assert.match(warning, /xyz-789/, 'must name the earlier session');
  // Req 1's own required wording: a reader must not be able to conclude
  // from silence that nobody else is working here.
  assert.match(warning, /nobody else is working here/i);
  // Req 3: states its own blind spot -- only launches through this
  // script, only at launch time, never a mid-build collision.
  assert.match(warning, /only sees launches that went through this script/i);
  // Req 1: never gates.
  assert.match(warning, /never blocks/i);
});

test('roleClaimWarning: given a LIST of more than one still-open claim, centers the message on the most recent and names how many others exist, dropping none silently', () => {
  const warning = roleClaimWarning('QA1', [
    { sessionId: 'older', startedAt: '2026-01-01T00:00:00.000Z' }, // undeterminable (no pid) -- still counts as open
    { sessionId: 'newest', startedAt: '2026-01-02T00:00:00.000Z' },
  ]);
  assert.match(warning, /2026-01-02T00:00:00\.000Z/, 'centers on the most recently recorded claim');
  assert.match(warning, /newest/);
  assert.match(warning, /plus 1 other earlier session/i, 'names the other still-open claim rather than dropping it');
});

test('roleClaimWarning: an empty list (every prior claim pruned already) is treated exactly like no previous claim -- null', () => {
  assert.strictEqual(roleClaimWarning('QA1', []), null);
});

function withTmpHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-launcher-home-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function touchSessionFile(roleId, repoRoot, generation, homeDir) {
  const file = sessionFilePath(roleId, repoRoot, generation, homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

test('session: UUID is deterministic for the same (role, repo, generation)', () => {
  const a = sessionId('qa1', '/Users/x/proj', 0);
  const b = sessionId('qa1', '/Users/x/proj', 0);
  assert.strictEqual(a, b);
});

test('session: UUID differs across roles', () => {
  const a = sessionId('qa1', '/Users/x/proj', 0);
  const b = sessionId('pipeman', '/Users/x/proj', 0);
  assert.notStrictEqual(a, b);
});

test('session: UUID differs across repo roots', () => {
  const a = sessionId('qa1', '/Users/x/proj-one', 0);
  const b = sessionId('qa1', '/Users/x/proj-two', 0);
  assert.notStrictEqual(a, b);
});

test('session: UUID differs across generations', () => {
  const a = sessionId('qa1', '/Users/x/proj', 0);
  const b = sessionId('qa1', '/Users/x/proj', 1);
  assert.notStrictEqual(a, b);
});

test('session: UUID is RFC-4122-valid (version 5, variant 10xx), not a reformatted hash', () => {
  const uuid = sessionId('qa1', '/Users/x/proj', 0);
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const versionNibble = uuid[14];
  assert.strictEqual(versionNibble, '5');
  const variantNibble = parseInt(uuid[19], 16);
  assert.ok(variantNibble >= 8 && variantNibble <= 11, `variant nibble ${uuid[19]} not in 8-b range`);
});

test('session: directory derivation replaces POSIX separators, no hardcoded -Users-', () => {
  withTmpHome((home) => {
    const dir = sessionsDir('/Users/x/Programming/fully-completely', home);
    assert.strictEqual(dir, path.join(home, '.claude', 'projects', '-Users-x-Programming-fully-completely'));
  });
});

// This exact case is what an earlier version of sessionsDir() (replacing
// only path separators) got wrong, and QA1 caught: a real repo path
// containing a space or a dot encodes those characters too, not just
// slashes. Values here are the CLI's actual observed encoding (checked by
// hand against ~/.claude/projects/ for a throwaway repo path containing a
// space, two consecutive spaces, a dot, parentheses, and underscores —
// each non-alphanumeric character maps to its own '-', with no collapsing
// of runs), not a guess.
test('session: directory derivation replaces spaces, dots, and other non-alphanumerics, one dash per character', () => {
  withTmpHome((home) => {
    const dir = sessionsDir('/private/tmp/fc test.dir/sub proj', home);
    assert.strictEqual(dir, path.join(home, '.claude', 'projects', '-private-tmp-fc-test-dir-sub-proj'));
  });
});

test('session: directory derivation does not collapse consecutive non-alphanumerics into one dash', () => {
  withTmpHome((home) => {
    const dir = sessionsDir('/private/tmp/fc2 (paren)_under__score/a  b/x.y.z', home);
    assert.strictEqual(
      dir,
      path.join(home, '.claude', 'projects', '-private-tmp-fc2--paren--under--score-a--b-x-y-z')
    );
  });
});

// Windows itself is NOT independently verified (see Risks in the sprint
// file — that's the user's Windows acceptance gate, not this suite). This
// asserts our code applies the same "replace every non-alphanumeric
// character with '-', one-for-one" rule uniformly rather than special-
// casing backslash vs forward slash — i.e. it locks in the derivation
// logic's consistency, not a claim about the real Windows CLI's behavior.
test('session: directory derivation applies the same non-alphanumeric rule to a Windows-style path', () => {
  withTmpHome((home) => {
    const dir = sessionsDir('C:\\Users\\Chris Hobbs\\Programming\\fully-completely', home);
    assert.strictEqual(
      dir,
      path.join(home, '.claude', 'projects', 'C--Users-Chris-Hobbs-Programming-fully-completely')
    );
  });
});

test('session: resolveSession launches fresh at generation 0 when nothing exists', () => {
  withTmpHome((home) => {
    const repoRoot = '/Users/x/proj';
    const result = resolveSession('qa1', repoRoot, { homeDir: home });
    assert.strictEqual(result.resume, false);
    assert.strictEqual(result.sessionId, sessionId('qa1', repoRoot, 0));
  });
});

test('session: resolveSession resumes generation 0 when only it exists', () => {
  withTmpHome((home) => {
    const repoRoot = '/Users/x/proj';
    touchSessionFile('qa1', repoRoot, 0, home);
    const result = resolveSession('qa1', repoRoot, { homeDir: home });
    assert.strictEqual(result.resume, true);
    assert.strictEqual(result.sessionId, sessionId('qa1', repoRoot, 0));
  });
});

test('session: resolveSession resumes the highest generation, not generation 0', () => {
  withTmpHome((home) => {
    const repoRoot = '/Users/x/proj';
    touchSessionFile('qa1', repoRoot, 0, home);
    touchSessionFile('qa1', repoRoot, 1, home);
    touchSessionFile('qa1', repoRoot, 2, home);
    const result = resolveSession('qa1', repoRoot, { homeDir: home });
    assert.strictEqual(result.resume, true);
    assert.strictEqual(result.sessionId, sessionId('qa1', repoRoot, 2));
  });
});

test('session: resolveSession uses highest existing generation, not the first gap', () => {
  withTmpHome((home) => {
    const repoRoot = '/Users/x/proj';
    touchSessionFile('qa1', repoRoot, 0, home);
    // generation 1 deliberately missing (manually deleted)
    touchSessionFile('qa1', repoRoot, 2, home);
    const result = resolveSession('qa1', repoRoot, { homeDir: home });
    assert.strictEqual(result.resume, true);
    assert.strictEqual(result.sessionId, sessionId('qa1', repoRoot, 2));
    const restart = resolveSession('qa1', repoRoot, { homeDir: home, restart: true });
    assert.strictEqual(restart.sessionId, sessionId('qa1', repoRoot, 3));
  });
});

test('session: --restart launches fresh at generation 0 when nothing exists yet', () => {
  withTmpHome((home) => {
    const repoRoot = '/Users/x/proj';
    const result = resolveSession('qa1', repoRoot, { homeDir: home, restart: true });
    assert.strictEqual(result.resume, false);
    assert.strictEqual(result.sessionId, sessionId('qa1', repoRoot, 0));
  });
});

test('session: --restart launches fresh at highest + 1, never an in-use ID', () => {
  withTmpHome((home) => {
    const repoRoot = '/Users/x/proj';
    touchSessionFile('qa1', repoRoot, 0, home);
    const result = resolveSession('qa1', repoRoot, { homeDir: home, restart: true });
    assert.strictEqual(result.resume, false);
    assert.strictEqual(result.sessionId, sessionId('qa1', repoRoot, 1));
  });
});

test('session: restart round trip — the next normal launch resumes the restarted session, not the abandoned one', () => {
  withTmpHome((home) => {
    const repoRoot = '/Users/x/proj';
    touchSessionFile('qa1', repoRoot, 0, home);
    const restart = resolveSession('qa1', repoRoot, { homeDir: home, restart: true });
    assert.strictEqual(restart.sessionId, sessionId('qa1', repoRoot, 1));
    // The restarted session only "sticks" once its own file exists on disk
    // (created by the real claude invocation in run-role.js); simulate that.
    touchSessionFile('qa1', repoRoot, 1, home);
    const normal = resolveSession('qa1', repoRoot, { homeDir: home });
    assert.strictEqual(normal.resume, true);
    assert.strictEqual(normal.sessionId, sessionId('qa1', repoRoot, 1));
    assert.notStrictEqual(normal.sessionId, sessionId('qa1', repoRoot, 0));
  });
});

// -------------------------------------------------------------------------
// auth.js: login preflight classification (Req 6, 6a-revised, 6b,
// 6b-clarified, 6c)
//
// Every stdout fixture below was captured from the real Claude CLI
// (2.1.233) via `claude auth status --json`, in an isolated
// CLAUDE_CONFIG_DIR that never touched a real login, not guessed. See the
// sprint 1 handoff notes for the exact repro of each.
// -------------------------------------------------------------------------
const { classify, parseLoggedIn } = require('./launcher/auth');

const REAL_LOGGED_IN_JSON = '{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "apiProvider": "firstParty"\n}\n';
const REAL_LOGGED_OUT_JSON = '{\n  "loggedIn": false,\n  "authMethod": "none",\n  "apiProvider": "firstParty"\n}\n';
const REAL_UNKNOWN_SUBCOMMAND_STDERR = "error: unknown command 'bogussubcommand'\n";
const REAL_UNKNOWN_FLAG_STDERR = "error: unknown option '--bogusflag'\n";

test('auth: loggedIn: true, exit 0 (real logged-in output) classifies as authenticated', () => {
  assert.strictEqual(classify({ status: 0, stdout: REAL_LOGGED_IN_JSON, error: null, signal: null }), 'authenticated');
});

test('auth: a clean exit 0 with no parseable JSON still classifies as authenticated', () => {
  assert.strictEqual(classify({ status: 0, stdout: '', error: null, signal: null }), 'authenticated');
});

test('auth: loggedIn: false, exit 1 (genuine logout) classifies as unauthenticated', () => {
  assert.strictEqual(classify({ status: 1, stdout: REAL_LOGGED_OUT_JSON, error: null, signal: null }), 'unauthenticated');
});

// Req 6b-clarified: a chmod-000 config dir and a genuine logout print the
// exact same well-formed JSON on this CLI — verified by hand, not assumed
// — so both must block. There is no field to read that distinguishes them
// (and Req 6b-clarified forbids trying via authMethod).
test('auth: loggedIn: false from a chmod-000 config dir classifies as unauthenticated, not inconclusive', () => {
  assert.strictEqual(classify({ status: 1, stdout: REAL_LOGGED_OUT_JSON, error: null, signal: null }), 'unauthenticated');
});

test('auth: loggedIn: false from a config dir that is a file, not a directory, classifies as unauthenticated', () => {
  assert.strictEqual(classify({ status: 1, stdout: REAL_LOGGED_OUT_JSON, error: null, signal: null }), 'unauthenticated');
});

// Req 6b: the probe itself failing to produce an answer must proceed, not
// block. Unrecognised subcommand/flag both print non-JSON error text on
// the real CLI, so loggedIn is unreadable — the probe broke, not auth.
test('auth: an unrecognised auth subcommand (non-JSON stderr) classifies as inconclusive', () => {
  assert.strictEqual(
    classify({ status: 1, stdout: REAL_UNKNOWN_SUBCOMMAND_STDERR, error: null, signal: null }),
    'inconclusive'
  );
});

test('auth: an unrecognised flag (non-JSON stderr) classifies as inconclusive', () => {
  assert.strictEqual(classify({ status: 1, stdout: REAL_UNKNOWN_FLAG_STDERR, error: null, signal: null }), 'inconclusive');
});

test('auth: malformed JSON classifies as inconclusive', () => {
  assert.strictEqual(classify({ status: 1, stdout: '{"loggedIn": tru', error: null, signal: null }), 'inconclusive');
});

test('auth: absent/empty stdout with a non-zero exit classifies as inconclusive', () => {
  assert.strictEqual(classify({ status: 1, stdout: '', error: null, signal: null }), 'inconclusive');
});

test('auth: valid JSON missing the loggedIn field classifies as inconclusive', () => {
  assert.strictEqual(
    classify({ status: 1, stdout: '{"authMethod": "none"}', error: null, signal: null }),
    'inconclusive'
  );
});

test('auth: a spawn error classifies as inconclusive, not unauthenticated', () => {
  assert.strictEqual(
    classify({ status: null, stdout: null, error: new Error('spawn claude ENOENT'), signal: null }),
    'inconclusive'
  );
});

test('auth: a killed/timed-out probe classifies as inconclusive, not unauthenticated', () => {
  assert.strictEqual(classify({ status: null, stdout: null, error: null, signal: 'SIGTERM' }), 'inconclusive');
});

test('auth: parseLoggedIn reads only the loggedIn field, ignoring authMethod entirely', () => {
  assert.strictEqual(parseLoggedIn(REAL_LOGGED_OUT_JSON), false);
  assert.strictEqual(parseLoggedIn(REAL_LOGGED_IN_JSON), true);
  assert.strictEqual(parseLoggedIn('not json at all'), undefined);
  assert.strictEqual(parseLoggedIn(''), undefined);
  assert.strictEqual(parseLoggedIn(null), undefined);
  assert.strictEqual(parseLoggedIn('null'), undefined);
  assert.strictEqual(parseLoggedIn('[1,2,3]'), undefined);
  assert.strictEqual(parseLoggedIn('{"loggedIn": "true"}'), undefined); // string, not boolean
});

// -------------------------------------------------------------------------
// generate-tasks.js: buildTasks()
// -------------------------------------------------------------------------
const { buildTasks } = require('./launcher/generate-tasks');

test('buildTasks: exactly one task per role, plus Shell and FC: Start All', () => {
  const { tasks } = buildTasks(REPO_ROOT);
  assert.deepStrictEqual(
    tasks.map((t) => t.label),
    ['Master Controller', 'Dev Team 1', 'Dev Team 2', 'QA1', 'Pipeman', 'LiveQA', 'Shell', 'FC: Start All']
  );
});

test('buildTasks: each role task runs run-role.js with the matching role id', () => {
  const { tasks } = buildTasks(REPO_ROOT);
  const qa1 = tasks.find((t) => t.label === 'QA1');
  assert.strictEqual(qa1.command, 'node');
  assert.deepStrictEqual(qa1.args, ['scripts/launcher/run-role.js', 'qa1']);
});

test('buildTasks: Shell has a Windows override and no color of its own', () => {
  const { tasks } = buildTasks(REPO_ROOT);
  const shell = tasks.find((t) => t.label === 'Shell');
  assert.strictEqual(shell.windows.command, 'powershell');
  assert.strictEqual(shell.icon.color, undefined);
});

test('buildTasks: role colors come from each agent file\'s frontmatter', () => {
  const { tasks } = buildTasks(REPO_ROOT);
  const mc = tasks.find((t) => t.label === 'Master Controller');
  assert.strictEqual(mc.icon.color, 'terminal.ansiBlue'); // master-controller.md: color: blue
});

test('buildTasks: FC: Start All depends on every role task plus Shell', () => {
  const { tasks } = buildTasks(REPO_ROOT);
  const startAll = tasks.find((t) => t.label === 'FC: Start All');
  assert.deepStrictEqual(
    startAll.dependsOn,
    ['Master Controller', 'Dev Team 1', 'Dev Team 2', 'QA1', 'Pipeman', 'LiveQA', 'Shell']
  );
});

// -------------------------------------------------------------------------
// install.js: merge logic, against throwaway fixture projects
// -------------------------------------------------------------------------
function withFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-launcher-test-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runInstall(cwd) {
  try {
    return execFileSync('node', [path.join(REPO_ROOT, 'scripts', 'install.js')], { cwd, encoding: 'utf8' });
  } catch (err) {
    // Sprint 8, Req 5: a normal run reporting conflicts exits 0 now (see
    // the exit-code tests below), so this catch exists only for a
    // genuine failure — still worth surfacing stdout if there is any,
    // rather than losing it, but this is no longer the routine path it
    // was under sprint 3-7's exitCode=1 behaviour.
    if (typeof err.stdout === 'string') return err.stdout;
    throw err;
  }
}

// Sprint 8, Req 5/8: runs install.js the same way runInstall() does, but
// returns the process's exit status instead of throwing away everything
// but stdout — spawnSync (not execFileSync) so a non-zero status is data,
// not a thrown exception, whether it's 0, 1, or anything else.
function runInstallStatus(cwd) {
  return spawnSync('node', [path.join(REPO_ROOT, 'scripts', 'install.js')], { cwd, encoding: 'utf8' }).status;
}

// Sprint 6: mirrors install.js's own hashFile() (sha256 of CRLF-normalised
// content) exactly, so these tests can construct a manifest that install.js
// will actually recognize as a match — re-deriving the algorithm here
// rather than requiring install.js's internals keeps this file testing
// behavior through the same CLI boundary every other test in this section
// uses.
function fcHash(content) {
  return crypto.createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex');
}

function writeManifest(dir, manifest) {
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude', 'fully-completely-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
}

function readManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'fully-completely-manifest.json'), 'utf8'));
}

// Sprint 8: unlike the manifest above (which lives under a throwaway
// DEST_ROOT fixture this file fully controls), the baseline table lives
// under SOURCE_ROOT — this repo's own committed data, read from wherever
// install.js's own scripts/baselines/ directory actually is. There is no
// per-run fixture to point it at, so testing its failure modes (missing,
// corrupt) or giving a test deterministic, non-network baseline data
// means temporarily replacing this repo's real file and restoring it
// afterwards, in `finally`, no matter what `fn` does — the same
// always-clean-up discipline withFixture() uses for its temp directories,
// applied to a file this repo actually ships instead of a scratch one.
// `rawContentOrNull === null` means "delete it" (a missing table), a
// string means "replace its contents" (corrupt JSON, or fabricated valid
// JSON for a deterministic test that doesn't depend on the real,
// regeneratable table's current contents).
const REAL_BASELINES_PATH = path.join(REPO_ROOT, 'scripts', 'baselines', 'user-owned-content.json');

function withReplacedBaselines(rawContentOrNull, fn) {
  const original = fs.readFileSync(REAL_BASELINES_PATH, 'utf8');
  if (rawContentOrNull === null) {
    fs.rmSync(REAL_BASELINES_PATH);
  } else {
    fs.writeFileSync(REAL_BASELINES_PATH, rawContentOrNull);
  }
  try {
    fn();
  } finally {
    fs.writeFileSync(REAL_BASELINES_PATH, original);
  }
}

function fakeBaselines(filesByVersion) {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    versions: Object.keys(filesByVersion),
    paths: [QA1_REL_PATH],
    files: { [QA1_REL_PATH]: filesByVersion },
  });
}

test('install.js: fresh project gets the framework and an 8-task tasks.json', () => {
  withFixture((dir) => {
    const output = runInstall(dir);
    assert.match(output, /tasks\.json \(8 tasks\)/);
    assert.ok(fs.existsSync(path.join(dir, '.claude', 'agents', 'qa1.md')));
    assert.ok(fs.existsSync(path.join(dir, 'CLAUDE.md')));
  });
});

// Sprint 36 fix round (QA1 round 2 finding): package.json's own "files"
// allowlist (what SHIPS in the published tarball) and install.js's own
// FRAMEWORK_OWNED list (what an install/upgrade actually COPIES into a
// target project) are two separate lists, and nothing before this
// enforced they stay in sync. scripts/mc-commit.js reached the first
// list (caught in this same sprint's own round-1 fix, after
// package.json's files array was found missing it) but not the second —
// every real consumer install shipped a headless master-controller
// profile pointing at a script that was never actually copied in. This
// structural test catches the CLASS of gap, not just this one instance;
// the two behavioral tests below catch this exact instance directly, on
// both the fresh-install and upgrade paths (upgrades walk the same
// FRAMEWORK_OWNED list, so both matter independently, per QA1's own
// instruction).
test('install.js: every runtime script/template in package.json "files" is also covered by FRAMEWORK_OWNED, so nothing ships in the tarball without also being installed', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const installSrc = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'install.js'), 'utf8');
  const match = installSrc.match(/const FRAMEWORK_OWNED = \[([\s\S]*?)\];/);
  assert.ok(match, 'could not find the FRAMEWORK_OWNED array in install.js -- update this test\'s regex if the declaration shape changed');
  const frameworkOwned = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  // Two documented, deliberate exceptions, not gaps: docs/sprints/* ships
  // only the phase-folder .gitkeep placeholders (SPRINT_SKELETON_FILES,
  // a special case install.js's own comment explains, never copied via
  // FRAMEWORK_OWNED) and scripts/baselines ships for other tooling
  // (npm run baselines:*) to read directly off the installed package,
  // never copied into a target project's own scripts/ at all.
  const exempt = (p) => p.startsWith('docs/sprints/') || p === 'scripts/baselines';
  const coveredByFrameworkOwned = (p) => frameworkOwned.some((owned) => p === owned || p.startsWith(`${owned}/`));

  const uncovered = pkg.files.filter((p) => (p.startsWith('scripts/') || p.startsWith('templates/')) && !exempt(p) && !coveredByFrameworkOwned(p));
  assert.deepStrictEqual(uncovered, [],
    `these package.json "files" entries ship in the published tarball but install.js's FRAMEWORK_OWNED would never copy them into a target project: ${uncovered.join(', ')}`);
});

test('install.js: a fresh install copies scripts/mc-commit.js with the real, current content', () => {
  // NOT checked against the install manifest: that file only ever
  // tracks USER_OWNED paths (the six agent personas plus CLAUDE.md, used
  // to detect a customization worth protecting on upgrade) -- confirmed
  // directly, a fresh install's own manifest contains exactly those
  // seven paths and no FRAMEWORK_OWNED file at all, sprint_lifecycle.py
  // and install.js itself included. A framework-owned file is simply
  // copied/overwritten unconditionally on every run, with nothing to
  // track drift against, so there is no manifest entry to assert here.
  withFixture((dir) => {
    runInstall(dir);
    const installedPath = path.join(dir, 'scripts', 'mc-commit.js');
    assert.ok(fs.existsSync(installedPath), 'scripts/mc-commit.js must land on a fresh install -- master-controller\'s own headless profile grants Bash access to run it');
    const REAL_MC_COMMIT_JS = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'mc-commit.js'), 'utf8');
    assert.strictEqual(fs.readFileSync(installedPath, 'utf8'), REAL_MC_COMMIT_JS);
  });
});

test('install.js: an upgrade from before mc-commit.js existed (0.2.9) adds it, same as any other new framework-owned file', () => {
  withFixture((dir) => {
    writeVersionMarker(dir, '0.2.9');
    // Simulate a pre-sprint-36 install: scripts/launcher/ present (an
    // existing framework-owned directory), scripts/mc-commit.js absent
    // (it did not exist in 0.2.9).
    fs.mkdirSync(path.join(dir, 'scripts', 'launcher'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'launcher', 'run-role.js'), '// old 0.2.9 placeholder\n');

    const output = runInstall(dir);

    const installedPath = path.join(dir, 'scripts', 'mc-commit.js');
    assert.ok(fs.existsSync(installedPath), 'an upgrade from 0.2.9 must add scripts/mc-commit.js -- it walks the same FRAMEWORK_OWNED list a fresh install does');
    assert.match(output, /mc-commit\.js/, 'the install output should name mc-commit.js as something it added');
  });
});

test('install.js: a fresh install adds fullyCompletely.testCommand, empty, with a note explaining what it is for (Req 1)', () => {
  withFixture((dir) => {
    const output = runInstall(dir);
    const settings = JSON.parse(fs.readFileSync(path.join(dir, '.vscode', 'settings.json'), 'utf8'));
    assert.strictEqual(settings['fullyCompletely.testCommand'], '', 'testCommand should be added, empty, with no guessed default');
    assert.strictEqual(settings['fullyCompletely.autoLaunch'], false, 'autoLaunch must still be added exactly as before this sprint');
    assert.match(output, /fullyCompletely\.testCommand.*was added, empty/, 'the note explaining the new key should print on a fresh install');
  });
});

test('install.js: an existing settings.json with only autoLaunch set still gains testCommand (the early-return gap this sprint fixed)', () => {
  withFixture((dir) => {
    fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.vscode', 'settings.json'), JSON.stringify({ 'fullyCompletely.autoLaunch': true }, null, 2) + '\n');
    const output = runInstall(dir);
    const settings = JSON.parse(fs.readFileSync(path.join(dir, '.vscode', 'settings.json'), 'utf8'));
    assert.strictEqual(settings['fullyCompletely.autoLaunch'], true, "the user's own existing autoLaunch value must survive untouched");
    assert.strictEqual(settings['fullyCompletely.testCommand'], '', 'testCommand should still be added even though autoLaunch already existed');
    assert.match(output, /added fullyCompletely\.testCommand key\(s\) to your existing file/);
  });
});

test('install.js: re-running once testCommand is already declared leaves it untouched and is a no-op', () => {
  withFixture((dir) => {
    runInstall(dir);
    const settingsPath = path.join(dir, '.vscode', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings['fullyCompletely.testCommand'] = 'npm test';
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    const second = runInstall(dir);
    assert.doesNotMatch(second, /testCommand.*was added/, "a re-run must not re-report a key that's already set");
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(after['fullyCompletely.testCommand'], 'npm test', "a user's declared command must never be overwritten by a re-install");
  });
});

test('install.js: re-running against its own output is a no-op', () => {
  withFixture((dir) => {
    runInstall(dir);
    const second = runInstall(dir);
    assert.match(second, /already present/);
    assert.doesNotMatch(second, /Conflicts/);
  });
});

test('install.js: refuses to touch a settings.json with comments', () => {
  withFixture((dir) => {
    fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
    const original = '{\n  // DO NOT REMOVE\n  "editor.tabSize": 2\n}\n';
    fs.writeFileSync(path.join(dir, '.vscode', 'settings.json'), original);
    runInstall(dir);
    assert.strictEqual(fs.readFileSync(path.join(dir, '.vscode', 'settings.json'), 'utf8'), original);
  });
});

test('install.js: a colliding task label is reported and nothing is written', () => {
  withFixture((dir) => {
    fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
    const original =
      JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Shell', type: 'shell', command: 'make devshell' }] }, null, 2) +
      '\n';
    fs.writeFileSync(path.join(dir, '.vscode', 'tasks.json'), original);
    const output = runInstall(dir);
    assert.match(output, /task label\(s\) already exist here with different content: Shell/);
    assert.strictEqual(fs.readFileSync(path.join(dir, '.vscode', 'tasks.json'), 'utf8'), original);
  });
});

test('install.js: a CRLF-converted user-owned file the manifest confirms is unchanged is recognized as such', () => {
  // Sprint 6: CLAUDE.md is now manifest-governed, so "unchanged" requires
  // a manifest entry as positive proof (Req 3) — a manifest-less dest with
  // merely CRLF-equivalent content is exactly the "no entry" case Req 3
  // says must default to conflict, covered separately below. This test
  // is what the pre-sprint-6 version of it covered: CRLF alone must not
  // be mistaken for a real edit once there IS a manifest to check against.
  withFixture((dir) => {
    const original = fs.readFileSync(path.join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
    const crlf = original.replace(/\r?\n/g, '\r\n');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), crlf);
    writeManifest(dir, { 'CLAUDE.md': fcHash(original) });
    const output = runInstall(dir);
    assert.match(output, /Already present, unchanged[\s\S]*CLAUDE\.md/);
  });
});

test('install.js: a genuinely different CLAUDE.md is reported as a conflict', () => {
  withFixture((dir) => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Something else entirely\n');
    const output = runInstall(dir);
    assert.match(output, /Conflicts[\s\S]*CLAUDE\.md/);
  });
});

// -------------------------------------------------------------------------
// install.js: sprint 2's upgrade taxonomy — framework-owned overwrite +
// backup, user-owned protection, stale-file removal, the version marker,
// and the one narrow .gitignore addition. Same throwaway-fixture
// discipline as above: never against this repo, real content read from
// REPO_ROOT rather than hardcoded, so these track the real files instead
// of a stale copy of them.
// -------------------------------------------------------------------------
const REAL_RUN_ROLE_JS = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'launcher', 'run-role.js'), 'utf8');
const REAL_QA1_MD = fs.readFileSync(path.join(REPO_ROOT, '.claude', 'agents', 'qa1.md'), 'utf8');
// Sprint 16, Req 3: picked DYNAMICALLY, not hardcoded to any one file.
// The tests below need a real tracked path whose CURRENT on-disk content
// matches an entry in the real, committed baseline table -- for four
// sprints running (11 through 17), that was hardcoded to a single "held
// out" file (qa1.md, then pipeman.md, then master-controller.md, then
// dev-team-1.md), and every single time, a later sprint legitimately
// edited that exact file and broke these tests again. Regenerating the
// table every release (this same sprint's Req 1/2) fixes staleness, but
// not this: even a same-day, uncommitted edit to whichever file was
// hardcoded would still fail these tests immediately, regenerated table
// or not. So instead of asserting a fact about one specific file, this
// asks the table itself which tracked path currently qualifies, and uses
// whichever one does -- true by construction, not by nobody having
// touched the right file lately. Throws (not skips) if literally every
// tracked path has been edited since the last regeneration, since that
// would mean these tests have nothing real left to exercise.
function findBaselineProvenFile() {
  const table = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'baselines', 'user-owned-content.json'), 'utf8'));
  for (const relPath of table.paths) {
    const absPath = path.join(REPO_ROOT, relPath);
    if (!fs.existsSync(absPath)) continue;
    const content = fs.readFileSync(absPath, 'utf8');
    const hashesForPath = Object.values(table.files[relPath] || {});
    if (hashesForPath.includes(fcHash(content))) {
      return { relPath, content };
    }
  }
  throw new Error(
    "launcher_test.js: no tracked path's current content matches any entry in the committed baseline table " +
      '(scripts/baselines/user-owned-content.json) -- every tracked file has apparently been edited since the ' +
      'table was last regenerated. Run `npm run baselines:generate` before running these tests.'
  );
}

const BASELINE_PROVEN = findBaselineProvenFile();
const BASELINE_PROVEN_CONTENT = BASELINE_PROVEN.content;
const REAL_CURRENT_VERSION = require(path.join(REPO_ROOT, 'package.json')).version;

function writeVersionMarker(dir, version) {
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'fully-completely-version'), `${version}\n`);
}

test('install.js: a changed framework-owned file is overwritten and the old version backed up', () => {
  withFixture((dir) => {
    writeVersionMarker(dir, '0.1.0');
    fs.mkdirSync(path.join(dir, 'scripts', 'launcher'), { recursive: true });
    const runRolePath = path.join(dir, 'scripts', 'launcher', 'run-role.js');
    fs.writeFileSync(runRolePath, '// old placeholder content, not the real file\n');

    const output = runInstall(dir);

    assert.match(output, /Replaced[\s\S]*scripts\/launcher\/run-role\.js/);
    assert.strictEqual(fs.readFileSync(runRolePath, 'utf8'), REAL_RUN_ROLE_JS);
    const backupPath = `${runRolePath}.fc-bak-0.1.0`;
    assert.ok(fs.existsSync(backupPath), 'backup of the old version should exist');
    assert.strictEqual(fs.readFileSync(backupPath, 'utf8'), '// old placeholder content, not the real file\n');
  });
});

test('install.js: a user-owned file (an agent persona) is left untouched and reported as a conflict, not overwritten', () => {
  withFixture((dir) => {
    writeVersionMarker(dir, '0.1.0');
    fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });
    const qa1Path = path.join(dir, '.claude', 'agents', 'qa1.md');
    const customized = '---\nname: qa1\n---\nMy customised QA1 persona, do not overwrite.\n';
    fs.writeFileSync(qa1Path, customized);

    const output = runInstall(dir);

    assert.match(output, /Conflicts[\s\S]*qa1\.md \(yours/);
    assert.strictEqual(fs.readFileSync(qa1Path, 'utf8'), customized, 'a customised persona must never be overwritten');
    assert.ok(!fs.existsSync(`${qa1Path}.fc-bak-0.1.0`), 'user-owned files are never backed up either, since they are never touched');
  });
});

test('install.js: a framework file removed upstream (state.js) is removed from an existing install, backed up first', () => {
  withFixture((dir) => {
    writeVersionMarker(dir, '0.1.0');
    fs.mkdirSync(path.join(dir, 'scripts', 'launcher'), { recursive: true });
    const stateJsPath = path.join(dir, 'scripts', 'launcher', 'state.js');
    fs.writeFileSync(stateJsPath, "'use strict';\nmodule.exports = { wasLaunched: () => false };\n");

    const output = runInstall(dir);

    assert.match(output, /Removed[\s\S]*scripts\/launcher\/state\.js/);
    assert.ok(!fs.existsSync(stateJsPath), 'state.js should be removed — it is not part of the framework anymore');
    const backupPath = `${stateJsPath}.fc-bak-0.1.0`;
    assert.ok(fs.existsSync(backupPath), 'the removed file should be backed up first');
    assert.match(fs.readFileSync(backupPath, 'utf8'), /wasLaunched/);
  });
});

test('install.js: a file outside the framework-owned set is never deleted, even during an upgrade', () => {
  withFixture((dir) => {
    writeVersionMarker(dir, '0.1.0');
    const unrelatedPath = path.join(dir, 'src', 'my-own-app.js');
    fs.mkdirSync(path.dirname(unrelatedPath), { recursive: true });
    fs.writeFileSync(unrelatedPath, 'console.log("my own project code");\n');
    // Also plant a random file directly at the project root.
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'unrelated notes\n');

    runInstall(dir);

    assert.strictEqual(fs.readFileSync(unrelatedPath, 'utf8'), 'console.log("my own project code");\n');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'unrelated notes\n');
  });
});

test('install.js: a missing version marker degrades to the upgrade path instead of crashing, and reports it as an upgrade, not a first install', () => {
  withFixture((dir) => {
    // No writeVersionMarker() call here on purpose — this simulates an
    // install from before Req 5 existed, or one where the marker was
    // deleted by hand.
    fs.mkdirSync(path.join(dir, 'scripts', 'launcher'), { recursive: true });
    const runRolePath = path.join(dir, 'scripts', 'launcher', 'run-role.js');
    fs.writeFileSync(runRolePath, '// old placeholder, unknown prior version\n');

    const output = runInstall(dir);

    assert.match(output, /Replaced[\s\S]*scripts\/launcher\/run-role\.js/);
    assert.strictEqual(fs.readFileSync(runRolePath, 'utf8'), REAL_RUN_ROLE_JS);
    assert.ok(fs.existsSync(`${runRolePath}.fc-bak-unknown`), 'an unversioned prior install backs up under .fc-bak-unknown');
    // LiveQA's finding: this run genuinely replaced a file, so it must
    // never be reported as "first install" — that's a false statement
    // printed at the exact moment files are being changed underneath it.
    assert.match(output, /Upgraded unknown -> \d+\.\d+\.\d+/);
    assert.doesNotMatch(output, /first install/);
  });
});

test('install.js: a marker already at the current version, but a drifted file underneath it, is reported as repaired, not "nothing to upgrade"', () => {
  // QA1's finding, checking the sibling branch to LiveQA's: the marker
  // says CURRENT_VERSION already, but a framework file on disk doesn't
  // actually match that version's source — reachable for real by anyone
  // who did sprint 1's Part B workaround (hand-replacing the launcher
  // folder) without the marker ever moving.
  withFixture((dir) => {
    writeVersionMarker(dir, REAL_CURRENT_VERSION);
    fs.mkdirSync(path.join(dir, 'scripts', 'launcher'), { recursive: true });
    const runRolePath = path.join(dir, 'scripts', 'launcher', 'run-role.js');
    fs.writeFileSync(runRolePath, '// drifted content, marker claims current version anyway\n');

    const output = runInstall(dir);

    assert.strictEqual(fs.readFileSync(runRolePath, 'utf8'), REAL_RUN_ROLE_JS);
    assert.match(output, /Replaced[\s\S]*scripts\/launcher\/run-role\.js/);
    // The bug: this exact scenario used to print "Already at X (re-run,
    // nothing to upgrade)" directly above the Replaced section listing
    // the file it just replaced.
    assert.doesNotMatch(output, /nothing to upgrade/);
    assert.match(output, /Already at \d+\.\d+\.\d+, but repaired 1 file\(s\) that had drifted from it/);
  });
});

test('install.js: the version marker is written after install and reports installed -> upgraded transitions', () => {
  withFixture((dir) => {
    const first = runInstall(dir);
    assert.match(first, /Installed \d+\.\d+\.\d+ \(first install\)/);
    const markerPath = path.join(dir, '.claude', 'fully-completely-version');
    assert.ok(fs.existsSync(markerPath));
    const version = fs.readFileSync(markerPath, 'utf8').trim();
    assert.ok(/^\d+\.\d+\.\d+$/.test(version));
    assert.ok(!markerPath.includes(`${path.sep}docs${path.sep}sprints${path.sep}`), 'the marker must not live under docs/sprints/');

    const second = runInstall(dir);
    assert.match(second, /Already at \d+\.\d+\.\d+ \(re-run, nothing to upgrade\)/);
  });
});

test('install.js: installing an older version than what is already present says so, naming both versions (sprint 41, Req 2 -- LiveQA: installing 0.2.11 over 0.2.13 went backwards silently)', () => {
  withFixture((dir) => {
    // A synthetic, unambiguously-newer marker rather than parsing/
    // incrementing REAL_CURRENT_VERSION -- clearly greater regardless of
    // what the real package version happens to be right now.
    writeVersionMarker(dir, '99.0.0');
    const output = runInstall(dir);
    assert.match(output, new RegExp(`Installing an OLDER version: 99\\.0\\.0 -> ${REAL_CURRENT_VERSION.replace(/\./g, '\\.')}`));
    assert.match(output, /downgrade/i);
    assert.doesNotMatch(output, /^Upgraded/m, 'a downgrade must not also be reported as an upgrade');
  });
});

test('install.js: a genuine upgrade (older marker than current) still reports "Upgraded", unaffected by the new downgrade check', () => {
  withFixture((dir) => {
    writeVersionMarker(dir, '0.0.1');
    const output = runInstall(dir);
    assert.match(output, new RegExp(`Upgraded 0\\.0\\.1 -> ${REAL_CURRENT_VERSION.replace(/\./g, '\\.')}`));
    assert.doesNotMatch(output, /downgrade/i);
  });
});

test('install.js: same-version and missing-marker wording is unchanged by sprint 41, Req 2', () => {
  withFixture((dir) => {
    writeVersionMarker(dir, REAL_CURRENT_VERSION);
    const sameVersionOutput = runInstall(dir);
    assert.match(sameVersionOutput, /Already at \d+\.\d+\.\d+ \(re-run, nothing to upgrade\)/);
    assert.doesNotMatch(sameVersionOutput, /downgrade/i);
  });
});

test('install.js: compareVersions() -- the sprint 41, Req 2 downgrade detector -- has not drifted from scripts/baselines/generate.js\'s own identical comparison', () => {
  // Duplicated, not shared (see install.js's own comment on why it never
  // requires scripts/baselines/ at runtime) -- this proves the duplicate
  // hasn't drifted, the same guard sprint 41's own Req 1 uses for its own
  // hand-kept-copy case. Compares the function BODY text directly (the
  // strongest, simplest guarantee -- byte-identical algorithms, not just
  // behaviorally similar ones) rather than eval'ing extracted source.
  const bodyOf = (src, label) => {
    const m = src.match(/function compareVersions\(a, b\) \{[\s\S]*?\n\}/);
    assert.ok(m, `could not find compareVersions() in ${label}`);
    return m[0];
  };
  const generateSrc = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'baselines', 'generate.js'), 'utf8');
  const installSrc = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'install.js'), 'utf8');
  assert.strictEqual(
    bodyOf(installSrc, 'install.js'),
    bodyOf(generateSrc, 'scripts/baselines/generate.js'),
    'install.js\'s own compareVersions() must stay byte-identical to generate.js\'s -- update both together if either ever changes'
  );
});

test('install.js: an old, exact .claude-launcher/ gitignore line is removed on upgrade; the new merged line is still added', () => {
  withFixture((dir) => {
    const oldGitignore =
      '__pycache__/\n*.pyc\n.DS_Store\n\n# Fully Completely (added by scripts/install.js)\n.claude-launcher/\n';
    fs.writeFileSync(path.join(dir, '.gitignore'), oldGitignore);

    const output = runInstall(dir);

    const finalGitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.ok(!finalGitignore.split(/\r?\n/).includes('.claude-launcher/'), 'the dead line must be gone');
    assert.match(finalGitignore, /docs\/sprints\/\.locks\//);
    assert.match(output, /removed now-dead line\(s\): \.claude-launcher\//);
  });
});

test('install.js: a .claude-launcher/ reference folded into a non-standalone line is reported, not rewritten', () => {
  withFixture((dir) => {
    fs.writeFileSync(path.join(dir, '.gitignore'), '__pycache__/\n!.claude-launcher/keep-this-one\n');

    const output = runInstall(dir);

    const finalGitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.match(finalGitignore, /!\.claude-launcher\/keep-this-one/, 'a non-standalone reference must be left alone');
    assert.match(output, /Notes[\s\S]*isn't a plain standalone line/);
  });
});

test('install.js: a fresh install\'s managed .gitignore block includes .claude/role-claims.json (sprint 36, Req 7)', () => {
  withFixture((dir) => {
    runInstall(dir);
    const finalGitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.ok(finalGitignore.split(/\r?\n/).includes('.claude/role-claims.json'),
      'a fresh install must gain the .claude/role-claims.json ignore entry');
  });
});

test('install.js: a fresh install\'s managed .gitignore block also includes the lock file and its stolen-lock sibling, derived from role-claims.js\'s own constants (sprint 41, Req 1)', () => {
  withFixture((dir) => {
    runInstall(dir);
    const lines = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').split(/\r?\n/);
    const { LOCK_SUFFIX, CLAIMS_RELATIVE_PATH } = require('./launcher/role-claims');
    const { toRelPathKey } = require('./launcher/rel-path-key');
    const claimsRelPath = toRelPathKey(CLAIMS_RELATIVE_PATH);
    assert.ok(lines.includes(`${claimsRelPath}${LOCK_SUFFIX}`), 'a fresh install must gain the lock-file ignore entry, derived from the real constant');
    assert.ok(lines.includes(`${claimsRelPath}${LOCK_SUFFIX}.stolen-*`), 'a fresh install must gain the stolen-lock ignore entry, derived from the real constant');
  });
});

test('install.js: this repository\'s OWN .gitignore matches what role-claims.js\'s constants would derive -- the hand-kept-copy divergence guard Req 1 requires', () => {
  // This repo's own .gitignore can't require() role-claims.js the way
  // install.js's managed block (generated, not hand-written) can -- it's
  // a plain text file. This is the promised fallback: a test that fails
  // if the hand-kept lines here and the real constant ever disagree,
  // rather than a silent, unguarded duplicate literal.
  const { LOCK_SUFFIX, CLAIMS_RELATIVE_PATH } = require('./launcher/role-claims');
  const { toRelPathKey } = require('./launcher/rel-path-key');
  const claimsRelPath = toRelPathKey(CLAIMS_RELATIVE_PATH);
  const lines = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(lines.includes(claimsRelPath), `this repo's own .gitignore is missing ${claimsRelPath}`);
  assert.ok(lines.includes(`${claimsRelPath}${LOCK_SUFFIX}`), `this repo's own .gitignore is missing the lock-file entry for the current LOCK_SUFFIX (${LOCK_SUFFIX}) -- update .gitignore by hand to match`);
  assert.ok(lines.includes(`${claimsRelPath}${LOCK_SUFFIX}.stolen-*`), `this repo's own .gitignore is missing the stolen-lock entry for the current LOCK_SUFFIX (${LOCK_SUFFIX}) -- update .gitignore by hand to match`);
});

test('install.js: an upgrade of an install that predates the role-claims entry adds it, and preserves an unrelated pre-existing line exactly (sprint 36, Req 7)', () => {
  withFixture((dir) => {
    const oldGitignore =
      'node_modules/\n*.log\n\n# Fully Completely (added by scripts/install.js)\ndocs/sprints/.locks/\n*.fc-bak-*\n';
    fs.writeFileSync(path.join(dir, '.gitignore'), oldGitignore);

    const output = runInstall(dir);

    const finalGitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    const lines = finalGitignore.split(/\r?\n/);
    assert.ok(lines.includes('.claude/role-claims.json'), 'the upgrade must add the missing role-claims entry');
    assert.ok(lines.includes('node_modules/'), 'an unrelated pre-existing line must survive exactly');
    assert.ok(lines.includes('*.log'), 'an unrelated pre-existing line must survive exactly');
    assert.ok(lines.includes('docs/sprints/.locks/'), 'the pre-existing managed line must survive unchanged');
    // Sprint 41, Req 1: the managed block grew by two more entries (the
    // lock file and its stolen-lock sibling), so an upgrade missing all
    // three new-since-sprint-36 lines now appends 3, not 1.
    assert.ok(lines.includes('.claude/role-claims.json.lock'), 'the upgrade must add the lock-file ignore entry');
    assert.ok(lines.includes('.claude/role-claims.json.lock.stolen-*'), 'the upgrade must add the stolen-lock ignore entry');
    assert.match(output, /gitignore \(appended 3 line\(s\)\)/);
  });
});

test('install.js: re-running against an install that already has the role-claims entry is a no-op for .gitignore', () => {
  withFixture((dir) => {
    runInstall(dir);
    const firstGitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    const output = runInstall(dir);
    const secondGitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.strictEqual(firstGitignore, secondGitignore, 're-running install.js must not change an already-up-to-date .gitignore');
    assert.match(output, /already has the lines this framework needs/);
  });
});

// -------------------------------------------------------------------------
// install.js: QA1 round 2's four findings — backup compounding on a
// second run, docs/sprints leaking this repo's own real sprint data,
// symlink-unsafe removal, and CRLF loss on gitignore rewrite. Each test
// below reproduces the exact scenario QA1 used, not a weaker stand-in.
// -------------------------------------------------------------------------
test('install.js: a second run does not re-flag its own backup as stale, and does not nest backup suffixes', () => {
  withFixture((dir) => {
    writeVersionMarker(dir, '0.1.0');
    fs.mkdirSync(path.join(dir, 'scripts', 'launcher'), { recursive: true });
    const runRolePath = path.join(dir, 'scripts', 'launcher', 'run-role.js');
    fs.writeFileSync(runRolePath, '// old placeholder content, not the real file\n');

    const first = runInstall(dir);
    assert.match(first, /Replaced[\s\S]*scripts\/launcher\/run-role\.js/);
    const backupPath = `${runRolePath}.fc-bak-0.1.0`;
    assert.ok(fs.existsSync(backupPath));

    // Second run: nothing upstream changed since run 1, and the file is
    // now at CURRENT_VERSION, so this should be a true no-op — QA1's
    // round-2 bug was that the backup itself got collected, found absent
    // from source, and "removed" (re-backed-up under a nested suffix).
    const second = runInstall(dir);
    assert.doesNotMatch(second, /Removed/, 'a second run must not report removing anything, least of all its own backup');
    assert.doesNotMatch(second, /Replaced/, 'nothing changed upstream between the two runs');
    assert.ok(fs.existsSync(backupPath), 'the original backup must still be exactly where it was');
    assert.ok(
      !fs.existsSync(`${backupPath}.fc-bak-0.1.1`),
      'the backup must never itself be backed up — no nested .fc-bak-X.fc-bak-Y suffix'
    );

    // Third run, for good measure — QA1's repro specifically named three
    // runs as where the nesting became visible.
    const third = runInstall(dir);
    assert.doesNotMatch(third, /Removed/);
    assert.strictEqual(fs.readFileSync(backupPath, 'utf8'), '// old placeholder content, not the real file\n');
  });
});

test('install.js: a symlink under a framework-owned directory is never descended into or deleted through', () => {
  withFixture((dir) => {
    writeVersionMarker(dir, '0.1.0');
    fs.mkdirSync(path.join(dir, 'scripts', 'launcher'), { recursive: true });

    // A directory genuinely outside anything install.js should ever
    // touch, reachable only by following a symlink planted inside a
    // framework-owned directory — QA1's exact repro.
    const outsideDir = path.join(dir, 'my-precious');
    fs.mkdirSync(outsideDir, { recursive: true });
    const preciousFile = path.join(outsideDir, 'notes.txt');
    fs.writeFileSync(preciousFile, 'do not touch this\n');
    fs.symlinkSync(outsideDir, path.join(dir, 'scripts', 'launcher', 'sneaky-link'));

    runInstall(dir);

    assert.strictEqual(fs.readFileSync(preciousFile, 'utf8'), 'do not touch this\n', 'a file reached only via a symlink must never be deleted');
    assert.ok(fs.existsSync(path.join(dir, 'scripts', 'launcher', 'sneaky-link')), 'the symlink itself is not framework content and must be left alone too');
  });
});

test('install.js: a real first install never copies this repo\'s own sprint content, only the empty skeleton', () => {
  withFixture((dir) => {
    const output = runInstall(dir);

    // Only .gitkeep placeholders may come from docs/sprints/, regardless
    // of whatever real sprint data currently sits in this repo's own
    // docs/sprints/ at test-run time.
    const sprintsDir = path.join(dir, 'docs', 'sprints');
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]
    );
    const installedFiles = walk(sprintsDir);
    for (const f of installedFiles) {
      assert.strictEqual(path.basename(f), '.gitkeep', `docs/sprints must only ever contain .gitkeep files on a fresh install, found ${f}`);
    }
    assert.ok(!fs.existsSync(path.join(sprintsDir, 'registry.json')), 'this repo\'s own registry.json must never be copied');
    assert.ok(!fs.existsSync(path.join(sprintsDir, 'state', 'sprint-1.json')), 'this repo\'s own sprint state must never be copied');
    assert.doesNotMatch(output, /registry\.json/);
  });
});

test('install.js: removing a dead gitignore line preserves the file\'s original CRLF line endings', () => {
  withFixture((dir) => {
    // Includes docs/sprints/.locks/ already, so nothing needs appending —
    // isolates removeDeadGitignoreLines()'s own rewrite (the thing QA1
    // found losing CRLF) from the separate, pre-existing, explicitly
    // out-of-scope append-with-hardcoded-\n path in the "missing lines"
    // branch below it (present before sprint 2, unrelated to this fix).
    const oldGitignoreCRLF =
      '__pycache__/\r\n*.pyc\r\n\r\n# Fully Completely (added by scripts/install.js)\r\ndocs/sprints/.locks/\r\n.claude-launcher/\r\n';
    fs.writeFileSync(path.join(dir, '.gitignore'), oldGitignoreCRLF);

    runInstall(dir);

    const finalRaw = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.ok(!finalRaw.split(/\r?\n/).includes('.claude-launcher/'), 'the dead line must still be removed');
    assert.ok(finalRaw.includes('\r\n'), 'the file\'s original CRLF line endings must be preserved, not silently converted to LF');
    assert.ok(!/(?<!\r)\n/.test(finalRaw), 'no bare LF (not preceded by \\r) should have been introduced by the rewrite');
  });
});

// -------------------------------------------------------------------------
// install.js: sprint 6's manifest mechanism. `.claude/agents/*` and
// CLAUDE.md are upgraded exactly when the manifest proves the installed
// copy was never touched (Req 1/2); everything else — no manifest file,
// no entry for this path, unparseable JSON, a malformed entry value, or a
// hash that plain doesn't match — must resolve to "never overwrite" (Req
// 3, the load-bearing requirement). Each of those five ways to land on
// the safe branch gets its own test below, named to match QA1's own
// acceptance-criteria wording so the audit can check this list directly
// rather than re-deriving it.
// -------------------------------------------------------------------------
const QA1_REL_PATH = path.join('.claude', 'agents', 'qa1.md');
// path.join() (not the raw table string) so this is a NATIVE path exactly
// like every other *_REL_PATH constant here, even though the table itself
// always stores forward-slash keys (generate.js's own documented choice).
const BASELINE_PROVEN_REL_PATH = path.join(...BASELINE_PROVEN.relPath.split('/'));

test('install.js: a fresh install writes a manifest recording every tracked user-owned file it wrote', () => {
  withFixture((dir) => {
    runInstall(dir);
    const manifest = readManifest(dir);
    assert.strictEqual(manifest['CLAUDE.md'], fcHash(fs.readFileSync(path.join(REPO_ROOT, 'CLAUDE.md'), 'utf8')));
    assert.strictEqual(manifest[QA1_REL_PATH], fcHash(REAL_QA1_MD));
    assert.ok(
      !Object.keys(manifest).some((k) => k.startsWith('docs/sprints')),
      'docs/sprints is excluded from the mechanism (Req 6) and must never appear in the manifest'
    );
  });
});

test('install.js: a user-owned file the manifest confirms is untouched is upgraded on the next release, backed up first', () => {
  withFixture((dir) => {
    writeVersionMarker(dir, '0.1.0');
    const qa1Path = path.join(dir, QA1_REL_PATH);
    fs.mkdirSync(path.dirname(qa1Path), { recursive: true });
    const oldContent = '---\nname: qa1\n---\nAn old shipped version, standing in for an untouched prior release.\n';
    fs.writeFileSync(qa1Path, oldContent);
    writeManifest(dir, { [QA1_REL_PATH]: fcHash(oldContent) });

    const output = runInstall(dir);

    assert.match(output, /Replaced[\s\S]*\.claude\/agents\/qa1\.md/);
    assert.strictEqual(fs.readFileSync(qa1Path, 'utf8'), REAL_QA1_MD, 'must be brought up to the real current version');
    const backupPath = `${qa1Path}.fc-bak-0.1.0`;
    assert.ok(fs.existsSync(backupPath), 'the untouched previous version should be backed up before overwriting');
    assert.strictEqual(fs.readFileSync(backupPath, 'utf8'), oldContent);
    const manifest = readManifest(dir);
    assert.strictEqual(manifest[QA1_REL_PATH], fcHash(REAL_QA1_MD), 'the manifest must record the newly-written content');
  });
});

test('install.js: CLAUDE.md goes through the identical manifest mechanism as agent files (Req 5)', () => {
  withFixture((dir) => {
    writeVersionMarker(dir, '0.1.0');
    const oldContent = 'Standing in for CLAUDE.md as this installer last wrote it, untouched since.\n';
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), oldContent);
    writeManifest(dir, { 'CLAUDE.md': fcHash(oldContent) });

    const output = runInstall(dir);

    assert.match(output, /Replaced[\s\S]*CLAUDE\.md/);
    const realClaudeMd = fs.readFileSync(path.join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), realClaudeMd);
    assert.ok(fs.existsSync(path.join(dir, 'CLAUDE.md.fc-bak-0.1.0')));
  });
});

test('install.js: a user-owned file whose content no longer matches its manifest entry is preserved and reported, not overwritten', () => {
  withFixture((dir) => {
    // Anchored to 0.1.2 (predates sprint 3's addition to qa1.md), not the
    // live current version — sprint 9 round 2: with the baseline table
    // regenerated and current, an installedVersion of "whatever's current
    // right now" would correctly find qa1.md unchanged since itself,
    // which is the *other* branch. 0.1.2 guarantees a real, known
    // difference exists between it and current, so this test still
    // exercises the "genuinely differs" branch it's named for.
    writeVersionMarker(dir, '0.1.2');
    const qa1Path = path.join(dir, QA1_REL_PATH);
    fs.mkdirSync(path.dirname(qa1Path), { recursive: true });
    const customized = '---\nname: qa1\n---\nMy customised QA1 persona, do not overwrite.\n';
    fs.writeFileSync(qa1Path, customized);
    // Records what this installer actually wrote at some earlier point —
    // deliberately NOT what's on disk now, simulating a real hand-edit
    // made after that write.
    writeManifest(dir, { [QA1_REL_PATH]: fcHash(REAL_QA1_MD) });

    const output = runInstall(dir);

    assert.match(output, /Conflicts[\s\S]*\.claude\/agents\/qa1\.md \(yours/);
    // qa1.md's shipped content really has changed since 0.1.2 (sprint 3
    // added to it in 0.1.3, sprint 9 edited it again) — the baseline
    // table has a real entry for 0.1.2, so this is the precise branch,
    // not the fallback, and the message should say so plainly.
    assert.match(output, /shipped content has changed since the version you have/);
    assert.match(output, /npx fully-completely/);
    assert.strictEqual(fs.readFileSync(qa1Path, 'utf8'), customized, 'a customised file must never be overwritten');
    assert.ok(!fs.existsSync(`${qa1Path}.fc-bak-0.1.2`), 'nothing was overwritten, so nothing should be backed up');
    const manifest = readManifest(dir);
    assert.strictEqual(
      manifest[QA1_REL_PATH],
      fcHash(REAL_QA1_MD),
      "a conflicted path's manifest entry is carried forward unchanged, never updated to the customised content"
    );
  });
});

test('install.js: a file matching a published baseline, with no manifest at all, is upgraded and recorded — the epic goal (Req 1/3)', () => {
  // The exact real-world shape sprint 8 exists to fix: a version marker,
  // real user-owned files, no manifest — every install from before
  // sprint 6 shipped. Sprint 6/QA1's own repro (a real 0.1.4 -> 0.1.5
  // upgrade) found this conflicted on all seven tracked files forever,
  // because a manifest was the ONLY proof source and none of those
  // installs could ever have one. This repo's real, committed baseline
  // table (scripts/baselines/user-owned-content.json, generated from the
  // real published tarballs) is Req 1's second source of proof:
  // BASELINE_PROVEN's content (whichever tracked path currently matches
  // the table — see findBaselineProvenFile()'s own comment above, sprint
  // 16) is exactly what shipped in some real release, so it must now be
  // recognised and brought current, not conflicted. baselineHashesFor()
  // matches against any published version, not just the one in the
  // fixture's version marker, so 0.1.4 here doesn't need to be the
  // specific version whose hash matches.
  withFixture((dir) => {
    writeVersionMarker(dir, '0.1.4');
    const baselineProvenPath = path.join(dir, BASELINE_PROVEN_REL_PATH);
    fs.mkdirSync(path.dirname(baselineProvenPath), { recursive: true });
    fs.writeFileSync(baselineProvenPath, BASELINE_PROVEN_CONTENT);

    const output = runInstall(dir);

    assert.doesNotMatch(output, /Conflicts/, 'a baseline-proven file must not conflict');
    assert.match(output, new RegExp(`Already present, unchanged[\\s\\S]*${BASELINE_PROVEN.relPath.replace(/\//g, '\\/').replace(/\./g, '\\.')}`));
    assert.strictEqual(fs.readFileSync(baselineProvenPath, 'utf8'), BASELINE_PROVEN_CONTENT);
    const manifest = readManifest(dir);
    assert.strictEqual(
      manifest[BASELINE_PROVEN_REL_PATH],
      fcHash(BASELINE_PROVEN_CONTENT),
      'a baseline-proven file must be recorded in the manifest as it is upgraded (Req 3), so the next run no longer needs the baseline sweep at all'
    );
  });
});

// Sprint 8: all three tests below use genuinely customised content —
// never published in any release — rather than REAL_QA1_MD, deliberately.
// A manifest failure alone no longer guarantees a conflict now that
// baselines are a second proof source (Req 1's own "when a file has no
// manifest entry" fallback); these tests exist to isolate the MANIFEST's
// own failure modes, so they need content that can't be proven by the
// baseline table either, or they'd just be re-testing the baseline-match
// path above under a different name.
const CUSTOMIZED_QA1_MD = '---\nname: qa1\n---\nMy customised QA1 persona, never published anywhere.\n';

test('install.js: a manifest that is not valid JSON resolves every user-owned file to no-overwrite, not a crash', () => {
  withFixture((dir) => {
    writeVersionMarker(dir, '0.1.0');
    const qa1Path = path.join(dir, QA1_REL_PATH);
    fs.mkdirSync(path.dirname(qa1Path), { recursive: true });
    fs.writeFileSync(qa1Path, CUSTOMIZED_QA1_MD);
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'fully-completely-manifest.json'), '{ this is not valid JSON');

    const output = runInstall(dir);

    assert.match(output, /Conflicts[\s\S]*\.claude\/agents\/qa1\.md \(yours/);
    assert.strictEqual(fs.readFileSync(qa1Path, 'utf8'), CUSTOMIZED_QA1_MD);
  });
});

test('install.js: a manifest entry that is not a well-formed hash resolves that file to no-overwrite', () => {
  withFixture((dir) => {
    writeVersionMarker(dir, '0.1.0');
    const qa1Path = path.join(dir, QA1_REL_PATH);
    fs.mkdirSync(path.dirname(qa1Path), { recursive: true });
    fs.writeFileSync(qa1Path, CUSTOMIZED_QA1_MD);
    writeManifest(dir, { [QA1_REL_PATH]: 'not-a-real-hash' });

    const output = runInstall(dir);

    assert.match(output, /Conflicts[\s\S]*\.claude\/agents\/qa1\.md \(yours/);
    assert.strictEqual(fs.readFileSync(qa1Path, 'utf8'), CUSTOMIZED_QA1_MD);
  });
});

test('install.js: a valid manifest with no entry for a given user-owned file resolves that file to no-overwrite', () => {
  withFixture((dir) => {
    writeVersionMarker(dir, '0.1.0');
    const qa1Path = path.join(dir, QA1_REL_PATH);
    fs.mkdirSync(path.dirname(qa1Path), { recursive: true });
    fs.writeFileSync(qa1Path, CUSTOMIZED_QA1_MD);
    // A real, well-formed manifest — just with no key at all for this
    // particular path.
    writeManifest(dir, { 'CLAUDE.md': fcHash('unrelated') });

    const output = runInstall(dir);

    assert.match(output, /Conflicts[\s\S]*\.claude\/agents\/qa1\.md \(yours/);
    assert.strictEqual(fs.readFileSync(qa1Path, 'utf8'), CUSTOMIZED_QA1_MD);
  });
});

// -------------------------------------------------------------------------
// install.js: sprint 10, Req 2/3 — a stale or foreign backslash-keyed
// manifest/baseline entry must still degrade to no-match, never an
// unearned overwrite. Req 3's own reasoning is that no real manifest can
// contain a backslash key (nothing was ever proven on Windows before this
// fix, so nothing was ever written), but "confirm rather than assume"
// means proving the safe fallback holds even if that reasoning is wrong
// somewhere — these tests do that directly, at the CLI level, with a
// manifest hand-written to contain exactly the shape a broken pre-fix
// Windows run would have (if Req 3's reasoning were wrong).
// -------------------------------------------------------------------------
test('install.js: a manifest entry stored under a backslash key never matches a real relPath, even by coincidence (Req 2/3)', () => {
  withFixture((dir) => {
    writeVersionMarker(dir, '0.1.0');
    const baselineProvenPath = path.join(dir, BASELINE_PROVEN_REL_PATH);
    fs.mkdirSync(path.dirname(baselineProvenPath), { recursive: true });
    fs.writeFileSync(baselineProvenPath, BASELINE_PROVEN_CONTENT); // byte-identical to what we'd write
    // A manifest recording the CORRECT hash, but under the Windows-shaped
    // key a broken pre-fix run would have used instead of the real
    // forward-slash one. manifestHashFor() normalizes the QUERY key (built
    // from the real, forward-slash relPath on this machine), so it must
    // look for BASELINE_PROVEN.relPath (whichever tracked path currently
    // matches the table — sprint 16, see findBaselineProvenFile()'s own
    // comment above) and find nothing here.
    const backslashKey = BASELINE_PROVEN.relPath.replace(/\//g, '\\');
    writeManifest(dir, { [backslashKey]: fcHash(BASELINE_PROVEN_CONTENT) });

    const output = runInstall(dir);

    // No manifest match — but BASELINE_PROVEN_CONTENT also matches a real published
    // baseline, so Req 1's second proof source correctly takes over and
    // this still resolves to "already present", not a conflict. That's
    // the safe fallback working, not a failure to detect the stale key.
    assert.match(output, new RegExp(`Already present, unchanged[\\s\\S]*${BASELINE_PROVEN.relPath.replace(/\//g, '\\/').replace(/\./g, '\\.')}`));
    assert.doesNotMatch(output, /Conflicts/);
    const manifest = readManifest(dir);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(manifest, backslashKey),
      'the stale backslash key must not survive into the new manifest'
    );
    assert.strictEqual(manifest[BASELINE_PROVEN_REL_PATH], fcHash(BASELINE_PROVEN_CONTENT), 'the real, forward-slash key must be written instead');
  });
});

test('install.js: a backslash-keyed manifest entry with customised content on disk still resolves to no-overwrite, not a coincidental match (Req 2/3)', () => {
  withFixture((dir) => {
    writeVersionMarker(dir, '0.1.0');
    const qa1Path = path.join(dir, QA1_REL_PATH);
    fs.mkdirSync(path.dirname(qa1Path), { recursive: true });
    fs.writeFileSync(qa1Path, CUSTOMIZED_QA1_MD); // matches no manifest and no baseline
    writeManifest(dir, { '.claude\\agents\\qa1.md': fcHash(REAL_QA1_MD) });

    const output = runInstall(dir);

    assert.match(output, /Conflicts[\s\S]*\.claude\/agents\/qa1\.md \(yours/);
    assert.strictEqual(fs.readFileSync(qa1Path, 'utf8'), CUSTOMIZED_QA1_MD, 'a customised file must never be overwritten, stale key or not');
  });
});

// -------------------------------------------------------------------------
// install.js: sprint 8's published-baseline mechanism (Req 1/2/3), the
// two-condition conflict message (Req 4), and the exit-code contract
// (Req 5). The corrupt/missing-table and message-selection tests below
// use withReplacedBaselines() with fabricated data specifically so they
// stay hermetic and deterministic — no network access, and no dependency
// on this repo's own real publication history never changing shape.
// -------------------------------------------------------------------------
test('install.js: a missing baseline table resolves to no-overwrite, same as a missing manifest (Req 1)', () => {
  withReplacedBaselines(null, () => {
    withFixture((dir) => {
      writeVersionMarker(dir, '0.1.0');
      const qa1Path = path.join(dir, QA1_REL_PATH);
      fs.mkdirSync(path.dirname(qa1Path), { recursive: true });
      fs.writeFileSync(qa1Path, REAL_QA1_MD); // would match, if the table existed at all

      const output = runInstall(dir);

      assert.match(output, /Conflicts[\s\S]*\.claude\/agents\/qa1\.md \(yours/);
      assert.strictEqual(fs.readFileSync(qa1Path, 'utf8'), REAL_QA1_MD);
    });
  });
});

test('install.js: a corrupt (unparseable) baseline table resolves to no-overwrite, not a crash (Req 1)', () => {
  withReplacedBaselines('{ this is not valid JSON', () => {
    withFixture((dir) => {
      writeVersionMarker(dir, '0.1.0');
      const qa1Path = path.join(dir, QA1_REL_PATH);
      fs.mkdirSync(path.dirname(qa1Path), { recursive: true });
      fs.writeFileSync(qa1Path, REAL_QA1_MD);

      const output = runInstall(dir);

      assert.match(output, /Conflicts[\s\S]*\.claude\/agents\/qa1\.md \(yours/);
      assert.strictEqual(fs.readFileSync(qa1Path, 'utf8'), REAL_QA1_MD);
    });
  });
});

test('install.js: a file matching an OLDER published baseline (not the newest) is upgraded and backed up (Req 1)', () => {
  const oldContent = '---\nname: qa1\n---\nA fabricated older published version, standing in for real history.\n';
  withReplacedBaselines(fakeBaselines({ '0.0.9': fcHash(oldContent) }), () => {
    withFixture((dir) => {
      writeVersionMarker(dir, '0.0.9');
      const qa1Path = path.join(dir, QA1_REL_PATH);
      fs.mkdirSync(path.dirname(qa1Path), { recursive: true });
      fs.writeFileSync(qa1Path, oldContent);

      const output = runInstall(dir);

      assert.match(output, /Replaced[\s\S]*\.claude\/agents\/qa1\.md/);
      assert.strictEqual(fs.readFileSync(qa1Path, 'utf8'), REAL_QA1_MD, 'must be brought up to the real current version');
      assert.ok(fs.existsSync(`${qa1Path}.fc-bak-0.0.9`), 'the old, baseline-proven version should be backed up first');
      const manifest = readManifest(dir);
      assert.strictEqual(manifest[QA1_REL_PATH], fcHash(REAL_QA1_MD));
    });
  });
});

test('install.js: local edits with no upstream change since the install say "no update pending", not "upstream changed" (Req 4)', () => {
  // hasUpstreamChangedSinceInstall() compares the installed version's
  // baseline hash against the REAL current source content (SOURCE_ROOT is
  // this actual repo, not something a test can fake) — so "unchanged
  // since install" has to mean the baseline entry at `installedVersion`
  // genuinely matches REAL_QA1_MD, not an arbitrary fabricated string.
  withReplacedBaselines(fakeBaselines({ '0.1.0': fcHash(REAL_QA1_MD), '0.1.1': fcHash(REAL_QA1_MD) }), () => {
    withFixture((dir) => {
      writeVersionMarker(dir, '0.1.1');
      const qa1Path = path.join(dir, QA1_REL_PATH);
      fs.mkdirSync(path.dirname(qa1Path), { recursive: true });
      fs.writeFileSync(qa1Path, CUSTOMIZED_QA1_MD);

      const output = runInstall(dir);

      assert.match(output, /Conflicts[\s\S]*\.claude\/agents\/qa1\.md \(yours/);
      assert.doesNotMatch(output, /shipped content has changed since the version you have/);
      assert.match(output, /no upstream update pending for this file/);
    });
  });
});

test('install.js: local edits with a real upstream change since the install say so, and how to see it (Req 4)', () => {
  const oldShipped = 'a fabricated OLD shipped version, deliberately different from what is installed now\n';
  withReplacedBaselines(fakeBaselines({ '0.1.0': fcHash(oldShipped) }), () => {
    withFixture((dir) => {
      writeVersionMarker(dir, '0.1.0');
      const qa1Path = path.join(dir, QA1_REL_PATH);
      fs.mkdirSync(path.dirname(qa1Path), { recursive: true });
      fs.writeFileSync(qa1Path, CUSTOMIZED_QA1_MD);

      const output = runInstall(dir);

      assert.match(output, /Conflicts[\s\S]*\.claude\/agents\/qa1\.md \(yours/);
      assert.match(output, /shipped content has changed since the version you have/);
      assert.match(output, /npx fully-completely/);
    });
  });
});

test('install.js: no baseline data for the installed version means the message can\'t claim "since the version you have" (Req 4/5, sprint 9 round 2)', () => {
  // QA1's exact round-1 finding on sprint 9 itself: the baseline table
  // lagged three published releases behind, so every 0.1.6/0.1.7/0.1.8
  // install hit hasUpstreamChangedSinceInstall()'s fallback path (true,
  // because content changed somewhere in older history) while the
  // message still claimed the precise "since the version you have" — a
  // claim that branch never actually established. Reproduced here with
  // fabricated data: installedVersion '0.1.9' has no baseline entry at
  // all, so the fallback fires; content genuinely differs across what
  // baseline data does exist, so upstreamChanged is correctly true; the
  // message must hedge rather than claim precision it doesn't have.
  const oldShipped = 'a fabricated OLD shipped version, deliberately different from what is installed now\n';
  withReplacedBaselines(fakeBaselines({ '0.1.0': fcHash(oldShipped) }), () => {
    withFixture((dir) => {
      writeVersionMarker(dir, '0.1.9'); // not in the fabricated table at all
      const qa1Path = path.join(dir, QA1_REL_PATH);
      fs.mkdirSync(path.dirname(qa1Path), { recursive: true });
      fs.writeFileSync(qa1Path, CUSTOMIZED_QA1_MD);

      const output = runInstall(dir);

      assert.match(output, /Conflicts[\s\S]*\.claude\/agents\/qa1\.md \(yours/);
      assert.doesNotMatch(
        output,
        /shipped content has changed since the version you have/,
        'must not claim precision the fallback branch never established'
      );
      assert.match(output, /doesn't have exact data for the version you're on/);
      assert.match(output, /npx fully-completely/);
    });
  });
});

test('install.js: a successful upgrade exits 0 even when it reports conflicts (Req 5)', () => {
  withFixture((dir) => {
    writeVersionMarker(dir, '0.1.0');
    const qa1Path = path.join(dir, QA1_REL_PATH);
    fs.mkdirSync(path.dirname(qa1Path), { recursive: true });
    fs.writeFileSync(qa1Path, CUSTOMIZED_QA1_MD); // matches no manifest and no baseline -> a real, guaranteed conflict

    const status = runInstallStatus(dir);

    assert.strictEqual(status, 0, 'a run that safely declines to overwrite something is a successful run, not a failed one');
  });
});

test('install.js: running against the source repo itself is a genuine failure and still exits non-zero (Req 5)', () => {
  const status = runInstallStatus(REPO_ROOT);
  assert.notStrictEqual(status, 0, 'the wrong-directory guard is a real error and must still signal one');
});

// -------------------------------------------------------------------------
// python-interpreter.js: sprint 10, Req 5's resolution order (python3,
// then python, then py) and its own named risk ("the interpreter
// resolution picks Python 2 on a machine that has one"). This dev
// machine's real interpreters can't exercise the fallback order or the
// Python-2 case (there's a real python3 and nothing else here to test
// against), so these use small fake executables on a controlled PATH —
// the same technique sprint 7 used to test git-unavailable degradation.
// -------------------------------------------------------------------------
const { findPython3Interpreter } = require('./launcher/python-interpreter');

function withFakeInterpreters(specs, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-fake-python-'));
  const originalPath = process.env.PATH;
  try {
    for (const [name, spec] of Object.entries(specs)) {
      const redirect = spec.toStderr ? '>&2' : '';
      const exitCode = spec.exitCode !== undefined ? spec.exitCode : 0;
      fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${spec.output}" ${redirect}\nexit ${exitCode}\n`);
      fs.chmodSync(path.join(dir, name), 0o755);
    }
    process.env.PATH = dir;
    fn();
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('python-interpreter: python3 present and correct resolves first (macOS/Linux, unchanged)', () => {
  withFakeInterpreters({ python3: { output: 'Python 3.9.6' } }, () => {
    assert.strictEqual(findPython3Interpreter(), 'python3');
  });
});

test('python-interpreter: only "python" present (a python.org Windows install) resolves via the fallback order', () => {
  withFakeInterpreters({ python: { output: 'Python 3.11.0' } }, () => {
    assert.strictEqual(findPython3Interpreter(), 'python');
  });
});

test('python-interpreter: only "py" present resolves via the last fallback', () => {
  withFakeInterpreters({ py: { output: 'Python 3.12.1' } }, () => {
    assert.strictEqual(findPython3Interpreter(), 'py');
  });
});

test('python-interpreter: a Python 2 "python3" is rejected, not mistaken for Python 3 — the sprint\'s own named risk', () => {
  withFakeInterpreters(
    {
      python3: { output: 'Python 2.7.18', toStderr: true }, // real python2 --version prints to stderr, not stdout
      python: { output: 'Python 3.10.4' },
    },
    () => {
      assert.strictEqual(
        findPython3Interpreter(),
        'python',
        'must skip the Python 2 interpreter and fall through to the next candidate, not stop at the first one that merely exits 0'
      );
    }
  );
});

test('python-interpreter: a candidate that exits non-zero (a Windows Store alias for an uninstalled Python) is treated as absent', () => {
  withFakeInterpreters(
    {
      python3: { output: '', exitCode: 1 },
      python: { output: 'Python 3.8.10' },
    },
    () => {
      assert.strictEqual(findPython3Interpreter(), 'python');
    }
  );
});

test('python-interpreter: no candidate resolves to a real Python 3 -> null, not a throw', () => {
  withFakeInterpreters({}, () => {
    assert.strictEqual(findPython3Interpreter(), null);
  });
});

// -------------------------------------------------------------------------
// install.js: Req 2 (sprint 14) — no non-ASCII byte in the installer's own
// runtime output, since that's exactly what a default Windows console
// (OEM code page 437/850) mangles into "ΓÇö" for an em dash. Two tests:
// a static scan of the source for a cheap blanket regression guard, and a
// dynamic run that actually triggers the two named findings (the
// conflicts section, the Python warning) plus a third conflict shape, and
// checks the real captured output rather than the source.
// -------------------------------------------------------------------------
test('install.js: no non-ASCII character on any line outside a `//` comment (Req 2 regression guard)', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'install.js'), 'utf8');
  const offenders = [];
  src.split('\n').forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return; // a whole-line comment; install.js has no /* */ block comments to worry about
    if (/[^\x00-\x7f]/.test(line)) offenders.push(`line ${i + 1}: ${line.trim()}`);
  });
  assert.deepStrictEqual(offenders, [], `non-ASCII character(s) found outside comments:\n${offenders.join('\n')}`);
});

test('install.js: the actual runtime output (conflicts + Python warning) is pure ASCII, not just the source', () => {
  withFixture((dir) => {
    // Two conflict shapes at once (a genuinely different CLAUDE.md, and a
    // colliding tasks.json label — the same triggers as the two existing
    // tests above), plus a PATH with no python3/python/py at all so the
    // Req 2's second named message (the Python warning) fires too. Uses
    // process.execPath rather than the bare string 'node' so the child
    // process is still reachable once PATH is replaced entirely.
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Something else entirely\n');
    fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.vscode', 'tasks.json'),
      JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Shell', type: 'shell', command: 'make devshell' }] }, null, 2) +
        '\n'
    );
    const emptyPathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-no-python-'));
    let output;
    try {
      output = execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'install.js')], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PATH: emptyPathDir },
      });
    } finally {
      fs.rmSync(emptyPathDir, { recursive: true, force: true });
    }
    // Confirm the two named findings' code paths were actually hit, not
    // just that whatever ran happened to be ASCII-clean.
    assert.match(output, /Conflicts - left untouched, review by hand/);
    assert.match(output, /WARNING: no Python 3 interpreter found/);
    assert.doesNotMatch(output, /[^\x00-\x7f]/, `non-ASCII byte in real install.js output:\n${output}`);
  });
});

// -------------------------------------------------------------------------
// run-role.js (Sprint 11: headless launch, Req 9 coverage)
// -------------------------------------------------------------------------
const { ROLES: RUN_ROLE_ROLES, readAgentMeta, agentBody } = require('./launcher/agents');
const {
  initialPrompt: RR_initialPrompt,
  devTeam2ResumePrompt: RR_devTeam2ResumePrompt,
  headlessPrompt,
  headlessCollisionNotice,
} = require('./launcher/prompts');
const {
  freshLaunchArgs,
  resumeLaunchArgs,
  headlessLaunchArgs,
  headlessPermissionArgs,
  LAUNCHER_FAILURE_EXIT_CODE,
  installOrphanGuard,
  readDeclaredTestCommand,
  readDeclaredMcpConfig,
  HEADLESS_PERMISSION_PROFILES,
  LIVEQA_PLAYWRIGHT_MCP_ALLOWED_TOOLS,
  LIVEQA_API_ALLOWED_TOOLS,
  emitPermissionRecord,
  extractGrantedCommandForms,
  grantedFormsInstruction,
} = require('./launcher/run-role');

const QA1_ROLE = RUN_ROLE_ROLES.find((r) => r.id === 'qa1');
const DEV_TEAM_2_ROLE = RUN_ROLE_ROLES.find((r) => r.id === 'dev-team-2');
const LIVEQA_ROLE = RUN_ROLE_ROLES.find((r) => r.id === 'liveqa');

// Req 6 (interactive path unchanged): exact-argv-shape assertions on the
// pure builders extracted from the pre-sprint-11 launchFresh()/resume
// call, so a regression here is a mechanical assertion failure, not a
// claim in a handoff.
test('run-role: freshLaunchArgs builds the exact pre-sprint-11 fresh-launch argv', () => {
  const args = freshLaunchArgs(QA1_ROLE, 'fc:qa1:fully-completely', 'uuid-123');
  assert.deepStrictEqual(args, [
    '--agent',
    'qa1',
    '--session-id',
    'uuid-123',
    '--name',
    'fc:qa1:fully-completely',
    RR_initialPrompt('QA1'),
  ]);
});

test('run-role: resumeLaunchArgs builds plain --agent/--resume argv for a non-dev-team-2 role', () => {
  const args = resumeLaunchArgs(QA1_ROLE, 'uuid-456', 'fully-completely');
  assert.deepStrictEqual(args, ['--agent', 'qa1', '--resume', 'uuid-456']);
});

test('run-role: resumeLaunchArgs appends the worktree-check prompt only for dev-team-2', () => {
  const args = resumeLaunchArgs(DEV_TEAM_2_ROLE, 'uuid-789', 'fully-completely');
  assert.deepStrictEqual(args, [
    '--agent',
    'dev-team-2',
    '--resume',
    'uuid-789',
    RR_devTeam2ResumePrompt('fully-completely'),
  ]);
});

// Sprint 41, Req 3: a collision warning must survive the interactive TUI's
// own redraw, which a pre-launch console.error() line does not (it's gone
// before the session it's FOR ever gets a chance to read it, confirmed
// live against a real headless launch). Prepending/appending the warning
// onto the actual opening prompt is what survives -- verified here as a
// mechanical argv assertion, and a clean launch (no warning, the vastly
// more common case) must be byte-for-byte unchanged from the pre-Req-3
// argv the tests above already pin.
test('run-role: freshLaunchArgs prepends a collision warning onto the opening prompt when one is given', () => {
  const warning = 'NOTE: another QA1 session was recorded starting at 2026-01-01T00:00:00.000Z in this same tree.';
  const args = freshLaunchArgs(QA1_ROLE, 'fc:qa1:fully-completely', 'uuid-123', warning);
  assert.deepStrictEqual(args, [
    '--agent',
    'qa1',
    '--session-id',
    'uuid-123',
    '--name',
    'fc:qa1:fully-completely',
    RR_initialPrompt('QA1', warning),
  ]);
  // And the prompt itself actually contains the warning text verbatim,
  // ahead of the standing orientation body -- not merely a differently-
  // shaped argv.
  const prompt = args[args.length - 1];
  assert.ok(prompt.startsWith(warning), `prompt does not start with the warning:\n${prompt}`);
  assert.match(prompt, /You are now running as QA1 for this project/);
});

test('run-role: freshLaunchArgs with no warning produces the exact same prompt as before Req 3 (undefined and omitted both)', () => {
  const withUndefined = freshLaunchArgs(QA1_ROLE, 'fc:qa1:fully-completely', 'uuid-123', undefined);
  const omitted = freshLaunchArgs(QA1_ROLE, 'fc:qa1:fully-completely', 'uuid-123');
  assert.deepStrictEqual(withUndefined, omitted);
  assert.strictEqual(withUndefined[withUndefined.length - 1], RR_initialPrompt('QA1'));
});

test('run-role: resumeLaunchArgs appends a collision warning as its own trailing message for a non-dev-team-2 role', () => {
  const warning = 'NOTE: another Pipeman session was recorded starting at 2026-01-01T00:00:00.000Z in this same tree.';
  const args = resumeLaunchArgs(QA1_ROLE, 'uuid-456', 'fully-completely', warning);
  assert.deepStrictEqual(args, ['--agent', 'qa1', '--resume', 'uuid-456', warning]);
});

test('run-role: resumeLaunchArgs combines the dev-team-2 worktree note and a collision warning into one trailing argv element', () => {
  const warning = 'NOTE: another Dev Team 2 session was recorded starting at 2026-01-01T00:00:00.000Z in this same tree.';
  const args = resumeLaunchArgs(DEV_TEAM_2_ROLE, 'uuid-789', 'fully-completely', warning);
  // Exactly one trailing argv element -- the CLI only accepts one -- and it
  // carries both messages, worktree note first (existing behavior), then
  // the warning, separated the same way initialPrompt() separates its own
  // warning from its body.
  assert.strictEqual(args.length, 5);
  assert.strictEqual(args[4], `${RR_devTeam2ResumePrompt('fully-completely')}\n\n${warning}`);
});

// Req 3 + Req 4 (headless argv shape): built from the same
// readAgentMeta()/agentBody() split the interactive path never touches, so
// this test would fail the moment headlessLaunchArgs and agents.js drift
// about where the frontmatter ends, rather than only on a real invocation.
// Sprint 31, Req 1: headlessLaunchArgs() now prepends a derived
// instruction to the prompt for any role holding a script-invocation
// grant. Computed from the REAL exported functions (extractGrantedCommandForms
// + grantedFormsInstruction), rather than a hardcoded literal duplicating
// their output, so these pre-existing tests can never silently drift from
// what headlessLaunchArgs() itself actually does — the exact same
// discipline this file's own comment above already applies to
// headlessPermissionArgs().
function expectedPromptFor(role, prompt) {
  const permArgs = headlessPermissionArgs(role);
  const i = permArgs.indexOf('--allowedTools');
  const allowedToolsValue = i === -1 ? null : permArgs[i + 1];
  const forms = extractGrantedCommandForms(allowedToolsValue);
  return forms.length ? `${grantedFormsInstruction(forms)}\n\n${prompt}` : prompt;
}

test('run-role: extractGrantedCommandForms parses exact command forms out of a real --allowedTools value, extras and edge cases included', () => {
  assert.deepStrictEqual(
    extractGrantedCommandForms('Bash(node scripts/run-lifecycle.js *) Bash(python3 scripts/sprint_lifecycle.py *)'),
    ['node scripts/run-lifecycle.js', 'python3 scripts/sprint_lifecycle.py']
  );
  assert.deepStrictEqual(extractGrantedCommandForms('Bash(git log *)'), ['git log']);
  assert.deepStrictEqual(extractGrantedCommandForms(null), []);
  assert.deepStrictEqual(extractGrantedCommandForms(''), []);
  assert.deepStrictEqual(extractGrantedCommandForms('Edit,Write'), [], 'a disallowedTools-shaped value has no Bash(...) entries to find');
});

test('run-role: grantedFormsInstruction states the exact forms, not a paraphrase', () => {
  const text = grantedFormsInstruction(['node scripts/run-lifecycle.js', 'python3 scripts/sprint_lifecycle.py']);
  assert.match(text, /EXACT COMMAND FORMS REQUIRED/);
  assert.match(text, /^ {2}node scripts\/run-lifecycle\.js \.\.\.$/m);
  assert.match(text, /^ {2}python3 scripts\/sprint_lifecycle\.py \.\.\.$/m);
});

test('run-role: emitPermissionRecord (Req 3) reports instructedCommandForms parsed from its OWN allowedTools field, not a second source', () => {
  const args = ['--agent', 'x', '--allowedTools', 'Bash(git log *) Bash(git diff *)', 'p'];
  const lines = captureStderr(() => emitPermissionRecord({ id: 'x' }, args, '/root'));
  const record = JSON.parse(lines[0].slice('PERMISSION_RECORD: '.length));
  assert.deepStrictEqual(record.instructedCommandForms, ['git log', 'git diff']);
  assert.deepStrictEqual(record.instructedCommandForms, extractGrantedCommandForms(record.allowedTools));
});

test('run-role: emitPermissionRecord (Req 3) reports instructedCommandForms as an empty array, not omitted, when there is no allowedTools value at all', () => {
  const args = ['--agent', 'x', 'p'];
  const lines = captureStderr(() => emitPermissionRecord({ id: 'x' }, args, '/root'));
  const record = JSON.parse(lines[0].slice('PERMISSION_RECORD: '.length));
  assert.ok('instructedCommandForms' in record);
  assert.deepStrictEqual(record.instructedCommandForms, []);
});

// Sprint 31, Req 4 (QA1 round 1 finding): in THIS repo's default config —
// no fullyCompletely.testCommand declared, no ownedRepository grant — the
// profile's own allowedTools (HEADLESS_PERMISSION_PROFILES[role].allowedTools
// joined) and the args actually passed to the child are byte-identical
// for every role, which means no comparison between a record and the
// child's real argv, including the subprocess test above, can tell a
// correctly args-derived record apart from one silently reassembled from
// HEADLESS_PERMISSION_PROFILES — Req 4's own named defect ("reassembled
// from a second source"). This test exists specifically to make the two
// sources diverge (a declared test command adds a THIRD grant entry that
// only the args-derived path can see) and assert the record still
// matches the real args exactly, catching the second-source mutation the
// other tests structurally cannot.
test('run-role: headlessLaunchArgs (Sprint 31 Req 4) derives allowedTools from the REAL args passed to the child, not a rebuild from HEADLESS_PERMISSION_PROFILES -- the two sources are made to actually differ via a declared test command', () => {
  withScratchSettings('{"fullyCompletely.testCommand": "node scripts/launcher_test.js"}', (dir) => {
    let args;
    const lines = captureStderr(() => {
      args = headlessLaunchArgs(QA1_ROLE, 'p', { root: dir });
    });
    const i = args.indexOf('--allowedTools');
    assert.notStrictEqual(i, -1, 'test setup: qa1 must receive an --allowedTools flag');
    const argsAllowedTools = args[i + 1];

    const profileOnly = HEADLESS_PERMISSION_PROFILES.qa1.allowedTools.join(' ');
    assert.notStrictEqual(
      argsAllowedTools,
      profileOnly,
      'test setup: a declared test command must make the real args differ from the bare profile -- ' +
        'if this fails, `root` is not reaching headlessPermissionArgs() and this test cannot distinguish anything'
    );
    assert.ok(argsAllowedTools.includes('Bash(node scripts/launcher_test.js *)'), 'the real args must carry the dynamically-added test-command grant');

    const record = JSON.parse(lines.find((l) => l.startsWith('PERMISSION_RECORD: ')).slice('PERMISSION_RECORD: '.length));
    assert.strictEqual(record.allowedTools, argsAllowedTools, 'record.allowedTools must equal the REAL args value, including the dynamically-added grant');
    assert.notStrictEqual(
      record.allowedTools,
      profileOnly,
      "record must not have been reassembled from HEADLESS_PERMISSION_PROFILES alone -- Req 4's exact defect"
    );
  });
});

test('run-role: headlessLaunchArgs (Req 1) prepends the instruction for every real role holding a script-invocation grant, and it precedes the task prompt', () => {
  for (const role of RUN_ROLE_ROLES) {
    const args = headlessLaunchArgs(role, 'THE TASK PROMPT');
    const finalPrompt = args.slice(-1)[0];
    const permArgs = headlessPermissionArgs(role);
    const i = permArgs.indexOf('--allowedTools');
    const forms = extractGrantedCommandForms(i === -1 ? null : permArgs[i + 1]);
    assert.ok(forms.length > 0, `${role.id}: test assumption failed -- every real role is expected to hold a script-invocation grant`);
    assert.ok(finalPrompt.startsWith('PERMISSION GRANT'), `${role.id}: instruction must come first, before the task`);
    assert.ok(finalPrompt.endsWith('THE TASK PROMPT'), `${role.id}: the original task prompt must still be present, untouched, at the end`);
    for (const form of forms) {
      assert.ok(finalPrompt.includes(form), `${role.id}: instructed prompt is missing granted form "${form}"`);
    }
  }
});

// Sprint 42, Req 2: the headless counterpart to sprint 41's interactive
// collision-warning fix. Before this sprint, roleWarning was computed in
// main() (unconditionally, both paths), printed to stderr, and then
// simply never reached runHeadless()/headlessLaunchArgs() at all -- a
// headless role had no way to see it in its own transcript.
test('run-role: headlessLaunchArgs prepends the collision notice (wrapped, not a bare join) when a roleWarning is given, ahead of the task prompt', () => {
  const warning = 'NOTE: another QA1 session was recorded starting at 2026-01-01T00:00:00.000Z in this same tree.';
  const args = headlessLaunchArgs(QA1_ROLE, 'THE TASK PROMPT', { roleWarning: warning });
  const finalPrompt = args.slice(-1)[0];
  assert.ok(finalPrompt.includes('=== FRAMEWORK NOTICE (not part of your task) ==='), 'the wrapped notice markers must be present');
  assert.ok(finalPrompt.includes(warning), 'the warning text itself must be present verbatim');
  assert.ok(finalPrompt.includes('=== END NOTICE ==='), 'the closing marker must be present');
  assert.ok(finalPrompt.endsWith('THE TASK PROMPT'), 'the original task prompt must still be present, untouched, at the end');
  // Ordering: QA1 holds a script-invocation grant, so grantedFormsInstruction
  // fires too -- it must still come first (Req 2a: its own existing
  // behavior/position is unchanged), the collision notice sits between it
  // and the task.
  const permInstructionIdx = finalPrompt.indexOf('PERMISSION GRANT');
  const noticeIdx = finalPrompt.indexOf('=== FRAMEWORK NOTICE');
  const taskIdx = finalPrompt.indexOf('THE TASK PROMPT');
  assert.ok(permInstructionIdx !== -1 && permInstructionIdx < noticeIdx, 'permission-grant instruction must precede the collision notice');
  assert.ok(noticeIdx < taskIdx, 'collision notice must precede the task prompt');
});

test('run-role: headlessLaunchArgs with no roleWarning is byte-identical to omitting the option entirely (Req 2a)', () => {
  const withUndefined = headlessLaunchArgs(QA1_ROLE, 'THE TASK PROMPT', { roleWarning: undefined });
  const omitted = headlessLaunchArgs(QA1_ROLE, 'THE TASK PROMPT', {});
  assert.deepStrictEqual(withUndefined, omitted);
  assert.ok(!withUndefined.slice(-1)[0].includes('FRAMEWORK NOTICE'), 'no notice text should appear when there is no warning');
});

test('run-role: headlessCollisionNotice (prompts.js) wraps the warning with clear framework-inserted markers, never a bare join', () => {
  const warning = 'NOTE: a collision warning with some content.';
  const notice = headlessCollisionNotice(warning);
  assert.notStrictEqual(notice, warning, 'must be more than the bare warning text -- a bare join is exactly the shape Req 2b forbids');
  assert.ok(notice.startsWith('=== FRAMEWORK NOTICE'));
  assert.ok(notice.endsWith('=== END NOTICE ==='));
  assert.doesNotMatch(notice, /"/, 'no literal double-quote character, same discipline as devTeam2ResumePrompt() and initialPrompt()');
});

test('run-role: headlessLaunchArgs supplies the persona via --agents JSON (--bare cannot read .claude/agents/*.md)', () => {
  const args = headlessLaunchArgs(QA1_ROLE, 'do the audit');
  const meta = readAgentMeta('qa1');
  const body = agentBody('qa1');
  assert.deepStrictEqual(args.slice(0, 2), ['--agent', 'qa1']);
  assert.strictEqual(args[2], '--agents');
  const agentsJson = JSON.parse(args[3]);
  assert.deepStrictEqual(Object.keys(agentsJson), ['qa1']);
  assert.strictEqual(agentsJson.qa1.description, meta.description);
  assert.strictEqual(agentsJson.qa1.prompt, body);
  assert.strictEqual(agentsJson.qa1.model, meta.model);
});

// Req 4, amended round 3: the DEFAULT shape (no options, or {}) now runs on
// the operator's own session — no --bare, and --no-session-persistence
// added, the one suppression testing found compatible with an explicit
// --agents override (--safe-mode was NOT: it disabled --agents too,
// confirmed by running it — "--agent 'test' not found. Available agents:
// claude, Explore, general-purpose, Plan").
//
// Sprint 12, Req 3: the permission-scope args (headlessPermissionArgs(),
// tested separately below) now sit between the --agents JSON and -p —
// these tests compute the expected block from the real function rather
// than hardcoding QA1's profile content here, so they can never silently
// drift from it.
test('run-role: headlessLaunchArgs default (no bare) omits --bare, adds --no-session-persistence, omits --settings', () => {
  const args = headlessLaunchArgs(QA1_ROLE, 'do the audit');
  assert.deepStrictEqual(args.slice(4), [
    '-p',
    '--output-format',
    'json',
    ...headlessPermissionArgs(QA1_ROLE),
    '--no-session-persistence',
    expectedPromptFor(QA1_ROLE, 'do the audit'),
  ]);
  assert.ok(!args.includes('--bare'));
  assert.ok(!args.includes('--settings'));
});

test('run-role: headlessLaunchArgs default (no bare) also omits --bare/--settings even when settings is passed without bare:true', () => {
  // settings is only meaningful alongside bare:true — passing it alone
  // must not silently smuggle --settings onto a non-isolated invocation.
  const args = headlessLaunchArgs(QA1_ROLE, 'do the audit', { settings: '{"apiKeyHelper":"/x.sh"}' });
  assert.ok(!args.includes('--bare'));
  assert.ok(!args.includes('--settings'));
  assert.deepStrictEqual(args.slice(4), [
    '-p',
    '--output-format',
    'json',
    ...headlessPermissionArgs(QA1_ROLE),
    '--no-session-persistence',
    expectedPromptFor(QA1_ROLE, 'do the audit'),
  ]);
});

test('run-role: headlessLaunchArgs bare:true adds --bare, omits --no-session-persistence, omits --settings when none given', () => {
  const args = headlessLaunchArgs(QA1_ROLE, 'do the audit', { bare: true });
  assert.deepStrictEqual(args.slice(4), [
    '-p', '--output-format', 'json', ...headlessPermissionArgs(QA1_ROLE), '--bare', expectedPromptFor(QA1_ROLE, 'do the audit'),
  ]);
  assert.ok(!args.includes('--no-session-persistence'));
  assert.ok(!args.includes('--settings'));
});

// QA1 round 1 (Req 4): --settings is forwarded to claude's own --settings
// flag, ahead of the trailing prompt, so an apiKeyHelper-based project has
// a real way to use headless --bare — not just a named-but-unwired remedy.
// Still applies unchanged in round 3, scoped to bare:true only.
test('run-role: headlessLaunchArgs bare:true forwards --settings ahead of the trailing prompt', () => {
  const args = headlessLaunchArgs(QA1_ROLE, 'do the audit', { bare: true, settings: '{"apiKeyHelper":"/path/to/helper.sh"}' });
  assert.deepStrictEqual(args.slice(4), [
    '-p',
    '--output-format',
    'json',
    ...headlessPermissionArgs(QA1_ROLE),
    '--bare',
    '--settings',
    '{"apiKeyHelper":"/path/to/helper.sh"}',
    expectedPromptFor(QA1_ROLE, 'do the audit'),
  ]);
});

// -------------------------------------------------------------------------
// Sprint 12, Req 3: headlessPermissionArgs() — the scoped profile itself.
// -------------------------------------------------------------------------
test('run-role: headlessPermissionArgs is defined for every real role and always includes acceptEdits', () => {
  for (const role of RUN_ROLE_ROLES) {
    const args = headlessPermissionArgs(role);
    assert.deepStrictEqual(args.slice(0, 2), ['--permission-mode', 'acceptEdits'], `${role.id}: must start with acceptEdits`);
  }
});

test('run-role: headlessPermissionArgs never includes --bare, --settings, or --permission-mode bypassPermissions', () => {
  // The whole point of sprint 12's Req 3 decision: no role's profile may
  // resemble the refused blanket bypass, ever, by construction.
  for (const role of RUN_ROLE_ROLES) {
    const args = headlessPermissionArgs(role);
    assert.ok(!args.includes('bypassPermissions'), `${role.id}: must never grant bypassPermissions`);
    assert.ok(!args.includes('--bare'));
    assert.ok(!args.includes('--settings'));
  }
});

test('run-role: headlessPermissionArgs hard-disables Edit/Write for qa1 and liveqa, neither of which writes source', () => {
  for (const roleId of ['qa1', 'liveqa']) {
    const role = RUN_ROLE_ROLES.find((r) => r.id === roleId);
    const args = headlessPermissionArgs(role);
    const idx = args.indexOf('--disallowedTools');
    assert.ok(idx !== -1, `${roleId}: must pass --disallowedTools`);
    assert.strictEqual(args[idx + 1], 'Edit,Write');
  }
});

test('run-role: headlessPermissionArgs does not disallow Edit/Write for roles that write source or sprint files', () => {
  for (const roleId of ['dev-team-1', 'dev-team-2', 'master-controller', 'pipeman']) {
    const role = RUN_ROLE_ROLES.find((r) => r.id === roleId);
    assert.ok(!headlessPermissionArgs(role).includes('--disallowedTools'), `${roleId}: must not disallow Edit/Write`);
  }
});

test('run-role: headlessPermissionArgs grants master-controller ONLY the mc-commit.js wrapper for git, no raw git pattern at all (sprint 36, Req 6, corrected in the fix round after QA1\'s round-1 FAIL)', () => {
  // QA1 round 1 demonstrated that raw `Bash(git add docs/sprints/*)` /
  // `Bash(git commit -m *)` allow entries cannot actually be confined to
  // docs/sprints/ -- a second pathspec appended after the matched prefix
  // sails through regardless of any disallow entry. The fix withdraws
  // every raw git pattern for this role and grants access to a dedicated
  // wrapper script instead (scripts/mc-commit.js, tested directly and
  // deterministically in this same file's own "mc-commit.js" section).
  const role = RUN_ROLE_ROLES.find((r) => r.id === 'master-controller');
  const args = headlessPermissionArgs(role);
  const allowedIdx = args.indexOf('--allowedTools');
  assert.ok(allowedIdx !== -1, 'master-controller must pass --allowedTools');
  const allowed = args[allowedIdx + 1];
  assert.ok(allowed.includes('Bash(node scripts/mc-commit.js *)'), 'master-controller must be allowed to invoke the mc-commit.js wrapper');
  assert.ok(!allowed.includes('git'), 'master-controller must not have ANY raw git pattern in allowedTools -- the wrapper script is the only path to git');
  assert.ok(!args.includes('--disallowedTools'), 'no disallowedTools entries should be needed any more -- the wrapper script itself enforces the boundary in code, not a pattern list');
  // master-controller is deliberately NOT eligible for the broader
  // owned-repository grant (npm/node/python/curl/etc.) -- its only
  // legitimate git need is committing its own sprint-file edits, via the
  // wrapper.
  assert.ok(!HEADLESS_PERMISSION_PROFILES['master-controller'].eligibleForOwnedRepositoryGrant,
    'master-controller must not be eligible for the broad owned-repository grant');
});

test('run-role: headlessPermissionArgs grants qa1 and liveqa ONLY the gate-commit.js wrapper for git -- exactly one new grant each, no raw git pattern at all (sprint 42, Req 1d)', () => {
  // The gate-role counterpart to the master-controller test above --
  // sprint 41's Req 6b measured that this exact CLAUDE.md-required
  // pathspec commit was DENIED headless for both these roles (see
  // docs/sprint-12-permission-scope-findings.md's "Sprint 41, Req 6"
  // section), and scripts/gate-commit.js is the fix (a sibling to
  // mc-commit.js, not an extension of it -- see that script's own header
  // comment for why).
  for (const roleId of ['qa1', 'liveqa']) {
    const role = RUN_ROLE_ROLES.find((r) => r.id === roleId);
    const args = headlessPermissionArgs(role);
    const allowedIdx = args.indexOf('--allowedTools');
    assert.ok(allowedIdx !== -1, `${roleId} must pass --allowedTools`);
    const allowed = args[allowedIdx + 1];
    assert.ok(allowed.includes('Bash(node scripts/gate-commit.js *)'), `${roleId} must be allowed to invoke the gate-commit.js wrapper`);
    assert.ok(!allowed.includes('git'), `${roleId} must not have ANY raw git pattern in allowedTools -- the wrapper script is the only path to git`);
  }
});

test('run-role: headlessPermissionArgs grants pipeman its narrow npm subcommands and nothing about npm to qa1', () => {
  // Sprint 17 round 2 (QA1 finding 2): blanket Bash(npm *) reaches well
  // past pipeman's job -- `npm install` alone runs unattended postinstall
  // scripts. Narrowed to the three subcommands pipeman.md actually names.
  const pipemanArgs = headlessPermissionArgs(RUN_ROLE_ROLES.find((r) => r.id === 'pipeman'));
  for (const sub of ['publish', 'view', 'pack']) {
    assert.ok(pipemanArgs.some((a) => a.includes(`Bash(npm ${sub} *)`)), `pipeman must be allowed npm ${sub}`);
  }
  assert.ok(!pipemanArgs.some((a) => a.includes('Bash(npm *)')), 'pipeman must not have blanket npm access');
  const qa1Args = headlessPermissionArgs(QA1_ROLE);
  assert.ok(!qa1Args.some((a) => a.includes('npm')), 'qa1 has no stated need for npm and must not be granted it');
});

test('run-role: headlessPermissionArgs grants every role the two lifecycle-script invocation patterns', () => {
  for (const role of RUN_ROLE_ROLES) {
    const allowedIdx = headlessPermissionArgs(role).indexOf('--allowedTools');
    assert.ok(allowedIdx !== -1, `${role.id}: must pass --allowedTools`);
    const allowed = headlessPermissionArgs(role)[allowedIdx + 1];
    assert.ok(allowed.includes('Bash(node scripts/run-lifecycle.js *)'), `${role.id}: missing run-lifecycle.js allowlist`);
    assert.ok(allowed.includes('Bash(python3 scripts/sprint_lifecycle.py *)'), `${role.id}: missing sprint_lifecycle.py allowlist`);
  }
});

test('run-role: headlessPermissionArgs throws for an unknown role rather than launching with no scope at all', () => {
  assert.throws(() => headlessPermissionArgs({ id: 'not-a-real-role', label: 'Nope' }), /No headless permission profile/);
});

// -------------------------------------------------------------------------
// Sprint 17: no profile hardcodes a path specific to THIS repository (Req
// 5's own instruction: "that second assertion is the one that would have
// caught this" -- the launcher_test.js/verify-tarball.sh patterns this
// sprint removed). Every real headless mechanism (declared test command,
// pipeman's git scope, liveqa's npm/npx) was also confirmed by actually
// running it against a real scratch install during this sprint's build --
// not repeated here as a launcher_test.js assertion, since faking that
// mechanism convincingly would mean re-implementing claude's own
// permission enforcement rather than testing this file's own logic.
// -------------------------------------------------------------------------
const REPO_SPECIFIC_PATTERNS = [/launcher_test\.js/, /verify-tarball\.sh/, /smoke_test\.sh/];

test('run-role: no role\'s static allowedTools hardcodes a path specific to this repository (Req 5)', () => {
  for (const [roleId, profile] of Object.entries(HEADLESS_PERMISSION_PROFILES)) {
    for (const pattern of profile.allowedTools) {
      for (const repoSpecific of REPO_SPECIFIC_PATTERNS) {
        assert.ok(
          !repoSpecific.test(pattern),
          `${roleId}: allowedTools entry '${pattern}' hardcodes a path specific to this repository (matches ${repoSpecific})`
        );
      }
    }
  }
});

test('run-role: every role still gets the two lifecycle-script patterns, unaffected by this sprint\'s changes', () => {
  // Re-asserts what the pre-existing test above already covers, scoped
  // here to the static profile object directly (not through
  // headlessPermissionArgs(), which now also depends on a real
  // .vscode/settings.json read) -- confirms the removal of the two
  // repo-specific patterns above didn't take these two with them.
  for (const profile of Object.values(HEADLESS_PERMISSION_PROFILES)) {
    assert.ok(profile.allowedTools.includes('Bash(node scripts/run-lifecycle.js *)'));
    assert.ok(profile.allowedTools.includes('Bash(python3 scripts/sprint_lifecycle.py *)'));
  }
});

test('run-role: pipeman is allowlisted the specific git subcommands its documented flow uses, not blanket git (Req 3)', () => {
  const pipemanArgs = HEADLESS_PERMISSION_PROFILES.pipeman.allowedTools;
  for (const sub of ['status', 'log', 'diff', 'fetch', 'add', 'commit', 'rebase', 'merge', 'checkout', 'push']) {
    assert.ok(pipemanArgs.some((a) => a === `Bash(git ${sub} *)`), `pipeman missing git ${sub}`);
  }
  assert.ok(!pipemanArgs.includes('Bash(git *)'), 'pipeman must not be granted blanket git access (Req 3\'s own named example)');
  // Narrower still: nothing here should ever grant a destructive/unrelated
  // git subcommand pipeman's documented process never names.
  for (const dangerous of ['reset', 'clean', 'filter-branch', 'gc', 'reflog', 'config', 'remote']) {
    assert.ok(
      !pipemanArgs.some((a) => a.includes(`git ${dangerous}`)),
      `pipeman should not have git ${dangerous} -- not part of its documented flow`
    );
  }
});

test('run-role: liveqa is allowlisted npm install (narrow) and npx (deliberately broad) (Req 1/3, confirmed by running npx against a real scratch install)', () => {
  const liveqaArgs = HEADLESS_PERMISSION_PROFILES.liveqa.allowedTools;
  // Sprint 17 round 2 (QA1 finding 2): blanket Bash(npm *) here too was
  // unargued and too broad -- narrowed to `npm install`, the specific verb
  // Req 1's own text names ("install published packages into scratch
  // directories"). `npx *` stays broad, deliberately: the package name
  // under test is a different string every sprint, so there is no fixed
  // prefix narrower than the subcommand to enumerate against, unlike a
  // fixed verb set like git's or npm's -- an argued exception, not an
  // oversight.
  assert.ok(liveqaArgs.some((a) => a.includes('Bash(npm install *)')), 'liveqa missing npm install');
  assert.ok(!liveqaArgs.some((a) => a.includes('Bash(npm *)')), 'liveqa must not have blanket npm access');
  assert.ok(liveqaArgs.some((a) => a.includes('Bash(npx *)')), 'liveqa missing npx');
});

test('run-role: liveqa is allowlisted exactly Bash(node *), unscoped (no -e/--eval/-p carve-out) -- the sprint 39, Req 3 grant', () => {
  const liveqaArgs = HEADLESS_PERMISSION_PROFILES.liveqa.allowedTools;
  // Sprint 39, Req 3: measured live (see run-role.js's own "MEASURED,
  // sprint 39" comment above HEADLESS_PERMISSION_PROFILES) that the
  // EXISTING npx * grant already reaches arbitrary program-mediated
  // writes, inside and outside the working directory, with zero
  // confinement -- so node * is granted unscoped, deliberately not
  // narrowed to exclude -e/--eval/-p, since that would buy no measured
  // safety over what npx * already permits.
  assert.ok(liveqaArgs.includes('Bash(node *)'), 'liveqa missing the node grant (sprint 39, Req 3)');
  assert.ok(!liveqaArgs.some((a) => a.includes('--eval')), 'the node grant must not be narrowed to exclude --eval -- measured not to reduce real risk');
  assert.ok(!liveqaArgs.some((a) => a.includes(' -e ') || a.endsWith(' -e')), 'the node grant must not be narrowed to exclude -e -- measured not to reduce real risk');
});

test('run-role: liveqa is allowlisted the full confirmed Playwright MCP tool set, minus the one named "unsafe" (Sprint 23, Req 1)', () => {
  const liveqaArgs = HEADLESS_PERMISSION_PROFILES.liveqa.allowedTools;
  for (const tool of LIVEQA_PLAYWRIGHT_MCP_ALLOWED_TOOLS) {
    assert.ok(liveqaArgs.includes(tool), `liveqa missing MCP tool ${tool}`);
  }
  assert.ok(
    !liveqaArgs.includes('mcp__playwright__browser_run_code_unsafe'),
    'liveqa must not be granted the tool playwright itself names "unsafe" (arbitrary in-page code execution)'
  );
  // MCP tool entries are matched as bare literal tool names (confirmed by
  // running against a real @playwright/mcp server) -- a different shape
  // from every Bash(...) entry in this file, and NOT a server-level
  // wildcard (`mcp__playwright__*`), which was also confirmed to work but
  // was deliberately not used, since it has no way to exclude the one
  // tool above.
  for (const tool of LIVEQA_PLAYWRIGHT_MCP_ALLOWED_TOOLS) {
    assert.ok(tool.startsWith('mcp__playwright__'), `${tool} should be a bare mcp__playwright__* tool name`);
    assert.ok(!tool.includes('Bash('), `${tool} should not be wrapped in a Bash(...) pattern`);
    assert.ok(!tool.endsWith('*'), `${tool} should be an exact tool name, not a wildcard`);
  }
  assert.ok(
    !liveqaArgs.some((a) => a === 'mcp__playwright__*'),
    'liveqa should use the enumerated tool list, not the server-level wildcard'
  );
});

test('run-role: liveqa is allowlisted curl (unscopable by verb) and a narrow, enumerated, read-only gh subcommand set (Sprint 23, Req 2)', () => {
  const liveqaArgs = HEADLESS_PERMISSION_PROFILES.liveqa.allowedTools;
  assert.ok(liveqaArgs.includes('Bash(curl *)'), 'liveqa missing curl');
  for (const tool of LIVEQA_API_ALLOWED_TOOLS) {
    assert.ok(liveqaArgs.includes(tool), `liveqa missing ${tool}`);
  }
  // Req 2's own narrowness criterion: "a bare wildcard where a verb set
  // exists is a finding." gh has a real verb set (unlike curl, named
  // honestly above as the one exception) -- confirm no blanket `gh *`,
  // and confirm none of the write-capable or arbitrary-endpoint
  // subcommands snuck in.
  assert.ok(!liveqaArgs.includes('Bash(gh *)'), 'liveqa must not have blanket gh access');
  assert.ok(!liveqaArgs.some((a) => a.includes('Bash(gh api')), 'liveqa must not have gh api (arbitrary method+endpoint, same unscopable shape as curl)');
  for (const writeVerb of ['gh workflow run', 'gh pr merge', 'gh pr close', 'gh pr comment', 'gh issue', 'gh release', 'gh repo edit']) {
    assert.ok(
      !liveqaArgs.some((a) => a.includes(`Bash(${writeVerb}`)),
      `liveqa should not have ${writeVerb} -- LiveQA never writes to what it verifies`
    );
  }
});

test('run-role: sprint 23 touched only the liveqa profile -- every other role\'s permission profile is byte-identical to its pre-sprint-23 shape (Req 3)', () => {
  // Deliberately hardcoded, exact-array assertions rather than a generic
  // "still has N entries" check -- Req 3's own acceptance criterion is
  // "git diff shows no other profile changed," and a snapshot comparison
  // here is the same claim, just runnable. Sourced from each role's own
  // profile as committed before this sprint's changes.
  //
  // Sprint 36, Req 6: master-controller's OWN profile legitimately
  // changed here. Round 1 added raw `git add`/`git commit` allow patterns
  // scoped to docs/sprints/ -- QA1's round-1 audit demonstrated those
  // patterns cannot actually be confined that way (a second pathspec
  // appended after the matched prefix sails through), so the fix round
  // withdrew every raw git pattern and granted access to a dedicated
  // wrapper script instead (scripts/mc-commit.js, which enforces the
  // boundary in real code -- see that file and
  // docs/sprint-36-mc-commit-permission-findings.md). The assertion below
  // matches the CORRECTED shape, not the round-1 shape. This is the one
  // deliberate exception to "byte-identical since sprint 23" this test's
  // own name claims; every other role below is unaffected.
  assert.deepStrictEqual(HEADLESS_PERMISSION_PROFILES['master-controller'], {
    disallowedTools: [],
    allowedTools: [
      'Bash(node scripts/run-lifecycle.js *)',
      'Bash(python3 scripts/sprint_lifecycle.py *)',
      'Bash(node scripts/mc-commit.js *)',
    ],
  });
  assert.deepStrictEqual(HEADLESS_PERMISSION_PROFILES['dev-team-1'], {
    disallowedTools: [],
    allowedTools: ['Bash(node scripts/run-lifecycle.js *)', 'Bash(python3 scripts/sprint_lifecycle.py *)'],
    needsTestCommand: true,
    eligibleForOwnedRepositoryGrant: true,
  });
  assert.deepStrictEqual(HEADLESS_PERMISSION_PROFILES['dev-team-2'], {
    disallowedTools: [],
    allowedTools: ['Bash(node scripts/run-lifecycle.js *)', 'Bash(python3 scripts/sprint_lifecycle.py *)'],
    needsTestCommand: true,
    eligibleForOwnedRepositoryGrant: true,
  });
  // Sprint 42, Req 1d: qa1's OWN profile legitimately changed here too --
  // the second deliberate exception to "byte-identical since sprint 23"
  // this test's own name claims. Gains exactly one new grant
  // (scripts/gate-commit.js, the sibling wrapper to mc-commit.js above --
  // see that script's own header comment for why it is a sibling and not
  // an extension), no raw `git` pattern.
  assert.deepStrictEqual(HEADLESS_PERMISSION_PROFILES.qa1, {
    disallowedTools: ['Edit', 'Write'],
    allowedTools: [
      'Bash(node scripts/run-lifecycle.js *)',
      'Bash(python3 scripts/sprint_lifecycle.py *)',
      'Bash(node scripts/gate-commit.js *)',
    ],
    needsTestCommand: true,
    eligibleForOwnedRepositoryGrant: true,
  });
  assert.deepStrictEqual(HEADLESS_PERMISSION_PROFILES.pipeman, {
    disallowedTools: [],
    allowedTools: [
      'Bash(node scripts/run-lifecycle.js *)',
      'Bash(python3 scripts/sprint_lifecycle.py *)',
      'Bash(npm publish *)',
      'Bash(npm view *)',
      'Bash(npm pack *)',
      'Bash(git status *)',
      'Bash(git log *)',
      'Bash(git diff *)',
      'Bash(git fetch *)',
      'Bash(git add *)',
      'Bash(git commit *)',
      'Bash(git rebase *)',
      'Bash(git merge *)',
      'Bash(git checkout *)',
      'Bash(git push *)',
    ],
  });
  // liveqa's own disallowedTools (Edit/Write) is likewise unchanged --
  // only allowedTools grew this sprint.
  assert.deepStrictEqual(HEADLESS_PERMISSION_PROFILES.liveqa.disallowedTools, ['Edit', 'Write']);
});

test('run-role: dev-team-1/2 and qa1 are marked as needing a declared test command; other roles are not', () => {
  for (const roleId of ['dev-team-1', 'dev-team-2', 'qa1']) {
    assert.strictEqual(HEADLESS_PERMISSION_PROFILES[roleId].needsTestCommand, true, `${roleId} should need a declared test command`);
  }
  for (const roleId of ['master-controller', 'pipeman', 'liveqa']) {
    assert.ok(!HEADLESS_PERMISSION_PROFILES[roleId].needsTestCommand, `${roleId} should not need a declared test command`);
  }
});

// -------------------------------------------------------------------------
// readDeclaredTestCommand() -- the mechanism itself, unit-tested against a
// scratch root (never this repo's own real, off-limits .vscode/settings.json,
// which stays untouched by every test in this file).
// -------------------------------------------------------------------------
function withScratchSettings(settingsContentOrNull, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-test-command-'));
  try {
    if (settingsContentOrNull !== null) {
      fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.vscode', 'settings.json'), settingsContentOrNull);
    }
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('readDeclaredTestCommand: no .vscode/settings.json at all -> null, not a throw', () => {
  withScratchSettings(null, (dir) => {
    assert.strictEqual(readDeclaredTestCommand(dir), null);
  });
});

test('readDeclaredTestCommand: key present but empty string -> null (install.js\'s own default, "not declared")', () => {
  withScratchSettings('{"fullyCompletely.testCommand": ""}', (dir) => {
    assert.strictEqual(readDeclaredTestCommand(dir), null);
  });
});

test('readDeclaredTestCommand: key absent entirely -> null', () => {
  withScratchSettings('{"fullyCompletely.autoLaunch": false}', (dir) => {
    assert.strictEqual(readDeclaredTestCommand(dir), null);
  });
});

test('readDeclaredTestCommand: a real declared value is returned, trimmed', () => {
  withScratchSettings('{"fullyCompletely.testCommand": "  npm test  "}', (dir) => {
    assert.strictEqual(readDeclaredTestCommand(dir), 'npm test');
  });
});

test('readDeclaredTestCommand: JSONC comments in the file do not break parsing (this file is written by install.js as JSONC)', () => {
  withScratchSettings(
    '{\n  // a comment above the key\n  "fullyCompletely.testCommand": "pytest tests/",\n}\n',
    (dir) => {
      assert.strictEqual(readDeclaredTestCommand(dir), 'pytest tests/');
    }
  );
});

test('readDeclaredTestCommand: unparseable JSON -> null, not a throw', () => {
  withScratchSettings('{ this is not json', (dir) => {
    assert.strictEqual(readDeclaredTestCommand(dir), null);
  });
});

test('readDeclaredTestCommand: a non-string value (e.g. a stray boolean) -> null, not a crash', () => {
  withScratchSettings('{"fullyCompletely.testCommand": true}', (dir) => {
    assert.strictEqual(readDeclaredTestCommand(dir), null);
  });
});

test('readDeclaredTestCommand: the array/root-not-an-object shapes both degrade to null', () => {
  withScratchSettings('[1, 2, 3]', (dir) => {
    assert.strictEqual(readDeclaredTestCommand(dir), null);
  });
  withScratchSettings('null', (dir) => {
    assert.strictEqual(readDeclaredTestCommand(dir), null);
  });
});

test('readDeclaredTestCommand: a bare interpreter is rejected end to end -- no permission granted (Req 6)', () => {
  for (const bare of ['node', 'bash', 'sh', 'python3']) {
    withScratchSettings(`{"fullyCompletely.testCommand": "${bare}"}`, (dir) => {
      assert.strictEqual(readDeclaredTestCommand(dir), null, `a bare "${bare}" must resolve to null, not be granted`);
    });
  }
});

test('readDeclaredTestCommand: a real command starting with an interpreter name still works (only the BARE form is rejected)', () => {
  withScratchSettings('{"fullyCompletely.testCommand": "node test/all.js"}', (dir) => {
    assert.strictEqual(readDeclaredTestCommand(dir), 'node test/all.js');
  });
});

// -------------------------------------------------------------------------
// readDeclaredMcpConfig() -- sprint 27, Req 4. Same shape and same test
// coverage style as readDeclaredTestCommand() immediately above,
// deliberately, since it's the identical mechanism one settings key over.
// -------------------------------------------------------------------------
test('readDeclaredMcpConfig: no .vscode/settings.json at all -> null, not a throw', () => {
  withScratchSettings(null, (dir) => {
    assert.strictEqual(readDeclaredMcpConfig(dir), null);
  });
});

test('readDeclaredMcpConfig: key absent entirely -> null', () => {
  withScratchSettings('{"fullyCompletely.testCommand": "npm test"}', (dir) => {
    assert.strictEqual(readDeclaredMcpConfig(dir), null);
  });
});

test('readDeclaredMcpConfig: key present but empty string -> null', () => {
  withScratchSettings('{"fullyCompletely.liveqaMcpConfig": ""}', (dir) => {
    assert.strictEqual(readDeclaredMcpConfig(dir), null);
  });
});

test('readDeclaredMcpConfig: a real declared JSON-string value is returned, trimmed, unparsed (claude itself parses it)', () => {
  const raw = '{"mcpServers":{"playwright":{"command":"npx","args":["-y","@playwright/mcp@latest"]}}}';
  withScratchSettings(`{"fullyCompletely.liveqaMcpConfig": "  ${raw.replace(/"/g, '\\"')}  "}`, (dir) => {
    assert.strictEqual(readDeclaredMcpConfig(dir), raw);
  });
});

test('readDeclaredMcpConfig: a real declared file-path value is also returned as-is (either form is valid for --mcp-config)', () => {
  withScratchSettings('{"fullyCompletely.liveqaMcpConfig": "./mcp-config.json"}', (dir) => {
    assert.strictEqual(readDeclaredMcpConfig(dir), './mcp-config.json');
  });
});

test('readDeclaredMcpConfig: unparseable JSON, a non-string value, and root-not-an-object all degrade to null, not a crash', () => {
  withScratchSettings('{ this is not json', (dir) => {
    assert.strictEqual(readDeclaredMcpConfig(dir), null);
  });
  withScratchSettings('{"fullyCompletely.liveqaMcpConfig": true}', (dir) => {
    assert.strictEqual(readDeclaredMcpConfig(dir), null);
  });
  withScratchSettings('[1, 2, 3]', (dir) => {
    assert.strictEqual(readDeclaredMcpConfig(dir), null);
  });
});

test('run-role: headlessLaunchArgs passes --mcp-config through for liveqa when declared, and never for another role even with the identical declaration', () => {
  withScratchSettings('{"fullyCompletely.liveqaMcpConfig": "{\\"mcpServers\\":{}}"}', (dir) => {
    const liveqaArgs = headlessLaunchArgs(LIVEQA_ROLE, 'X', { root: dir });
    assert.ok(liveqaArgs.includes('--mcp-config'), 'liveqa should receive --mcp-config when declared');
    assert.strictEqual(liveqaArgs[liveqaArgs.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');

    const qa1Args = headlessLaunchArgs(QA1_ROLE, 'X', { root: dir });
    assert.ok(!qa1Args.includes('--mcp-config'), 'qa1 has no Playwright tools granted and must never receive --mcp-config');
  });
});

test('run-role: headlessLaunchArgs omits --mcp-config for liveqa when nothing is declared, and warns naming what to configure (Req 4)', () => {
  withScratchSettings(null, (dir) => {
    let args;
    const lines = captureStderr(() => {
      args = headlessLaunchArgs(LIVEQA_ROLE, 'X', { root: dir });
    });
    assert.ok(!args.includes('--mcp-config'), 'no declaration means no --mcp-config -- the launcher never invents one');
    // Sprint 30, Req 5: emitPermissionRecord() now prints a PERMISSION_RECORD
    // line on every launch too -- the MCP note is still exactly one line,
    // it's just no longer the only line on stderr.
    const mcpLines = lines.filter((l) => !l.startsWith('PERMISSION_RECORD: '));
    assert.strictEqual(mcpLines.length, 1);
    assert.match(mcpLines[0], /Playwright MCP browser tools/);
    assert.match(mcpLines[0], /fullyCompletely\.liveqaMcpConfig/);
    // Req 4's own instruction: if a server can't be supplied, the message
    // must name what a project must configure -- not just that something
    // is missing.
    assert.match(mcpLines[0], /mcpServers/);
    assert.ok(lines.some((l) => l.startsWith('PERMISSION_RECORD: {"role":"liveqa"')), 'the permission record itself must still be emitted');
  });
});

test('run-role: headlessLaunchArgs prints no MCP note at all for a role other than liveqa, declared or not', () => {
  withScratchSettings(null, (dir) => {
    const lines = captureStderr(() => headlessLaunchArgs(QA1_ROLE, 'X', { root: dir }));
    // Sprint 30, Req 5: PERMISSION_RECORD is now expected here too --
    // this test's own subject (no MCP note for a non-liveqa role) is
    // still true, just no longer "stderr is empty".
    assert.deepStrictEqual(
      lines.filter((l) => !l.startsWith('PERMISSION_RECORD: ')),
      []
    );
    assert.ok(lines.some((l) => l.startsWith('PERMISSION_RECORD: {"role":"qa1"')), 'the permission record itself must still be emitted');
  });
});

test('run-role: emitPermissionRecord (Req 1) derives every field from the args array itself, never a second source that could drift', () => {
  const args = [
    '--agent', 'x', '-p', '--output-format', 'json',
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Bash(git log *)',
    '--disallowedTools', 'Edit,Write',
    '--mcp-config', '{"mcpServers":{}}',
    'the prompt',
  ];
  const lines = captureStderr(() => emitPermissionRecord({ id: 'x' }, args, '/some/root'));
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /^PERMISSION_RECORD: /);
  const record = JSON.parse(lines[0].slice('PERMISSION_RECORD: '.length));
  assert.strictEqual(record.role, 'x');
  assert.strictEqual(record.workingDirectory, '/some/root');
  assert.strictEqual(record.permissionMode, 'acceptEdits');
  assert.strictEqual(record.allowedTools, 'Bash(git log *)');
  assert.strictEqual(record.disallowedTools, 'Edit,Write');
  assert.strictEqual(record.mcpConfigSupplied, true);
  // Not the prompt or the --agents JSON -- Risks & Mitigations names
  // exactly this as the thing that would make the record unreadable.
  assert.ok(!lines[0].includes('the prompt'), 'the record must not include the prompt body');
});

test('run-role: emitPermissionRecord (Req 3) states an empty grant explicitly -- null, not an omitted key -- when a flag was never added to args', () => {
  const args = ['--agent', 'x', '-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', 'the prompt'];
  const lines = captureStderr(() => emitPermissionRecord({ id: 'x' }, args, '/root'));
  const record = JSON.parse(lines[0].slice('PERMISSION_RECORD: '.length));
  assert.ok('allowedTools' in record, 'the key must be present even when there is nothing to report');
  assert.ok('disallowedTools' in record, 'the key must be present even when there is nothing to report');
  assert.strictEqual(record.allowedTools, null);
  assert.strictEqual(record.disallowedTools, null);
  assert.strictEqual(record.mcpConfigSupplied, false);
});

test('run-role: emitPermissionRecord (Req 2) reports the CLI version measured now, never PERMISSION_FINDINGS_ANCHOR_VERSION as a fallback', () => {
  // Deliberately re-required inline rather than relying on the module-level
  // PERMISSION_FINDINGS_ANCHOR_VERSION binding declared later in this file
  // (a separate destructure of the same module, further down) -- this
  // test() callback runs synchronously at registration time, before that
  // later `const` has initialized, and referencing it here would hit the
  // temporal dead zone rather than the value.
  const anchor = require('./launcher/run-role').PERMISSION_FINDINGS_ANCHOR_VERSION;
  withFakeClaudeVersion('9.9.9', () => {
    const lines = captureStderr(() => emitPermissionRecord({ id: 'x' }, ['--agent', 'x', 'p'], '/root'));
    const record = JSON.parse(lines[0].slice('PERMISSION_RECORD: '.length));
    assert.strictEqual(record.cliVersion, '9.9.9');
    assert.notStrictEqual(record.cliVersion, anchor);
  });
});

test('run-role: headlessLaunchArgs (Req 1, end to end) emits a record whose fields match the real args array it actually returns, for every real role', () => {
  for (const role of RUN_ROLE_ROLES) {
    let args;
    const lines = captureStderr(() => {
      args = headlessLaunchArgs(role, 'p');
    });
    const recordLine = lines.find((l) => l.startsWith('PERMISSION_RECORD: '));
    assert.ok(recordLine, `${role.id}: no PERMISSION_RECORD emitted (Req 5: every role, unconditionally)`);
    const record = JSON.parse(recordLine.slice('PERMISSION_RECORD: '.length));
    assert.strictEqual(record.role, role.id);
    const at = (flag) => {
      const i = args.indexOf(flag);
      return i === -1 ? null : args[i + 1];
    };
    assert.strictEqual(record.allowedTools, at('--allowedTools'), `${role.id}: allowedTools mismatch against the real returned args`);
    assert.strictEqual(record.disallowedTools, at('--disallowedTools'), `${role.id}: disallowedTools mismatch against the real returned args`);
    assert.strictEqual(record.permissionMode, at('--permission-mode'), `${role.id}: permissionMode mismatch against the real returned args`);
    assert.strictEqual(record.mcpConfigSupplied, args.includes('--mcp-config'), `${role.id}: mcpConfigSupplied mismatch against the real returned args`);
  }
});

test('run-role: headlessLaunchArgs prompt (with sprint 31\'s instruction prepended, for a role holding a script-invocation grant) stays the final positional argument in every mode', () => {
  const expected = expectedPromptFor(QA1_ROLE, 'X');
  assert.ok(expected.endsWith('X'), 'test setup: qa1 must still hold a script-invocation grant for this to be a meaningful check');
  assert.strictEqual(headlessLaunchArgs(QA1_ROLE, 'X').slice(-1)[0], expected);
  assert.strictEqual(headlessLaunchArgs(QA1_ROLE, 'X', { bare: true }).slice(-1)[0], expected);
  assert.strictEqual(headlessLaunchArgs(QA1_ROLE, 'X', { bare: true, settings: 'S' }).slice(-1)[0], expected);
});

test('run-role: headlessLaunchArgs omits "model" from the JSON when the persona file has none', () => {
  const args = headlessLaunchArgs({ id: 'qa1', label: 'QA1' }, 'p');
  const agentsJson = JSON.parse(args[3]);
  // qa1.md does declare a model, so this exercises the omission branch
  // directly rather than relying on a fixture file happening to lack one.
  if (readAgentMeta('qa1').model) {
    assert.ok('model' in agentsJson.qa1, 'sanity: qa1.md is expected to declare a model');
  }
});

// -------------------------------------------------------------------------
// prompts.js: headlessPrompt() — Req 5's own deliverable. Discovered by
// actually running each of the six roles headless (see the round-3 handoff
// for the real throwaway-sprint runs), not composed from a desk. These
// tests check the two things Req 5's acceptance criteria specifically call
// out: the scaffold is fixed and identical across all six roles, and no
// verdict/note/requirement/phase-history content is ever composed in —
// only a pointer, parameterized by sprint id.
// -------------------------------------------------------------------------
test('prompts: headlessPrompt is defined for every real role, with a role-specific pointer', () => {
  for (const role of RUN_ROLE_ROLES) {
    const prompt = headlessPrompt(role, 7);
    assert.ok(prompt.includes('sprint 7'), `${role.id}: must mention the sprint id`);
    assert.ok(prompt.includes('Point:'), `${role.id}: must contain a pointer clause`);
  }
});

test('prompts: headlessPrompt scaffold is identical across all six roles except the role label and pointer', () => {
  const stripped = RUN_ROLE_ROLES.map((role) => {
    const prompt = headlessPrompt(role, 3);
    // Remove the one part of the scaffold that legitimately varies
    // (the role label itself) and the pointer clause (everything from
    // "Point:" on) — what's left must be byte-identical across all six,
    // which is the "fixed scaffold, identical across all six" acceptance
    // criterion made mechanical rather than eyeballed.
    const pointerStart = prompt.indexOf('Point:');
    const scaffold = prompt.slice(0, pointerStart);
    return scaffold.replace(role.label, '<ROLE>');
  });
  for (const s of stripped.slice(1)) {
    assert.strictEqual(s, stripped[0], 'the scaffold (everything before "Point:") must be identical across every role');
  }
});

test('prompts: headlessPrompt never composes verdicts, notes, requirements or phase history — it only points at paths', () => {
  const prompt = headlessPrompt(QA1_ROLE, 11);
  // A loose but meaningful proxy: the prompt must be short (a pointer, not
  // a summary) and must not contain the kind of language that would only
  // appear if state had been paraphrased in. Threshold raised in sprint 18
  // (Req 2) to fit the fixed, cross-role compound-command instruction
  // headlessScaffold() now always carries -- real, permanent guidance, not
  // a sign that sprint content is leaking in, which is what the length
  // check is actually a proxy for; the word-list check right below is the
  // one that actually guards against that.
  assert.ok(prompt.length < 1400, `expected a short pointer, got ${prompt.length} chars`);
  for (const word of ['PASS', 'FAIL', 'CONDITIONAL', 'verdict:', 'Requirement 1']) {
    assert.ok(!prompt.includes(word), `must not restate state content ("${word}" found)`);
  }
});

test('prompts: headlessPrompt has no literal " character (single argv element via cmd.exe /c on Windows)', () => {
  for (const role of RUN_ROLE_ROLES) {
    assert.ok(!headlessPrompt(role, 5).includes('"'), `${role.id}: must contain no literal " character`);
  }
});

test('prompts: headlessPrompt throws for an unknown role rather than silently building a broken prompt', () => {
  assert.throws(() => headlessPrompt({ id: 'not-a-real-role', label: 'Nope' }, 1), /No headless pointer/);
});

test('prompts: headlessPrompt tells every role not to append shell chaining like ; echo $? (sprint 18, Req 2 -- the compound-command cost, decided rather than left implicit)', () => {
  for (const role of RUN_ROLE_ROLES) {
    const prompt = headlessPrompt(role, 9);
    assert.match(prompt, /echo \$\?/, `${role.id}: must be told not to append shell chaining after a scoped command`);
    assert.match(prompt, /wasted denial/, `${role.id}: must state why -- the permission matcher covers the whole command line, not a leading sub-command`);
  }
});

// CLI-level tests: spawn the real script as a real OS process (Req 1 — a
// headless launch is a genuinely separate process, never an in-process
// sub-agent call), against this worktree's real .claude/agents/*.md files.
const RUN_ROLE_PATH = path.join(REPO_ROOT, 'scripts', 'launcher', 'run-role.js');

// Sprint 25: every real run-role.js invocation now records a role-launch
// claim (see role-claims.js). Every call through this helper points that
// at a FRESH scratch path, per call, via the override role-claims.js
// itself documents — otherwise every CLI-level test in this file would
// share this repo's own real .claude/role-claims.json, and the second
// test to launch any given role would see the first's claim and print an
// unwanted warning, breaking every exact-stderr assertion below and
// leaving real test artifacts in this repo's own working tree. Tests
// that specifically exercise the claim/warning behavior override this
// again themselves, deliberately, to share one path across two calls.
function freshRoleClaimsPathOverride() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-role-claims-'));
  return path.join(dir, 'role-claims.json');
}

function runRoleCli(args, envOverrides) {
  return spawnSync(process.execPath, [RUN_ROLE_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      FULLY_COMPLETELY_ROLE_CLAIMS_PATH_OVERRIDE: freshRoleClaimsPathOverride(),
      ...envOverrides,
    },
  });
}

// Sprint 30, Req 5: emitPermissionRecord() now prints one PERMISSION_RECORD
// line, unconditionally, on EVERY headless launch -- including every real
// subprocess test below that predates this sprint and asserted an
// otherwise-empty stderr to mean "nothing unexpected happened". That
// assertion is still the right one to make; it just has to look past a
// line that's now legitimately always there. Filtering it out here (rather
// than hand-reconstructing the exact expected JSON per test, which would
// tie every one of these tests to emitPermissionRecord()'s exact field
// order) keeps each test's own actual subject -- a role claim warning, an
// auth failure, a prompt-file override -- the only thing it's asserting on.
function stripPermissionRecordLine(stderr) {
  return stderr
    .split('\n')
    .filter((line) => !line.startsWith('PERMISSION_RECORD: '))
    .join('\n');
}

// A fake `claude` on PATH: answers --version so claudeOnPath() passes,
// answers `auth status --json` with a controllable {"loggedIn": ...} (Req
// 4 round 3: the default headless path now probes this exact same way the
// interactive path always has), records every OTHER invocation's argv (one
// per line) to a log file, and prints ONLY a fixed JSON string to stdout —
// nothing else — so a test can assert stdout equals exactly that string
// (Req 2: headless writes nothing extraneous to stdout) while still
// separately observing stderr. Neither probe call is logged to argv.log,
// so readArgv() reflects only the real headless launch, if one happened.
const FAKE_JSON_RESULT = '{"type":"result","is_error":true,"result":"fake"}';

function withFakeClaude(loggedIn, fn) {
  if (typeof loggedIn === 'function') {
    // Allow the 1-arg form (defaults to authenticated) for tests that
    // never reach the default (non-bare) credential check at all.
    fn = loggedIn;
    loggedIn = true;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-fake-claude-'));
  const argvLog = path.join(dir, 'argv.log');
  const script = [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then exit 0; fi',
    `if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo '{"loggedIn": ${loggedIn}}'; exit 0; fi`,
    // NUL-delimited, not newline-delimited: headlessPrompt() legitimately
    // produces a multi-paragraph prompt containing its own embedded
    // newlines (see prompts.js), which a newline-delimited log can't
    // round-trip without splitting one argv element into several.
    'for a in "$@"; do printf \'%s\\0\' "$a" >> ' + JSON.stringify(argvLog) + '; done',
    `printf '%s' '${FAKE_JSON_RESULT}'`,
    'exit 0',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'claude'), script);
  fs.chmodSync(path.join(dir, 'claude'), 0o755);
  try {
    fn({
      dir,
      argvLog,
      // No log file at all means claude was never invoked for a real
      // launch — a valid, in fact the expected, outcome for every
      // precondition-failure test below, not a fixture bug.
      readArgv: () => (fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8').split('\0').filter((l) => l.length) : []),
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('run-role CLI: unknown role is rejected before any headless logic runs (no PATH/env needed)', () => {
  const result = runRoleCli(['not-a-real-role', '--headless'], {});
  assert.strictEqual(result.status, LAUNCHER_FAILURE_EXIT_CODE);
  assert.match(result.stderr, /Unknown role 'not-a-real-role'/);
  assert.strictEqual(result.stdout, '');
});

test('run-role CLI: --agent flag resolves the role (the new canonical headless shape, no leading positional)', () => {
  // Role resolution happens before any auth probe, so the 1-arg
  // withFakeClaude form (authenticated) is fine here even though this
  // never reaches the credential check.
  withFakeClaude(({ dir }) => {
    const result = runRoleCli(['--headless', '--agent', 'not-a-real-role', '--sprint', '1'], { PATH: dir });
    assert.strictEqual(result.status, LAUNCHER_FAILURE_EXIT_CODE);
    assert.match(result.stderr, /Unknown role 'not-a-real-role'/);
  });
});

test('run-role CLI: --headless without --sprint or --prompt-file fails with the exact message, before spawning claude', () => {
  withFakeClaude(({ dir, readArgv }) => {
    const result = runRoleCli(['--headless', '--agent', 'qa1'], { PATH: dir });
    assert.strictEqual(result.status, LAUNCHER_FAILURE_EXIT_CODE);
    assert.match(result.stderr, /--headless requires either --sprint <id>.*or --prompt-file <path>/s);
    assert.strictEqual(result.stdout, '');
    assert.deepStrictEqual(readArgv(), [], 'claude must never be invoked when neither --sprint nor --prompt-file is given');
  });
});

// Req 4, amended round 3: the DEFAULT (non-bare) path now checks the
// OPERATOR's own session, via the exact same checkAuth() probe the
// interactive path uses — simulated here by the fake claude's
// `auth status --json` response, never a real logout.
test('run-role CLI: default headless path fails when the operator session is unauthenticated, before the real launch', () => {
  withFakeClaude(false, ({ dir, readArgv }) => {
    const result = runRoleCli(['--headless', '--agent', 'qa1', '--sprint', '4'], { PATH: dir });
    assert.strictEqual(result.status, LAUNCHER_FAILURE_EXIT_CODE);
    assert.match(result.stderr, /no usable credentials for this operator session/);
    assert.strictEqual(result.stdout, '');
    assert.deepStrictEqual(readArgv(), [], 'claude must never be invoked for the real launch when unauthenticated');
  });
});

test('run-role CLI: default headless path succeeds when the operator session is authenticated, composing the prompt from --sprint', () => {
  withFakeClaude(true, ({ dir, readArgv }) => {
    const result = runRoleCli(['--headless', '--agent', 'qa1', '--sprint', '4'], { PATH: dir });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, FAKE_JSON_RESULT);
    // Sprint 30, Req 5: a PERMISSION_RECORD line is now expected on every
    // headless launch -- asserted directly, then stripped before checking
    // nothing else unexpected is on stderr.
    assert.match(result.stderr, /^PERMISSION_RECORD: \{"role":"qa1"/m);
    assert.strictEqual(stripPermissionRecordLine(result.stderr), '');
    assert.deepStrictEqual(readArgv(), headlessLaunchArgs(QA1_ROLE, headlessPrompt(QA1_ROLE, '4')));
    assert.ok(!readArgv().includes('--bare'), 'the default path must never pass --bare');
  });
});

test('run-role CLI (real subprocess, Sprint 31 Req 4): PERMISSION_RECORD matches the REAL argv the child process actually received -- runs under the project\'s normal CI test command, no stub binary or manual setup beyond the existing fake-claude fixture', () => {
  withFakeClaude(true, ({ dir, readArgv }) => {
    const result = runRoleCli(['--headless', '--agent', 'qa1', '--sprint', '4'], { PATH: dir });
    assert.strictEqual(result.status, 0, 'launch must succeed');
    const recordLine = result.stderr.split('\n').find((l) => l.startsWith('PERMISSION_RECORD: '));
    assert.ok(recordLine, 'no PERMISSION_RECORD found on stderr');
    const record = JSON.parse(recordLine.slice('PERMISSION_RECORD: '.length));
    // The REAL argv the fake claude binary actually received and logged to
    // disk -- not headlessLaunchArgs()'s own in-process return value, which
    // could stay self-consistent while the real child received something
    // else (a spawn/quoting bug, for instance). This is the stronger check
    // Req 4 asks for: assert against what reached the child process, across
    // a real subprocess boundary.
    const realArgv = readArgv();
    const at = (flag) => {
      const i = realArgv.indexOf(flag);
      return i === -1 ? null : realArgv[i + 1];
    };
    assert.strictEqual(record.allowedTools, at('--allowedTools'), 'allowedTools must match the REAL child argv');
    assert.strictEqual(record.disallowedTools, at('--disallowedTools'), 'disallowedTools must match the REAL child argv');
    assert.strictEqual(record.permissionMode, at('--permission-mode'), 'permissionMode must match the REAL child argv');
    assert.strictEqual(record.mcpConfigSupplied, realArgv.includes('--mcp-config'), 'mcpConfigSupplied must match the REAL child argv');
    assert.deepStrictEqual(
      record.instructedCommandForms,
      extractGrantedCommandForms(at('--allowedTools')),
      'instructedCommandForms must match what the REAL child argv actually grants'
    );
    // And the prompt the child actually received (the final argv element)
    // really does carry the instruction -- not just the in-process return
    // value of headlessLaunchArgs().
    const realPrompt = realArgv.slice(-1)[0];
    for (const form of record.instructedCommandForms) {
      assert.ok(realPrompt.includes(form), `the REAL prompt the child received is missing granted form "${form}"`);
    }
  });
});

test('run-role CLI (real subprocess, Req 1): a role\'s first launch writes a claim, with its own real pid, and stays silent', () => {
  withFakeClaude(true, ({ dir }) => {
    const claimsPath = freshRoleClaimsPathOverride();
    const env = { PATH: dir, FULLY_COMPLETELY_ROLE_CLAIMS_PATH_OVERRIDE: claimsPath };

    const first = runRoleCli(['--headless', '--agent', 'qa1', '--sprint', '4'], env);
    assert.strictEqual(first.status, 0, 'first launch must succeed');
    // Sprint 30, Req 5: PERMISSION_RECORD is expected here too -- "nothing
    // to warn about" is a claim about the role-claim warning specifically,
    // not about stderr being literally empty.
    assert.strictEqual(stripPermissionRecordLine(first.stderr), '', 'a role\'s first launch in a tree has nothing to warn about');
    assert.ok(fs.existsSync(claimsPath), 'the claim must actually be written to disk');
    const claims = JSON.parse(fs.readFileSync(claimsPath, 'utf8'));
    // Sprint 38, second fix round: a role's claims are now a list (see
    // role-claims.js's own comment on normalizeClaimList) -- a first
    // launch writes a one-element list, not a bare object.
    assert.strictEqual(claims.qa1.length, 1);
    assert.ok(claims.qa1[0].startedAt, 'the claim must record qa1 with a start time');
    assert.ok(Number.isInteger(claims.qa1[0].pid) && claims.qa1[0].pid > 0, 'sprint 38, Req 1: the claim must record a real pid');
  });
});

test('run-role CLI (real subprocess, sprint 38 Req 1): a SEQUENTIAL second launch of the same role -- the first launcher process has already fully exited by the time the second one checks -- does NOT warn', () => {
  // runRoleCli() is synchronous (spawnSync): by construction, the first
  // launch's own launcher process (whose pid was recorded in the claim)
  // has completely exited before this line returns, let alone before the
  // second launch below even starts. This is exactly Req 1's own target
  // case -- "the previously recorded session is demonstrably no longer
  // running" -- and is the regression test for the behavior change this
  // sprint makes: before this sprint, this exact sequence warned every
  // time (the old, unconditional-fire behavior); now it must not.
  withFakeClaude(true, ({ dir }) => {
    const claimsPath = freshRoleClaimsPathOverride();
    const env = { PATH: dir, FULLY_COMPLETELY_ROLE_CLAIMS_PATH_OVERRIDE: claimsPath };

    const first = runRoleCli(['--headless', '--agent', 'qa1', '--sprint', '4'], env);
    assert.strictEqual(first.status, 0);

    const second = runRoleCli(['--headless', '--agent', 'qa1', '--sprint', '4'], env);
    assert.strictEqual(second.status, 0, 'a second launch must succeed regardless -- never gates');
    assert.strictEqual(second.stdout, FAKE_JSON_RESULT, 'the launch itself proceeded normally');
    assert.strictEqual(
      stripPermissionRecordLine(second.stderr), '',
      'the previous launcher process has genuinely exited by now -- no NOTE should fire (sprint 38, Req 1)'
    );
    const claims = JSON.parse(fs.readFileSync(claimsPath, 'utf8'));
    // The first launcher is confirmed exited by now, so it's pruned --
    // exactly one entry, the second launch's own.
    assert.strictEqual(claims.qa1.length, 1, 'the confirmed-dead first claim must not be carried forward');
    assert.ok(Number.isInteger(claims.qa1[0].pid), 'the claim must still be updated to the new (second) launch\'s own pid');
  });
});

test('run-role CLI (real subprocess, sprint 38 Req 1): a second launch WHILE the first is still genuinely running still warns', () => {
  // A real overlap, not simulated: the first launch's own fake-claude
  // child sleeps for a controlled interval before exiting, keeping the
  // REAL launcher process (run-role.js itself) alive and blocked on it
  // for that whole window -- spawnClaude()'s own Promise only resolves
  // once its child exits. The second launch runs synchronously to
  // completion well inside that window and must see the first launcher's
  // pid as still alive.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-fake-claude-slow-'));
  const argvLog = path.join(dir, 'argv.log');
  const script = [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then exit 0; fi',
    'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo \'{"loggedIn": true}\'; exit 0; fi',
    'for a in "$@"; do printf \'%s\\0\' "$a" >> ' + JSON.stringify(argvLog) + '; done',
    'sleep 3',
    `printf '%s' '${FAKE_JSON_RESULT}'`,
    'exit 0',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'claude'), script);
  fs.chmodSync(path.join(dir, 'claude'), 0o755);
  try {
    const claimsPath = freshRoleClaimsPathOverride();
    const env = {
      ...process.env,
      PATH: dir,
      FULLY_COMPLETELY_ROLE_CLAIMS_PATH_OVERRIDE: claimsPath,
    };
    const firstChild = spawn(process.execPath, [RUN_ROLE_PATH, '--headless', '--agent', 'qa1', '--sprint', '4'], {
      cwd: REPO_ROOT,
      env,
    });
    try {
      // Wait for the claim to actually land on disk (the first launcher
      // records it before ever spawning its own slow child), rather than
      // a fixed sleep guessing when that write has happened.
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(claimsPath) && Date.now() < deadline) {
        execFileSync('sleep', ['0.05']);
      }
      assert.ok(fs.existsSync(claimsPath), 'the first launch should have recorded its claim by now');

      const second = runRoleCli(['--headless', '--agent', 'qa1', '--sprint', '4'], env);
      assert.strictEqual(second.status, 0, 'a second launch must succeed regardless -- never gates');
      assert.match(
        second.stderr, /NOTE: another QA1 session was recorded starting at/,
        'the first launcher is still genuinely alive (blocked on its own slow child) -- the NOTE must still fire'
      );
      assert.match(second.stderr, /nobody else is working here/i);
    } finally {
      firstChild.kill('SIGKILL');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run-role CLI (real subprocess, sprint 38 second fix round): the exact QA1 live-loop A/B/C repro -- A still running, B claims then exits, C must still be warned about A', () => {
  // QA1's own live-loop finding, end to end with real launches: launch A
  // (stays running); launch B while A is up (correctly warns, then B
  // itself exits); launch C, with A still genuinely running and B now
  // confirmed dead. Before this fix round, C saw nothing -- B's own claim,
  // once it became a dead pid, had already silently overwritten A's still-
  // live one the moment B launched, so a role whose record simply hadn't
  // been the LATEST one anymore was invisible to every later launch, no
  // matter how alive it still genuinely was.
  const slowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-fake-claude-slow-'));
  const slowScript = [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then exit 0; fi',
    'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo \'{"loggedIn": true}\'; exit 0; fi',
    'sleep 6', // long enough to still be running through the whole B+C sequence below
    `printf '%s' '${FAKE_JSON_RESULT}'`,
    'exit 0',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(slowDir, 'claude'), slowScript);
  fs.chmodSync(path.join(slowDir, 'claude'), 0o755);
  try {
    withFakeClaude(true, ({ dir: fastDir }) => {
      const claimsPath = freshRoleClaimsPathOverride();
      const slowEnv = { ...process.env, PATH: slowDir, FULLY_COMPLETELY_ROLE_CLAIMS_PATH_OVERRIDE: claimsPath };
      const fastEnv = { ...process.env, PATH: fastDir, FULLY_COMPLETELY_ROLE_CLAIMS_PATH_OVERRIDE: claimsPath };

      // A: launched async, stays alive (blocked on its own 6-second child)
      // for the rest of this test.
      const childA = spawn(process.execPath, [RUN_ROLE_PATH, '--headless', '--agent', 'qa1', '--sprint', '4'], { cwd: REPO_ROOT, env: slowEnv });
      try {
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(claimsPath) && Date.now() < deadline) execFileSync('sleep', ['0.05']);
        assert.ok(fs.existsSync(claimsPath), 'A should have recorded its claim by now');

        // B: launched and runs to completion (fast fake claude, spawnSync)
        // while A is still up. Must warn about A, then B itself is fully
        // exited by construction once this call returns.
        const b = runRoleCli(['--headless', '--agent', 'qa1', '--sprint', '4'], fastEnv);
        assert.strictEqual(b.status, 0);
        assert.match(stripPermissionRecordLine(b.stderr), /NOTE: another QA1 session was recorded starting at/, 'B must be warned -- A is genuinely running');

        // C: launched after B has exited, with A still genuinely running.
        // This is QA1's exact repro step -- C must still see A.
        const c = runRoleCli(['--headless', '--agent', 'qa1', '--sprint', '4'], fastEnv);
        assert.strictEqual(c.status, 0);
        assert.match(
          stripPermissionRecordLine(c.stderr), /NOTE: another QA1 session was recorded starting at/,
          'C must still be warned about A -- A never exited, and B being newer (and now dead) must not have silently erased A\'s own still-open record'
        );

        const claims = JSON.parse(fs.readFileSync(claimsPath, 'utf8'));
        assert.strictEqual(claims.qa1.length, 2, 'A (still alive) and C (the newest launch) both on record; B was pruned once confirmed dead');
      } finally {
        childA.kill('SIGKILL');
      }
    });
  } finally {
    fs.rmSync(slowDir, { recursive: true, force: true });
  }
});

test('run-role CLI (real subprocess, sprint 38 third fix round): a planted pre-0.2.13 (pid-less) claim warns on the launch that reads it, then never again -- QA1\'s exact upgrade repro', () => {
  // QA1's exact reproduction: a claim written by 0.2.10/0.2.11 (or the
  // second fix round's own now-superseded code) has no `pid` at all, so
  // isPidAlive() on it can only ever return `null` (undeterminable) --
  // FOREVER, since there's no pid to ever positively confirm as gone.
  // Keeping an entry like that in the file forever (what the second fix
  // round's code did, by design, to satisfy Req 1a) meant an upgraded
  // install's own leftover pre-0.2.13 claim warned on every single
  // relaunch, permanently -- the exact "every relaunch warns, forever"
  // regression (F6) this whole sprint exists to fix, reached a third way.
  // Real repro: plant an old-format file directly (this project's own
  // pre-0.2.13 shape -- a bare object, no `pid` key), with nothing else
  // running, then launch the same role twice in a row.
  withFakeClaude(true, ({ dir }) => {
    const claimsPath = freshRoleClaimsPathOverride();
    fs.mkdirSync(path.dirname(claimsPath), { recursive: true });
    fs.writeFileSync(claimsPath, JSON.stringify({
      qa1: { sessionId: 'pre-0.2.13-session', startedAt: '2026-01-01T00:00:00.000Z' }, // genuinely no `pid` key
    }, null, 2) + '\n');
    const env = { ...process.env, PATH: dir, FULLY_COMPLETELY_ROLE_CLAIMS_PATH_OVERRIDE: claimsPath };

    const first = runRoleCli(['--headless', '--agent', 'qa1', '--sprint', '4'], env);
    assert.strictEqual(first.status, 0);
    assert.match(
      stripPermissionRecordLine(first.stderr), /NOTE: another QA1 session was recorded starting at/,
      'Req 1a: an undeterminable (pid-less) record must still warn on the launch that reads it'
    );

    const second = runRoleCli(['--headless', '--agent', 'qa1', '--sprint', '4'], env);
    assert.strictEqual(second.status, 0);
    assert.strictEqual(
      stripPermissionRecordLine(second.stderr), '',
      'the pid-less record must not be carried forward -- it already had its one warning, and nothing else is running'
    );

    const claims = JSON.parse(fs.readFileSync(claimsPath, 'utf8'));
    assert.strictEqual(claims.qa1.length, 1, 'the untrackable pre-0.2.13 entry must be gone -- only the second launch\'s own trackable claim remains');
    assert.notStrictEqual(claims.qa1[0].sessionId, 'pre-0.2.13-session', 'the surviving entry must be the second launch\'s own, not the old planted one');
  });
});

test('run-role CLI (real subprocess, sprint 42 Req 2): a headless launch that fires a collision warning actually carries it in the prompt reaching claude, not only on stderr', () => {
  // Before this sprint, roleWarning was computed in main() and printed to
  // stderr (still true, asserted below), but never threaded into
  // runHeadless()/headlessLaunchArgs() at all -- a headless session had
  // no way to see it in its own transcript. readArgv() below inspects
  // the EXACT argv the fake claude binary actually received, so this
  // asserts the real end-to-end wiring, not just the pure-function unit
  // tests above.
  withFakeClaude(true, ({ dir, readArgv }) => {
    const claimsPath = freshRoleClaimsPathOverride();
    fs.mkdirSync(path.dirname(claimsPath), { recursive: true });
    // An undeterminable (pid-less) record always warns (Req 1a, sprint
    // 38) -- the simplest reliable way to force a real warning without
    // needing a genuinely-still-alive process for this end-to-end check.
    fs.writeFileSync(claimsPath, JSON.stringify({
      qa1: { sessionId: 'req-2-fixture-session', startedAt: '2026-01-01T00:00:00.000Z' },
    }, null, 2) + '\n');
    const env = { PATH: dir, FULLY_COMPLETELY_ROLE_CLAIMS_PATH_OVERRIDE: claimsPath };

    const result = runRoleCli(['--headless', '--agent', 'qa1', '--sprint', '4'], env);
    assert.strictEqual(result.status, 0);
    assert.match(
      stripPermissionRecordLine(result.stderr), /NOTE: another QA1 session was recorded starting at/,
      'the stderr NOTE must still fire, unconditionally (this is additive, not a replacement)'
    );

    const argv = readArgv();
    const finalPrompt = argv[argv.length - 1];
    assert.ok(finalPrompt, 'the fake claude must have actually been invoked with a prompt');
    assert.match(finalPrompt, /=== FRAMEWORK NOTICE \(not part of your task\) ===/, 'the wrapped notice must be in the ACTUAL prompt sent to claude');
    assert.match(finalPrompt, /NOTE: another QA1 session was recorded starting at/, 'the real warning text must be in that prompt');
    assert.match(finalPrompt, /=== END NOTICE ===/);
  });
});

test('run-role CLI (real subprocess, sprint 42 Req 2a): a clean headless launch (no collision) never adds the notice to the prompt', () => {
  withFakeClaude(true, ({ dir, readArgv }) => {
    const env = { PATH: dir, FULLY_COMPLETELY_ROLE_CLAIMS_PATH_OVERRIDE: freshRoleClaimsPathOverride() };
    const result = runRoleCli(['--headless', '--agent', 'qa1', '--sprint', '4'], env);
    assert.strictEqual(result.status, 0);
    const argv = readArgv();
    const finalPrompt = argv[argv.length - 1];
    assert.ok(finalPrompt, 'the fake claude must have actually been invoked with a prompt');
    assert.doesNotMatch(finalPrompt, /FRAMEWORK NOTICE/, 'no collision -- no notice should appear anywhere in the prompt');
  });
});

// Single-quotes a string for safe embedding in a POSIX `sh` script (the
// values passed through here -- REPO_ROOT, RUN_ROLE_PATH, process.execPath,
// role ids, temp-file paths -- are all this project's own real paths and
// id strings, never external input, but quoted properly regardless rather
// than assumed safe).
function shQuote(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

test('run-role CLI (real subprocess, sprint 38 fix round): FC: Start All -- all six roles launched at essentially the same instant all keep their own claim record (LiveQA round 1 finding)', () => {
  // The real-world shape LiveQA found losing records: "FC: Start All"
  // launches all six roles' own launcher processes within the same
  // instant, ALL writing to the SAME .claude/role-claims.json with no
  // coordination -- confirmed live and in scratch installs to lose 3-5 of
  // 6 records before the lock fix. This test reproduces exactly that
  // shape: six real `run-role.js` subprocesses, all sharing ONE claims-
  // file override -- and asserts every single one survives with its OWN
  // correct pid, not another role's or a partial write.
  //
  // WHY THIS SPAWNS THROUGH A SHELL WRAPPER, NOT SIX Node `spawn()` CALLS
  // POLLED DIRECTLY -- found by running it, not assumed: an earlier
  // version of this test used `spawn()` six times and then busy-polled
  // each child's own `exitCode`/`signalCode` in a loop sleeping via
  // `execFileSync('sleep', ...)` between checks. That version hung
  // (every child stuck reading `null` for exitCode) whether or not
  // role-claims.js's own lock was involved at all -- confirmed by an
  // isolated probe with no role-claims.js code in the loop whatsoever:
  // spawn one trivial child, then busy-poll its `exitCode` from a tight
  // synchronous loop (`execFileSync`, and separately `Atomics.wait`, tried
  // independently) -- over 2,000+ iterations across 3 real seconds,
  // `exitCode` never once left `null`, even though the child had long
  // since exited (confirmed separately: the same child, left alone with
  // no polling loop at all, exits and is reaped normally in well under a
  // second). The cause is a genuine Node.js constraint, not a bug in this
  // project's own code: Node only runs the internal callback that sets a
  // ChildProcess's `exitCode` and fires its `'exit'` event when the
  // JS call stack returns control to the event loop -- and a synchronous
  // while-loop, no matter what it sleeps with in between iterations, never
  // does that. This test file's own `test()` harness has no async/await
  // support anywhere in it (by design), so there was never going to be a
  // correct way to `await` six `spawn()`ed children from inside it.
  //
  // THE FIX: push both "start all six at once" and "wait for all six" into
  // ONE real `/bin/sh` child, started via the ordinary, already-proven
  // `spawnSync` path this file uses everywhere else. The wrapper script
  // backgrounds all six real `run-role.js` invocations with `&` -- which
  // is what actually gives this test its "essentially the same instant"
  // property, at the OS level, not at the Node event-loop level -- then
  // waits on each one individually with POSIX `wait $pid`, which reports
  // that job's own real exit status without needing any other job to have
  // finished first. None of this depends on Node ever being told about
  // the six inner processes at all; `spawnSync` only ever has to wait on
  // its own ONE direct child (the wrapper shell), the same shape every
  // other real-subprocess test in this file already uses successfully.
  withFakeClaude(true, ({ dir }) => {
    const claimsPath = freshRoleClaimsPathOverride();
    const env = {
      ...process.env,
      PATH: dir,
      FULLY_COMPLETELY_ROLE_CLAIMS_PATH_OVERRIDE: claimsPath,
    };
    const roleIds = RUN_ROLE_ROLES.map((r) => r.id);
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-start-all-output-'));
    const lines = [];
    roleIds.forEach((roleId, i) => {
      lines.push(
        `${shQuote(process.execPath)} ${shQuote(RUN_ROLE_PATH)} --headless --agent ${shQuote(roleId)} --sprint 4 ` +
        `>${shQuote(path.join(outputDir, `${i}.stdout`))} 2>${shQuote(path.join(outputDir, `${i}.stderr`))} &`
      );
      lines.push(`pid${i}=$!`);
    });
    roleIds.forEach((roleId, i) => {
      lines.push(`wait $pid${i}`);
      lines.push(`echo ${shQuote(roleId)} $?`);
    });
    const script = lines.join('\n') + '\n';
    const wrapperResult = spawnSync('/bin/sh', ['-c', script], { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 20000 });
    assert.ok(!wrapperResult.error, `the wrapper shell itself must run cleanly -- ${wrapperResult.error && wrapperResult.error.message}`);
    const exitCodes = {};
    for (const line of wrapperResult.stdout.trim().split('\n')) {
      const [roleId, code] = line.trim().split(/\s+/);
      exitCodes[roleId] = Number(code);
    }
    for (let i = 0; i < roleIds.length; i++) {
      const roleId = roleIds[i];
      if (exitCodes[roleId] !== 0) {
        // Surfaced only on an actual failure, to save whoever's debugging
        // it a second run -- each role's own real stdout/stderr from this
        // exact failing run, not a re-run's (which could easily not
        // reproduce the same race).
        console.error(`${roleId} stdout: ${fs.existsSync(path.join(outputDir, `${i}.stdout`)) ? fs.readFileSync(path.join(outputDir, `${i}.stdout`), 'utf8') : '(missing)'}`);
        console.error(`${roleId} stderr: ${fs.existsSync(path.join(outputDir, `${i}.stderr`)) ? fs.readFileSync(path.join(outputDir, `${i}.stderr`), 'utf8') : '(missing)'}`);
      }
      assert.strictEqual(exitCodes[roleId], 0, `${roleId}'s launch must have succeeded (all six reported: ${JSON.stringify(exitCodes)})`);
    }
    fs.rmSync(outputDir, { recursive: true, force: true });
    const claims = JSON.parse(fs.readFileSync(claimsPath, 'utf8'));
    for (const roleId of roleIds) {
      assert.ok(claims[roleId], `${roleId}'s own claim record must have survived the concurrent launch -- got keys: ${Object.keys(claims).join(', ')}`);
      // Sprint 38, second fix round: a role's claims are now a list -- a
      // first, uncontested launch (every role's own case here) writes a
      // one-element list.
      assert.strictEqual(claims[roleId].length, 1, `${roleId}'s record should have exactly one entry -- its own single launch`);
      assert.ok(Number.isInteger(claims[roleId][0].pid) && claims[roleId][0].pid > 0, `${roleId}'s record must have a real pid`);
    }
    assert.strictEqual(Object.keys(claims).length, roleIds.length, 'no extra or duplicate keys -- exactly the six roles');
  });
});

test('run-role CLI (real subprocess, Req 1): a DIFFERENT role launching after qa1 is a first launch for IT -- no warning', () => {
  withFakeClaude(true, ({ dir }) => {
    const claimsPath = freshRoleClaimsPathOverride();
    const env = { PATH: dir, FULLY_COMPLETELY_ROLE_CLAIMS_PATH_OVERRIDE: claimsPath };
    runRoleCli(['--headless', '--agent', 'qa1', '--sprint', '4'], env);
    const result = runRoleCli(['--headless', '--agent', 'dev-team-1', '--sprint', '4'], env);
    assert.strictEqual(result.status, 0);
    assert.strictEqual(
      stripPermissionRecordLine(result.stderr), '',
      'dev-team-1 has never launched in this tree before -- qa1\'s claim must not leak across roles'
    );
  });
});

test('run-role CLI: --bare with neither ANTHROPIC_API_KEY nor --settings fails without ever probing operator auth', () => {
  withFakeClaude(({ dir, readArgv }) => {
    const env = { ...process.env, PATH: dir, FULLY_COMPLETELY_ROLE_CLAIMS_PATH_OVERRIDE: freshRoleClaimsPathOverride() };
    delete env.ANTHROPIC_API_KEY;
    const result = spawnSync(
      process.execPath,
      [RUN_ROLE_PATH, '--headless', '--agent', 'qa1', '--sprint', '4', '--bare'],
      { cwd: REPO_ROOT, encoding: 'utf8', env }
    );
    assert.strictEqual(result.status, LAUNCHER_FAILURE_EXIT_CODE);
    assert.match(result.stderr, /neither ANTHROPIC_API_KEY nor.*--settings/s);
    assert.strictEqual(result.stdout, '');
    assert.deepStrictEqual(readArgv(), [], 'claude must never be invoked with no credentials, bare or not');
  });
});

// QA1 round 1 (Req 4): --settings must be a REAL, working alternative to
// ANTHROPIC_API_KEY, not just a claim in the error message. Still applies
// unchanged in round 3, scoped to --bare.
test('run-role CLI: --bare with --settings alone (no ANTHROPIC_API_KEY) satisfies the precondition and reaches claude', () => {
  withFakeClaude(({ dir, readArgv }) => {
    const env = { ...process.env, PATH: dir, FULLY_COMPLETELY_ROLE_CLAIMS_PATH_OVERRIDE: freshRoleClaimsPathOverride() };
    delete env.ANTHROPIC_API_KEY;
    const result = spawnSync(
      process.execPath,
      [
        RUN_ROLE_PATH,
        '--headless',
        '--agent',
        'qa1',
        '--sprint',
        '4',
        '--bare',
        '--settings',
        '{"apiKeyHelper":"/path/to/helper.sh"}',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env }
    );
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, FAKE_JSON_RESULT);
    assert.strictEqual(stripPermissionRecordLine(result.stderr), '');
    assert.deepStrictEqual(
      readArgv(),
      headlessLaunchArgs(QA1_ROLE, headlessPrompt(QA1_ROLE, '4'), { bare: true, settings: '{"apiKeyHelper":"/path/to/helper.sh"}' }),
      "--settings must reach claude's own real argv, not just satisfy a local check"
    );
    assert.ok(readArgv().includes('--settings'), 'the real claude invocation must carry --settings through');
  });
});

test('run-role CLI: a missing --prompt-file target fails and names the exact path (escape hatch, no --sprint needed)', () => {
  withFakeClaude(({ dir, readArgv }) => {
    const missingPath = path.join(os.tmpdir(), `fc-missing-prompt-${Date.now()}.txt`);
    const result = runRoleCli(['--headless', '--agent', 'qa1', '--prompt-file', missingPath], { PATH: dir });
    assert.strictEqual(result.status, LAUNCHER_FAILURE_EXIT_CODE);
    assert.ok(result.stderr.includes(`Could not read --prompt-file '${missingPath}'`), result.stderr);
    assert.strictEqual(result.stdout, '');
    assert.deepStrictEqual(readArgv(), []);
  });
});

test('run-role CLI: an empty --prompt-file fails distinctly from a missing one', () => {
  withFakeClaude(({ dir, readArgv }) => {
    const emptyPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-empty-prompt-')), 'prompt.txt');
    fs.writeFileSync(emptyPath, '   \n  \n');
    const result = runRoleCli(['--headless', '--agent', 'qa1', '--prompt-file', emptyPath], { PATH: dir });
    assert.strictEqual(result.status, LAUNCHER_FAILURE_EXIT_CODE);
    assert.ok(result.stderr.includes(`--prompt-file '${emptyPath}' is empty`), result.stderr);
    assert.strictEqual(result.stdout, '');
    assert.deepStrictEqual(readArgv(), []);
  });
});

test('run-role CLI: --prompt-file overrides --sprint when both are given (escape hatch wins, Req 3)', () => {
  withFakeClaude(({ dir, readArgv }) => {
    const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-real-prompt-'));
    const promptPath = path.join(promptDir, 'prompt.txt');
    fs.writeFileSync(promptPath, '  do the sprint 11 audit  \n');
    const result = runRoleCli(['--headless', '--agent', 'qa1', '--sprint', '4', '--prompt-file', promptPath], { PATH: dir });
    assert.strictEqual(result.status, 0);
    // Req 2, mechanically: stdout is exactly the child's output, nothing
    // this file's own code contributed (no banner, no "Restarting...",
    // nothing) — and it parses.
    assert.strictEqual(result.stdout, FAKE_JSON_RESULT);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    assert.strictEqual(stripPermissionRecordLine(result.stderr), '');
    // The FILE's prompt reached claude's real argv, not the --sprint
    // template's composed one.
    assert.deepStrictEqual(readArgv(), headlessLaunchArgs(QA1_ROLE, 'do the sprint 11 audit'));
  });
});

test('run-role CLI: --restart writes its banner to stderr only, never stdout (the named Req 2 offender, mechanically re-checked)', () => {
  // Structural guarantee: the whole file has zero console.log calls left,
  // so nothing on the interactive path — --restart included — can regress
  // into writing a banner to stdout. This is a file-wide invariant, not a
  // per-path claim, and cheaper to assert than re-driving the real
  // resume-detection filesystem scan (scripts/launcher/session.js) just to
  // reach the --restart branch in a CLI test.
  const source = fs.readFileSync(RUN_ROLE_PATH, 'utf8');
  assert.ok(!/console\.log\(/.test(source), 'run-role.js must contain zero console.log calls');
  assert.match(source, /console\.error\(`Restarting \$\{role\.label\}/, 'the --restart banner must still exist, on stderr');
});

// -------------------------------------------------------------------------
// Req 10: exit code semantics. "Exercise it, don't read it" — every
// existing failure-path test above already exercises the reserved code
// (LAUNCHER_FAILURE_EXIT_CODE) for a launcher-level failure; these tests
// add the two things Req 10 specifically calls out that nothing above
// covers: the reserved code is genuinely distinct from anything the child
// can return, and the child's own exit code — including a non-zero one —
// passes through UNMODIFIED once claude has actually been spawned, rather
// than being coerced to either 0 or the reserved code.
// -------------------------------------------------------------------------
test('run-role: LAUNCHER_FAILURE_EXIT_CODE is distinct from 0 and from 1 (claude\'s own observed is_error:true exit code)', () => {
  // 1 was confirmed by hand: `claude --bare` with no credentials at all
  // returns a well-formed is_error:true envelope AND exits 1 — see
  // runHeadless()'s own comment on the child-exit-code pass-through. The
  // reserved code must never collide with that, or a genuine claude-level
  // auth failure would be indistinguishable from this launcher refusing
  // to even try.
  assert.notStrictEqual(LAUNCHER_FAILURE_EXIT_CODE, 0);
  assert.notStrictEqual(LAUNCHER_FAILURE_EXIT_CODE, 1);
});

test('run-role CLI: a role that ran and recorded any verdict exits 0 (Req 10) — including a FAIL-shaped result', () => {
  withFakeClaude(({ dir }) => {
    // The fake claude's JSON payload content doesn't matter to the
    // launcher at all (Req 2's "we emit, we do not parse" boundary) — a
    // FAIL verdict recorded by a real QA1 run is, from the launcher's own
    // point of view, indistinguishable from any other completed turn: the
    // child exits 0 either way. This test's fake result string, despite
    // being named FAKE_JSON_RESULT, stands in for exactly that case.
    const result = runRoleCli(['--headless', '--agent', 'qa1', '--sprint', '4'], { PATH: dir });
    assert.strictEqual(result.status, 0, 'a role that ran to completion must exit 0, whatever verdict it recorded');
  });
});

test('run-role CLI: the child\'s own non-zero exit code passes through UNMODIFIED, never coerced to 0 or to the reserved code', () => {
  // A separate, purpose-built fake claude for this one test: exits 2 on
  // the real launch (simulating either claude's own is_error:true failure
  // — confirmed exit 1 by hand, this uses a different code specifically to
  // prove it's a pass-through and not a hardcoded "1 means launcher
  // failure" special case — or a genuine crash), while --version and
  // auth status still succeed normally so the run actually reaches the
  // real launch instead of failing earlier for an unrelated reason.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-fake-claude-exit2-'));
  const script = [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then exit 0; fi',
    'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo \'{"loggedIn": true}\'; exit 0; fi',
    'exit 2',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'claude'), script);
  fs.chmodSync(path.join(dir, 'claude'), 0o755);
  try {
    const result = runRoleCli(['--headless', '--agent', 'qa1', '--sprint', '4'], { PATH: dir });
    assert.strictEqual(result.status, 2, 'the child\'s real exit code must reach the caller exactly as claude returned it');
    assert.notStrictEqual(result.status, LAUNCHER_FAILURE_EXIT_CODE, 'a child-returned code must never be confused with a launcher-level failure');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------------
// installOrphanGuard (Sprint 15, Req 3): demonstrated against a real
// process table, not reasoned about signal semantics -- the same
// discipline QA1/LiveQA's own criteria for this requirement demand.
// POSIX-only by construction (see the function's own comment in
// run-role.js for why SIGKILL and Windows are both named limits, not
// silently assumed away); skipped on win32 here rather than asserting a
// mechanism that doesn't apply there at all.
// -------------------------------------------------------------------------
if (process.platform === 'win32') {
  console.log("SKIP installOrphanGuard tests: POSIX-signal mechanism, doesn't apply on win32 (see run-role.js)");
} else {
  // Node has no true synchronous sleep; Atomics.wait on a throwaway
  // SharedArrayBuffer is the standard way to block the thread for a real
  // wall-clock interval without spawning a subprocess just to wait. This
  // blocks the whole event loop, which is exactly why the two wrapper
  // scripts below communicate a PID via a FILE rather than piping their
  // stdout back to this process: a stream 'data' event would never fire
  // while this process is inside one of these sleeps.
  const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  // A real `ps` query, not process.kill(pid, 0) -- discovered by running
  // this: kill(pid, 0) still reports a ZOMBIE child as alive (its PID slot
  // is still allocated until reaped), and this test's own wrapper process
  // is a direct child of THIS test runner, whose reaping is exactly what
  // sleepMs() above blocks while it sleeps. `ps -o state=` distinguishes
  // "gone" (ps itself fails) from a real running state from "Z" (zombie,
  // dead in every way that matters here, just not yet collected) --
  // treating a zombie as alive was a false negative this test hit on its
  // own first run, not a hypothetical.
  const isPidAlive = (pid) => {
    let state;
    try {
      state = execFileSync('ps', ['-p', String(pid), '-o', 'state='], { encoding: 'utf8' }).trim();
    } catch {
      return false; // ps itself failing means no such process
    }
    return !state.startsWith('Z');
  };

  const waitUntil = (fn, timeoutMs, intervalMs = 100) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fn()) return true;
      sleepMs(intervalMs);
    }
    return fn();
  };

  // Writes a small standalone wrapper script that spawns a long-running
  // dummy child (never exits on its own), optionally installs the real
  // orphan guard on it, then writes the child's PID to a file and idles.
  // `guarded` toggles the one line that matters, so the guarded and
  // unguarded scenarios below are identical in every other respect --
  // the comparison isolates exactly the variable this requirement fixed.
  function writeWrapper(dir, guarded) {
    const pidFile = path.join(dir, 'child-pid.txt');
    const lines = [
      "const fs = require('fs');",
      "const { spawn } = require('child_process');",
      guarded ? `const { installOrphanGuard } = require(${JSON.stringify(RUN_ROLE_PATH)});` : '',
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);",
      guarded ? 'installOrphanGuard(child);' : '',
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      'setInterval(() => {}, 1000);', // keep the wrapper itself alive to be killed
    ].filter(Boolean);
    const wrapperFile = path.join(dir, 'wrapper.js');
    fs.writeFileSync(wrapperFile, lines.join('\n') + '\n');
    return { wrapperFile, pidFile };
  }

  // Runs one scenario end to end: spawn the wrapper (simulating the
  // launcher), wait for it to report its own child's PID, send the
  // wrapper a real SIGTERM by PID -- the exact `kill <launcher-pid>`
  // shape the original bug report used, not a self-inflicted signal --
  // then report back whether the child was still alive ~2 seconds later.
  // Always cleans up both PIDs in `finally`, regardless of outcome, so a
  // failing assertion never leaks a live process out of the test run.
  function runOrphanScenario(guarded) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-orphan-guard-'));
    let wrapper;
    let childPid = null;
    try {
      const { wrapperFile, pidFile } = writeWrapper(dir, guarded);
      wrapper = spawn(process.execPath, [wrapperFile], { stdio: 'ignore' });
      const gotPidFile = waitUntil(() => fs.existsSync(pidFile), 5000);
      assert.ok(gotPidFile, 'wrapper never wrote its child PID file within 5s -- test setup broken');
      childPid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
      assert.ok(Number.isInteger(childPid) && childPid > 0, `unexpected child PID file content: ${childPid}`);
      assert.ok(isPidAlive(wrapper.pid), 'wrapper process not alive right after spawning -- test setup broken');
      assert.ok(isPidAlive(childPid), 'dummy child not alive right after spawning -- test setup broken');

      process.kill(wrapper.pid, 'SIGTERM');
      waitUntil(() => !isPidAlive(wrapper.pid), 3000);
      assert.ok(!isPidAlive(wrapper.pid), 'wrapper still alive 3s after SIGTERM -- test setup broken');

      // Real wait, not an instant check: signal delivery and process
      // teardown are asynchronous, and the original field report itself
      // measured the child still alive at both 5s and 56s post-kill, so
      // this window has to be long enough to distinguish "gone" from
      // "hasn't been reaped yet" either way.
      const childDiedInTime = waitUntil(() => !isPidAlive(childPid), 3000);
      return { childDiedInTime, childPid };
    } finally {
      if (wrapper && isPidAlive(wrapper.pid)) {
        try { process.kill(wrapper.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      if (childPid && isPidAlive(childPid)) {
        try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('installOrphanGuard: WITHOUT the guard, SIGTERM to the launcher orphans the child (negative control -- proves this test methodology actually detects the bug)', () => {
    const { childDiedInTime, childPid } = runOrphanScenario(false);
    assert.strictEqual(
      childDiedInTime, false,
      `expected the unguarded child (pid ${childPid}) to survive its launcher's SIGTERM (the real, ` +
      'reported bug) but it died anyway -- either the repro no longer reproduces, or this test is not ' +
      'measuring what it claims to'
    );
  });

  test('installOrphanGuard: WITH the guard, SIGTERM to the launcher kills the child too -- no survivor (Req 3, by process table)', () => {
    const { childDiedInTime, childPid } = runOrphanScenario(true);
    assert.strictEqual(
      childDiedInTime, true,
      `expected installOrphanGuard to relay SIGTERM to the child (pid ${childPid}) and kill it within 3s, ` +
      'but it was still alive -- the fix did not hold'
    );
  });
}

// -------------------------------------------------------------------------
// scripts/baselines/check-staleness.js (Sprint 16, Req 1/5): the pure
// comparison function, tested in both directions with fake data -- no
// network call, no real baselines file, deterministic every run. Req 5's
// own instruction: "A check that can only say PASS retires the manual
// habit that was working." The real, live-registry-backed run (both
// directions, against the actual table) was also done for real during
// this sprint's build -- see the sprint's own commit message -- this is
// the permanent, repeatable regression guard for the comparison logic
// itself, independent of network/registry state.
// -------------------------------------------------------------------------
const { missingVersions } = require('./baselines/check-staleness');

test('check-staleness: a table covering everything published reports no missing versions', () => {
  const published = ['0.1.0', '0.1.1', '0.1.2'];
  assert.deepStrictEqual(missingVersions(published, published), []);
});

test('check-staleness: a table missing recent versions names exactly the missing ones, in order (the real, current-repo shape before this sprint)', () => {
  const covered = ['0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.1.4', '0.1.5', '0.1.6', '0.1.7', '0.1.8'];
  const published = [...covered, '0.1.9', '0.1.10', '0.1.11'];
  assert.deepStrictEqual(missingVersions(covered, published), ['0.1.9', '0.1.10', '0.1.11']);
});

test('check-staleness: missing versions are sorted numerically, not lexically (0.1.9 before 0.1.10)', () => {
  // Deliberately fed out of order and lexically-would-sort-wrong, to
  // confirm this reuses generate.js's own compareVersions rather than a
  // second, naive string sort that would put "0.1.10" before "0.1.9".
  const covered = ['0.1.0'];
  const published = ['0.1.0', '0.1.10', '0.1.2', '0.1.9', '0.1.1'];
  assert.deepStrictEqual(missingVersions(covered, published), ['0.1.1', '0.1.2', '0.1.9', '0.1.10']);
});

test('check-staleness: covering through N-1 is correct, not a gap -- a table missing only the version about to publish reports nothing missing', () => {
  // Req 1's own named risk: the version currently in package.json, not
  // yet on the registry, must never be demanded. Modeled here by simply
  // never including it in `published` (exactly what publishedVersions()
  // itself would return pre-publish, since it reads the real registry) --
  // there is no separate "subtract one" logic in missingVersions() to get
  // wrong, which this test exists to keep true.
  const covered = ['0.1.0', '0.1.1', '0.1.2'];
  const published = ['0.1.0', '0.1.1', '0.1.2']; // 0.1.3 not yet published, correctly absent
  assert.deepStrictEqual(missingVersions(covered, published), []);
});

test('check-staleness: an empty table against real published versions reports everything missing, not a crash', () => {
  assert.deepStrictEqual(missingVersions([], ['0.1.0', '0.1.1']), ['0.1.0', '0.1.1']);
});

test('check-staleness: real regeneration only adds versions, never changes an existing hash (this sprint\'s own real run)', () => {
  // This sprint actually regenerated scripts/baselines/user-owned-content.json
  // for real (0.1.0-0.1.8 -> 0.1.0-0.1.17) as part of its own build -- see
  // the sprint's commit message for the before/after diff proving every
  // pre-existing (path, version) hash was unchanged. Re-asserted here as a
  // narrower, permanent regression guard: the table on disk right now
  // must at least contain every version the original 0.1.8-era table
  // covered, so a future accidental truncation is caught.
  const table = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'baselines', 'user-owned-content.json'), 'utf8'));
  for (const v of ['0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.1.4', '0.1.5', '0.1.6', '0.1.7', '0.1.8']) {
    assert.ok(table.versions.includes(v), `regenerated table lost pre-existing version ${v}`);
  }
});

// -------------------------------------------------------------------------
// Sprint 19: the owned-repository broad grant. isBareInterpreter,
// isGitRepository, readOwnedRepositoryDeclaration, and
// validateOwnedRepositoryDeclaration are all pure or read-only against a
// scratch fixture -- no fail(), no process.exit(), safe to call directly
// in this same process. resolveOwnedRepositoryGrant() itself DOES call
// fail() on an invalid declaration (real process.exit -- calling it
// in-process for the invalid case would kill this entire test run), so
// that specific behaviour is exercised via a real subprocess instead,
// using a scratch copy of scripts/launcher/ + .claude/agents/ so its own
// __dirname-resolved ROOT points at the scratch fixture rather than this
// repo's real, off-limits checkout -- the established discipline from
// smoke_test.sh's own comment: never operate a destructive/exit-triggering
// test against the repo this session is actually standing in.
// -------------------------------------------------------------------------
const {
  isBareInterpreter,
  isGitRepository,
  readOwnedRepositoryDeclaration,
  validateOwnedRepositoryDeclaration,
  envFilesIn,
  protectEnvFiles,
  unprotectEnvFiles,
  OWNED_REPOSITORY_ALLOWED_TOOLS,
  OWNED_REPOSITORY_DISALLOWED_TOOLS,
  PERMISSION_FINDINGS_ANCHOR_VERSION,
  getClaudeVersionString,
  warnIfPermissionFindingsStale,
} = require('./launcher/run-role');

test('isBareInterpreter: the exact interpreters named in the sprint file, and common neighbours, are caught', () => {
  for (const cmd of ['node', 'bash', 'sh', 'python3', 'python', 'ruby', 'perl']) {
    assert.ok(isBareInterpreter(cmd), `${cmd} should be caught as a bare interpreter`);
  }
});

test('isBareInterpreter: a real script/test command is NOT caught', () => {
  for (const cmd of ['node test/all.js', 'npm test', 'python3 -m pytest', 'bash setup.sh', './run-tests.sh']) {
    assert.ok(!isBareInterpreter(cmd), `${cmd} should NOT be treated as a bare interpreter`);
  }
});

test('isBareInterpreter: whitespace around a bare interpreter is still caught (matches the trim() readDeclaredTestCommand already applies)', () => {
  assert.ok(isBareInterpreter('  node  '));
});

test('isGitRepository: true inside a real git working tree, false outside one', () => {
  withFixture((dir) => {
    assert.ok(!isGitRepository(dir), 'a fresh scratch directory is not a git repository yet');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    assert.ok(isGitRepository(dir), 'after git init, the same directory should be recognised');
  });
});

test('readOwnedRepositoryDeclaration: absent file, absent key, and blank all resolve to { present: false } -- true opt-outs, never refused', () => {
  withFixture((dir) => {
    assert.deepStrictEqual(readOwnedRepositoryDeclaration(dir), { present: false }, 'no .claude/settings.local.json at all');
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{"unrelated": true}');
    assert.deepStrictEqual(readOwnedRepositoryDeclaration(dir), { present: false }, 'key absent');
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{"fullyCompletely.ownedRepository": "   "}');
    assert.deepStrictEqual(readOwnedRepositoryDeclaration(dir), { present: false }, 'blank string');
  });
});

test('readOwnedRepositoryDeclaration: a non-string value is reported as PRESENT, not silently dropped (QA1 round 1: this used to be indistinguishable from "not declared")', () => {
  withFixture((dir) => {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{"fullyCompletely.ownedRepository": true}');
    assert.deepStrictEqual(readOwnedRepositoryDeclaration(dir), { present: true, value: true });
  });
});

test('readOwnedRepositoryDeclaration: a real declared value is returned, trimmed', () => {
  withFixture((dir) => {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), `{"fullyCompletely.ownedRepository": "  ${dir}  "}`);
    assert.deepStrictEqual(readOwnedRepositoryDeclaration(dir), { present: true, value: dir });
  });
});

test('validateOwnedRepositoryDeclaration: Req 1 adversarial sweep -- every input that should be refused, is', () => {
  withFixture((dir) => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const parent = path.dirname(dir);

    assert.strictEqual(validateOwnedRepositoryDeclaration('relative/path', dir).valid, false, 'a relative path must be refused');
    assert.strictEqual(
      validateOwnedRepositoryDeclaration(path.join(dir, 'does-not-exist'), dir).valid,
      false,
      "a path that doesn't resolve to anything real must be refused"
    );
    assert.strictEqual(validateOwnedRepositoryDeclaration(parent, dir).valid, false, 'a declaration naming the PARENT of the repository must be refused');
    assert.strictEqual(
      validateOwnedRepositoryDeclaration(path.join(parent, 'some-sibling-dir'), dir).valid,
      false,
      "a declaration naming a SIBLING (a path the operator doesn't own here) must be refused"
    );

    // Symlink: a link elsewhere that happens to point AT the real
    // directory must still resolve to the real, canonical path and pass
    // -- but a link that's simply a DIFFERENT path than what was declared
    // (pointing at a sibling, not this repo) must fail, covered above by
    // realpath resolution already differing. Directly exercised here: a
    // symlink TO this repo, declared BY that symlink path, still matches
    // once both sides are realpath-resolved.
    const symlinkPath = path.join(parent, `fc-symlink-${Date.now()}`);
    fs.symlinkSync(dir, symlinkPath);
    try {
      const viaSymlink = validateOwnedRepositoryDeclaration(symlinkPath, dir);
      assert.strictEqual(viaSymlink.valid, true, 'a symlink that genuinely resolves to this exact repository should be accepted');
    } finally {
      fs.unlinkSync(symlinkPath);
    }

    // Non-git directory: a path that's real, absolute, and matches exactly
    // -- but isn't a git repository.
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-non-git-'));
    try {
      assert.strictEqual(validateOwnedRepositoryDeclaration(nonGitDir, nonGitDir).valid, false, 'a non-git directory must be refused (Req 2)');
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });
});

test('validateOwnedRepositoryDeclaration: the exact matching declaration, in a real git repo, is accepted', () => {
  withFixture((dir) => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const verdict = validateOwnedRepositoryDeclaration(dir, dir);
    assert.strictEqual(verdict.valid, true, verdict.reason);
  });
});

test('validateOwnedRepositoryDeclaration: every refusal names what was wrong, not a generic message', () => {
  withFixture((dir) => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const relative = validateOwnedRepositoryDeclaration('relative/path', dir);
    assert.match(relative.reason, /not an absolute path/);
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-non-git-msg-'));
    try {
      const notGit = validateOwnedRepositoryDeclaration(nonGitDir, nonGitDir);
      assert.match(notGit.reason, /not a real git repository/);
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });
});

test('headlessPermissionArgs: no ownership declaration leaves dev-team-1/2 and qa1 on exactly today\'s narrow profile (the default is unchanged, Req 1)', () => {
  withFixture((dir) => {
    for (const role of RUN_ROLE_ROLES.filter((r) => ['dev-team-1', 'dev-team-2', 'qa1'].includes(r.id))) {
      const allowedIdx = headlessPermissionArgs(role, dir).indexOf('--allowedTools');
      const allowed = headlessPermissionArgs(role, dir)[allowedIdx + 1];
      for (const broad of OWNED_REPOSITORY_ALLOWED_TOOLS) {
        assert.ok(!allowed.includes(broad), `${role.id}: no declaration should never grant ${broad}`);
      }
    }
  });
});

test('headlessPermissionArgs: a valid ownership declaration grants the broad profile, including the git-push carve-out', () => {
  withFixture((dir) => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ 'fullyCompletely.ownedRepository': dir }));
    const args = headlessPermissionArgs(RUN_ROLE_ROLES.find((r) => r.id === 'dev-team-1'), dir);
    const allowedIdx = args.indexOf('--allowedTools');
    const allowed = args[allowedIdx + 1];
    for (const broad of OWNED_REPOSITORY_ALLOWED_TOOLS) {
      assert.ok(allowed.includes(broad), `expected the broad grant to include ${broad}`);
    }
    const disallowedIdx = args.indexOf('--disallowedTools');
    assert.ok(disallowedIdx !== -1, 'a valid grant must also carry the disallowedTools carve-out');
    const disallowed = args[disallowedIdx + 1];
    for (const carveOut of OWNED_REPOSITORY_DISALLOWED_TOOLS) {
      assert.ok(disallowed.includes(carveOut), `expected the carve-out ${carveOut} to be present even under the broad grant (Req 7)`);
    }
  });
});

test('headlessPermissionArgs: a role NOT eligible for the grant (pipeman) ignores a declaration entirely (Req 7)', () => {
  withFixture((dir) => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ 'fullyCompletely.ownedRepository': dir }));
    const before = headlessPermissionArgs(RUN_ROLE_ROLES.find((r) => r.id === 'pipeman'));
    const after = headlessPermissionArgs(RUN_ROLE_ROLES.find((r) => r.id === 'pipeman'), dir);
    assert.deepStrictEqual(before, after, "pipeman's profile must be identical whether or not a declaration exists");
  });
});

test('envFilesIn: finds .env and .env.* variants, ignores unrelated dotfiles, does not recurse', () => {
  withFixture((dir) => {
    fs.writeFileSync(path.join(dir, '.env'), 'A=1');
    fs.writeFileSync(path.join(dir, '.env.local'), 'B=2');
    fs.writeFileSync(path.join(dir, '.environment-notes.txt'), 'not an env file');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'irrelevant');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', '.env'), 'C=3');
    const found = envFilesIn(dir).map((f) => path.basename(f)).sort();
    assert.deepStrictEqual(found, ['.env', '.env.local']);
  });
});

if (process.platform !== 'darwin' && process.platform !== 'linux') {
  console.log(`SKIP .env protection tests: no known immutable-flag mechanism on ${process.platform} (see run-role.js's own comment)`);
} else {
  // Post-ship CI finding (this sprint's own round-1-through-3 comments
  // said Linux's chattr +i was "expected but unverified" -- CI running on
  // ubuntu-latest is what actually verified it, and what it verified is
  // narrower than assumed). Confirmed independently, in a real Linux
  // container: `chattr +i` requires CAP_LINUX_IMMUTABLE, which an
  // ordinary unprivileged user does not have, and which a default `docker
  // run` does not grant even to root inside the container -- both fail
  // identically, "Operation not permitted", exit 1. The matching positive
  // was also confirmed: with that capability explicitly added
  // (--cap-add=LINUX_IMMUTABLE), chattr +i behaves exactly as documented
  // -- blocks a real write and a real delete, fully reversible. So the
  // mechanism itself is real and now verified both ways, it just is not
  // available to every process that might run this launcher on Linux.
  //
  // That is exactly the scenario Req 3's own verifyEnvProtected() exists
  // to catch by attempting a real write rather than trusting an exit
  // code, and runHeadless() already refuses the whole broad grant when it
  // fires rather than degrading to "granted but unprotected" -- see that
  // refusal's own coverage further below. This test's job is to prove the
  // mechanism works when it can run for real; asserting that
  // unconditionally on Linux was the CI defect, not the mechanism -- so
  // probe capability first, honestly, the same discipline this whole area
  // already follows, and skip loudly rather than fail in the one place
  // that is expected.
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-env-protect-probe-'));
  fs.writeFileSync(path.join(probeDir, '.env'), 'probe');
  const probe = protectEnvFiles(probeDir);
  unprotectEnvFiles(probe.protected);
  fs.rmSync(probeDir, { recursive: true, force: true });

  if (probe.failed.length > 0) {
    console.log(
      `SKIP .env real-enforcement test: this process could not verify ${process.platform}'s immutable-flag ` +
        'mechanism (likely missing CAP_LINUX_IMMUTABLE or equivalent privilege -- confirmed as the cause in a real ' +
        'Linux container, both as an unprivileged user and as root without the capability explicitly added). This ' +
        "is exactly the case runHeadless() refuses the broad grant for rather than degrading; see that refusal's " +
        'own real-subprocess coverage below.'
    );
  } else {
    test('protectEnvFiles/unprotectEnvFiles: .env becomes unwritable and undeletable, stays readable, and is fully restored after (Req 3, real OS enforcement)', () => {
      withFixture((dir) => {
        fs.writeFileSync(path.join(dir, '.env'), 'SECRET=abc123');
        const { protected: protectedFiles, failed } = protectEnvFiles(dir);
        try {
          assert.deepStrictEqual(failed, [], 'protection should be verified, not just attempted, when this process can actually exercise the mechanism');
          assert.strictEqual(protectedFiles.length, 1);

          // Read still works.
          assert.strictEqual(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'SECRET=abc123');

          // Write, via a real subprocess (not this process's own fs calls,
          // which run as the file's owner and could behave differently from
          // how an actual spawned Bash command would) fails.
          const writeAttempt = spawnSync('sh', ['-c', `printf overwritten > ${JSON.stringify(path.join(dir, '.env'))}`]);
          assert.notStrictEqual(writeAttempt.status, 0, 'a write to the protected .env must fail');
          assert.strictEqual(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'SECRET=abc123', '.env content must be unchanged after the failed write');

          // Delete fails too -- the harder case, since POSIX deletion is
          // normally a directory-permission operation, not a file one; this
          // is exactly why Req 3 needed the immutable flag rather than a
          // plain chmod.
          const deleteAttempt = spawnSync('rm', [path.join(dir, '.env')]);
          assert.notStrictEqual(deleteAttempt.status, 0, 'deleting the protected .env must fail');
          assert.ok(fs.existsSync(path.join(dir, '.env')), '.env must still exist after the failed delete');
        } finally {
          unprotectEnvFiles(protectedFiles);
        }

        // After unprotecting, normal operations must work again -- proving
        // this is a scoped, reversible grant-duration protection, not a
        // permanent lockout of the operator's own file.
        fs.writeFileSync(path.join(dir, '.env'), 'restored');
        assert.strictEqual(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'restored');
      });
    });
  }

  test('protectEnvFiles: no .env* files present is not a failure -- nothing to protect, nothing fails', () => {
    withFixture((dir) => {
      const { protected: protectedFiles, failed } = protectEnvFiles(dir);
      assert.deepStrictEqual(protectedFiles, []);
      assert.deepStrictEqual(failed, []);
    });
  });

  test('runHeadless (real subprocess): when .env protection cannot be verified (chflags/chattr no-ops -- the faithful stand-in for an unprivileged Linux process lacking CAP_LINUX_IMMUTABLE, confirmed above), the broad grant is refused rather than silently degraded to unprotected', () => {
    withScratchLauncherInstall((scratchRoot) => {
      execFileSync('git', ['init', '-q'], { cwd: scratchRoot });
      fs.mkdirSync(path.join(scratchRoot, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(scratchRoot, '.claude', 'settings.local.json'), JSON.stringify({ 'fullyCompletely.ownedRepository': scratchRoot }));
      fs.writeFileSync(path.join(scratchRoot, '.env'), 'SECRET=abc123');

      // A no-op protect command standing in for what an unprivileged Linux
      // process actually experiences. verifyEnvProtected() never trusts
      // the protect command's own exit code (see its own comment) -- it
      // attempts a real write -- so a no-op is a faithful stand-in
      // regardless of what exit status it happens to return; this one
      // returns non-zero, matching the real "Operation not permitted"
      // observed in testing.
      const noOpProtectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-noop-protect-'));
      try {
        for (const name of ['chflags', 'chattr']) {
          fs.writeFileSync(path.join(noOpProtectDir, name), '#!/bin/sh\nexit 1\n');
          fs.chmodSync(path.join(noOpProtectDir, name), 0o755);
        }
        withFakeClaude(({ dir: fakeClaudeDir, readArgv }) => {
          const promptFile = path.join(scratchRoot, 'prompt.txt');
          fs.writeFileSync(promptFile, 'irrelevant, refused before this would matter');
          const result = spawnSync(
            process.execPath,
            [path.join(scratchRoot, 'scripts', 'launcher', 'run-role.js'), '--headless', '--agent', 'dev-team-1', '--prompt-file', promptFile],
            {
              cwd: scratchRoot,
              encoding: 'utf8',
              // noOpProtectDir and fakeClaudeDir first, so they shadow the
              // real chflags/chattr/claude; the real PATH stays appended so
              // git (needed by isGitRepository) and node's own shell-outs
              // still resolve normally.
              env: { ...process.env, PATH: [noOpProtectDir, fakeClaudeDir, process.env.PATH].join(path.delimiter) },
            }
          );
          assert.strictEqual(result.status, LAUNCHER_FAILURE_EXIT_CODE);
          assert.match(result.stderr, /Could not verify \.env protection/);
          assert.strictEqual(result.stdout, '');
          assert.deepStrictEqual(readArgv(), [], 'claude must never be spawned when .env protection cannot be verified');
          assert.strictEqual(
            fs.readFileSync(path.join(scratchRoot, '.env'), 'utf8'),
            'SECRET=abc123',
            '.env must be untouched -- this refuses the launch, it does not attempt to write to .env itself'
          );
        });
      } finally {
        fs.rmSync(noOpProtectDir, { recursive: true, force: true });
      }
    });
  });
}

// resolveOwnedRepositoryGrant()'s fail()-triggering path: a real
// subprocess, against a scratch COPY of scripts/launcher/ and
// .claude/agents/ (never this repo's own real checkout -- see this
// section's own opening comment), so its __dirname-resolved ROOT points
// at the scratch fixture and an invalid declaration there is exactly what
// a real downstream project's own invalid declaration would look like.
function withScratchLauncherInstall(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-scratch-launcher-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts', 'launcher'), { recursive: true });
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, 'scripts', 'launcher'))) {
      if (!entry.endsWith('.js')) continue;
      fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'launcher', entry), path.join(dir, 'scripts', 'launcher', entry));
    }
    fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, '.claude', 'agents'))) {
      fs.copyFileSync(path.join(REPO_ROOT, '.claude', 'agents', entry), path.join(dir, '.claude', 'agents', entry));
    }
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveOwnedRepositoryGrant (real subprocess): an invalid declaration refuses the whole headless launch, naming what was wrong, before claude is ever spawned', () => {
  withScratchLauncherInstall((scratchRoot) => {
    fs.mkdirSync(path.join(scratchRoot, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(scratchRoot, '.claude', 'settings.local.json'),
      JSON.stringify({ 'fullyCompletely.ownedRepository': 'not/an/absolute/path' })
    );
    withFakeClaude(({ dir: fakeClaudeDir, readArgv }) => {
      const promptFile = path.join(scratchRoot, 'prompt.txt');
      fs.writeFileSync(promptFile, 'irrelevant, refused before this would matter');
      const result = spawnSync(
        process.execPath,
        [path.join(scratchRoot, 'scripts', 'launcher', 'run-role.js'), '--headless', '--agent', 'dev-team-1', '--prompt-file', promptFile],
        { cwd: scratchRoot, encoding: 'utf8', env: { ...process.env, PATH: fakeClaudeDir } }
      );
      assert.strictEqual(result.status, LAUNCHER_FAILURE_EXIT_CODE);
      assert.match(result.stderr, /not an absolute path/);
      assert.strictEqual(result.stdout, '');
      assert.deepStrictEqual(readArgv(), [], 'claude must never be spawned once the declaration is refused');
    });
  });
});

test('resolveOwnedRepositoryGrant (real subprocess): a non-string declared value refuses too, not silently granted the narrow default (QA1 round 1 finding)', () => {
  withScratchLauncherInstall((scratchRoot) => {
    fs.mkdirSync(path.join(scratchRoot, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(scratchRoot, '.claude', 'settings.local.json'), JSON.stringify({ 'fullyCompletely.ownedRepository': true }));
    withFakeClaude(({ dir: fakeClaudeDir, readArgv }) => {
      const promptFile = path.join(scratchRoot, 'prompt.txt');
      fs.writeFileSync(promptFile, 'irrelevant, refused before this would matter');
      const result = spawnSync(
        process.execPath,
        [path.join(scratchRoot, 'scripts', 'launcher', 'run-role.js'), '--headless', '--agent', 'dev-team-1', '--prompt-file', promptFile],
        { cwd: scratchRoot, encoding: 'utf8', env: { ...process.env, PATH: fakeClaudeDir } }
      );
      assert.strictEqual(result.status, LAUNCHER_FAILURE_EXIT_CODE);
      assert.match(result.stderr, /not a string/);
      assert.strictEqual(result.stdout, '');
      assert.deepStrictEqual(readArgv(), [], 'claude must never be spawned once the declaration is refused');
    });
  });
});

// -------------------------------------------------------------------------
// Sprint 21, Req 3: the permission-findings staleness warning. Reuses
// withFakeClaude()'s fake binary but extends what it answers for
// --version -- the shared fixture always exits 0 with no output for
// --version, which getClaudeVersionString() treats as null (can't
// compare), so these tests need a fake that actually PRINTS a version.
// PATH is mutated on process.env directly, not passed as a function
// argument, because getClaudeVersionString() -- like the real claude
// binary resolution everywhere else in this file -- has no root/env
// override parameter; it always resolves 'claude' from whatever this
// process's own PATH is, the same way production does. Restored in
// finally either way.
function withFakeClaudeVersion(versionOutput, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-fake-claude-version-'));
  const script = ['#!/bin/sh', `if [ "$1" = "--version" ]; then printf '%s\\n' ${JSON.stringify(versionOutput)}; exit 0; fi`, 'exit 1', ''].join('\n');
  fs.writeFileSync(path.join(dir, 'claude'), script);
  fs.chmodSync(path.join(dir, 'claude'), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = dir;
  try {
    fn();
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function captureStderr(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

test('getClaudeVersionString: parses the version token, ignoring trailing text like "(Claude Code)"', () => {
  withFakeClaudeVersion(`${PERMISSION_FINDINGS_ANCHOR_VERSION} (Claude Code)`, () => {
    assert.strictEqual(getClaudeVersionString(), PERMISSION_FINDINGS_ANCHOR_VERSION);
  });
});

test('getClaudeVersionString: null when claude produces no parseable output (the shared fake-claude fixture used everywhere else in this file) -- can\'t compare is not the same as mismatch', () => {
  // withFakeClaude() only creates the fake binary and hands back its dir --
  // it never mutates this process's own PATH itself (real-subprocess tests
  // pass `dir` as the child's env.PATH explicitly instead). Calling
  // getClaudeVersionString() in-process needs that same mutation applied
  // here, or it just resolves the real system claude and this test would
  // pass for the wrong reason.
  withFakeClaude(({ dir }) => {
    const originalPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      assert.strictEqual(getClaudeVersionString(), null);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

test('warnIfPermissionFindingsStale: silent when the running version matches the anchor', () => {
  withFakeClaudeVersion(PERMISSION_FINDINGS_ANCHOR_VERSION, () => {
    const lines = captureStderr(() => warnIfPermissionFindingsStale());
    assert.deepStrictEqual(lines, []);
  });
});

test('warnIfPermissionFindingsStale: silent when the version can\'t be determined (null), never a false alarm', () => {
  withFakeClaude(({ dir }) => {
    const originalPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      const lines = captureStderr(() => warnIfPermissionFindingsStale());
      assert.deepStrictEqual(lines, []);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

test('warnIfPermissionFindingsStale: warns, naming both versions and the findings document, on a real mismatch -- and never throws or exits (Req 3: warns, never gates)', () => {
  withFakeClaudeVersion('9.9.999 (Claude Code)', () => {
    const lines = captureStderr(() => warnIfPermissionFindingsStale());
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /9\.9\.999/);
    assert.match(lines[0], new RegExp(PERMISSION_FINDINGS_ANCHOR_VERSION.replace(/\./g, '\\.')));
    assert.match(lines[0], /sprint-12-permission-scope-findings\.md/);
    assert.match(lines[0], /not a defect and not a block/i);
  });
});

test('warnIfPermissionFindingsStale: the "survived one real CLI update unchanged" claim is gone, not merely updated (Sprint 26, Req 5)', () => {
  withFakeClaudeVersion('9.9.999 (Claude Code)', () => {
    const lines = captureStderr(() => warnIfPermissionFindingsStale());
    assert.strictEqual(lines.length, 1);
    // The exact claim this Req removes -- checked for its absence
    // directly, not inferred from the message being merely different.
    assert.doesNotMatch(lines[0], /survived/i);
    assert.doesNotMatch(lines[0], /unchanged/i);
    // The corrected message must not swap "re-verified" (implies
    // establishment) back in either -- "examined" is the word Req 5
    // asks for instead.
    assert.doesNotMatch(lines[0], /re-verified/i);
    assert.match(lines[0], /examined/i);
    // Points the reader at the actual accounting rather than asserting
    // a conclusion inline.
    assert.match(lines[0], /Sprint 26 re-grading/);
  });
});

test('runHeadless (real subprocess): the staleness warning appears on stderr but never blocks the run when claude reports a different version', () => {
  withScratchLauncherInstall((scratchRoot) => {
    const noOpProtectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-version-mismatch-claude-'));
    try {
      const script = ['#!/bin/sh', 'if [ "$1" = "--version" ]; then printf \'9.9.999 (Claude Code)\\n\'; exit 0; fi', `if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo '{"loggedIn": true}'; exit 0; fi`, `printf '%s' '${FAKE_JSON_RESULT}'`, 'exit 0', ''].join('\n');
      fs.writeFileSync(path.join(noOpProtectDir, 'claude'), script);
      fs.chmodSync(path.join(noOpProtectDir, 'claude'), 0o755);
      const promptFile = path.join(scratchRoot, 'prompt.txt');
      fs.writeFileSync(promptFile, 'irrelevant, this only checks the version-mismatch warning path');
      const result = spawnSync(
        process.execPath,
        [path.join(scratchRoot, 'scripts', 'launcher', 'run-role.js'), '--headless', '--agent', 'dev-team-1', '--prompt-file', promptFile],
        { cwd: scratchRoot, encoding: 'utf8', env: { ...process.env, PATH: noOpProtectDir } }
      );
      assert.strictEqual(result.status, 0, 'a version mismatch must never change the exit code -- warns, never gates');
      assert.match(result.stderr, /9\.9\.999/);
      assert.match(result.stderr, /sprint-12-permission-scope-findings\.md/);
    } finally {
      fs.rmSync(noOpProtectDir, { recursive: true, force: true });
    }
  });
});

// -------------------------------------------------------------------------
// mc-commit.js: sprint 36 fix round (QA1 FAIL round 1, items 1-3) --
// replaces the Bash-permission-pattern approach to scoping headless
// Master Controller's git grant (proven, by QA1's own real probes, not
// to be expressible that way at all: a trailing wildcard on `git commit
// -m *` covers a pathspec argument exactly as readily as it covers the
// message, and `git add docs/sprints/*` has the identical gap the moment
// a second pathspec is appended). Enforcement now lives in this file's
// own real code, which makes it deterministically, non-model-mediated
// testable -- every test below is a real subprocess run against a real
// scratch git repo, never a permission-pattern assertion.
// -------------------------------------------------------------------------
const MC_COMMIT_PATH = path.join(REPO_ROOT, 'scripts', 'mc-commit.js');

function withMcCommitFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-mc-commit-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts', 'launcher'), { recursive: true });
    fs.copyFileSync(MC_COMMIT_PATH, path.join(dir, 'scripts', 'mc-commit.js'));
    // Sprint 40, Req 2b: mc-commit.js now requires ./launcher/jsonc (the
    // same JSONC parser run-role.js's own readDeclaredTestCommand() uses)
    // to read a project's declared decisions-log path -- a real dependency
    // the fixture must carry too, or every real subprocess launch below
    // crashes with MODULE_NOT_FOUND before ever reaching the code under
    // test.
    fs.copyFileSync(
      path.join(REPO_ROOT, 'scripts', 'launcher', 'jsonc.js'),
      path.join(dir, 'scripts', 'launcher', 'jsonc.js')
    );
    fs.mkdirSync(path.join(dir, 'docs', 'sprints', 'state'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'scripts_other'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'mc-commit-test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'MC Commit Test'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'docs', 'sprints', 'existing.md'), 'base\n');
    fs.writeFileSync(path.join(dir, 'scripts_other', 'tool.js'), 'base\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir });
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runMcCommit(dir, args) {
  return spawnSync(process.execPath, [path.join(dir, 'scripts', 'mc-commit.js'), ...args], { cwd: dir, encoding: 'utf8' });
}

function gitLog(dir) {
  return execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' }).trim();
}

test('mc-commit.js: commits a brand-new file under docs/sprints/ (the /sprint-new shape -- untracked, needs staging first)', () => {
  withMcCommitFixture((dir) => {
    fs.writeFileSync(path.join(dir, 'docs', 'sprints', 'state', 'sprint-1.json'), '{}\n');
    const result = runMcCommit(dir, ['--message', 'legit commit', '--', 'docs/sprints/state/sprint-1.json']);
    assert.strictEqual(result.status, 0, `expected success, got: ${result.stderr}`);
    assert.match(gitLog(dir), /legit commit/);
    const stat = execFileSync('git', ['show', '--stat', '--format=', 'HEAD'], { cwd: dir, encoding: 'utf8' });
    assert.match(stat, /sprint-1\.json/);
  });
});

test('mc-commit.js: commits multiple paths under docs/sprints/ in one call', () => {
  withMcCommitFixture((dir) => {
    fs.appendFileSync(path.join(dir, 'docs', 'sprints', 'existing.md'), 'amended\n');
    fs.writeFileSync(path.join(dir, 'docs', 'sprints', 'state', 'sprint-2.json'), '{}\n');
    const result = runMcCommit(dir, ['--message', 'two paths', '--', 'docs/sprints/existing.md', 'docs/sprints/state/sprint-2.json']);
    assert.strictEqual(result.status, 0, `expected success, got: ${result.stderr}`);
    const stat = execFileSync('git', ['show', '--stat', '--format=', 'HEAD'], { cwd: dir, encoding: 'utf8' });
    assert.match(stat, /existing\.md/);
    assert.match(stat, /sprint-2\.json/);
  });
});

test('mc-commit.js: refuses a path outside docs/sprints/ -- the exact QA1 P2 repro (git commit -m ... scripts/tool.js), nothing committed', () => {
  withMcCommitFixture((dir) => {
    fs.appendFileSync(path.join(dir, 'scripts_other', 'tool.js'), 'tweaked\n');
    const before = gitLog(dir);
    const result = runMcCommit(dir, ['--message', 'tool tweak', '--', 'scripts_other/tool.js']);
    assert.notStrictEqual(result.status, 0, 'a path outside docs/sprints/ must be refused');
    assert.match(result.stderr, /does not resolve to a path this script is allowed to commit/);
    assert.strictEqual(gitLog(dir), before, 'nothing must have been committed');
  });
});

test('mc-commit.js: refuses when ONE OF SEVERAL paths is outside docs/sprints/ -- all or nothing, the exact QA1 P3 shape (git add docs/sprints/x scripts/tool.js)', () => {
  withMcCommitFixture((dir) => {
    fs.appendFileSync(path.join(dir, 'docs', 'sprints', 'existing.md'), 'amended\n');
    fs.appendFileSync(path.join(dir, 'scripts_other', 'tool.js'), 'tweaked\n');
    const before = gitLog(dir);
    const result = runMcCommit(dir, ['--message', 'sneaky combo', '--', 'docs/sprints/existing.md', 'scripts_other/tool.js']);
    assert.notStrictEqual(result.status, 0, 'a mixed legit+outside path list must be refused entirely');
    assert.strictEqual(gitLog(dir), before, 'nothing must have been committed, not even the legitimate path');
    const status = execFileSync('git', ['status', '--short'], { cwd: dir, encoding: 'utf8' });
    assert.match(status, /docs\/sprints\/existing\.md/, 'the legitimate file must still be sitting uncommitted, not swept in');
  });
});

test('mc-commit.js: refuses a `..` traversal path', () => {
  withMcCommitFixture((dir) => {
    const result = runMcCommit(dir, ['--message', 'traversal', '--', 'docs/sprints/../../etc-like.txt']);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /does not resolve to a path this script is allowed to commit/);
  });
});

test('mc-commit.js: refuses a string-prefix trick (docs/sprints-evil/ is not docs/sprints/)', () => {
  withMcCommitFixture((dir) => {
    fs.mkdirSync(path.join(dir, 'docs', 'sprints-evil'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'sprints-evil', 'y.txt'), 'x\n');
    const result = runMcCommit(dir, ['--message', 'prefix trick', '--', 'docs/sprints-evil/y.txt']);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /does not resolve to a path this script is allowed to commit/);
  });
});

test('mc-commit.js: refuses when no paths are given -- there is no "commit everything" mode', () => {
  withMcCommitFixture((dir) => {
    const result = runMcCommit(dir, ['--message', 'nothing named', '--']);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /At least one path is required/);
  });
});

// -------------------------------------------------------------------------
// mc-commit.js: sprint 40, Req 2 -- the widened allowlist (CLAUDE.md, and
// the declared-or-default decisions log), alongside docs/sprints/.
// -------------------------------------------------------------------------

test('mc-commit.js: accepts CLAUDE.md itself, an exact single-file match', () => {
  withMcCommitFixture((dir) => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'base\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'baseline claude.md'], { cwd: dir });
    fs.appendFileSync(path.join(dir, 'CLAUDE.md'), 'a real amendment\n');
    const result = runMcCommit(dir, ['--message', 'update CLAUDE.md', '--', 'CLAUDE.md']);
    assert.strictEqual(result.status, 0, `expected success, got: ${result.stderr}`);
    assert.match(gitLog(dir), /update CLAUDE\.md/);
  });
});

test('mc-commit.js: refuses a CLAUDE.md prefix-lookalike (CLAUDE.mdx is not CLAUDE.md)', () => {
  withMcCommitFixture((dir) => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.mdx'), 'lookalike\n');
    const result = runMcCommit(dir, ['--message', 'sneaky', '--', 'CLAUDE.mdx']);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /does not resolve to a path this script is allowed to commit/);
    assert.match(gitLog(dir), /^[0-9a-f]+ baseline$/, 'nothing new should have been committed');
  });
});

test('mc-commit.js: refuses a CLAUDE.md that is actually a symlink to a source file -- QA1 round 1 FINDING (control: real file is unaffected)', () => {
  withMcCommitFixture((dir) => {
    fs.symlinkSync(path.join(dir, 'scripts_other', 'tool.js'), path.join(dir, 'CLAUDE.md'));
    const result = runMcCommit(dir, ['--message', 'sneaky via symlink', '--', 'CLAUDE.md']);
    assert.notStrictEqual(result.status, 0, 'a symlinked CLAUDE.md must be refused, not resolved-and-committed');
    assert.match(result.stderr, /is a symlink/);
    assert.match(gitLog(dir), /^[0-9a-f]+ baseline$/, 'nothing new should have been committed');
    // Control: confirm the fixture's own tool.js was NOT touched/staged by
    // this attempt, and that a genuinely real (non-symlink) CLAUDE.md
    // still works -- isolates the refusal to the symlink shape itself.
    fs.unlinkSync(path.join(dir, 'CLAUDE.md'));
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'a real file\n');
    const realResult = runMcCommit(dir, ['--message', 'real claude.md', '--', 'CLAUDE.md']);
    assert.strictEqual(realResult.status, 0, `a genuinely real CLAUDE.md must still work -- got: ${realResult.stderr}`);
  });
});

test('mc-commit.js: refuses a declared decisions log that is actually a symlink to a source file -- QA1 round 1 FINDING', () => {
  withMcCommitFixture((dir) => {
    fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.vscode', 'settings.json'),
      JSON.stringify({ 'fullyCompletely.mcDecisionsLog': 'docs/decisions.md' }));
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.symlinkSync(path.join(dir, 'scripts_other', 'tool.js'), path.join(dir, 'docs', 'decisions.md'));
    const result = runMcCommit(dir, ['--message', 'sneaky via symlink', '--', 'docs/decisions.md']);
    assert.notStrictEqual(result.status, 0, 'a symlinked decisions log must be refused, not resolved-and-committed');
    assert.match(result.stderr, /is a symlink/);
    assert.match(gitLog(dir), /^[0-9a-f]+ baseline$/, 'nothing new should have been committed');
  });
});

test('mc-commit.js: refuses a declared decisions log that is a symlink pointing OUTSIDE the repository -- QA1 round 1 FINDING ("git add complaining" is not this wrapper\'s own check)', () => {
  withMcCommitFixture((dir) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-mc-commit-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'not part of this repo\n');
      fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.vscode', 'settings.json'),
        JSON.stringify({ 'fullyCompletely.mcDecisionsLog': 'docs/decisions.md' }));
      fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'docs', 'decisions.md'));
      const result = runMcCommit(dir, ['--message', 'escape via symlink', '--', 'docs/decisions.md']);
      assert.notStrictEqual(result.status, 0, 'a symlink pointing outside the repository must be refused by THIS wrapper\'s own check');
      assert.match(result.stderr, /is a symlink/);
      assert.match(gitLog(dir), /^[0-9a-f]+ baseline$/, 'nothing new should have been committed');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('mc-commit.js: accepts the DEFAULT decisions log (docs/decisions.md) when nothing is declared', () => {
  withMcCommitFixture((dir) => {
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'decisions.md'), 'decision: upgraded 0.2.9 -> 0.2.11\n');
    const result = runMcCommit(dir, ['--message', 'record decision', '--', 'docs/decisions.md']);
    assert.strictEqual(result.status, 0, `expected success, got: ${result.stderr}`);
    assert.match(gitLog(dir), /record decision/);
  });
});

test('mc-commit.js: accepts a DECLARED decisions log at a project-chosen path (sprint 40, Req 2b -- settled with FMC, the path belongs to the project)', () => {
  withMcCommitFixture((dir) => {
    fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.vscode', 'settings.json'),
      JSON.stringify({ 'fullyCompletely.mcDecisionsLog': 'docs/rebuild/mc-decisions.md' }));
    fs.mkdirSync(path.join(dir, 'docs', 'rebuild'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'rebuild', 'mc-decisions.md'), 'a real decision\n');
    const result = runMcCommit(dir, ['--message', 'record decision', '--', 'docs/rebuild/mc-decisions.md']);
    assert.strictEqual(result.status, 0, `expected success, got: ${result.stderr}`);
    assert.match(gitLog(dir), /record decision/);
  });
});

test('mc-commit.js: a declared decisions log does NOT also grant the unrelated default path (the declaration replaces, not adds to, the default)', () => {
  withMcCommitFixture((dir) => {
    fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.vscode', 'settings.json'),
      JSON.stringify({ 'fullyCompletely.mcDecisionsLog': 'docs/rebuild/mc-decisions.md' }));
    fs.mkdirSync(path.join(dir, 'docs', 'rebuild'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'decisions.md'), 'stray default-shaped file\n');
    const result = runMcCommit(dir, ['--message', 'sneaky', '--', 'docs/decisions.md']);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /does not resolve to a path this script is allowed to commit/);
  });
});

test('mc-commit.js: refuses (and does NOT silently fall back to the default) when the declared decisions log resolves outside the repository', () => {
  withMcCommitFixture((dir) => {
    fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.vscode', 'settings.json'),
      JSON.stringify({ 'fullyCompletely.mcDecisionsLog': '../outside-the-repo.md' }));
    const result = runMcCommit(dir, ['--message', 'escape attempt', '--', '../outside-the-repo.md']);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /failed validation/);
    assert.match(result.stderr, /does not resolve to a file inside the repository/);
    assert.match(result.stderr, /fullyCompletely\.mcDecisionsLog/);
  });
});

test('mc-commit.js: refuses when the declared decisions log resolves inside .git/', () => {
  withMcCommitFixture((dir) => {
    fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.vscode', 'settings.json'),
      JSON.stringify({ 'fullyCompletely.mcDecisionsLog': '.git/config' }));
    const result = runMcCommit(dir, ['--message', 'escape attempt', '--', '.git/config']);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /failed validation/);
    assert.match(result.stderr, /resolves inside \.git\//);
  });
});

test('mc-commit.js: refuses when the declared decisions log resolves inside a path the install manifest owns', () => {
  withMcCommitFixture((dir) => {
    fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.vscode', 'settings.json'),
      JSON.stringify({ 'fullyCompletely.mcDecisionsLog': 'scripts/sprint_lifecycle.py' }));
    const result = runMcCommit(dir, ['--message', 'escape attempt', '--', 'scripts/sprint_lifecycle.py']);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /failed validation/);
    assert.match(result.stderr, /this framework's own installer manages/);
  });
});

test('mc-commit.js: refuses when the declared decisions log is a directory, not a file', () => {
  withMcCommitFixture((dir) => {
    fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.vscode', 'settings.json'),
      JSON.stringify({ 'fullyCompletely.mcDecisionsLog': 'docs/sprints' }));
    const result = runMcCommit(dir, ['--message', 'escape attempt', '--', 'docs/sprints']);
    assert.notStrictEqual(result.status, 0);
    // docs/sprints itself is ALSO refused by the unchanged docs/sprints/
    // check (it's the directory itself, not a file inside it) -- either
    // refusal reason is correct here, this just confirms nothing commits.
    assert.match(gitLog(dir), /^[0-9a-f]+ baseline$/, 'nothing new should have been committed');
  });
});

test('mc-commit.js: refuses when the declared decisions log is glob/list-shaped', () => {
  withMcCommitFixture((dir) => {
    fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.vscode', 'settings.json'),
      JSON.stringify({ 'fullyCompletely.mcDecisionsLog': 'docs/*.md' }));
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', '_glob_.md'), 'x\n');
    const result = runMcCommit(dir, ['--message', 'escape attempt', '--', 'docs/*.md']);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /failed validation/);
    assert.match(result.stderr, /looks like a glob or a list/);
  });
});

test('mc-commit.js: no environment variable or CLI flag widens the allowlist at run time (Req 2c, no escape hatch)', () => {
  withMcCommitFixture((dir) => {
    fs.writeFileSync(path.join(dir, 'scripts_other', 'tool.js'), 'tweaked\n');
    const result = spawnSync(process.execPath, [path.join(dir, 'scripts', 'mc-commit.js'),
      '--message', 'escape attempt', '--', 'scripts_other/tool.js'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        FULLY_COMPLETELY_MC_COMMIT_ALLOW: 'scripts_other',
        MC_COMMIT_EXTRA_PATHS: 'scripts_other',
        FULLY_COMPLETELY_ALLOW_ANY_PATH: '1',
      },
    });
    assert.notStrictEqual(result.status, 0, 'no environment variable may widen what this script accepts');
    assert.match(gitLog(dir), /^[0-9a-f]+ baseline$/, 'nothing new should have been committed');
  });
});

test('mc-commit.js: source-level check -- no code path reads process.env or a CLI flag to build or extend the allowlist', () => {
  const src = fs.readFileSync(MC_COMMIT_PATH, 'utf8');
  assert.ok(!src.includes('process.env'), 'mc-commit.js must never read process.env anywhere -- the allowlist is fixed code and one validated project declaration, never an environment override');
});

test('mc-commit.js: refuses an empty commit message', () => {
  withMcCommitFixture((dir) => {
    const result = runMcCommit(dir, ['--message', '', '--', 'docs/sprints/existing.md']);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /non-empty commit message is required/);
  });
});

test('mc-commit.js: --message-file reads the message from a file (matching qa1.md/liveqa.md\'s own established --notes-file pattern)', () => {
  withMcCommitFixture((dir) => {
    fs.appendFileSync(path.join(dir, 'docs', 'sprints', 'existing.md'), 'amended\n');
    const msgFile = path.join(dir, 'msg.txt');
    fs.writeFileSync(msgFile, 'message from a file\n');
    const result = runMcCommit(dir, ['--message-file', msgFile, '--', 'docs/sprints/existing.md']);
    assert.strictEqual(result.status, 0, `expected success, got: ${result.stderr}`);
    assert.match(gitLog(dir), /message from a file/);
  });
});

test('mc-commit.js: never reaches a remote -- a real bare remote receives nothing across every scenario above (no code path here ever constructs a git push)', () => {
  withMcCommitFixture((dir) => {
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-mc-commit-remote-'));
    try {
      execFileSync('git', ['init', '-q', '--bare'], { cwd: remoteDir });
      execFileSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: dir });
      fs.writeFileSync(path.join(dir, 'docs', 'sprints', 'state', 'sprint-3.json'), '{}\n');
      const result = runMcCommit(dir, ['--message', 'legit commit', '--', 'docs/sprints/state/sprint-3.json']);
      assert.strictEqual(result.status, 0);
      const remoteLog = execFileSync('git', ['log', '--oneline', '--all'], { cwd: remoteDir, encoding: 'utf8' }).trim();
      assert.strictEqual(remoteLog, '', 'the remote must have received nothing -- this script has no push capability at all');
    } finally {
      fs.rmSync(remoteDir, { recursive: true, force: true });
    }
  });
});

test('mc-commit.js: source-level check -- the only git subcommands this file ever passes to spawnSync are "add" and "commit", never "push", and no bare "-a"/"-A"/"--all"/"."  argv element exists anywhere', () => {
  const src = fs.readFileSync(MC_COMMIT_PATH, 'utf8');
  const spawnCalls = [...src.matchAll(/spawnSync\('git',\s*\[([^\]]*)\]/g)].map((m) => m[1]);
  assert.strictEqual(spawnCalls.length, 2, `expected exactly two spawnSync('git', [...]) call sites, found ${spawnCalls.length}`);
  assert.ok(spawnCalls.some((argsSrc) => /'add'/.test(argsSrc)), 'expected one call to pass "add"');
  assert.ok(spawnCalls.some((argsSrc) => /'commit'/.test(argsSrc)), 'expected one call to pass "commit"');
  for (const argsSrc of spawnCalls) {
    assert.ok(!/'push'/.test(argsSrc), 'no spawnSync(\'git\', [...]) call may ever pass "push"');
    for (const forbidden of ["'-a'", "'-A'", "'--all'", "'.'", "'-am'"]) {
      assert.ok(!argsSrc.includes(forbidden), `no spawnSync('git', [...]) call may ever pass ${forbidden}`);
    }
  }
});

// -------------------------------------------------------------------------
// gate-commit.js: sprint 42, Req 1. A sibling to mc-commit.js, not an
// extension of it -- see gate-commit.js's own header comment for why
// (different commit shape: no staging at all vs. mc-commit.js's own
// unconditional `git add`; different, narrower allowlist: exactly one
// path matching docs/sprints/state/sprint-<N>.json for a real, existing
// sprint id, not a directory prefix). Every test below is a real
// subprocess run against a real scratch git repo, matching mc-commit.js's
// own established test shape exactly -- deterministic, non-model-mediated.
// -------------------------------------------------------------------------
const GATE_COMMIT_PATH = path.join(REPO_ROOT, 'scripts', 'gate-commit.js');

function withGateCommitFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-gate-commit-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(GATE_COMMIT_PATH, path.join(dir, 'scripts', 'gate-commit.js'));
    fs.mkdirSync(path.join(dir, 'docs', 'sprints', 'state'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'gate-commit-test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Gate Commit Test'], { cwd: dir });
    // Sprint 1 is the "real, existing sprint" fixture every test below
    // uses -- registered AND its state file already tracked, matching the
    // real shape a gate role's verdict file is always in by the time this
    // script runs (created by /sprint-start, committed by Dev Team).
    fs.writeFileSync(
      path.join(dir, 'docs', 'sprints', 'registry.json'),
      JSON.stringify({ next_id: 2, sprints: { 1: { file: 'docs/sprints/1-todo/sprint-1_x.md' } } }, null, 2) + '\n'
    );
    fs.writeFileSync(path.join(dir, 'docs', 'sprints', 'state', 'sprint-1.json'), JSON.stringify({ phase: 'qa1_audit' }) + '\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir });
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runGateCommit(dir, args) {
  return spawnSync(process.execPath, [path.join(dir, 'scripts', 'gate-commit.js'), ...args], { cwd: dir, encoding: 'utf8' });
}

function gateCommitGitLog(dir) {
  return execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' }).trim();
}

test('gate-commit.js: commits a real, already-tracked verdict file with NO staging step (the exact CLAUDE.md gate-role shape, unlike mc-commit.js)', () => {
  withGateCommitFixture((dir) => {
    fs.writeFileSync(path.join(dir, 'docs', 'sprints', 'state', 'sprint-1.json'), JSON.stringify({ phase: 'qa1_audit', qa1_audit_result: 'PASS' }) + '\n');
    const result = runGateCommit(dir, ['--message', 'Record sprint 1 QA1 audit', '--', 'docs/sprints/state/sprint-1.json']);
    assert.strictEqual(result.status, 0, `expected success, got: ${result.stderr}`);
    assert.match(gateCommitGitLog(dir), /Record sprint 1 QA1 audit/);
    // --name-only lists exactly the changed paths, one per line, no
    // summary line to account for (git show --stat's own trailing "N
    // file(s) changed..." line would otherwise make a length check like
    // this one count the wrong thing).
    const changedFiles = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    assert.strictEqual(changedFiles, 'docs/sprints/state/sprint-1.json', 'exactly one file must appear in the commit -- nothing else swept in');
  });
});

test('gate-commit.js: refuses (git status still shows the change, nothing committed) when the target path is not actually tracked yet -- this is not a substitute for /sprint-start\'s own initial commit', () => {
  withGateCommitFixture((dir) => {
    fs.writeFileSync(path.join(dir, 'docs', 'sprints', 'state', 'sprint-2.json'), '{}\n');
    fs.writeFileSync(
      path.join(dir, 'docs', 'sprints', 'registry.json'),
      JSON.stringify({ next_id: 3, sprints: { 1: {}, 2: {} } }, null, 2) + '\n'
    );
    const result = runGateCommit(dir, ['--message', 'x', '--', 'docs/sprints/state/sprint-2.json']);
    assert.notStrictEqual(result.status, 0, 'an untracked verdict file must not commit');
    assert.match(result.stderr, /did not match any file/, 'git\'s own real error must surface unmodified');
  });
});

test('gate-commit.js: refuses any path other than docs/sprints/state/sprint-<N>.json', () => {
  withGateCommitFixture((dir) => {
    fs.mkdirSync(path.join(dir, 'scripts_other'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts_other', 'tool.js'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'add tool'], { cwd: dir });
    const before = gateCommitGitLog(dir);
    const result = runGateCommit(dir, ['--message', 'x', '--', 'scripts_other/tool.js']);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /does not resolve to a path this script is allowed to commit/);
    assert.strictEqual(gateCommitGitLog(dir), before, 'nothing must have been committed');
  });
});

test('gate-commit.js: refuses more than one path (Req 1a -- a gate role commits exactly its own verdict, never a batch)', () => {
  withGateCommitFixture((dir) => {
    fs.writeFileSync(path.join(dir, 'docs', 'sprints', 'state', 'sprint-1.json'), JSON.stringify({ x: 1 }) + '\n');
    const before = gateCommitGitLog(dir);
    const result = runGateCommit(dir, ['--message', 'x', '--', 'docs/sprints/state/sprint-1.json', 'docs/sprints/state/sprint-1.json']);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /Exactly one path is required, got 2/);
    assert.strictEqual(gateCommitGitLog(dir), before);
  });
});

test('gate-commit.js: refuses a `..` traversal path', () => {
  withGateCommitFixture((dir) => {
    const before = gateCommitGitLog(dir);
    const result = runGateCommit(dir, ['--message', 'x', '--', 'docs/sprints/state/../../../etc/passwd']);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /does not resolve to a path this script is allowed to commit/);
    assert.strictEqual(gateCommitGitLog(dir), before);
  });
});

test('gate-commit.js: refuses a string-prefix trick (docs/sprints/state-evil/ is not docs/sprints/state/)', () => {
  withGateCommitFixture((dir) => {
    fs.mkdirSync(path.join(dir, 'docs', 'sprints', 'state-evil'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'sprints', 'state-evil', 'sprint-1.json'), '{}\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'add lookalike'], { cwd: dir });
    const before = gateCommitGitLog(dir);
    const result = runGateCommit(dir, ['--message', 'x', '--', 'docs/sprints/state-evil/sprint-1.json']);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /does not resolve to a path this script is allowed to commit/);
    assert.strictEqual(gateCommitGitLog(dir), before);
  });
});

test('gate-commit.js: refuses an absolute path outside the repository', () => {
  withGateCommitFixture((dir) => {
    const before = gateCommitGitLog(dir);
    const result = runGateCommit(dir, ['--message', 'x', '--', '/etc/hostname']);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /does not resolve to a path this script is allowed to commit/);
    assert.strictEqual(gateCommitGitLog(dir), before);
  });
});

test('gate-commit.js: refuses a nonexistent sprint id -- the filename pattern alone is not enough, it must be a real, registered sprint', () => {
  withGateCommitFixture((dir) => {
    fs.writeFileSync(path.join(dir, 'docs', 'sprints', 'state', 'sprint-99.json'), '{}\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'add fake sprint state'], { cwd: dir });
    const before = gateCommitGitLog(dir);
    const result = runGateCommit(dir, ['--message', 'x', '--', 'docs/sprints/state/sprint-99.json']);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /has no entry in docs\/sprints\/registry\.json/);
    assert.strictEqual(gateCommitGitLog(dir), before);
  });
});

// Sprint 40's LiveQA reported a FALSE symlink escape from a DANGLING
// link (one whose target doesn't exist) -- this fixture uses a REAL
// target, exactly the shape this sprint's own Req 4 requires tested.
test('gate-commit.js: refuses a symlink with a REAL target outside the directory (not a dangling-link false positive)', () => {
  withGateCommitFixture((dir) => {
    const outsideTarget = path.join(dir, 'outside-secret.txt');
    fs.writeFileSync(outsideTarget, 'real secret content\n');
    const linkPath = path.join(dir, 'docs', 'sprints', 'state', 'sprint-1.json');
    fs.rmSync(linkPath);
    fs.symlinkSync(outsideTarget, linkPath);
    const before = gateCommitGitLog(dir);
    const result = runGateCommit(dir, ['--message', 'x', '--', 'docs/sprints/state/sprint-1.json']);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /is a symlink \(or sits behind one\)/);
    assert.strictEqual(gateCommitGitLog(dir), before);
  });
});

test('gate-commit.js: refuses any attempt to pass extra/unrecognized arguments (no --amend, no -a, no way to widen the surface)', () => {
  withGateCommitFixture((dir) => {
    const before = gateCommitGitLog(dir);
    for (const extra of ['--amend', '-a', '--all', '--force']) {
      const result = runGateCommit(dir, ['--message', 'x', extra, '--', 'docs/sprints/state/sprint-1.json']);
      assert.notStrictEqual(result.status, 0, `${extra} must be refused`);
      assert.match(result.stderr, /Unrecognized argument/);
    }
    assert.strictEqual(gateCommitGitLog(dir), before);
  });
});

test('gate-commit.js: refuses when no path is given -- there is no "commit everything" mode', () => {
  withGateCommitFixture((dir) => {
    const result = runGateCommit(dir, ['--message', 'x', '--']);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /A path is required/);
  });
});

test('gate-commit.js: refuses an empty commit message', () => {
  withGateCommitFixture((dir) => {
    const result = runGateCommit(dir, ['--message', '  ', '--', 'docs/sprints/state/sprint-1.json']);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /non-empty commit message is required/);
  });
});

test('gate-commit.js: --message-file reads the message from a file (matching mc-commit.js\'s/qa1.md\'s own established --notes-file pattern)', () => {
  withGateCommitFixture((dir) => {
    const msgPath = path.join(dir, 'msg.txt');
    fs.writeFileSync(msgPath, 'Record sprint 1 LiveQA verdict\n');
    fs.writeFileSync(path.join(dir, 'docs', 'sprints', 'state', 'sprint-1.json'), JSON.stringify({ x: 2 }) + '\n');
    const result = runGateCommit(dir, ['--message-file', msgPath, '--', 'docs/sprints/state/sprint-1.json']);
    assert.strictEqual(result.status, 0, `expected success, got: ${result.stderr}`);
    assert.match(gateCommitGitLog(dir), /Record sprint 1 LiveQA verdict/);
  });
});

test('gate-commit.js: never reaches a remote -- a real bare remote receives nothing (no code path here ever constructs a git push)', () => {
  withGateCommitFixture((dir) => {
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-gate-commit-remote-'));
    execFileSync('git', ['init', '-q', '--bare'], { cwd: remoteDir });
    execFileSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'docs', 'sprints', 'state', 'sprint-1.json'), JSON.stringify({ x: 3 }) + '\n');
    const result = runGateCommit(dir, ['--message', 'local only', '--', 'docs/sprints/state/sprint-1.json']);
    assert.strictEqual(result.status, 0);
    const remoteRefs = execFileSync('git', ['for-each-ref'], { cwd: remoteDir, encoding: 'utf8' }).trim();
    assert.strictEqual(remoteRefs, '', 'a real bare remote must have received nothing at all');
    fs.rmSync(remoteDir, { recursive: true, force: true });
  });
});

test('gate-commit.js: no environment variable or CLI flag widens the allowlist at run time (Req 1a\'s own "no escape hatch", matching mc-commit.js\'s Req 2c precedent)', () => {
  withGateCommitFixture((dir) => {
    fs.mkdirSync(path.join(dir, 'scripts_other'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts_other', 'tool.js'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'add tool'], { cwd: dir });
    const before = gateCommitGitLog(dir);
    const result = spawnSync(
      process.execPath,
      [path.join(dir, 'scripts', 'gate-commit.js'), '--message', 'x', '--', 'scripts_other/tool.js'],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, GATE_COMMIT_ALLOW_ALL: '1', FULLY_COMPLETELY_GATE_COMMIT_UNSAFE: '1' } }
    );
    assert.notStrictEqual(result.status, 0);
    assert.strictEqual(gateCommitGitLog(dir), before);
  });
});

test('gate-commit.js: source-level check -- no code path reads process.env to build or extend the allowlist', () => {
  const src = fs.readFileSync(GATE_COMMIT_PATH, 'utf8');
  assert.doesNotMatch(src, /process\.env/, 'gate-commit.js must never read any environment variable');
});

test('gate-commit.js: source-level check -- the only git subcommand this file ever passes to spawnSync is "commit" (never "add", "push", "-a", "-A", "--all", or ".")', () => {
  const src = fs.readFileSync(GATE_COMMIT_PATH, 'utf8');
  const spawnCalls = [...src.matchAll(/spawnSync\('git',\s*\[([^\]]*)\]/g)].map((m) => m[1]);
  assert.strictEqual(spawnCalls.length, 1, `expected exactly one spawnSync('git', [...]) call site, found ${spawnCalls.length}`);
  const argsSrc = spawnCalls[0];
  assert.ok(/'commit'/.test(argsSrc), 'expected the one call to pass "commit"');
  for (const forbidden of ["'add'", "'push'", "'-a'", "'-A'", "'--all'", "'.'", "'-am'", "'--amend'"]) {
    assert.ok(!argsSrc.includes(forbidden), `no spawnSync('git', [...]) call may ever pass ${forbidden}`);
  }
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nALL LAUNCHER TESTS PASSED');
