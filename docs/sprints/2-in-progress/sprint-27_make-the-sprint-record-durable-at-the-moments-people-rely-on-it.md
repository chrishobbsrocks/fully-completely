---
id: 27
title: "Make the sprint record durable at the moments people rely on it"
epic: "Honest reporting"
status: in_progress
created: 2026-09-09T03:09:56+00:00
---

# Master Controller Sprint Definition — Sprint 27

**Epic:** Honest reporting — the record a gate depends on is uncommitted by default, and the window where it changes most is guarded by nothing.
**Sprint Objective:** Make the framework say what it just wrote, record a sprint file amended after the ship, and stop allowlisting browser tools nobody supplies a server for.

### Context

Three findings, two of them one thesis: **the sprint record is not durable at the moments people rely on it.**

**A. Nothing commits lifecycle bookkeeping.** `sprint_lifecycle.py` contains **zero** `git commit` or `git add` calls, which is deliberate — the script owns state, git belongs to a role, and `cmd_ship` performs no git operations at all. But `/sprint-start` moves a file between phase folders, writes a state file and bumps the registry; `/sprint-complete` does the equivalent. **Neither commits, so after every transition the working tree carries `docs/sprints/` changes until some role happens to sweep them.**

Reported by a downstream consumer's Pipeman, which hit it three times in one day. **Their consequence is worse than ours and worth recording**: their release gate reads *committed* state, correctly, so a close sitting uncommitted means no commit contains that sprint's LiveQA PASS and nothing downstream can be a gated release. **Our gates read the working tree, so we get no refusal** — the drift simply accumulates silently.

We get a different symptom for the same cause: **five separate occasions where a gate recorded a verdict against an uncommitted sprint file**, every one caught by QA1 holding rather than by any mechanism. Sprint 18's Req 4 added a commit rule for Master Controller; nothing covers the bookkeeping every other role generates. At the time of writing, sprint 24's own state file is untracked — if this machine were lost, its start would be gone.

**B. A sprint file amended between the ship and the live verdict is guarded by nothing.** `cmd_dev_done` refuses outright on sprint-file hash drift, no override. `cmd_liveqa` has no equivalent check of any kind — its guards are phase, git repository, commit resolution, shipped-commit-on-record, deployed-commit identity, and verdict validity. **So the framework guards the window that is minutes long and spans one session, and leaves open the one that is hours or days and spans three** — which is precisely where a Master Controller discovers an unsatisfiable acceptance criterion and reaches for the file.

Two instances reported, both from one operator in one day across two projects; one was self-flagged, the other caught by a role reading the artifact instead of the summary. Master Controller here has done the same repeatedly — sprints 10, 14 and 19 twice.

**The obvious symmetric fix is wrong, and the reporter said so before we could.** A live-gate amendment is often legitimate — a criterion genuinely has no premise, a requirement is genuinely unbuildable — and the recovery from a refusal is a full lap: CONDITIONAL, back to `dev_build`, re-audit, dev-done, reship, another live round, for a prose amendment. That fails our own transition-precondition rule: the role that hits it cannot clear it and the recovery is disproportionate. Their sentence is the design brief: **a refusal with a full-lap recovery makes the honest move more expensive than the dishonest one, which is how you teach people to amend quietly.**

**C. The launcher allowlists 27 Playwright tool names and supplies no server.** `--mcp-config` appears exactly once in `run-role.js`, at :653, **inside a comment** describing how the tool names were discovered. `headlessLaunchArgs()` contains no MCP references at all. Sprint 23's LiveQA found this on its first honest attempt: a real headless launch returned `TOOL NOT AVAILABLE` — not denied, not reachable. **The grant is correct and necessary and not sufficient.** A downstream LiveQA gets these tools only if that project configures a server itself, with no warning they are absent.

### Requirements

