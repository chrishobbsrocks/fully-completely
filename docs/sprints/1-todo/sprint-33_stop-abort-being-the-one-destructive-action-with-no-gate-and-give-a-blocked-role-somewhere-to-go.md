---
id: 33
title: "Stop abort being the one destructive action with no gate, and give a blocked role somewhere to go"
epic: "Sprint record durability"
status: todo
created: 2026-09-10T05:55:49+00:00
---

# Master Controller Sprint Definition — Sprint 33

**Epic:** Sprint record durability — make the sprint record reliable at the
moments people act on it.
**Sprint Objective:** Require real human authorization for the lifecycle's most
destructive action, record truthfully who took it, and give a role that
correctly finds a sprint unbuildable a way to stop without destroying it.

### Context

A downstream install ran its first unattended chain and a headless role
abandoned two sprints in ninety seconds and sixteen seconds. Its judgment was
correct both times — neither sprint was buildable, one needing real content
that did not exist and one reaching Dev Team with required decisions unmade.
The diagnosis was right and the available action was wrong: `/sprint-abort`
escalated and abandoned in the same step, so the escalation message arrived
after the sprint was already gone.

Three defects sit behind that, and only the first two were reported.

`cmd_abort` calls `log_event(state, "human", "aborted", reason)`. Every other
command in the file logs the role that acted — `cmd_complete` writes
`"dev-team"`, `cmd_ship` writes `"pipeman"`. `"human"` appears exactly once in
this file and it is an assertion no other command makes about itself. When a
headless role abandons a sprint, the history states a human did it. The record
does not merely fail to prevent this; it reports the opposite of what happened,
which is why the downstream install found it by reading wall-clock timestamps
rather than by reading the history.

`cmd_complete` requires `--user-said`, non-empty, refusing with no override,
because a sprint is never closed without the user's explicit real-time
authorization. `cmd_abort` requires nothing. `--reason` is optional and prints
`(none given)` when absent. The lifecycle's most destructive action — it moves
the file to `5-abandoned`, marks the registry, burns the sprint id, and makes
re-filing a human act — has strictly less protection than its least
destructive one. This repo's own quick reference already notes `/sprint-abort`
as the one command whose role attribution is inferred rather than quoted; this
is where that inference costs most.

The third defect is the one that makes a gate alone insufficient. This
framework's own transition-precondition design rule states that a precondition
must be clearable by the role that hits it, or ship with a documented
cross-role recovery path. Gating abort without providing an alternative leaves
a correctly-blocked role with no action at all — it cannot proceed, cannot
abandon, and cannot hand back. That is precisely the dead end the rule exists
to forbid, and it means the recovery path is not optional scope here. It is
what makes the gate admissible.

What was actually lost was the analysis. "This sprint is not buildable and here
is why" is exactly what a Master Controller needs to repair the file. Abandoning
converted a fixable specification problem into re-filing from scratch.

### Requirements

1. `cmd_abort` records the role that actually ran it, on the same footing as
   every other command in the file. The hardcoded `"human"` actor is removed.
2. `cmd_abort` requires explicit human authorization, non-empty, refusing with
   no override — the same mechanical shape and the same non-overridability as
   `cmd_complete`'s `--user-said`.
3. `--reason` becomes required and non-empty. A sprint may not be abandoned
   without a stated cause.
4. A role that finds a sprint unbuildable has a non-destructive action: it
   returns the sprint to the planner, preserving the sprint id, the file's
   location, and the role's own stated analysis, without moving anything to
   `5-abandoned`.
5. That path is reachable by the role that hits Req 2's refusal, and the
   refusal message names it. A precondition whose recovery path exists but is
   undiscoverable at the moment of refusal has not satisfied the design rule.
6. The two existing abandoned sprints in the downstream install are not this
   sprint's concern, but the path in Req 4 must be usable to re-file a sprint
   that was abandoned for a specification problem rather than a real one.

