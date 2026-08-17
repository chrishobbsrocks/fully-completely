'use strict';
// Login preflight (sprint 1, Req 6, 6a-revised, 6b, 6b-clarified, 6c).
// Reads exactly one field — `loggedIn` — from `claude auth status --json`,
// and blocks only on an explicit `loggedIn === false`. Nothing else in the
// JSON (authMethod, email, subscriptionType, ...) is read or branched on.
//
// This started as exit-code-only (Req 6a's original wording: "the exit
// code already carries it"). LiveQA's live test measured that claim false
// against real CLI 2.1.233: a genuine logout and at least two probe
// failures (an unrecognised subcommand, an unrecognised flag) all produce
// the identical non-zero exit code with no distinguishing signal. Honoring
// Req 6b ("never block without positive evidence") strictly under
// exit-code-only meant the preflight could never block anyone — deleting
// Requirement 6's purpose. Req 6a-revised replaced it with reading
// `loggedIn`, and Req 6b is what makes that safe: if the JSON shape ever
// changes and `loggedIn` can't be found, the result is 'inconclusive' (we
// stop blocking — harmless) rather than a false block.
//
// One more round of verification mattered here (Req 6b-clarified): hand
// capturing stdout, not just exit codes, for all four of LiveQA's measured
// failure scenarios found they split two and two, not four proceeding as
// first assumed —
//   - Unrecognised subcommand / unrecognised flag: non-JSON error text,
//     `loggedIn` absent → 'inconclusive'. The probe broke; auth is fine.
//   - A `chmod 000` config dir / a config dir that's a file, not a
//     directory: BOTH print a well-formed `{"loggedIn": false, ...}`,
//     byte-identical to a genuine logout. Correctly so — in both cases
//     this session cannot authenticate, and all six agents would fail
//     identically. `classify()` blocks on all three; there is no way to
//     tell them apart from `loggedIn` alone, and Req 6b-clarified forbids
//     trying (no reading `authMethod` to guess the cause) — proceeding
//     anyway would just reproduce the original bug (six doomed terminals).
//
// classify() and parseLoggedIn() are pure and separated from the
// spawnSync call so tests can drive every branch with a synthetic probe
// result instead of needing a real logged-out CLI (there's exactly one
// real Claude login on a dev machine, and logging it out and back in
// isn't something a test should be doing) — but every shape used in the
// tests was captured from the real CLI first, not guessed.
const { spawnSync } = require('child_process');
const { claudeCommand } = require('./claude-cmd');

const AUTH_PROBE_TIMEOUT_MS = 5000;

// Pulls `loggedIn` out of `claude auth status --json`'s stdout without
// trusting anything else about the shape. Returns true/false only when
// that one field is confidently readable as a boolean; undefined for
// anything else (no stdout, malformed JSON, non-object JSON, a missing or
// non-boolean field) — undefined is classify()'s signal that the probe
// didn't produce an answer, not that it produced a bad one.
function parseLoggedIn(stdout) {
  if (!stdout) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(stdout.toString('utf8'));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  if (typeof parsed.loggedIn !== 'boolean') return undefined;
  return parsed.loggedIn;
}

// Req 6b / 6b-clarified: the line is "could the probe answer?", not "why
// can't the user authenticate?".
//   - 'authenticated'   — loggedIn === true, or (absent any parseable
//                         loggedIn) a clean exit 0.
//   - 'unauthenticated' — loggedIn === false, parsed explicitly. The only
//                         path that blocks — whether the underlying cause
//                         is a genuine logout or a broken config
//                         directory, the CLI itself is reporting
//                         unusable credentials, which is positive
//                         evidence, not an unrelated probe failure.
//   - 'inconclusive'    — the probe itself failed to produce an answer:
//                         spawn error, signal/timeout, non-JSON output,
//                         absent output, or a missing/non-boolean
//                         `loggedIn` field. Proceed — never block without
//                         positive evidence.
function classify(probe) {
  if (probe.error) return 'inconclusive';
  if (probe.signal) return 'inconclusive';

  const loggedIn = parseLoggedIn(probe.stdout);
  if (loggedIn === true) return 'authenticated';
  if (loggedIn === false) return 'unauthenticated';
  if (probe.status === 0) return 'authenticated';
  return 'inconclusive';
}

function checkAuth() {
  const [cmd, args] = claudeCommand(['auth', 'status', '--json']);
  const probe = spawnSync(cmd, args, {
    timeout: AUTH_PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return classify(probe);
}

module.exports = { checkAuth, classify, parseLoggedIn, AUTH_PROBE_TIMEOUT_MS };
