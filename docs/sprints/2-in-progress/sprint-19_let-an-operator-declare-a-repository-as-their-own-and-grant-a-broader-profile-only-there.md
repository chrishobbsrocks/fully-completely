---
id: 19
title: "Let an operator declare a repository as their own, and grant a broader profile only there"
epic: "Framework rules and distribution"
status: in_progress
created: 2026-09-05T14:44:11+00:00
---

# Master Controller Sprint Definition — Sprint 19

**Epic:** Framework rules and distribution — a headless role has to be able to do the work of the project it is running in, and the bound has to come from who owns that project.
**Sprint Objective:** Let an operator explicitly declare a repository as their own, grant a broader headless profile only inside such a repository, and make every part of that grant refuse rather than sanitise.

> **LiveQA's gate is REDEFINED, not skipped**, same as sprints 3–18. **"Live"
> means running roles headless against a published install, in scratch repos
> that are not this one** — including one that is deliberately not a git
> repository, and one carrying an untracked `.env`.

### Context

Sprint 17 gave each role the permissions its job needs and was verified in a downstream project. It solved **"run the target's tests."** A downstream consumer then exercised `dev-team-1` in a real client-shaped project and found it could not perform **any part of a build**: `npx supabase`, `./node_modules/.bin/supabase`, `curl` against the project's own endpoint, `git ls-remote`, and the Supabase MCP tools were each denied. The role recorded every denial and stopped rather than working around it, which was correct, and wrote zero code.

**Sprint 17 did not change this.** The current `dev-team-1` profile is `['Bash(node scripts/run-lifecycle.js *)', 'Bash(python3 scripts/sprint_lifecycle.py *)']` plus one declared test command. All five denied avenues would be denied identically today. The finding is live, not historical, and it is a category error rather than a gap: **the profiles enumerate commands, and a target project's build needs a toolchain nobody here has seen.**

**The missing axis is ownership, and it was Master Controller who had the shape wrong.** The proposed answer was to declare headless building unsupported. Three objections carried that recommendation and all three fell:

- *"Building should stay where a human is watching."* An interactive session already runs with full permissions and nobody audits each Bash call. A session a human launches and walks away from is functionally unattended. **The delta is not reviewed-versus-unreviewed; it is that someone could interrupt.**
- *"A broader declaration is a scope hole, because `testCommand: \"node\"` unscopes three roles."* That is an argument for **validating** declarations, not abandoning them. Sprint 12 did not sanitise `../..`; it rejected it. A validator is checkable and a sanitiser is a puzzle.
- *"A directory-confined broad grant is blanket bypass in a different hat."* **Refuted by this project's own findings document.** Sprint 12 tested it: `printf ... > /tmp/outside-file.txt` from inside a different working directory was blocked with the identical directory bound, *"enforced at the Bash-redirect level too, not only at the Write-tool level."* The confinement this grant rests on is verified by running, not assumed.

**The bound that actually matters is git, and it is not universal.** Every downstream gate — QA1 on the code, Pipeman as the only pusher, LiveQA on the deployed result — assumes a mistake is recoverable, and that assumption is entirely git's. **`.env` sits outside git by convention in every target project.** The file whose loss costs most is the one git cannot restore, and no gate in this framework runs early enough to prevent it.

**Uncommitted work is a live case, not a thought experiment.** The consumer had two sessions interleaving in one checkout the same day this was reported.

### Requirements

1. **An operator may declare a repository as their own, and the declaration is validated, never sanitised.** A malformed, ambiguous or over-broad declaration is **refused with a message naming what was wrong** — never coerced into something acceptable. This is the same principle sprint 12 applied to `../..` and the reason it worked.
   - **The default is unchanged.** No declaration means exactly today's narrow profile. The broad grant is opt-in, per repository, by an explicit act.

2. **The grant requires the target to be a git repository. Refuse otherwise.** Git is the recovery boundary every downstream gate assumes, and outside a repository none of QA1, Pipeman or LiveQA runs early enough to prevent a loss. **This refuses rather than warns** — a warning is a thing an unattended run cannot read.

3. **`.env*` is readable and never writable or deletable, inside the grant.** It is the highest-cost, lowest-recoverability file in a typical target and it is untracked by convention, so git cannot restore it. **A narrow, checkable refusal beats a general rule about secrets**, which would be a puzzle rather than a validator.

4. **State what the grant does about uncommitted work, and make it a decision rather than a silence.** Two sessions interleaving in one checkout is a real case that has already happened. Whether the grant refuses on a dirty tree, warns, or proceeds is open — **but it must be chosen deliberately and recorded**, and "proceeds" needs its reasoning stated, not assumed.

5. **The directory confinement is the load-bearing bound. Re-verify it rather than citing it.** Sprint 12 established it symmetrically for the Write tool and Bash redirection. **Confirm it still holds** under whatever the broad profile grants — a bound verified against a narrow profile is not automatically a bound under a wide one.

6. **The declared test command is validated, folded in from sprint 18.** A bare interpreter — `node`, `bash`, `sh`, `python3` — yields `Bash(node *)` and arbitrary execution through `-e`. **Reject it as too broad, in the same place and by the same reasoning as Req 1.** State what the rule does not catch; a rule claiming completeness will be wrong.
   - **Severity, stated accurately:** `install.js` writes `fullyCompletely.testCommand: ""` as its default, and `readDeclaredTestCommand()` resolves empty to `null`, so **no allowlist entry is injected unless a project deliberately sets one.** This is a configuration hazard, not a shipped exposure — nobody is exposed by installing. It still needs fixing, because a project whose suite genuinely runs as `node test/all.js` may shorten it, but the requirement must not be written as though installs are currently unscoped.