1. **Every lifecycle command that writes says what it wrote and that it is uncommitted.** A completion notice, not a drift warning — printed once, at the moment it is true, where the wrong conclusion ("the record is saved") is actually formed.
   - **Do not make the script commit.** `cmd_ship` performing no git operations is a deliberate property: the script owns state, git belongs to a role. Preserve it.
   - **Do not add a drift warning that fires on uncommitted bookkeeping.** Bookkeeping is uncommitted by default after every transition, so such a warning would fire almost always — and a warning that always fires is the `repo=` banner that four wrong conclusions were drawn straight past.

2. **Extend the commit rule from Master Controller to every role.** Sprint 18 added it to `master-controller.md` for sprint-file amendments. **The role that runs a lifecycle command commits the bookkeeping that command produced**, before handing off. Prose is not enforcement — sprint 9's publish ordering was fixed this way and drifted on the very next release — which is why Req 1 exists to prompt it rather than relying on the rule alone.

3. **`cmd_liveqa` records that the sprint file changed since the audit. It does not refuse.**
   - Compare the sprint file against `qa1_audit_file_hash` and, on a difference, **record it in the state history and surface it in the verdict output** so it is on the durable record rather than in a commit message.
   - **State in the code why this warns rather than refuses**, including that the recovery from a refusal would be a full lap for a prose amendment. A future reader must see it was decided, not overlooked.
   - **Say what re-gating actually costs.** `_qa1_live_loop_audit` is append-only and cannot write `qa1_audit_file_hash`, and `cmd_qa1` cannot reach gate-1 logic from `liveqa_live` — so a QA1 verdict in that phase is an opinion, not a re-gate. That is currently undocumented and someone will assume otherwise.

4. **Either supply an MCP server or say the grant needs one.** The 27 allowlisted Playwright tools reach nothing without `--mcp-config`. **Whichever way this goes, the failure must stop being silent** — a downstream LiveQA currently gets `TOOL NOT AVAILABLE` with nothing telling it a server was never configured.
   - **Determine by running** whether the launcher can supply one usefully without knowing the target project's setup. **"It cannot, and here is what a project must configure" is an acceptable outcome** — as long as it is said where someone hits it.

5. **Say what 0.2.0 signals, where a consumer sees it before acting.** *This sprint's version target changed from 0.1.30 — it is the milestone release, not the next patch.*
   - **Nothing here is breaking.** Every change since 0.1.6 has been additive or corrective. **But in `0.x` a minor bump conventionally signals a breaking change**, and a downstream consumer pins this package and re-verifies its contract against every published version. They will read 0.2.0 as breaking and do work that is not needed unless told otherwise.
   - State it in the README or equivalent, not only in a commit message: 0.2.0 marks that **the framework's own debts are paid** — the package has been read for what it discloses (0.1.23), its permission findings are honestly graded (0.1.27), and its sprint record is durable (this release) — **and that it is not a breaking release.**

6. **Write a CHANGELOG.** **Twenty-eight versions have been published and nothing records what changed between them.** A consumer pinning a version has no way to know what moving costs, and one has been re-deriving it from our commits every release.
   - **The mapping already exists** — every closed sprint is an entry. 0.1.10 is the Windows path fix, 0.1.19 is the ownership grant, 0.1.23 is the disclosure sweep. **Transcription, not archaeology.**
   - **Mark the corrections as corrections.** Several releases fixed what an earlier one got wrong: 0.1.5 shipped a mechanism that reached no existing install, 0.1.8 shipped a message that stated a falsehood, 0.1.27 re-graded fourteen findings this project had cited as settled. **A changelog reading as a clean march of features would be its own small dishonesty**, on a project whose record is otherwise unusually frank.

7. **Bump `package.json` to 0.2.0.** One line.

