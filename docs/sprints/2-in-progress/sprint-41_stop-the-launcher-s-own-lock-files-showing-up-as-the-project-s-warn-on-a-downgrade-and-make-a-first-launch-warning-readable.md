---
id: 41
title: "Stop the launcher's own lock files showing up as the project's, warn on a downgrade, and make a first-launch warning readable"
epic: "Workshop readiness: a new attendee's first launch reads correctly"
status: in_progress
created: 2026-09-21T00:00:00+00:00
---

# Master Controller Sprint Definition — Sprint 41

**Epic:** Workshop readiness — a new attendee's first install and launch, done
exactly as the setup guides describe, should print nothing false, nothing
alarming, and nothing the reader cannot actually read.
**Sprint Objective:** Keep the launcher's own transient files out of a
downstream project's git status, make the installer say when it is going
backwards, make the collision warning survive long enough to be read, and lock
the `--user-said` rule down with tests on both sides — in one release.

### Context

Four items, all found by running the framework rather than reading it.

**Finding 11** (FMC, 19 September; verified here): sprint 38's lock design has
`role-claims.js` writing `<claims>.lock` and, on a steal,
`<claims>.lock.stolen-<pid>-<ts>` next to `.claude/role-claims.json`. The
installer's managed ignore block is
`['docs/sprints/.locks/', '*<backup marker>*', '.claude/role-claims.json']` —
the lock siblings are not in it, and this repository's own `.gitignore` has the
same gap. A downstream Master Controller running a scope check sees untracked
files it never created, which is exactly the "the record should never accuse the
project of something it didn't do" property sprint 25 wrote the warning for in
the first place.

**LiveQA, sprint 38 round 2** (both platforms): the collision warning this
project has now spent two sprints making *correct* is visible for well under a
second before Claude Code's full-screen UI replaces it. On the version the
workshop guide was verified against it was readable; it is not now. A warning
nobody can read is worth what it costs to print. Same round: the installer
downgrades without saying so — install 0.2.11 over 0.2.13 and it goes backwards
silently, which on a workshop machine means an attendee can end up behind the
version the guides were written against, with no signal.

**The `--user-said` guard** comes from FMC's own sprint 91, offered upstream on
21 September, plus their follow-up: assert both directions. This framework's own
rule (`/sprint-complete` refuses an empty `--user-said`, no override) is
currently protected only by that one refusal. Nothing stops a future launcher
prompt, helper, or headless opening prompt from assembling the text, and that is
precisely how a rule like this rots — sprint 9's publish ordering was fixed in
prose and drifted on the very next release.

**Human Prerequisites** comes from FMC's run in progress: a sprint-2 live test
failed twice because a committed migration had never been applied to the hosted
database. Both tools behaved correctly; the reship rule held. The lesson is about
sprint files: QA1's audit had effectively predicted an operator-side blocker, and
a prediction recorded as a warning inside an audit is read after the failure, not
before. The sprint file is where it belongs, before anyone builds.

### Requirements

1. **The launcher's own lock files are ignored, in this repo and in every
   install.** Add the lock and steal-sibling patterns to the managed ignore block
   in `scripts/install.js` and to this repository's own `.gitignore`. Derive the
   patterns from `role-claims.js`'s own constants (`LOCK_SUFFIX` and the stolen
   path shape) rather than retyping literals that can drift out of sync; if that
   is impractical across a JS constant and a text block, state why in a comment
   and add a test that fails if the shapes diverge. An upgrade of an existing
   install must add the entries, and unrelated lines in a target's `.gitignore`
   must survive exactly as the block merge already guarantees.

2. **The installer says when it is about to install an older version than the one
   already present.** Compare the installed `.claude/fully-completely-version`
   against the version being installed. Going backwards is not forbidden — a
   deliberate rollback is legitimate — but it must be stated in the installer's
   own output, naming both versions, in the same place the normal version
   transition is reported. Equal versions and upgrades keep their current
   wording.

3. **The collision warning is readable by the person it is for.**

   **3a. FLAGGED ASSUMPTION — measure before building on it.** The warning is
   currently printed to stderr by `run-role.js` before `claude` starts, and
   Claude Code's full-screen UI covers it within about a second on both macOS and
   Windows (LiveQA, sprint 38 round 2, real VS Code on both). The launcher does
   not control when Claude takes the screen. Establish by running, on the current
   CLI version and recording it: what actually survives on screen, and which of
   the plausible routes works — for example holding the launch until the reader
   acknowledges, passing the warning into the role's opening prompt so the agent
   itself reports it in its first reply, writing it where the role will read it,
   or something else measured to work. Do not build on a route that was reasoned
   about rather than run.

   **3b.** The outcome, not the mechanism, is the requirement: after a launch
   where a collision warning fires, a person looking at that agent's terminal can
   still see that it fired, without scrollback archaeology. It must not block or
   delay a launch where no warning fires — sprint 25's "it warns; it never gates"
   stands, and a workshop attendee launching six agents must not face six extra
   prompts.

   **3c.** If every measured route is worse than the current behaviour, say so
   with the measurements, change nothing, and record the finding for Master
   Controller rather than shipping a change that trades one bad outcome for
   another.

