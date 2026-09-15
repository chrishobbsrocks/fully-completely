---
id: 36
title: "Stop a mis-issued command erasing a sprint's record, audit live-loop fixes, and close three smaller downstream gaps"
original_title: "Stop start erasing a live sprint's record, and put a live-loop fix through the audit it skips"
epic: "Downstream findings: FMC ShowOffTest run"
status: done
created: 2026-09-14T23:17:34+00:00
---

# Master Controller Sprint Definition — Sprint 36

**Epic:** Downstream findings: FMC ShowOffTest run — five framework defects
surfaced by FMC driving a real 0.2.9 install (ShowOffTest) headless, routed
upstream in `docs/proposals/fully-completely-findings-2026-09-13.md` (held in
the FMC repositories, not this one).
**Sprint Objective:** Make the lifecycle refuse to destroy a sprint's record
through a mis-issued `/sprint-start` or `/sprint-block`, require a QA1 audit on
any code a reship puts live, and close the three smaller gaps the same run
found (headless Master Controller cannot commit, LiveQA stops testing at the
first defect, consumers never get the role-claims ignore entry) — in one
release.

### Context

Findings #1 and #2 each now have two independent downstream incidents behind
them. **#1:** a headless Dev Team 1 ran `/sprint-start 1` on a sprint in
`liveqa_live`; `cmd_start` rebuilt the state file from scratch, nulling every
verdict, both audit hashes, `last_shipped_commit`, and the whole history
(ShowOffTest `268a066`, reverted by hand in `55557bc`). Master Controller
verified the code: `cmd_start` has no phase check at all. It is worse than
reported, in two ways. `cmd_block`'s own docstring records that it also has no
phase guard, so a *completed* sprint can be blocked and then started — a
two-command path to erasing a closed record that a guard on start alone would
leave open. And even the one legitimate use of an unguarded start, re-filing a
blocked sprint (sprint 33), discards the history event carrying the very
analysis `/sprint-block` exists to preserve.

**#2:** `cmd_reship` has no tree-hash check, by design (its own comment: "there
is normally no time to route back through gate 1"). Downstream, an unaudited
logo fix went live contradicting a recorded decision a static read would have
caught; in a later run Pipeman held the same shape of fix for an audit no rule
required; on 14 September a different Pipeman turn, same framework version,
reshipped one unaudited and called it "by design". The rule is being decided
per turn. The user has settled it: **a code change reshipped during the live
loop requires a QA1 audit first**, mechanically enforced. The three smaller
findings are bundled because the user chose one release for this work, and
this repository's live test is per-sprint against a published `gitHead` —
two sprints cannot share one publish.

### Requirements

1. **`/sprint-start` refuses on any sprint that has already started and is not
   blocked.** It proceeds only when (a) the sprint has no state file (never
   started), or (b) the state's phase is `blocked`. Every other phase —
   `dev_build`, `dev_agreed_done`, every LiveQA phase, `complete_ready`,
   `complete`, `aborted` — refuses, no override, before any file move,
   registry write, or state write. The refusal names the current phase and
   says nothing was changed.

   **1a. Re-filing a blocked sprint preserves its history.** On start from
   `blocked`: `history` is kept and a new event is appended (not replaced);
   `audit_rounds` and `live_test_rounds` are kept; `started` is kept (the
   original start time) — record the restart time in the appended event.
   Gate results (`qa1_audit_result`, `qa1_audit_file_hash`,
   `qa1_audited_tree_hash`, `last_shipped_commit`, `groundtruth_result`, and
   whatever field Req 3 adds) are reset, because a repaired sprint file must
   pass both gates again. Phase becomes `dev_build`.

   **1b. Fresh starts are unchanged.** A never-started sprint gets exactly the
   state it gets today.

2. **`/sprint-block` refuses on a sprint whose phase is `complete` or `aborted`.** No override. This is the narrow half of the guard
   `cmd_block`'s docstring deferred; which *in-flight* phases may block
   (including during the live loop) stays as it is today — see Out of Scope.
   Update that docstring so it no longer describes the closed-sprint case as
   open.

