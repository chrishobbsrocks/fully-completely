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
// does not resolve strictly inside docs/sprints/ — a `..` segment, an
// absolute path elsewhere, a symlink pointing outside, or a path that
// merely shares "docs/sprints" as a string prefix without being a real
// path inside it (e.g. `docs/sprints-evil/x`) are all refused. Requires
// at least one path — there is no "commit everything" mode. If every
// path validates: stages exactly those paths (`git add -- <paths>`,
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

const ROOT = path.resolve(__dirname, '..');
const SPRINTS_ROOT = path.join(ROOT, 'docs', 'sprints');

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
    const real = resolveInsideSprints(p);
    if (real === null) {
      die(`'${p}' does not resolve to a path strictly inside docs/sprints/ (${SPRINTS_ROOT}). ` +
        'This script only ever stages/commits paths under docs/sprints/ — nothing has been run.');
    }
    resolved.push(path.relative(ROOT, real));
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
