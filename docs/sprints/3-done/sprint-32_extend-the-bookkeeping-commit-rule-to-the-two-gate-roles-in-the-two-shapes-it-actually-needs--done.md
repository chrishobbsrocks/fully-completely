---
id: 32
title: "Extend the bookkeeping-commit rule to the two gate roles, in the two shapes it actually needs"
epic: "Sprint record durability"
status: done
created: 2026-09-09T23:39:39+00:00
---

# Master Controller Sprint Definition — Sprint 32

**Epic:** Sprint record durability — make the sprint record reliable at the
moments people act on it.
**Sprint Objective:** Extend sprint 27's bookkeeping-commit rule to QA1 and
LiveQA, in the two distinct shapes the rule actually requires, rather than the
one shape it appears to require.

### Context

Sprint 27, Req 2 established that the role which runs a lifecycle command
commits the bookkeeping that command produced. It reached `pipeman.md`,
`dev-team-1.md` and `master-controller.md`. It never reached `qa1.md` or
`liveqa.md`, so both gate roles record a verdict and leave it uncommitted.
Both roles have hit this, both correctly refused to start committing on their
own authority, and LiveQA has flagged it in three consecutive reports. The
decision is Master Controller's to make and it is made: gate roles commit their
own bookkeeping.

The objection worth taking seriously was that a verifier should not mutate the
repository it is verifying. It does not survive contact with the code.
`SHIP_HASH_EXCLUDE_PATTERNS` covers `docs/sprints/.locks/*`, `registry.json`,
`state/*.json` and `*/*.md` — exactly the paths a lifecycle command writes. A
gate role committing its own bookkeeping cannot invalidate the audit it just
recorded. Sprint 13 built that exclusion for an unrelated reason and it happens
to cover this case completely. Separately, CLAUDE.md reserves only `git push`
to Pipeman; local commits are explicitly sanctioned, and both gate roles have
been reading the boundary as wider than it is.

A downstream install's Master Controller supplied the commit shape and it is
better than the obvious one: `git commit <pathspec>` with no `git add`. A gate
verdict only ever modifies already-tracked files, so the index is unnecessary,
and a pathspec commit is structurally incapable of sweeping up a concurrent
session's uncommitted work — a failure their Pipeman hit for real with an
unfiltered `git stash -u` that swallowed another session's in-progress file.

Using that shape immediately, to commit this sprint's own creation, found its
boundary: pathspec commit does not see untracked files, and `/sprint-new`
writes a brand-new sprint file while `/sprint-start` creates a new state file.
So the rule is not uniform across commands, and writing it as though it were
would be wrong for exactly the commands that create records. The downstream
install confirmed they were already doing both shapes without having
articulated the split, and would have written the uniform version too.

### Requirements

1. `qa1.md` and `liveqa.md` state that the role commits the bookkeeping its own
   lifecycle command produced, before handing off.
2. The commit shape given to the gate roles is `git commit <pathspec>` with no
   staging step, and the files it names are stated.
3. The reason the no-staging shape is correct for these roles is recorded where
   the instruction is: a gate verdict touches only already-tracked files, and a
   pathspec commit cannot capture a concurrent session's unrelated work.
4. The reason a gate role may commit at all is recorded: `SHIP_HASH_EXCLUDE_PATTERNS`
   excludes every path a lifecycle command writes, so the commit cannot
   invalidate the audit just recorded, and CLAUDE.md reserves only `git push`
   to Pipeman.
5. The distinction between the two shapes — gate roles need no staging, roles
   running commands that create files do — is recorded somewhere both audiences
   read, not only in the two gate files.
6. No headless permission profile is changed by this sprint.

### Acceptance Criteria

- **Req 1** — QA1 confirms both files carry the rule, and that it is stated as
  an instruction to act on rather than a permission that may be exercised. The
  gap this sprint closes was created by roles reading a rule as optional.
- **Req 2, Req 3** — QA1 confirms the shape is the no-staging one and that the
  stated reason is the concurrency-safety property, not brevity.
- **Req 4** — QA1 confirms both stated reasons are accurate against the code:
  the exclusion patterns are as described, and CLAUDE.md's push restriction is
  quoted rather than paraphrased into something broader.
- **Req 5** — QA1 confirms a reader who runs `/sprint-new` finds the staging
  requirement without having to infer it from the gate-role text, which states
  the opposite shape for a different reason.
- **Req 6** — QA1 diffs `HEADLESS_PERMISSION_PROFILES` and confirms no change.
- **Whole sprint** — LiveQA installs the published package into a scratch
  project and confirms the amended `qa1.md` and `liveqa.md` actually arrive
  there. Both files are in `install.js`'s `USER_OWNED` list, so an existing
  install may legitimately not receive them; the criterion is that a *fresh*
  install does, and that whatever the upgrade path does for user-owned files
  is what the report states, rather than what it is assumed to do.

### Out of Scope

- **Granting either gate role a git permission in its headless profile.** The
  downstream install verified from real unattended runs that no gate verdict
  has ever been lost, because their loop always runs another role afterwards.
  That is a property of their orchestrator, not a general one, so the rule is
  worth writing — but adding a grant this framework cannot demonstrate works,
  for a failure neither install has suffered, is the trade sprint 26 exists to
  warn against. When a run stops immediately after a gate verdict and loses
  one, that is the sprint.
- **Changing `sprint_lifecycle.py` to commit anything itself.** The script owns
  state, git belongs to a role, and CLAUDE.md names that boundary explicitly.
- **Revisiting whether gate roles should commit.** Decided. This sprint records
  the decision and its reasoning; it does not reopen it.

### Dependencies

- Blocks: nothing.
- Blocked by: nothing. Deliberately shares no file with sprint 31.
- External: none.

### Team Assignments

- Dev Team 2: all requirements, in its own worktree. Run `/sprint-worktree 32`
  before touching any files, and stay there for the whole sprint. Sprint 31 is
  running in parallel in `scripts/launcher/run-role.js`; this sprint touches
  `.claude/agents/qa1.md`, `.claude/agents/liveqa.md`, and CLAUDE.md for Req 5.
  No overlap, which is why these two are parallel — but the worktree is not
  conditional on that judgement being right.
- Dev Team 1: sprint 31.

### Risks & Mitigations

- **The rule is written as permission rather than instruction**, and both gate
  roles continue to decline to exercise it, exactly as they have been. Mitigated
  by Req 1's acceptance criterion.
- **Req 5's split is recorded only in the gate files**, where a role running
  `/sprint-new` will never see it, and the uniform-rule error this sprint exists
  to avoid gets made by the next reader instead. Mitigated by Req 5 naming a
  location both audiences read.
- **CLAUDE.md is edited by a sprint while sprint 31 is in flight** — CLAUDE.md
  is not in sprint 31's file set, so this is safe, but it is the one file in
  this repo most likely to attract an unrelated concurrent edit. The worktree
  is the mitigation.