### Acceptance Criteria

- **Req 1** — QA1 confirms no call site passes a literal `"human"` as actor,
  and that the recorded actor is derived the same way the surrounding commands
  derive theirs. LiveQA confirms, on a real install, that a sprint aborted by a
  named role records that role.
- **Req 2** — QA1 confirms the check is non-empty, occurs before any state or
  file mutation, and has no flag, environment variable, or argument that
  bypasses it. LiveQA confirms an abort with the argument absent, and with it
  present but empty or whitespace, both refuse and leave the sprint file where
  it was.
- **Req 3** — LiveQA confirms an abort with no reason refuses, and that
  `(none given)` can no longer be produced.
- **Req 4** — LiveQA drives the path on a real sprint and confirms afterwards
  that the sprint id is unchanged, the file has not moved to `5-abandoned`, the
  registry does not mark it abandoned, and the stated analysis is retrievable
  from the record rather than only from the terminal that produced it.
- **Req 5** — LiveQA triggers Req 2's refusal and confirms the message names
  the alternative. The test is whether a reader who has just been refused knows
  what to do next without consulting another file.
- **Whole sprint** — a headless role that correctly determines a sprint is
  unbuildable can stop, hand back with its reasoning intact, and cannot
  abandon anything unattended.

### Out of Scope

- **Narrowing the headless profiles' subcommand wildcards.** The grants are
  `Bash(python3 scripts/sprint_lifecycle.py *)` and equivalent, so every role
  holding one reaches every subcommand. Enforcing in `cmd_abort` is preferred
  for the same reason sprint 31 stated the command form rather than widening a
  pattern: a check in the command works whether or not the permission layer
  behaves as documented, and this framework cannot currently demonstrate that
  it does. A per-subcommand permission model may be worth having; it is not
  what closes this hole.
- **Changing `cmd_complete`.** It is the correct shape here and is being
  matched, not revised.
- **Instructing roles, in agent files, to escalate rather than abandon.** The
  downstream install is doing exactly this on their side and correctly
  describes it as instruction, not enforcement — a role under load can ignore
  a prompt. This sprint is the enforcement half. The two are complementary and
  neither substitutes for the other.
- **Recovering the downstream install's two abandoned sprints.** Their files
  survive; re-filing is theirs to do.

### Dependencies

- Blocks: nothing.
- Blocked by: nothing. Does not touch `run-role.js`, so it does not collide
  with sprint 31.
- External: the downstream install's 10 September chain is the observation
  behind this. It is evidence, not a dependency, and this sprint must stand on
  the inconsistency being real in this repo — which it is, independently.

### Team Assignments

- Dev Team 1: all requirements. `scripts/sprint_lifecycle.py`, plus whatever
  command surface Req 4 needs and its `.claude/commands/` entry.
- Dev Team 2: sprint 32 if still open, in its own worktree. Sprint 32 touches
  agent files and CLAUDE.md; this sprint touches the lifecycle script and a
  command file. If Req 5's refusal message or Req 4's new command needs
  documenting in CLAUDE.md, that is a genuine overlap with sprint 32 — flag it
  rather than both editing that file.

### Risks & Mitigations

- **The gate ships without the recovery path**, leaving a blocked role with no
  legal action and making the framework worse than it is today. Mitigated by
  Reqs 4 and 5 being requirements of this sprint rather than a follow-up, per
  the transition-precondition rule.
- **The authorization argument is added but a role fabricates a value for it** —
  the same exposure `--user-said` already carries. Not solvable mechanically
  here; what this sprint buys is that abandoning requires an affirmative,
  recorded, quoted claim rather than happening silently. Worth stating in the
  sprint rather than pretending the gate is stronger than it is.
- **Req 4 grows into a new lifecycle phase with its own gates.** The need is a
  way back to the planner, not a new state machine branch. The narrowest thing
  that preserves id, location and analysis is the target.
