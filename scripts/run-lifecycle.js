#!/usr/bin/env node
'use strict';
// Sprint 10, Req 5: every /sprint-* command that runs sprint_lifecycle.py
// (eleven of the twelve command files — /sprint-worktree runs
// dev2_worktree.sh instead) hardcoded `python3 scripts/sprint_lifecycle.py
// ...`, which does not exist after a python.org install on Windows (it
// registers `python` and `py`, never `python3` — only a Microsoft Store
// install does that). All eleven now run this wrapper instead:
//
//   node scripts/run-lifecycle.js <same arguments as before>
//
// which resolves a real Python 3 interpreter (python3, then python, then
// py — scripts/launcher/python-interpreter.js, shared with install.js's
// own courtesy check) and re-execs sprint_lifecycle.py through it,
// forwarding every argument, stdio, and the real exit code unchanged.
// Node itself is already a hard requirement (package.json's own
// "engines"), so a wrapper written in Node — rather than, say, a second
// copy of this logic in each command file's own shell snippet — is
// something every install already has, and it means this resolution
// logic exists in exactly one place rather than eleven.
//
// On macOS/Linux this changes nothing observable: python3 is correct and
// present, resolves first, and every command behaves exactly as it did
// invoking python3 directly.
const path = require('path');
const { spawnSync } = require('child_process');
const { findPython3Interpreter, CANDIDATES } = require('./launcher/python-interpreter');

const SPRINT_LIFECYCLE_PATH = path.join(__dirname, 'sprint_lifecycle.py');

const interpreter = findPython3Interpreter();
if (interpreter === null) {
  console.error(
    `ERROR: no Python 3 interpreter found on PATH (tried ${CANDIDATES.join(', ')}). ` +
      'Every /sprint-* slash command needs one. Install Python 3 from https://python.org ' +
      '(the Microsoft Store listing works too), then confirm it with one of ' +
      '`python3 --version`, `python --version`, or `py --version` — any of those printing ' +
      'a "Python 3.x.y" line means you are ready.'
  );
  process.exit(1);
}

const result = spawnSync(interpreter, [SPRINT_LIFECYCLE_PATH, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

if (result.error) {
  console.error(`ERROR: failed to run '${interpreter}': ${result.error.message}`);
  process.exit(1);
}
// A signal (result.status === null, result.signal set) has no meaningful
// exit code of its own; 1 is the closest honest "something went wrong"
// available rather than exiting 0 and claiming success.
process.exit(result.status === null ? 1 : result.status);
