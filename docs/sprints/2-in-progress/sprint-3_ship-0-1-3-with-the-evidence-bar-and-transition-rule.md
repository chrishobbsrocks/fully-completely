---
id: 3
title: "Ship 0.1.3 with the evidence bar and transition rule"
epic: "Framework rules and distribution"
status: in_progress
created: 2026-08-28T19:24:33+00:00
---

# Master Controller Sprint Definition — Sprint 3

**Epic:** Framework rules and distribution — the rules this framework defines have to actually reach the people installing it, and the rules themselves have to be worth reaching them.
**Sprint Objective:** Get the four unpublished commits to users as 0.1.3, add two instruction changes the external-team exchange actually earned, and prove the tarball carries none of this repo's own sprint history.

> **LiveQA's gate is REDEFINED for this sprint, not skipped.** Per CLAUDE.md's
> `## Changes to this repo's own tooling`, LiveQA normally live-tests a
> deployed product in a browser, and that clause says a sprint here should
> skip LiveQA and note why. **That instruction is wrong for this sprint and
> following it would deadlock the sprint** — `/sprint-complete` hard-requires
> a LiveQA PASS (`sprint_lifecycle.py:688`), with no skip flag and no
> override, exactly as sprint 1 discovered.
>
> It is also wrong on the merits here. **The npm package is a deployed
> product.** Sprint 2 proved it: LiveQA found version-reporting lying during
> a real upgrade, a defect no static read of the diff surfaced. This sprint
> publishes a new version of that same artifact, so there is a real live
> test — it just isn't a browser.
>
> **"Live" here means a real `npx fully-completely` upgrade against a
> scratch directory, run after Pipeman publishes.** See LiveQA's section in
> Acceptance Criteria. QA1's static gate applies unchanged.
>
> Note for a later sprint, not this one: the own-tooling clause's blanket
> "LiveQA does not apply here" is now wrong twice over. Fixing that sentence
> is out of scope below.

### Context

Four commits have never been published. `f2557d4`, `2238f44`, `192de1d` and `0fd7973` all landed *after* the 0.1.2 version bump at `64e40c6`, and the version was never moved again. Two of them are the retro edits that exist specifically to fix the failure mode where a requirement asserts external tool behaviour nobody measured. An external team installed on 2026-08-18, a day after those commits existed, and correctly received none of them — they reported the verified-how prompt absent from `templates/sprint-template.md`, and it is absent, because 0.1.2 predates it. The rule written to prevent that class of failure has never reached anyone who installs this framework. That is a distribution gap, and writing it down more carefully does not fix it.

The same exchange produced two instruction changes worth making, each backed by evidence from both teams: a demonstration standard for QA1's FAIL verdicts, and a design rule about where preconditions can safely be added. Everything else that exchange proposed is explicitly out of scope below — most of it was refused with a reason, and the refusals matter as much as the additions.

### Requirements

1. **`.claude/agents/qa1.md` — a FAIL is demonstrated, not argued.** Record the standard that a FAIL is proved with a constructed counterexample, a reproduction, or a command whose output shows the defect — not reasoned from a reading of the code. Cite the real instance: sprint 1's path-encoding blocker was proved by deriving directory names against this machine's actual session directories, and on re-audit the rule was re-derived three ways including a falsification test.

   **1a. The counterweight clause ships in the same paragraph, and this is not optional.** A demonstration standard raises the bar for *recording* a FAIL, which is how an accurate FAIL ends up unrecorded. That already happened here: `192de1d` exists partly because an accurate LiveQA FAIL sat unrecorded waiting on unrelated evidence, stalling sprint 1 in `liveqa_live` until QA1 noticed. Mirror `0fd7973`'s resolution of that on the static side — **one confirmed defect is enough for a FAIL, and an accurate verdict is never held open waiting for evidence that cannot change it.** A CONDITIONAL follows the same rule; it is a FAIL that names what needs fixing, not a softer PASS that can wait.

   **1b. Bound it so it does not become "QA1 writes tests."** Demonstration means evidence the finding is real. It does not mean authoring a test for each finding — that is Dev Team's work and crosses a role boundary. Say so explicitly.

2. **`CLAUDE.md` — the transition rule.** Record it, credited to the external team who named it: *a precondition on a phase transition must be clearable by the role that hits it, or it must ship with a documented cross-role recovery path.* Use `/sprint-ship`'s tree-hash check as the worked example — Pipeman hits it and cannot clear it, only a fresh audit in QA1's session can, and `cmd_qa1` already accepts `dev_agreed_done` specifically so that error is not a dead end.

   **2a. Phrase it as a design constraint, never as a prohibition.** The hash gates are themselves preconditions on transitions and they are this framework's best mechanical protections. A rule that reads as "don't add preconditions" would stop the next good gate from being built. The rule constrains *how* a precondition is added, not *whether*.