3. **`/sprint-reship` refuses unless the commit's content has a recorded QA1
   PASS.** Compare the reshipped commit's tree (via `git_tree_hash_excluding`
   with `SHIP_HASH_EXCLUDE_PATTERNS`, same as `cmd_ship`) against the tree of
   the most recent PASS on record for this sprint — either the gate-1 PASS
   (`qa1_audited_tree_hash`) or a live-loop audit PASS. Refuse on mismatch, no
   override.

   **3a. Do not break the live-loop audit's invariant.** `_qa1_live_loop_audit`
   must still never assign to `phase`, `qa1_audit_result`,
   `qa1_audit_file_hash`, or `qa1_audited_tree_hash` (its docstring explains
   why). The trees that live-loop audits PASSed therefore go in their own
   field (post-hoc schema field: `.get()` everywhere, per CLAUDE.md's
   state-field convention). The test is exactly "a PASS is on record for this
   tree": a live-loop FAIL or CONDITIONAL never satisfies it, and a FAIL on a
   *different* tree does not revoke a PASS already recorded for the tree being
   reshipped. If a FAIL is recorded on the *same* tree after its PASS, the
   latest verdict for that tree wins — refuse. State these semantics in a
   comment.

   **3b. The refusal is its own recovery path** (CLAUDE.md's transition-
   precondition rule: Pipeman hits this and cannot clear it). The message
   names both trees and tells Pipeman to hand to QA1 for
   `/sprint-qa1 <N> --verdict ...` on that commit, then reship again.

   **3c. Replace `cmd_reship`'s "No tree-hash check here" comment** with the
   current rule and why it changed (the downstream incidents, by finding
   number, not by client detail).

4. **Every document that describes the live-loop fix path says an audit is
   required**, consistently: CLAUDE.md's lifecycle diagram and prose,
   `.claude/agents/pipeman.md`, `.claude/agents/qa1.md` (a live-loop audit is
   now a gate on reship, not only a record), `.claude/agents/dev-team-1.md` /
   `dev-team-2.md` if they describe the loop, `.claude/commands/sprint-reship.md`,
   and `.claude/commands/sprint-qa1.md`. Search for every description of the
   loop; do not rely on this list being complete.

5. **LiveQA runs every runnable check before recording a FAIL or
   CONDITIONAL.** Amend `liveqa.md` step 7: a confirmed defect decides the
   verdict, but every remaining check that *can run now* is still run in that
   round, and all defects found go in the same `--notes`. What step 7 must keep
   is its real reason: do not hold a determined verdict open waiting on checks
   that are **genuinely blocked** (the original stall was Windows hardware that
   wasn't available). Name both the stall and the downstream incident (two
   FAIL rounds each deferring five-plus criteria, the third finding the
   remaining defect at once) so the next reader sees why the line is where it
   is.

