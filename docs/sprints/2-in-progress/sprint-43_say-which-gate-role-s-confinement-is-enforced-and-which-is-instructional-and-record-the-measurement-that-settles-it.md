---
id: 43
title: "Say which gate role's confinement is enforced and which is instructional, and record the measurement that settles it"
epic: "Headless parity: a role running headless can follow the same rules as one at a keyboard"
status: in_progress
created: 2026-09-22T00:00:00+00:00
---

# Master Controller Sprint Definition — Sprint 43

**Epic:** Headless parity — a role launched headless is held to the same rules as
one at a keyboard, so every rule this framework states must be followable from
both, and every boundary it implies must be one that actually holds.
**Sprint Objective:** State plainly that QA1's confinement is enforced by the
tool layer while LiveQA's is instructional, record the measurement that
establishes it, and change no permission grant.

**NO VERSION BUMP IN THIS SPRINT.** The user declined a release for
documentation alone (22 September). This sprint is written and held; it ships
whenever the next release carries it, or gets its own bump later if the user
decides so. Dev Team: do not add a version bump, and do not treat the absence of
one as an oversight. See Human Prerequisites for what that means for the live
gate.

### Context

Sprint 42 gave headless gate roles `gate-commit.js`, a wrapper that commits
exactly one state file and refuses everything else, enforced in code. LiveQA's
live test then measured something the sprint had not asked about and reported it
rather than leaving it: **the wrapper is a real boundary for QA1 and not for
LiveQA.** QA1's `node -e "…git…"` was denied; LiveQA's ran, and a `node -e` git
commit was not stopped by the permission layer at all. That is LiveQA's own
`Bash(node *)` grant from sprint 39, not anything sprint 42 introduced.

