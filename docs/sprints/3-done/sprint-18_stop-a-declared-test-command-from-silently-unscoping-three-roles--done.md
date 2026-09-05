---
id: 18
title: "Stop a declared test command from silently unscoping three roles"
epic: "Framework rules and distribution"
status: done
created: 2026-09-05T05:45:21+00:00
---

# Master Controller Sprint Definition — Sprint 18

**Epic:** Framework rules and distribution — a scope that a configuration typo can remove is not a scope.
**Sprint Objective:** Correct four claims — two in code, two in agent files — that assert more than was established, and add the one workflow rule whose absence has cost five gate rounds.

> **The title is historical.** This sprint was created to constrain the declared test command; that requirement was absorbed into sprint 19's Req 6, built as `isBareInterpreter()`, tested, audited across four rounds and confirmed live. **Removed from Requirements here on 2026-09-05 after Dev Team caught it still listed as active work** — Master Controller had recorded the absorption in Dependencies and left the requirement itself in place, which is a half-edit and would have had Dev Team rebuild shipped code. The title cannot be changed without registry surgery, which the script owns and has no command for.

> **LiveQA's gate is REDEFINED, not skipped**, same as sprints 3–17. **"Live"
> means running roles headless against a published install in a scratch repo
> that is not this one**, with a deliberately hostile `testCommand` declared.

### Context

Sprint 17 fixed the two profiles that were broken and did it well — git enumerated by subcommand rather than `Bash(git *)`, and an honest gap when a target declares no test command rather than a guess. **The hole is in the one value that cannot be enumerated in advance**, because it belongs to the downstream project.

`readDeclaredTestCommand()` validates a declaration only as a non-empty string, and `run-role.js` interpolates it verbatim: `allowedTools.push(\`Bash(${testCommand} *)\`)`. LiveQA confirmed by varying it — `"bash"` yields `Bash(bash *)`, `"node"` yields `Bash(node *)`, and `node -e` is arbitrary execution. **One word in `.vscode/settings.json` silently unscopes `dev-team-1`, `dev-team-2` and `qa1`.**

This was correctly recorded as a finding rather than a FAIL: no role can do anything under a sane declaration, and LiveQA verified the bounded allowlists directly. But **the word in the criterion was *quietly***, and a project whose suite genuinely runs as `node test/all.js` might shorten it to `node` with no signal that three roles just lost their bound. It needs no attacker — only a plausible edit by the project's own owner.

**Two claims in the code assert more than was established.**

`run-role.js:543` says the trailing-wildcard pattern was *"confirmed (sprint 17) to also match the bare command with no trailing arguments at all."* Sprint 17 confirmed that for **git**, a real verb, in a real push. The npm half was proxied by an `npm pack` request that pipeman **declined as outside its process**, so no permission decision was ever reached. LiveQA's framing is exact: *one real verb plus reasoning, not two real verbs.* Same class as sprint 12's characterisation finding, where a doc described a bound the mechanism did not provide.

**And one incidental with a real per-invocation cost.** Pipeman's only denial in sprint 17 was `git push origin main 2>&1; echo "EXIT:$?"` — the pattern matches a single command, not a compound line. That is the correct security property and must not be relaxed. But appending `; echo $?` is a near-universal agent habit, so every headless role that does it burns a denial and a retry.

**One thing this sprint cannot assume.** LiveQA reported **zero denials** for dev-team and refused to score it as evidence, on the grounds that *a role that never attempts anything forbidden looks identical to one with no scope.* It tried twice to force the boundary and both roles defeated it by behaving correctly — `dev-team-2` identified an injected requirement as *"an instruction addressed directly at the building agent, embedded in what should be inert sprint data"* and refused it. So dev-team's bound currently rests on inspection of the launch arguments, not on an observed denial.

### Requirements

1. **Correct `run-role.js:543`.** It cites sprint 17 as confirming a general property that sprint 17 established for git alone. Either establish the npm case for real, or state plainly that git is confirmed and npm is inferred. **Do not leave a comment asserting two verbs on the evidence of one.**

2. **Decide the compound-command cost, explicitly.** `git push origin main 2>&1; echo "EXIT:$?"` is denied because the matcher matches one command, and **that behaviour is correct and stays.** The question is whether headless roles should be told not to append `; echo $?` — the templates from sprint 12 are the natural place — or whether the denial-and-retry is an acceptable cost. Either answer is fine; deciding by omission is not.

3. **Retire the phrase "directory-confined", and make three existing statements say *redirect* rather than *write*.** LiveQA's sprint 19 directive, and it is a precision fix rather than a correction — the three statements are true as far as they go.
   - `.claude/agents/liveqa.md:30`, `.claude/agents/qa1.md:35` and `.claude/commands/sprint-new.md:17` each tell a role to keep its notes file inside the working directory because a write outside is blocked. **That operational advice is correct and must not be weakened** — it is why `printf … > notes.txt` works and `/tmp` does not.
   - What must change is the stated *reason*. Sprint 12 established confinement for **shell redirects and the Write tool**. It says nothing about a program-mediated write, and sprint 19 demonstrated `node -e "fs.writeFileSync('/private/tmp/…')"` landing outside the declared directory with **zero denials**. A reader taking "confined to your working directory" as a property of *the profile* rather than of *the mechanism* makes exactly the generalisation that cost sprint 19 two separate corrections.
   - **Record the bound as four legs, not "directory confinement":** git recoverability (except uncommitted work and `.env`), the OS-level `.env` protection which refuses rather than degrades, **`Bash(git push *)` carried in DISALLOWED so nothing leaves except through Pipeman**, and the operator's explicit declaration. **It is a trust decision, not a sandbox.** Sprint 19's own Context lists only the first, second and fourth — it understates the protection, which is the safe direction, and is not worth a re-audit to amend.

