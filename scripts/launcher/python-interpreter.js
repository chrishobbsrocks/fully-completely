'use strict';
// Sprint 10: the one place "which command actually runs Python 3" is
// decided, shared between install.js (Req 4, a courtesy check — a
// missing interpreter never blocks the install itself) and
// scripts/run-lifecycle.js (Req 5, where it's load-bearing — every slash
// command needs a real interpreter to do anything at all). Resolution
// order is python3, then python, then py (Req 5's own wording) — python3
// is correct and present on macOS/Linux, and stays first so this changes
// nothing there; python and py are the two ways a python.org install on
// Windows actually registers itself (a python.org install never creates
// a python3 command at all, which is the whole reason this exists).
const { spawnSync } = require('child_process');

const CANDIDATES = ['python3', 'python', 'py'];

// Real Python 2 still exists on some machines (older macOS/Linux installs
// that predate python3 becoming the default), and its own --version
// output goes to stderr, not stdout, unlike Python 3's — checking both
// streams and requiring the "Python 3." prefix is what catches that,
// rather than treating any successful exit as good enough. Also covers
// Windows' App Execution Alias for an uninstalled "python"/"python3":
// spawning it exits non-zero rather than printing a version, so it's
// correctly treated as absent, not present.
function isPython3(candidate) {
  let result;
  try {
    result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
  } catch {
    return false;
  }
  if (result.error || typeof result.status !== 'number' || result.status !== 0) return false;
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return /^Python 3\./.test(output.trim());
}

// The first working candidate, in resolution order, or null if none of
// them resolve to a real Python 3 interpreter. Never throws — every
// failure mode (not on PATH, a Windows Store alias, an actual Python 2)
// folds into "try the next one, then report null" rather than an
// exception a caller would need to handle separately.
function findPython3Interpreter() {
  return CANDIDATES.find(isPython3) || null;
}

module.exports = { findPython3Interpreter, CANDIDATES };
