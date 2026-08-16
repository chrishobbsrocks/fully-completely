'use strict';
// Short, generic first messages the launcher sends when it opens or resumes
// a role's session. These are launch-time user turns, not part of any
// agent's own persona file under .claude/agents/ — that wording is never
// touched here.

function initialPrompt(roleLabel) {
  return (
    `You are now running as ${roleLabel} for this project. Before anything ` +
    `else, check docs/sprints/registry.json (and docs/sprints/state/ for ` +
    `any sprint listed there) to see what's currently in flight, then wait ` +
    `for instructions.`
  );
}

// Dev Team 2 is the one role whose working directory can legitimately move
// mid-sprint (into ../<repo>-devteam2-sprint-<id>, see /sprint-worktree).
// The launcher itself never scans for or cds into that worktree — on
// resume it always reopens Dev Team 2 in the project root and hands it
// this extra instruction so the agent checks for and returns to an active
// worktree itself.
function devTeam2ResumePrompt(repoName) {
  // No literal " characters anywhere in this string, on purpose — this is
  // the one launch-time prompt sent on Windows via cmd.exe /c, and cmd.exe's
  // own tokenizer runs before the target's argv parsing. The array-based
  // spawn (see run-role.js) should quote this correctly regardless, but a
  // prompt with zero quote characters to get wrong is cheaper than being
  // right about it, especially untested on a real Windows machine.
  return (
    `Before continuing, check docs/sprints/registry.json for a sprint ` +
    `currently assigned to you (Dev Team 2) with status in_progress. If ` +
    `one exists, check whether ../${repoName}-devteam2-sprint-<id> exists ` +
    `(substituting the real sprint id) and cd into it now, before doing ` +
    `anything else. If no such sprint or worktree exists, stay here in the ` +
    `project root.`
  );
}

module.exports = { initialPrompt, devTeam2ResumePrompt };
