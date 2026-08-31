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
const { execFileSync } = require('child_process');

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
    // install.js exits 1 when it reports conflicts — still valid output
    // to inspect, not a test-harness failure.
    if (typeof err.stdout === 'string') return err.stdout;
    throw err;
  }
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
    writeVersionMarker(dir, REAL_CURRENT_VERSION);
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
    assert.strictEqual(fs.readFileSync(qa1Path, 'utf8'), customized, 'a customised file must never be overwritten');
    assert.ok(!fs.existsSync(`${qa1Path}.fc-bak-${REAL_CURRENT_VERSION}`), 'nothing was overwritten, so nothing should be backed up');
    const manifest = readManifest(dir);
    assert.strictEqual(
      manifest[QA1_REL_PATH],
      fcHash(REAL_QA1_MD),
      "a conflicted path's manifest entry is carried forward unchanged, never updated to the customised content"
    );
  });
});

test('install.js: no manifest file at all means a user-owned file is never overwritten, even if its content matches upstream exactly', () => {
  // Req 3's sharpest case: every install from before this sprint looks
  // exactly like this — a version marker, real user-owned files, no
  // manifest. Content matching upstream by coincidence must not be
  // mistaken for positive proof.
  withFixture((dir) => {
    writeVersionMarker(dir, '0.1.0');
    const qa1Path = path.join(dir, QA1_REL_PATH);
    fs.mkdirSync(path.dirname(qa1Path), { recursive: true });
    fs.writeFileSync(qa1Path, REAL_QA1_MD);

    const output = runInstall(dir);

    assert.match(output, /Conflicts[\s\S]*\.claude\/agents\/qa1\.md \(yours/);
    assert.strictEqual(fs.readFileSync(qa1Path, 'utf8'), REAL_QA1_MD);
    const manifest = readManifest(dir);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(manifest, QA1_REL_PATH),
      'a path with no prior manifest entry gets none added just for being seen — the conflict must be resolved by hand first'
    );
  });
});

test('install.js: a manifest that is not valid JSON resolves every user-owned file to no-overwrite, not a crash', () => {
  withFixture((dir) => {
    writeVersionMarker(dir, '0.1.0');
    const qa1Path = path.join(dir, QA1_REL_PATH);
    fs.mkdirSync(path.dirname(qa1Path), { recursive: true });
    fs.writeFileSync(qa1Path, REAL_QA1_MD);
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'fully-completely-manifest.json'), '{ this is not valid JSON');

    const output = runInstall(dir);

    assert.match(output, /Conflicts[\s\S]*\.claude\/agents\/qa1\.md \(yours/);
    assert.strictEqual(fs.readFileSync(qa1Path, 'utf8'), REAL_QA1_MD);
  });
});

test('install.js: a manifest entry that is not a well-formed hash resolves that file to no-overwrite', () => {
  withFixture((dir) => {
    writeVersionMarker(dir, '0.1.0');
    const qa1Path = path.join(dir, QA1_REL_PATH);
    fs.mkdirSync(path.dirname(qa1Path), { recursive: true });
    fs.writeFileSync(qa1Path, REAL_QA1_MD);
    writeManifest(dir, { [QA1_REL_PATH]: 'not-a-real-hash' });

    const output = runInstall(dir);

    assert.match(output, /Conflicts[\s\S]*\.claude\/agents\/qa1\.md \(yours/);
    assert.strictEqual(fs.readFileSync(qa1Path, 'utf8'), REAL_QA1_MD);
  });
});

test('install.js: a valid manifest with no entry for a given user-owned file resolves that file to no-overwrite', () => {
  withFixture((dir) => {
    writeVersionMarker(dir, '0.1.0');
    const qa1Path = path.join(dir, QA1_REL_PATH);
    fs.mkdirSync(path.dirname(qa1Path), { recursive: true });
    fs.writeFileSync(qa1Path, REAL_QA1_MD);
    // A real, well-formed manifest — just with no key at all for this
    // particular path.
    writeManifest(dir, { 'CLAUDE.md': fcHash('unrelated') });

    const output = runInstall(dir);

    assert.match(output, /Conflicts[\s\S]*\.claude\/agents\/qa1\.md \(yours/);
    assert.strictEqual(fs.readFileSync(qa1Path, 'utf8'), REAL_QA1_MD);
  });
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nALL LAUNCHER TESTS PASSED');
