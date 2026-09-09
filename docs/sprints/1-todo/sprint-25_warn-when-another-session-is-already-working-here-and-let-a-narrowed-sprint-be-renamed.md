---
id: 25
title: "Warn when another session is already working here, and let a narrowed sprint be renamed"
epic: "Honest reporting"
status: todo
created: 2026-09-08T23:02:45+00:00
---

# Master Controller Sprint Definition — Sprint 25

**Epic:** Honest reporting — a sprint's state records its lifecycle position, not who is holding it.
**Sprint Objective:** Warn when another session is already working in this tree, and let a sprint whose scope legitimately narrowed be renamed without hand-editing the registry.

### Context

**Two Dev Team 1 sessions built the same sprint concurrently in the same checkout**, each producing a complete implementation of the same module, neither aware of the other until one noticed unfamiliar files in `git status`. Reported by a downstream orchestrator that drives this lifecycle unattended; the proximate cause was theirs — a loop pointed at a sprint an interactive session already had open — but the framework offered nothing that could have surfaced it.

**Nothing failed, and that is the finding.** The sprint was already in `dev_build`, so `/sprint-start` was never called and never had cause to refuse. **A sprint's state records its lifecycle position; phase is not a lease.**

**The consumer asked whether this record belongs upstream, and the answer given was: yes, but not as a lease.** A lease goes stale when a session crashes, and sessions can start outside `run-role.js`, so any record is incomplete by construction — and an incomplete record presented as authoritative is the confidently-wrong failure both projects have spent sprints removing. **What works is the shape sprint 13 landed on for worktrees: a best-effort warning that names its own blind spot and never gates.**

They have since written into their own sprint that they **do not build it, do not approximate it, and do not wait for it**, having taken a real lease only over what they can see completely — their own loop instances. **So if this is not built here, nobody builds it**, and they have stopped compensating.

**The collision happened during a build, with no lifecycle command running.** That is the constraint that shapes the design: a claim recorded at `/sprint-start` would not have caught it. `run-role.js:275` already generates a `--session-id <uuid>` per launch, so **launch time is where a role-level claim is available and early enough to matter.**

**Separately, and unrelated except in kind:** the registry keeps the title a sprint was given at creation, and there is no rename command — the subcommand list is `new start status qa1 dev-done ship reship verify-publish liveqa groundtruth complete abort override list gates`. When a sprint is legitimately narrowed, its frontmatter can be edited and the registry cannot, because hand-editing `registry.json` is forbidden. **The rule that keeps the registry safe is also what keeps it wrong.** This project has its own instance: sprint 18's title stopped describing it after its first requirement was absorbed, and Master Controller recorded the title as historical rather than fixing it.

### Requirements

1. **Record a role-level claim at launch, in `run-role.js`.** When a role starts, record that this role is running in this tree, with a timestamp and the session id it already generates. **A second launch of the same role in the same tree warns**, naming when the earlier one started.
   - **It warns; it never gates.** Two sessions of one role are sometimes legitimate — a second Dev Team 1 on a genuinely different sprint, or a session someone deliberately restarted. Blocking would make a normal thing unworkable.
   - **The warning must name its own blind spot in the message itself**, not only in a comment: this record sees only sessions started through the launcher, and a session started another way is invisible to it. A reader must not be able to conclude from silence that nobody else is working.

2. **Determine whether a sprint-level claim is reachable at all, by running rather than reasoning.** `sprint_lifecycle.py` has no concept of a holder and no session identity today. Whether one is available to it — an environment variable the launcher could set, something Claude Code exposes — **is unknown and must be established rather than assumed.**
   - **If it is reachable**, record a claim on the commands that write, and surface it on the commands that read. `/sprint-status` must stay read-only.
   - **If it is not reachable, say so and name what would be needed.** That is an acceptable outcome, exactly as it was for sprint 23's MCP question. Do not invent a mechanism to avoid reporting a gap.

3. **State plainly what this catches and what it does not.** Req 1 catches a second launch; it does **not** catch the collision at the moment the second session begins editing files, because no lifecycle command runs during a build. **It surfaces the conflict at the next launch or the next command, not at the first keystroke.** Write that in the code, not only here — a warning that implies more coverage than it has is the defect this project has corrected in four separate comments.

4. **A sprint can be renamed through the script.** A subcommand that updates the registry entry, the frontmatter and the filename together, since those three are what hand-editing would otherwise have to keep in sync.
   - **Preserve the original title.** A sprint that narrowed legitimately should show what it was and what it became; a rename that erases the first is a half-record.
   - **Renaming does not change a sprint's phase, verdicts, hashes or history.** Confirm the sprint-file hash gate behaves correctly across a rename — if renaming invalidates a recorded QA1 PASS, say so and decide whether that is right rather than discovering it at a gate.

