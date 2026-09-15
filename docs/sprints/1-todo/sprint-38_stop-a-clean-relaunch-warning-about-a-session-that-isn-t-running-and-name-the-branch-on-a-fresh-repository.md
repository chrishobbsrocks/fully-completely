---
id: 38
title: "Stop a clean relaunch warning about a session that isn't running, and name the branch on a fresh repository"
epic: "Workshop readiness: a new attendee's first launch reads correctly"
status: todo
created: 2026-09-15T05:48:19+00:00
---

# Master Controller Sprint Definition — Sprint 38

**Epic:** Workshop readiness — a new attendee's first install and launch, done
exactly as the workshop setup guides describe, should print nothing false and
nothing alarming.
**Sprint Objective:** Stop the role-claims NOTE firing on a relaunch when the
previously recorded session is no longer running, and make the lifecycle's
tree description name the branch correctly on a repository with no commits —
shipped in one release before the workshop.

### Context

LiveQA ran both workshop setup guides (Mac and a clean Windows 11 ARM VM)
against published 0.2.10, as a no-sprint verification pass. Full report, with
screenshot-numbered evidence: `~/Desktop/Claude Code Workshop/Guide_Verification_Report_0.2.10.md`
(outside this repo). Seven framework defects came out of it. The user chose to
fix two before the workshop, which is under a week away: **F6** and **F2**.
The rest are handled by guide edits or deferred (see Out of Scope).

**F6.** After a clean shutdown of FC: Start All (trash can on each tab;
`Get-Process claude` confirmed nothing running), every relaunch prints at the
top of each agent tab: "NOTE: another Master Controller session was recorded
starting at … or a genuine collision … Launching anyway -- this never blocks."
`recordRoleClaim()` in `scripts/launcher/role-claims.js` writes a claim at
launch and nothing ever retires it, so the NOTE fires on every relaunch in a
tree, for every role, forever. Attendees relaunch constantly in class; six
collision warnings about sessions that do not exist teach them to ignore the
one warning that matters. Sprint 25 deliberately rejected a *lease* (a stale
lease after a crash reads as "nobody is here", which is confidently wrong).
That reasoning stands and this sprint must not undo it. **F2.**
`python3 scripts/sprint_lifecycle.py list` — the exact line the guides tell
attendees to check — prints "No sprints yet in <folder> (branch unknown)."
both before and after `git init`. `current_branch()` uses
`git rev-parse --abbrev-ref HEAD`, which fails on an unborn branch, and
`tree_description()` collapses every failure (not a repository, no commits
yet, detached HEAD, git missing) into the same "branch unknown".

### Requirements

1. **The role-claims NOTE does not fire when the previously recorded session
   is demonstrably no longer running** — however it ended: clean exit, the VS
   Code terminal trash can, "Tasks: Terminate All Tasks", or the launcher being
   killed. It **must still fire** when the previously recorded session is still
   running (the collision sprint 25 exists to surface).

   **1a. Do not reintroduce the lease sprint 25 rejected.** When the record
   cannot establish whether the previous session is running (an unreadable or
   older-format record, a check that cannot be performed on this platform),
   the NOTE fires as it does today. Absence of the NOTE must never be worded,
   in code or output, as "nobody else is working here"; the existing NOTE
   wording about what the record cannot see stays accurate.

   **1b. FLAGGED ASSUMPTION — measure before building on it.** Which shutdown
   paths let the launcher run any code on the way out, and what a "still
   running" check can reliably observe, differ between macOS and Windows and
   between those shutdown paths. Sprint 15 already found a killed launcher's
   child outliving it on macOS. Do not assume a clean-exit hook runs on the
   trash-can or Terminate-All paths on either platform; establish it by
   running each path. Choose a design that meets Req 1 on every path you
   measured, and record the measurements (platform, shutdown path, what was
   observed) in a comment or findings note next to the code.

   **1c. Record format stays backward compatible.** An existing
   `.claude/role-claims.json` written by 0.2.10 or earlier must not crash the
   launcher or silence the NOTE incorrectly (Req 1a covers what it does).

2. **The tree description names what is actually true about the branch.**
   `tree_description()` (and `current_branch()` or its replacement) must
   distinguish at least: a named branch with commits (unchanged:
   `(branch: <name>)`); an unborn branch with no commits yet (name the branch
   and say it has no commits yet); not a git repository (say so); and the
   remaining undeterminable cases (detached HEAD, git not on PATH) — which may
   keep a "branch unknown"-style wording, but must not claim any of the three
   specific cases above. Sprint 7, Req 7's rule stands: none of this may make a
   read-only command fail to answer.

   **2a.** Every command that prints `tree_description()` gets the new text;
   none is special-cased. Do not change the stderr
   `[sprint_lifecycle] repo=... script=...` banner — it is CLAUDE.md's
   wrong-script safety net.

3. **Version bump to one above the currently published version**, with a
   CHANGELOG entry covering Reqs 1–2. Authorized by the user for this sprint.
   Confirm the published version with `npm view fully-completely version` at
   build time — sprint 36's live-loop fix may itself have published a new
   version by then; do not trust any number written here.

