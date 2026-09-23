---
id: 44
title: "Move both Dev Teams to Opus 5.5, with the alias established by launching rather than assumed"
epic: "Role configuration: the model each role runs on is a deliberate, verified choice"
status: todo
created: 2026-09-22T00:00:00+00:00
---

# Master Controller Sprint Definition — Sprint 44

**Epic:** Role configuration — which model a role runs on is a decision this
framework states in one place, verifies by launching, and ships to every
install.
**Sprint Objective:** Change Dev Team 1 and Dev Team 2 from `sonnet` to Opus 5.5,
using an alias established by actually launching a session rather than assumed,
and ship it.

### Context

The operator's decision, 22 September: Opus 5.5 has been released, is cheaper
than Opus 5 and comparable in capability, and both Dev Teams should run on it by
default. This sprint records and implements that choice; the judgment about the
model itself is the operator's, not something this sprint re-litigates.

Mechanically this is small. `scripts/launcher/agents.js` and `run-role.js` both
record, from real measurement, that an agent file's frontmatter `model:` is the
single place a role's model is set and that it wins even over an explicit
`--model` flag. So the change is two frontmatter lines plus CLAUDE.md's team
table. What is NOT small is the alias string: **nobody here knows what Claude
Code accepts for this model.** Master Controller's own knowledge predates the
release, and a wrong string in frontmatter is not a cosmetic error — it is a role
that fails to launch, in every downstream install, discovered by a workshop
attendee rather than by us. Sprints 14, 21, 26 and 30 all exist because a
version- or CLI-dependent claim was written from reasoning instead of a run.

### Requirements

1. **Establish the accepted alias by launching, before changing any file.**
   Determine what Claude Code actually accepts for Opus 5.5 in an agent file's
   `model:` frontmatter, by launching a real session and confirming from the
   session's own reported model that it ran on 5.5 and not on a fallback.
   Record what was tried, what was accepted, what was rejected, and the Claude
   Code CLI version, in `docs/sprint-12-permission-scope-findings.md` or a
   sibling findings doc — sprint 30's conditions format, sprint 26's grading.

   **1a. A silent fallback is the failure mode to rule out.** An unrecognised
   alias may not produce an error; it may quietly run on something else. Confirm
   positively that the session reports the intended model, rather than confirming
   only that the launch did not fail.

   **1b. If no alias reliably selects Opus 5.5, stop and report to Master
   Controller.** Do not ship a guess, and do not ship a string that works on this
   machine's CLI version but is undocumented — say what was measured and let
   Master Controller decide.

2. **Both Dev Team agent files carry that alias.** `model: sonnet` becomes the
   established alias in `.claude/agents/dev-team-1.md` and
   `.claude/agents/dev-team-2.md`. Nothing else in those files changes.

3. **CLAUDE.md's team table matches.** Both Dev Team rows show the new model.
   The table is the framework's own statement of which role runs on what, and a
   table disagreeing with the frontmatter is exactly the "documentation quietly
   false" shape sprint 43 built a test against.

4. **No other role's model changes.** Pipeman stays `sonnet`; Master Controller,
   QA1 and LiveQA keep what they have. The operator's decision covers the Dev
   Teams only.

   **4a. Report, do not fix, what the bare `opus` alias now resolves to.** If the
   plain `opus` used by Master Controller, QA1 and LiveQA has begun resolving to
   5.5, those three roles have changed model without anyone choosing it. That is
   worth knowing and is not this sprint's to change: measure it, record it, and
   report it to Master Controller.

5. **Version bump to one above the currently published version**, with a
   CHANGELOG entry. Authorized by the user, 22 September. Confirm with
   `npm view fully-completely version` at build time — 0.2.18 when this was
   written; do not trust that number.