8. **Test coverage** for Reqs 1 and 3 in `scripts/smoke_test.sh`: a writing command prints the notice; a read-only command does not; an amended sprint file is recorded at `cmd_liveqa` and the verdict still records.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1: confirm no `git commit` or `git add` was added to `sprint_lifecycle.py`.** That count is zero today and must stay zero. **Adding one is a FAIL** regardless of how well scoped — the property being protected is that the script does not touch git.
- Req 1: confirm the notice fires on writing commands only, and read it cold. If it reads as a warning about a problem rather than a statement of what just happened, it will be tuned out.
- Req 2: read the extended rule against the five recorded instances. If it would not have caught them, it is not written correctly.
- **Req 3 is the one most likely to be built as a refusal**, because a refusal feels stronger. **Confirm it records and never blocks.** A `cmd_liveqa` that can refuse on sprint-file drift is a FAIL, not a CONDITIONAL — the reasoning is in Context and must survive in the code.
- Req 3: confirm the re-gating cost is documented, and check the claim about `_qa1_live_loop_audit` against the code rather than accepting it.
- Req 4: confirm the outcome was **established by running**, and that if no server can be supplied, the message names what a project must configure.
- **Req 5: read the 0.2.0 statement cold, as a consumer who pins.** If it could be taken as announcing a breaking change, it fails — that misreading costs someone a day of contract re-verification they did not need.
- Req 6: spot-check entries against the sprints they claim to describe. **Confirm the corrections are marked as corrections**, not presented as features.
- Req 7: `package.json` is `0.2.0`, one-line diff.
- Req 8: **run the suite.**
- Run `scripts/verify-tarball.sh`.

**LiveQA verifies live, after Pipeman publishes:**

- **Confirm 0.2.0 is on the registry**, verifying published bytes against the audited commit per sprint 13's rule.
- **Run a transition and read what it prints.** `/sprint-start` in a scratch repo: confirm the notice names the files written and that they are in fact uncommitted afterwards.
- **Amend a sprint file mid-`liveqa_live` and record a verdict.** Confirm the drift appears in the state history and the verdict is still accepted. **A refusal here is the finding.**
- **The MCP outcome, whichever it is.** If a server is supplied, confirm a headless LiveQA reaches a browser tool. If not, confirm the message tells it what to configure — `TOOL NOT AVAILABLE` with no explanation is the state this sprint exists to end.

### Out of Scope

- **Making the script commit.** See Req 1. The property is deliberate and a scoped commit would still be the script touching git.
- **A symmetric hash gate at `liveqa_live`.** Rejected on reasoning both projects arrived at independently — see Context. Recording it here so a future reader sees it was declined rather than missed.
- **Re-establishing anything in the permission findings document.** Sprint 26 graded 14 of 16 claims unestablished; running the unreliable method again establishes nothing.
- **Sprint 24's ship-to-verify work and sprint 25's session warning.** Both queued ahead on the version line.
- **The uncommitted `.vscode/settings.json` change** — which, twenty-seven sprints in, is now the longest-standing item in this repository and is not bookkeeping.

### Dependencies

- **Blocks:** Nothing. All three are gaps in what the framework says, not in what it does.
- **Blocked by:** Sprints 24 and 25, both shipped. **This is the 0.2.0 release** — the last inward debt, with the version marker riding on it.
- **External: a consumer must be told before this publishes that 0.2.0 is a milestone and not a breaking change**, since they pin and re-verify per published version. Findings A and B came from that same consumer, A from their Pipeman rather than their Master Controller. Finding C came from our own LiveQA on its first honest attempt at sprint 23's grant.

### Team Assignments

- **Dev Team 1:** All of it. Three independent pieces, two files.
- **Dev Team 2:** Not assigned.

### Risks & Mitigations

- **Req 3 gets built as a refusal** because recording feels weak next to a gate. That would make the honest amendment more expensive than the quiet one, which is the outcome the design exists to avoid. *Mitigation:* FAIL-level QA1 criterion, and the reasoning stated in the code rather than only in this file.
- **Req 1's notice becomes noise** and is tuned out like the `repo=` banner. *Mitigation:* it fires on writing commands only, once, and QA1 reads it cold for whether it sounds like a problem report rather than a receipt.
- **Someone adds a scoped `git add docs/sprints/` to the script** as an obvious improvement. *Mitigation:* Req 1's criterion is a zero-count check on the whole file.
- **Req 4 concludes a server cannot be supplied and stops there**, leaving the silent failure in place. *Mitigation:* the requirement is that the failure stops being silent, not that a server gets supplied — those are different deliverables and only the first is mandatory.
