---
id: 24
title: "Close the three gaps between shipping a commit and verifying what actually got served"
epic: "Honest reporting"
status: todo
created: 2026-09-08T21:56:14+00:00
---

# Master Controller Sprint Definition — Sprint 24

**Epic:** Honest reporting — between shipping a commit and verifying what got served, three things can go wrong and none of them is visible.
**Sprint Objective:** Let LiveQA record a verdict on a deployment whose content matches what shipped, refuse a ship over a red pipeline, and make an origin-ahead-of-record drift detectable after the fact.

### Context

Three findings from an orchestrator running this lifecycle unattended across two target repos — thirty sprints in three days. **They are one path and one moment**, and the reporter agrees that splitting them would produce three partial fixes. Every claim below is from traces pulled from their repos, including one correction to their own earlier report, which is why this sprint is written against evidence rather than inference.

**A. The deployed SHA is never the shipped SHA, on any target that deploys from a branch.** Their production alias tracks `main`. The ship's own bookkeeping commit lands on top. By the time LiveQA tests, the served commit is the bookkeeping commit, and `cmd_liveqa`'s identity check refuses the verdict.

Showoff sprint 6: shipped `8b6fe09`, bookkeeping `9f944d7` on top, deployment reported `githubCommitSha 9f944d7`. Sprint 17: shipped `c74cf14`, served `605fc87`, four bookkeeping commits between them. **In both cases `git diff --stat <shipped> <served> -- <product paths>` is empty** — the only difference is `docs/sprints/state/*.json`.

Their LiveQA verified the product code was byte-identical to what QA1 audited *before* deciding the verdict was valid, tested anyway, was refused, and **declined to type the expected SHA to get past it.** That was right, and the check should be able to reward it. As their Master Controller put it: the check has exactly two outcomes — a recorded verdict naming a commit nobody tested, or a valid verdict that cannot be recorded.

**This framework already has the fix and does not use it.** Sprint 13 built `git_tree_hash_excluding(ref, patterns)` and `SHIP_HASH_EXCLUDE_PATTERNS` for exactly this shape on the ship side, and audited it as a gate relaxation with a FAIL-level criterion. `cmd_liveqa` still compares raw commit identity. **This is a second call site for an existing, audited mechanism, not a new one.**

**B. `/sprint-ship` does not look at CI, and a sprint shipped over a two-day-red build.** QA1 had explicitly conditioned its PASS on green CI; nothing enforced it, and Pipeman found the red build only by going to look afterwards.

`npm ci` was exiting `EUSAGE` in 5–7 seconds on a lockfile out of sync — **lint, test and build never ran at all.** The reporter's own diagnosis is the requirement: a check asking only *"did a run exist"* or *"did it finish"* would have passed every red run. What is needed is **the conclusion of the latest run for the exact commit being shipped, and whether its steps actually executed.** They also disproved an npm-version-drift theory that reached an earlier draft of their report — last-green and first-red both ran npm 11.19.0 and node v24.20.0, so do not build against it.

**C. An origin-ahead-of-record window is silent, and it cannot be prevented at ship time.** On 7 September a headless Pipeman pushed `c74cf14` at 01:49:37 UTC; the state write landed at 01:58:26. Nine minutes, closed only because Pipeman went to the reflog unprompted — and its first read was that someone had bypassed *"only Pipeman pushes"*, when it was Pipeman's own headless twin, which it had no way to see.

**`cmd_ship` never executed.** The denial came from Claude Code's permission classifier before the process started, on both entry points identically. So a remote check inside `cmd_ship` would not have run either. The design constraint the reporter names is the important one: **the classifier permitted the irreversible half and blocked the recoverable one.** Any reconciliation must assume the push can succeed while the record fails, never the reverse — which makes this a detection problem, not a prevention one.

### Requirements

1. **`cmd_liveqa` accepts a deployed commit whose shipped content matches `last_shipped_commit`.** Reuse `git_tree_hash_excluding` and `SHIP_HASH_EXCLUDE_PATTERNS` — **do not build a second mechanism.** Sprint 13 already carried this reasoning through a FAIL-level audit on the ship side; the same argument applies here for the same reason.
   - **State what the identity check was protecting and confirm it still is.** Its comment says a mismatch *"always means this live test ran against something other than what Pipeman actually shipped"* — that remains true for a genuinely different deployment and must keep refusing. **What changes is that bookkeeping is no longer "something other".**
   - **The message on a real mismatch must say which paths differ**, not just that the hashes do. Their LiveQA had to run the diff by hand to know its verdict was valid.

2. **`/sprint-ship` refuses over a red pipeline, and the check is specific.** The conclusion of the latest run **for the exact commit being shipped**, and **whether its steps executed** — a run that died at install in five seconds satisfies both "exists" and "completed" and is exactly the case that shipped.
   - **Decide what happens when CI status cannot be determined** — no network, no runs yet, an unconfigured project. **Refusing on an undeterminable status and refusing on a red one are different decisions and both need making.** An unstated default here is the defect; a project with no CI at all must not become unshippable by accident.
   - The green run after their fix recorded lint, test and build as executed. **That is the shape of a useful positive** — build the check against it.

