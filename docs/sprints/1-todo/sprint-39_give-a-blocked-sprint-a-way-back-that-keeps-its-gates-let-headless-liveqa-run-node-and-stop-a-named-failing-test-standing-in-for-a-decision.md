---
id: 39
title: "Give a blocked sprint a way back that keeps its gates, let headless LiveQA run node, and stop a named failing test standing in for a decision"
epic: "Downstream findings: FMC ShowOffTest run"
status: todo
created: 2026-09-15T14:44:31+00:00
---

# Master Controller Sprint Definition — Sprint 39

**Epic:** Downstream findings: FMC ShowOffTest run — framework defects surfaced
by FMC driving real installs headless, routed upstream in
`~/Programming/Fifty_Mission_Cap/docs/proposals/fully-completely-findings-2026-09-13.md`
(outside this repo). Sprint 36 closed findings 1–5.
**Sprint Objective:** Stop the framework's own `status:` writes counting as an
edit to an audited sprint file, use that to let a blocked sprint whose file is
unchanged return to where it was with its gates intact, give headless LiveQA a
measured `node` grant, and tell the gate roles that repeatedly naming a known
failing test is not a decision to accept it.

### Context

**Finding 8** (FMC sprint 80, 15 September): headless Dev Team correctly used
`/sprint-block` on a sprint in `liveqa_live` over an unmade decision. The only
documented way back is `/sprint-start`. Sprint 36 made that restart preserve
history, but its Req 1a deliberately resets every gate result — so a sprint
blocked after its QA1 PASS over a decision that changed nothing still pays a full
re-audit, re-ship and re-live-test. Master Controller verified a second,
underlying defect: `file_hash()` hashes the entire sprint file, and
`update_frontmatter_status()` rewrites its `status:` line on start, block,
complete and abort. Any check keyed on `qa1_audit_file_hash` therefore sees the
framework's own bookkeeping as a human edit (FMC worked around this in its sprint
81), and "the file is unchanged since the audit" cannot currently be expressed at
all. Fixing the hash is the prerequisite for any gate-preserving re-file.

**Finding 7:** the headless `liveqa` profile allows `npm install *` and `npx *`
but not `node *`. On a target whose live surface is a Node script, headless
LiveQA cannot run the check and can only return CONDITIONAL, which triggered a
costly extra fix cycle downstream. This is a real security tradeoff, not an
omission: `liveqa` has Edit/Write disallowed, and sprint 19 found that
program-mediated writes (`node -e "fs.writeFileSync(...)"`) are not covered by
that restriction. **Finding 6** (FMC sprint 79): two failing tests were named
correctly, by QA1 and Dev Team, in verdict after verdict, as "pre-existing" —
and being named repeatedly was mistaken for having been decided. Neither
`qa1.md` nor the Dev Team agent files say otherwise.

### Requirements

