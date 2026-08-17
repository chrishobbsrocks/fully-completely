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

test('session: directory derivation replaces Windows-style separators too', () => {
  withTmpHome((home) => {
    const dir = sessionsDir('C:\\Users\\chris\\Programming\\fully-completely', home);
    assert.strictEqual(dir, path.join(home, '.claude', 'projects', 'C:-Users-chris-Programming-fully-completely'));
    assert.ok(!dir.includes('\\Users\\'), 'backslash separators must not survive encoding');
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
// auth.js: login preflight classification (Req 6a/6b)
// -------------------------------------------------------------------------
const { classify } = require('./launcher/auth');

test('auth: a clean exit 0 classifies as authenticated', () => {
  assert.strictEqual(classify({ status: 0, error: null, signal: null }), 'authenticated');
});

test('auth: a clean non-zero exit classifies as unauthenticated', () => {
  assert.strictEqual(classify({ status: 1, error: null, signal: null }), 'unauthenticated');
});

test('auth: a spawn error classifies as inconclusive, not unauthenticated', () => {
  assert.strictEqual(
    classify({ status: null, error: new Error('spawn claude ENOENT'), signal: null }),
    'inconclusive'
  );
});

test('auth: a killed/timed-out probe classifies as inconclusive, not unauthenticated', () => {
  assert.strictEqual(classify({ status: null, error: null, signal: 'SIGTERM' }), 'inconclusive');
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

test('install.js: a CRLF-converted framework file is recognized as unchanged', () => {
  withFixture((dir) => {
    const crlf = fs.readFileSync(path.join(REPO_ROOT, 'CLAUDE.md'), 'utf8').replace(/\r?\n/g, '\r\n');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), crlf);
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

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nALL LAUNCHER TESTS PASSED');
