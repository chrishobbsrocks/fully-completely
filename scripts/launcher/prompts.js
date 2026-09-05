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

// Sprint 11 designed this, labeled provisional. Sprint 12 confirmed it:
// this comment must say exactly what happened, not what was asked for
// (sprint 11's own QA1 round 3 caught it drifting once already — a
// version of this comment claimed a full run before one had happened —
// so this update states precisely what changed and what didn't).
//
// What actually ran (sprint 12, Req 4): all six roles, headless, in
// sequence, through one real throwaway sprint driven through both gates,
// in a scratch git-init directory (never this repo), using the real
// `--agents` personas (not a synthetic test agent) under sprint 12's own
// scoped permission profile (headlessPermissionArgs() in run-role.js —
// acceptEdits plus per-role allow/disallow lists, not blanket bypass).
// Dev Team 1 built and committed a real change; QA1 audited it and
// recorded a real PASS; Dev Team 1 ran dev-done; Pipeman pushed for real
// to a local bare remote and correctly determined the scratch repo had no
// package.json so no npm step applied; LiveQA correctly identified there
// was no deployed product to browser-test and verified what genuinely
// existed instead; Master Controller reported status read-only and
// correctly declined to treat two green gates as closure authorization;
// Dev Team 2 confirmed the same and also declined. All seven invocations
// (Dev Team 1 ran twice): is_error:false, exit 0, ~$4.78 total. Full
// account in docs/sprint-12-permission-scope-findings.md.
//
// The result, stated as Req 5 asks: the design SURVIVED CONTACT. The
// scaffold and pointers below are UNCHANGED from what sprint 11 shipped —
// every role oriented correctly from nothing but "read the sprint file
// and state file" plus its own persona, with no additional guidance
// needed. That is the finding, not a null result: QA1 round 3 already
// confirmed no verdict/note/requirement/phase-history content leaks into
// any of them, and this pass confirms the pointing itself is sufficient.
// The real, unanticipated finding from this pass wasn't about the prompt
// text at all — it was that QA1 and LiveQA's own persona files mandate a
// Write-tool pattern (`--notes-file`) that their own scoped profile
// correctly disallows; see qa1.md/liveqa.md/sprint-qa1.md/
// sprint-liveqa.md for the fix, made from three independent roles hitting
// the identical gap unprompted.
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
    `exists — both are on disk and current. This message does not restate anything from either.\n\n` +
    `Sprint 18, Req 2, decided explicitly rather than left as an incidental cost: when you run a ` +
    `Bash command your permission profile already covers, run exactly that command. Do not append ` +
    'shell chaining like ; echo $? or && echo done. Your allowed/disallowed patterns match the ' +
    'whole command line, not a leading sub-command, so appending anything after a covered command ' +
    'turns it into a different, uncovered line — one that is correctly denied even though the ' +
    'command itself was fine — and costs you a wasted denial and a retry.'
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
