---
id: 11
title: "Launch a role headless, with its opening prompt read from a file"
epic: "Framework rules and distribution"
status: in_progress
created: 2026-09-02T06:03:07+00:00
---

# Master Controller Sprint Definition — Sprint 11

**Epic:** Framework rules and distribution — the framework has to be drivable by the systems that install it, without those systems forking it.
**Sprint Objective:** Add a headless launch path to `run-role.js` that emits a clean machine-readable stream, takes its opening prompt from a file rather than argv, and carries its own credentials — then discover, by running them, what each of the six roles actually needs in that opening prompt.

> **LiveQA's gate is REDEFINED, not skipped**, same as sprints 3–10 and for the
> same mechanical reason (`sprint_lifecycle.py:688`). **"Live" here means
> launching real roles headless from a published install and driving a real
> throwaway sprint through both gates.** Req 5 cannot be verified any other way.

### Context

Requested by Fifty Mission Cap, an internal delivery system that installs this framework into target repos and drives their `docs/sprints/` from outside, through `sprint_lifecycle.py` and state files only — never reading agent files, never editing sprint files. Their repository boundary forbids them editing framework internals, which is their defence against drift. Headless launching benefits every project that installs this framework, so it is framework-owned by nature rather than by their preference.

**Their code claims were verified here before this sprint was written.** `launchFresh` at `run-role.js:68` is the seam: `spawnClaude(['--agent', role.id, '--session-id', uuid, '--name', sessionTitle, initialPrompt(role.label)])`. `stdio: 'inherit'` at :57. `prompts.js` exports exactly `initialPrompt` and `devTeam2ResumePrompt`. There are zero headless references anywhere in `scripts/`, `templates/` or `CLAUDE.md` today.

**The JSON shape is settled by primary source, not by message.** `/Users/chrishobbs/Programming/Fifty_Mission_Cap/metering/output-format-json-notes.md` at commit `39a12fd` records a real, billed `claude -p --output-format json` run against `claude` 2.1.258, with the complete envelope pasted verbatim. Quote field names from that file, pinned at that commit — not from any relayed message. Four separate handoffs corrupted in transmission this week, and a JSON field list is the worst possible payload for a lossy channel.

**Their withdrawn requirements are not in this sprint and should not be added back.** Fifty Mission Cap is not automating sprint closure; their orchestrator has no path to `/sprint-complete`. The provenance field for standing authorization and the framework-side escalation limit were both proposed here and both withdrawn on evidence — max `audit_rounds` across ten sprints is 2, so the loop the escalation limit would guard has never occurred. Whoever automates closure first will meet `--user-said` with a real case in hand, which is a better moment to design it than now.

### Requirements

1. **A headless launch path on `run-role.js`, as a separate OS process.** Roles must remain separate processes exactly as they are today. `CLAUDE.md` forbids one role session sub-agenting another; **headless must not become a loophole for that**, and this requirement is the reason to say so explicitly in the code rather than rely on it being obvious.

2. **Headless stdout carries the machine-readable stream and nothing else.** The consumer parses it; anything the launcher prints corrupts it. `run-role.js:121` (`console.log("Restarting …")`, on the `--restart` path) is the only current stdout write and is the known offender — errors already go to stderr via `console.error` at :40. Route all launcher output to stderr on the headless path, or suppress it. **We emit the envelope; we do not parse it** — no code in this sprint should depend on field names inside it.

3. **The opening prompt is read from a file, not passed on argv.** Today `launchFresh` passes `initialPrompt(role.label)` as a positional argument. A backticked expression in a `--notes` argument was command-substituted out of a permanent LiveQA record this week; the same shell exposure exists here. The `--*-file` pattern already exists across this CLI for exactly this reason — extend it to the opening prompt.

4. **Headless carries its own credentials and fails legibly without them.** Per the pinned notes: `--bare` reads only `ANTHROPIC_API_KEY` or `apiKeyHelper`, never OAuth or keychain. An unauthenticated attempt returned `is_error: true` with `"result": "Not logged in · Please run /login"`, and — importantly — **the envelope stayed well-formed with the same top-level shape, zeroed values, and no `modelUsage` entries.** A caller metering `total_cost_usd` naively would record that as a real zero-cost run. Headless must not inherit the launching operator's auth, and the failure must be legible rather than silent.

5. **Discover the six per-role opening prompts by running them. This is the sprint's deliverable; the flag is the easy half.** They cannot be written from a desk. Launch each of the six roles headless, by hand, in sequence, through one throwaway sprint and both gates, and record what each role actually needed in order to do its job without a human in the loop. **Answer explicitly whether these are fixed per role or templates parameterized by the work** — a headless QA1 needs to know *which sprint* it is auditing, which an interactive `initialPrompt(role.label)` never had to convey. If they turn out to be templates, say what the caller must supply.

6. **The interactive path is regression-verified mechanically, not asserted.** Two launch paths is an accepted maintenance cost, and only on the condition that the existing one demonstrably still works. A claim in a handoff does not satisfy this.

7. **Mandate `--notes-file` for notes containing backticks, `$`, or code, in `qa1.md` and `liveqa.md`.** Included on the strength of a real incident, not a hypothetical: a line of a permanent LiveQA record was lost to shell command-substitution this week. Same failure class as Req 3, different files, independently reviewable.

8. **Bump `package.json` to 0.1.11.** One line.

