---
id: 10
title: "Make the upgrade mechanism work on Windows, and say what the framework needs to run"
epic: "Framework rules and distribution"
status: in_progress
created: 2026-09-01T19:11:59+00:00
---

# Master Controller Sprint Definition — Sprint 10

**Epic:** Framework rules and distribution — the rules this framework defines have to reach the people running it, on every platform they run it on.
**Sprint Objective:** Fix the path-separator mismatch that makes the manifest and baseline mechanism silently inert on Windows, and make the framework state what it needs to run instead of failing with a message that points somewhere else.

> **LiveQA's gate for this sprint CANNOT be satisfied on macOS.** Every defect
> here was invisible on macOS and will stay invisible there. The live test
> requires a real Windows machine running the published artifact. If one is not
> available when this reaches the gate, LiveQA records nothing and says so —
> a macOS pass on this sprint would be worse than no verdict, because it would
> read as evidence.

### Context

Every finding below came from running the published 0.1.9 on a clean Windows VM. None came from reading the code, and none were visible on macOS — three sprints of verification, including two adversarial passes over this exact mechanism, missed all of it, because every test we have ever run was on the platform where the paths happen to agree.

**The mechanism sprints 6 and 8 built is inert on Windows and reports success.** A clean `0.1.2` → `0.1.9` upgrade with nothing customised reported six conflicts:

```
Conflicts — left untouched, review by hand (6):
  .claude\agents\dev-team-1.md  (yours — this doesn't match what this installer last wrote here...)
  .claude\agents\dev-team-2.md
  .claude\agents\liveqa.md
  .claude\agents\master-controller.md
  .claude\agents\pipeman.md
  .claude\agents\qa1.md
```

The user customised nothing. On macOS the identical upgrade replaces all six.

**The cause is isolated, and `CLAUDE.md` is the discriminator.** It was the one user-owned file that upgraded, and the resulting manifest contains exactly one entry: `{"CLAUDE.md": "0fb16757…"}`. `CLAUDE.md` is the only user-owned path with no directory separator. The baseline table is generated on macOS with forward-slash keys (`.claude/agents/qa1.md`); on Windows the installer computes `relPath` with `path.join`, producing `.claude\agents\qa1.md`; the lookup finds nothing and falls through to "no proof, don't overwrite."

**This also eliminates line endings as a cause.** If CRLF were responsible, `CLAUDE.md` would have failed identically — same file type, same treatment. It matched. Do not spend time on CRLF.

**Separately, the framework does not say what it needs.** `package.json` declares `node >=18` and nothing else. Python 3 is required by every one of the twelve slash commands, is mentioned once in the README, and is checked nowhere. On a clean Windows box the first error a user sees is *"Python was not found; run without arguments to install from the Microsoft Store"* — Windows' App Execution Alias, which points at a store page rather than at the actual requirement. And once Python is installed, `python3` resolves only if it came from the Microsoft Store; the python.org installer creates `python` and `py` but not `python3`. The framework works or does not depending on which installer someone happened to use, and nothing says so.

**What is not broken, tested and confirmed:** `sprint_lifecycle.py` runs correctly on Windows. `new`, `list`, `start` and `status` all work, the sprint file moved folders correctly, state was written, and the Windows-only `msvcrt` locking branch executed without incident — the first time that code has run anywhere. No work is needed there.

### Requirements

1. **Normalize path separators to forward slashes at every manifest and baseline lookup, and when writing manifest keys.** The published baseline tables for 0.1.0–0.1.9 all exist with forward-slash keys and cannot be changed, so normalization must happen on the lookup side: convert the computed `relPath` before consulting `manifestHashFor` or `baselineHashesFor`, and write manifest keys in the same normalized form so a manifest is portable between platforms.

