#!/usr/bin/env node
'use strict';
// Sprint 42, Req 1: a headless gate role (QA1, LiveQA) needs a sanctioned
// way to commit exactly the one file CLAUDE.md's own bookkeeping-commit
// rule (sprint 32) requires of it -- its own already-written verdict,
// `docs/sprints/state/sprint-<N>.json`, with no staging step at all,
// exactly the shape CLAUDE.md prescribes for a gate role's commit (never
// a `git add`, since staging is what makes a pathspec commit capable of
// sweeping up a concurrent session's unrelated work -- see CLAUDE.md's
// "commit shape differs by what the command actually wrote"). Sprint 41,
// Req 6b measured why this needed a real fix rather than a permission
// tweak: under `claude 2.1.278`, both `qa1` and `liveqa` can run
// read-only git (`status`/`log`/`diff`) with zero denials -- Claude
// Code's own built-in safe-read allowlist, independent of `allowedTools`
// -- while `git add` and this exact pathspec commit are both DENIED for
// both roles, regardless of grant, including for qa1 with
// `eligibleForOwnedRepositoryGrant` set. The rule was unfollowable
// headless, and it already cost a real record (FMC's Show Off run: a
// headless LiveQA round-3 PASS sat uncommitted until Dev Team happened
// to sweep it into an unrelated close commit).
//
// WHY A SIBLING SCRIPT, NOT AN EXTENSION OF mc-commit.js (Req 1's own
// instruction: "choose deliberately and say why in a comment"): the two
// wrappers enforce genuinely different boundaries, not just different
// path lists.
//   - mc-commit.js UNCONDITIONALLY stages (`git add`) before committing,
//     because Master Controller's own use case is a brand-new or amended
//     sprint FILE that may be untracked. A gate role's verdict file is
//     always already tracked (created by `/sprint-start`, committed by
//     Dev Team, long before QA1 or LiveQA ever runs) -- staging it would
//     be a real behavioral difference from what CLAUDE.md documents for
//     gate roles (Req 1b: "no git add, no staging step of any kind"),
//     not a cosmetic one.
//   - mc-commit.js's allowlist is a DIRECTORY-prefix check (anything
//     resolving inside docs/sprints/) plus two exact single-file
//     entries. This wrapper's allowlist is narrower and shaped
//     differently: exactly ONE path, matching a specific FILENAME
//     PATTERN (`sprint-<N>.json`) for a sprint id that must already be
//     real (Req 1a) -- not "any file under a directory."
//   - The owning roles and profiles differ (qa1/liveqa here, vs.
//     master-controller there); mixing the two grants into one script
//     would mean a role's own Bash pattern reaches code paths that were
//     never meant for it, purely because they happen to share a file.
// Combining these into one script would conflate two different security
// boundaries and two different commit shapes behind one CLI surface --
// worse for auditability than two small, single-purpose scripts. The
// actually-reusable pieces (the "resolve then require real === lexical"
// symlink defense, the --message/--message-file reading) are small
// enough to duplicate deliberately rather than share a module between
// two scripts with different failure/allowlist semantics -- the same
// judgment call sprint_lifecycle.py's own SHIP_HASH_EXCLUDE_PATTERNS and
// mc-commit.js's own INSTALL_FRAMEWORK_OWNED_PREFIXES already made for
// analogous "small enough to hand-keep, not worth a shared risk" cases.
//
// Usage:
//   node scripts/gate-commit.js --message "<commit message>" -- <path>
//   node scripts/gate-commit.js --message-file <path-to-file> -- <path>
//
// (--message-file preferred whenever the message might contain a
// backtick, `$`, or other shell metacharacter -- the same established
// pattern every other free-text argument in this framework uses, e.g.
// qa1.md's/liveqa.md's own --notes-file, mc-commit.js's own
// --message-file. Reading the message from a file in Node is what
// removes the quoting risk; it is not needed for shell-injection safety
// once the message reaches THIS script, since spawnSync below is called
// with an argv array, never a shell string.)
//
// Behavior: accepts EXACTLY ONE path (Req 1a: "any other path, MORE THAN
// ONE path" is refused -- a gate role commits exactly its own verdict,
// never a batch). Refuses (exit 1, prints why, runs no git command at
// all) unless that path resolves -- through the same real-path,
// symlink-resolved check mc-commit.js uses (`real !== abs` after
// fs.realpathSync means a symlink was followed somewhere and this is
// refused outright, never resolved-and-trusted) -- to EXACTLY
// `docs/sprints/state/sprint-<N>.json`, where `<N>` is a canonical
// positive integer (no leading zeros, no sign) that ALSO appears as a
// key in docs/sprints/registry.json's own `sprints` object -- Req 1a's
// "a real, existing sprint id", not merely a filename that happens to
// match the pattern. This one check, by construction, refuses every
// shape Req 1a names: a different path entirely, `..` traversal (the
// resolved real path would not equal the exact expected canonical path),
// a symlink whose target leaves the directory (refused by the
// real-vs-lexical check regardless of where it points), a prefix
// lookalike (`docs/sprints/state-evil/sprint-1.json` never matches the
// literal `docs/sprints/state/` prefix the pattern requires), an
// absolute path outside the repo (never resolves to the expected
// in-repo path), and a nonexistent sprint id (fails the registry-key
// check even if the filename pattern itself matches). If it validates:
// commits it (`git commit -m <message> -- <path>`, no `git add`, no
// second pathspec, no `-a`/`--amend`/`--all` -- there is no flag on this
// script's own CLI surface that could ever construct any of those, and
// no code path here does). Never runs `git push`. Exits non-zero with
// the real git error on any failure (e.g. the path is not actually
// tracked yet -- git's own "pathspec ... did not match any file(s)
// known to git" surfaces unmodified, exactly the signal that this
// script is NOT a substitute for `/sprint-start`'s own initial commit).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'docs', 'sprints', 'state');
const REGISTRY_PATH = path.join(ROOT, 'docs', 'sprints', 'registry.json');

