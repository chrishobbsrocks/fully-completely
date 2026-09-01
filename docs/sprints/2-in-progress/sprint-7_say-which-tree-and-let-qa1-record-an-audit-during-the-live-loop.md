---
id: 7
title: "Say which tree, and let QA1 record an audit during the live loop"
epic: "Honest reporting"
status: in_progress
created: 2026-08-31T21:05:01+00:00
---

# Master Controller Sprint Definition — Sprint 7

**Epic:** Honest reporting — no command implies more than it actually read.
**Sprint Objective:** Let QA1 record an audit during the live-test loop without touching anything the gates read, and make every command that reports a sprint absent say which tree it looked in.

> **LiveQA's gate is REDEFINED, not skipped**, same as sprints 3–6 and for the
> same mechanical reason — `/sprint-complete` hard-requires a LiveQA PASS
> (`sprint_lifecycle.py:688`), no skip flag, no override. **"Live" here means a
> real `npx fully-completely` install into a scratch directory and a real Dev
> Team 2 worktree**, because the defect being fixed only appears across two
> working trees and cannot be reproduced in one.

### Context

Two gaps, reported by an external team running this framework on a fork for two weeks, verified still present in 0.1.4. `scripts/sprint_lifecycle.py` has not been touched since before their 2026-08-18 install: 0.1.3 shipped `qa1.md` + `CLAUDE.md`, 0.1.4 shipped `pipeman.md` + `session.js`. Both findings are current.

