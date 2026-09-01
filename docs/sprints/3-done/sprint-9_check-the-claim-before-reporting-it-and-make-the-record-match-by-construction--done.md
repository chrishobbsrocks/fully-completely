---
id: 9
title: "Check the claim before reporting it, and make the record match by construction"
epic: "Honest reporting"
status: done
created: 2026-09-01T05:42:40+00:00
---

# Master Controller Sprint Definition — Sprint 9

**Epic:** Honest reporting — no role and no command reports a state it has not established.
**Sprint Objective:** Remove three recurring false reports at their source — a publish whose recorded commit cannot match, an acceptance criterion that cannot demonstrate what it asks, and a claim that something is untestable made without trying — and tighten the one installer message that under-claims what it knows.

> **LiveQA's gate is REDEFINED, not skipped**, same as sprints 3–8 and for the
> same mechanical reason (`sprint_lifecycle.py:688`). Most of this sprint is
> agent-file and process content. **"Live" means confirming the published
> artifact actually carries the changed files into a real install** — which,
> since 0.1.6, it finally can.

### Context

Three failures recurred across sprints 6, 7 and 8, each one a report that was confidently wrong, each one caught by a downstream role rather than by the role that made it.

**Pipeman reported a matching commit twice, and could not have been right either time.** `/sprint-ship` records the audited commit; Pipeman then commits the resulting state change, which moves `HEAD`; `npm publish` stamps `gitHead` from `HEAD`. The recorded commit is stale *before the publish can happen*. Sprint 6 needed a reship to fix it, sprint 8 needed another. Pipeman's own resolution — check `npm view` before recording — is right, and it lives in a chat log that ends with the session. The ordering is the actual defect.

**Master Controller specified an unsatisfiable version pair three times.** Sprint 8's criterion said upgrade 0.1.4 → 0.1.6 to prove sprint 3's rule arrives; 0.1.4 already contained it. Sprint 7's inherited criterion said 0.1.6 → 0.1.7; `git diff v0.1.6 v0.1.7 -- .claude/agents CLAUDE.md` is empty. The third instance is the instructive one: the rule had already been diagnosed and written down, and the amendment fixed the wrong variable — changing *which versions* to make both ends published, when the requirement was that the pair must **differ in the file under test**. Publishedness was never the problem.

**Master Controller asserted something was untestable without trying it.** Sprint 7's header claimed the two-tree defect "cannot be reproduced in one" checkout. A worktree is created *from* a checkout; `dev2_worktree.sh` plus a scratch repo does it in a minute, and the non-git case is `mkdir` without `git init`. LiveQA tried instead of believing, which is the only reason the sprint's two central criteria were tested at all. **A false claim of untestability is worse than a false claim of correctness** — it routes around verification rather than failing loudly.

One thing has changed that makes this sprint worth running as content rather than as a note: since 0.1.6, agent-file changes actually reach installs that already exist. Before that, every rule added here was invisible to everyone who had already installed — the failure that started this epic.

### Requirements

1. **Pipeman publishes before committing the ship bookkeeping.** Update `.claude/agents/pipeman.md` so the release order is: `/sprint-ship` → **`npm publish`** → commit and push the state change. At publish time `HEAD` is still the audited commit, so npm stamps it and `last_shipped_commit` matches **by construction**, with no reship correction. Confirm the state file is excluded from the tarball so publishing with it uncommitted is clean; if it is not excluded, say so and stop rather than working around it.

2. **Pipeman establishes `gitHead` from the registry, never from intent.** Same file. After publishing, read `npm view <pkg>@<version> gitHead` and report that value. Never report the commit that was *meant* to ship. Req 1 makes them agree; this catches the case where they don't anyway.

3. **QA1 checks that version-pair criteria are satisfiable.** Update `.claude/agents/qa1.md`. QA1 already re-reads the sprint file fresh immediately before recording its verdict; add to that pass: **any acceptance criterion asserting that something arrives between two versions is only valid if the file under test actually differs between them**, which is one `git diff A B -- <path>` to confirm. An unsatisfiable criterion is raised as a finding against the sprint file, not silently satisfied by substituting a different pair. Master Controller has written this defect three times and has not once caught it alone.

4. **Master Controller does not assert untestability without attempting it.** Update `.claude/agents/master-controller.md`: never write that something cannot be tested in the available environment without having tried it. If a criterion is genuinely blocked, say what was attempted and what failed. State the reason in the file — a false "this cannot be tested here" removes the check entirely, and is more dangerous than a wrong requirement, which downstream roles will catch.

5. **Tighten the conflict message that under-claims what it established.** `install.js`'s upstream-changed message says *"since it was first published"* while the condition actually established the stronger and more useful *"since the version you have."* True as written, weaker than what the code knows. QA1 flagged it in sprint 8 as not worth a commit of its own; this is that commit. One message, no logic change.

6. **Bump `package.json` to 0.1.8.** One line.

