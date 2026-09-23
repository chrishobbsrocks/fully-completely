---
id: 45
title: "Say what reads a role's model, stop the colour test passing on a near-miss, and name the rule the publish and close gates share"
epic: "Role configuration: the model each role runs on is a deliberate, verified choice"
status: done
created: 2026-09-23T00:00:00+00:00
---

# Master Controller Sprint Definition — Sprint 45

**Epic:** Role configuration — which model a role runs on is a decision this
framework states in one place, verifies by launching, and ships to every
install.
**Sprint Objective:** Close the four documentation and test gaps sprint 44 left
behind: say what actually reads `model:`, correct the stale `--model` example the
table change orphaned, stop the colour test passing on two colours that render
alike, and state as a general principle the rule the publish and close gates
already enforce separately.

### Context

All four items are carry-overs, and three of them exist because sprint 44
deliberately refused to absorb them mid-flight. Req 1 here was briefly Req 2a
of sprint 44, added by Master Controller *after* that sprint had been built,
audited and passed through `/sprint-dev-done` — the build commit predates the
amendment, so it shipped in nothing, and rescoping it out was cheaper than a fix
round and a second publish for one paragraph. That was Master Controller's own
error, recorded in sprint 44's Out of Scope, and this sprint is where the work
actually lands.

Req 1's substance comes from FMC: their orchestrator loaded a role's model
config, validated it, tested it, and passed it to nothing, so every role ran on
the CLI default while looking fully configured. They found it by reading a
launcher's source. Our own paths do carry `model:` — verified live in sprint 44,
where the structured envelope reported `claude-opus-5-5` for both Dev Teams on
both paths — but nothing in the agent files, the tests, or an upgrade notice says
which code makes that true, so the same silent drop is one refactor away from
being invisible here too.

Req 3 comes from LiveQA and QA1 jointly: sprint 44's new colour test asserts six
*distinct* values, which catches identical declarations but not the defect that
started it. `orange` and `yellow` were always distinct strings; they rendered
alike because they mapped to `terminal.ansiBrightYellow` and
`terminal.ansiYellow`. Sprint 44's own colour evidence was therefore a rendered
screenshot, which is honest and does not scale.

### Requirements

1. **Say, beside CLAUDE.md's team table, what actually reads `model:`.** Name
   both routes in one place: an interactive launch runs `claude --agent <id>`, so
   the CLI reads the agent file itself (and sprint 12 measured frontmatter
   beating an explicit `--model`); a headless launch passes it in
   `headlessLaunchArgs()`'s `--agents` JSON, verified honoured. State it so an
   operator setting `model:` can tell it is a supported control rather than
   decoration, and so a future change that stops passing it reads as a break
   rather than as drift. **One statement in the table's own section — not a
   comment in each of the six agent files.**

2. **Correct the stale `--model` example the table change orphaned.** CLAUDE.md
   (around line 75) still says "Start each session with the model listed above,
   e.g. `claude --model opus` for Master Controller, QA1, or LiveQA" — five roles
   now declare `opus`, not three, and that example also contradicts what Req 1
   documents, since frontmatter wins over `--model` anyway. Rewrite it to tell an
   operator what actually determines the model, and keep any `--model` mention
   consistent with Req 1's statement rather than implying the flag is what sets
   it.

3. **The colour test catches a near-miss, not only an exact collision.**
   Sprint 44's test asserts six distinct `terminal.ansi*` values. Extend it so a
   pair that renders alike also fails: maintain a named, commented set of
   look-alike pairs — `terminal.ansiYellow`/`terminal.ansiBrightYellow` is the
   worked example, since that is the real defect that reached an operator — and
   fail if two roles resolve to any pair in it.

   **3a. Judgment, stated as judgment.** Which pairs look alike is theme- and
   eyesight-dependent and cannot be measured in a unit test. Say so in the
   comment: this set is a deliberately conservative list of pairs known to have
   confused a real reader, not a claim about all themes. Seed it with the one
   confirmed pair and any others the same reasoning obviously covers (a colour
   and its own bright variant).

   **3b.** The limitation stays stated: a rendered check by a person is still the
   only evidence that covers an unlisted pair, and sprint 44's screenshot is the
   precedent. Do not claim the test replaces it.

