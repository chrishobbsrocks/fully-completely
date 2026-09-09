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

// Records that `roleId` is launching now, in `repoRoot`, returning
// whatever claim existed for that role BEFORE this call (or null if none
// did) so the caller can decide what to print. `sessionId` is caller-
// supplied rather than generated in here, so a caller with a real,
// already-computed identifier (the interactive path's own deterministic
// UUIDv5 from session.js) can pass that instead of a second, unrelated
// one -- this function only ever records whatever identity it's given,
// it does not mint identity itself except via the `nowFn`/id fallback a
// caller can also override for tests.
function recordRoleClaim(roleId, repoRoot, { sessionId, now = () => new Date() } = {}) {
  const claims = readClaims(repoRoot);
  const previous = Object.prototype.hasOwnProperty.call(claims, roleId) ? claims[roleId] : null;
  claims[roleId] = { sessionId: sessionId || null, startedAt: now().toISOString() };
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
  return previous;
}

// Sprint 25, Req 1's own required wording: names the blind spot in the
// message itself, not only in a code comment nobody launching a role will
// ever read. Returns null (nothing to print) when there is no previous
// claim to warn about -- the common, correct case for a role's first
// launch in a tree.
function roleClaimWarning(roleLabel, previousClaim) {
  if (!previousClaim) return null;
  return (
    `NOTE: another ${roleLabel} session was recorded starting at ` +
    `${previousClaim.startedAt} in this same tree${previousClaim.sessionId ? ` (session ${previousClaim.sessionId})` : ''}. ` +
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
};
