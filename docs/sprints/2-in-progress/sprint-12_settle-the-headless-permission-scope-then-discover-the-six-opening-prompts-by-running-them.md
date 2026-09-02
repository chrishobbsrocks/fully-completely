---
id: 12
title: "Settle the headless permission scope, then discover the six opening prompts by running them"
epic: "Framework rules and distribution"
status: in_progress
created: 2026-09-02T18:52:30+00:00
---

# Master Controller Sprint Definition — Sprint 12

**Epic:** Framework rules and distribution — a capability the framework ships has to have been run, not just written.
**Sprint Objective:** Establish by testing what the narrowest workable permission scope for a headless role actually is, put that decision to the user on real evidence, and then complete the discovery pass sprint 11 could not: what each of the six roles needs to hear when nobody will answer.

> **LiveQA's gate is REDEFINED, not skipped**, same as sprints 3–11 and for the
> same mechanical reason (`sprint_lifecycle.py:688`). **"Live" here means real
> headless roles, launched from a published install, driving a real throwaway
> sprint through both gates.** That is the deliverable, and it is the thing
> sprint 11 could not do.

### Context

Sprint 11 shipped the headless launch path with everything verified except the prompts themselves: exit codes exercised, stdout purity confirmed, auth on the operator's own session confirmed, 116 tests green. **Its Req 5 — discover the six opening prompts by running the roles — was rescoped out on the record**, because completing it requires headless roles that can write files and execute scripts, and that requires a decision nobody should make under the schedule pressure of a blocked sprint.

The blocker is precise. A `--permission-mode bypassPermissions` change was blocked three times by Claude Code's own safety classifier with an instruction to stop. Dev Team escalated it, correctly, and then asked QA1 to apply the diff from a session with different access. **QA1 refused, across two rounds under pressure to close, on the grounds that a control clearable by asking a different session is not a control.** That refusal is the reason this sprint exists instead of a quiet bypass, and it should be read as the framework working rather than as an obstacle.

**The binary being assumed is probably false, and nobody has tested the middle.** The choice is presented as blanket bypass or a headless mode that can do nothing — and read-only headless genuinely is useless, since QA1 runs test suites, Dev Team writes code, and Pipeman runs git and npm. But a scoped permission allowlist, combined with running only in a caller-designated directory, would bound the blast radius without disabling the control. Whether Claude Code supports that granularly enough **is unknown and has not been tested by anyone here.**

Sprint 11's side-effect documentation is the input to this: hooks fire and `CLAUDE.md` auto-discovery happens under a normal non-`--bare` run (both confirmed by running), `--safe-mode` is unusable because it also disables `--agents`, attribution evidence is weak and labeled weak, auto-memory is inconclusive and labeled inconclusive, and LSP, plugin sync, background prefetches and keychain reads are named as untested rather than assumed suppressed.

### Requirements

1. **Establish, by testing, what the narrowest permission scope is that lets a headless role do its job.** Not by reading help text — sprint 11's own evidence-grading is the standard here. Determine concretely: what a headless Dev Team needs in order to write source files and run the test suite; what QA1 needs in order to run tests and read code without writing source; what Pipeman needs for git and npm; what Master Controller needs to write a sprint file. **Report what each role minimally requires and what each demonstrably does not.**

2. **Test whether scoping actually works before anyone concludes it doesn't.** Try a per-role tool allowlist, a caller-designated working directory, and any combination that bounds the blast radius. **Grade the findings the way sprint 11 graded its side effects** — confirmed by running, weak with the weakness named, inconclusive with the reason, untested and named as untested. A scope that "should work" but was never run is untested, and must be labeled that way.

3. **The permission decision is the user's, made on Req 1 and Req 2's evidence, and recorded before any run that depends on it.** Master Controller writes the chosen scope into this file as an amendment. **Blanket `bypassPermissions` is permitted only if scoping is demonstrated not to work**, and then only as an explicit recorded decision naming what it grants. **Nobody routes around a blocked control by changing sessions, at any point in this sprint, for any reason.**

4. **Complete the discovery pass.** Launch each of the six roles headless, by hand, in sequence, through **one throwaway sprint driven through both gates, in a scratch `git init` directory — never this repo.** Record what each role actually needed in order to work with nobody to answer it.

5. **Replace sprint 11's provisional templates with what was observed, and say which parts changed.** Sprint 11 shipped them explicitly labeled as an unvalidated design. Where a run confirms the design, say so. Where it contradicts it, say what was wrong and why the desk version missed it — that is the finding, and it is the reason this sprint exists.

