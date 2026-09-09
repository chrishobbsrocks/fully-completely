---
id: 29
title: "Surface a stranded close and stop the deployed tip moving during the live gate"
epic: "Honest reporting"
status: in_progress
created: 2026-09-09T19:47:18+00:00
---

# Master Controller Sprint Definition — Sprint 29

**Epic:** Honest reporting — between the ship and the close, the record can strand on a branch and the deployment can move, and neither is visible.
**Sprint Objective:** Make a close that landed only in a worktree detectable from the main checkout, and make a branch tip moving during the live gate something the framework notices rather than something discipline prevents.

### Context

Two findings from the same batch as sprint 28, both in the window between shipping and closing, and both invisible by construction.

**A. A sprint closed in a worktree strands its bookkeeping on that branch.** `/sprint-worktree` puts Dev Team on its own branch. `/sprint-complete` then correctly runs in that session and writes to that worktree's `docs/sprints/`. **The close commit never reaches main, and nothing surfaces it — main simply shows a sprint that was never closed.** Sprint 38 sat that way for hours with everyone believing it was done. The reporter's release gate then refused for a reason that reads like an unmet gate rather than a stranded commit, costing a backwards re-pin and about an hour.

**This finding got more serious after it was filed.** The reporter initially attributed a downstream ordering failure to an orphaned shipped commit, then re-checked git ancestry and found the real cause was this stranding: without it, sprint 38 would have closed before sprint 32 and the ordering would have held. **A misattributed failure survived until someone went back and checked** — which is the cost of an invisible state, not of an hour.

**The gap is ours and it is a scoping failure.** Sprint 13's Req 3 built a warning for exactly this class — a sprint file amended in one working tree and invisible from another — using `git worktree list`, which is local, enumerable and needs no network. **Master Controller scoped it to sprint files.** It says nothing about state files or the registry, which is precisely what a close writes.

**B. Any push moves the branch tip, and the platform deploys the tip.** Pipeman pushed a docs-only commit during sprint 7's `liveqa_live` window. **The deployed SHA left the shipped commit mid-gate with every check still green.**

The commit was `4d67199`, touching `docs/sprints/1-todo/sprint-21_….md` and `docs/sprints/registry.json` and nothing else. **Both inside the path sprint 13 excludes from the ship-hash comparison**, so existing machinery could not see it at all — not a content mismatch, and not half-caught. The reporter's framing is the one to design against: **it is not about what changed, it is that any push moves the tip and the platform deploys the tip.**

They have adopted a hold-everything rule operationally. It is discipline, and it failed the first day they relied on it.

### Requirements

1. **Extend the cross-tree warning to state files and the registry, not only sprint files.** Sprint 13's mechanism already works and needs no redesign — `git worktree list` is local and enumerable. **What it examines is what must change.**
   - **Surface a sprint whose state differs between working trees**, naming which tree holds which phase. A sprint reading `complete` in one tree and `liveqa_live` in another is the case that cost hours.
   - **It warns and never gates.** Roles must be able to work in worktrees; that is what worktrees are for, and blocking on divergence would make the framework's own parallel-sprint model unusable.
   - **The message must name the other tree specifically** — path and phase — not "another tree disagrees". Sprint 25 established that naming the specific session is what makes a collision warning actionable, and the same applies here.

2. **`/sprint-status` and `/sprint-list` must not report a sprint as open when another tree has closed it.** These are the commands someone runs to answer "is this done", and today they answer confidently from one tree. **Surfacing the disagreement at the point the wrong conclusion is drawn is sprint 13's own lesson**, applied to the state the warning currently ignores.

3. **Detect that the branch tip moved off the shipped commit during `liveqa_live`, and say so.** Not prevent — detect.
   - **A prevention would have to block pushes**, which this framework cannot do and should not try: `cmd_ship` performs no git operations by design, and the pushes in question are legitimate work by other roles on other sprints.
   - **`cmd_liveqa` already resolves the deployed commit.** What is missing is noticing that `last_shipped_commit` is no longer the tip of the branch a deployment tracks, and saying which commits landed since.
   - **The docs-only case is the one to design against**, because it is invisible to every existing check: sprint 13's exclusion means a push touching only `docs/sprints/` produces no content mismatch anywhere.
   - **Decide whether this warns or refuses, and record the reasoning.** A refusal has a real cost — the recovery is a reship — and a warning may be too weak for a gate whose whole job is testing what is deployed. **An unstated default is the defect**, whichever way it goes.

