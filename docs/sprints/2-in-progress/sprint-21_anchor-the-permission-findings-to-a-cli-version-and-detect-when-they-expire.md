---
id: 21
title: "Anchor the permission findings to a CLI version, and detect when they expire"
epic: "Honest reporting"
status: in_progress
created: 2026-09-06T02:09:00+00:00
---

# Master Controller Sprint Definition — Sprint 21

**Epic:** Honest reporting — evidence about someone else's software has a shelf life, and ours records none.
**Sprint Objective:** Anchor every confirmed permission finding to the `claude` version it was confirmed against, identify which have already expired, and make the staleness detectable instead of silent.

### Context

`docs/sprint-12-permission-scope-findings.md` is the evidence base for this framework's entire permission model. Sprints 12, 17 and 19 all rest on it — the scoped profile, the per-role allowlists, and the broad owned-repository grant were each argued from entries in that document.

**It records no `claude` version. Anywhere.** Every entry graded CONFIRMED asserts a behaviour of software this project does not control, with nothing saying which build of that software was observed. Sprint 12's testing ran at roughly `2.1.257`–`2.1.258`; the CLI is now `2.1.261`.

**QA1 has carried this forward as "the strongest-evidenced open item" across at least sprints 19 and 20, noting that one CONFIRMED entry has already expired.** It stayed unscheduled because Master Controller was reading the findings and recommendations in those audits and not the carried-items list — which is the same failure as everything else this epic: a determination recorded where nobody was looking.

The consequence is specific rather than theoretical. A confirmation that silently stops being true does not fail loudly; it keeps being cited. Sprint 19's grant is bounded partly by `.env` protection and by `git push` sitting in DISALLOWED — both confirmed by running, both against an unrecorded version, both cited since as settled.

### Requirements

1. **Every confirmed entry records the `claude --version` it was confirmed against.** Retrofit the existing document and make it the standing form for new entries. An entry without a version is not CONFIRMED — it is a claim about an unspecified build.

2. **Identify which entries have already expired, by re-running them against the current CLI.** QA1 reports at least one. **Find out how many.** Re-verify every CONFIRMED entry the permission model actually depends on — at minimum the ones sprints 17 and 19 cite — and grade each again: still confirmed, expired, or now unverifiable. **Do not assume an entry survives because nothing broke.** Nothing breaking is what silent expiry looks like.

3. **Make staleness detectable rather than silent.** When the running CLI differs from the version an entry was confirmed against, that should be visible to whoever is about to rely on it. Where that check lives — the findings document, a test, the launcher — is Dev Team's call. **What must not survive is a document that reads as current while resting on a build nobody is running.**
   - **It warns; it does not gate.** A version difference is not a defect and must not block a run. The failure mode to avoid is a check so noisy it gets ignored, which is what happened to the `repo=` banner.

4. **Bump `package.json` to 0.1.22.** One line.

5. **Test coverage** for whatever Req 3 becomes, if it is code. If it is documentation, say so rather than adding a test for its own sake.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 2 is the load-bearing check and it cannot be cleared by reading.** Confirm each re-verification was actually run, and that the grading distinguishes *still confirmed* from *not re-tested*. **An entry silently carried forward as CONFIRMED without a fresh run is the exact defect this sprint exists to fix** — that is a FAIL, not a CONDITIONAL.
- Req 2: confirm the count of expired entries is stated. "At least one" is where this sprint started; it is not an acceptable place to finish.
- Req 1: confirm the retrofit covers the document rather than only new entries, and that any entry which could not be re-verified is downgraded rather than left CONFIRMED with a guessed version.
- Req 3: confirm it warns and never gates, and read it against the `repo=` banner — a check nobody reads is a check that does not exist.
- Req 4: `package.json` is `0.1.22`, one-line diff.
- Req 5: run whatever suite applies.
- Run `scripts/verify-tarball.sh`.

**LiveQA verifies live, after Pipeman publishes:**

- **Confirm 0.1.22 is on the registry**, verifying published bytes against the audited commit per sprint 13's rule.
- **Re-run a sample of the re-verified entries yourself**, against the published artifact and the CLI you are actually running. This document is the basis of the permission model, and a re-verification nobody independently repeated is one team's word.
- **The staleness signal appears** when the running CLI differs from a recorded one, and **does not block** the run.
- **The permission model still behaves as documented** — the `.env` refusal, `git push` denied while `git status` passes, and a bare interpreter rejected. Those are the three the grant is argued from.

### Out of Scope

- **Changing any permission behaviour.** This sprint records what is true and detects when that changes. If a re-verification finds a behaviour has genuinely changed, **that is a finding for the next sprint**, not a fix to make here — and it should be recorded loudly rather than quietly corrected.
- **The other carried items** QA1 lists: every allowlist entry other than git and npm remaining inferred, the empty-string `ownedRepository` declaration falling through silently, and the `--agents` argv budget against Windows' 32,767-character limit. Real, tracked, and separately scoped.
- **The disclosure sweep**, unscheduled since sprint 4.
- **The grandchild process question**, untested since sprint 15.
- **The uncommitted `.vscode/settings.json` change.**

### Dependencies

- **Blocks:** Nothing directly. But every sprint that cites the findings document — which is every permission sprint — cites evidence of unknown age until this lands.
- **Blocked by:** Sprint 20 completing its live gate.
- **External:** A downstream consumer's own metering notes anchor their findings to `claude --version 2.1.258` explicitly. **They got this right and we did not**, and their document is the model for the form Req 1 should take.

### Team Assignments

- **Dev Team 1:** All of it. Req 2 is the bulk and it is re-running, not reading.
- **Dev Team 2:** Not assigned.

### Risks & Mitigations

- **Re-verification is done by reading the old entries and agreeing with them.** That produces a document that looks freshly confirmed and is not. *Mitigation:* QA1's criterion makes a carried-forward CONFIRMED a FAIL, and LiveQA independently re-runs a sample.
- **The staleness check becomes noise** and is ignored the way the `repo=` banner was through four wrong readings. *Mitigation:* Req 3 requires it to warn rather than gate, and QA1 reads it against that precedent specifically.
- **An expired entry turns out to invalidate a shipped grant.** *Mitigation:* Out of Scope says to record it loudly rather than fix it here — a permission behaviour that changed under us deserves its own sprint and its own decision, not a quiet correction inside a documentation sprint.
- **This is the seventh consecutive sprint about the framework's own machinery.** *Mitigation:* named, not mitigated. This one has a sharper claim than most — the evidence under the permission model is of unknown age — but the pattern stands, and the two oldest backlog items still have users on the other end while this does not.
