---
id: 20
title: "Make the framework describe itself accurately in the five places it doesn't"
epic: "Honest reporting"
status: in_progress
created: 2026-09-05T21:10:55+00:00
---

# Master Controller Sprint Definition — Sprint 20

**Epic:** Honest reporting — a framework's description of itself is its interface, and five parts of ours are wrong.
**Sprint Objective:** Correct the five self-descriptions that have each caused a real misreading, in the files that reach every install.

> **LiveQA's gate is REDEFINED, not skipped** — and **Req 1 is the requirement that
> makes this header unnecessary.** Fourteen sprint files now carry a paragraph
> like this one. "Live" here means confirming the corrected files reach a real
> install and read correctly to someone who has not followed this project.

### Context

Every item below is a place where this framework says something untrue or ambiguous **about itself**, in a file that ships to every install. None is a code defect. All five have a recorded instance of someone acting on the wrong reading, and since 0.1.6 corrections to these files actually reach installs that already exist — which is what makes fixing them worth doing rather than only fixing them going forward.

**1. LiveQA is defined as browser-only, and it is not.** `liveqa.md` says the role trusts *"a real, running browser, nothing else."* **Fourteen sprint files** now open with a paragraph redefining "live" for that reason. That is not a workaround succeeding fourteen times; it is a definition that is wrong, restated fourteen times. What the role actually does — verify the released artifact in a real environment, after distribution — covers a browser and an npm install equally, and its record here is the strongest of any gate: it caught an unpublished release, two commit-record mismatches, two unsatisfiable criteria, a silent Windows failure, a program-mediated write escaping a bound, and three of its own bad measurements.

**2. `CLAUDE.md` says LiveQA's gate does not apply to this repository, while the code refuses to close a sprint without it.** `CLAUDE.md:267` versus `sprint_lifecycle.py:688`. The prose says skip it; the command refuses. Listed in Out of Scope since sprint 6.

**3. The same section reads as being about the *target* when installed.** `CLAUDE.md` is `USER_OWNED`, so it ships into every project. Its "Changes to this repo's own tooling" section names *"this repository itself (`scripts/`, `.claude/`, `templates/`, this file)"* — and a consumer reading their installed copy sees that pointing at their own `scripts/`, with `sprint_lifecycle.py` sitting in it. **A downstream team nearly edited framework internals on that reading**, and stopped only because their own boundary held. They flagged the ambiguity on day one; this was its first real instance.

**4. LiveQA's own method for observing a permission bound was wrong, and it recorded the wrong conclusion twice.** At sprints 17 and 19 it reported that a denial could not be forced, honestly and with the limitation named. Sprint 18 found the cause: it had been instructing roles to do things *outside their job*, so they refused on process grounds and the permission layer was never consulted. Given a task the role genuinely needed the missing tool for, the bound was observed immediately. **Two roles defeating a probe by behaving correctly looks identical to an unobservable bound and is not.**

**5. `run-role.js:1016-1024` now understates its own evidence.** It reads *"Confirmed: git. Inferred, not established: npm."* Sprint 18 established npm directly — `Bash(npm pack *)` matched a bare `npm pack` with zero denials **and produced the tarball**, which is proof it ran rather than proof it was not denied. First comment in this epic needing correction because the evidence improved rather than because it overclaimed.

**REMOVED BEFORE BUILD — and the removal is the rule demonstrating itself.** *This sprint originally carried a sixth requirement asking for a half-edit rule in `master-controller.md`. Dev Team found it already there as step 7, added during sprint 18 as Req 4's companion, with better wording than this sprint asked for — including a clause about clearing stale Risks and LiveQA criteria in the same edit. Master Controller offered to fold it into sprint 18, got no answer, and wrote it into sprint 20 without checking whether the file already had it. Leaving it would have been the fourth instance of the defect the rule prevents.* The original context follows, kept because it is the rule's evidence:

**One rule with three instances, all Master Controller's.** A requirement absorbed into another sprint was recorded in Dependencies and left standing in Requirements — a half-edit that had Dev Team asking whether to rebuild shipped, audited code. Same shape as sprint 14's line 38 and sprint 19's compensating-controls clause: a claim corrected in one place and left standing in another.

### Requirements

1. **Redefine LiveQA by what it does, not by the surface it usually does it on.** `liveqa.md`'s description and `CLAUDE.md`'s table entry. **Verify the released artifact in a real environment, after distribution** — a browser is the common case, not the definition. Say explicitly that an `npx` install into a scratch directory is the same gate, so a project with no deployed product does not have to reinvent the reasoning every sprint.
   - **Do not weaken what the role refuses.** It still does not read code, does not trust a static pass, and re-verifies live every time. Those are the properties that produced its record.

2. **Correct `CLAUDE.md`'s claim that LiveQA's gate does not apply here.** It contradicts `sprint_lifecycle.py:688`, which refuses to close a sprint without a LiveQA PASS and has no override. Once Req 1 lands, the honest statement is that the gate applies and the surface differs.