4. **Tests.** `node scripts/launcher_test.js` and the Python lifecycle tests
   both pass, with new tests for: no NOTE after a previous session has ended;
   NOTE when the previous session is still running; NOTE (not silence) on an
   undeterminable or old-format record; the tree description for each case in
   Req 2 (asserting on the printed text), including a real `git init` with no
   commits.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1** — read the claim record and warning logic: the NOTE is suppressed
  only on a positive determination that the previous session is not running.
  **1a** — every undeterminable branch falls through to the NOTE; grep the
  diff for any output or comment implying "nobody else is working here".
  **1b** — the measurements exist next to the code and name platform and
  shutdown path for each path the design relies on; a design justified by
  reasoning about exit hooks rather than measurement is a FAIL.
  **1c** — a 0.2.10-format record is handled per 1a (a test covers it).
- **Req 2** — assert on printed text for each case, including a real unborn
  branch from `git init`. **2a** — the banner is untouched; no call site of
  `tree_description()` is special-cased.
- **Req 3** — version is published+1 at build time; CHANGELOG present.
- **Req 4** — QA1 runs both suites itself.
- The cumulative diff is confined to `scripts/launcher/role-claims.js`,
  `scripts/launcher/run-role.js` (only if the claim call site must change),
  `scripts/sprint_lifecycle.py`, tests, `package.json`, `CHANGELOG.md`,
  version-derived tables the release process regenerates, and
  `docs/sprints/` bookkeeping. Anything else needs a stated reason.

**LiveQA verifies live, after Pipeman publishes (with the user's own go-ahead):**

Both platforms are required, not optional: the published package is what
workshop attendees install. Use the Windows 11 ARM VMware Fusion VM LiveQA
used for the guide verification pass (the user runs the steps; LiveQA writes
them and scores the output). If either environment genuinely cannot be
obtained at gate time, record what was attempted and what failed — do not
record a PASS for the missing platform.

- Provenance: version and `gitHead` from `npm view`, matching
  `last_shipped_commit`.
- **Guide Steps 5–6 re-run on the new version, both platforms**, in a new
  folder, exactly as the guides describe (Mac from Step 5; Windows from Step 5
  on the existing VM toolchain). This is a regression check on what attendees
  will install, not only on this sprint's two changes.
- **Req 2 live:** `python3 scripts/sprint_lifecycle.py list` before `git init`,
  after `git init`, and after a first commit — quote each output line and
  confirm each names the true state.
- **Req 1 live, each platform:** FC: Start All; shut down via the trash can on
  every tab; relaunch — no NOTE on any tab. Repeat with "Tasks: Terminate All
  Tasks". Then, with one agent still running, launch that same role again
  separately — the NOTE appears. Confirm `Get-Process claude` / `ps` state at
  each step rather than assuming it.
- Per `liveqa.md` step 7: run every runnable check before recording.

### Out of Scope

- **F1 (no role owns a new install's first commit).** Handled for the workshop
  by a guide edit (`git init -b main` plus a first commit in Step 5). The
  framework half — CLAUDE.md and agent files naming that owner consistently —
  is a post-workshop sprint.
- **F4 (Claude Code's per-folder trust prompt defaults to "No, exit").** Claude
  Code's prompt, not the framework's. Having the launcher pre-trust a folder is
  a security decision, not a pre-class change. Guide edit.
- **F5 (a relaunch shows previous replies, including now-false claims).**
  Session resume is deliberate launcher behaviour and the cause was not
  established. Needs investigation before a sprint is written. Guide edit
  ("type *check again*") for class.
- **F7 (mixed path separators in the Windows installer's file list).**
  Cosmetic; post-workshop.
- **F3 (a model slip about the registry file).** Not a code defect.
- **The 22 guide-text corrections.** The guides are the user's documents, not
  this repo's. Note: Req 2 changes the `list` line guide correction #12 quotes;
  the user updates that text once this publishes.
- **The stderr `[sprint_lifecycle]` banner.** Kept deliberately (Req 2a); the
  guide explains it instead.

### Dependencies

- **Blocks:** sending the workshop homework on a version with these fixes.
- **Blocked by:** sprint 36 closing. It is in its LiveQA fix loop
  (CONDITIONAL, stale live-loop audit text in `sprint_lifecycle.py`); its
  reship publishes a version, and this sprint's release must follow it. Both
  sprints touch `sprint_lifecycle.py`.
- **External:** the workshop, under a week away. npm publish needs the user's
  own go-ahead in Pipeman's session. Windows gate needs the user at the VM.

### Team Assignments

- **Dev Team 1:** all of it, starting as soon as sprint 36 closes. Two small,
  separate changes and one release.
- **Dev Team 2:** not assigned. A parallel worktree build would have to rebase
  onto sprint 36's final `sprint_lifecycle.py` and be re-audited anyway, and
  the release must be sequential; it saves no time.

### Risks & Mitigations

- **The fix silences a real collision.** — Req 1 requires the NOTE when the
  previous session is running; Req 1a makes every undeterminable case warn;
  LiveQA proves the positive case live on both platforms.
- **The design works on macOS and not on Windows (or on one shutdown path and
  not another).** — Req 1b requires measuring each path on each platform before
  building; LiveQA tests trash can and Terminate All on both.
- **A release days before class breaks what attendees install.** — LiveQA's
  gate re-runs guide Steps 5–6 on both platforms against this exact version;
  the scope is two contained changes.
- **The guides go out quoting old output.** — Out of Scope names guide
  correction #12; the user updates it after publish.
- **Schedule: sprint 36's loop runs long and squeezes this.** — If sprint 36
  has not closed with enough time for this sprint's two gates before the
  homework must go out, Master Controller asks the user whether to send the
  homework on the current version with guide notes for F6 and F2 instead.
