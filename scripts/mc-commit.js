#!/usr/bin/env node
'use strict';
// Sprint 36 fix round (QA1 FAIL, round 1, Reqs 1/2/3/4 of "REQUIRED
// BEFORE PASS"): replaces the Bash-permission-pattern approach to
// scoping headless Master Controller's git-commit grant to
// docs/sprints/ — real, run probes (QA1's P2/P3, reproduced) showed it
// cannot express that boundary at all:
//
//   - `Bash(git commit -m *)`'s own trailing wildcard covers a PATHSPEC
//     argument exactly as readily as it covers the commit message —
//     `git commit -m "tool tweak" scripts/tool.js` matched it and
//     committed a file entirely outside docs/sprints/, with zero
//     permission denials.
//   - `Bash(git add docs/sprints/*)` has the identical gap the moment a
//     SECOND pathspec is appended after the first (`git add
//     docs/sprints/x.md scripts/tool.js` — the whole line still starts
//     with the allowed prefix).
//
// Prefix-then-wildcard matching can express "the command line starts
// with X"; it structurally cannot express "contains ONLY X and nothing
// appended after it" for a command whose own syntax accepts an
// arbitrary number of trailing arguments — git add and git commit both
// do. No pattern in `HEADLESS_PERMISSION_PROFILES['master-controller']`
// (however many `-a`/`-A`/`--all` variants it disallows) closes this,
// because the vulnerable argument is a second PATH, not a flag.
//
// THE FIX moves enforcement out of the permission-pattern layer
// entirely and into real code — the same shape this project already
// uses for every other git-touching lifecycle action, except
// `scripts/sprint_lifecycle.py` is contractually forbidden from ever
// calling `git add`/`git commit` itself (CLAUDE.md's "Changes to this
// repo's own tooling"; the smoke test's own zero-git-calls assertion
// greps that exact file for it), so this is a SEPARATE wrapper script.
// Master Controller's headless profile grants Bash access to invoke
// THIS SCRIPT (`Bash(node scripts/mc-commit.js *)`) and nothing raw
// `git` at all — every path given to it is validated in real Node code
// (path.resolve + a strict, symlink-resolved prefix check against
// docs/sprints/) before anything ever reaches git, and this script's own
// CLI surface has no flag or argument that could ask it to run `git
// push`, `git commit -a`/`-am`, or `git add -A`/`.` — there is no code
// path here that constructs any of those. That is a mechanically
// testable property of THIS FILE (unit tested in launcher_test.js), not
// a permission-string heuristic graded UNESTABLISHED the way the
// Bash-pattern approach was.
//
// Usage:
//   node scripts/mc-commit.js --message "<commit message>" -- <path> [<path> ...]
//   node scripts/mc-commit.js --message-file <path-to-file> -- <path> [<path> ...]
//
// (--message-file preferred whenever the message might contain a
// backtick, `$`, or other shell metacharacter this file's own CLI
// invocation would otherwise have to quote correctly — the same
// established pattern every other free-text argument in this framework
// uses, e.g. qa1.md's own --notes-file. Reading the message from a file
// in Node, rather than as a Bash-quoted argument, is what removes the
// quoting risk; it is not needed for shell-injection safety once the
// message reaches THIS script, since spawnSync below is called with an
// argv array, never a shell string.)
//
// Behavior: resolves each given <path> against the repository root and
// refuses (exit 1, prints why, runs no git command at all) if ANY path
// does not resolve to exactly one of three allowlisted things (sprint 40,
// Req 2 widened this from docs/sprints/ alone): strictly inside
// docs/sprints/ (unchanged default — a `..` segment, an absolute path
// elsewhere, a symlink pointing outside, or a path that merely shares
// "docs/sprints" as a string prefix without being a real path inside it,
// e.g. `docs/sprints-evil/x`, are all still refused); CLAUDE.md itself,
// an exact single-file match, never a directory; or the project's own
// declared-or-default decisions log (also an exact single-file match,
// validated fresh on every run — see validateDecisionsLogDeclaration()
// below for exactly what that checks and refuses). Requires at least one
// path — there is no "commit everything" mode. If every path validates:
// stages exactly those paths (`git add -- <paths>`,
// needed because a brand-new sprint file is untracked and a pathspec
// commit alone does not stage an untracked path — confirmed directly:
// `git commit <new-path> -m msg` fails with "pathspec ... did not match
// any file(s) known to git" until `git add` runs first), then commits
// exactly those paths (`git commit -m <message> -- <paths>`, a real
// pathspec commit, nothing implicit, nothing else touched). Never runs
// `git push`. Exits non-zero with the real git error on any failure.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseJsonc } = require('./launcher/jsonc');

