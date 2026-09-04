---
id: 15
title: "Make the live-loop audit reachable when it is needed, and stop a killed launcher leaving a billed child alive"
epic: "Honest reporting"
status: todo
created: 2026-09-03T23:05:31+00:00
---

# Master Controller Sprint Definition — Sprint 15

**Epic:** Honest reporting — a record that cannot be written when it is needed is not a record, and a process nobody can see is not finished.
**Sprint Objective:** Open the live-loop audit's window to the moment the need actually becomes visible, prompt for it where it arises, and stop a killed launcher leaving a live billed agent behind.

> **LiveQA's gate is REDEFINED, not skipped**, same as sprints 3–14 and for the
> same mechanical reason (`sprint_lifecycle.py:688`). **"Live" means real
> headless runs from a published install**, including the five role profiles
> that have been read but never exercised.

### Context

**The live-loop audit's window shuts precisely when someone finally thinks to use it.** Sprint 7 built it so QA1 could put an audit of a reshipped commit on the record without touching anything either gate reads. It has been used **once** in this project's life — on sprint 10, and only because an instruction of mine accidentally triggered it. LiveQA has flagged it going unused on a qualifying reship **twice**, on sprints 9 and 12.

The cause is mechanical and was verified in code, not inferred. `cmd_qa1`'s live-loop branch is gated on `LIVEQA_PHASES = ("liveqa_live", "groundtruth_live")`; `cmd_reship` is gated on the same pair; `complete_ready` is set at `:819` and read only by `cmd_complete` at `:858`; **no transition moves backward.** So the sequence is: LiveQA raises the unaudited commit in its final report → that same report's PASS moves the sprint to `complete_ready` → the record can no longer be written, from any role, by any command. QA1 confirmed this on sprint 12 and correctly refused the only remaining routes, which were changing code mid-flight or hand-editing state.

**Both halves are needed and neither is sufficient.** A prompt at reship alone would fire while the sprint is still at `liveqa_live` — useful, but it fires before LiveQA has found anything to be prompted about. Widening the phase alone leaves nobody saying the record is wanted. QA1 named this precisely, and it is why the two are one sprint.

**Sprint 12's audit is the outstanding instance.** QA1 audited `4885b05` and `aa5a281` and found no findings, and has nowhere to record it. That audit is carried here as context rather than as a debt to be settled by a bookkeeping entry on a closed sprint.

**Separately: a killed launcher orphans its billed child.** Confirmed under the scoped profile in published 0.1.13 — child `16859` went `ppid 16798 → 1` within five seconds of the launcher being killed and was still alive at 56 seconds. The scoped profile changes nothing. Roles run **75–170 seconds**, and an unattended orchestrator will use timeouts, so **every timeout leaves a live billed agent running in an unwatched repository.** This was deliberately kept out of sprint 14 pending evidence; it now has evidence.

**And five of six role profiles have been read but never exercised.** Only `qa1` has been run headless under the scoped profile. LiveQA named the two it would least want assumed: `pipeman` under `npm publish`, and the dev-team profiles doing source edits under `acceptEdits`.

### Requirements

1. **The live-loop audit branch accepts a sprint at `complete_ready`, not only during the live phases.** A sprint past the live gate but not yet closed is exactly when the unaudited commit becomes visible, and it is currently the one moment the record cannot be written.
   - **Append-only, unchanged and non-negotiable.** It must still write nothing but a history event: never `phase`, `qa1_audit_result`, `audit_rounds`, `qa1_audit_file_hash`, or `qa1_audited_tree_hash`. That property is what makes this safe to widen at all — an audit that cannot alter a gate verdict cannot launder one.
   - **`complete` is not included, and the boundary is narrower than "nothing writes to a closed sprint."** A closed sprint must not gain an **audit event** — a judgement about whether code is sound — because that is the thing a late entry could launder. It may gain a **verification event**: a record that a mechanical comparison was run against an artifact that still exists. Sprint 13's `verify-publish` already does exactly this, appending `content_check`/`gitHead_check` to sprints 11 and 12 after they closed, and that is legitimate — a published package can be re-checked months later and the check is worth recording. **State the distinction in the code**: verdicts close with the sprint, comparisons remain runnable. If that line proves impossible to draw cleanly, forbid the closed-sprint case entirely and say why.
   - **Confirm `cmd_gates` does not count the new event types.** It has been wrong twice about which events count as gate catches, and closed sprints are exactly its scope.
   - The gate-1 path (`dev_build`, `qa1_audit`, `dev_agreed_done`) is untouched.

