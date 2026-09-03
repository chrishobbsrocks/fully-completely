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

3. **`run-role.js` composes the opening prompt itself, from its own per-role template, taking exactly one parameter: the sprint id.** *Amended — this replaces "read the prompt from a file" as the default path.* The consumer's shape is `run-role.js --headless --agent qa1 --sprint 4`: it says which role runs next on which sprint and knows nothing about what that role needs to hear. A file override is an escape hatch, **not the default** — if callers must supply prompt text, every consumer reinvents this sprint's research and role semantics leak into their drivers.
   - **The composition path must never route prompt text through a shell.** `spawnClaude` already uses `spawn(cmd, args)` with no `shell: true`, so argv inside the launcher is safe today — the `--notes` record lost this week was destroyed by a shell interpreting text *before* Node saw it, a different vector. A sprint id is a low-risk interpolation; the mechanism must not depend on that staying true.
   - **The file override is read from a path**, never passed as prompt text on a command line.

4. **Headless runs on the operator's existing Claude authentication, and must not require a separate API key.** *Amended mid-build — this reverses this requirement's original isolation goal.* The original came from the consumer's brief: headless must never inherit the operator's session, which `--bare` enforces by reading only `ANTHROPIC_API_KEY` or `apiKeyHelper`. **That is a consumer preference and it does not outrank the framework owner's decision about which account this tool runs on.** Headless must work on a normal logged-in Claude session; a separate API key must not be a precondition.
   - **The side-effect half of the concern stands and is NOT reversed.** `--bare` bundled credential isolation with skipping hooks, LSP, plugin sync, attribution and auto-memory. Only the credential half is withdrawn. An unattended run that fires hooks or writes auto-memory into whatever directory it lands in is a real hazard, separable from which credentials are used.
   - **Determine what side-effect suppression is achievable without `--bare` by testing, not by reading help text, and record it.** A documented unsuppressible side effect is acceptable; an assumed-away one is not.
   - **Metering is unaffected and already verified.** The pinned notes at `39a12fd` recorded their primary envelope from a normal OAuth, non-`--bare` run — exactly the path this selects. The `--bare` finding there is a caveat about `--bare`, not about this implementation.
   - **A separate key must remain usable** for a consumer that wants isolation — an option, never a requirement.

5. **The six per-role templates ship as an explicitly provisional design. The discovery pass is RESCOPED OUT of this sprint and owned by sprint 12.** *Amended by Master Controller after QA1 round 4, on the record, with the reason — not quietly dropped.*
   - **Why.** Completing the discovery requires launching roles headless that can write files and execute scripts, which requires deciding whether unattended roles run with permission prompts disabled. That is a real security decision with real blast radius, it belongs to the user, and **it must not be made under the schedule pressure of a blocked sprint.** Deciding it because a sprint is stuck is the wrong reason to decide it. QA1 named this correctly: it has no findings left for Dev Team, and a CONDITIONAL that names no clearable fix is the unclearable-precondition pattern this framework has a rule against.
   - **What ships.** The templates as a design, derived from this requirement's own guidance, **labeled as such in the code**. The comment must state plainly what was and was not established — that one Dev Team launch was attempted and blocked at the first tool call, that no role completed an audit or drove a gate, and that the templates are therefore unvalidated by running. It must not read as though the discovery happened.
   - **The side-effect findings stay**, and are the substantive result this sprint did produce: four grades correctly assigned, with weak evidence named as weak, inconclusive named as inconclusive, and four items named as untested rather than assumed suppressed.
   - **What does not ship.** Any claim that the templates were validated by running the roles. Sprint 12 owns that.

6. **The interactive path is regression-verified mechanically, not asserted.** Two launch paths is an accepted maintenance cost, and only on the condition that the existing one demonstrably still works. A claim in a handoff does not satisfy this.

7. **Mandate `--notes-file` for notes containing backticks, `$`, or code, in `qa1.md` and `liveqa.md`.** Included on the strength of a real incident, not a hypothetical: a line of a permanent LiveQA record was lost to shell command-substitution this week. Same failure class as Req 3, different files, independently reviewable.

8. **Bump `package.json` to 0.1.11.** One line.

9. **Test coverage in `scripts/launcher_test.js`.** At minimum: headless writes nothing to stdout that isn't the child's stream, including on the `--restart` path; the prompt file is read and a missing file fails clearly; the interactive path is unchanged.

10. **Exit codes separate a launcher failure from a role outcome.** The consumer's source of truth is state, not exit status — after a role runs they re-read `docs/sprints/state/` and decide from there. So this contract is deliberately narrow, and narrow is what keeps it stable.
    - **A role that ran and recorded any verdict exits 0 — including `FAIL` and `CONDITIONAL`.** QA1 auditing and recording a FAIL is a *successful run*: the system worked exactly as designed. **This is the natural mistake and the most damaging one** — a negative verdict exiting non-zero would make a functioning gate read as a broken harness, and healthy sprints would be escalated as machine failures.
    - **Launcher-level failures use a reserved range, distinct from anything the child can return.** `claude` not on PATH, authentication missing, an unreadable prompt file, an unknown role id, a missing `--sprint`: these send someone to fix a machine, not to look at a sprint, and must be distinguishable from the model session crashing.
    - **Do not pass the child's exit code through unmodified without documenting that you have.** If `claude` exiting 1 and the launcher deciding 1 are indistinguishable, a crashed session cannot be told from a refusal.
    - **The reason goes on stderr, and names the specific cause** — which file was unreadable, which binary was missing. Req 2 reserves stdout. An escalation that says "exit 3" is not actionable; one that names the file is.