5. **Bump `package.json` to 0.1.26.** One line.

6. **Test coverage** in whichever suite fits each half: a second launch of the same role warns and does not block; a first launch does not warn; a rename updates all three of registry, frontmatter and filename; a rename preserves the original title; a rename leaves phase and verdicts untouched.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1: confirm it never gates.** A launch that warns must still launch. **A blocking implementation is a FAIL, not a CONDITIONAL** — two sessions of one role are legitimate and this must not make them impossible.
- **Req 1: read the warning cold and check it names its blind spot.** If a reader could take silence as "nobody else is working here", it fails. That is the whole difference between this and the lease that was rejected.
- Req 2: confirm the reachability question was **established by running**. If the answer is "not reachable", confirm what would be needed is named rather than left as a shrug.
- **Req 3 is the honesty check.** Confirm the code states what this does not catch — specifically that a build in progress is invisible until the next launch or command. Four comments in this project have had to be corrected for claiming more than the evidence supported; this is the fifth chance to get it right first time.
- Req 4: confirm all three of registry, frontmatter and filename move together, and that the original title survives. **Confirm the hash behaviour across a rename was tested rather than assumed** — a rename that silently invalidates a QA1 PASS would surface at `/sprint-dev-done` as a refusal nobody could explain.
- Req 5: `package.json` is `0.1.26`, one-line diff.
- Req 6: **run both suites.**
- Run `scripts/verify-tarball.sh`.

**LiveQA verifies live, after Pipeman publishes:**

- **Confirm 0.1.26 is on the registry**, verifying published bytes against the audited commit per sprint 13's rule.
- **Reproduce the reported collision.** Launch the same role twice in one tree from a published install and confirm the second warns, names the first, and still launches.
- **Confirm the blind spot is real and stated.** Start a session outside the launcher and confirm the warning does not claim to have seen it — this is the case the message must not overstate.
- **Rename a sprint end to end** and confirm the registry, frontmatter and filename agree afterwards, the original title is preserved, and the phase and verdicts are unchanged.

### Out of Scope

- **A lease, a lock, or anything that refuses.** Rejected on reasoning both projects agreed with: a stale lease after a crash and an incomplete record presented as authoritative are both worse than a warning that admits what it cannot see. The consumer holds a real lease over their own loop instances, which they can observe completely; that division stands.
- **A parallel session registry maintained outside the launcher.** The consumer deliberately did not build one, on the grounds that it would duplicate something only the launcher can know accurately and would be wrong the moment a session started outside it. That reasoning applies here too.
- **The Bash-allowlist permission finding.** Unscoped and waiting on evidence; nothing in this sprint touches allowlists or profiles.
- **Sprint 23's held work and sprint 24's ship-to-verify path.** Both queued ahead of this in the version line.
- **The uncommitted `.vscode/settings.json` change.**

### Dependencies

- **Blocks:** Nothing. But no one else is building the cross-session record — the consumer has written into their own sprint that they will not.
- **Blocked by:** Sprints 23 and 24 shipping, on the shared `package.json` version line. **Not blocked by the permission finding** — neither half of this sprint touches allowlists, and neither changes meaning depending on how that resolves. It is the only work on the board that can move while that evidence is gathered.
- **External:** The collision, the reasoning that rejected the lease, and the rename instance all came from the same downstream consumer. Their sprint 15 and this one now divide the problem along the line they proposed: they gate what they can see completely, we warn about what neither of us can.

### Team Assignments

- **Dev Team 1:** All of it. Two independent halves, one file each.
- **Dev Team 2:** Not assigned — and note this sprint's own collision case is two sessions of one role, which is the thing Dev Team 2 exists to avoid needing.

### Risks & Mitigations

- **The warning becomes a lease by accident** — someone adds a refusal because a warning feels weak. *Mitigation:* Req 1's criterion is FAIL-level and the Out of Scope names the reasoning, so a future reader sees why it was rejected rather than assuming it was overlooked.
- **The message overstates its coverage** and someone reads silence as safety. *Mitigation:* Req 1 and Req 3 both require the blind spot in the message, and QA1 reads it cold.
- **The rename desynchronises the three records** it exists to keep in sync, leaving the registry pointing at a filename that no longer exists. *Mitigation:* a LiveQA criterion checking all three agree after a real rename.
- **A rename silently invalidates a recorded QA1 PASS**, surfacing later as an unexplainable refusal at `/sprint-dev-done`. *Mitigation:* Req 4 requires the hash behaviour to be tested and the outcome decided, not discovered.