4. **Both halves of the `--user-said` rule are enforced by tests.**

   **4a.** A test asserting no code path in this repository constructs, defaults,
   templates, or otherwise supplies `--user-said` or `--user-said-file` content —
   the only source stays a human's typed words. Cover `scripts/` including the
   launcher and any headless opening prompts, and the command and agent files, so
   a future prompt that helpfully pre-fills it fails the suite.

   **4b.** The reverse assertion, FMC's own addition: every recorded close in a
   sprint's history carries a non-empty `--user-said`. The guard then catches
   both invention and omission.

   **4c.** Neither test changes `cmd_complete`'s behaviour. The rule is
   unchanged; this only makes it hard to erode.

5. **The sprint template gains a `### Human Prerequisites` section, and QA1 is
   told to route a predicted operator-side blocker into it.**

   **5a.** Add the section to `templates/sprint-template.md`, between Dependencies
   and Team Assignments, with a prompt line saying what belongs there: anything a
   person must do outside the repository before this sprint's gates can pass — a
   migration applied to a hosted database, a DNS record, an account, a device at
   hand — and what does not (anything a role can do itself). Say explicitly that
   an empty section is a normal outcome and should read "None".

   **5b.** Update `.claude/agents/qa1.md`: when an audit identifies something the
   operator must do outside the repo before the live test can pass, say so as a
   routed item for Master Controller to put in Human Prerequisites, not as a
   warning inside the verdict notes — a warning recorded in an audit is read
   after the failure, and FMC lost two live-test rounds to exactly that.
   Update `.claude/agents/liveqa.md` in the same spirit: a live test blocked by an
   unmet human prerequisite names it as such.

   **5c.** Update `.claude/agents/master-controller.md` so the section is filled
   in at planning time rather than after a failure.

6. **Two measured gaps between the documented permission model and what it
   actually does.** Both were observed by LiveQA during sprint 39's live test, on
   CLI 2.1.278, and neither is yet known to be a defect — this requirement is to
   find out, not to fix.

   **6a.** A write outside the launch working directory succeeds through
   `node`/`npx` while an `ls` of that same path is blocked by Claude Code's own
   guard. Sprints 12 and 19 documented the confinement of shell redirects and the
   Write tool, and 19 found program-mediated writes escape it; this adds that
   reads and writes of the same outside path are treated differently. Re-measure
   deliberately, record it in `docs/sprint-12-permission-scope-findings.md`
   against the CLI version, and state plainly in `liveqa.md` and `qa1.md` what a
   scoped profile does and does not actually confine — those files currently
   imply more than holds.

   **6b.** `git status` ran in a headless `liveqa` session although no git entry
   is in that profile's grant — while, in sprint 40's live test, a headless QA1's
   bookkeeping `git commit` hit "This command requires approval" and left the
   state file uncommitted. Both observations are about the same two profiles, and
   they do not fit one story: establish what a headless gate profile can actually
   do with git today — which operations pass, which prompt, and why any pass at
   all when no git entry exists. Measure `status`, `log`, `diff`, `add`, and the
   exact pathspec commit CLAUDE.md's sprint 32 rule prescribes, for both `qa1`
   and `liveqa`, recording the CLI version.

   **This has a live consequence, which is why it is measured here and fixed
   next:** CLAUDE.md requires each gate role to commit its own verdict
   bookkeeping before handing off, and headless that rule is currently
   unfollowable — the verdict is recorded in the state file and left uncommitted,
   which is the exact durability gap sprints 27 and 32 exist to close. Report the
   measurements to Master Controller, who will file the fix as its own sprint. Do
   not design or ship that fix here, and note that the obvious narrow pattern is
   already known to leak: sprint 36 measured `Bash(git commit -m *)` admitting
   `git commit -m "msg" scripts/tool.js` with zero denials.

   **6c.** Neither 6a nor 6b changes a permission grant in this sprint. The
   deliverable is measurement, the recorded finding, and documentation that
   matches what was measured.

7. **Version bump to one above the currently published version**, with a
   CHANGELOG entry covering Reqs 1–6. Authorized by the user for this sprint.
   Confirm with `npm view fully-completely version` at build time — 0.2.13 when
   this file was written; sprints 39 and 40 both publish before this one.

8. **Tests.** `node scripts/launcher_test.js` and the Python lifecycle tests both
   pass, with new tests for: the managed block containing the lock patterns and
   an upgrade adding them to an existing `.gitignore` while preserving unrelated
   lines; the pattern/constant divergence guard from Req 1; downgrade, upgrade and
   equal-version installer output; whatever Req 3 lands on, plus a test that a
   no-warning launch is unchanged; Reqs 4a and 4b; the template containing the new
   section.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1** — patterns cover both the `.lock` and the `.stolen-<pid>-<ts>` shapes
  and are derived from, or guarded against, `role-claims.js`'s constants; the
  block merge is otherwise unchanged.
- **Req 2** — the comparison reads the installed version file; the message names
  both versions and sits with the normal transition reporting; upgrade and
  equal-version wording is untouched. Assert on the printed output, not only on
  the resulting files.
