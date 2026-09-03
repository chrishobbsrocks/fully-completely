---
id: 13
title: "Stop the lifecycle's own bookkeeping from breaking the lifecycle's own gates"
epic: "Honest reporting"
status: todo
created: 2026-09-03T15:47:07+00:00
---

# Master Controller Sprint Definition — Sprint 13

**Epic:** Honest reporting — no gate should fire on something it was never built to catch.
**Sprint Objective:** Fix three ways the lifecycle's own bookkeeping commits break the lifecycle's own gates, without weakening what any of those gates actually protect.

> **LiveQA's gate is REDEFINED, not skipped**, same as sprints 3–12 and for the
> same mechanical reason (`sprint_lifecycle.py:688`). **"Live" here means
> driving a real sprint through the real gates from a published install**, in a
> scratch repo, with the bookkeeping commits that cause these failures actually
> present. All three findings only appear once a sprint has state written mid-flight.

### Context

Three distinct findings, one thesis, **eight recorded instances between them**. Every one was caught downstream — by QA1, by LiveQA, or by a downstream consumer — and none by the role that caused it.

**Finding A — the tree-hash gate is stricter than the thing it protects.** `cmd_ship` compares the *whole tree* of the commit Pipeman names against `qa1_audited_tree_hash`. What actually ships is the tarball, and `.npmignore` excludes `docs/sprints/` from it. So the lifecycle's own bookkeeping — a registry update, a state file, a sprint file — invalidates an audit **without changing one byte that ships**. Sprints 6, 8 and 10 each hit it, and the documented recovery is to re-audit a diff containing zero shipped files.

**Finding B — HEAD has already drifted before Pipeman is invoked.** Sprint 9's Req 1 held *Pipeman's* bookkeeping commit until after the publish, and that reordering worked. But the drift does not come from Pipeman. Dev Team's QA1-PASS and dev-agreed-done bookkeeping lands on top of the audited commit *before Pipeman exists in the sequence*, so HEAD at publish time is already past it and npm stamps the wrong thing. Sprint 10 published as `0.1.10` with `gitHead 6c1fc67` while the audited commit was `21dcc8d`, and needed the post-hoc correction (`20daca7`) that sprint 9 was built to eliminate — **on the release immediately after sprint 9 shipped.** Second instance after `8f597b8`. Req 11's trigger does not address it: that decides *whether* to publish, not what HEAD is when you do.

**Finding C — a sprint file amended in one tree is invisible to the gate in another.** The hash gate binds an audit to the sprint file *in that working tree*. It cannot see that Master Controller amended a different copy on another branch, and it was working exactly as designed while blind to this. Three instances: Dev Team built sprint 11 against a spec amended on main; a downstream consumer specified against a stale Req 4 read from main; and a QA1 acceptance criterion could not be satisfied from the tree QA1 was auditing in, which needed an absolute path hardcoded into the criterion to work around.

**This sprint changes gates. That is the whole risk.** Every requirement below must state what protection is preserved, not just what friction is removed. A gate that stops firing is not automatically fixed.

### Requirements

1. **Finding A — the ship gate compares what ships, not the whole tree.** Exclude `docs/sprints/` from the content compared by `cmd_ship`'s tree-hash check, so bookkeeping the lifecycle itself writes cannot invalidate an audit.
   - **State the preserved protection explicitly in a comment**: sprint files remain guarded by `qa1_audit_file_hash`, which is a separate gate checked by `cmd_dev_done`. Excluding `docs/sprints/` from the *tree* hash removes an overlap between two gates, it does not remove a protection. If that reasoning is wrong anywhere, say so and stop rather than proceeding.
   - **Everything outside `docs/sprints/` stays covered exactly as today.** A source change landing between audit and ship must still be refused, with no override.

2. **Finding B — decide what `last_shipped_commit` means, and make the answer mechanical.** Two candidate meanings are in play and the code currently implies one while LiveQA checks the other: *the commit whose content was audited and shipped*, or *the commit npm actually stamped as `gitHead`*. They differ whenever bookkeeping lands between audit and publish, which is every release.
   - **Determine which LiveQA's `--deployed-commit` identity check actually needs**, by reading `cmd_liveqa` rather than by reasoning about it, and record the finding.
   - **Then make it mechanical rather than a reporting instruction.** Sprint 9 fixed this with prose in `pipeman.md` and it drifted on the very next release. If the answer is "what npm stamped," the value should be read from the registry and recorded, not asserted by whoever is reporting.
   - **The post-hoc correction may turn out to be the correct workflow rather than a defect** — two facts recorded in sequence, both true. If so, say that plainly and make it a first-class step instead of an anomaly that reads like a mistake every time it happens. Do not presuppose the answer.

