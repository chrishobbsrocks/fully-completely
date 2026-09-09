---
id: 26
title: "Re-grade every permission finding by how it was measured, and find what can be probed without a model"
epic: "Honest reporting"
status: done
created: 2026-09-09T00:14:02+00:00
---

# Master Controller Sprint Definition — Sprint 26

**Epic:** Honest reporting — a method that cannot reproduce itself cannot establish a bound, and ours produced twenty-three findings.
**Sprint Objective:** Re-grade every entry in the permission-scope findings document by how it was measured, mark what the method cannot support as unestablished, and determine what — if anything — can be probed without a model in the loop.

### Context

`docs/sprint-12-permission-scope-findings.md` carries **23 CONFIRMED entries** and is the evidence base for this framework's entire permission model. Sprints 12, 17 and 19 all argue from it; sprint 19's owned-repository grant was justified in part by scoping having been demonstrated to work.

**A large share of those entries were measured the same way: launch a role headless, give it an instruction, read `permission_denials` from the JSON envelope.** A downstream consumer ran our own harness — verified from `git show 867ba16`, both hash kinds matched, run unmodified — twice against CLI 2.1.265, same binary, same two roles, nothing differing but the clock.

**Three of eight verdicts moved. No `(role, probe)` pair produced DRIFT twice.** Their QA1's single sentence is the finding and everything here is downstream of it: *a single run of this harness cannot support a cross-version comparison.*

**Which means the method cannot distinguish a bound from a coin.** Sprints 17 and 21 both returned CONFIRMED on the same claim, two sprints apart. On this evidence those are two samples of a variable process that happened to agree — which is exactly what agreement looks like when a method manufactures it.

**Three corrections deep, the mechanism question is still open and the claim is much smaller than it started.** Master Controller offered that `liveqa` D held across all four observations, which would have pointed at enforcement rather than compliance; the consumer went to the raw and found D was observed twice per role, and **`qa1`'s D was a non-attempt in both runs, with narration of the persona declining on scope grounds.** Re-derived from the allowlist probes only, the basis narrows to **two pairs** — `qa1 B` and `liveqa B` — where the command is evidenced as attempted in both runs and the denial differs. And `qa1 A` moved from attempted-and-succeeded to not-attempted, so **compliance varies within a role as well as between roles.** Enforcement variance and compliance variance cannot be separated anywhere in this data. Suggestive; not a finding.

**Sprint 21 made this worse rather than better.** It anchored these findings to a CLI version so we would know when they expired. Anchoring an unreliable measurement is precision on top of noise, and it made the document look more solid than it was.

**One thing is settled and does not depend on the mechanism question at all:** two byte-identical runs at a fixed version produced different verdicts. Everything in this sprint follows from that and from nothing else.

**NARROWED BY EVIDENCE BEFORE THIS SPRINT STARTED.** Sprint 23's LiveQA ran the harness on **CLI 2.1.266** — one release past where the drift was found — and scoped it rather than confirming a general collapse:

- **The MCP gate demonstrably enforces.** With a real `@playwright/mcp` server supplied and the shipped grant applied verbatim: `browser_navigate` ran, `browser_run_code_unsafe` was **PERMISSION DENIED** with a real denial entry naming the tool. Same session, granted sibling ran, excluded tool refused. And `qa1` was denied `browser_navigate` **with the server present**, so it is a clean comparison rather than two flavours of absence.
- **Path-based Bash denial still works** — the harness's D control, writing outside the working directory, was denied on 2.1.266.
- **The drift is specifically unlisted single Bash commands writing inside the working directory.** Not a general collapse of the permission layer.

**So the re-grading in Req 1 must distinguish which mechanism an entry measured, not only how it was measured.** An entry about MCP tool exclusion or about path-based denial rests on a mechanism demonstrated to enforce on the current CLI; an entry about a Bash command inside the working directory rests on the one that drifted. **Grading everything as unestablished would be as wrong in one direction as the original document was in the other.**

**What is not rescued:** the Bash-side claims across sprints 17–22, several of which LiveQA itself gated. Its sprint-18 forced denial was true on the CLI then running; **whether it reproduces on 2.1.266 is open and was not tested.**

### Requirements

1. **Re-grade every entry in the findings document by how it was measured.** Two classes at minimum: **direct** — a shell command, a filesystem check, a hash comparison, something with no model deciding whether to act — and **model-mediated** — launch a role, instruct it, read the envelope. **The grade is about the method, not the confidence.** An entry can be carefully observed and still be model-mediated.

2. **Model-mediated entries are marked unestablished, not confirmed.** Not disproved, and not deleted — the observations happened and are worth keeping. **What changes is the claim they support.** Anything the permission model currently rests on that turns out to be model-mediated must be named explicitly, including which sprints cited it as settled.

3. **Determine what can be probed without a model in the loop, by trying.** The permission layer sits between a model's tool call and the system, so it may not be reachable any other way. **"Very little can be probed directly, and here is why" is an acceptable and possibly correct answer** — it would be a real constraint on what this framework can ever claim about permissions, and stating it plainly is worth more than a method that produces confident numbers.
   - **Do not design a replacement method in this sprint.** Establish what is measurable. Designing against an unestablished measurement surface is how the current document was built.