11. **Fix the publish-order trigger in `.claude/agents/pipeman.md`.** Sprint 9's reordering (publish before the bookkeeping commit) keys off *"a version bump in the sprint's original requirements"*, which misses a bump that happens mid-loop. LiveQA found the real instance: `8f597b8` sat at an already-published 0.1.8 and npm would have rejected it — Pipeman caught it by hand and named the correct generalization, **"`package.json` changed since the last ship."** One paragraph, no code, and included here for the same reason as Req 7: a real incident behind it, an agent file this sprint already touches, independently reviewable. *It is in this sprint because Master Controller agreed to carry it a day ago and then lost it — it existed only in a chat log until now, which is the failure this addition also happens to illustrate.*

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- Req 1: confirm headless spawns a separate process and that nothing in the change permits one role to invoke another. Read it as someone looking for that loophole.
- **Req 2 is the one a diff hides.** Trace every path that can write to stdout on the headless path, including error and `--restart` paths, and confirm each is stderr or suppressed. A single stray line breaks every consumer parsing the stream, and it will look fine in review.
- Req 3: confirm the prompt never transits argv on the headless path, and that a missing or unreadable file fails with a message that says which file.
- **Req 4 was amended mid-build and reverses direction — audit the current file, not what you passed twice before.** Confirm headless works on a normal logged-in session with **no `ANTHROPIC_API_KEY` set**, that a key is optional, and that side-effect findings were **tested** rather than read from help text.
- **Req 5, as rescoped.** Read the provenance comment cold and confirm it cannot mislead in either direction — it must not imply the discovery ran. Confirm this sprint file records the rescope and its reason. **Confirm sprint 12 exists and names the discovery as its deliverable** — that makes the deferral verifiable rather than a promise. **It is not visible from this worktree**, which branched before sprint 12 was created; read it at `/Users/chrishobbs/Programming/fully-completely/docs/sprints/1-todo/sprint-12_settle-the-headless-permission-scope-then-discover-the-six-opening-prompts-by-running-them.md`. *(That this criterion needed a hardcoded absolute path is itself the cross-tree divergence problem, logged on the backlog with three instances now — this is the third.)* Then read every template for restated state (a verdict, a note, a requirement, any phase history) and flag each: pointing is the requirement, summarizing is the defect.
- Req 6: confirm the interactive regression is a runnable check, not a statement.
- Req 7: read both files' new wording cold. Confirm it names the characters that trigger it.
- Req 8: `package.json` is `0.1.11`, one-line diff.
- Req 9: **run `node scripts/launcher_test.js`.**
- **Req 10: exercise it, don't read it.** Run a role headless that records a `FAIL` verdict and confirm **exit 0**. Then trigger each launcher-level failure — no `claude` on PATH, unreadable prompt file, unknown role, missing `--sprint` — and confirm each lands in the reserved range with a stderr line naming the cause. **A FAIL verdict exiting non-zero is a FAIL of this sprint, not a CONDITIONAL.**
- Req 11: confirm the trigger now keys on `package.json` differing from the last shipped commit, not on what the sprint's requirements said at the start. Read it against the `8f597b8` case — if that scenario would still slip through, it fails.
- Run `scripts/verify-tarball.sh`.

**LiveQA verifies live, after Pipeman publishes:**

- **Confirm 0.1.11 is on the registry** and its `gitHead` matches `last_shipped_commit`, from `npm view`.
- **The real thing, end to end.** From a published 0.1.11 install in a scratch repo, launch each of the six roles headless and drive one throwaway sprint through both gates. This is Req 5's verification and there is no substitute for it.
- **stdout is parseable.** Pipe a headless run into a JSON parser and confirm it succeeds. Repeat on the `--restart` path, which is where the known stray write lives.
- **Auth, per amended Req 4.** Run headless with **no `ANTHROPIC_API_KEY` set** and confirm it works on the operator's existing Claude session. A key must be optional, never a precondition.
- **Exit codes end to end.** A recorded FAIL exits 0; a launcher-level failure exits in the reserved range with the cause on stderr.
- **The interactive path still works** — launch the roles the normal way, via the VS Code task, and confirm seven terminals with each agent announcing its role. Verified working on both macOS and Windows as of 0.1.9; it must stay that way.

### Out of Scope

- **Provenance for standing authorization, and a framework-side escalation limit.** Both proposed here, both withdrawn on evidence. See Context. Do not reinstate without an instance.
- **Composing state contents into the opening prompt.** Verdicts, notes, requirements and phase history stay on disk and get read by the role, never paraphrased into a message. See Req 5.
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
