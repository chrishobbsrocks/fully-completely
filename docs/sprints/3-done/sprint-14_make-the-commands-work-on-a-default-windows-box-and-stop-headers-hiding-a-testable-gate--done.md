---
id: 14
title: "Make the commands work on a default Windows box, and stop headers hiding a testable gate"
epic: "Framework rules and distribution"
status: done
created: 2026-09-03T21:44:11+00:00
---

# Master Controller Sprint Definition — Sprint 14

**Epic:** Framework rules and distribution — the framework has to work on a machine nobody prepared for it.
**Sprint Objective:** Remove the last three things that only appear on a default Windows box, and fix the sprint-header form that nearly let a testable gate go unrecorded.

> **LiveQA's gate for this sprint requires a real Windows machine, and one exists** —
> the VM used for sprints 10 and 11. **Attempt to obtain one before recording
> anything, and name what was tried if you cannot.** That wording is deliberate
> and is itself Req 4: sprint 10's header said this gate "cannot be satisfied on
> macOS" and offered "record nothing" as the immediate alternative, which LiveQA
> read as a blanket instruction while a Windows VM was running on the same laptop.

### Context

Three findings from sprint 10's live test on a clean Windows VM, plus one about how I write sprint headers. All four came from running the published artifact on a machine nobody had prepared, which is the only way any of them surface.

**The `/tmp` paths fail in PowerShell, and that is where students are.** Five command files write notes to `/tmp` — `sprint-abort`, `sprint-complete`, `sprint-qa1`, `sprint-new`, `sprint-liveqa`. On a default Windows box **PowerShell fails**: `C:\tmp` does not exist, the command dies on an unhandled `FileNotFoundError`, and nothing is recorded. **Git Bash works**, mapping `/tmp` to `AppData\Local\Temp`. Neither fails silently, which is the one piece of good news. QA1's hypothesis — that Git Bash would be the broken one — was refuted almost exactly in reverse, and it was labeled a hypothesis rather than a finding, which is why the refutation cost nothing.

The practical consequence is sharp. The workshop checklist points students at the VS Code terminal, which on Windows is PowerShell by default, so **a Windows student hits this at their first `/sprint-qa1`** — step one of the lifecycle after the build. There is a one-line workaround (`mkdir C:\tmp`) that belongs in the setup guide today, but the framework should not require a user to create a Unix-shaped directory on Windows.

**The console mojibake lands in the two messages whose job is helping a stuck user.** `ΓÇö` appears in the installer's own output — that is an em dash (`E2 80 94`) decoded as CP437. LiveQA withheld it after the first run because that capture arrived ISO-8859 and the corruption could have been its own pipeline; re-captured as genuine UTF-8 it persists. Cosmetic in isolation, and not cosmetic where it lives: the conflict message and the Python prerequisite warning.

**Sprint 10's Req 5 is unestablished on Windows.** The interpreter fallback — `python3`, then `python`, then `py` — was proven on macOS with a controlled PATH, and the Windows VM has a Microsoft Store install where `python3` works and `py` is not recognised. That is the opposite of the shape the requirement was written for, so the case that motivated it has never been run. LiveQA declined to present the macOS proof as a Windows one, correctly.

**And the header form.** Sprint 9's Req 4 put "do not assert untestability without attempting it" into `master-controller.md`, governing how I answer. It did not reach the *sprint header form*, and sprint 10's header stated an impossibility and offered an off-ramp in the same breath. That is the third time I have written a claim of untestability that would have removed verification if believed.

### Requirements