// Exactly `sprint-<N>.json` where <N> is a canonical positive integer --
// no leading zeros (so "007" and "7" can never both be read as the same
// sprint by this check, matching sprint_lifecycle.py's own
// `f"sprint-{sprint_id}.json"`, which int formatting never produces with
// a leading zero), no sign, digits only.
const STATE_FILENAME_RE = /^sprint-([1-9][0-9]*)\.json$/;

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { message: null, messageFile: null, paths: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--message') {
      opts.message = argv[++i];
    } else if (a === '--message-file') {
      opts.messageFile = argv[++i];
    } else if (a === '--') {
      opts.paths = argv.slice(i + 1);
      break;
    } else {
      die(`Unrecognized argument '${a}'. Usage: node scripts/gate-commit.js --message "<msg>" -- <path>`);
    }
  }
  return opts;
}

// Returns the set of sprint ids (strings) with a registry entry, or an
// empty set if the registry is missing/unparsable -- never throws, since
// a corrupt or absent registry should mean "no id validates," not a
// crash that could be mistaken for something else.
function registrySprintIds() {
  let raw;
  try {
    raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
  } catch (e) {
    return new Set();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return new Set();
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.sprints || typeof parsed.sprints !== 'object') {
    return new Set();
  }
  return new Set(Object.keys(parsed.sprints));
}

// Resolves `p` to a real, symlink-resolved absolute path and returns it
// only if EVERY one of these holds: it resolves (lexically, before any
// symlink resolution) to exactly `docs/sprints/state/sprint-<N>.json`
// for a canonical <N>; no symlink was followed anywhere along the path
// (`real !== abs` after fs.realpathSync -- the identical defense
// mc-commit.js's own resolveInsideSprints()/CLAUDE.md-branch use, QA1's
// sprint-40 round-1 finding fixed there and applied here from the
// start); and <N> is a key in the registry (a real, existing sprint).
// Returns null on any refusal; the caller decides how to report it.
function resolveGateVerdictPath(p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  const abs = path.resolve(ROOT, p);
  const rel = path.relative(STATE_DIR, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
    // Not a direct child of docs/sprints/state/ at all -- covers a
    // different directory, `..` traversal, and a prefix lookalike like
    // docs/sprints/state-evil/sprint-1.json in one check (the last of
    // those has a `path.relative` result starting with `..` too, since
    // "state-evil" is not "state").
    return null;
  }
  const filename = path.basename(abs);
  const m = STATE_FILENAME_RE.exec(filename);
  if (!m) return null;
  const sprintId = m[1];

  let real = abs;
  try {
    real = fs.realpathSync(abs);
  } catch (e) {
    // Doesn't exist yet -- resolved lexically. A gate role's verdict
    // file always exists by the time this runs (sprint_lifecycle.py
    // already wrote it), so this branch is not expected in real use,
    // but is not itself a reason to refuse -- the registry check below
    // still has to pass.
    real = abs;
  }
  if (real !== abs) {
    return { refusedSymlink: true, real, abs };
  }

  if (!registrySprintIds().has(sprintId)) {
    return { refusedUnknownSprint: true, sprintId };
  }

  return { real: abs, sprintId };
}