6. **The headless `master-controller` profile can commit its own
   sprint-bookkeeping, and nothing else.** `HEADLESS_PERMISSION_PROFILES` in
   `scripts/launcher/run-role.js` currently allows only the two lifecycle
   invocations, so Master Controller Rule 6 (commit an amendment before any
   gate acts on it) and CLAUDE.md's bookkeeping-commit rule cannot be followed
   headless — downstream, five decision blocks in one sprint went uncommitted
   and were correctly ignored by every later role.

   **6a. FLAGGED ASSUMPTION — verify by running before building on it.** The
   grant must allow the commit shapes Master Controller actually needs
   (staging and committing new/changed paths under `docs/sprints/`, and a
   pathspec commit of an amended sprint file) and must deny `git push`,
   `git commit -a`/`-am`, `git add -A`/`.`, and any add/commit naming paths
   outside `docs/sprints/`. Whether Claude Code's permission patterns can
   express that distinction is **unmeasured**. Sprints 26, 30 and 31 exist
   because permission claims were written from reasoning; measure each allowed
   and denied form in a real headless run, record the CLI version and the
   conditions (sprint 30's format), and grade each finding by how it was
   measured (sprint 26). If the patterns cannot deny a form above, say so in
   the findings, choose the narrowest grant that is measured safe, and flag
   the gap to Master Controller rather than widening silently.

   **6a, RESOLVED — amended post-build to record what this requirement was
   actually satisfied by, not left describing only the original question.**
   Measured, twice, in round 1: raw `Bash(git add docs/sprints/*)` /
   `Bash(git commit -m *)` allow patterns genuinely CANNOT express "confined
   to `docs/sprints/`, nothing else" — QA1's own real probes showed a
   trailing wildcard covers a pathspec argument exactly as readily as it
   covers the free text before it (`git commit -m "tool tweak"
   scripts/tool.js` matched and committed a file entirely outside
   `docs/sprints/`, zero denials). Rather than stop at flagging the gap, the
   narrowest grant that measured safe turned out to be a different
   *mechanism*, not a narrower pattern: `scripts/mc-commit.js`, a dedicated
   wrapper script that validates every path in real code before it ever
   reaches `git`. Master Controller's headless profile grants Bash access to
   only that script (plus the two pre-existing lifecycle-script patterns) —
   no raw `git` pattern at all. QA1 reviewed this design change directly
   (round 2 audit) and confirmed it stays within this Req's own "choose the
   narrowest grant that is measured safe" latitude, not a widening and not
   requiring separate Master Controller escalation. Full measured record,
   across two CLI versions (2.1.271 and 2.1.272) and two operators (Dev
   Team, then QA1 independently): `docs/sprint-36-mc-commit-permission-findings.md`.
   *Master Controller review (2026-09-15): this amendment records how Req 6a
   was satisfied; it does not change what was required. Accepted, with the
   CLI-version count corrected from "three" to two. Master Controller had
   already accepted the wrapper design when QA1's round-3 PASS was relayed.*

   **6b.** Update `master-controller.md` and the headless note in
   `sprint-new.md` to describe what headless Master Controller can now commit.

7. **The installer's managed `.gitignore` block includes
   `.claude/role-claims.json`.** Currently `['docs/sprints/.locks/',
   '*.fc-bak-*']` in `scripts/install.js`. This repo's own `.gitignore` already
   has it (sprint 25); consumers never received it, and ShowOffTest committed
   the file before untracking it (`ad1fb84`). Existing unrelated lines in a
   target's `.gitignore` must be preserved exactly as the block merge already
   does, and an upgrade of an install that lacks the entry must add it.

8. **Version bump to one above the currently published version**, with a
   CHANGELOG entry covering Reqs 1–7. Confirm the published version with
   `npm view fully-completely version` at build time (0.2.9 when this file was
   written — do not trust that line). Regenerate any version-derived tables
   the release process already regenerates.

9. **Tests.** `node scripts/launcher_test.js` and the Python lifecycle tests
   both pass, with new tests for: start refused from each non-blocked started
   phase with no file/registry/state change; start from blocked preserving
   history and resetting gates; block refused on complete; reship refused on an
   unaudited tree, accepted after a live-loop PASS on that exact tree, refused
   after only a live-loop FAIL; the live-loop audit still writing none of the
   four gate-1 fields; the managed block containing the new entry.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1** — read `cmd_start`: the phase check happens before the lock-held
  file move, registry write, and state write, and allows exactly "no state
  file" or `blocked`. Assert on the refusal's printed text in a test, not only
  on the absence of file changes. **1a** — history appended not replaced;
  rounds and `started` kept; the gate fields listed reset. **1b** — the
  never-started path produces the same dict as before (diff it).
- **Req 2** — `cmd_block` refuses `complete` and `aborted` before any mutation;
  docstring updated.
- **Req 3** — `cmd_reship` compares tree hashes with the same exclusion patterns
  `cmd_ship` uses. **3a** — grep `_qa1_live_loop_audit` for assignments: none
  to the four gate-1 fields; the new field is read with `.get()` everywhere.
  Confirm FAIL/CONDITIONAL cannot satisfy the check. **3b** — the refusal text
  names both trees and the QA1 recovery step (asserted on output). **3c** — the
  old comment is gone.
- **Req 4** — grep the repo for every description of reship / the live-test
  fix loop; each says an audit is required. List the files checked in the
  audit notes. Any surviving "reship without audit" description is a FAIL.
- **Req 5** — `liveqa.md` step 7 distinguishes runnable from blocked checks and
  keeps the no-stall reasoning.
- **Req 6** — the profile diff is narrowly scoped; **6a** — a findings record
  exists with CLI version, conditions and measurement grade for **every**
  allowed and denied form listed, from a real run. A grant claimed safe without
  a measured denial of `git push` and `git commit -a` is a FAIL. **6b** — docs
  match the measured grant.
- **Req 7** — the managed block includes the entry; merge logic otherwise
  unchanged.
- **Req 8** — version is published+1; CHANGELOG present.
- **Req 9** — QA1 runs both test suites itself.

**LiveQA verifies live, after Pipeman publishes (with the user's own go-ahead):**

- Confirm the version is on the registry and `gitHead` matches
  `last_shipped_commit`, from `npm view`, not from a handoff.
- **Fresh install into a clean scratch git repository**, then drive the
  lifecycle for real with a throwaway sprint:
  - Take it to a LiveQA phase (a scratch "published" artifact can be any real
    commit; the gates only need real commits). Run `/sprint-start <N>`:
    confirm refusal, and that `git status` and the state file are byte-for-byte
    unchanged.
  - Make a code commit and attempt `/sprint-reship`: confirm refusal naming the
    QA1 recovery. Record a live-loop FAIL on it: still refused. Record a
    live-loop PASS on it: reship succeeds.
  - Block a separate sprint, start it again: confirm the block analysis is still
    in `/sprint-status <N> --verbose`.
  - Close a sprint, then `/sprint-block` it: confirm refusal.
- **Upgrade for real** from 0.2.9 in a separate scratch project with an
  unrelated `.gitignore` line planted first: confirm `.claude/role-claims.json`
  is added and the planted line survives.
- **Headless Master Controller commit**: launch headless Master Controller in
  the scratch project, have it amend a sprint file and commit it — confirm the
  commit exists in `git log`. Then confirm at least `git push` and
  `git commit -a` are denied in that same session. Record the CLI version.
- **LiveQA's own Req 5 applies to this round**: run every check above before
  recording, even after the first defect.

### Out of Scope

- **Which in-flight phases may be blocked**, including blocking during the live
  loop. A real design question `cmd_block`'s docstring deferred; Req 2 takes
  only the closed-sprint case, because it is the one that combines with Req 1
  into a record-erasing path.
- **A phase guard on `/sprint-abort`.** Abort already requires `--user-said`
  (sprint 33); a human authorization is the gate there.
- **Untracking an already-committed `role-claims.json` in consumer repos.** The
  installer does not touch git and should not start; the ignore entry prevents
  new cases.
- **FMC's own workarounds (FMC sprints 72–78).** Theirs to retire once this
  publishes.
- **The leftover `fully-completely-devteam2-sprint-32` worktree and the
  uncommitted install files on main** (`.gitignore`, `.vscode/settings.json`,
  `.claude/fully-completely-*`, `settings.local.json`). Not this sprint's; do
  not commit them into its audited tree.
- **Sprint 37.** Registered while this work was briefly planned as two sprints.
  It is empty and superseded by this one; Dev Team aborts it (with the user's
  authorization), it is not built.

### Dependencies

- **Blocks:** retirement of FMC's workarounds for these findings.
- **Blocked by:** nothing. All prior sprints are closed on main.
- **External:** the npm publish requires the user's explicit go-ahead in
  Pipeman's own session (CLAUDE.md). Req 6a depends on measured Claude Code
  CLI permission behaviour; the CLI version at build time is part of the
  record.

### Team Assignments

- **Dev Team 1:** all of it. Reqs 1–5 share `sprint_lifecycle.py` and the agent
  docs; Reqs 6–8 share the release. One checkout.
- **Dev Team 2:** not assigned. Req 6 and Req 7 are separable in code, but both
  land in CLAUDE.md/agent docs and the same version bump, and a second worktree
  would collide there.

### Risks & Mitigations

- **Req 1 blocks a legitimate restart nobody thought of.** — The only
  documented re-entry is from `blocked`; any other need has a recovery path
  already (block, then start). The refusal message says so.
- **Req 3 makes the live loop slower.** — Accepted by the user: one QA1 turn
  per code fix is the cost of never shipping an unaudited change. A reship of
  an already-audited tree is not slowed.
- **Req 3's new field lets a live-loop audit influence gate 1.** — Req 3a keeps
  it in a separate field and QA1 greps for the four forbidden assignments.
- **Req 6's permission patterns can't express the needed denials, and the grant
  quietly goes broad.** — Req 6a makes it a flagged assumption, requires
  measured denials, and requires escalation instead of widening. **Materialized
  and resolved**: the patterns genuinely couldn't express it (measured, not
  assumed); resolved not by widening but by moving enforcement into
  `scripts/mc-commit.js`'s own real code, reviewed and confirmed in-scope by
  QA1 — see Req 6a's own resolved note above.
- **Docs drift: one file keeps describing unaudited reship.** — Req 4 requires
  a repo-wide search and QA1 lists what was checked.
- **This release is published without the user choosing it.** — Req 8 was
  written with the user's authorization for one release; the publish itself
  still waits for the user's own word in Pipeman's session.