7. **Every downstream gate stays exactly as it is.** QA1 audits the code, Pipeman remains the only pusher, LiveQA tests the deployed result, and `--user-said` still gates closure. **This sprint widens what a role may do inside one directory; it widens nothing about how work leaves that directory.**

8. **Bump `package.json` to 0.1.19.** One line. *Sprint 16 keeps 0.1.18 and ships first; sprint 18 moves to 0.1.20 and shrinks, since Req 6 absorbs its first requirement.*

9. **Test coverage in `scripts/launcher_test.js`.** At minimum: no declaration yields today's profile unchanged; a valid declaration in a git repo yields the broad profile; a declaration in a non-git directory is refused; a malformed declaration is refused with a message; a bare-interpreter test command is refused; `.env` is not writable under the broad profile.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **This sprint grants more than any other in this project. Audit it as such.** For each requirement, the question is what it **refuses**, not what it enables.
- **Req 1: try to defeat the validator rather than confirm it.** Relative paths, symlinks, a declaration naming a parent of the repository, a declaration naming a path the operator does not own, whitespace and case variations. **Any input that yields a grant outside the declared directory is a FAIL, not a CONDITIONAL.** List what was tried and what the rule is stated not to catch.
- **Req 2 and Req 3 refuse, and refusal is demonstrated.** A non-git directory is refused; a write to `.env` under the broad profile is blocked; a read of `.env` still works. Demonstrate each, in that order, rather than reading the code path.
- Req 4: confirm a decision was made and its reasoning recorded. **An unstated default is the defect**, whichever behaviour was chosen.
- **Req 5 is the load-bearing check.** Re-run sprint 12's own test under the broad profile: a redirect to an absolute path outside the working directory must still be blocked. **If the wider grant loosens the directory bound, this is a FAIL** — that bound is the entire basis on which this sprint was argued.
- Req 6: bare interpreters refused, and the stated gaps named.
- **Req 7: `git diff` shows nothing touched in `cmd_ship`, `cmd_complete`, `cmd_qa1` or `cmd_liveqa`.** If this sprint changed how work leaves a directory, it exceeded its scope.
- Req 8: `package.json` is `0.1.19`, one-line diff.
- Req 9: **run the suite.**
- Run `scripts/verify-tarball.sh`.

**LiveQA verifies live, after Pipeman publishes:**

- **Confirm 0.1.19 is on the registry**, verifying published bytes against the audited commit per sprint 13's rule.
- **The finding that started this, reversed.** In a scratch project with a real toolchain — its own `package.json`, a dependency, a network-touching command — declare ownership and run `dev-team-1` headless. It must be able to actually build, where in sprint 15's and this finding's runs it could do nothing.
- **The three refusals, observed.** A non-git directory refused. A `.env` write blocked while a read succeeds. A bare-interpreter test command refused. **Each demonstrated, not inferred.**
- **The confinement holds under the broad grant.** A write outside the declared directory is blocked. This is the one that matters most.
- **The default is untouched.** A target with no declaration behaves exactly as 0.1.17 did.
- **Try to force a denial**, as in sprint 18's criterion. If it cannot be forced because the role behaves correctly, **say so plainly** — an unobservable bound recorded as unobserved is worth more than one assumed sound.

### Out of Scope

- **Client-owned repositories.** This grant is for a repository the operator declares as their own, on their own machine. **Nothing here makes unattended broad grants safe in someone else's accounts**, and nobody should read it as evidence that they are.
- **Blanket `bypassPermissions`.** Refused in sprint 12 on evidence and still refused. This is a scoped grant with a verified directory bound, not a bypass.
- **Anything about how work leaves the directory.** See Req 7.
- **Sprint 18's remaining items** — the `:543` comment that generalises from one verb, and the `; echo $?` compound-command decision. Both stay in sprint 18, which shrinks to those.
- **The grandchild process question.** Still genuinely untested since sprint 15.
- **The disclosure sweep**, unscheduled since sprint 4.

### Dependencies

- **Blocks:** A downstream consumer's Milestone 2, which runs entirely on operator-owned repositories and cannot run at all under the current profiles.
- **Blocked by:** Sprint 16 shipping as 0.1.18.
- **External:** The consumer is running the affected roles interactively meanwhile, so nothing is stalled. Their framing of the cost is the accurate one and worth keeping: this does not restore supervision, it restores **launches** — five to seven per sprint.

### Team Assignments

- **Dev Team 1:** All of it.
- **Dev Team 2:** Not assigned.

### Risks & Mitigations

- **The grant escapes the declared directory**, which would make every argument for this sprint false. *Mitigation:* Req 5 re-verifies sprint 12's own confinement test under the wider profile, as a FAIL-level criterion, and LiveQA repeats it against the published build.
- **An operator declares a repository they do not own**, or a client repository. *Mitigation:* accepted and named. The declaration is an explicit, auditable act on the operator's own machine; the framework cannot know who owns what, and pretending otherwise would be a worse lie than trusting a deliberate statement. Out of Scope says plainly that this is not evidence for client-repo automation.
- **`.env` protection is treated as secret protection generally.** It is not — it is one narrow, checkable refusal for the highest-cost unrecoverable file. *Mitigation:* Req 3 states the scope; a general rule about secrets would be a sanitiser, and sanitisers are puzzles.
- **The validator is too strict and operators route around it** by declaring something worse. *Mitigation:* Req 1 requires naming what the rule does not catch, which forces the boundary to be described rather than assumed.
- **This sprint is read as a precedent for widening.** It is a grant justified by ownership, verified confinement, and four downstream gates that are unchanged. *Mitigation:* Req 7 and its `git diff` criterion.
