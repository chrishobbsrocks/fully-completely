---
id: 28
title: "Split the undeterminable CI case, and give an orphaned shipped commit a way back"
epic: "Honest reporting"
status: in_progress
created: 2026-09-09T19:44:20+00:00
---

# Master Controller Sprint Definition — Sprint 28

**Epic:** Honest reporting — one ship-gate check treats a red pipeline as absence, and another has no way out.
**Sprint Objective:** Separate "this project has no CI" from "CI produced nothing for this commit", and give a shipped commit orphaned by a rebase a documented path back.

### Context

Two findings from a downstream orchestrator's day of real runs, both in `cmd_ship`. The reporter corrected themselves twice while gathering evidence, and both corrections shaped what is built here.

**A. `ci=undeterminable` proceeds, and it hides a red pipeline.** The Show Off's sprint 20 shipped with `ci=undeterminable: no CI runs found for commit 52ce4e6`. CI had been red since the 0.2.0 upgrade — `npm ci` failing on lockfile drift that local npm 11.6.2 tolerated and CI's 11.19.0 rejected. **Two sprints shipped over a silently red pipeline** before Pipeman found it doing something else.

`cmd_reship` correctly refuses on red. `cmd_ship` collapses two cases that are not alike: *no workflows configured* and *workflows exist and produced no run for this commit.* Only the second is alarming, and it is the one that occurred — **`.github/workflows/` at `52ce4e6` contained both `ci.yml` and `verify-deployment.yml`.** The discriminator is available locally, from the repository alone, with no API call.

The existing comment claims these statuses carry "distinct wording so it isn't confused with 'no CI at all'". **The wording distinguishes them and the behaviour does not.** Sprint 24's Req 2 asked for the undeterminable decision to be made explicitly and did not split the case finely enough for it to be made well — a Master Controller failure of specification, not a Dev Team judgement call.

**B. A shipped commit orphaned by a rebase has no way back.** Sprint 38 shipped against `e608876`; a rebase orphaned it. `cmd_liveqa` compares the deployed commit against `last_shipped_commit` and cannot match; `cmd_reship` refuses on a complete sprint; hand-editing `docs/sprints/state/` is forbidden. **That is this framework's own transition-precondition rule violated** — a precondition must be clearable by the role that hits it, or ship with a documented cross-role recovery path, and this has neither.

**Correction one, which makes a recovery buildable.** The reporter first concluded no equivalent commit exists and therefore no honest recovery was possible. Re-checking, they found content *was* preserved: `git patch-id --stable` on `e608876` gives `ab134614…`, matching `0fc408b` on main exactly — same patch, same message, no conflict resolution, no squash. **No equivalent tree exists only because the base moved 27 commits.** A tree comparison cannot distinguish a legitimately relocated commit from mangled content; a patch-id can.

**Correction two, which bounds what this sprint claims.** Patch-id identifies a content-equivalent commit — but **in their own instance that equivalent still does not resolve their failure**, because `0fc408b` does not descend from the commit their ordering assertion compares against. Sprint 38's code landed on main before sprint 32's. **Their failure was downstream of a stranded worktree close, not of the orphaned citation** — the close sat on its branch for hours, and without that the ordering would have held.

**So this sprint fixes a real dead end and must not be described as fixing theirs.** The orphaned-citation problem is genuine, separate, and will recur; it simply was not what turned their tests red. The stranding is the next sprint's.

### Requirements

1. **Split the undeterminable CI status into its two real cases**, and treat them differently.
   - **No workflows configured** — benign. A project with no CI must not become unshippable, which was sprint 24's explicit instruction and stays true.
   - **Workflows exist and no run was found for this commit** — **not benign.** It is indistinguishable from a pipeline broken badly enough to produce nothing, which is exactly what happened. Decide what `cmd_ship` does here and **record the reasoning** — refuse, or proceed with a distinct and loud status a reader cannot mistake for the benign case. **Leaving them merged is what this sprint exists to undo.**
   - **The discriminator is local**: `.github/workflows/` in the repository at the commit being shipped. Establish by running whether `gh` also separates them, and prefer whichever is more reliable — but the local check needs no API and cannot fail for network reasons.
   - **`cmd_reship` gets the same treatment**, per sprint 24's Req 4: two different answers to the same question in one codebase is the finding.

2. **`cmd_ship` verifies the commit it cites is reachable from the branch being pushed.** Nothing checks this today. A commit already unreachable at ship time should never become `last_shipped_commit`.

3. **Provide a documented recovery for a shipped commit orphaned after the fact**, with a checkable equivalence.
   - **Re-point `last_shipped_commit` only at a commit whose `git patch-id --stable` matches the orphaned commit's.** Same patch, same work, relocated. **A hopeful re-point is the laundering path this must not become** — without a checked equivalence it becomes a way to point a completed sprint at whatever is convenient.
   - **It must be clearable by the role that hits it.** Pipeman meets this failure and must be able to resolve it without git surgery. The reporter's workaround is an `-s ours` merge forcing the orphan into main's ancestry — an instance fix, not a class fix.
   - **Record the re-point in the state history** with both commits and the matching patch-id, so a later reader sees an equivalence was checked rather than asserted.
   - **A patch-equivalent commit may still not satisfy every downstream check**, as the reporter found. This requirement restores a path where none existed; it does not promise that every consequence of an orphaning resolves.

