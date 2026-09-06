---
id: 22
title: "Read what the package actually ships, and record two budgets nobody is watching"
epic: "Framework rules and distribution"
status: in_progress
created: 2026-09-06T15:12:30+00:00
---

# Master Controller Sprint Definition — Sprint 22

**Epic:** Framework rules and distribution — we have never read what we publish, and we publish permanently.
**Sprint Objective:** Read every file this package ships, for disclosure rather than correctness, and record two budgets that currently move only one way.

### Context

**Sprint 4 scrubbed a real client's name out of `scripts/launcher/session.js` after it had already been published to npm in 0.1.2**, past the 72-hour unpublish window and therefore permanent. We fixed that one instance. **We have never read the rest of the package with that question in mind**, and it has been unscheduled for **seventeen sprints** — since sprint 4 itself, cited in Out of Scope in almost every sprint since.

The tarball has grown continuously in that time: baseline tables generated from published artifacts, install manifests, a permission-scope findings document, and every agent file. None of it has been read for what it *discloses* rather than for whether it *works*. QA1 audits diffs against requirements; LiveQA tests behaviour; `verify-tarball.sh` checks that sprint data is excluded and that expected paths are present. **No gate in this framework has ever asked what a shipped file reveals.**

This is the only security-adjacent failure that has actually occurred here, and its cost profile is unique among the open items: npm does not forget, and a second instance would be as permanent as the first.

**Two budgets are also unwatched, and both move in one direction only.**

The `--agents` argv payload: `headlessLaunchArgs()` builds `JSON.stringify({ [role.id]: definition })`, one role per launch, on the headless path only. Measured today, the largest role — `master-controller.md` — is **14,164 characters JSON-escaped against Windows' 32,767-character `CreateProcess` limit: 43% used, 18,603 remaining.** That is comfortable now. It is also monotonic: every rule added to an agent file spends headroom, sprints 14, 18 and 20 each added one, and nothing ever reclaims any. QA1 has carried this as informational across several sprints, correctly — it is not a defect and not a workshop risk, since the interactive path passes no `--agents` at all.

And LiveQA has now self-reported **four instances** of probing a neighbouring surface before the one under test — most recently checking `pipeman`'s base profile rather than the owned-repository grant's lists, which briefly made documented behaviour look wrong. Every one was caught before a verdict. That is exactly the shape sprint 20 fixed for the forced-denial method, and the fix that worked there was not stating a method but making it **a claim that must be attributed**.

### Requirements

1. **Read every file in the published tarball, for disclosure.** Not for correctness — for what it reveals. Names of real people or organisations other than the author, client or project identifiers, absolute paths carrying a username or directory structure, internal URLs, tokens or key-shaped strings, email addresses, machine names, and anything that describes a third party's work.
   - **The author's own name and repository URL are deliberately not in scope** — they are already public via `package.json`'s author field and the repository link, and treating them as findings would bury the real ones.
   - **Enumerate what was read**, so the next sweep can start from a list rather than re-deriving it. A sweep that cannot be repeated is a one-off.

2. **Report findings without fixing them in the same commit.** If something is found, **record it and stop.** A disclosure finding may need a decision about whether it can be scrubbed at all — sprint 4's could not be unpublished, only stopped from recurring — and that decision belongs to the user, not to whoever runs the sweep.
   - **A clean result must be stated as a result**, with the list of what was read. "Nothing found" and "nobody looked" are indistinguishable in a record that says neither.

3. **Add a disclosure check to `scripts/verify-tarball.sh`** for whatever classes the sweep shows are worth catching mechanically. **Do not attempt a general secret-scanner** — a narrow, checkable refusal beats a rule that claims completeness, which is the principle sprints 12 and 19 both arrived at. If a class cannot be checked reliably, say so rather than shipping a check that gives false comfort.

4. **Record the `--agents` argv budget as a number, in the code.** 14,164 of 32,767 characters, one role per launch, headless path only, measured against `master-controller.md` at this commit. State that it is monotonic and that agent-file additions spend it. **This is a recorded budget, not a defect** — the point is that the next rule added to an agent file is spent knowingly rather than discovered at 100%.

5. **Add the neighbouring-surface rule to `liveqa.md`**, in the form that worked for the forced-denial method: **not "check the right surface," but "name which surface you probed."** A method is skipped; an attribution is not. Include the four instances, as sprint 20 included the two.