3. **`CLAUDE.md` — the state-access convention.** Record that fields added after the initial schema are read with `.get()` and a default, while base-schema fields are indexed directly and stay that way. Include the reasoning inline, because the rule is unusable without it: a missing `phase` is corruption and must fail loudly rather than silently evaluating to `None` and continuing. Reference `cmd_dev_done`'s existing migration comment as the precedent.

   **3a. This exists to prevent a change, not cause one.** No code in `scripts/` is touched for this requirement. It is written down so that the next person adding a state field follows the convention and the one after that does not "fix" the direct indexing.

4. **Bump `package.json` to 0.1.3.** One line. No other change to that file.

5. **The published tarball contains none of this repo's own sprint content.** `.npmignore` already excludes `docs/sprints/registry.json`, `docs/sprints/state/*.json` and `docs/sprints/*/*.md`, and its own comments record that this content shipped unnoticed from the very first publish until sprint 2 looked inside the tarball. **This requirement is that somebody looks inside the tarball again, on this release.** The exclusion mechanism is a denylist with no `files` allowlist in `package.json`, so it fails open: anything new outside those three patterns ships silently.

   **5a. What is at stake, so nobody treats this as ceremony.** The state files contain this machine's home-directory paths and a real client project name (`Licenseprofessor Edits and fixes`), plus an observation about how many directories under `~/Programming` contain spaces. This is information disclosure, not untidiness.

6. **Nothing in `scripts/` changes.** No behaviour change lands in this release beyond the version string. Everything shipping is either already-committed work or documentation.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- Req 1: `qa1.md` states the demonstration standard and cites a real instance. Req 1a's counterweight is present **in the same paragraph or immediately adjacent**, not in a separate section where it can be read independently — QA1 should specifically confirm that a reader who stops after the demonstration sentence still learns that one confirmed defect is enough. Req 1b's bound against test-authoring is explicit.
- Req 2: the transition rule is in `CLAUDE.md` with the ship tree-hash worked example. Req 2a: confirm by reading that the rule constrains how a precondition is added rather than discouraging preconditions — if a reasonable agent could come away thinking "adding a gate is discouraged," it fails this criterion.
- Req 3: the convention is recorded with its reasoning inline. Req 3a: `git diff` shows zero changes under `scripts/`.
- Req 4: `package.json` version is `0.1.3` and the diff to that file is exactly one line.
- **Req 5: run `npm pack --dry-run` and read the file list.** Confirm no `docs/sprints/registry.json`, no `docs/sprints/state/*.json`, no sprint `.md` files under any phase folder, and no `.claude/settings.local.json`. This is a static check that publishes nothing, which is why it belongs to QA1 and not LiveQA — by the time LiveQA can test a published package, a leak is already public and unrecallable. **If anything sprint-related appears in that list, this is a FAIL, not a CONDITIONAL.**
- Req 6: `git diff` against the release base shows changes confined to `.claude/agents/qa1.md`, `CLAUDE.md`, and `package.json`.
- The four commits intended for this release (`f2557d4`, `2238f44`, `192de1d`, `0fd7973`) are ancestors of the commit being audited.

**LiveQA verifies live, after Pipeman publishes (no browser — the package is the product):**

- **Install fresh.** In a scratch directory, run the published 0.1.3 and confirm it installs. Confirm the reported version is `0.1.3` and not something else — sprint 2's live gate caught exactly this lying, so assert on the printed string, not on a file's contents.
- **Upgrade for real, from 0.1.2.** Install 0.1.2 into a scratch directory first, then upgrade to 0.1.3. This is the path that has been live-tested exactly once and failed that once. Confirm the upgrade completes, reports the correct version afterwards, and does not corrupt or discard anything the 0.1.2 install had created.
- **Confirm the retro edits actually arrived.** After upgrading, read `templates/sprint-template.md` in the target and confirm the verified-how prompt is present. This is the entire point of the release — if the prompt is not there, the sprint failed regardless of what else passed. Check `.claude/agents/liveqa.md` for the FAIL-vs-PASS evidence bar the same way.
- **Confirm the new rules arrived too.** `CLAUDE.md` in the target contains the transition rule and the state-access convention; `qa1.md` contains the demonstration standard and its counterweight.
- **Confirm no sprint data landed in the target.** Independently of QA1's tarball check, list `docs/sprints/` in the freshly installed target and confirm it contains only the empty phase-folder skeleton — no registry with our sprints in it, no state files, no sprint markdown.

### Out of Scope

