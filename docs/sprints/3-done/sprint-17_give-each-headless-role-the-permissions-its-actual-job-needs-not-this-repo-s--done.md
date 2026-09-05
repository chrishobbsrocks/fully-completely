---
id: 17
title: "Give each headless role the permissions its actual job needs, not this repo's"
epic: "Framework rules and distribution"
status: done
created: 2026-09-05T04:00:40+00:00
---

# Master Controller Sprint Definition — Sprint 17

**Epic:** Framework rules and distribution — a role's permissions have to fit the role's job, in the repo the role is actually running in.
**Sprint Objective:** Fix the headless permission profiles that were written against this repository's own commands rather than against what each role does, and settle the tool-versus-Bash confusion that produced them.

> **LiveQA's gate is REDEFINED, not skipped**, same as sprints 3–16 and for the
> same mechanical reason (`sprint_lifecycle.py:688`). **"Live" means running
> each role headless against a published install, in a scratch repo that is not
> this one** — the distinction that produced every finding below.

### Context

Sprint 15's LiveQA exercised the two profiles it was told to prioritise. **Both failed**, and neither failure is in sprint 15's code — they are sprint 12's profile definitions, which is why sprint 15 still passed.

**Pipeman cannot `git push`.** Its allowlist is `['Bash(node scripts/run-lifecycle.js *)', 'Bash(python3 scripts/sprint_lifecycle.py *)', 'Bash(npm *)']` — **no git entry of any kind.** The push was denied, Pipeman correctly reported BLOCKED, and the sprint went unshipped. `CLAUDE.md` defines the role as *"Only Pipeman ever runs `git push`, no exceptions, ever"*, so headless Pipeman cannot do the one thing only it is allowed to do.

**`run-role.js:360` explains why someone thought it would work** — a comment reading *"git (free under acceptEdits)"*. That is the **third instance in this epic** of the same conflation: `acceptEdits` governs **tools** (Edit, Write), not **Bash commands**. QA1 caught it in sprint 12, where the profile was described as making QA1 write nothing while Bash redirection wrote anyway. It is now load-bearing in a comment that justifies an omission.

**Dev Team can write source and cannot test it.** The run produced `greet.js` and `greet.test.js`, and the code was correct — LiveQA ran the test itself and it passed. But **11 of 27 turns were denials, every one of them `node greet.test.js`**. The only test command allowlisted is `Bash(node scripts/launcher_test.js)` — *this framework's own test file*, hardcoded. Correct in this repo, wrong in every repo that installs the framework, **which is the entire point of the framework.** A headless Dev Team at a downstream consumer can build and cannot verify.

**Three profiles remain unexercised: `dev-team-2`, `liveqa`, `master-controller`.** `dev-team-2` shares `dev-team-1`'s shape, so the same finding likely applies — *likely* being the word LiveQA used, and the distinction this project keeps having to relearn. And reading `liveqa`'s definition, its allowlist contains no `npm` or `npx` at all while its job is installing published packages into scratch directories; **that is a prediction from a definition, not an observation, and it must be tested rather than assumed.**

### Requirements

1. **Every profile is derived from what the role does, not from what this repository happens to run.** Go role by role and state, for each, what capability the role's job requires and how the allowlist provides it. **A hardcoded path to a file in this repo is the defect**, not an example to copy.
   - `pipeman` needs git — at minimum `push`, and whatever else its documented flow uses. It also publishes, which `Bash(npm *)` already covers.
   - `dev-team-1` and `dev-team-2` need to run **the target project's tests**, whatever those are, not `scripts/launcher_test.js`. State how that is expressed without knowing the target's test command in advance, and if the honest answer is that the target must declare it, say so and define where.
   - `liveqa` needs to install published packages — `npx`/`npm` — into scratch directories. **Test this rather than reasoning from the definition.**
   - `master-controller` writes sprint files and runs the lifecycle. Sprint 14 established it works; confirm nothing here regresses it.

2. **Settle the tool-versus-Bash boundary in the code, and delete the comment that gets it wrong.** `run-role.js:360`'s *"git (free under acceptEdits)"* is false and it is the third instance of this confusion in this epic. **`acceptEdits` governs tool use; Bash commands require explicit allowlisting.** State that once, plainly, where the profiles are defined, so the next person extending them does not rediscover it by shipping a broken profile.

3. **The scoped model is not being abandoned.** Sprint 12 established by testing that scoping works and refused blanket `bypassPermissions` on that evidence; that decision stands. **Widening a profile to fit a role's real job is not the same as removing the bound** — every addition must be the narrowest form that does the job, and stated as such. If any role genuinely cannot be scoped, say which and why rather than quietly granting more.

