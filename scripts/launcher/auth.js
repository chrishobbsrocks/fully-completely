'use strict';
// Login preflight (sprint 1, Req 6). Asks the CLI's own `claude auth
// status` and reads only its exit code — per Req 6a, this never parses
// `--json` output or guesses at field names, since that couples the
// launcher to an undocumented shape to answer a question the exit code
// already carries on its own: authenticated, or not.
//
// classify() is the pure, testable core, separated from the spawnSync call
// so tests can drive every branch with a synthetic probe result instead of
// needing a real logged-out CLI (there's exactly one real Claude login on
// a dev machine, and logging it out and back in isn't something a test
// should be doing).
const { spawnSync } = require('child_process');
const { claudeCommand } = require('./claude-cmd');

const AUTH_PROBE_TIMEOUT_MS = 5000;

// Req 6b: three outcomes, not two.
//   - 'authenticated'   — clean exit 0. Proceed.
//   - 'unauthenticated' — the probe ran to completion and returned a
//                         defined non-zero status. Block.
//   - 'inconclusive'    — the probe itself didn't produce a trustworthy
//                         answer (failed to spawn, or was killed/timed
//                         out before exiting) — a failure unrelated to
//                         auth, not evidence the user is logged out.
//                         Proceed. This is the asymmetry Req 6b requires:
//                         a false "logged out" hard-blocks a working
//                         setup with no way past it, so anything short of
//                         a clean, completed non-zero exit must not block.
function classify(probe) {
  if (probe.error) return 'inconclusive';
  if (probe.signal) return 'inconclusive';
  if (probe.status === 0) return 'authenticated';
  // 'unauthenticated' requires positive evidence — a real, completed,
  // non-zero exit code — not just "wasn't 0 and wasn't caught above".
  // spawnSync's status is null when the process was killed by a signal
  // without a captured signal name reaching here, or in any other shape
  // this probe wasn't designed around; that's exactly the "probe fails
  // for a reason unrelated to auth" case Req 6b names, so it must not
  // fall through to a block.
  if (typeof probe.status === 'number' && probe.status !== 0) return 'unauthenticated';
  return 'inconclusive';
}

function checkAuth() {
  const [cmd, args] = claudeCommand(['auth', 'status']);
  const probe = spawnSync(cmd, args, { stdio: 'ignore', timeout: AUTH_PROBE_TIMEOUT_MS });
  return classify(probe);
}

module.exports = { checkAuth, classify, AUTH_PROBE_TIMEOUT_MS };