6. **Bump `package.json` to 0.1.23.** One line.

7. **Test coverage** for Req 3 if it becomes a check. Reqs 1, 2, 4 and 5 are a sweep, a record and prose — **say so rather than adding tests for their own sake.**

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1 is the sprint, and it cannot be cleared by reading the report.** Confirm the enumeration covers what `npm pack --dry-run` actually lists, file for file. **A file present in the tarball and absent from the enumeration is the defect** — the whole failure mode is a file nobody looked at.
- Req 1: confirm the author's own identifiers were excluded deliberately and that the exclusion is stated, not silently applied.
- Req 2: if findings exist, confirm nothing was scrubbed in the same commit. **If the result is clean, confirm it is recorded as a clean result with its list** — an unstated clean sweep is worth nothing later.
- Req 3: confirm the check refuses narrowly and that anything unreliable is named as unchecked rather than covered. **A check that gives false comfort is worse than no check**, and this sprint is the one place that trade is decided.
- Req 4: confirm the number matches a measurement taken at this commit, not a carried-forward figure. Re-measure it.
- Req 5: read it against the four instances. **If it would not have caught the `pipeman` base-profile probe, it is not written correctly.**
- Req 6: `package.json` is `0.1.23`, one-line diff.
- Req 7: run whatever suite applies.
- Run `scripts/verify-tarball.sh`.

**LiveQA verifies live, after Pipeman publishes:**

- **Confirm 0.1.23 is on the registry**, verifying published bytes against the audited commit per sprint 13's rule.
- **Read the published tarball yourself, independently of the sweep's report.** Download it, extract it, and spot-check the enumeration against what is actually in it. This is a document nobody has ever produced before; one team's word on it is one team's word.
- **The disclosure check fires and refuses**, if Req 3 produced one — construct the class it catches and confirm it fails the tarball verification.
- **The install path is unaffected** — a fresh install and an upgrade both behave as they did on 0.1.22.

### Out of Scope

- **Fixing anything the sweep finds.** See Req 2. Findings get recorded and decided, not quietly corrected — a disclosure that has already shipped cannot be undone, and pretending otherwise is worse than naming it.
- **A general secret-scanning dependency.** This is a read of a small package, not a tooling adoption.
- **The grandchild process question**, untested since sprint 15 — LiveQA's kill test watched the direct child only and the pgid observed cannot distinguish a group kill from the child exiting.
- **The carried allowlist inferences** — every entry other than `git` and `npm` remains inferred, narrowed in sprint 18 and not closed.
- **The empty-string `ownedRepository` declaration** falling through silently.
- **The uncommitted `.vscode/settings.json` change**, twenty-two sprints running.

### Dependencies

- **Blocks:** A meaningful 0.2.0. This is the last inward debt — calling the package 0.2.0 while never having read what it ships would be a version number asserting something nobody checked.
- **Blocked by:** Nothing. Sprint 21 shipped as 0.1.22 and the board is empty.
- **External:** Nothing. **This sprint serves whoever installs the package rather than any consumer**, which is deliberate: six of the last eleven sprints descended from one consumer's brief, and four served the framework's own users.

### Team Assignments

- **Dev Team 1:** All of it. Req 1 is reading, and it is the bulk.
- **Dev Team 2:** Not assigned.

### Risks & Mitigations

- **The sweep is performed by grepping for patterns rather than reading**, and misses anything not pattern-shaped — which is what sprint 4's finding was, a client name inside a plausible-looking example string. *Mitigation:* Req 1 requires an enumeration of files read, and QA1 checks it against `npm pack --dry-run` file for file.
- **A clean result is recorded as "nothing found" with no list**, making it indistinguishable from nobody looking. *Mitigation:* Req 2 and its criterion require the list either way.
- **Req 3 ships a scanner that gives false comfort** and future sweeps get skipped because "the check covers it." *Mitigation:* narrow refusals only, and anything unreliable named as unchecked.
- **The argv budget is recorded and then ignored**, the way the `repo=` banner was. *Mitigation:* accepted. It is a number in a comment, not a gate, and its value is that the next person adding a rule can see the cost — if it ever becomes urgent it will be because someone crossed it, and then it earns a check.