2. **Normalization must not make the destructive branch reachable.** This edits the same code path as sprint 6's Req 3 and sprint 8's Req 1, and those constraints are unchanged and non-negotiable: overwriting still requires a positive hash match from either a manifest entry or a published baseline, and every degradation — missing file, missing entry, malformed data, no match — still resolves to no-overwrite. Normalization changes only which *key* is looked up, never what counts as proof.

3. **Confirm there is nothing to migrate, rather than assuming it.** Reasoning to verify: on Windows a path containing a separator can never have been proven, so it can never have been written to a manifest, so no existing manifest can contain backslash keys — which the observed `{"CLAUDE.md": …}` supports. If that reasoning is wrong anywhere, a stale backslash key must still degrade to no-match and therefore no-overwrite. State which way it was established.

4. **Declare Python 3 as a prerequisite and check for it.** Add it to the documented requirements alongside Node and git, and have `install.js` check for a usable interpreter at install time. On failure, say what is needed and how to verify it — never leave the user with Windows' Store message as their only signal. A missing interpreter should not block the install itself; the files are still worth writing. It must not be silent.

5. **The slash commands must not depend on which Python installer was used.** All twelve hardcode `python3`, which does not exist after a python.org install. Resolve an interpreter that works — `python3`, then `python`, then `py` — rather than assuming one. Whatever mechanism is chosen must keep working unchanged on macOS, where `python3` is correct and present.

6. **Determine whether the `/tmp` paths in the slash commands work on Windows, and fix them if not.** `/sprint-liveqa`, `/sprint-abort` and `/sprint-complete` instruct writing to `/tmp/…` and passing `--notes-file`/`--reason-file`/`--user-said-file`. This was **not tested** on Windows and is genuinely unknown — `/tmp` may resolve to `C:\tmp` and work, or may not. **Test it before changing anything**, and if it works, say so and change nothing.

7. **Bump `package.json` to 0.1.10.** One line.

8. **Test coverage in `scripts/launcher_test.js`.** At minimum: a backslash-separated relPath matches a forward-slash baseline key; manifest keys are written normalized; a file with no separator still behaves exactly as today; and the no-match, malformed and missing cases still resolve to no-overwrite.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 2 is the load-bearing check and carries forward unchanged.** Re-trace every route to "overwrite" and confirm each still requires a positive match. **If normalization has opened any route to an unearned overwrite, this is a FAIL, not a CONDITIONAL.** List the routes traced.
- Req 1: confirm normalization happens on the lookup side and that no published baseline table needs regenerating for the fix to work. A fix that requires reissuing old tables does not help anyone already installed.
- Req 3: confirm which way the migration question was settled — by argument, or by inspecting a real manifest.
- Req 4: read the failure message cold, as someone on Windows who has never installed Python. If it does not tell them what to install and how to check it, it fails.
- Req 5: confirm macOS behaviour is unchanged, and that the resolution order does not pick a Python 2 interpreter on a machine that has one.
- Req 6: confirm this was **tested** rather than reasoned about, and that the notes say which.
- Req 7: `package.json` is `0.1.10`, one-line diff.
- Req 8: **run `node scripts/launcher_test.js`.** Confirm the four listed cases.
- Run `scripts/verify-tarball.sh`.

**LiveQA verifies live, on a real Windows machine, after Pipeman publishes:**