const ROOT = path.resolve(__dirname, '..');
const SPRINTS_ROOT = path.join(ROOT, 'docs', 'sprints');

// Sprint 40, Req 2: two additional single-file paths Master Controller may
// commit, outside docs/sprints/ -- CLAUDE.md's own real content, sprint 36
// established, and a project's own decisions log (Finding 10: ShowOffTest's
// mc-decisions.md sat uncommitted after mc-commit.js correctly refused it,
// exactly the state this whole wrapper exists to prevent). Each is checked
// by EXACT match against a resolved single file, never a directory prefix
// the way docs/sprints/ is -- Req 2a's own explicit instruction.
const CLAUDE_MD_REL = 'CLAUDE.md';

// Sprint 40, Req 2b: the standard default when a project declares nothing
// -- settled with FMC's own Master Controller (see this sprint's own
// Context): the path belongs to the PROJECT, not this framework, so this
// is a fallback, never something Req 2c's "no escape hatch" rule treats as
// authoritative over a real declaration.
const DEFAULT_DECISIONS_LOG_PATH = 'docs/decisions.md';

// Sprint 40, Req 2b: copied from install.js's own FRAMEWORK_OWNED list --
// paths this framework's installer itself writes and manages on every
// upgrade. A project declaring one of these AS its decisions log would
// have that log silently overwritten or removed the next time it upgrades,
// which is exactly the failure Req 2b's "not any path the install
// manifest owns" check exists to refuse before it happens. NOT required
// (or safe) to `require('./install.js')` directly for this list: that
// file runs real, cwd-comparing side-effecting code at module load time
// (it exits immediately if invoked from inside this repo's own source
// checkout, which mc-commit.js legitimately is when this repo's own
// Master Controller uses it) -- so this is a deliberate, named duplicate,
// kept in sync by hand, the same established shape
// SHIP_HASH_EXCLUDE_PATTERNS in sprint_lifecycle.py already uses for an
// analogous "can't safely import the real list, so copy it with a comment
// saying so" case. If install.js's own FRAMEWORK_OWNED list changes, this
// one has to change with it by hand, and nothing will warn if it doesn't.
const INSTALL_FRAMEWORK_OWNED_PREFIXES = [
  '.claude/commands',
  'scripts/sprint_lifecycle.py',
  'scripts/run-lifecycle.js',
  'scripts/mc-commit.js',
  'scripts/smoke_test.sh',
  'scripts/dev2_worktree.sh',
  'scripts/worktree_test.sh',
  'scripts/launcher',
  'scripts/install.js',
  'templates/sprint-template.md',
  'docs/HUMAN_OVERRIDE.md',
];

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
      die(`Unrecognized argument '${a}'. Usage: node scripts/mc-commit.js --message "<msg>" -- <path> [<path> ...]`);
    }
  }
  return opts;
}

// Resolves `p` (as given, relative to ROOT the same way every path this
// framework passes around already is, e.g. "docs/sprints/state/sprint-
// 36.json") to a real, symlink-resolved absolute path, and returns it
// only if that real path sits strictly inside docs/sprints/. Returns
// null on any refusal — the caller decides how to report it. A path
// that does not exist yet is resolved lexically (fs.realpathSync only
// works on something already on disk) — still checked against the same
// prefix, so a not-yet-existing path outside docs/sprints/ is refused
// exactly like an existing one would be.
function resolveInsideSprints(p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  const abs = path.resolve(ROOT, p);
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch (e) {
    real = abs;
  }
  const relToSprintsRoot = path.relative(SPRINTS_ROOT, real);
  // path.relative starting with '..' or being absolute (Windows drive
  // change) means `real` is NOT inside SPRINTS_ROOT. An empty string
  // would mean `real === SPRINTS_ROOT` itself (the directory, not a file
  // inside it) — also refused, there is nothing to commit at the
  // directory itself.
  if (relToSprintsRoot === '' || relToSprintsRoot.startsWith('..') || path.isAbsolute(relToSprintsRoot)) {
    return null;
  }
  return real;
}