9. **Test coverage in `scripts/launcher_test.js`.** At minimum: headless writes nothing to stdout that isn't the child's stream, including on the `--restart` path; the prompt file is read and a missing file fails clearly; the interactive path is unchanged.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- Req 1: confirm headless spawns a separate process and that nothing in the change permits one role to invoke another. Read it as someone looking for that loophole.
- **Req 2 is the one a diff hides.** Trace every path that can write to stdout on the headless path, including error and `--restart` paths, and confirm each is stderr or suppressed. A single stray line breaks every consumer parsing the stream, and it will look fine in review.
- Req 3: confirm the prompt never transits argv on the headless path, and that a missing or unreadable file fails with a message that says which file.
- Req 4: check the behaviour against the pinned notes at `39a12fd` — **read that file, do not take its contents from this sprint file or any message.** Confirm the failure is legible and that headless does not fall back to operator auth.
- **Req 5: this cannot be cleared by reading.** Confirm the six prompts were derived from actual headless runs and that the notes record what was observed, including the fixed-vs-template determination. If they read as though they were written from a desk, say so.
- Req 6: confirm the interactive regression is a runnable check, not a statement.
- Req 7: read both files' new wording cold. Confirm it names the characters that trigger it.
- Req 8: `package.json` is `0.1.11`, one-line diff.
- Req 9: **run `node scripts/launcher_test.js`.**
- Run `scripts/verify-tarball.sh`.

**LiveQA verifies live, after Pipeman publishes:**

- **Confirm 0.1.11 is on the registry** and its `gitHead` matches `last_shipped_commit`, from `npm view`.
- **The real thing, end to end.** From a published 0.1.11 install in a scratch repo, launch each of the six roles headless and drive one throwaway sprint through both gates. This is Req 5's verification and there is no substitute for it.
- **stdout is parseable.** Pipe a headless run into a JSON parser and confirm it succeeds. Repeat on the `--restart` path, which is where the known stray write lives.
- **Auth isolation.** Run headless in an environment with no `ANTHROPIC_API_KEY` and confirm it fails legibly rather than borrowing the operator's session.
- **The interactive path still works** — launch the roles the normal way, via the VS Code task, and confirm seven terminals with each agent announcing its role. Verified working on both macOS and Windows as of 0.1.9; it must stay that way.

### Out of Scope

- **Provenance for standing authorization, and a framework-side escalation limit.** Both proposed here, both withdrawn on evidence. See Context. Do not reinstate without an instance.
- **Parsing or depending on any field inside the JSON envelope.** We emit it. The consumer parses it. A framework that keys on undocumented internal fields inherits their churn.
- **Anything in `sprint_lifecycle.py`.** This is a launcher sprint.
- **Sprint 10's unanswered Req 6** (the `/tmp` paths on Windows, five command files not three). Still open, still needs Windows access, and it belongs to sprint 10's close rather than being absorbed here.
- **Naming framework-owned files that have drifted before replacing them.** Deferred a fifth time.
- **The disclosure sweep**, still unscheduled since sprint 4.
- **Fixing CLAUDE.md's own-tooling clause.** Tenth sprint working around it.
- **The uncommitted `.vscode/settings.json` change.**

### Dependencies

- **Blocks:** Fifty Mission Cap's Sprints 3–5, which stay unfiled until this lands — writing them against an unbuilt flag is the trap their own Sprint 1 Requirement 7 existed to avoid.
- **Blocked by:** Nothing, for the build. **Shipping is blocked** until sprint 10 ships as 0.1.10 and the workshop registry freeze lifts — both sprints park at `dev_agreed_done` until then, and 0.1.11 goes out after 0.1.10, not before.
  - **Build this in a worktree** (`/sprint-worktree 11`). Sprint 10 is sitting at `dev_agreed_done` in the main checkout with a release commit that must not be disturbed.
  - **Req 5's discovery pass runs in a throwaway scratch repo, never in this one.** Driving a sprint through both gates creates real registry entries and real state files; doing that here pollutes this project's own sprint history. Use a `git init` directory with a published install, exactly as the Windows testing did.
  - **Hold the version bump until ship time** if 0.1.10 has not gone out yet — Req 8 and sprint 10's Req 7 edit the same line in `package.json`.
- **External:** The pinned notes at `39a12fd` in the sibling repo are an input, not a dependency — read them, do not vendor them.

### Team Assignments

- **Dev Team 1:** All of it. Req 5 is the bulk of the work and it is sequential by nature.
- **Dev Team 2:** Not assigned.

### Risks & Mitigations

- **A stray stdout write breaks every consumer, silently and later.** The failure appears as a JSON parse error in somebody else's system, far from the cause. *Mitigation:* Req 2's criterion traces every write path rather than reading the diff; LiveQA pipes a real run into a parser, including on `--restart`.
- **The six prompts get written from a desk** because running six roles through two gates is slow and the flag will already work. That would ship the easy half and call it done. *Mitigation:* Req 5 states it, QA1 is told to detect it by tone, LiveQA re-runs it end to end.
- **Headless becomes the sub-agenting loophole** `CLAUDE.md` has forbidden since the incident that put the rule there. *Mitigation:* Req 1, and a QA1 criterion that reads for it specifically.
- **The interactive path rots** because everyone tests the new one. *Mitigation:* Req 6 as a runnable check, and a LiveQA criterion covering both platforms.
- **Field names in the envelope change under us.** *Mitigation:* Out of Scope — we emit, we do not parse. The consumer owns that coupling and has recorded it against a pinned version.