1. **No command file writes to a hardcoded POSIX path.** *Three remain, not five — `sprint-qa1.md` and `sprint-liveqa.md` were fixed in sprint 12 and shipped in 0.1.13, using working-directory-relative paths (`> qa1-notes-<N>.txt`). **That is a proven, shipped pattern; follow it rather than inventing a second one.*** Still outstanding: **`sprint-abort.md`** (`--reason-file`), **`sprint-complete.md`** (`--user-said-file`), and **`sprint-new.md`** (`--title-file` and `--epic-file`).
   - **`sprint-new.md` is broken headless, and the cause is the absolute path — not the Write tool.** *Corrected mid-sprint: this bullet originally stated that sprint 12's profile hard-disables Write for Master Controller, and this sprint's own headless testing disproved that. Write was never disabled for Master Controller's profile.* The real defect is `/tmp/sprint-title.txt` being **absolute**: it falls outside `acceptEdits`' working-directory confinement, and on Windows `/tmp` does not exist at all. Fixing the path fixes the file; the Write-tool instruction is not itself the problem.
   - *Where the wrong cause came from, since it is the kind of error worth not repeating:* QA1's sprint 12 finding was that sprint 11's Req 7 mandated a Write-tool pattern which sprint 12's profile made impossible **for the two roles Req 7 was written for** — `qa1` and `liveqa`. Master Controller has a different profile, and Master Controller generalised the finding to it without checking. Right effect, wrong mechanism.
   All three must work on a **default Windows box in PowerShell with no setup** — no `mkdir C:\tmp`, no shell switch, no prerequisite beyond what the setup guide already names. Choose the mechanism and **state the reasoning in the commit**: a platform temp directory resolved at runtime, a repo-relative location alongside the existing gitignored `docs/sprints/.locks/`, or reading notes from stdin. Whatever is chosen must keep working unchanged on macOS and in Git Bash, where the current behaviour is correct.
   - **The failure mode to design against is the one observed**: an unhandled exception with nothing recorded. A role that cannot write its notes must fail with a message naming the path it tried, not a stack trace.

2. **Fix the encoding of the installer's own output on a Windows console.** `ΓÇö` in the conflict message and the Python prerequisite warning. These are the two messages a stuck user reads, and mojibake in them costs exactly the confidence they exist to provide. Establish what the console actually needs — by running it on Windows, not by reasoning about code pages — and record what was tried.

3. **Establish sprint 10's Req 5 on Windows, against a python.org install.** The fallback has never been exercised in the shape that motivated it: a machine where `python3` does not exist but `python` and `py` do. Install Python from python.org on a Windows box, confirm `python3` is absent, and confirm the eleven commands still run through `scripts/run-lifecycle.js`. **If a python.org machine cannot be obtained, say so plainly and record what was and was not established** — do not infer it from the macOS proof.

4. **A sprint header that names a required environment must require the attempt before permitting silence.** Add to `.claude/agents/master-controller.md`: a header may state what environment a gate needs, but must direct the role to attempt to obtain it and to name what was tried if it cannot — never state an impossibility and offer "record nothing" as the immediate alternative. Sprint 10's header is the worked example and should be cited as one. This is the same rule as sprint 9's Req 4, applied to the artifact rather than the conversation.

5. **Document the version marker as a guarantee, or decline to give one.** `install.js:826` calls `writeInstalledVersion(CURRENT_VERSION)` **unconditionally, after every file copy**, so `.claude/fully-completely-version` always reflects the version whose files were just written. **A downstream consumer depends on that today** as a version-skew check, and has asked whether it is intended to stay true.
   - State it at the write site as an invariant rather than an incidental. `install.js` has been substantially rewritten in sprints 6, 8 and 10; a future edit could make that call conditional and silently break a consumer with no test failing anywhere.
   - **This is also the mitigation for a real shape in our install.** A target ends up with **two copies of the launcher** — the scaffolded one under `<target>/scripts/launcher/` that executes, and the pinned dependency under `node_modules/` that does not — and nothing compares them. That cost the consumer a false ROOT-resolution finding, since `path.resolve(__dirname, '..', '..')` is correct from the scaffolded copy and wrong from the other. They fixed it their side by refusing to invoke on skew, which only works because the marker is reliable. Documenting the invariant is what makes that detectable by anyone else.
   - **If we are not willing to guarantee it, say that instead.** An undocumented invariant a consumer depends on is worse than a documented refusal.

6. **Bump `package.json` to 0.1.15.** One line.

7. **Test coverage.** For Req 1, cover the path resolution in `scripts/launcher_test.js` or `scripts/smoke_test.sh` as fits the mechanism chosen. Reqs 2–4 are verified by running and by reading; if no test is appropriate, say so rather than adding one for its own sake.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- Req 1: confirm **no command file anywhere** contains a hardcoded `/tmp` — grep all twelve rather than the three named, because this enumeration has now been wrong twice in opposite directions (short by two originally, long by two after sprint 12 fixed some). Confirm the three outstanding files follow sprint 12's shipped working-directory-relative pattern rather than a second invented one, and that the failure path names the attempted location rather than raising.
- Req 1, second half: confirm `sprint-new.md` no longer depends on the Write tool, and that a headless Master Controller can actually create a sprint under the scoped profile. **If that was reasoned rather than run, it is not met** — it is the exact inference sprint 12 disproved.
- **Req 2 has a clearable path, added after QA1 flagged it as a precondition Dev Team could not clear.** *The asymmetry with Req 3 was an oversight, not a decision.* Confirm the encoding fix was established **by running on Windows**, not derived from code-page reasoning. **If no Windows console is obtainable, the change does not ship** — record what was attempted, what is blocked, and what was and was not established, and Req 2 moves to the next sprint with the rest of the sprint proceeding without it.
  - **The escape hatch is 'do not ship it', not 'ship it unverified'.** Code pages look settled on paper and are not, and this fix lands in the conflict message and the Python warning — the two messages a stuck user reads. An unverified change there is worse than the mojibake it replaces. Inferring the result from code-page reasoning remains a **FAIL**.
