---
id: 44
title: "Move both Dev Teams to the opus alias, and stop two role tabs reading as the same colour"
original_title: "Move both Dev Teams to Opus 5.5, with the alias established by launching rather than assumed"
epic: "Role configuration: the model each role runs on is a deliberate, verified choice"
status: in_progress
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
default — **written as the bare `opus` alias, not a version string, because
`opus` already resolves to 5.5.** That choice is the operator's and this sprint
implements it; it does not re-litigate the model.

Writing `opus` rather than `opus-5.5` is the more durable form: the alias tracks
whatever Anthropic currently ships as Opus, so the framework does not carry a
version string that silently goes stale the way a pinned one would. It also
means the Dev Teams now follow the same alias Master Controller, QA1 and LiveQA
already use — all five move together whenever the alias moves, which is a
property worth stating rather than discovering later.

Mechanically this is small. `scripts/launcher/agents.js` and `run-role.js` both
record, from real measurement, that an agent file's frontmatter `model:` is the
single place a role's model is set and that it wins even over an explicit
`--model` flag. So the change is two frontmatter lines plus CLAUDE.md's team
table. The risk is not the string — `opus` is already in use by three roles and
demonstrably works — it is confirming that a Dev Team launched this way actually
runs on Opus rather than falling back, and that nothing else in those files
moved.

### Requirements

1. **Both Dev Team agent files set `model: opus`.** `model: sonnet` becomes
   `model: opus` in `.claude/agents/dev-team-1.md` and
   `.claude/agents/dev-team-2.md`. The bare alias, never a version string:
   `opus-5.5`, `claude-opus-5-5` or any other pinned form is wrong for this
   sprint even if it works. Nothing else in those files changes.

2. **CLAUDE.md's team table matches.** Both Dev Team rows read `opus`. The table
   is the framework's own statement of which role runs on what, and a table
   disagreeing with the frontmatter is exactly the "documentation quietly false"
   shape sprint 43 built a test against.