4. **Bump `package.json` to 0.1.17.** One line. *This sprint is sequenced ahead of sprint 16, which moves to 0.1.18 — both were `todo` when the order changed.*

5. **Test coverage in `scripts/launcher_test.js`** for the profile definitions: assert each role's allowlist contains what its job needs, and that no allowlist hardcodes a path specific to this repository. That second assertion is the one that would have caught this.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1 role by role.** For each of the six, confirm the stated capability matches the allowlist and that nothing repo-specific remains. **A profile that only works in this repository is a FAIL, not a CONDITIONAL** — that is the defect this sprint exists to remove.
- Req 1, dev-team: read the mechanism for the target's test command cold. If it still requires the framework to know the target's test runner in advance, it is not solved.
- Req 2: confirm the false comment is gone and the boundary is stated once, where profiles are defined. **Check the new wording against the sprint 12 case** — QA1's finding that Bash redirection writes under `acceptEdits` while `Write` is disabled. If the wording would not have prevented that, it is not right yet.
- **Req 3 is the counterweight and should be audited as one.** Confirm each widening is the narrowest form that does the job. `Bash(git *)` where `Bash(git push *)` would do is a finding, not a convenience.
- Req 4: `package.json` is `0.1.17`, one-line diff.
- Req 5: **run the suite**, and confirm the no-repo-specific-paths assertion actually fails against the current definitions.
- Run `scripts/verify-tarball.sh`.

**LiveQA verifies live, after Pipeman publishes:**

- **Confirm 0.1.17 is on the registry**, verifying published bytes against the audited commit per sprint 13's rule.
- **The two known failures, re-run.** Headless `pipeman` completes a real `git push`. Headless `dev-team` writes source **and runs the target's own tests** in a scratch repo that is not this one. Both failed in sprint 15; both must pass here.
- **The three unexercised profiles.** `dev-team-2`, `liveqa` and `master-controller`, run for real. **`liveqa` is the one with a live prediction against it** — its allowlist appears to lack `npm`/`npx` while its job requires them. Confirm or refute by running.
- **The scope did not quietly become a bypass.** Confirm each role is still denied something it should not have — a role that can now do anything is a FAIL regardless of whether its own job works.

### Out of Scope

- **Sprint 15's shipped work** — the live-loop window, the orphan fix, `cmd_ship`'s display, the em-dash cleanup. All verified; do not re-derive.
- **The grandchild process question.** Sprint 15's kill test watched the direct child only, and LiveQA explicitly declined to claim group coverage — the pgid it observed is consistent with a group kill *and* with the child simply exiting. **Genuinely untested, not assumed either way.** It needs its own measurement and does not belong bolted onto a permissions sprint.
- **Blanket `bypassPermissions`.** Refused in sprint 12 on evidence and still refused. See Req 3.
- **The disclosure sweep**, unscheduled since sprint 4.
- **The uncommitted `.vscode/settings.json` change.**

### Dependencies

- **Blocks:** Fifty Mission Cap's run loop. **Headless `pipeman` cannot push and headless `dev-team` cannot test**, which are two of the four things an automated lifecycle has to do. They should be told before they build around either.
- **Blocked by:** Sprint 15 shipped as 0.1.16. **Sequenced ahead of sprint 16**, whose baseline drift is internal hygiene with no consumer blocked on it.
- **External:** The two failing profiles are exactly the two Fifty Mission Cap named as least safe to assume, months before either was run. Their judgement was right and it is worth saying so.

### Team Assignments

- **Dev Team 1:** All of it.
- **Dev Team 2:** Not assigned — and note this sprint fixes `dev-team-2`'s own profile, which it cannot verify from inside.

### Risks & Mitigations

- **Fixing the profiles becomes widening them until everything works**, which is blanket bypass reached one grant at a time. *Mitigation:* Req 3 is a first-class requirement, and QA1 audits each widening for narrowness rather than only for function.
- **The dev-team test command gets solved for this repo again**, since that is the repo the work happens in. *Mitigation:* QA1 reads the mechanism cold, and LiveQA runs it in a scratch repo that is not this one.
- **`liveqa`'s predicted failure is treated as established** because the definition is obviously missing `npm`. It is a prediction from reading, which is the exact thing this project has been wrong about repeatedly. *Mitigation:* the criterion says confirm or refute by running.
- **The comment fix is cosmetic and the confusion recurs.** Three instances so far. *Mitigation:* Req 2's criterion tests the new wording against the sprint 12 case rather than accepting it as clear.