3. **Finding C — commands that read a sprint file say when another working tree has a different one.** Use `git worktree list`, which is local, enumerable and needs no network. **Do not compare against `origin/main`** — that was ruled out in sprint 7 for a reason that still holds: a stale or unfetched remote ref produces a *new* confidently-wrong answer, which is the defect this epic exists to remove.
   - At minimum `cmd_status` and `cmd_qa1` should surface it, since those are where a stale read does damage.
   - **This warns; it does not gate.** Nothing should be blocked by a divergence — the roles must be able to work in worktrees, which is what worktrees are for.
   - If the compare is impossible or unreliable in some configuration, name the configuration rather than assuming it works everywhere.

4. **Bump `package.json` to 0.1.13.** One line.

5. **Test coverage in `scripts/smoke_test.sh`.** At minimum: a bookkeeping-only change between audit and ship no longer refuses; a source change between audit and ship still refuses; whatever Req 2 decides is asserted; the worktree divergence warning appears when trees differ and stays silent when they don't.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1 is the load-bearing check, and it is a gate relaxation.** Confirm by construction that a change to any path outside `docs/sprints/` between audit and ship is still refused with no override. **If any source path can now slip through, this is a FAIL, not a CONDITIONAL.** Demonstrate both directions against a scratch repo — bookkeeping-only passes, a one-line source change refuses — rather than reading the diff.
- Req 1's rationale: confirm the comment states the preserved protection, and check the claim yourself. If `qa1_audit_file_hash` does not in fact still guard sprint files, the whole basis for this change is wrong and it should be a FAIL.
- **Req 2: confirm the decision was reached by reading `cmd_liveqa`**, not by reasoning, and that the outcome is mechanical rather than an instruction in an agent file. Sprint 9's version was prose and it drifted on the next release; a fix of the same shape is not a fix.
- Req 3: confirm it warns and never gates, and that no `origin/*` comparison was introduced.
- Req 4: `package.json` is `0.1.13`, one-line diff.
- Req 5: **run `scripts/smoke_test.sh`.**
- Run `scripts/verify-tarball.sh`.

**LiveQA verifies live, after Pipeman publishes:**

- **Confirm 0.1.13 is on the registry** and its `gitHead` matches `last_shipped_commit` — **on the first attempt, with no post-hoc correction.** If a correction was still needed, Req 2 did not work and that is the finding.
- **Drive a real sprint through the real gates from a published install**, in a scratch repo, with bookkeeping commits actually landing between audit and ship. All three findings only appear once state is written mid-flight; a sprint with no bookkeeping proves nothing here.
- **The relaxation did not open a hole.** Land a one-line source change between audit and ship and confirm `/sprint-ship` still refuses it.
- **The worktree warning fires.** Create a worktree, amend a sprint file in one tree, and confirm the other names the divergence — the exact scenario that had Dev Team building against a stale spec.

### Out of Scope

- **Any `origin/*` comparison.** Ruled out in sprint 7, still ruled out, same reason.
- **Making the tree-hash check match the tarball exactly.** Excluding `docs/sprints/` covers all eight recorded instances; computing true tarball membership is a larger change with no instance demanding it.
- **Sprint 12's headless work**, and sprint 11's shipped surface. Untouched.
- **Widening LiveQA's definition, CLAUDE.md's own-tooling clause, and the mechanism-not-automation boundary.** Still queued, still no instance forcing them.
- **The disclosure sweep**, unscheduled since sprint 4.
- **The uncommitted `.vscode/settings.json` change.**

### Dependencies

- **Blocks:** Nothing directly, but every future release pays the tax these findings impose until it lands.
- **Blocked by:** Sprints 11 and 12 shipping, on the shared `package.json` version line. Sequential: 0.1.11, 0.1.12, then 0.1.13.
- **External:** None. All three findings are internal to this repo's own lifecycle.

### Team Assignments

- **Dev Team 1:** All of it. One file, three related changes, one release.
- **Dev Team 2:** Not assigned. A gate relaxation is a single review surface.

### Risks & Mitigations

- **Req 1 relaxes a gate and opens a path for unaudited source to ship.** By far the worst outcome available here — it would undo the protection that has held across every release this project has made. *Mitigation:* QA1 demonstrates both directions against a scratch repo as a FAIL-level criterion, and LiveQA re-tests the refusal against the published artifact.
- **Req 2 is fixed with prose again** and drifts on the next release, exactly as sprint 9's did. *Mitigation:* the requirement names that failure explicitly and the acceptance criterion rejects an agent-file instruction as the fix.
- **Req 3's warning becomes noise** and gets ignored the way the `repo=` banner was ignored through four wrong readings. *Mitigation:* it appears in `cmd_status` and `cmd_qa1` where a stale read does damage, not on every invocation. If it turns out to need to be everywhere, that is a finding for later, not a reason to start there.
- **Three gate changes in one sprint** is more surface than this project usually takes at once. *Mitigation:* accepted deliberately — they are one thesis with eight instances, and splitting them means three releases each paying the tax the others impose.
