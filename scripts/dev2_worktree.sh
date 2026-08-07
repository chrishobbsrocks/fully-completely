#!/usr/bin/env bash
# Create (or reuse) the dedicated git worktree Dev Team 2 builds a parallel
# sprint in, so it never shares a working tree with Dev Team 1. "Check the
# Dependencies section for overlap" is necessary but not sufficient,
# "independent" sprints on a small app routinely still touch shared files
# (routing, layout, config) even when the features themselves don't
# overlap, and two sessions editing the same checkout at once is how that
# turns into a real, uncommitted-work collision. A separate worktree on its
# own branch removes the shared-checkout risk entirely.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <sprint-id>" >&2
  exit 1
fi

SPRINT_ID="$1"
if ! [[ "$SPRINT_ID" =~ ^[0-9]+$ ]]; then
  echo "ERROR: sprint id must be a positive integer, got '$SPRINT_ID'" >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
REPO_NAME="$(basename "$REPO_ROOT")"
BRANCH="devteam2/sprint-${SPRINT_ID}"
WORKTREE_DIR="$(dirname "$REPO_ROOT")/${REPO_NAME}-devteam2-sprint-${SPRINT_ID}"

cd "$REPO_ROOT"

if [ -d "$WORKTREE_DIR" ]; then
  echo "Worktree already exists, reusing it."
elif git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  git worktree add "$WORKTREE_DIR" "$BRANCH"
else
  git worktree add -b "$BRANCH" "$WORKTREE_DIR"
fi

echo "Dev Team 2 worktree ready: ${WORKTREE_DIR}"
echo "cd into it before writing any code for sprint ${SPRINT_ID}."