- **The `cmd_status` "whose turn is it" line.** Refused this round, with a reason: the proposal infers "Dev is finished" from a commit landing after the audit timestamp, which is false whenever Dev commits incrementally, and would tell QA1 to audit unfinished work. The real gap may be a missing Dev-side "re-audit me" signal, which is a state change and must clear Req 2's rule first. Separate sprint if it survives that.
- **A new verdict for "correct work on an approach that will not survive."** The finding behind it is real and well-evidenced. The fix is not obviously a verdict, because that has QA1 making a scope judgement that belongs to Master Controller. Needs design, not implementation.
- **The external team's 271-line diff.** Read as a patch, never applied, nothing adopted on this pass. Fourteen modified functions in the gate machinery, scoped by their own account to their problems rather than ours.
- **A LiveQA brief template.** Waiting on their three hand-written briefs. Their inconsistency may turn out to mean no single template is possible, which is a valid answer.
- **Fixing the own-tooling clause's "LiveQA does not apply here" sentence.** It is now wrong twice — sprint 1 and this sprint both redefined the gate rather than skipping it, and following the clause literally deadlocks a sprint. Correcting it is a real change to `CLAUDE.md`'s logic and deserves its own scope, not a drive-by edit inside a release sprint.
- **Adding a `files` allowlist to `package.json`.** The right long-term fix for Req 5's fail-open denylist, and deliberately not done here — changing what ships in the same release where we are verifying what ships means the verification tests the new mechanism rather than the release. Do it next, with its own tarball check.
- **The uncommitted `.vscode/settings.json` change.** Unrelated to this sprint and still in the working tree. Leave it alone; do not commit it.

### Dependencies

- **Blocks:** Every downstream install continues to receive a framework missing the retro edits until this ships. Also blocks any sensible conversation with the external team about their remaining items, since three of their observations were made against a version that predates our fixes.
- **Blocked by:** Nothing. All four commits are already on `main` and already reviewed — `0fd7973` is QA1's CONDITIONAL on `192de1d` being resolved.
- **External:** **What is actually published as 0.1.2 on npm is unverified from inside this repo.** Everything above reasons from git history. The external team's install corroborates it — they received a 0.1.2 without the template change — but that is one data point from a fork. Pipeman should confirm the published contents before assuming what the upgrade diff contains. Flagged as an assumption, not asserted as fact.

### Team Assignments

- **Dev Team 1:** All of it. Three documentation edits and a one-line version bump that must land in a single release.
- **Dev Team 2:** Not assigned. Splitting this would put two sessions in the same release and manufacture a conflict in `CLAUDE.md` for no gain. No worktree needed.

### Risks & Mitigations

- **The demonstration standard makes accurate FAILs go unrecorded.** The highest risk in this sprint, and it has already happened once here in the opposite direction. *Mitigation:* Req 1a makes the counterweight mandatory and in the same paragraph, and the acceptance criterion tests specifically for a reader who stops early.
- **The transition rule is read as "don't add preconditions."** Would discourage the next mechanical gate, which is where this framework's real protection lives. *Mitigation:* Req 2a, plus an acceptance criterion written as a reader test rather than a presence check.
- **The tarball leaks this repo's sprint history and the client name in it.** Fails open by construction; verified inside the tarball exactly once ever. *Mitigation:* Req 5 is QA1's, runs pre-publish, and is a FAIL not a CONDITIONAL. A `files` allowlist is the structural fix and is deliberately deferred so this release verifies the mechanism it actually ships with.
- **The upgrade path breaks.** It has one live test in its history and it failed that one. *Mitigation:* LiveQA's second criterion is a real 0.1.2 → 0.1.3 upgrade, not a fresh install, because those are different code paths and only one of them has ever broken.
- **Coupling the release to two unreviewed doc edits delays the urgent part.** The release unblocks eleven-day-old reviewed work; the edits are new. *Mitigation:* explicit descope path — **if Requirements 1–3 have not passed QA1 by round 2, drop them from this sprint and ship Requirements 4–6 alone as 0.1.3.** The doc edits then get their own sprint and their own release. Master Controller makes that call, not Dev Team, and it is a scope decision rather than a failure.
- **CLAUDE.md is getting long enough that agents may stop reading all of it.** ~290 lines, and every role is instructed to read it before starting. Two additions is fine; the trend is the risk. *Mitigation:* none this sprint beyond keeping both additions short. Noted so it is on the record before the next three arrive.
- **Nothing gates instruction quality.** A `CLAUDE.md` or agent-file edit changes every role's behaviour immediately with nothing testing whether it made things worse. `0fd7973` is the precedent — QA1 caught three real defects in the last instruction edit. *Mitigation:* that is the entire safety net, and it is why this is a sprint with a real audit rather than a direct edit.
- **Our evidence base is two closed sprints; most of what drives Requirements 1–3 comes from one forked team's thirteen.** *Mitigation:* both additions are documentation, reversible in one commit, and neither changes the state machine. That asymmetry is deliberate — the code refusals in Out of Scope are where the thin evidence actually mattered.
