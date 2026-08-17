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

echo
echo "TARBALL VERIFICATION PASSED"
echo "  tarball:  $TARBALL_PATH"
echo "  unpacked: $UNPACKED"
echo "  target:   $TARGET"
echo "(left in place for inspection — $WORKDIR)"