Master Controller's ruling, 22 September: **document it, do not narrow the
grant.** Narrowing `Bash(node *)` would not restore a boundary, because
`Bash(npx *)` remains and does the same thing — that is precisely what sprint 39
measured when it concluded `node *` widened nothing. And `npx` cannot go:
LiveQA's job is installing and running the published artifact, which is arbitrary
code execution by definition. A role whose work is to run published code cannot
be confined by tool grants, and a narrower pattern would buy the appearance of a
boundary with none of its substance — the exact failure this project has now
measured three times (sprint 36's `git commit -m *`, sprint 26's re-grading,
sprint 30's conditions).

What follows is not a defect to fix but a difference to state. QA1 must never
modify the code it audits, and its tool layer genuinely enforces that: no
`node *`, no `npx *`, `Edit` and `Write` denied. LiveQA's restraint comes from
its instructions, exactly as `liveqa.md` already says about writing source. Both
files currently imply more uniformity than holds.

### Requirements

1. **`liveqa.md` states that LiveQA's confinement is instructional, not
   enforced.** Say which parts of its job the tool layer does not and cannot
   constrain (running arbitrary code via `npx`/`node`, and therefore git and file
   writes through that route), why it cannot (the role's own work is running
   published artifacts), and that the restraint is therefore a rule LiveQA keeps,
   not a wall it is held behind. Tie it to what that file already says about
   never writing source, so this reads as the same principle extended, not a new
   licence.

2. **`qa1.md` states that QA1's confinement is enforced on its DEFAULT profile,
   conditionally, and why the two gate roles differ.** *(Amended 22 September,
   after QA1's own round-1 audit found this requirement's first wording
   overclaimed — the sprint whose subject is not overstating a boundary should
   not overstate one in its own requirements. The shipped text was already
   correct; this brings the requirement into line with it, and the cost is one
   re-audit.)* By default QA1's profile holds no `Bash(node *)` and no
   `Bash(npx *)`, with `Edit`/`Write` disallowed, so there is no route to an
   arbitrary child process and the boundary genuinely is enforced rather than
   merely instructed — measured, `node -e` git probe DENIED. Three
   qualifications must be stated, not left implied:
   (a) `gate-commit.js` (sprint 42) is a sanctioned, purpose-built narrow child
   process, and naming it forecloses the obvious objection;
   (b) a valid `fullyCompletely.ownedRepository` declaration makes QA1
   `eligibleForOwnedRepositoryGrant` and hands it the broad set, at which point
   the same probe would run and the boundary is instructional for that session —
   so QA1 must know which case it is in and say so if it bears on a finding;
   (c) no "narrowest of the six" claim — Master Controller's default profile is
   equally narrow and is never eligible for the broad grant; the honest statement
   is that QA1's default profile is narrow by design, not uniquely so.
   Name the asymmetry with LiveQA so a reader of either file understands it is
   designed, not an oversight.

3. **The measurement is recorded where the other permission findings live.**
   Add LiveQA's sprint 42 observation to
   `docs/sprint-12-permission-scope-findings.md` in the established format
   (sprint 30's conditions, sprint 26's grading): CLI version, what was run in
   which profile, what was denied, what ran. Note that it confirms rather than
   contradicts sprint 39's conclusion — `node *` widened nothing because `npx *`
   already reached that far.

4. **No permission grant changes, and no code changes.** `HEADLESS_PERMISSION_PROFILES`
   is byte-unchanged. If the work suggests a grant should change, that is a
   finding for Master Controller and its own sprint, not a change made here.

5. **CLAUDE.md gains one short paragraph** stating the general principle, since
   it will outlive these two files: a role whose work is running published or
   arbitrary code cannot be confined by tool grants, so where a rule matters for
   such a role it must be stated as an instruction and verified by review, not
   assumed to be enforced.

6. **Tests.** Both suites still pass (no behaviour changes). Add a test asserting
   the two gate profiles' grants are what these documents now claim, so a future
   grant change that contradicts the documentation fails the suite rather than
   silently making it false.

### Acceptance Criteria

**QA1 verifies statically:**

- **Req 1** — `liveqa.md` names the unconstrained routes and the reason, and
  frames it as the same principle as its existing source-writing rule.
- **Req 2** — `qa1.md` states the enforced boundary, cites the measurement, and
  names the asymmetry as deliberate.
- **Req 3** — the findings doc entry carries CLI version, profile, commands,
  and outcomes, and states the relationship to sprint 39's conclusion.
- **Req 4** — `git diff` shows `HEADLESS_PERMISSION_PROFILES` unchanged and no
  source behaviour change. Any grant change is a FAIL.
- **Req 5** — the CLAUDE.md paragraph states the general principle, not just
  this instance.
- **Req 6** — the profile-versus-documentation test exists and fails if a grant
  is changed without updating these files. QA1 plants a change and confirms it
  fails.
- **No version bump.** `package.json` unchanged. A bump added here is a FAIL,
  per the header.

**LiveQA verifies live, once this reaches a published release:**

- Read the installed `liveqa.md`, `qa1.md`, CLAUDE.md paragraph and findings doc
  in a real install of whichever version carries this, and confirm the wording
  arrived.
- Re-confirm the measurement itself on the CLI version current at that time, and
  record that version: in a headless QA1 session on the DEFAULT profile, a
  `node -e` git attempt is denied; in a headless LiveQA session, it runs. **Add
  the third case QA1 asked for (round 3): a headless QA1 in a project that
  validly declares `fullyCompletely.ownedRepository` in
  `.claude/settings.local.json` — there the same probe should RUN, not be denied,
  which is what makes Req 2(b)'s conditional claim true rather than merely
  cautious.** If any of the three has changed, say so — the documentation this
  sprint writes would then be stale and needs its own correction.
- Per `liveqa.md` step 7: run every runnable check before recording.

### Out of Scope

- **Narrowing `Bash(node *)` or `Bash(npx *)` for LiveQA.** Ruled on 22
  September: it would not create a boundary while `npx` remains, and `npx` cannot
  go without removing LiveQA's ability to do its job.
- **Any change to `gate-commit.js`.** Sprint 42 shipped and verified it; it is a
  real boundary for QA1 and a convenience for LiveQA, and both of those are now
  documented facts.
- **Re-examining the other four roles' grants.** Dev Team writes source and
  Pipeman pushes; both need broad grants by design. If someone wants that
  written down too, it is a separate sprint.
- **A release for documentation alone.** The user declined one; see the header.

### Human Prerequisites

- **A release that carries this.** This sprint has no bump of its own, so its
  live gate cannot run until its content ships in some later release. Until then
  it can reach QA1's gate and stop there. Master Controller asks the user, when
  the next sprint with a bump is planned, whether this rides along.

### Dependencies

- **Blocks:** nothing.
- **Blocked by:** nothing for the build. The live gate is blocked on a release
  carrying it (Human Prerequisites).
- **External:** the measurement is anchored to the Claude Code CLI version;
  sprint 21's expiry logic applies.

### Team Assignments

- **Dev Team 1:** all of it. Small, documentation plus one test.
- **Dev Team 2:** not assigned.

### Risks & Mitigations

- **The documentation reads as licence rather than as a stated limit.** — Req 1
  ties it to the existing source-writing rule; QA1 checks the framing.
- **A future grant change makes these files quietly false.** — Req 6's test
  fails when the grants and the documentation disagree.
- **The sprint sits unshipped and the wording goes stale.** — Human
  Prerequisites names the trigger: Master Controller raises it when the next
  bump is planned.
- **The measurement expires with a CLI update.** — Req 3 anchors it to a
  version; LiveQA re-confirms at gate time and says so if it has changed.