4. **The ship gate keeps comparing trees. Only the recovery uses patch-id.** *This distinction is load-bearing and the reporter did not draw it.*
   - The ship gate asks **"is the combined state what QA1 audited?"** A rebase onto newer work legitimately changes the tree, and the answer is then genuinely no — that code has not been audited against the base it now sits on. **Tree comparison is right there, and a fresh audit is the honest cost.**
   - The recovery asks **"is this the same work, relocated?"** — a different question, and patch-id is right for it.
   - **Do not "improve" the ship gate to accept patch-id equivalence.** It would let a sprint ship code audited against a different base, which is the property sprint 13 built the gate to protect. If anyone wants that trade it is a separate decision with a real consequence.

5. **Bump `package.json` to 0.2.1.** One line.

6. **Test coverage in `scripts/smoke_test.sh`:** workflows-present-no-runs is distinguished from no-workflows; an unreachable commit is refused at ship; a re-point with a matching patch-id succeeds and is recorded; a re-point with a non-matching patch-id is refused.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- Req 1: confirm the two cases are distinguished **in behaviour, not only in wording** — the existing comment already claims a distinction it does not make.
- Req 1: confirm a project with no CI configured is still shippable. **Making CI-less projects unshippable would be worse than the defect being fixed.**
- Req 1: confirm `cmd_reship` and `cmd_ship` give the same answer to the same question.
- Req 2: confirm the reachability check runs **before** `last_shipped_commit` is written.
- **Req 3 is the one that could become a laundering path.** Confirm the patch-id equivalence is checked and no path re-points without it. **A re-point succeeding on an unmatched patch-id is a FAIL, not a CONDITIONAL.**
- Req 3: confirm Pipeman can clear the failure itself. If it still needs another role or git surgery, the transition-precondition rule is still violated.
- **Req 4: `git diff` shows the ship gate's tree comparison unchanged.** Patch-id appearing anywhere in the gate path is a FAIL — it is a deliberate protection, not an oversight.
- Req 5: `package.json` is `0.2.1`, one-line diff.
- Req 6: **run the suite**, all four cases.
- Run `scripts/verify-tarball.sh`.

**LiveQA verifies live, after Pipeman publishes:**

- **Confirm 0.2.1 is on the registry**, verifying published bytes against the audited commit per sprint 13's rule.
- **Reproduce the CI case.** A scratch repo with a workflow file and no run for the shipped commit: confirm it is treated differently from a repo with no workflows, and that the message distinguishes them to a reader.
- **Reproduce the orphaning.** Ship a commit, rebase onto a moved base, confirm the original is unreachable and the re-point succeeds against the patch-id match. **Then confirm a re-point against an unrelated commit is refused.**
- **Confirm the ship gate still refuses a rebased commit** whose tree differs from what was audited. That refusal is correct and must survive this sprint.

### Out of Scope

- **The stranded worktree close, and the branch tip moving during `liveqa_live`.** Both real, both from the same batch, and **the stranding is now known to be the cause of a failure first attributed to the orphaning.** Next sprint, and it matters more than it looked.
- **Relaxing the ship gate to patch-id.** See Req 4.
- **The `-s ours` workaround.** It makes an orphan reachable; this recovery is meant to remove the need for it.
- **Any downstream ordering invariant the reporter maintains.** Their assertion that a later-closed sprint's shipped commit descends from an earlier-closed one's assumes serialized development, and this framework mandates the opposite — Dev Team 2 always works in a worktree branched from wherever main was. **That is theirs to restate or drop**, and no exception list here would help.
- **The uncommitted `.vscode/settings.json` change**, twenty-eight sprints running.

### Dependencies

- **Blocks:** A downstream orchestrator shipping over red pipelines under A, and working around B with git surgery.
- **Blocked by:** Nothing. 0.2.0 is shipped and the board is otherwise clear.
- **External:** All evidence from the reporter, including two self-corrections. **The first made Req 3 buildable; the second bounded what it can claim.** Neither was prompted.

### Team Assignments

- **Dev Team 1:** All of it. One file, two independent changes.
- **Dev Team 2:** Not assigned.

### Risks & Mitigations

- **Req 3 becomes a way to re-point a completed sprint at anything convenient.** The worst outcome here — a recovery turned into a laundering path. *Mitigation:* patch-id equivalence checked, FAIL-level criterion, and the check recorded in history so it is auditable later.
- **Someone improves the ship gate to accept patch-id** while implementing Req 3, since the code is adjacent and it looks like consistency. *Mitigation:* Req 4 states it and QA1 diffs the gate path.
- **Req 1 refuses too broadly** and CI-less projects stop being shippable — the exact failure sprint 24 warned against. *Mitigation:* explicit criterion, and the local discriminator makes the benign case cheap to detect.
- **The recovery is read as fixing more than it does.** The reporter's own failure had a different cause, and a recovery that advertises more than it delivers would send the next person down the wrong path. *Mitigation:* stated in Req 3 and in Context.