7. **Test coverage.** Req 5 is the only code change: assert the tightened message in `scripts/launcher_test.js` by condition, following the existing file's conventions. Reqs 1–4 are agent-file content and are verified by reading, not by test.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- Req 1: read the revised order and confirm it actually produces a matching `gitHead` — that `HEAD` at publish time is the audited commit. Confirm the state file's tarball exclusion was verified rather than assumed. **If the documented order still leaves a window where `HEAD` moves before publish, that is a FAIL** — the whole point is removing the correction, not describing it better.
- Req 2: confirm the instruction is to read the registry, and that it does not permit reporting an intended commit.
- Req 3: **exercise it.** Take sprint 8's original criterion (0.1.4 → 0.1.6 for sprint 3's rule) and confirm the new instruction would have caught it. A rule that would not have caught the three instances that motivated it is not written correctly yet.
- Req 4: read it cold. Confirm it tells Master Controller what to do instead, not merely what to avoid.
- Req 5: confirm the message now states what the condition established, and that no logic changed — `git diff` shows a message-only edit.
- Req 6: `package.json` is `0.1.8`, one-line diff.
- Req 7: **run `node scripts/launcher_test.js`.** Confirm the message assertion is by condition, not by string presence alone.
- Run `scripts/verify-tarball.sh`. Sprint content in the tarball is a FAIL. **Confirm all three modified agent files are actually in the tarball** — an agent-file change excluded from the package would ship this entire sprint as a no-op, which is precisely the failure this epic exists to end.

**LiveQA verifies live, after Pipeman publishes:**

- **Confirm 0.1.8 is on the registry** and its `gitHead` matches `last_shipped_commit` — established from `npm view`, and this time expected to match **on the first attempt, with no reship**. If a reship was still needed, Req 1 did not work and that is the finding.
- **The agent-file changes reach a real install.** Choose a starting version in which the three changed files demonstrably differ from 0.1.8 — **verify that with `git diff` before running, do not assume it** — install it, leave the files untouched, upgrade to published 0.1.8, and confirm each change is present afterwards with a backup written. This criterion names no version pair on purpose: picking one is LiveQA's call, made against the diff, because Master Controller has specified an unsatisfiable pair three sprints running.
- **Both conflict messages still behave**, with the tightened wording in the upstream-changed case.
- **Fresh install still works.**

### Out of Scope

- **Naming framework-owned files that have drifted before replacing them.** The installer prints one `Replaced` line whether the user was merely behind or had a month of their own work in that file, and never prints the backup path. The external team's 271-line fork is the concrete instance and will meet it at their next upgrade. Deferred a third time, deliberately: it needs the baseline machinery extended to the other category, which is a mechanism sprint like sprint 8, not a message fix.
- **Mechanically enforcing Reqs 1–4 in `sprint_lifecycle.py`.** Tempting, and wrong for now: these are judgement failures by roles, and the cheapest correction is the instruction the role already reads. If any of the three recurs *after* this sprint ships, that is the evidence that a mechanical gate is warranted, and it should be built then rather than pre-emptively.
- **A hard framework/user marker in `CLAUDE.md`.** Still queued, still separate.
- **Fixing CLAUDE.md's own-tooling clause**, still wrong about LiveQA not applying here. Eighth sprint working around it.
- **The uncommitted `.vscode/settings.json` change.** Still unrelated, still not ours.

### Dependencies

- **Blocks:** Nothing.
- **Blocked by:** Sprint 7 closed and 0.1.7 live. **Sprint 8 is the load-bearing dependency**: before 0.1.6, changes to `qa1.md`, `pipeman.md` and `master-controller.md` reached fresh installs only, so Reqs 1–4 would have been written for an audience that could never receive them. This is the first sprint whose agent-file changes propagate to installs that already exist.
- **External:** The npm publish is Pipeman's, and Req 1 changes when in the sequence it happens. The external team running this on a fork is the concrete beneficiary of Reqs 1–4 arriving at all.

### Team Assignments

- **Dev Team 1:** All of it. Three agent files, one message, one release.
- **Dev Team 2:** Not assigned. Small, sequential, single review surface.

### Risks & Mitigations

- **Req 1's reorder introduces a worse failure than the one it fixes** — publishing before the bookkeeping commit means a publish could succeed while the commit that records it fails. *Mitigation:* that ordering is already recoverable (the state file is regenerable from the registry; a failed commit is retried), whereas today's ordering guarantees a mismatch on every release. QA1 confirms the window is genuinely closed rather than moved.
- **Reqs 1–4 are prose, and prose is not enforcement.** Three of these failures happened despite roles that read their own instructions carefully. *Mitigation:* accepted, and named in Out of Scope with the trigger for escalating — a recurrence after this ships is the evidence for a mechanical gate. Req 3's criterion, which tests the new rule against the three real instances, is the closest thing to enforcement available in prose.
- **A fourth unsatisfiable version pair, in this very sprint.** The obvious way to fail. *Mitigation:* the LiveQA criterion deliberately names no pair and instructs LiveQA to choose one against `git diff` — the specification defect is removed by not specifying the thing Master Controller keeps getting wrong.
- **An agent file change that never ships.** It would look complete and reach nobody, the exact failure this epic exists to end. *Mitigation:* QA1's tarball criterion checks all three files are actually packaged.