// Sprint 46, Req 2: refuses outright, before any git write, if this
// checkout's HEAD is detached right now -- committing onto a detached
// HEAD is never something this wrapper's own callers (QA1, LiveQA)
// legitimately do, and it is the exact shape that stranded a real commit
// during sprint 44's publish: Pipeman detached the PRIMARY checkout to
// publish (so npm would stamp `gitHead` with the audited commit rather
// than main's drifted tip), and a commit made by another session in that
// same window attached to the detached commit instead of main --
// reachable from no branch at all. `git symbolic-ref -q HEAD` succeeds
// (prints the ref, e.g. refs/heads/main) only when HEAD is a real
// branch; it exits non-zero with nothing on stdout when HEAD is
// detached -- the standard, git-native way to ask this question, no
// string-parsing of `git status` output required. Req 2b: no flag or
// environment variable overrides this -- if a legitimate detached-HEAD
// commit case ever appears, that is a finding for Master Controller, not
// a switch here. Sprint 46, Req 1, is the actual fix (Pipeman now
// publishes from a dedicated worktree, never by detaching this checkout);
// this is the backstop for the paths this framework owns, not the fix
// for every way a commit can be made. Identical in shape to mc-commit.js's
// own checkNotDetachedHead() -- duplicated deliberately, the same
// established judgment call as this script's own symlink defense
// (small enough to hand-keep in each wrapper rather than share a module
// between two scripts with different failure/allowlist semantics).
function checkNotDetachedHead() {
  const symbolicResult = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }); // nosec B603 B607
  if (symbolicResult.status === 0) return; // HEAD is a real branch
  const headResult = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }); // nosec B603 B607
  const commit = headResult.status === 0 ? headResult.stdout.trim() : '(unknown commit)';
  die(
    `HEAD is detached, currently at ${commit} -- refusing to commit. Nothing has been committed. ` +
    'A publish may be in progress in this checkout (see CLAUDE.md\'s publish-isolation rule: Pipeman ' +
    'publishes from a throwaway clone, never from this checkout) -- wait for HEAD to return to a branch, ' +
    'then retry.'
  );
}

function main() {
  // Before anything else, including argument parsing -- the cheapest
  // possible fail-fast, and it means a detached-HEAD refusal is never
  // preceded by any other validation work.
  checkNotDetachedHead();
  const opts = parseArgs(process.argv.slice(2));

  let message = opts.message;
  if (opts.messageFile) {
    try {
      message = fs.readFileSync(opts.messageFile, 'utf8').trim();
    } catch (e) {
      die(`Could not read --message-file '${opts.messageFile}': ${e.message}`);
    }
  }
  if (!message || !message.trim()) {
    die('A non-empty commit message is required, via --message or --message-file.');
  }

  if (opts.paths.length === 0) {
    die('A path is required after --. Usage: node scripts/gate-commit.js --message "<msg>" -- docs/sprints/state/sprint-<N>.json');
  }
  if (opts.paths.length > 1) {
    die(
      `Exactly one path is required, got ${opts.paths.length}: ${opts.paths.join(', ')}. ` +
        'A gate role commits exactly its own verdict file, never a batch -- there is no "commit multiple" mode here.'
    );
  }

  const p = opts.paths[0];
  const resolved = resolveGateVerdictPath(p);
  if (resolved === null) {
    die(
      `'${p}' does not resolve to a path this script is allowed to commit -- exactly ` +
        `docs/sprints/state/sprint-<N>.json (${STATE_DIR}), for a real sprint id, nothing else. ` +
        'Nothing has been run.'
    );
  }
  if (resolved.refusedSymlink) {
    die(
      `'${p}' is a symlink (or sits behind one) -- resolves to ${resolved.real}, not ${resolved.abs}. ` +
        'A symlink here could point anywhere and would defeat this allowlist entirely; commit the real ' +
        'file directly, never a symlink to it. Nothing has been committed.'
    );
  }
  if (resolved.refusedUnknownSprint) {
    die(
      `'${p}' names sprint ${resolved.sprintId}, which has no entry in docs/sprints/registry.json -- ` +
        'this must be a real, existing sprint, not merely a filename matching the pattern. Nothing has been committed.'
    );
  }

  const relPath = path.relative(ROOT, resolved.real);
  // No `git add` -- deliberately. This is the entire behavioral
  // difference from mc-commit.js's own commit step (see the header
  // comment above for why): a pathspec commit with no staging step
  // commits exactly the changes to `relPath`, whether or not it happens
  // to be staged already, and fails cleanly ("pathspec ... did not
  // match any file(s) known to git") if `relPath` isn't tracked at all
  // -- which is the correct refusal here, not a bug to work around, a
  // gate role's verdict file is always already tracked by the time this
  // runs.
  const commitResult = spawnSync('git', ['commit', '-m', message, '--', relPath], { cwd: ROOT, encoding: 'utf8' }); // nosec B603 B607
  if (commitResult.status !== 0) {
    die(`git commit failed: ${(commitResult.stderr || commitResult.stdout || '').trim()}`);
  }
  process.stdout.write(commitResult.stdout || '');
  console.log(`Committed 1 path: ${relPath} (sprint ${resolved.sprintId} verdict)`);
}

main();
