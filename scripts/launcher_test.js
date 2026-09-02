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
const { execFileSync, spawnSync } = require('child_process');

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
    const dir = sessionsDir('/Users/chrishobbs/Programming/fully-completely', home);
    assert.strictEqual(dir, path.join(home, '.claude', 'projects', '-Users-chrishobbs-Programming-fully-completely'));
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
// pipeman.md, not qa1.md or liveqa.md, for the tests below that assert a
// file matches the COMMITTED baseline table (scripts/baselines/user-owned-
// content.json, generated from published tarballs): sprint 9 edited
// qa1.md's live content and sprint 11 edits BOTH qa1.md's and liveqa.md's
// (Req 7's --notes-file mandate) ahead of the 0.1.10 publish that will
// regenerate that table, so neither currently matches any published
// version — a test proving "matches a published baseline" needs a file
// this repo hasn't since changed. pipeman.md is untouched since 0.1.8 (the
// table's newest entry); confirmed by hash before relying on it here.
const REAL_PIPEMAN_MD = fs.readFileSync(path.join(REPO_ROOT, '.claude', 'agents', 'pipeman.md'), 'utf8');
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
const PIPEMAN_REL_PATH = path.join('.claude', 'agents', 'pipeman.md');

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
  // real published tarballs) is Req 1's second source of proof: pipeman.md's
  // content here is exactly what shipped through 0.1.8, so it must now be
  // recognised and brought current, not conflicted. (pipeman.md, not
  // qa1.md or liveqa.md — sprint 9 edited qa1.md's live content and
  // sprint 11 edits both qa1.md's and liveqa.md's ahead of the 0.1.10
  // publish that will regenerate this table, so neither's current bytes
  // are on record there right now; see REAL_PIPEMAN_MD's own comment
  // above. baselineHashesFor() matches against any published version, not
  // just the one in the fixture's version marker, so 0.1.4 here doesn't
  // need to be the specific version whose hash matches.)
  withFixture((dir) => {
    writeVersionMarker(dir, '0.1.4');
    const pipemanPath = path.join(dir, PIPEMAN_REL_PATH);
    fs.mkdirSync(path.dirname(pipemanPath), { recursive: true });
    fs.writeFileSync(pipemanPath, REAL_PIPEMAN_MD);

    const output = runInstall(dir);

    assert.doesNotMatch(output, /Conflicts/, 'a baseline-proven file must not conflict');
    assert.match(output, /Already present, unchanged[\s\S]*\.claude\/agents\/pipeman\.md/);
    assert.strictEqual(fs.readFileSync(pipemanPath, 'utf8'), REAL_PIPEMAN_MD);
    const manifest = readManifest(dir);
    assert.strictEqual(
      manifest[PIPEMAN_REL_PATH],
      fcHash(REAL_PIPEMAN_MD),
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
    const pipemanPath = path.join(dir, PIPEMAN_REL_PATH);
    fs.mkdirSync(path.dirname(pipemanPath), { recursive: true });
    fs.writeFileSync(pipemanPath, REAL_PIPEMAN_MD); // byte-identical to what we'd write
    // A manifest recording the CORRECT hash, but under the Windows-shaped
    // key a broken pre-fix run would have used instead of the real
    // forward-slash one. manifestHashFor() normalizes the QUERY key
    // (built from the real, forward-slash relPath on this machine), so it
    // must look for '.claude/agents/pipeman.md' and find nothing here.
    // pipeman.md, not qa1.md (this test's original fixture file) — sprint
    // 11 edits qa1.md live (Req 7), so it's no longer on record in the
    // committed baseline table until 0.1.10 publishes and regenerates it;
    // see REAL_PIPEMAN_MD's own comment above.
    writeManifest(dir, { '.claude\\agents\\pipeman.md': fcHash(REAL_PIPEMAN_MD) });

    const output = runInstall(dir);

    // No manifest match — but REAL_PIPEMAN_MD also matches a real published
    // baseline, so Req 1's second proof source correctly takes over and
    // this still resolves to "already present", not a conflict. That's
    // the safe fallback working, not a failure to detect the stale key.
    assert.match(output, /Already present, unchanged[\s\S]*\.claude\/agents\/pipeman\.md/);
    assert.doesNotMatch(output, /Conflicts/);
    const manifest = readManifest(dir);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(manifest, '.claude\\agents\\pipeman.md'),
      'the stale backslash key must not survive into the new manifest'
    );
    assert.strictEqual(manifest[PIPEMAN_REL_PATH], fcHash(REAL_PIPEMAN_MD), 'the real, forward-slash key must be written instead');
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
// run-role.js (Sprint 11: headless launch, Req 9 coverage)
// -------------------------------------------------------------------------
const { ROLES: RUN_ROLE_ROLES, readAgentMeta, agentBody } = require('./launcher/agents');
const { initialPrompt: RR_initialPrompt, devTeam2ResumePrompt: RR_devTeam2ResumePrompt } = require('./launcher/prompts');
const {
  freshLaunchArgs,
  resumeLaunchArgs,
  headlessLaunchArgs,
} = require('./launcher/run-role');

const QA1_ROLE = RUN_ROLE_ROLES.find((r) => r.id === 'qa1');
const DEV_TEAM_2_ROLE = RUN_ROLE_ROLES.find((r) => r.id === 'dev-team-2');

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

// Req 3 + Req 4 (headless argv shape): built from the same
// readAgentMeta()/agentBody() split the interactive path never touches, so
// this test would fail the moment headlessLaunchArgs and agents.js drift
// about where the frontmatter ends, rather than only on a real invocation.
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
  assert.deepStrictEqual(args.slice(4), ['-p', '--output-format', 'json', '--bare', 'do the audit']);
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

// CLI-level tests: spawn the real script as a real OS process (Req 1 — a
// headless launch is a genuinely separate process, never an in-process
// sub-agent call), against this worktree's real .claude/agents/*.md files.
const RUN_ROLE_PATH = path.join(REPO_ROOT, 'scripts', 'launcher', 'run-role.js');

function runRoleCli(args, envOverrides) {
  return spawnSync(process.execPath, [RUN_ROLE_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...envOverrides },
  });
}

// A fake `claude` on PATH: answers --version so claudeOnPath() passes,
// records every other invocation's argv (one per line) to a log file, and
// prints ONLY a fixed JSON string to stdout — nothing else — so a test can
// assert stdout equals exactly that string (Req 2: headless writes nothing
// extraneous to stdout) while still separately observing stderr.
const FAKE_JSON_RESULT = '{"type":"result","is_error":true,"result":"fake"}';

function withFakeClaude(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-fake-claude-'));
  const argvLog = path.join(dir, 'argv.log');
  const script = [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then exit 0; fi',
    'for a in "$@"; do printf \'%s\\n\' "$a" >> ' + JSON.stringify(argvLog) + '; done',
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
      // No log file at all means claude was never invoked — a valid, in
      // fact the expected, outcome for every precondition-failure test
      // below, not a fixture bug.
      readArgv: () => (fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8').split('\n').filter((l) => l.length) : []),
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('run-role CLI: unknown role is rejected before any headless logic runs (no PATH/env needed)', () => {
  const result = runRoleCli(['not-a-real-role', '--headless'], {});
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /Unknown role 'not-a-real-role'/);
  assert.strictEqual(result.stdout, '');
});

test('run-role CLI: --headless without --prompt-file fails with the exact message, before spawning claude', () => {
  withFakeClaude(({ dir, readArgv }) => {
    const result = runRoleCli(['qa1', '--headless'], { PATH: dir, ANTHROPIC_API_KEY: 'fake-key' });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /--headless requires --prompt-file <path>\./);
    assert.strictEqual(result.stdout, '');
    assert.deepStrictEqual(readArgv(), [], 'claude must never be invoked when --prompt-file is missing');
  });
});

test('run-role CLI: missing ANTHROPIC_API_KEY fails headless before even reading the prompt file', () => {
  withFakeClaude(({ dir, readArgv }) => {
    // Build env explicitly and delete the key after merging with
    // process.env, rather than just omitting it from envOverrides — an
    // ambient ANTHROPIC_API_KEY already set in the environment running
    // this test suite would otherwise leak through runRoleCli's
    // {...process.env, ...envOverrides} merge and silently pass this check
    // for the wrong reason.
    const env = { ...process.env, PATH: dir };
    delete env.ANTHROPIC_API_KEY;
    const result = spawnSync(
      process.execPath,
      [RUN_ROLE_PATH, 'qa1', '--headless', '--prompt-file', '/nonexistent/does-not-matter.txt'],
      { cwd: REPO_ROOT, encoding: 'utf8', env }
    );
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /ANTHROPIC_API_KEY is not set/);
    assert.strictEqual(result.stdout, '');
    assert.deepStrictEqual(readArgv(), [], 'claude must never be invoked with no credentials');
  });
});

test('run-role CLI: a missing --prompt-file target fails and names the exact path', () => {
  withFakeClaude(({ dir, readArgv }) => {
    const missingPath = path.join(os.tmpdir(), `fc-missing-prompt-${Date.now()}.txt`);
    const result = runRoleCli(['qa1', '--headless', '--prompt-file', missingPath], {
      PATH: dir,
      ANTHROPIC_API_KEY: 'fake-key',
    });
    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes(`Could not read --prompt-file '${missingPath}'`), result.stderr);
    assert.strictEqual(result.stdout, '');
    assert.deepStrictEqual(readArgv(), []);
  });
});

