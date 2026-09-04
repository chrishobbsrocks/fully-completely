---
id: 16
title: "Make the baseline table maintain itself, and stop tests breaking on its drift"
epic: "Honest reporting"
status: todo
created: 2026-09-04T02:30:00+00:00
---

# Master Controller Sprint Definition — Sprint 16

**Epic:** Honest reporting — a threshold this project set for itself, passed twice and not acted on.
**Sprint Objective:** Wire baseline regeneration into the release path so the table cannot silently fall behind, and decouple the tests that break whenever it does.

> **LiveQA's gate is REDEFINED, not skipped**, same as sprints 3–15 and for the
> same mechanical reason (`sprint_lifecycle.py:688`). **"Live" means installing
> the published artifact and confirming its baseline table covers what it
> should**, which is the only place the drift becomes visible to a user.

### Context

**The table is six releases behind and nothing notices.** `scripts/baselines/user-owned-content.json` covers `0.1.0`–`0.1.8`. The registry is at `0.1.14`. Nothing regenerates it — `generate.js` appears in no shell script, no `package.json` entry, and no agent file. It is regenerated when someone remembers.

**The consequence is a fixture breakage that has now recurred four times.** `scripts/launcher_test.js` contains tests asserting that a file matches the **committed** baseline table, and its own comments say the quiet part: *"'a file matching a published baseline' needs a file this repo hasn't since changed."* So whenever a user-owned file legitimately changes in a release, a test coupled to the stale table breaks. It gets fixed in the round it appears and the cause survives.

**QA1 flagged the generator drifting in sprint 9's notes and again in sprint 10's.** This is the fourth occurrence.

**And this project set an explicit threshold for exactly this.** Sprint 9's Out of Scope, in Master Controller's words: *"If any of the three recurs after this sprint ships, that is the evidence that a mechanical gate is warranted, and it should be built then rather than pre-emptively."* QA1 recorded recurrence one during sprint 12. **The threshold passed two sprints ago and nothing was built.** QA1's framing is the accurate one: it keeps getting worked around in the round it appears, which is exactly how it stays invisible.

**Sprint 9 chose the other half deliberately, and that choice was right.** LiveQA offered either regenerating the table or making the message degrade honestly without a baseline entry; Dev Team took the message fix. That closed a user-facing falsehood and was the better of the two under time pressure. It left the drift, which is what this sprint is for.

### Requirements

1. **A stale baseline table fails a check, mechanically.** Prose in an agent file is not a fix — sprint 9 fixed the publish ordering that way and it drifted on the very next release. The check belongs where a release already runs one: `scripts/verify-tarball.sh` or the test suite. **It must fail when the table's newest covered version is not the last published version**, and it must say which versions are missing.
   - **Covering through N-1 is correct, not a gap.** A table shipped *in* version N cannot contain N's own hashes, because they do not exist until publish. The check must encode that, or it will fail on every correct release.

2. **Regeneration is a real step, not a remembered one.** Whatever produces the table on a release must be runnable and documented at the point it is needed. If the answer is a `package.json` script, note that `scripts` is currently `{}` and every entrypoint is invoked by path from memory — this is a chance to fix that or a reason not to, and either is acceptable if stated.

3. **The tests stop breaking when a user-owned file legitimately changes.** The coupling is real: a test that asserts "this file matches a published baseline" needs a file the repo has not since changed, and the repo keeps changing files. **Either pick the file/version pair dynamically from the table**, or **freeze a fixture that is deliberately separate from the live table** and say which, and why. What must not survive is a test whose passing depends on nobody editing a particular agent file.

4. **Bump `package.json` to 0.1.17.** One line.

5. **Test coverage.** The stale-table check must itself be tested in both directions — a current table passes, a table missing the last published version fails and names it. A check that can only say PASS retires the manual habit that was working, which is the trap LiveQA named when it verified sprint 13's `verify-publish` against its negative case.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1 both directions, demonstrated.** Run it against the current (stale) table and confirm it fails naming `0.1.9` through the latest; regenerate and confirm it passes. **A check verified only in the passing direction does not clear this.**
- Req 1: confirm the N-1 rule is encoded rather than assumed, and that a correct release does not trip it.
- Req 2: confirm the regeneration step exists somewhere a release actually reaches, and that the reasoning about `package.json` scripts is stated either way.
- **Req 3: read the chosen approach against the failure it must prevent.** If a future edit to an agent file would still break a test, it is not fixed. Name which tests were coupled and what they are coupled to now.
- Req 4: `package.json` is `0.1.17`, one-line diff.
- Req 5: **run the suite**, and confirm the negative case is covered.
- Run `scripts/verify-tarball.sh`.

**LiveQA verifies live, after Pipeman publishes:**

- **Confirm 0.1.17 is on the registry**, verifying published bytes against the audited commit per the rule sprint 13 documents.
- **The published table is current.** Install the published artifact and confirm its baseline table covers through `0.1.16` — the release before this one. This is the state that has been wrong since 0.1.9 and that no user could have detected.
- **The upgrade path still works** on a real pre-manifest install, since the table is what proves a file untouched. A regenerated table must not change any existing hash — only add versions.
- **macOS and Windows both unaffected**, if a Windows machine is obtainable; record plainly if not.

### Out of Scope

- **The conflict message's degrade-honestly behaviour** from sprint 9. It works, it is correct, and it stays — this sprint removes the drift it compensates for, not the compensation.
- **Sprint 14's Windows work and sprint 15's live-loop window.** Both queued ahead.
- **Any other stale-data check.** This one has four instances; nothing else does.
- **The disclosure sweep**, unscheduled since sprint 4.
- **The uncommitted `.vscode/settings.json` change.**

### Dependencies

- **Blocks:** Nothing, but the fixture breaks again on any release that touches a user-owned file, which sprint 14 does.
- **Blocked by:** Sprints 14 and 15 shipping, on the shared `package.json` version line. Sequential: 0.1.15, 0.1.16, then 0.1.17.
- **External:** None.

### Team Assignments

- **Dev Team 1:** All of it.
- **Dev Team 2:** Not assigned.

### Risks & Mitigations

- **The check encodes N-1 wrongly and fails every correct release**, gets marked flaky, and is ignored. That is how a gate becomes noise. *Mitigation:* Req 1 states it and QA1 confirms a correct release does not trip it.
- **Req 3 is solved by deleting the coupled tests** rather than fixing the coupling, removing coverage instead of fragility. *Mitigation:* QA1's criterion asks which tests were coupled and what they are coupled to now — an answer of "removed" needs to be defended, not assumed.
- **Regeneration changes an existing hash**, which would invalidate proof for files already installed in the field. *Mitigation:* LiveQA's criterion — only additions, no changes to existing entries.
- **This sprint gets deferred again**, since nothing user-facing is broken and the fixture is fixable in the round. *Mitigation:* none available in a sprint file. The threshold was already passed twice; recording that is the only honest mitigation, and it is in the Context.