6. **Tests.** Both suites pass. If the suite asserts anything about role models
   (sprint 43's documentation-drift test is adjacent), update it so the table and
   the frontmatter are checked against each other rather than against a literal
   that is now stale.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1** — the findings entry exists, names the CLI version, and records a
  real launch with the session's own reported model. **A verdict recorded on
  "the alias looks right" is a FAIL**; so is one where only "it didn't error"
  was checked (1a). **1b** — if Dev Team escalated instead of shipping, that is
  a legitimate outcome and the sprint stops for Master Controller.
- **Req 2** — exactly the `model:` line changed in each agent file; `git diff`
  shows nothing else in them.
- **Req 3** — both CLAUDE.md rows match the frontmatter exactly, string for
  string.
- **Req 4** — `git diff` shows no other agent file's `model:` touched. **4a** —
  the `opus` resolution is recorded and reported, not acted on.
- **Req 5** — version is published+1 at build time; CHANGELOG present.
- **Req 6** — QA1 runs both suites itself; any model assertion checks table
  against frontmatter.

**LiveQA verifies live, after Pipeman publishes (with the user's own go-ahead):**

- Provenance: version and `gitHead` from `npm view`, matching
  `last_shipped_commit`.
- **Fresh install into a clean scratch project, then launch both Dev Teams for
  real** — FC: Start All or the equivalent — and confirm from each session's own
  reported model that it is running on Opus 5.5. This is the whole point of the
  sprint: a frontmatter string that parses is not evidence that the role runs on
  the intended model.
- Confirm the other four roles are unchanged, by launching at least one of them
  and reporting what model it reports, and confirm CLAUDE.md's table in the
  installed copy matches what each role actually runs.
- Confirm a headless launch of a Dev Team also reports the intended model, since
  the headless path builds its own arguments.
- Per `liveqa.md` step 7: run every runnable check before recording.

### Out of Scope

- **Whether Opus 5.5 is the right model.** The operator's decision; this sprint
  implements it.
- **Changing Pipeman, Master Controller, QA1 or LiveQA.** Req 4. If 4a's
  measurement suggests the opus roles should be pinned, that is a separate sprint
  and the operator's call — they were offered it and chose Dev Teams only.
- **A mechanism for per-project model overrides.** Frontmatter is the one place a
  model is set, deliberately; adding an override path is a different design
  question nobody has asked for.
- **Re-tuning either Dev Team's instructions for a different model.** If the
  model change turns out to need different guidance, that is a finding from
  real sprints, not an assumption to build in now.

### Human Prerequisites

- **The user's own publish authorization in Pipeman's session**, at the moment of
  publishing. Authorizing the bump in this file is not that.
- **A Claude Code CLI recent enough to offer Opus 5.5**, on whichever machine
  runs Req 1's measurement and LiveQA's live launches. If it is not available,
  say so with what was tried rather than recording a guess.

### Dependencies

- **Blocks:** nothing.
- **Blocked by:** nothing. Sprint 43 is closed and 0.2.18 is published.
- **External:** the alias is a property of the Claude Code CLI and of model
  availability on the operator's account; sprint 21's version-anchoring applies,
  so record the CLI version with the finding.

### Team Assignments

- **Dev Team 1:** all of it. Small, but Req 1 is the whole risk.
- **Dev Team 2:** not assigned — though note it is the role whose own model this
  sprint changes, so its next sprint is the first real test of the change.

### Risks & Mitigations

- **A wrong alias ships and roles fail to launch in every install.** — Req 1
  establishes it by launching; Req 1b forbids shipping a guess; LiveQA launches
  both Dev Teams from a real install before the sprint can pass.
- **An unrecognised alias silently falls back to another model, and the sprint
  passes while nothing changed.** — Req 1a requires positive confirmation from
  the session's own reported model, and LiveQA repeats it live.
- **The table and the frontmatter drift apart.** — Req 3 and Req 6 check them
  against each other, the shape sprint 43 established.
- **The opus roles have already moved without anyone choosing it.** — Req 4a
  measures and reports it; deliberately not fixed here.