- **Req 3** — **3a** measurements exist with CLI version and platform for each
  route considered, from real runs; a route justified by reasoning is a FAIL.
  **3b** the no-warning path is unchanged and tested; no added prompt or delay
  on a clean launch. **3c** if nothing shipped, the measurements and the
  recommendation are recorded and that is a legitimate PASS for this requirement.
- **Req 4** — **4a** the test actually greps or parses the shipped code and
  fails on a planted violation; QA1 plants one and confirms it fails. **4b** the
  history assertion exists. **4c** `cmd_complete` is byte-unchanged.
- **Req 5** — the template section and all three agent files carry the wording;
  the guidance says routed-to-Master-Controller, not warning-in-notes.
- **Req 6** — the measurements exist for both 6a and 6b with CLI version and
  conditions, from real runs; the findings doc and the agent files say what was
  actually measured, no more. **6c** — grep the diff: no permission grant
  changed. A conclusion reasoned rather than run is a FAIL.
- **Req 7** — version is published+1 at build time; CHANGELOG present.
- **Req 8** — QA1 runs both suites itself.

**LiveQA verifies live, after Pipeman publishes (with the user's own go-ahead):**

Both platforms, using the Windows VM — the collision warning and the install
behaviour are what workshop attendees see, and sprint 38's round 1 showed a
macOS-only pass is not evidence for Windows. If a platform genuinely cannot be
obtained at gate time, record what was attempted and what failed.

- Provenance: version and `gitHead` from `npm view`, matching
  `last_shipped_commit`.
- **Req 1 live:** fresh install and an upgrade from the previous version, with an
  unrelated ignore line planted first. Launch agents, provoke a lock and a steal
  if reachable, then confirm `git status` in the target shows no launcher file —
  and that the planted line survived.
- **Req 2 live:** install an older version over a newer one and confirm the
  output says so, naming both versions; confirm a normal upgrade and a
  same-version install still read correctly.
- **Req 3 live:** in real VS Code on both platforms, cause a collision warning
  (launch a role that is already running) and confirm a person can still see it
  afterwards. Then run FC: Start All with no collision and confirm nothing extra
  appears and no launch is delayed. If Req 3c applied, confirm the measurements
  shipped and nothing changed.
- **Req 5 live:** read the installed template and agent files in the target.
- **Req 6 live:** in a headless `liveqa` session on the published version,
  re-confirm 6a (a write out while `ls` of the same path is blocked) and 6b
  (each named git operation, for both gate profiles, including the sprint 32
  pathspec commit), recording the CLI version at gate time — it has moved twice
  during this epic.
- Per `liveqa.md` step 7: run every runnable check before recording.

### Out of Scope

- **Changing `/sprint-complete`, `--user-said`, or the authorization rule.**
  Req 4c. Finding 12 was ruled on 21 September: no standing authorization, no
  auto-close. These tests defend that rule; they do not touch it.
- **Changing what the collision warning says.** Sprint 25's wording, and its
  statement of what the record cannot see, stand. This is about whether it can be
  read.
- **Blocking a launch on an unread warning.** Req 3b.
- **Making the installer refuse a downgrade.** Req 2 states it; a deliberate
  rollback stays possible.
- **A general "project scope check" command.** FMC's own; this sprint only stops
  the framework's files from polluting one.
- **Enforcing that Human Prerequisites is non-empty.** Req 5a: "None" is a normal
  answer, and a mechanical requirement to fill it would produce filler.

### Dependencies

- **Blocks:** nothing downstream is waiting on this; FMC guards finding 11 itself
  in its sprint 85.
- **Blocked by:** sprints 39 and 40 closing. All three touch the agent files and
  the release is sequential; Req 1 also builds on sprint 38's lock design.
- **External:** npm publish needs the user's own go-ahead in Pipeman's session.
  Req 3 depends on measured Claude Code CLI behaviour; the version is part of the
  record. The Windows gate needs the user at the VM.

### Team Assignments

- **Dev Team 1:** all of it, after sprint 40 closes.
- **Dev Team 2:** not assigned. Reqs 1–2 (installer), 3 (launcher), 4 (tests) and
  5 (docs) are separable, but they share one release and the agent files, and the
  queue ahead is sequential anyway.

### Risks & Mitigations

- **Req 1's patterns drift from the lock implementation.** — Derive from the
  constants, or add the divergence guard Req 1 requires.
- **Req 3 ships a fix that annoys six-agent launches.** — Req 3b forbids added
  prompts or delay on a clean launch; LiveQA tests FC: Start All with no
  collision on both platforms.
- **Req 3 is unsolvable and the sprint stalls on it.** — Req 3c makes
  "measured, nothing shipped, recorded" a legitimate outcome.
- **Req 4a passes while proving nothing.** — QA1 plants a violation and confirms
  the test fails.
- **Req 6 turns into a grant change mid-sprint.** — Req 6c forbids it; a real
  finding routes to Master Controller for its own sprint.
- **Req 5 becomes paperwork.** — "None" is explicitly a normal answer; the
  requirement is the routing rule in QA1's guidance, not the section being full.