1. **The sprint-file hash excludes lifecycle-owned frontmatter lines.** The hash
   recorded as `qa1_audit_file_hash` and every comparison against it (dev-done,
   and any other reader) ignores the frontmatter lines `sprint_lifecycle.py`
   itself writes as bookkeeping: at minimum `status:`. It does **not** exclude
   `title:` or `original_title:` — CLAUDE.md states a rename must force a fresh
   audit, and that stays true. Name every excluded line in one constant with a
   comment saying why each is lifecycle-owned. Every other byte, including the
   rest of the frontmatter and the body, stays in the hash.

   **1a. Backward compatible with hashes already on record.** State files written
   before this release hold a whole-file hash. An in-flight sprint in any
   downstream install that upgrades mid-sprint must not have its dev-done check
   start failing, or start silently passing an edited file. Record which hashing
   scheme a stored hash used (a post-hoc field, `.get()` with a default per
   CLAUDE.md's state-field convention) or otherwise make an old hash compare
   correctly; state the chosen approach in a comment.

   **1b.** `override --gate dev-done-hash` re-stamps using the same scheme.

2. **A blocked sprint whose file is unchanged returns to its pre-block phase with
   its gates intact.**

   **2a.** `/sprint-block` records the phase the sprint was in when blocked
   (in the history event, a post-hoc field, or both — `.get()` on read).

   **2b.** On `/sprint-start` from `blocked`: if the sprint has a QA1 PASS on
   record, the pre-block phase is known, and the sprint file hashes equal to
   `qa1_audit_file_hash` under Req 1's scheme, the sprint returns to its
   pre-block phase with every gate-result field (`qa1_audit_result`, both audit
   hashes, `last_shipped_commit`, `groundtruth_result`, `live_loop_audit_trees`)
   and both round counts untouched. History is appended, never replaced, and the
   appended event says gates were kept and why.

   **2c.** In every other case — the file differs, no PASS on record, pre-block
   phase unknown (a sprint blocked by a version before 2a) — behaviour is exactly
   sprint 36's Req 1a: history kept, gates reset, phase `dev_build`. The printed
   output says which path was taken and, when gates were reset, the reason.

   **2d. Keeping gates must not let unaudited code through.** Restoring the phase
   restores nothing that bypasses the existing tree-content checks:
   `/sprint-ship` and `/sprint-reship` still compare tree hashes, and
   `/sprint-liveqa` still checks the deployed commit. Confirm by test that code
   committed while the sprint was blocked is still refused at ship/reship.

   **2e.** Update CLAUDE.md's `/sprint-block` and sprint-36 paragraphs, and
   `.claude/commands/sprint-start.md` / `sprint-block.md`, to describe both
   paths. Replace CLAUDE.md's "see the current sprint's own Out of Scope"
   (a pointer that goes stale once a sprint closes) with "sprint 36's Out of
   Scope".

3. **Headless LiveQA can run `node`, with the tradeoff measured and stated.**

   **3a. FLAGGED ASSUMPTION — measure before building on it.** Before adding any
   grant, measure in real headless `liveqa` runs, on the current Claude Code CLI
   version, recording version and conditions (sprint 30's format) and grading each
   finding by how it was measured (sprint 26): (i) that `node <script>` is denied
   today; (ii) whether the *existing* `npx *` grant already permits
   program-mediated file writes (e.g. running a local or registry script that
   writes a file); (iii) what the candidate grant permits, including `node -e`
   writing a file inside and outside the working directory.

   **3b.** Choose the narrowest grant that lets LiveQA run a target's Node live
   check. If (ii) shows `npx *` already permits equivalent writes, say so and
   state that `node *` does not widen what LiveQA can do; if a narrower pattern
   (for example excluding `-e`/`--eval`/`-p`) is measured to hold, prefer it. If
   the grant does widen LiveQA's reach and nothing narrower holds, **stop and flag
   it to Master Controller** with the measurements rather than shipping it.

   **3c.** Record the measurements next to the existing permission findings and
   update `liveqa.md` to state what the grant permits and that LiveQA's rule
   against writing source is still an instruction, not only a tool restriction.

4. **Gate roles are told that naming a known failing test is not accepting it.**
   Add to `.claude/agents/qa1.md` (verdict recording) and to
   `.claude/agents/dev-team-1.md` and `dev-team-2.md` (self-review / handoff),
   worded generally, not tied to any project's tests: a failing test may be
   reported as known only by citing a specific recorded decision to accept that
   named failure (a commit, a sprint, or Master Controller's own recorded call);
   without one, the first report names it and routes it to Master Controller as
   unowned, and every later report says it is still unowned. Include one sentence
   on why (FMC: two failures correctly named in every verdict for five sprints
   before anyone traced one; being named repeatedly was mistaken for being
   decided).

5. **Version bump to one above the currently published version**, with a
   CHANGELOG entry covering Reqs 1–4. Authorized by the user for this sprint.
   Confirm the published version with `npm view fully-completely version` at
   build time — sprints 36 and 38 both publish before this one.

6. **Tests.** `node scripts/launcher_test.js` and the Python lifecycle tests both
   pass, with new tests for: a `status:` rewrite not changing the hash; a body or
   `title:` change still changing it; an old-scheme hash on record (1a); block
   after PASS then start with an unchanged file restoring phase and all gate
   fields; the same with a changed file, with no PASS, and with an unknown
   pre-block phase all resetting (2c) and printing the reason; ship/reship still
   refusing code committed while blocked (2d); the liveqa profile containing
   exactly the chosen grant.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1** — every reader and writer of `qa1_audit_file_hash` uses the new
  scheme; the excluded-lines constant exists, names only lifecycle-written lines,
  and does not include `title:`/`original_title:`. **1a** — read the migration
  path for an old whole-file hash: it can neither fail a genuinely unchanged file
  nor pass an edited one; a test covers it. **1b** — the override uses the same
  function.
- **Req 2** — **2a** pre-block phase recorded, read with `.get()`. **2b/2c** —
  the keep-gates branch requires all three conditions; every other branch is
  sprint 36's reset. Assert on the printed output for both paths. **2d** — the
  test exists and QA1 reads that no ship/reship/liveqa check was loosened.
  **2e** — docs describe both paths; the stale "current sprint's own Out of
  Scope" pointer is gone.
- **Req 3** — the measurement record exists for (i), (ii) and (iii) with CLI
  version, conditions and grade. A grant justified by reasoning about what
  `npx *` "surely" already allows, without measuring it, is a FAIL. If the grant
  widens reach, confirm Master Controller's recorded acceptance exists in the
  sprint file; if not, FAIL.
- **Req 4** — wording present in all three agent files, general, with the
  citation rule and the "still unowned" rule.
- **Req 5** — version is published+1 at build time; CHANGELOG present.
- **Req 6** — QA1 runs both suites itself.

**LiveQA verifies live, after Pipeman publishes (with the user's own go-ahead):**

- Provenance: version and `gitHead` from `npm view`, matching
  `last_shipped_commit`.
- **Upgrade mid-sprint (1a):** in a scratch project on the previous published
  version, take a throwaway sprint to a QA1 PASS, upgrade to this release, then
  `/sprint-dev-done` — it proceeds on an unchanged file and refuses after a body
  edit.
- **Fresh install, gate-preserving re-file:** take a throwaway sprint to
  `liveqa_live` with a real commit; `/sprint-block`; `/sprint-start` — phase is
  `liveqa_live` again, `/sprint-status --verbose` shows the PASS, shipped commit
  and live verdicts unchanged, and the printed output says gates were kept.
  Repeat with a body edit made while blocked — gates reset, reason printed.
  Commit code while blocked, re-file with an unchanged file, attempt reship —
  refused.
- **Headless LiveQA node grant:** launch headless LiveQA in the scratch project
  and have it run a Node live-check script — it runs. Then confirm each denial or
  allowance Req 3's measurements claimed, on the CLI version current at gate
  time, and record that version.
- **Req 4:** read the installed `qa1.md` and Dev Team agent files and confirm the
  wording arrived.
- Per `liveqa.md` step 7: run every runnable check before recording.

### Out of Scope

- **Keeping gates when the sprint file changed while blocked.** A decision that
  unblocks a sprint is normally recorded in the sprint file by Master Controller,
  so Req 2b will often not apply. Deciding which edits invalidate which gates is a
  separate, riskier design; Req 2c keeps sprint 36's full reset for every changed
  file.
- **Which in-flight phases may be blocked.** Still the open question sprint 36
  left; unchanged.
- **Excluding `title:` from the hash.** Rename forcing a fresh audit is
  documented, deliberate behaviour.
- **Workshop findings F1, F4, F5, F7** (guide verification pass). Separate;
  F6/F2 are sprint 38.
- **Any change to FMC.** FMC retires its sprint 81 workaround on its own
  schedule.

### Dependencies

- **Blocks:** retirement of FMC's sprint 81 workaround.
- **Blocked by:** sprint 36 closing (Req 2 builds on its start/block guards,
  mid-live-test now) and sprint 38 closing (both touch `sprint_lifecycle.py`;
  releases are sequential). The user chose to run this immediately after 38.
- **External:** npm publish needs the user's own go-ahead in Pipeman's session.
  Req 3 depends on measured Claude Code CLI permission behaviour; the CLI version
  is part of the record.

### Team Assignments

- **Dev Team 1:** all of it, after sprint 38 closes. Reqs 1 and 2 are one
  coupled change in `sprint_lifecycle.py`; Reqs 3 and 4 share the release.
- **Dev Team 2:** not assigned. Req 3 (`run-role.js`) and Req 4 (agent files)
  are separable in code, but they share CLAUDE.md-adjacent docs and the one
  release, and sprint 38 already occupies the queue ahead; a worktree would
  collide at merge and re-audit for no time saved.

### Risks & Mitigations

- **Req 1 lets a real edit through by excluding too much.** — Only named,
  lifecycle-written lines are excluded; `title:` stays in; QA1 checks the
  constant line by line; tests prove a body and a title edit still change the
  hash.
- **Req 1 breaks in-flight sprints on upgrade.** — Req 1a, tested live by
  LiveQA's upgrade-mid-sprint check.
- **Req 2 restores a phase and something ships unaudited.** — Req 2d: ship,
  reship and liveqa checks are unchanged and tested against code committed while
  blocked.
- **Req 3 quietly widens a role's reach.** — Req 3a measures first; 3b requires
  escalation rather than shipping a widening; QA1 FAILs an unmeasured
  justification.
- **Req 4 becomes a project-specific rule.** — Worded generally; FMC is named
  only as the reason.
- **Three releases land in the week of the workshop.** — The user chose this
  ordering. LiveQA's install checks here run on a fresh install, but they do not
  re-run the workshop guides; if this release lands before the homework goes out,
  Master Controller asks the user whether a short guide Steps 5–6 re-run is
  needed.