3. **Disambiguate "this repo" throughout the own-tooling section, for a reader inside an installed target.** The section is correct about *this* repository and dangerous when read from a target. **A consumer must be able to tell, from the installed copy alone, that it does not license editing `scripts/` in their own project.** Whether that means naming the framework explicitly, scoping the section, or something else is Dev Team's call — the requirement is that the misreading becomes impossible, not merely unlikely.

4. **Record the forced-denial method in `liveqa.md`.** To observe a permission bound, give the role a task it genuinely needs the missing tool for. Instructing it to act outside its job tests the role's judgement, not the profile — it refuses on process grounds and the permission layer is never reached. **Include that "cannot be forced" was recorded twice before the method was found**, because the honest-but-wrong conclusion is the thing this prevents.

5. **Promote npm at `run-role.js:1016-1024`.** Two real verbs now, citing sprint 18's gate. **Keep the caveat that every other entry on the list remains inferred** — the correction is one entry, not the general claim.

6. **Bump `package.json` to 0.1.21.** One line.

7. **No test coverage is expected.** These are prose corrections in files with no test surface. **Say so rather than adding a test for its own sake**, and confirm the existing suites pass untouched.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1 read cold, by the standard that matters: would a project with no deployed product still know what to do?** If it would, the fourteen header paragraphs become unnecessary. Confirm the refusals — no reading code, no trusting a static pass, re-verify every time — are intact and not softened.
- Req 2: confirm the contradiction with `sprint_lifecycle.py:688` is gone, and that nothing now claims a gate is skippable when the code refuses.
- **Req 3 is the one with a near-miss behind it. Read the section as a consumer inside an installed target, not as a maintainer.** If it can still be read as licensing edits to their own `scripts/`, it fails. This is not a wording preference — a downstream team nearly acted on it.
- Req 4: confirm the method is stated *and* that the two wrong conclusions are named. A method without its failure history reads as obvious and gets skipped.
- Req 5: confirm exactly one entry was promoted and the general caveat survives.
- Req 6: `package.json` is `0.1.21`, one-line diff.
- Req 7: confirm existing suites pass and that no test was added for its own sake.
- Run `scripts/verify-tarball.sh`.

**LiveQA verifies live, after Pipeman publishes:**

- **Confirm 0.1.21 is on the registry**, verifying published bytes against the audited commit per sprint 13's rule.
- **The corrections reach an existing install.** Upgrade a pre-0.1.21 install with untouched user-owned files and confirm the corrected `liveqa.md`, `qa1.md`-adjacent text and `CLAUDE.md` actually arrive. **This is the manifest mechanism doing the job it was built for** — before 0.1.6 none of these corrections would have reached anyone who had already installed.
- **Read `CLAUDE.md`'s own-tooling section from inside that installed target.** Not from this repository. That is the reading that nearly caused the incident.
- **Req 1 in practice.** Write this sprint's own live-test notes without a redefinition paragraph, and say whether one was needed.

### Out of Scope

- **The grandchild process question.** Still genuinely untested since sprint 15 — LiveQA's kill test watched the direct child only, and the pgid observed is consistent with a group kill and with the child simply exiting. It needs its own measurement.
- **The disclosure sweep**, unscheduled since sprint 4 — the only security-adjacent failure that has actually happened here.
- **The confinement bound.** Correctly documented as of sprint 19; nothing here revisits it.
- **Retitling sprint 18**, whose title no longer describes it. Registry surgery, the script owns it, and there is no command.
- **The uncommitted `.vscode/settings.json` change**, twenty sprints running.

### Dependencies

- **Blocks:** Nothing. Every item is a correction to a description, not a capability.
- **Blocked by:** Nothing. Sprint 18 shipped as 0.1.20 and nothing is in flight.
- **External:** A downstream consumer flagged Req 3's ambiguity on day one and hit it in practice. Worth telling them when it lands, since they are the ones whose boundary it threatened.

### Team Assignments

- **Dev Team 1:** All of it. Prose in four files plus one comment.
- **Dev Team 2:** Not assigned.

### Risks & Mitigations

- **Req 1 widens LiveQA's definition into vagueness**, and the role stops refusing things it should refuse. Its record comes from what it will not accept, not from what it covers. *Mitigation:* Req 1 states the refusals explicitly and QA1 checks they survive.
- **Req 3 is judged by a maintainer rather than a consumer**, and the ambiguity survives because it is obvious to someone who already knows. *Mitigation:* both QA1 and LiveQA are told to read it from inside an installed target.
- **This is the sixth consecutive sprint about the framework's own machinery**, a pattern flagged after sprint 8 and still true. *Mitigation:* named rather than mitigated. Every item here has a recorded instance of someone acting on the wrong reading, which is the test this project applies — but the pattern is worth watching, and the next sprint should have a user outside this repository in view.
