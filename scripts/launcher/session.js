'use strict';
// Deterministic session-ID assignment + resume-vs-fresh selection for the
// VS Code launcher (sprint 1, Req 1-1c, 4, 5a). There is no state file
// anywhere in this module — every decision is made by computing candidate
// UUIDs and checking which ones already have a session file on disk, the
// filesystem-as-source-of-truth principle Req 4 establishes and Req 1b
// extends to cover generations.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// A fixed, valid UUID used only as uuidv5's namespace input, never as a
// literal identifier of anything on its own. This is RFC 4122's
// predefined "URL" namespace — reusing the standard constant rather than
// minting an arbitrary one of our own.
const NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

// How many generations to probe before giving up on the deterministic
// scheme and falling back to an ungoverned random ID (Req 1b). 100
// restarts of one role in one repo is already an absurd number to hit in
// practice; this bound exists so a pathological case fails safe instead of
// scanning forever.
const MAX_GENERATIONS = 100;

function uuidToBytes(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function bytesToUuid(bytes) {
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

// UUIDv5 (RFC 4122 §4.3): SHA-1(namespace bytes + name bytes), truncated to
// 16 bytes, with the version nibble forced to 5 and the variant bits
// forced to the RFC's "10" — the two things that make this a spec-valid
// UUID rather than a hash reformatted to merely look like one (Req 2).
// node:crypto's createHash is the only dependency used; nothing new is
// added to package.json.
function uuidv5(name, namespace) {
  const hash = crypto
    .createHash('sha1')
    .update(Buffer.concat([uuidToBytes(namespace), Buffer.from(name, 'utf8')]))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx per RFC 4122
  return bytesToUuid(bytes);
}

// Stable per (role, repo, generation) session ID (Req 1, 1a). Same inputs
// always produce the same UUID, so nothing about it is ever written down —
// it's recomputed fresh every time it's needed, which is what lets this
// replace state.js entirely.
function sessionId(roleId, repoRoot, generation) {
  return uuidv5(`fc:${roleId}:${repoRoot}:${generation}`, NAMESPACE);
}

// Mirrors how the Claude CLI encodes a project's session directory under
// ~/.claude/projects/: every character in the absolute repo path that
// isn't an ASCII letter or digit is replaced with '-', one-for-one, no
// collapsing of runs. This was verified by hand against real macOS session
// directories while building this — first against a plain path (only
// slashes), which is what an earlier version of this function assumed and
// QA1 correctly failed: a real repo path containing a space or a dot
// (e.g. `~/Projects/Example Corp. (Staging)  Notes`, which happens to
// cover parentheses and two consecutive spaces too) encodes those
// characters just the same, not just separators. Re-verified against a
// path containing a space, two consecutive spaces, a dot, parentheses,
// and single/double underscores —
// each individual non-alnum character maps to its own '-', confirming
// "any non-alnum -> '-'" rather than "separators only" or "collapse runs
// of specials into one dash". Applying the same uniform rule to a
// Windows-style path (colons, backslashes, a space in `C:\Users\Chris
// Hobbs\...`) is the reasonable extrapolation, but Windows itself remains
// unverified until this sprint's Windows gate runs (see Risks in the
// sprint file) — the character-class approach is chosen specifically
// because it doesn't need a separate, unverified special case for
// backslash vs forward slash the way the slash-only version did. homeDir
// is a parameter rather than an os.homedir() call buried inside the
// function so tests can point it at a throwaway fixture directory instead
// of the real one.
function sessionsDir(repoRoot, homeDir = os.homedir()) {
  const encoded = repoRoot.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(homeDir, '.claude', 'projects', encoded);
}

function sessionFilePath(roleId, repoRoot, generation, homeDir = os.homedir()) {
  return path.join(sessionsDir(repoRoot, homeDir), `${sessionId(roleId, repoRoot, generation)}.jsonl`);
}

// The scan that answers both selection rules (Req 1b, 5a) — no state file,
// just: which generations' session files exist right now. Returns the
// highest existing generation, or -1 if none exist. Uses *highest*, not
// *first gap*, so a manually deleted middle generation can't cause a live
// ID to be reassigned.
function highestExistingGeneration(roleId, repoRoot, homeDir) {
  let highest = -1;
  for (let generation = 0; generation < MAX_GENERATIONS; generation += 1) {
    if (fs.existsSync(sessionFilePath(roleId, repoRoot, generation, homeDir))) {
      highest = generation;
    }
  }
  return highest;
}

// Decides what run-role.js should do (Req 1b, 5a):
//   - Normal launch: resume the highest existing generation, or launch
//     fresh at generation 0 if none exists yet.
//   - --restart: always launch fresh, at (highest existing + 1) — never
//     the same ID a normal launch would resume, so the "already in use"
//     CLI behaviour flagged (and struck) in Risks is never invoked (Req
//     1c: a new session is only ever assigned a generation whose file
//     does not exist). This is also what makes the round trip in Req 5a
//     work: the next normal launch's scan sees this new generation as the
//     highest and resumes it — the restarted session sticks.
function resolveSession(roleId, repoRoot, { restart = false, homeDir = os.homedir() } = {}) {
  const highest = highestExistingGeneration(roleId, repoRoot, homeDir);

  if (!restart) {
    const generation = highest === -1 ? 0 : highest;
    return {
      resume: highest !== -1,
      sessionId: sessionId(roleId, repoRoot, generation),
    };
  }

  const nextGeneration = highest + 1;
  if (nextGeneration >= MAX_GENERATIONS) {
    // Bound exceeded — fall back to an ungoverned random ID rather than
    // reusing one or looping forever. Still RFC-valid on its own
    // (crypto.randomUUID is a v4 UUID), just no longer part of the
    // deterministic scheme: the next normal launch's bounded scan can't
    // recompute it, so this generation becomes another orphan. Same
    // "sane bound, not a hard guarantee" tradeoff Req 1b already accepts
    // — 100 restarts of one role in one repo is not a case worth
    // engineering around further.
    return { resume: false, sessionId: crypto.randomUUID() };
  }
  return { resume: false, sessionId: sessionId(roleId, repoRoot, nextGeneration) };
}

module.exports = {
  sessionId,
  sessionsDir,
  sessionFilePath,
  highestExistingGeneration,
  resolveSession,
  MAX_GENERATIONS,
};