- Req 3: confirm this was attempted and that the outcome — established or not obtainable — is recorded plainly. **An inference from the macOS proof is a FAIL**, not a CONDITIONAL.
- Req 4: read the new wording cold against sprint 10's header. If that header would still pass under the new rule, the rule is not written correctly yet.
- Req 5: confirm the invariant is stated at the write site and matches what the code does. If the wording promises more than the code delivers, that is the defect.
- Req 6: `package.json` is `0.1.15`, one-line diff.
- Req 7: run whichever suite applies.
- Run `scripts/verify-tarball.sh`.

**LiveQA verifies live, on a real Windows machine, after Pipeman publishes:**

- **Confirm 0.1.15 is on the registry** and verify the published bytes against the audited commit — by content if `gitHead` is absent, as established on 0.1.11.
- **The headline test, on a default box in PowerShell with no `C:\tmp`:** run a real `/sprint-qa1` against a scratch sprint and confirm the verdict is **recorded**, with the notes stored verbatim rather than empty. This is the exact case that fails today.
- **Confirm Git Bash still works.** The current behaviour there is correct and must not be traded for the PowerShell fix.
- **Read the installer's output on a Windows console** and confirm no mojibake in the conflict message or the Python warning.
- **macOS is unaffected** — re-run the same command path and confirm no regression.

### Out of Scope

- **The orphaned billed child.** Sprint 11 found that killing the launcher leaves the spawned `claude` alive on PPID 1. Sprint 12's LiveQA is establishing whether that still happens under the scoped profile. **If it does, it comes back with evidence attached** — it is not written into a requirement here on a finding that has not been made.
- **Anything in sprint 13's three gate fixes.** Separate sprint, separate thesis.
- **The workshop guide's `mkdir C:\tmp` line.** That belongs in the guide today, without a release, and it is documentation rather than sprint work.
- **Widening LiveQA's definition, CLAUDE.md's own-tooling clause, and the mechanism-not-automation boundary.** Still queued, still no instance forcing them.
- **The disclosure sweep**, unscheduled since sprint 4.
- **The uncommitted `.vscode/settings.json` change.**

### Dependencies

- **Blocks:** Nothing, but every Windows user in PowerShell is blocked at their first gate command until Req 1 lands.
- **Blocked by:** Sprints 12 and 13 shipping, on the shared `package.json` version line. Sequential: 0.1.12, 0.1.13, then 0.1.15.
- **External:** **A Windows machine is a hard dependency of the live gate**, not of the build. One exists — the VM used for sprints 10 and 11. Req 3 additionally needs a python.org install, which may need a second machine or a reconfiguration of that one.

### Team Assignments

- **Dev Team 1:** All of it. Small, and Req 3's verification is sequential by nature.
- **Dev Team 2:** Not assigned.

### Risks & Mitigations

- **The PowerShell fix breaks Git Bash or macOS**, trading a working platform for a broken one. *Mitigation:* explicit LiveQA criteria on both, and Req 1 states it directly.
- **Req 3 gets inferred from the macOS proof** because obtaining a python.org machine is inconvenient. It is exactly the shape of inference this project keeps having to correct. *Mitigation:* QA1's criterion makes it a FAIL, and "not obtainable, recorded plainly" is an acceptable outcome where an inference is not.
- **The encoding fix is reasoned rather than run.** Code pages are the kind of thing that looks settled on paper and is not. *Mitigation:* Req 2 and its criterion both require it established on Windows.
- **Req 4 is prose, and prose is not enforcement** — the same limit named in sprint 9. *Mitigation:* accepted, and its criterion is unusually concrete: the rule must be strong enough that sprint 10's actual header would fail under it.
