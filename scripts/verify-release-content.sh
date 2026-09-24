#!/usr/bin/env bash
# Sprint 47, Req 1c: the runnable form of the standing provenance check
# liveqa.md now documents as the primary proof of what a published
# release actually contains -- content comparison, not gitHead metadata
# (see liveqa.md's own Provenance section for the full reasoning: npm's
# gitHead attests what git said at one instant, and can be silently
# absent -- sprint 46's own 0.2.22 shipped with none at all, from a
# linked-worktree publish -- while content comparison proves what the
# tarball ACTUALLY is, directly, regardless of what the metadata says).
# This is sprint 13's own recommendation, made runnable: "that is a
# stronger proof than the metadata it replaced, and it should be the
# documented path rather than an improvisation each time" -- LiveQA had
# improvised this exact comparison by hand at least three times before
# this script existed.
#
# Different from verify-tarball.sh, which packs and checks THIS repo's
# own LOCAL source tree before anything is ever published (a pre-publish
# check, Pipeman's own, against a tarball that was never uploaded
# anywhere). This script checks a PUBLISHED release already on the
# registry, against a given commit -- LiveQA's own post-publish
# provenance check -- and takes the package name as an argument rather
# than assuming fully-completely's own, since LiveQA's job is to verify
# whatever package a project installing this framework ships.
#
# Usage:
#   scripts/verify-release-content.sh <package-name> <version> <commit>
#
# Downloads the real published tarball (npm pack <pkg>@<version>, the
# same command a real install effectively runs), independently
# recomputes its own SHA-1 and compares it against the registry's own
# recorded dist.shasum (never trusts npm's own internal check silently),
# extracts it, and byte-compares every file inside against
# `git show <commit>:<path>` run from THIS checkout. Reports three
# counts -- MATCHED, MISMATCHED, NOT-IN-COMMIT -- the same shape this
# project's own verdicts have already been reporting by hand since
# sprint 13. Neither count answers the other question a mismatched
# `gitHead` alone could (Req 1b): content comparison cannot detect a
# release published from the WRONG commit whose content happens to
# match anyway; only gitHead (or an independent audit-trail check) can.
#
# gitHead is reported too, for corroboration (Req 1a: demoted, not
# removed) -- its absence or mismatch is printed plainly but NEVER fails
# this script on its own; only the content comparison and the tarball's
# own shasum check decide pass/fail. That asymmetry is deliberate: this
# script's one job is proving what the tarball IS, not re-litigating
# what Pipeman's own publish-time gitHead check (pipeman.md step 10.3,
# unchanged by this sprint) already covers.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <package-name> <version> <commit>" >&2
  exit 2
fi
PKG="$1"
VERSION="$2"
COMMIT="$3"

# REPO_ROOT is normally this script's own repo -- LiveQA runs this from a
# real checkout of the project being verified. The override below exists
# only so smoke_test.sh (Req 5) can point this script at a throwaway
# sandbox git repo instead, to test the byte-comparison logic against a
# planted commit without touching this repo's own real history. Never set
# by a real verification run.
REPO_ROOT="${VERIFY_RELEASE_CONTENT_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$REPO_ROOT"

fail() { echo "RELEASE CONTENT VERIFICATION FAILED: $1" >&2; exit 1; }

git rev-parse --verify "${COMMIT}^{commit}" > /dev/null 2>&1 || \
  fail "'$COMMIT' does not resolve to a real commit in this checkout -- fetch it first if it isn't local yet"
RESOLVED_COMMIT="$(git rev-parse "$COMMIT")"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/fully-completely-release-verify.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT

echo "== provenance: $PKG@$VERSION against commit $RESOLVED_COMMIT =="

echo "== gitHead (corroboration only -- Req 1a: reported, never decides pass/fail on its own) =="
REGISTRY_GITHEAD="$(npm view "${PKG}@${VERSION}" gitHead 2>/dev/null || true)"
if [ -z "$REGISTRY_GITHEAD" ]; then
  echo "  ABSENT -- the registry has no gitHead recorded for this version (this is exactly sprint 46's own 0.2.22 failure mode -- not a reason to fail this script, but reported plainly; content comparison below is what still proves the artifact)"
elif [ "$REGISTRY_GITHEAD" = "$RESOLVED_COMMIT" ]; then
  echo "  present and matches: $REGISTRY_GITHEAD"
else
  echo "  present but DOES NOT MATCH -- registry says $REGISTRY_GITHEAD, expected $RESOLVED_COMMIT -- reported, not failed on its own (content comparison below is what actually decides this run)"
fi

echo "== downloading the real published tarball (npm pack $PKG@$VERSION) =="
TARBALL_NAME="$(cd "$WORKDIR" && npm pack "${PKG}@${VERSION}" --silent)"
TARBALL_PATH="$WORKDIR/$TARBALL_NAME"
[ -f "$TARBALL_PATH" ] || fail "npm pack did not produce $TARBALL_PATH"
echo "  $TARBALL_PATH"

echo "== recomputing the tarball's own SHA-1, independently of npm's own internal check =="
LOCAL_SHASUM="$(shasum "$TARBALL_PATH" | awk '{print $1}')"
REGISTRY_SHASUM="$(npm view "${PKG}@${VERSION}" dist.shasum 2>/dev/null || true)"
[ -n "$REGISTRY_SHASUM" ] || fail "the registry has no dist.shasum recorded for $PKG@$VERSION at all -- cannot verify"
[ "$LOCAL_SHASUM" = "$REGISTRY_SHASUM" ] || \
  fail "the downloaded tarball's own SHA-1 ($LOCAL_SHASUM) does not match the registry's recorded dist.shasum ($REGISTRY_SHASUM) -- the download itself is suspect, stop"
echo "  matches: $LOCAL_SHASUM"

echo "== extracting the tarball =="
tar -xzf "$TARBALL_PATH" -C "$WORKDIR"
UNPACKED="$WORKDIR/package"
[ -d "$UNPACKED" ] || fail "expected an unpacked 'package/' directory, found none"

echo "== byte-comparing every published file against git show ${RESOLVED_COMMIT}:<path> =="
MATCHED=0
MISMATCHED=0
NOT_IN_COMMIT=0
while IFS= read -r -d '' f; do
  rel="${f#"$UNPACKED"/}"
  if git show "${RESOLVED_COMMIT}:${rel}" > "$WORKDIR/.committed_copy" 2>/dev/null; then
    if diff -q "$f" "$WORKDIR/.committed_copy" > /dev/null 2>&1; then
      MATCHED=$((MATCHED + 1))
    else
      MISMATCHED=$((MISMATCHED + 1))
      echo "  MISMATCHED: $rel"
    fi
  else
    NOT_IN_COMMIT=$((NOT_IN_COMMIT + 1))
    echo "  NOT-IN-COMMIT: $rel"
  fi
done < <(find "$UNPACKED" -type f -print0)
rm -f "$WORKDIR/.committed_copy"

echo
echo "MATCHED: $MATCHED"
echo "MISMATCHED: $MISMATCHED"
echo "NOT-IN-COMMIT: $NOT_IN_COMMIT"

if [ "$MISMATCHED" -ne 0 ] || [ "$NOT_IN_COMMIT" -ne 0 ]; then
  fail "content comparison found real drift -- see MISMATCHED/NOT-IN-COMMIT lines above. This is the proof that matters (Req 1); gitHead alone would not have caught every shape of this."
fi

echo
echo "RELEASE CONTENT VERIFICATION PASSED"
echo "  $MATCHED file(s) byte-identical to git show ${RESOLVED_COMMIT}:<path>, 0 mismatched, 0 not-in-commit"
