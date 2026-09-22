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

**VERSION BUMP AUTHORIZED, 22 September — this header REPLACES the earlier
"no version bump" instruction.** The user first declined a release for
documentation alone, then reversed that later the same day and authorized this
sprint to ship on its own. Dev Team: add the bump (Req 7 below). The earlier
instruction is void; do not follow it, and do not read its removal as an
oversight. *(Also on record, and explicitly NOT authorization: FMC's Master
Controller asked for this wording sooner rather than later. Publishing still
requires the user's own word in Pipeman's session, in the moment — a downstream
team's preference is never a substitute for it.)*

### Context

Sprint 42 gave headless gate roles `gate-commit.js`, a wrapper that commits
exactly one state file and refuses everything else, enforced in code. LiveQA's
live test then measured something the sprint had not asked about and reported it
rather than leaving it: **the wrapper is a real boundary for QA1 and not for
LiveQA.** QA1's `node -e "…git…"` was denied; LiveQA's ran, and a `node -e` git
commit was not stopped by the permission layer at all. That is LiveQA's own
`Bash(node *)` grant from sprint 39, not anything sprint 42 introduced.

Master Controller's ruling, 22 September: **document it, do not narrow the
grant.** *(Independently reproduced: FMC's own sprint 39 granted their headless
LiveQA `Bash(node *)` and recorded the same measurement in the profile itself —
`npx *` already permits arbitrary program-mediated writes inside and outside the
working directory. Two installs, same measurement, same ruling; treat it as
settled rather than as one team's judgment call. Their owned-repository grant
includes `bash *`, `sh *`, `git *` and `node *`, so the QA1 conditional in Req 2
reproduces there too.)* Narrowing `Bash(node *)` would not restore a boundary, because
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

   **6a. Assert the PAIRING, not only the prose (added 22 September, FMC's
   sharpening; requires a fresh `/sprint-qa1` and a second `/sprint-dev-done`,
   which is the hash check working as intended).** A prose-versus-grants test
   passes on a profile that is quietly lying, and this is not hypothetical:
   `disallowedTools: ['Edit', 'Write']` sits directly above `Bash(npx *)` in
   LiveQA's profile and directly above the narrow script grants in QA1's. Same
   two lines, opposite meaning, no marker telling them apart — and FMC's own
   install carries the identical shape. So assert the structural invariant:
   **any profile that disallows `Edit`/`Write` while granting a general
   interpreter or shell (`node *`, `npx *`, `bash`, `sh`, `git *`, or an
   equivalent route to an arbitrary child process) MUST carry the
   instructional-not-enforced wording, and the suite fails if it does not.**
   Include the owned-repository grant set in what counts as such a route, since
   a declaration is what flips QA1. The test must fail on a planted profile that
   pairs the two without the wording — QA1 plants one to prove it.

   **6b.** State in the test's own comment why prose-matching alone is
   insufficient, so the next person to touch it does not simplify it back.

7. **Version bump to one above the currently published version**, with a
   CHANGELOG entry covering Reqs 1–6. Authorized by the user, 22 September,
   reversing the earlier decision recorded in this file's own header. Confirm the
   published version with `npm view fully-completely version` at build time —
   0.2.17 when this requirement was written; do not trust that number.

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
  fails. **6a** — the pairing invariant is asserted structurally, covering the
  owned-repository route; QA1 plants a profile that disallows `Edit`/`Write`
  alongside a general interpreter with no instructional wording and confirms the
  suite fails on it. A test that only compares prose to grants does not meet this
  requirement. **6b** — the comment says why.
- **Req 7** — `package.json` is published+1, confirmed at build time, with a
  CHANGELOG entry. **The earlier "a bump here is a FAIL" criterion is void**
  (the header says so): a bump is now required, and its ABSENCE is the FAIL.

**LiveQA verifies live, after Pipeman publishes (with the user's own go-ahead):**

- Provenance: version and `gitHead` from `npm view`, matching
  `last_shipped_commit`.

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
- **Any code or grant change.** Reqs 4 and 6 still hold: this release carries
  documentation and tests only. The bump does not license anything else into the
  diff.

### Human Prerequisites

- **The user's own publish authorization in Pipeman's session**, at the moment of
  publishing. Authorizing the bump here (22 September) is not that, and does not
  stand in for it.
- *(Resolved: this sprint no longer waits on another release to carry it — see
  the header and Req 7.)*

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
- **A release published for documentation alone carries an unnoticed behaviour
  change.** — Reqs 4 and 6 keep `HEADLESS_PERMISSION_PROFILES` byte-unchanged and
  the diff to docs and tests; QA1 fails the sprint on any grant movement.
- **The measurement expires with a CLI update.** — Req 3 anchors it to a
  version; LiveQA re-confirms at gate time and says so if it has changed.
