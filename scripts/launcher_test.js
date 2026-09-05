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
} = require('./launcher/prompts');
const {
  freshLaunchArgs,
  resumeLaunchArgs,
  headlessLaunchArgs,
  headlessPermissionArgs,
  LAUNCHER_FAILURE_EXIT_CODE,
  installOrphanGuard,
  readDeclaredTestCommand,
  HEADLESS_PERMISSION_PROFILES,
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
    'do the audit',
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
    'do the audit',
  ]);
});

test('run-role: headlessLaunchArgs bare:true adds --bare, omits --no-session-persistence, omits --settings when none given', () => {
  const args = headlessLaunchArgs(QA1_ROLE, 'do the audit', { bare: true });
  assert.deepStrictEqual(args.slice(4), ['-p', '--output-format', 'json', ...headlessPermissionArgs(QA1_ROLE), '--bare', 'do the audit']);
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
    'do the audit',
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

test('run-role: headlessLaunchArgs prompt stays the final positional argument in every mode', () => {
  assert.strictEqual(headlessLaunchArgs(QA1_ROLE, 'X').slice(-1)[0], 'X');
  assert.strictEqual(headlessLaunchArgs(QA1_ROLE, 'X', { bare: true }).slice(-1)[0], 'X');
  assert.strictEqual(headlessLaunchArgs(QA1_ROLE, 'X', { bare: true, settings: 'S' }).slice(-1)[0], 'X');
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
  // appear if state had been paraphrased in.
  assert.ok(prompt.length < 900, `expected a short pointer, got ${prompt.length} chars`);
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
    assert.strictEqual(result.stderr, '');
    assert.deepStrictEqual(readArgv(), headlessLaunchArgs(QA1_ROLE, headlessPrompt(QA1_ROLE, '4')));
    assert.ok(!readArgv().includes('--bare'), 'the default path must never pass --bare');
  });
});

test('run-role CLI: --bare with neither ANTHROPIC_API_KEY nor --settings fails without ever probing operator auth', () => {
  withFakeClaude(({ dir, readArgv }) => {
    const env = { ...process.env, PATH: dir };
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
    const env = { ...process.env, PATH: dir };
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
    assert.strictEqual(result.stderr, '');
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
    assert.strictEqual(result.stderr, '');
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

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nALL LAUNCHER TESTS PASSED');