4. **Keep the harness's third branch in whatever comes next.** `scripts/permission-gate-repro.js:259` distinguishes *no denial recorded* from *no attempt made* — "the model may not have attempted the command at all. Not evidence." **That distinction is what turned a version question into a method question**, it caught our own false "cannot force a denial" conclusions in sprints 17 and 19, and the consumer's `qa1` D result is a live instance of it working. Nothing that replaces the method may collapse those two outcomes.

5. **Correct sprint 21's warning text, which now reassures exactly when the reassurance is false.** `run-role.js:159` tells the reader *"this bound has already survived one real CLI update unchanged"* — and the harness shipped in the same package disproves it. **A warning built to raise alarm that contains a calming claim which is no longer true is worse than no warning**, because it fires at the moment someone most needs to doubt.
   - The mechanism is sound and fired correctly on its first real instance. **What needs correcting is what it asserts.** It also says the findings were "last re-verified against 2.1.261", which reads as though re-verification established them. Say what re-verification can and cannot support given Req 1's grading, and remove the survived-unchanged claim rather than updating it to a new count.

6. **Bump `package.json` to 0.1.27.** One line.

7. **Test coverage** only where Reqs 3 or 5 produce code. Reqs 1, 2 and 4 are grading and documentation — **say so rather than adding a test for its own sake.**

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1: check the grading against the entries rather than accepting it.** Spot-check entries in both classes and confirm the class assigned matches how the entry says it was obtained. **An entry graded direct that actually involved launching a role is the defect this sprint exists to remove**, reproduced one level up.
- Req 2: confirm the count of unestablished entries is stated, and that the sprints citing them are named. **"Some entries" is not an acceptable finish** — this project has twice had to correct an enumeration that was short.
- **Req 3: confirm the attempt was made and its outcome recorded honestly.** If the answer is that little or nothing can be probed directly, confirm the reasoning is given rather than asserted, and that **no replacement method was designed on top of an unestablished surface.**
- Req 4: confirm the third branch survives intact wherever it appears, and that its rationale is recorded rather than left as a bare code path.
- **Req 5: confirm the survived-unchanged claim is gone**, not merely updated. Read the revised text cold: if it still implies re-verification establishes a finding, or still reassures at the moment it fires, it fails. This is the fifth comment in this project to have overclaimed and the first that did so inside a warning.
- Req 6: `package.json` is `0.1.27`, one-line diff.
- Req 7: run whatever suite applies.
- Run `scripts/verify-tarball.sh`.

**LiveQA verifies live, after Pipeman publishes:**

- **Confirm 0.1.27 is on the registry**, verifying published bytes against the audited commit per sprint 13's rule.
- **The corrected document reaches an existing install.** Upgrade a pre-0.1.27 install with untouched user-owned files and confirm the re-graded findings and the revised anchor text actually arrive.
- **Read the re-graded document cold**, as someone deciding whether to trust a permission claim. If an unestablished entry still reads as settled, that is the finding.
- **Do not attempt to re-establish any entry.** This sprint records what the method can support; running the unreliable method again to feel better about it is the failure mode.

### Out of Scope

- **Designing a replacement measurement method.** Req 3 establishes what is measurable and stops. Building a method against an unestablished surface is how the current document was produced.
- **Changing any permission behaviour, profile or allowlist.** Nothing here touches `run-role.js`'s profiles. Sprint 23 owns the LiveQA grant and has been amended to stop describing narrowness as a boundary.
- **Running `.261` or `.263`.** A single sample per version cannot support a cross-version comparison, so a version bisect is not informative until the method question is answered — and may never be.
- **The mechanism question** — whether the variance is enforcement or compliance. Two pairs, n=2, suggestive and not a finding. Recording it as open is the correct treatment.
- **Sprint 24's ship-to-verify path, sprint 25's session warning, and the sprint-file drift finding.** All independent of this.
- **The uncommitted `.vscode/settings.json` change**, twenty-six sprints running.

### Dependencies

- **Blocks:** Any future claim this framework makes about what a permission profile enforces.
- **Blocked by:** Sprints 23, 24 and 25 on the shared version line. **Not blocked technically** — if the queue reorders, this can move up, and the case for doing so is that every day it waits is a day the document reads as settled.
- **External:** The consumer has offered to re-run, re-check or fetch anything from their environment, and holds CLI versions 2.1.259 through 2.1.265. **The useful ask is not now** — it is whatever direct-probe design comes out of Req 3, tested somewhere that is not this machine. Asking before that would be asking them to run an experiment nobody has designed.

### Team Assignments

- **Dev Team 1:** All of it. Req 1 is the bulk and it is reading, not building.
- **Dev Team 2:** Not assigned.

### Risks & Mitigations

- **The re-grading is done by reading each entry's own confidence rather than its method**, producing a document that looks re-graded and is not. *Mitigation:* QA1 spot-checks both classes against how each entry says it was obtained.
- **Req 3 produces a replacement method rather than an answer**, because "we cannot measure this" is an unsatisfying deliverable. *Mitigation:* Out of Scope forbids it and QA1 checks for it specifically. A stated limit is the deliverable.
- **The unestablished entries get quietly re-run to restore confidence.** *Mitigation:* a LiveQA criterion forbidding it — the method is what is in question, so running it again establishes nothing and would feel like progress.
- **This lands as a crisis rather than a correction.** The permission model has not been shown to fail; it has been shown to be unverified by the method that verified it. *Mitigation:* Req 2 says unestablished rather than disproved, and the distinction is the whole point.
