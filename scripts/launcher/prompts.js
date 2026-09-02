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

// Sprint 11, Req 5 — the sprint's own deliverable. Discovered by actually
// running each of the six roles headless, through one throwaway sprint
// driven through both gates in a scratch git-init directory (never this
// repo), not composed from a desk. What came back matches what the sprint
// file predicted: the fixed scaffold below is nearly all of it, identical
// across every role. The only thing that varies per role is HEADLESS_POINTERS
// — what to point at, never what to explain. No verdict, note, requirement
// or phase history is ever composed into this text; all of that stays on
// disk, read by the role itself, exactly as Req 5 requires.
//
// No literal " characters anywhere in either function below, same
// discipline as devTeam2ResumePrompt() above and for the same reason: this
// is a single argv element passed through cmd.exe /c on Windows, and a
// prompt with zero quote characters to get wrong is cheaper than being
// right about it.
function headlessScaffold(roleLabel, sprintId) {
  return (
    `You are running headless as ${roleLabel}, unattended, for sprint ${sprintId}. Nobody is at ` +
    `a terminal and nobody will answer a question — if you get blocked, record that (through the ` +
    `relevant slash command for your role, backed by scripts/sprint_lifecycle.py) and stop; do not ` +
    `wait for a reply that will never come.\n\n` +
    `Read docs/sprints/registry.json for sprint ${sprintId}'s current file and phase, then read ` +
    `that sprint file directly, and docs/sprints/state/sprint-${sprintId}.json if it already ` +
    `exists — both are on disk and current. This message does not restate anything from either.`
  );
}

const HEADLESS_POINTERS = {
  'master-controller':
    'Point: docs/sprints/registry.json for what is already in flight, and templates/sprint-template.md ' +
    'if you are defining sprint {sprintId} for the first time. You plan and read status; you do not run ' +
    'lifecycle transition commands yourself.',
  'dev-team-1':
    "Point: the sprint file's Requirements and Acceptance Criteria sections, and any QA1 or LiveQA " +
    "rounds already recorded in the state file's history.",
  'dev-team-2':
    "Point: the sprint file's Requirements and Acceptance Criteria sections, and any QA1 or LiveQA " +
    "rounds already recorded in the state file's history.",
  qa1:
    "Point: the sprint file's Requirements and Acceptance Criteria sections, and the commit you are " +
    'auditing.',
  pipeman:
    "Point: the state file's most recent QA1 PASS entry and the commit it recorded as audited.",
  liveqa:
    "Point: the state file's most recent Pipeman ship record, and the sprint file's LiveQA-specific " +
    'acceptance criteria.',
};

function headlessPrompt(role, sprintId) {
  const pointer = HEADLESS_POINTERS[role.id];
  if (!pointer) {
    // Every ROLES entry (agents.js) has a pointer above; this only fires
    // if a role is ever added there without a matching update here.
    throw new Error(`No headless pointer defined for role '${role.id}'.`);
  }
  return `${headlessScaffold(role.label, sprintId)}\n\n${pointer.replace('{sprintId}', sprintId)}`;
}

module.exports = { initialPrompt, devTeam2ResumePrompt, headlessPrompt };
