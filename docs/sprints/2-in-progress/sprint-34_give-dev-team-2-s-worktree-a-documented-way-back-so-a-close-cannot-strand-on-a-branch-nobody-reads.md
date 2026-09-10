---
id: 34
title: "Give Dev Team 2's worktree a documented way back, so a close cannot strand on a branch nobody reads"
epic: "Sprint record durability"
status: in_progress
created: 2026-09-10T15:34:33+00:00
---

# Master Controller Sprint Definition — Sprint 34

**Epic:** Sprint record durability — make the sprint record reliable at the
moments people act on it.
**Sprint Objective:** Give a sprint closed in Dev Team 2's worktree a
documented way to reach main, so a close cannot come to rest on a branch no
other checkout reads.

### Context

Sprint 32 was closed correctly and became invisible. Dev Team 2 verified both
gates, obtained real authorization, ran `/sprint-complete 32`, and committed
the result to `devteam2/sprint-32`. From main, from `origin/main`, and from
every other checkout, sprint 32 read `complete_ready` — not closed. Recovering
it took a real merge by Pipeman, against a main that had independently
diverged with sprint 33's own close.

Pipeman had articulated the underlying distinction one sprint earlier, during
sprint 32's own stall: recorded and visible are different facts. That stall was
about a verdict committed but not pushed. This is the same distinction in a new
form — committed, pushed nowhere anyone reads, on a branch created by this
framework's own instruction.

The gap is this framework's, not Dev Team 2's. CLAUDE.md tells Dev Team 2 to
create a worktree, `cd` there before touching any files, and stay there for the
whole sprint. It says nothing about that branch at close: a grep of CLAUDE.md
for close, complete, merge, or return in the worktree section returns nothing.
The instruction describes a one-way door and documents the return path by
omission. Dev Team 2 did exactly what it was told and the record stranded
anyway, which makes this a specification defect rather than an execution one.

A second observation belongs in the record, though not in this sprint's scope.
Dev Team 2 reported that `run-lifecycle.js complete` was refused twice by the
session's worktree-isolation guard and that it worked around this by running
the same command from outside the pinned session via an explicit `cd`. That
guard is not ours — this repository has no worktree-isolation code, and `ROOT`
resolves from the script's own location without consulting the working
directory — so the refusal came from the host tool, not from anything here.
The outcome was benign, the stated diagnosis ("it misfires on the literal
argument `complete`") was never tested, and a routed-around guard is a pattern
worth not letting settle. Naming it here so it is recorded somewhere durable.

### Requirements

1. A sprint closed from a Dev Team 2 worktree either reaches main, or the role
   that closed it is told, at that moment, that it has not.
2. Whatever mechanism satisfies Req 1 does not have Dev Team 2 push. Only
   Pipeman pushes, without exception, and this sprint does not become the
   exception. If the resolution is a handoff, the handoff names Pipeman and
   names the branch and commit Pipeman needs.
3. The instruction in CLAUDE.md's `## Running two sprints at once` section
   covers the whole life of the worktree, including what happens to the branch
   once the sprint closes and when the directory may be removed.
4. Whatever Req 1 emits is discoverable at the moment of the close, not in a
   file the role would have to already know to consult. This mirrors sprint
   33's Req 5: a recovery path that exists but is not named where the problem
   appears has not been provided.
5. Cleaning up the worktree directory is addressed, including the case Pipeman
   correctly declined to act on — a merged branch whose directory is still some
   session's working directory.

### Acceptance Criteria

- **Req 1** — LiveQA reproduces the original failure on a real install: create
  a worktree, take a sprint to `complete_ready`, close it from inside the
  worktree, and confirm that either main now reads `complete`, or that the
  close emitted an unmissable statement that it did not. Confirming the
  emitted text exists is not enough; the criterion is that a reader who sees
  only that output knows the record has not landed.
- **Req 2** — QA1 confirms no path added by this sprint invokes `git push`, and
  that any handoff text names Pipeman explicitly rather than saying "hand off"
  generically.
- **Req 3** — QA1 confirms the worktree section reads as a complete lifecycle:
  create, work, close, return, remove. The test is whether a Dev Team 2 session
  reading only that section knows what to do at the end, since that is exactly
  what failed here.
- **Req 4** — LiveQA confirms the statement appears in the close's own output.
- **Req 5** — QA1 confirms the guidance distinguishes a merged branch from an
  unmerged one, and does not instruct anyone to remove a directory another
  session may be sitting in.
- **Whole sprint** — the sequence that produced this sprint, run again, either
  cannot strand or cannot strand silently.

### Out of Scope

- **Having Dev Team 2 push, merge, or rebase.** The push restriction is
  absolute and this sprint does not touch it. Recovery was Pipeman's and stays
  Pipeman's; what is missing is the signal that recovery is needed.
- **Changing `/sprint-worktree` to avoid worktrees.** They exist because
  "check for overlap first" demonstrably did not prevent collisions, and
  sprints 31 and 32 running in parallel without incident is evidence they work.
  The isolation is correct; only the exit is unspecified.
- **Investigating or working around the host tool's worktree-isolation guard.**
  Not this framework's code. Recorded in Context; not fixed here, and
  specifically not to be worked around in this sprint's own implementation.
- **The two remaining known items** — the installer naming a conflict without
  naming what did not arrive, and the permission anchor six CLI versions
  behind. Both real, both still open, both their own sprint. Folding them in
  because all three are shaped like "a record failing to reach its reader"
  would be a theme, not a scope.

### Dependencies

- Blocks: nothing.
- Blocked by: nothing. Sprints 31, 32 and 33 are all closed and landed on main.
- External: none. This reproduces entirely within one checkout plus a worktree
  created from it.

### Team Assignments

- Dev Team 1: all requirements. Deliberately not Dev Team 2 — this sprint
  changes the mechanism Dev Team 2 would itself be operating under, and the
  acceptance criteria require reproducing a worktree close from outside it.
- Dev Team 2: unassigned. If a parallel sprint is wanted, it should not be one
  that runs in a worktree while this sprint is changing what worktrees do at
  close.

### Risks & Mitigations

- **The fix is documentation only, and the next session under load skips it** —
  the exact failure mode already demonstrated, since the existing instruction
  was also documentation. Mitigated by Req 1 and Req 4 requiring something
  emitted at the moment of the close, with the CLAUDE.md change as the
  explanation rather than the mechanism.
- **A refusal is added with no path Dev Team 2 can take** — Dev Team 2 cannot
  push, so a hard refusal would be a dead end of exactly the kind this
  framework's transition-precondition rule forbids. Mitigated by Req 2: the
  resolution is a named handoff, not a block.
- **Cleanup guidance tells someone to delete a directory in use** — Pipeman
  hit precisely this and correctly declined to act. Mitigated by Req 5.