// True if `abs` (already an absolute, resolved path) sits at or inside
// `prefixRel` (a path relative to ROOT) — the same relative-path
// containment test resolveInsideSprints() above already uses, generalized
// to an arbitrary prefix so it can check both the framework-owned list
// and (for the decisions-log check below) the repository root and .git/
// itself, without three near-identical copies of the same three-line test.
function isInsidePrefix(abs, prefixRel) {
  const prefixAbs = path.resolve(ROOT, prefixRel);
  const rel = path.relative(prefixAbs, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Sprint 40, Req 2b: reads exactly the way sprint 17's readDeclaredTestCommand()
// (scripts/launcher/run-role.js) reads the project's declared test command
// -- same file, same JSONC parsing, same "anything short of a real,
// non-empty declared string means not declared" default. Returns null
// (never declared, or declared invalid-shape) rather than guessing.
function readDeclaredDecisionsLogPath(root) {
  const settingsPath = path.join(root, '.vscode', 'settings.json');
  let raw;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch (e) {
    return null;
  }
  let parsed;
  try {
    parsed = parseJsonc(raw);
  } catch (e) {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const value = parsed['fullyCompletely.mcDecisionsLog'];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Sprint 40, Req 2b: the pure validator -- same "validated, never
// sanitised" shape run-role.js's own validateOwnedRepositoryDeclaration()
// established, returning a verdict rather than exiting, so it stays
// directly unit-testable. Checked, in order: not empty; not glob/list-
// shaped (a single real path never legitimately contains *, ?, [, ], a
// comma, or a newline); resolves inside the repository; does not resolve
// inside .git/; does not resolve inside any INSTALL_FRAMEWORK_OWNED_PREFIXES
// entry; and, if it already exists on disk, is a regular file, not a
// directory. A path that does not exist YET is accepted (same "resolved
// lexically" precedent resolveInsideSprints() above already sets) -- Master
// Controller may be about to create the decisions log for the first time.
function validateDecisionsLogDeclaration(declaredOrDefault, root) {
  if (typeof declaredOrDefault !== 'string' || !declaredOrDefault.trim()) {
    return { valid: false, reason: 'the path is empty' };
  }
  const value = declaredOrDefault.trim();
  if (/[*?[\]]/.test(value) || /[,\n;]/.test(value)) {
    return { valid: false, reason: `"${value}" looks like a glob or a list of multiple paths (contains *, ?, [, ], a comma, semicolon, or newline) -- the decisions log must be exactly one real file, named directly` };
  }
  if (path.isAbsolute(value)) {
    return { valid: false, reason: `"${value}" is an absolute path -- declare it relative to the repository root instead` };
  }

  const abs = path.resolve(root, value);
  if (!isInsidePrefix(abs, '.') || path.relative(root, abs) === '') {
    return { valid: false, reason: `"${value}" does not resolve to a file inside the repository (${root})` };
  }
  if (isInsidePrefix(abs, '.git')) {
    return { valid: false, reason: `"${value}" resolves inside .git/ (${abs}) -- this framework never commits anything there` };
  }
  for (const owned of INSTALL_FRAMEWORK_OWNED_PREFIXES) {
    if (isInsidePrefix(abs, owned)) {
      return {
        valid: false,
        reason: `"${value}" resolves inside "${owned}", which this framework's own installer manages on every ` +
          'upgrade -- a decisions log placed there would be silently overwritten or removed the next time this ' +
          'project upgrades. Declare a path this framework does not own',
      };
    }
  }
  let real = abs;
  try {
    real = fs.realpathSync(abs);
  } catch (e) {
    // Doesn't exist yet -- fine, resolved lexically, same as
    // resolveInsideSprints() above.
  }
  if (fs.existsSync(real)) {
    let st = null;
    try {
      st = fs.statSync(real);
    } catch (e) {
      st = null;
    }
    if (st && !st.isFile()) {
      return { valid: false, reason: `"${value}" (${real}) exists but is not a regular file (a directory?) -- the decisions log must be exactly one file` };
    }
  }
  return { valid: true, real };
}

// The thin wrapper: resolves what the declared-or-default decisions-log
// path WOULD be, structurally (no validation yet, so this alone never
// dies) -- used by resolveOwnedPath() below to cheaply decide whether a
// GIVEN commit path is even a candidate for "the decisions log" before
// paying the cost (and the risk of an unrelated commit being refused for
// the wrong reason) of fully validating a declaration nobody asked to use
// this run.
function decisionsLogCandidateAbs(root) {
  const declared = readDeclaredDecisionsLogPath(root);
  return path.resolve(root, declared !== null ? declared : DEFAULT_DECISIONS_LOG_PATH);
}

// Sprint 40, Req 2: the generalized allowlist check -- tries, in order,
// docs/sprints/ (Req 2a's own unchanged default), then CLAUDE.md (Req 2a's
// fixed entry), then the declared-or-default decisions log (Req 2b), each
// an EXACT single-file match, never a directory wildcard for the two new
// entries. Returns { real, owner } on a match, or null. The decisions-log
// branch is the only one that can ever die() with a validation reason —
// and only when the GIVEN path actually resolves to that candidate slot,
// so an unrelated, simply-not-allowlisted path (e.g. scripts/tool.js)
// is never misreported as "the decisions log is misconfigured" just
// because a project's declaration happens to be broken.
function resolveOwnedPath(p) {
  const real = resolveInsideSprints(p);
  if (real !== null) return { real, owner: 'docs/sprints/' };

  const abs = path.resolve(ROOT, p);
  const claudeMdAbs = path.resolve(ROOT, CLAUDE_MD_REL);
  if (abs === claudeMdAbs) {
    let realClaudeMd = abs;
    try {
      realClaudeMd = fs.realpathSync(abs);
    } catch (e) {
      // Doesn't exist yet -- every real project installing this framework
      // has one, but refusing a not-yet-existing CLAUDE.md here would be
      // stricter than resolveInsideSprints() itself is for docs/sprints/.
    }
    return { real: realClaudeMd, owner: CLAUDE_MD_REL };
  }

  if (abs === decisionsLogCandidateAbs(ROOT)) {
    const declared = readDeclaredDecisionsLogPath(ROOT);
    const result = validateDecisionsLogDeclaration(declared !== null ? declared : DEFAULT_DECISIONS_LOG_PATH, ROOT);
    if (!result.valid) {
      const source = declared !== null
        ? `the declared "fullyCompletely.mcDecisionsLog" (${JSON.stringify(declared)})`
        : `this framework's own default decisions-log path (${JSON.stringify(DEFAULT_DECISIONS_LOG_PATH)})`;
      die(`${source} failed validation: ${result.reason}. ` +
        (declared !== null
          ? 'Fix "fullyCompletely.mcDecisionsLog" in .vscode/settings.json, or remove it to use the default.'
          : 'This is a framework defect, not a project misconfiguration — report it.') +
        ' Nothing has been committed.');
    }
    return { real: result.real, owner: 'the declared decisions log' };
  }

  return null;
}

function main() {
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
    die('At least one path is required after --. There is no "commit everything" mode — name exactly the path(s) this run wrote or amended.');
  }

  const resolved = [];
  for (const p of opts.paths) {
    const match = resolveOwnedPath(p);
    if (match === null) {
      die(`'${p}' does not resolve to a path this script is allowed to commit -- exactly ` +
        `docs/sprints/ (${SPRINTS_ROOT}), ${CLAUDE_MD_REL}, or the declared/default decisions log ` +
        `(${DEFAULT_DECISIONS_LOG_PATH} unless "fullyCompletely.mcDecisionsLog" declares another). ` +
        'Nothing has been run.');
    }
    resolved.push(path.relative(ROOT, match.real));
  }

  const addResult = spawnSync('git', ['add', '--', ...resolved], { cwd: ROOT, encoding: 'utf8' }); // nosec B603 B607
  if (addResult.status !== 0) {
    die(`git add failed: ${(addResult.stderr || addResult.stdout || '').trim()}`);
  }

  const commitResult = spawnSync('git', ['commit', '-m', message, '--', ...resolved], { cwd: ROOT, encoding: 'utf8' }); // nosec B603 B607
  if (commitResult.status !== 0) {
    die(`git commit failed: ${(commitResult.stderr || commitResult.stdout || '').trim()}`);
  }
  process.stdout.write(commitResult.stdout || '');
  console.log(`Committed ${resolved.length} path(s) under docs/sprints/: ${resolved.join(', ')}`);
}

main();