2. **`cmd_reship` says, at the moment it runs, that the commit being shipped is unaudited and that the live-loop audit is available.** Not in an agent file — in the command's own output, where the situation arises. Sprint 7's lesson applies directly: naming a thing at the point of the wrong conclusion is what works, and a banner nobody reads is not.
   - The wording must not imply LiveQA's retest substitutes for a QA1 audit. That belief has now appeared in three separate handoffs despite the code saying otherwise in as many words.

3. **Killing the launcher must not leave the spawned child alive.** Establish the mechanism by running it, not by reasoning about signal semantics — the observed behaviour is reparenting to PID 1 within five seconds and surviving at least a minute.
   - **The interactive path must not regress.** Whatever handles the headless case must leave normal Ctrl-C behaviour in a terminal exactly as it is today.
   - If some kill signal or platform cannot be handled, name it rather than implying full coverage.

4. **`cmd_ship` prints the resolved SHA, not the ref it was given.** `--commit HEAD` currently prints `shipped (commit HEAD)` while `--commit <sha>` prints the SHA. The stored value is correct either way — LiveQA checked — but shipping with `HEAD` leaves no way to read back which commit was recorded, **and that is the exact value `--deployed-commit` has to match later.** One line, in a function this sprint already has open.

5. **Make `sprint_lifecycle.py`'s printed strings ASCII-clean on a Windows console.** Sprint 14 fixed `install.js` and left this file untouched — **seventeen printed strings still carry em dashes**, including `/sprint-list`'s own output at `:708` and the notes-file error at `:222`, both observed mojibaking as `ΓÇö` on a real Windows console at codepage IBM437.
   - *Master Controller's scoping gap, not a Dev Team miss.* Sprint 14's Req 2 named the installer and its two messages explicitly, so LiveQA correctly recorded this out of scope rather than re-specifying a sprint at its own gate. But sprint 14's title was "make the commands work on a default Windows box," and `/sprint-list` is a command that prints mojibake there.
   - **The fix is mechanical and the precedent is shipped** — copy what `install.js` does rather than inventing a second approach. Comments are not printed and are out of scope; only strings that reach a console.
   - `:222`'s notes-file error matters most: it is what a user sees **when something has already gone wrong**, which is the reasoning that made sprint 14's two messages worth fixing.

6. **Bump `package.json` to 0.1.16.** One line.

7. **Test coverage in `scripts/smoke_test.sh` and/or `scripts/launcher_test.js`.** At minimum: a live-loop audit at `complete_ready` writes only a history event and leaves all five protected fields untouched; the same call at `complete` is refused; the gate-1 path is unchanged; reship's new output appears.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1 is the load-bearing check, and it is a phase-gate widening.** Seed a scratch state file at `complete_ready` with a gate-1 PASS and both hashes populated, run the live-loop audit, and diff the state file. **Only the history array may differ.** **If any input reaches the gate-1 branch or writes `qa1_audit_result` from `complete_ready`, this is a FAIL, not a CONDITIONAL.** This is the same method that found sprint 7's record-corruption trap, and reading the diff did not surface that one either.
- Req 1: confirm `complete` is refused, and that the gate-1 tuple is byte-identical to today.
- Req 2: read the new output cold. Confirm it does not imply substitution between the two gates.
- **Req 3: demonstrate it.** Kill a launcher mid-run and confirm no surviving child, by process table rather than by absence of an error. Confirm interactive Ctrl-C is unchanged.
- Req 5: confirm no printed string in `sprint_lifecycle.py` carries a non-ASCII character, and that the check covers strings rather than comments. **Verify on a Windows console if one is available**; if not, say so — a source-level check is necessary and is not the same claim.
- Req 6: `package.json` is `0.1.16`, one-line diff.
- Req 7: **run both suites.**
- Run `scripts/verify-tarball.sh`.