2a. **Say, where the field is set, what actually reads it** *(added 22
   September, after `/sprint-start`, from FMC's finding — re-read this file)*.
   FMC discovered their own orchestrator loads a role's model config and passes
   it to nothing, so every role there has run on the CLI default while looking
   fully configured; they found it only by reading a launcher's source. Our own
   paths do carry it — interactive launches `claude --agent <id>` so the CLI
   reads the file itself (and sprint 12 measured frontmatter beating an explicit
   `--model`), and `headlessLaunchArgs()` puts `meta.model` into the `--agents`
   JSON, which a previous sprint verified is honoured — but nothing in the agent
   file, the tests, or an upgrade notice says so. Add a short comment beside the
   team table in CLAUDE.md naming both routes, so an operator setting `model:`
   can tell it is a supported control rather than decoration, and so a future
   change that stops passing it is visibly a break rather than a silent one.
   **Do not add a per-file comment to all six agent files** — one statement in
   the table's own section, where the models are already listed.

3. **Confirm by launching that a Dev Team actually runs on Opus.** Launch Dev
   Team 1 for real after the change and confirm from the session's own reported
   model that it is Opus — not merely that the launch did not error. Record the
   Claude Code CLI version and what the session reported, in
   `docs/sprint-12-permission-scope-findings.md` or a sibling findings doc
   (sprint 30's conditions format). A silent fallback to another model is the
   failure this check exists to catch.

4. **No other role's model changes.** Pipeman stays `sonnet`; Master Controller,
   QA1 and LiveQA keep `opus`, which they already had. Four of the six roles now
   run the same alias by design.

5. **Dev Team 2's terminal tab stops reading as QA1's** *(added 22 September,
   after `/sprint-start`; Dev Team, re-read this file before continuing)*. The
   operator reports two tabs looking alike; the cause is the colour map, not the
   agent files' distinctness. VS Code task icons accept only `terminal.ansi*`
   theme colours, so `orange` maps to `terminal.ansiBrightYellow`, which sits
   beside QA1's `terminal.ansiYellow` and reads as the same colour in most
   themes.

   **5a.** `.claude/agents/dev-team-2.md` sets `color: cyan`, and `COLOR_MAP` in
   `scripts/launcher/agents.js` gains `cyan: 'terminal.ansiCyan'`. QA1 keeps
   `yellow`; no other role's colour changes.

   **5b. Keep `orange` in the map.** It becomes unused by this framework's own
   roles, but a downstream project may have an agent file declaring it, and
   removing it would break that project's tabs for no gain. Say so in the
   comment beside it.

   **5c.** Update the comment above `COLOR_MAP` — it currently explains the
   orange and purple approximations and will be half-true once Dev Team 2 no
   longer uses orange.

   **5d.** Extend the existing colour test (`scripts/launcher_test.js`, "role
   colors come from each agent file's frontmatter") so it asserts all six roles
   resolve to six *distinct* `terminal.ansi*` values, not just that Master
   Controller is blue. That is the property the operator actually wants, and it
   fails if a future colour change reintroduces a collision.

6. **Version bump to one above the currently published version**, with a
   CHANGELOG entry. Authorized by the user, 22 September. Confirm with
   `npm view fully-completely version` at build time — 0.2.18 when this was
   written; do not trust that number.

7. **Tests.** Both suites pass. If the suite asserts anything about role models
   (sprint 43's documentation-drift test is adjacent), update it so CLAUDE.md's
   table and the agent frontmatter are checked against each other rather than
   against a literal that is now stale.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1** — exactly the `model:` line changed in each Dev Team agent file, to
  the bare `opus`; `git diff` shows nothing else in them. A pinned version
  string is a FAIL even if it would work.
- **Req 2** — both CLAUDE.md rows read `opus`, matching the frontmatter string
  for string.
- **Req 2a** — CLAUDE.md names both routes (the CLI reading the agent file on an
  interactive launch, and `headlessLaunchArgs()`'s `--agents` JSON headless) in
  one place beside the table, not scattered through six agent files.
- **Req 3** — the findings entry exists, names the CLI version, and records what
  a real launched session reported. **"It didn't error" is not evidence and is a
  FAIL**; the session's own reported model is.
- **Req 4** — `git diff` shows no other agent file's `model:` touched.
- **Req 5** — **5a** `dev-team-2.md` reads `cyan` and the map gains
  `terminal.ansiCyan`; QA1 and the other four are untouched. **5b** `orange` is
  still in the map, with the reason in the comment. **5c** the comment is
  accurate after the change. **5d** the test asserts six distinct resolved
  values; QA1 plants a duplicate colour and confirms it fails.
- **Req 6** — version is published+1 at build time; CHANGELOG present.
- **Req 7** — QA1 runs both suites itself; any model assertion checks table
  against frontmatter.

**LiveQA verifies live, after Pipeman publishes (with the user's own go-ahead):**

- Provenance: version and `gitHead` from `npm view`, matching
  `last_shipped_commit`.
- **Fresh install into a clean scratch project, then launch both Dev Teams for
  real** — FC: Start All or the equivalent — and confirm from each session's own
  reported model that it is running on Opus. This is the whole point of the
  sprint: a frontmatter string that parses is not evidence that the role runs on
  the intended model.
- Confirm the other four roles are unchanged, by launching at least one of them
  and reporting what model it reports, and confirm CLAUDE.md's table in the
  installed copy matches what each role actually runs.
- Confirm a headless launch of a Dev Team also reports the intended model, since
  the headless path builds its own arguments.
- **Req 5 live:** run FC: Start All in the scratch project and confirm that all
  six role tabs are distinguishable — specifically that Dev Team 2 and QA1 no
  longer read as the same colour. A screenshot from the operator is acceptable
  evidence; a JSON assertion is not, since the defect was two distinct declared
  colours rendering alike.
- Per `liveqa.md` step 7: run every runnable check before recording.

### Out of Scope

- **Re-picking every role's colour.** Only the collision is in scope; four roles
  keep what they have and QA1 keeps yellow.
- **Removing `orange` from the map.** Req 5b: a downstream agent file may use it.

- **Whether Opus 5.5 is the right model.** The operator's decision; this sprint
  implements it.
- **Changing Pipeman, Master Controller, QA1 or LiveQA.** Req 4. Pinning any
  role to a version string is a separate decision the operator was offered and
  declined.
- **A mechanism for per-project model overrides.** Frontmatter is the one place a
  model is set, deliberately; adding an override path is a different design
  question nobody has asked for.
- **Re-tuning either Dev Team's instructions for a different model.** If the
  model change turns out to need different guidance, that is a finding from
  real sprints, not an assumption to build in now.

### Human Prerequisites

- **The user's own publish authorization in Pipeman's session**, at the moment of
  publishing. Authorizing the bump in this file is not that.
- **A Claude Code CLI and account on which `opus` resolves to the current Opus**,
  on whichever machine runs Req 3's check and LiveQA's live launches. If it does
  not, say so with what was observed rather than recording a guess.

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

- **A pinned version string is written instead of the alias, and goes stale the
  next time Opus moves.** — Req 1 forbids it explicitly and QA1 fails it.
- **The alias silently falls back to another model, and the sprint passes while
  nothing changed.** — Req 3 requires positive confirmation from the session's
  own reported model, and LiveQA repeats it live from a real install.
- **Cyan renders poorly in some themes and a new collision appears.** — Req 5d's
  test catches declared collisions, but only the operator's own eyes catch a
  rendering one; LiveQA's live criterion asks for exactly that.
- **All four `opus` roles move together whenever the alias moves.** — Stated in
  Context as a property of this choice, not a defect; pinning any role is a
  separate decision the operator was offered and declined.
- **A future change stops passing `model:` and nobody notices.** — Req 2a makes
  the routes explicit, and Req 3 plus LiveQA's live launches check the model a
  session actually reports rather than what the file declares. FMC's own
  orchestrator ran every role on a default for weeks with a validated, tested,
  unread config; the defence is checking the session, not the file.
- **The table and the frontmatter drift apart.** — Req 3 and Req 6 check them
  against each other, the shape sprint 43 established.
- **The opus roles have already moved without anyone choosing it.** — Req 4a
  measures and reports it; deliberately not fixed here.