6. **The message points; it does not summarize.** Carried unchanged from sprint 11. No verdicts, failure notes, requirements or phase history composed into a prompt — all of it is on disk already and it is what the interactive roles read. A blocked sprint's escalation says *read sprint 4's state*, never restates it.

7. **Bump `package.json` to 0.1.12.** One line.

8. **Test coverage in `scripts/launcher_test.js`** for anything Reqs 4–5 change in the templates or the composition path. If nothing changes, say so rather than adding tests for their own sake.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 2 is the load-bearing check.** Read the permission findings for anything asserted without a run. Sprint 11 set the bar and cleared it; this sprint is held to the same one. **An unrun scope claimed as working is a FAIL, not a CONDITIONAL.**
- Req 3: confirm the chosen scope is recorded in this file as an explicit decision, and that no step of this sprint applied a blocked change from a different session. **If blanket bypass was taken, confirm it is recorded as a decision with what it grants named — not inherited by default because scoping was inconvenient.**
- **Req 4 cannot be cleared by reading**, and this is the requirement sprint 11 could not meet. Confirm the runs actually happened, in a scratch repo and not this one, and that the notes record what was observed rather than what was expected.
- Req 5: read the diff between sprint 11's provisional templates and these. **If nothing changed, that is a finding worth stating explicitly** — it would mean the desk design survived contact, which is informative rather than a non-event.
- Req 6: read every template for restated state and flag each.
- Req 7: `package.json` is `0.1.12`, one-line diff.
- Req 8: **run `node scripts/launcher_test.js`.**
- Run `scripts/verify-tarball.sh`.

**LiveQA verifies live, after Pipeman publishes:**

- **Confirm 0.1.12 is on the registry** and its `gitHead` matches `last_shipped_commit`, from `npm view`.
- **The deliverable, end to end.** From a published 0.1.12 install in a scratch repo, launch each of the six roles headless and drive one throwaway sprint through both gates. This is what sprint 11 could not do and there is no substitute for it.
- **The permission scope holds in practice.** Confirm a headless role can do its job under the recorded scope, and — if scoping was chosen over bypass — confirm it is genuinely constrained rather than nominally so.
- **The interactive path still works**, on both macOS and Windows. Two launch paths remain an accepted cost only while the original demonstrably works.

### Out of Scope

- **Anything in sprint 11's verified surface** — exit codes, stdout purity, auth, the composition model, the CLI shape. All confirmed by running. Do not re-derive them.
- **CRLF and line endings.** Eliminated by evidence in sprint 10.
- **Widening LiveQA's definition, correcting CLAUDE.md's own-tooling clause, and recording the mechanism-not-automation boundary.** Still queued, still real, still no instance forcing them.
- **The cross-tree sprint-file divergence** — a sprint file amended on one branch is invisible to the hash gate on another. **Two real instances now** (Dev Team built against a stale spec, a downstream consumer specified against a stale requirement). The strongest-evidenced item on the backlog and deliberately not bundled here.
- **The disclosure sweep**, unscheduled since sprint 4.
- **The uncommitted `.vscode/settings.json` change.**

### Dependencies

- **Blocks:** Fifty Mission Cap's invocation sprint gets real templates rather than a provisional design. They are not blocked on this — sprint 11 ships them a working flag — but what they receive from 0.1.11 is labeled unvalidated, and this is what validates it.
- **Blocked by:** Sprint 11 shipped as 0.1.11. **And by a decision, not a phase**: Req 3's permission scope must be recorded before Req 4 can run. The sprint can start on Reqs 1–2 immediately; it stalls at Req 3 until the user decides, by design.
- **External:** The npm publish is Pipeman's, using sprint 9's ordering.

### Team Assignments

- **Dev Team 1:** All of it. Reqs 1–2 are investigation, Req 4 is sequential by nature.
- **Dev Team 2:** Not assigned.

### Risks & Mitigations

- **Blanket bypass gets taken because scoping is fiddly**, and an unattended agent ends up with no permission gate by default rather than by decision. *Mitigation:* Req 3 permits it only on demonstrated evidence that scoping fails, and QA1 checks it was recorded as a decision naming what it grants.
- **Someone routes around the blocked control** by applying the change from a session with different access. It was already attempted once. *Mitigation:* Req 3 forbids it explicitly, QA1 already refused it twice on the record, and this sprint exists because that refusal held.
- **The discovery gets desk-written again** because the flag already works and running six roles through two gates is slow. *Mitigation:* Req 4's criterion cannot be cleared by reading; QA1 detected exactly this in sprint 11 and will be looking for it.
- **The templates come back unchanged**, and it reads as though nothing was learned. *Mitigation:* Req 5's criterion makes "unchanged" an explicit finding — the desk design surviving contact is informative, and stating it is the requirement.