test('run-role CLI: an empty --prompt-file fails distinctly from a missing one', () => {
  withFakeClaude(({ dir, readArgv }) => {
    const emptyPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-empty-prompt-')), 'prompt.txt');
    fs.writeFileSync(emptyPath, '   \n  \n');
    const result = runRoleCli(['qa1', '--headless', '--prompt-file', emptyPath], {
      PATH: dir,
      ANTHROPIC_API_KEY: 'fake-key',
    });
    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes(`--prompt-file '${emptyPath}' is empty`), result.stderr);
    assert.strictEqual(result.stdout, '');
    assert.deepStrictEqual(readArgv(), []);
  });
});

test('run-role CLI: a real headless launch spawns claude with the exact headlessLaunchArgs and prints ONLY its stdout', () => {
  withFakeClaude(({ dir, readArgv }) => {
    const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-real-prompt-'));
    const promptPath = path.join(promptDir, 'prompt.txt');
    fs.writeFileSync(promptPath, '  do the sprint 11 audit  \n');
    const result = runRoleCli(['qa1', '--headless', '--prompt-file', promptPath], {
      PATH: dir,
      ANTHROPIC_API_KEY: 'fake-key',
    });
    assert.strictEqual(result.status, 0);
    // Req 2, mechanically: stdout is exactly the child's output, nothing
    // this file's own code contributed (no banner, no "Restarting...",
    // nothing) — and it parses, since the real --bare path's own envelope
    // is JSON even on failure (confirmed against real credential-less
    // runs; this fake stands in for that envelope shape).
    assert.strictEqual(result.stdout, FAKE_JSON_RESULT);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    assert.strictEqual(result.stderr, '');
    // Req 3 + Req 4: the prompt read from the file (trimmed) reached
    // claude's real argv, and --bare was passed unconditionally.
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

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nALL LAUNCHER TESTS PASSED');
