#!/usr/bin/env bash
# Sprint 2, Req 7: verifies the exact artifact `npm pack`/`npx` would
# deliver, before anything is published. `npm pack` produces the real
# tarball; this installs FROM that tarball into a throwaway target
# directory (never this repo) and checks the result two ways:
#   1. The installed launcher files are byte-identical to this repo's own
#      current source — catching any packaging drift (a stale .npmignore
#      exclusion, an entry missing from install.js's own copy lists, etc.)
#      that a plain source-tree check would never see, since it only ever
#      looks at what's actually inside the packed tarball.
#   2. This repo's own live sprint data (docs/sprints/registry.json,
#      docs/sprints/state/*.json, any phase-folder sprint .md file) is NOT
#      present in the tarball — the leak sprint 2 found and fixed via
#      .npmignore. Only .gitkeep placeholders should ship.
#
# Run from anywhere; resolves the repo root itself:
#   scripts/verify-tarball.sh
#
# Exits non-zero on the first check that fails, leaving the tarball and
# temp directories in place for inspection (reported on the way out) —
# unlike the automated test suite, a failure here is something a human is
# about to act on (Pipeman, before publishing), so it's worth being able
# to look at exactly what was produced.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

fail() { echo "TARBALL VERIFICATION FAILED: $1" >&2; exit 1; }

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/fully-completely-tarball-verify.XXXXXX")"
TARGET="$WORKDIR/target-project"
mkdir -p "$TARGET"

echo "== packing the real tarball (npm pack) =="
TARBALL_NAME="$(cd "$WORKDIR" && npm pack "$REPO_ROOT" --silent)"
TARBALL_PATH="$WORKDIR/$TARBALL_NAME"
[ -f "$TARBALL_PATH" ] || fail "npm pack did not produce $TARBALL_PATH"
echo "  $TARBALL_PATH"

echo "== extracting the tarball (this is what npx actually unpacks) =="
tar -xzf "$TARBALL_PATH" -C "$WORKDIR"
UNPACKED="$WORKDIR/package"
[ -d "$UNPACKED" ] || fail "expected an unpacked 'package/' directory, found none"

echo "== running the tarball's own install.js against a throwaway target =="
(cd "$TARGET" && node "$UNPACKED/scripts/install.js") || fail "install.js (from the tarball) exited non-zero"
[ -f "$TARGET/scripts/launcher/run-role.js" ] || fail "run-role.js did not land in the target project"

echo "== launcher files: tarball-installed vs. this repo's live source =="
DIFF_FOUND=0
while IFS= read -r -d '' f; do
  rel="${f#"$REPO_ROOT"/scripts/launcher/}"
  installed="$TARGET/scripts/launcher/$rel"
  if [ ! -f "$installed" ]; then
    echo "  MISSING in installed target: scripts/launcher/$rel"
    DIFF_FOUND=1
    continue
  fi
  if ! diff -q "$f" "$installed" >/dev/null 2>&1; then
    echo "  DIFFERS: scripts/launcher/$rel"
    DIFF_FOUND=1
  fi
done < <(find "$REPO_ROOT/scripts/launcher" -type f -print0)
[ "$DIFF_FOUND" -eq 0 ] || fail "the tarball-installed launcher does not match this repo's source — see DIFFERS/MISSING lines above"
echo "  match"

echo "== confirming this repo's own sprint data did not leak into the tarball =="
LEAK_FOUND=0
if [ -f "$UNPACKED/docs/sprints/registry.json" ]; then
  echo "  LEAK: docs/sprints/registry.json is in the tarball"
  LEAK_FOUND=1
fi
while IFS= read -r -d '' f; do
  echo "  LEAK: ${f#"$UNPACKED"/} is in the tarball"
  LEAK_FOUND=1
done < <(find "$UNPACKED/docs/sprints" -type f \( -name '*.json' -o -name '*.md' \) ! -name '.gitkeep' -print0 2>/dev/null)
[ "$LEAK_FOUND" -eq 0 ] || fail "this repo's own sprint content is present in the tarball — check .npmignore"
echo "  clean — only .gitkeep placeholders present"