4. **State the general principle the publish and close gates already share.** Add
   a short paragraph to CLAUDE.md, credited to FMC's Master Controller (22
   September): *taking a cost by default is not the same as choosing it* — whether
   the cost is a release going out, a sprint closing, or a role's model changing
   under an unattended run on an upgrade. The two existing rules
   (`--user-said`, publish authorization) are instances of it; the model case is
   the one that has no gate and does not get one here, which is exactly why the
   principle is worth stating where someone designing the next gate will read it.

   **4a. No new gate, no behaviour change.** This is a statement of a principle,
   not a mechanism. If it suggests a mechanism to anyone, that is a finding for
   Master Controller and its own sprint.

7. **Every shipped copy of the withdrawn `--model` claim is corrected**
   *(added 23 September, during this sprint's own live-test fix loop, at the
   operator's decision — see the note at the end of this requirement)*. Sprint
   45's re-measurement established the opposite of what this framework has been
   asserting: `--model`, given by hand, WINS over an agent file's frontmatter.
   CLAUDE.md now says so. Three other shipped files still say the reverse, two of
   them claiming measurement, and a fourth records the unmeasured
   generalization:

   - `scripts/launcher/agents.js`, header comment: "frontmatter wins either way
     (verified empirically: `--agent X --model haiku` still ran as X's
     frontmatter model)".
   - `scripts/launcher/run-role.js`, lines ~28–29: "confirmed to win even over an
     explicit `--model`".
   - `README.md`, ~114–117: the same claim, "measured directly".
   - `docs/sprint-44-dev-team-opus-model-findings.md`: asserts frontmatter beats
     `--model` "on claude 2.1.280, confirmed by running it" — QA1 established the
     doc's own probe table never passed `--model` in any row, so a real
     measurement was generalized into an untested claim.

   **7a.** Correct the first three to state what was actually measured, matching
   CLAUDE.md's wording rather than paraphrasing it. Where a comment's *design*
   reasoning still holds — this launcher deliberately never passes `--model`, so
   frontmatter is the single place a model is set — keep that and drop only the
   unsupported "and it would win anyway" half. The behaviour is unchanged: no
   launcher starts passing `--model`.

   **7b.** Add a **dated correction note** to the findings doc rather than
   editing its table. The measurement it ran was sound; only the generalization
   drawn from it is withdrawn. Say which rows exist, what they varied, and what
   therefore was never tested. This is the same shape as `/sprint-correct`
   (sprint 40) — append, do not rewrite the record.

   **7c. Sweep for others.** These four were found by one grep. Search the whole
   repository for any other statement about what determines a role's model, in
   any file, and correct or withdraw each. List what was checked in the handoff,
   so the next person knows the sweep's actual coverage rather than assuming it
   was total.

   *Why this is in a sprint already past its gate, when Master Controller's own
   rule is that sprints are not redesigned mid-flight: the operator made the call
   explicitly (23 September) on the trade it actually is — one more QA1 round now
   versus publishing a release whose own files contradict each other about a
   claim this sprint exists to correct, plus a further release to fix it. The
   distinction from sprint 44's Req 2a, which Master Controller added after that
   sprint had passed everything and then had to withdraw, is that this is
   discovered during an active fix loop, before the reship, and it is the same
   defect the sprint is already correcting rather than new scope.*

8. **Version bump to one above the currently published version**, with a
   CHANGELOG entry covering Reqs 1–4. Authorized by the user, 23 September.
   Confirm with `npm view fully-completely version` at build time — 0.2.19 when
   this was written; do not trust that number.

9. **Tests.** Both suites pass, plus Req 3's extension.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1** — one statement beside the team table naming both routes accurately
  (interactive: the CLI reads the agent file; headless: the `--agents` JSON).
  Six scattered comments instead of one statement does not meet it. Check the
  claims against `run-role.js` rather than taking the sentence on trust.
- **Req 2** — the stale example is gone; what replaces it is consistent with
  Req 1 and does not imply `--model` is what sets a role's model.
- **Req 3** — the look-alike set exists, is commented, and includes
  yellow/bright-yellow. **Plant a profile pairing two look-alikes and confirm
  the suite fails**; plant two genuinely distinct colours and confirm it passes.
  **3a** — the comment states this is judgment, conservative, and not a claim
  about all themes. **3b** — the human-rendered check is still named as the only
  coverage for an unlisted pair.
- **Req 4** — the paragraph states the principle generally, names all three
  instances, credits FMC, and **4a** introduces no gate: `git diff` shows no
  behaviour change in `sprint_lifecycle.py` or the launcher.
- **Req 7** — **7a** all three shipped files state what was measured and agree
  with CLAUDE.md; grep for the withdrawn claim and confirm no shipped file still
  asserts it; confirm no launcher started passing `--model`. **7b** the findings
  doc carries an appended, dated correction naming what its table did and did not
  vary, with the table itself unedited. **7c** the sweep's coverage is stated in
  the handoff; QA1 runs its own independent grep rather than trusting that list.
- **Req 8** — version is published+1 at build time; CHANGELOG present.
- **Req 9** — QA1 runs both suites itself.
- The cumulative diff is confined to `CLAUDE.md`, `README.md`,
  `scripts/launcher/agents.js`, `scripts/launcher/run-role.js`,
  `docs/sprint-44-dev-team-opus-model-findings.md`, `scripts/launcher_test.js`,
  `package.json`, `CHANGELOG.md`, the version-derived tables the release
  regenerates, and `docs/sprints/` bookkeeping. Anything else needs a stated
  reason.

**LiveQA verifies live, after Pipeman publishes (with the user's own go-ahead):**

- Provenance: version and `gitHead` from `npm view`, matching
  `last_shipped_commit`.
- Read the installed CLAUDE.md in a real install and confirm Reqs 1, 2 and 4
  arrived, and that the table still matches every agent file's frontmatter.
- **Req 7 live:** grep the installed tree and the published tarball for the
  withdrawn claim — no shipped file may still assert that frontmatter beats
  `--model`. Confirm the installed `agents.js`, `run-role.js` and `README.md`
  agree with the installed CLAUDE.md.
- **Confirm Req 1's claim is still true rather than merely present:** launch one
  role interactively and one headless from that install and check the model each
  session actually reports, from the structured envelope where available, as
  sprint 44 established. A statement about what reads `model:` that has quietly
  stopped being true is worse than no statement.
- Req 3 is a unit-test property; confirm the suite is present in the install and
  passes there, and record the CLI version.
- Per `liveqa.md` step 7: run every runnable check before recording.

### Out of Scope

- **Pipeman's detached-checkout publish technique nearly losing a Master
  Controller commit** (LiveQA's flag, sprint 44). A real mechanism defect that
  can drop someone else's commit, and it gets its own sprint written from
  Pipeman's own report of what happened — not from a one-line summary. The
  operator is obtaining that report.
- **Any new gate.** Req 4a. The principle is stated, not mechanised.
- **Pinning any role to a version string.** Still the operator's decision,
  offered and declined; `opus` resolving to 5.5 for five roles is the intended
  property.
- **A per-project model override mechanism.** Frontmatter stays the single place
  a model is set.
- **Programmatic rendering checks for colour.** Req 3a: not measurable in a unit
  test; the conservative list plus a human check is the honest bound.

### Human Prerequisites

- **The user's own publish authorization in Pipeman's session**, at the moment of
  publishing. Authorizing the bump in this file is not that.

### Dependencies

- **Blocks:** nothing.
- **Blocked by:** sprint 44 closing — it touches the same CLAUDE.md section and
  the same test file, and the releases are sequential.
- **External:** none. Req 1's claims are about this repository's own launcher,
  verified live in sprint 44.

### Team Assignments

- **Dev Team 1:** all of it. Documentation plus one test extension.
- **Dev Team 2:** not assigned.

### Risks & Mitigations

- **Req 1's statement is written and is already wrong.** — QA1 checks it against
  `run-role.js`; LiveQA checks the running sessions, not the sentence.
- **Req 3's look-alike list becomes a false guarantee.** — Req 3a states it as
  judgment and 3b keeps the human check named as the real coverage.
- **Req 4 reads as licence to skip a gate rather than as a reason gates exist.**
  — The paragraph names the two gates that DO enforce it and the one case that
  deliberately does not; QA1 checks the framing.
- **Correcting three files reintroduces the claim somewhere else, or drops the
  design reasoning that is still true.** — Req 7a keeps the "this launcher never
  passes `--model`" half and drops only the unsupported half; QA1 greps
  independently of Dev Team's stated sweep.
- **Scope creep from four small items into a fifth.** — Pipeman's publish defect
  is explicitly Out of Scope with its own sprint named; sprint 44's own history
  is the argument against absorbing anything mid-flight.