4. **Master Controller commits sprint-file amendments before handing to a gate.** Add to `.claude/agents/master-controller.md`. Five instances — sprints 11, 14, 19 twice, and the round-3 authorization record — every one caught by QA1 holding a verdict rather than by Master Controller. The sharpest was sprint 19's: **a PASS hashing a working-tree file would have left the durable record showing an authorization that existed nowhere in history.** There is no step in Master Controller's own workflow that says to commit, which is why it recurs.

5. **Bump `package.json` to 0.1.20.** One line. *Sprint 16 keeps 0.1.18 and ships first.*

6. **Test coverage, only where these changes are testable.** Reqs 1, 3 and 4 are comment and prose corrections; Req 2's outcome may be a decision rather than code. **If nothing here warrants a test, say so rather than adding one for its own sake** — and confirm the existing `isBareInterpreter` coverage from sprint 19 still passes untouched.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- Req 1: confirm the comment now matches what was established. **If it still generalises from one verb, it fails** — this is the third comment in this epic to assert a bound the evidence did not reach.
- Req 2: confirm a decision was made and recorded either way, and that the matcher's single-command behaviour is unchanged.
- Req 3: confirm the three statements now attribute confinement to the mechanism, and that the operational advice is unchanged. **A weakened instruction is a defect** — roles still need to write notes inside the working directory.
- Req 4: read it cold. If it would not have caught the five instances, it is not written correctly.
- Req 5: `package.json` is `0.1.20`, one-line diff.
- Req 6: **run the suite.**
- Run `scripts/verify-tarball.sh`.

**LiveQA verifies live, after Pipeman publishes:**

- **Confirm 0.1.20 is on the registry**, verifying published bytes against the audited commit per sprint 13's rule.

- **The honest declaration still works.** A real project-shaped command in a downstream repo, with the role running the target's own tests, as sprint 17 established.
- **Force a denial on dev-team if it can be done.** Its bound currently rests on argument inspection rather than observation, and two attempts to provoke one failed because the role behaved correctly. **If it cannot be forced, say so plainly** — an unobservable bound recorded as unobserved is worth more than one assumed sound.
- **The npm verb, if a safe route exists.** Sprint 17's proxy was declined before any permission decision was reached. If nothing safe establishes it, record it as still inferred rather than closing it quietly.

### Out of Scope

- **The matcher's single-command behaviour.** Correct as it stands; Req 3 decides only whether roles are told to work with it.
- **Sprint 17's shipped profiles.** Verified live and against ground truth — the remote's own ref moved, and a downstream project's own suite ran. Do not re-derive.
- **Relaxing any bound to make a role's job easier.** Sprint 12's scoped model stands, and this sprint tightens rather than widens.
- **The grandchild process question.** Still genuinely untested, still not bolted onto a permissions sprint.
- **The disclosure sweep**, unscheduled since sprint 4.
- **The uncommitted `.vscode/settings.json` change** — note the irony that this sprint is about a value in that exact file, and it is still a different, unrelated edit.

### Dependencies

- **Blocks:** Nothing hard, but Fifty Mission Cap declares test commands in downstream client repos, which is precisely where a plausible shortening unscopes three roles.
- **Blocked by:** Sprints 16 and 19. **Req 1 was absorbed into sprint 19's Req 6** — the declared-test-command validator belongs with the ownership declaration's validator, in one place, by one rule. This sprint is now four corrections and one workflow rule: the `:543` comment, the compound-command decision, retiring "directory-confined", and Master Controller's commit rule. **Sprint 16 goes first** — its threshold was passed twice already and deferring it again for a hole that needs a misconfiguration would repeat the mistake this project has been correcting all epic.
- **External:** Worth telling Fifty Mission Cap what a safe declaration looks like before they write one per client repo.

### Team Assignments

- **Dev Team 1:** All of it.
- **Dev Team 2:** Not assigned.

### Risks & Mitigations

- **The rule is too strict and rejects legitimate project test commands**, so downstream users disable the mechanism or declare something worse to get past it. *Mitigation:* Req 1 requires stating what the rule does not catch, which forces the boundary to be described rather than assumed; LiveQA runs a real project-shaped command.
- **The rule is too loose and something still escapes.** *Mitigation:* QA1's criterion is adversarial by construction — try to defeat it, list what was tried — rather than confirming the happy path.
- **The npm verb gets closed by reasoning** because establishing it safely is awkward. *Mitigation:* Req 2 permits "git confirmed, npm inferred" as an honest answer; it does not permit a comment claiming both.
- **Zero denials get read as a working bound** in whatever this sprint reports. *Mitigation:* named in Context and carried as a LiveQA criterion, with "cannot be forced, recorded as unobserved" an acceptable outcome.