**LiveQA verifies live, after Pipeman publishes:**

- **Confirm 0.1.16 is on the registry**, verifying published bytes against the audited commit — by `gitHead` if present, by content if not, per the rule sprint 13 documents.
- **The window is actually open.** On a real sprint at `complete_ready`, record a live-loop audit and confirm it lands, with the gate verdicts untouched. This is the case that has been impossible for fifteen sprints.
- **The orphan is gone.** Kill a launcher mid-run against the published build and confirm by process table that no child survives. This is the exact measurement that produced the finding — `ppid → 1` within five seconds, alive at 56.
- **The five unexercised profiles.** Run `pipeman`, both dev-team roles, `liveqa` and `master-controller` headless under the scoped profile against the published build. **`pipeman` under `npm publish` and the dev-team profiles doing source edits are the two to prioritise** if the run has to be cut short — they are the ones LiveQA named as least safe to assume. Record what was and was not exercised.

### Out of Scope

- **Recording sprint 12's outstanding audit.** It cannot be written — `complete_ready` was left behind when sprint 12 closed, and this sprint's Req 1 does not reach backwards into closed sprints by design. The audit's substance is in this sprint's Context: `4885b05` and `aa5a281`, both correct, no findings.
- **Sprint 13's gate fixes and sprint 14's Windows work.** Separate sprints, separate theses, both queued ahead.
- **Widening any other phase check.** Req 1 opens exactly one window, for one append-only command, with the boundary at `complete` stated.
- **The disclosure sweep**, unscheduled since sprint 4.
- **The uncommitted `.vscode/settings.json` change.**

### Dependencies

- **Blocks:** Nothing, but every reship until this lands ships a commit that cannot be audited on the record.
- **Blocked by:** Sprints 13 and 14 shipping, on the shared `package.json` version line. Sequential: 0.1.14, 0.1.15, then 0.1.16.
- **External: closed, do not re-raise.** Fifty Mission Cap fixed the orphan driver-side before their invocation sprint started — process-group teardown, two requirements, verified by their QA1 against a real three-member detached group (all members gone, read from `ps`, with an honesty control confirming no signals on an already-dead group) and passed by their LiveQA. It works against published 0.1.13 today and they are not waiting on this sprint. Our ppid measurement is cited in their sprint file. **This finding reached them three times because Master Controller re-drafted the handoff without tracking that it had been sent** — recorded here so a fourth does not follow.
- **Still open with them, and theirs to run:** `dev-team`-editing-source and `pipeman`-under-`npm publish` remain unverified in their context, which is a client checkout rather than this repo. Sprint 12 exercised only `qa1`, so we have no observed result to offer yet. **This sprint's LiveQA criterion is where one would come from** — and their framing is right, that an observed result is worth more than a profile definition.

### Team Assignments

- **Dev Team 1:** All of it. Two small changes to `sprint_lifecycle.py` and one to the launcher.
- **Dev Team 2:** Not assigned.

### Risks & Mitigations

- **Widening the phase check opens a route to launder a gate-1 verdict.** The worst outcome available here, and the exact trap an external team found in sprint 7 by demonstration rather than by reading. *Mitigation:* Req 1 names the five protected fields; QA1's criterion is a state-file diff from a seeded `complete_ready` file and is FAIL-level.
- **The orphan fix breaks interactive Ctrl-C**, trading a working path for a fixed one. *Mitigation:* Req 3 states it and QA1 confirms it directly.
- **Req 2 becomes noise** the way the `repo=` banner did — printed on every invocation and read on none. *Mitigation:* it prints only at reship, which is rare and is exactly the moment the situation arises.
- **The five profiles get inferred rather than run** because each costs a real billed run. *Mitigation:* LiveQA's criterion names the two to prioritise if the run is cut short, so a partial result is still honest rather than a silent gap.