- **Confirm 0.1.10 is on the registry** and its `gitHead` matches `last_shipped_commit`, from `npm view`.
- **The exact reproduction, reversed.** On Windows: install published `0.1.2` into an empty directory, touch nothing, upgrade to published `0.1.10`. All six agent files must be **Replaced with backups written**, the manifest must contain all seven user-owned paths, and there must be **zero** conflicts. This is the precise scenario that produced six false conflicts on 0.1.9.
- **The destructive branch, on Windows.** Install published `0.1.4`, plant a sentinel in `.claude\agents\qa1.md`, upgrade to `0.1.10`. The sentinel must survive and that one file must be reported as a conflict. Note that this passed on 0.1.9 for the wrong reason — nothing was ever overwritten because nothing ever matched — so this is the first real test of it on Windows.
- **macOS is unaffected.** Re-run the 0.1.2 → 0.1.10 upgrade on macOS and confirm it behaves as 0.1.9 did. This sprint must not fix one platform by breaking the other.
- **A clean-machine prerequisite check.** On a Windows box without Python, run the installer and confirm the message names Python and the verification command.
- **The commands run after a python.org install**, not only a Microsoft Store one, if a machine is available for it. If not, say so plainly rather than inferring.
- **Req 6's determination — carried here on QA1's recommendation, because these criteria did not mention it and it would otherwise retire unrecorded.** *Amended by Master Controller after QA1's round-1 PASS; a fresh `/sprint-qa1` is required so the sign-off attests to this file rather than the one it audited.*
  - **Five command files write to `/tmp`, not the three Req 6 named**: `sprint-abort.md`, `sprint-complete.md`, `sprint-qa1.md`, `sprint-new.md`, `sprint-liveqa.md`. `sprint-qa1` is the one that matters most — it runs every sprint, for every team.
  - **Test from both PowerShell and Git Bash.** QA1 left a labeled hypothesis, which is a hypothesis and not a finding: cmd/PowerShell likely works unless `C:\tmp` is absent, while **Git Bash likely fails silently** because its `/tmp` mapping disagrees with Python's. Confirm or refute it by running. Do not record the hypothesis as the result.
  - **Exercise a real command, not just a bare file write** — you will be running `/sprint-liveqa --notes-file` on this sprint anyway, and that is the test.
  - **The determination is the deliverable here; the fix is not.** If `/tmp` proves broken on Windows, record it plainly and it becomes a follow-up sprint. **It does not fail this sprint** — a code change discovered at gate 2 would force a re-audit and re-ship for a defect that predates this release. State what was established, on which shell.


### Out of Scope

- **CRLF and line-ending handling.** Eliminated by evidence: `CLAUDE.md` matched under identical treatment. Do not spend time here.
- **Anything in `sprint_lifecycle.py`.** Tested on Windows and working, including the `msvcrt` branch. Leave it alone.
- **Naming framework-owned files that have drifted before replacing them.** Deferred a fourth time. Still real, still the external team's fork as the instance.
- **The disclosure sweep** of everything the package ships — deferred since sprint 4, and the one security-adjacent item worth scheduling next.
- **Fixing CLAUDE.md's own-tooling clause**, still wrong about LiveQA not applying here. Ninth sprint working around it.
- **The uncommitted `.vscode/settings.json` change.**

### Dependencies

- **Blocks:** Nothing.
- **Blocked by:** Nothing in the lifecycle. **A Windows machine is a hard dependency of the live gate**, not of the build.
- **External:** The npm publish is Pipeman's, using the sprint 9 ordering — publish before the bookkeeping commit.

### Team Assignments

- **Dev Team 1:** All of it.
- **Dev Team 2:** Not assigned.

### Risks & Mitigations

- **Normalization opens a route to an unearned overwrite**, in the one branch that destroys other people's work. *Mitigation:* Req 2 restates the constraint unchanged; QA1 re-traces every route as a FAIL-level criterion; LiveQA tests the destructive branch on Windows, where it has never actually been exercised.
- **Fixing Windows breaks macOS**, which is where every existing install lives. *Mitigation:* an explicit LiveQA criterion re-running the macOS path.
- **The interpreter resolution picks Python 2** on a machine that has one, producing a confusing syntax error instead of a clear failure. *Mitigation:* QA1 criterion on Req 5.
- **This class of defect recurs on the next platform.** The real lesson is not about separators: it is that every verification this project has ever run was on one machine, and three sprints of adversarial testing missed a total failure on another. *Mitigation:* none in this sprint, deliberately. Naming it is the honest output; building a cross-platform test harness is a decision on its own evidence, not a rider here.