3. **An origin-ahead-of-record drift is detectable after the fact.** It cannot be prevented — `cmd_ship` never ran. **Surface it where the wrong conclusion would otherwise be drawn**, which is sprint 13's Finding C shape: `cmd_status` at minimum, and wherever `last_shipped_commit` is read to make a decision.
   - **It warns; it does not gate.** A record lagging origin is recoverable and common; blocking on it would make a normal state unworkable.
   - The message must distinguish **"origin carries a commit your record does not"** from **"you shipped the wrong thing."** Pipeman's first reading of this was that someone had bypassed the push rule — the message must not invite that.

4. **Bump `package.json` to 0.1.25.** One line.

5. **Test coverage in `scripts/smoke_test.sh`.** At minimum: a bookkeeping-only difference between shipped and deployed is accepted; a product-code difference is still refused; the CI check refuses a run that completed without executing its steps; the undeterminable-status decision behaves as chosen; the origin-ahead warning appears and does not gate.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1 is a gate relaxation and carries sprint 13's standard.** Demonstrate both directions against a scratch repo: a bookkeeping-only difference is accepted, **and a one-line product-code change between shipped and deployed is still refused.** **If a real code difference can now slip through, this is a FAIL, not a CONDITIONAL.** Reading the diff does not clear it.
- Req 1: confirm the existing helper was reused rather than reimplemented, and that a mismatch message names the differing paths.
- **Req 2's specificity is the whole point.** Confirm the check would refuse a run that exited `EUSAGE` at install in five seconds. **A check satisfied by "a run exists" or "a run completed" is the defect, not the fix.**
- Req 2: confirm the undeterminable-status decision is recorded with its reasoning, and that a project with no CI configured is not silently unshippable.
- Req 3: confirm it warns and never gates, and read the message cold. **If it could be read as "someone bypassed the push rule", it fails** — that is the misreading it exists to prevent, and it has already happened once.
- Req 4: `package.json` is `0.1.25`, one-line diff.
- Req 5: **run the suite**, and confirm the five listed cases.
- Run `scripts/verify-tarball.sh`.

**LiveQA verifies live, after Pipeman publishes:**

- **Confirm 0.1.25 is on the registry**, verifying published bytes against the audited commit per sprint 13's rule.
- **Reproduce the reported scenario.** Ship a commit in a scratch repo, land a bookkeeping commit on top, and record a verdict against the later commit. **That is the exact case that has cost a manual reship on every sprint of theirs.**
- **The relaxation did not open a hole.** Land a one-line product change between the shipped and the tested commit and confirm the verdict is still refused.
- **The CI refusal fires.** Construct or find a commit whose run completed without executing its steps and confirm the ship refuses. If that cannot be constructed here, say so plainly rather than inferring it.
- **The origin-ahead warning appears** when origin carries a commit the record does not, and **does not block**.

### Out of Scope

- **Preventing the origin-ahead window.** `cmd_ship` never executes when the classifier denies it, so nothing inside it can help. Detection is the achievable thing and pretending otherwise would produce a check that never runs.
- **The classifier's behaviour itself.** That it permitted the irreversible half and blocked the recoverable one is a real observation about the environment, not something this framework controls.
- **Cross-session ownership and sprint renaming.** Sprint 25, deliberately kept separate.
- **Any per-project declaration of "product paths".** Excluding `docs/sprints/` is what sprint 13 established and it needs no per-project configuration — which is why it is the right shape here too.
- **The disproved npm-version-drift theory.** Named so it is not rebuilt against.

### Dependencies

- **Blocks:** A manual `/sprint-reship` on every sprint of a consumer whose deployment tracks a branch, and a ship-time regression signal that has been absent since 4 September on their side.
- **Blocked by:** Sprint 23 shipping as 0.1.24.
- **External:** Traces supplied by the reporter, pulled from their repos rather than recalled, **including a correction to their own report's dates.** More detail is available on request for any of the three.

### Team Assignments

- **Dev Team 1:** All of it. One file, three changes on one path.
- **Dev Team 2:** Not assigned.

### Risks & Mitigations

- **Req 1 relaxes a gate and lets a genuinely different deployment through.** The worst outcome here, and the same risk sprint 13's Finding A carried. *Mitigation:* both directions demonstrated against a scratch repo as a FAIL-level criterion, and re-tested live.
- **Req 2's check is satisfied by the wrong signal**, passing every red run exactly as the reporter's case did. *Mitigation:* QA1's criterion names the five-second `EUSAGE` case specifically.
- **Req 2 makes a CI-less project unshippable**, which would be a worse defect than the one being fixed. *Mitigation:* Req 2 requires the undeterminable-status decision to be made explicitly rather than defaulted.
- **Req 3's warning is read as an accusation.** It already was once, by the role that caused it. *Mitigation:* a QA1 criterion on the wording, read cold.