4. **Bump `package.json` to 0.2.2.** One line. *0.2.1 belongs to sprint 28.*

5. **Test coverage in `scripts/smoke_test.sh`:** a sprint closed in one worktree is surfaced from another; a sprint in identical states across trees produces no warning; a branch tip moving off `last_shipped_commit` during `liveqa_live` is detected, including when the only change is inside `docs/sprints/`.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1: confirm it warns and never gates.** A command that refuses on cross-tree divergence is a **FAIL, not a CONDITIONAL** — the framework mandates worktrees and would be blocking its own model.
- Req 1: confirm state files *and* the registry are covered, and that the message names the other tree's path and phase. **"Another tree disagrees" is not actionable and is the version that gets ignored.**
- Req 2: confirm the disagreement surfaces on the commands someone actually runs to ask whether a sprint is done. **A warning that fires somewhere else is a warning nobody sees at the moment they form the wrong belief.**
- **Req 3: confirm the docs-only case is detected.** That is the case existing machinery structurally cannot see, and a check that only catches source changes would look correct while missing the reported instance.
- Req 3: confirm the warn-or-refuse decision is recorded with its reasoning. **Deciding by omission is the defect.**
- Req 4: `package.json` is `0.2.2`, one-line diff.
- Req 5: **run the suite**, all three cases.
- Run `scripts/verify-tarball.sh`.

**LiveQA verifies live, after Pipeman publishes:**

- **Confirm 0.2.2 is on the registry**, verifying published bytes against the audited commit per sprint 13's rule.
- **Reproduce the stranding.** Create a worktree, close a sprint inside it, and confirm the main checkout surfaces the disagreement rather than reporting the sprint open. **This is the case that cost hours and a backwards re-pin.**
- **Reproduce the tip move.** With a sprint at `liveqa_live`, push a commit touching only `docs/sprints/`, and confirm the framework notices the deployed tip left the shipped commit.
- **Confirm identical state across trees produces silence.** A warning that fires when there is nothing to disagree about is the noise that trains people to ignore it — the same property sprint 25 verified for the collision warning.

### Out of Scope

- **Preventing pushes during the live gate.** `cmd_ship` performs no git operations by design, and the pushes in question are other roles doing legitimate work on other sprints. Detection is the achievable thing.
- **Making `/sprint-complete` write to main from a worktree.** It correctly writes where it runs; the fix is surfacing the divergence, not relocating the write.
- **Sprint 28's ship-gate work** — the CI split and the orphan recovery. Separate sprint, already written.
- **Any downstream ordering invariant.** The reporter's assertion assumes serialized development, which this framework mandates against; theirs to restate or drop.
- **The uncommitted `.vscode/settings.json` change**, twenty-nine sprints running.

### Dependencies

- **Blocks:** A downstream orchestrator relying on operational discipline for B, which failed on the first day they relied on it.
- **Blocked by:** Sprint 28 on the shared version line.
- **External:** Both findings and the ancestry re-check that corrected the first one came from the same reporter.

### Team Assignments

- **Dev Team 1:** All of it. Two independent halves.
- **Dev Team 2:** Not assigned — **and note this sprint fixes the invisibility of work done in Dev Team 2's own worktree**, which it cannot verify from inside.

### Risks & Mitigations

- **Req 1 or 2 becomes a refusal** because a warning feels weak. That would block the framework's own parallel-sprint model. *Mitigation:* FAIL-level QA1 criterion on both.
- **The warning fires on every invocation** and becomes the `repo=` banner that four wrong conclusions were drawn past. *Mitigation:* silence when trees agree, verified live.
- **Req 3 catches only source changes**, looking correct while missing the reported case entirely. *Mitigation:* the docs-only case is named in the requirement and in both gates' criteria.
- **Req 3's decision is made by omission** — the warn-or-refuse question is genuinely hard, and defaulting is easier than deciding. *Mitigation:* the requirement states that an unstated default is the defect, and QA1 checks for the recorded reasoning rather than the outcome.