# Sprint 22, Req 3: a narrow, mechanical disclosure check, not a general
# secret-scanner -- "do not attempt one" is the requirement's own
# instruction, and a check that claims to catch every disclosure class
# gives false comfort worse than no check at all. This checks exactly one
# thing: does any shipped file contain the literal $HOME path of whoever
# is running this script, right now, on this machine? That's motivated by
# a real finding, not a guess -- sprint 22's own disclosure sweep
# (docs/sprint-22-disclosure-sweep.md, not shipped, see .npmignore) found
# a test fixture hardcoding the author's real local absolute path
# (revealing their actual OS username, distinct from their public name)
# instead of the placeholder every neighbouring test in that file
# correctly uses. $HOME is a real, verifiable fact about this machine at
# verify-tarball.sh's own run time, not a guessed pattern -- a match here
# means a real local path leaked in, never a false positive on a
# deliberate placeholder like /Users/x/proj (already used correctly
# throughout this codebase's own tests). This only actually catches the
# leak on the machine that produced it, which is exactly when it matters:
# this class of leak happens when a developer runs a test locally, sees a
# real path in the output, and pastes it into a fixture -- it will not
# reproduce with a generic $HOME on a CI runner, which is why this lives
# here (Pipeman's own local pre-publish check) rather than in CI.
#
# What this does NOT catch, named rather than assumed away, because none
# of these have a reliable, narrow, mechanical check: a real person's
# name, a client or project identifier (sprint 22's own second finding,
# "Fifty Mission Cap" in scripts/launcher/run-role.js, is exactly this
# shape and this check cannot see it), an email address beyond an
# obviously-reserved domain, an internal URL, a key or token, or any
# machine's home directory other than this one. Those stay a human-review
# question for the next disclosure sweep, same as this one.
echo "== confirming no shipped file contains this machine's own home directory path (sprint 22) =="
if [ -n "${HOME:-}" ] && [ "$HOME" != "/" ]; then
  HOME_LEAK_FOUND=0
  while IFS= read -r -d '' f; do
    if grep -qF "$HOME" "$f" 2>/dev/null; then
      echo "  LEAK: ${f#"$UNPACKED"/} contains this machine's home directory path ($HOME)"
      HOME_LEAK_FOUND=1
    fi
  done < <(find "$UNPACKED" -type f -print0)
  [ "$HOME_LEAK_FOUND" -eq 0 ] || fail "a shipped file contains this machine's own home directory path — see LEAK line(s) above; very likely a hardcoded local path that should be a placeholder instead, same shape as sprint 22's own finding"
  echo "  clean"
else
  echo "  SKIP: \$HOME is unset or '/' — nothing meaningful to check against"
fi

echo "== confirming scripts/baselines/user-owned-content.json shipped (sprint 8) =="
BASELINES_IN_TARBALL="$UNPACKED/scripts/baselines/user-owned-content.json"
[ -f "$BASELINES_IN_TARBALL" ] || fail "scripts/baselines/user-owned-content.json is missing from the tarball — excluded here, the baseline mechanism ships and silently does nothing"
BASELINE_PATH_COUNT="$(node -e "
  const data = require('$BASELINES_IN_TARBALL');
  const paths = data && data.files && typeof data.files === 'object' ? Object.keys(data.files) : [];
  if (paths.length === 0) { console.error(0); process.exit(1); }
  console.log(paths.length);
")" || fail "scripts/baselines/user-owned-content.json in the tarball is not well-formed or has no path entries"
echo "  present, $BASELINE_PATH_COUNT path(s) covered"

echo "== confirming the baseline table itself is current, not just present (sprint 16) =="
# Run from the UNPACKED tarball's own copy, not this repo's live source --
# same reasoning as the launcher-file diff check above: this verifies what
# actually ships, and check-staleness.js resolves both generate.js and the
# table it reads relative to its own location, so running the tarball's
# copy exercises the tarball's copy end to end.
node "$UNPACKED/scripts/baselines/check-staleness.js" || \
  fail "scripts/baselines/user-owned-content.json is stale -- see the message above for which version(s) are missing"

echo
echo "TARBALL VERIFICATION PASSED"
echo "  tarball:  $TARBALL_PATH"
echo "  unpacked: $UNPACKED"
echo "  target:   $TARGET"
echo "(left in place for inspection — $WORKDIR)"