**Gap 1.** During the LiveQA fix loop, `cmd_reship` deliberately permits a commit QA1 never audited (line 579's comment says so outright), while `cmd_qa1`'s phase tuple at line 478 refuses to record an audit for a sprint in `liveqa_live`. So a code change reaches production with no audit on the record, and QA1 cannot record one *even when it has performed one and asked*. Their QA1 declined to hand-edit the state file, correctly, and two complete audits exist only in a chat transcript. This is a violation of our own transition-precondition rule — the precondition is hit by QA1, cannot be cleared by QA1, and has no documented cross-role recovery path. It also contradicts the doctrine every agent file states: that the two gates are not interchangeable and neither substitutes for the other.

**Gap 2.** `ROOT = Path(__file__).resolve().parent.parent` (line 98) resolves from the script's own location, so in a git worktree `STATE_DIR` follows the script into the worktree. Dev Team 2's whole purpose is worktrees. Their `/sprint-status 672` returned "No state file for sprint 672. Run /sprint-start 672 first" from the main checkout while, in the worktree, 672 was at `liveqa_live` with gate 1 passed and a commit shipped. It produced four confidently-wrong statements in one week. Not only theirs: this project's own Master Controller produced two stale status reads on sprints 1 and 3, and never diagnosed either.

Note what this sprint does **not** conclude from Gap 2. The wrong-script banner at line 1097 already prints `repo={ROOT}` on every invocation, in the exact version they were running. It printed, and four wrong readings happened anyway. An agent reads the answer, not the header. The fix therefore goes in the message that produced the wrong conclusion, not in more preamble.

### Requirements

1. **`cmd_qa1` gains a live-loop branch that writes nothing the gates read.** When `state["phase"]` is in `LIVEQA_PHASES`, take a distinct branch that appends a history event and does nothing else. It must **not** write any of these five fields: `phase`, `qa1_audit_result`, `audit_rounds`, `qa1_audit_file_hash`, `qa1_audited_tree_hash`. The last two are the exact fields `cmd_ship` compares against; overwriting them with values unrelated to what gate 1 audited would let a mismatched commit ship, which is worse than the problem being fixed. The append-only property is not a convention to be respected, it is the whole safety argument: an audit that never writes `qa1_audit_result` **cannot** be used to launder an inconvenient gate-1 verdict, by construction rather than by rule. Say that in a comment.

2. **Optional `--commit`, resolved or refused.** If passed, resolve it with the same helper `cmd_reship` uses and `die` if it does not resolve to a real commit, then record the resolved SHA in the event detail. An audit record naming a commit that does not exist is worse than one naming none. Invocations that omit it keep working exactly as today — this argument is additive, never required.

3. **All three verdicts record, and none of them act.** PASS, CONDITIONAL and FAIL are all recordable in the live loop. A FAIL here must **not** send the sprint back to `dev_build`, which is what the gate-1 branch does — the existing reship loop is how a live-loop fix travels, and this command's job is to leave a record, not to move the sprint. The printed output must say plainly that this is a record and not a gate, and that LiveQA's retest remains the gate for this code.

4. **The gate-1 path is untouched.** `dev_build`, `qa1_audit` and `dev_agreed_done` behave byte-identically to today, including the FAIL branch that nulls both hashes. The `die` for a phase in neither set stays, with a message that is accurate now that two paths exist rather than still claiming the sprint is "not ready for QA1's first audit."

5. **Correct `cmd_reship`'s comment.** Line 579 asserts that LiveQA's retest is the check for reshipped code "instead of a fresh QA1 pass." Every agent file and CLAUDE.md say the two gates are not interchangeable. The comment is the thing that is wrong. Rewrite it to describe what reship actually does — ship a commit gate 1 has not seen — and point at the live-loop audit as the way to get one on the record.

6. **Every command that reports a sprint absent, or the board empty, names the tree it read.** At minimum: `load_state`'s "No state file for sprint N" die (line 190), `cmd_status`'s "No sprints yet" (line 440), `cmd_list`'s "No sprints yet" (line 809), and `cmd_gates`'s "No sprint state yet" (line 828). Name `ROOT` and the current branch. These are the four places the tool says "there is nothing here" — the sentence that produced all four of their wrong readings.

7. **The tree-naming code can never itself fail a command.** Reading the branch is a subprocess call, and it has to survive a detached HEAD, `git` missing from PATH, and a directory that is not a git repository. It degrades to omitting the branch and still prints the message. A read-only status command that dies because git is unavailable is a worse failure than a vague one, and this sprint must not trade one for the other.

8. **Keep the line 1097 banner exactly as it is.** This sprint adds naming at the point of the wrong conclusion; it does not replace the wrong-script safety net, and removing it because the new messages overlap would be a regression.

9. **`cmd_gates` output is unchanged for every existing sprint.** Live-loop audits are not counted as gate catches by this sprint. `gates` has already had two separate miscounting bugs fixed (`33dbd08`, `2d90a3d`); introducing a new history event type near it is exactly how a third arrives.

10. **Bump `package.json` to 0.1.7.** One line. (Sprint 8 takes 0.1.6; this sprint was resequenced behind it.)

12. **Distinguish "not a git repository" from "that ref doesn't resolve," and say which.** `git_tree_hash` and `git_commit_sha` both return `None` for either cause, so every message downstream has to guess — and guesses wrong. In a directory with no repo, `/sprint-qa1 --verdict PASS` succeeds and silently records `qa1_audited_tree_hash = None`; `/sprint-ship` then dies with *"either QA1 hasn't PASSed yet, or this sprint predates the commit-content check. Run /sprint-qa1 now. No override."* QA1 **did** pass, and re-running it records `None` again. **That is an unclearable dead end with a message that names the wrong cause**, and it violates this framework's own transition-precondition rule in the same way Req 1 does — Pipeman hits it and cannot clear it. Add a check that separates the two causes, then:
    - `cmd_qa1`, on a PASS with no repository present: say so at that moment, plainly, rather than recording `None` in silence. The sprint should not reach Pipeman before anyone learns the hash is missing.
    - `cmd_ship`, `cmd_reship` and `cmd_liveqa`: when the cause is a missing repository, say that and name the action that clears it. When a repository exists and the ref genuinely doesn't resolve, keep today's message.
    - Behaviour inside a real repository must not change at all.

13. **Test coverage in `scripts/smoke_test.sh`**, following the existing file's conventions. At minimum: a live-loop audit leaves all five fields byte-identical; a live-loop FAIL does not change `phase`; an unresolvable `--commit` is refused; the gate-1 path is unchanged; the four absence messages name the tree; branch lookup failure degrades rather than raising.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1 is the load-bearing check, and reading the diff is not sufficient to clear it.** Seed a scratch state file in a temp directory at `liveqa_live` with a gate-1 PASS and both hashes populated, run the live-loop audit against it, and diff the state file before and after. **Only the `history` array may differ.** This is the exact method that found the record-corruption trap in the first place; the external team's own note is that reading the diff would not have surfaced it. **If a live-loop invocation can reach the gate-1 branch or write `qa1_audit_result` by any input, this is a FAIL, not a CONDITIONAL.** State in the notes which inputs were tried.
- Req 2: confirm an unresolvable ref dies, and that a resolved SHA lands in the event detail. Confirm omitting `--commit` is unchanged from today.
- Req 3: read the printed output cold. If a reader could mistake it for a gate verdict, it fails.
- Req 4: `git diff` on the gate-1 branch shows no behavioural change. Confirm a sprint in `complete` or `abandoned` still dies.
- Req 5: read the rewritten comment against CLAUDE.md's "not interchangeable" line. If it still implies substitution, it fails.
- Req 6: all four call sites, read cold by someone who does not know which checkout they are in.
- **Req 7: demonstrate it, do not reason about it.** Run a status command with `git` unavailable (a stripped PATH, or a directory that is not a repo) and confirm it still reports.
- Req 9: run `gates` against the real state directory before and after the change and byte-compare the output.
- Req 10: `package.json` is `0.1.7`, one-line diff.
- **Req 12: demonstrate it in a directory that is not a git repository.** `new` -> `start` -> `qa1 --verdict PASS` -> `ship`, and confirm the PASS says the hash could not be recorded and the ship message names the missing repository and the action that clears it. Confirm the same sequence inside a real repository is byte-identical to today. This is a workshop-stalling dead end, so a code read does not clear it.
- Req 13: **run `scripts/smoke_test.sh`, do not just read it.** Confirm it covers all six listed cases plus the two git-cause cases.
- Run `scripts/verify-tarball.sh`: sprint content appearing in the tarball is a FAIL.

**LiveQA verifies live, after Pipeman publishes:**

- **Confirm 0.1.7 is on the registry** and its `gitHead` matches `last_shipped_commit`, established from `npm view` rather than from a handoff.
- **Reproduce the two-tree failure.** Create a real Dev Team 2 worktree with `/sprint-worktree`, start a sprint inside it, then run `/sprint-status <N>` **from the main checkout**. Confirm the message names the tree it read and the branch. Before this sprint that command said the sprint was never started. This is the four-wrong-readings scenario, reproduced rather than described.
- **The live-loop audit, end to end.** Against a sprint genuinely sitting at `liveqa_live`, record an audit, then confirm the sprint still ships and closes normally afterwards — the append must not break the completion path. Sprint 7's own fix loop is the natural place for this if LiveQA returns anything other than PASS on the first round. **If no such sprint is available, say so plainly in the notes and record what was and was not demonstrated rather than inferring it.**
- **Fresh install still works**, and the installed `sprint_lifecycle.py` is the 0.1.7 one.
- **The non-repository path, against the published artifact.** Install published 0.1.7 into a scratch directory that is deliberately not a git repository, run `new` -> `start` -> `qa1 --verdict PASS` -> `ship`, and confirm no message blames a missing QA1 pass for a missing repository. A student hitting this mid-workshop is the scenario; reproduce it rather than describe it.
- **Inherited from sprint 6, whose live gate could not complete it.** Sprint 6's "branch that must fire" criterion — an *untouched* user-owned file actually receiving an upgrade, with a backup written — needed a second published version to upgrade to, and 0.1.5 was the only one on the registry when it ran. It was accepted there as a local demonstration against a doctored `npm pack` tarball, explicitly recorded as not proven registry-to-registry. **By the time this sprint runs, 0.1.6 and 0.1.7 are both real published versions, so run it with both ends published and neither doctored.** Install published 0.1.6 into a scratch directory, leave `.claude/agents/qa1.md` untouched, upgrade to published 0.1.7, and confirm the file was updated, a backup of the 0.1.6 copy exists, and the manifest was refreshed. If sprint 6's local demonstration was wrong, this is where it surfaces.

### Out of Scope

- **The `origin/main` comparison** — warning that a sprint's state file exists on the remote but not locally. The external team proposed it alongside the tree-naming fix. It is not one line, it needs a ref that may be unfetched or days stale, and a stale ref produces a *new* confidently-wrong answer, which is the exact defect this sprint exists to remove. Its own decision, later, on its own evidence.
- **Counting live-loop audits in `cmd_gates`.** Feeding an append-only record into an aggregate is reasonable eventually and is a second feature today. Req 9 pins the current output instead.
- **Making a live-loop audit *required* before `/sprint-reship`.** This is the larger question Gap 1 raises — whether the reship path should be gated at all rather than merely recordable. It changes the fix loop's cost materially and deserves a decision on its own evidence, not a rider on the command that makes recording possible in the first place. This sprint makes the record possible; whether to require it stays open.
- **Install provenance** — recording the package name, source URL, and how to check for a newer version in the installed tree. Real, cheap, and the direct reason a two-week-old install sat two versions behind with no signal. It belongs in `install.js`, which sprint 6 is rewriting; bundling it here would put two sprints in one file.
- **Merging the external team's 271-line fork.** Reading it is not merging it. Their determination on Gap 1 is design input, credited; their code is not on the table.
- **Fixing CLAUDE.md's own-tooling clause**, still wrong about LiveQA not applying here. Sixth sprint working around it.
- **The uncommitted `.vscode/settings.json` change.** Still unrelated, leave it alone.

### Dependencies

- **Blocks:** Nothing. Both changes are additive.
- **Blocked by:** **Sprint 8 shipped as 0.1.6.** Resequenced behind it: sprint 6 shipped 0.1.5 with three live defects, and a defect already in users' hands outranks a gap they have been working around since before 0.1.2. Sequential, not parallel: both sprints end in an npm publish and both edit `package.json`'s version line, and two releases in flight from two worktrees is how a mis-versioned publish happens.
- **External:** The npm publish is Pipeman's, per `pipeman.md`. The record-corruption finding in Req 1 came from an external team's demonstration against a scratch state file; credit it in the commit message. That team is also building the same fix locally on their fork, deliberately aligned to Req 1's five protected fields and to the verification method above. **This is not a dependency and must not become one** — do not wait for it, do not read their implementation before building ours. It is recorded here because after both exist, comparing the two *behaviours* is a free check on whether Req 1 was specified precisely enough, and a divergence would be information about the requirement rather than about either build. That comparison is a retrospective item for after sprint 7 closes, not work inside it.

### Team Assignments

- **Dev Team 1:** All of it. One file, two independent changes, one release.
- **Dev Team 2:** Not assigned. Sequential with sprint 6 on the shared version line, and the Python state machine is a single review surface.

### Risks & Mitigations

- **The live-loop branch writes a field the gates read, and a corrupted tree hash lets a mismatched commit ship.** The worst outcome available here, and it is silent — nothing surfaces until a bad commit passes `cmd_ship`. *Mitigation:* Req 1 names the five forbidden fields explicitly; QA1's criterion is a before/after state-file diff against a seeded scratch file, not a code read; it is a FAIL rather than a CONDITIONAL.
- **A live-loop audit gets mistaken for a gate-1 verdict.** A recorded PASS during the live loop reads, in a transcript, exactly like gate 1 passing. *Mitigation:* Req 3's wording, Req 9's exclusion from `gates`, and a distinct event name that cannot be confused with `audit`.
- **The branch lookup crashes a read-only command.** The tool would then fail to answer at all in exactly the situation it was meant to answer better. *Mitigation:* Req 7, demonstrated rather than argued.
- **`cmd_gates` miscounts a third time.** It has been wrong twice, both times about which events counted as catches, and this sprint adds an event type. *Mitigation:* Req 9's byte-compare, run before and after.
- **Scope pull toward gating reship.** It is the more interesting question and it is not this sprint's. *Mitigation:* named in Out of Scope with the reason, so it is deferred on the record rather than forgotten.
