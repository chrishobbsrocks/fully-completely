---
id: 47
title: "Make content the documented proof of what shipped, fix three pointers to a renamed rule, and check for a prior measurement before calling one unverified"
epic: "Knowledge that survives: a record is only as good as whether the next person finds it"
status: todo
created: 2026-09-24T00:00:00+00:00
---

# Master Controller Sprint Definition — Sprint 47

**Epic:** Knowledge that survives — this project keeps measuring things
correctly, writing them down, and then not finding them. A record is worth only
what the next person's actual path reaches.
**Sprint Objective:** Make content comparison the documented proof of what a
release contains, with `gitHead` demoted to corroboration; repair three shipped
pointers to a rule that was renamed out from under them; and give Master
Controller a planning step that checks this repository's own history before
flagging an assumption as unverified.

### Context

Three findings from sprint 46, all the same shape: **a pointer that outlived what
it pointed at.**

**The provenance question is sprint 13's own unimplemented recommendation.** That
sprint found `gitHead` absent on 0.1.11, correctly diagnosed the linked worktree
as the cause, and wrote: LiveQA verified 0.1.11 by content instead — registry
`dist.shasum` against the downloaded tarball, every published file byte-identical
to `git show <commit>:<path>` — and "that is a stronger proof than the metadata
it replaced, and it should be the documented path rather than an improvisation
each time." It was never made the documented path. LiveQA has since improvised it
at least three times, most recently in sprint 46's own round-1 FAIL, where
`gitHead` was missing and content comparison is what established the artifact was
sound. Meanwhile `liveqa.md` says nothing about provenance at all: the method
survives only in whatever criteria Master Controller happens to write into each
sprint file.

**Three shipped files point at a rule that no longer exists.**
`scripts/gate-commit.js`, `scripts/mc-commit.js` and `scripts/sprint_lifecycle.py`
each tell a reader to "see CLAUDE.md's worktree-publish rule, sprint 46" — and
sprint 46 changed technique mid-flight, so CLAUDE.md now documents a *clone*
publish and contains zero occurrences of that name. The advice in those messages
is right; the signpost points at nothing. LiveQA found it and named it correctly
as the same shape as the sprint's own root cause.

**And the planning gap is Master Controller's.** Sprint 46's Req 1a called the
worktree behaviour "unverified" when this repository had measured it twice,
twenty days earlier — in the `v0.1.11` tag annotation and in sprint 13's own
sprint file. That cost a release (0.2.22, published with no `gitHead`) and a fix
round. QA1 named the missing step: before writing "nobody here knows whether X",
look.

### Requirements

1. **Content comparison becomes the documented proof of what a release
   contains.** Write the method into `.claude/agents/liveqa.md` as the standing
   provenance check, not something a sprint file has to specify each time:
   registry `dist.shasum` against the downloaded tarball, and every published
   file byte-compared against the audited commit (`git show <commit>:<path>`),
   reporting counts of matched, mismatched, and not-in-commit.

   **1a. `gitHead` is demoted to corroboration, not removed.** It remains worth
   checking and reporting, and Pipeman's own step 10.3 check — which must be
   PRESENT and correct at publish time, and which caught sprint 46's failure
   immediately — **does not change**: for Pipeman it is still a publish-time stop
   condition, because its absence means the technique was wrong. What changes is
   LiveQA's side: a missing or mismatched `gitHead` no longer decides the verdict
   on its own when content comparison independently proves the artifact. State
   the asymmetry explicitly, with the reason — npm's metadata attests what git
   said at one instant; content comparison proves what the tarball actually is.

   **1b. Neither replaces the other.** Content comparison cannot detect a
   *published-from-the-wrong-commit* release whose content happens to match, and
   `gitHead` cannot detect content drift. Say which question each answers.

   **1c. Make it runnable, not recited.** Add a script that performs the content
   comparison end to end (download the published tarball, check `dist.shasum`,
   byte-compare every file against a given commit, print the three counts and a
   clear pass/fail), alongside `verify-tarball.sh`, which checks a *local* pack
   rather than a published release. LiveQA improvising the same comparison by
   hand each time is the defect; a script is what makes it the documented path.

2. **The three stale pointers are repaired, and the rule gets a name that will
   survive.** Update the messages in `gate-commit.js`, `mc-commit.js` and
   `sprint_lifecycle.py` to name what CLAUDE.md actually says now.

   **2a.** Prefer a durable reference over a sprint number: point at the rule by
   what it *is* ("CLAUDE.md's publish-isolation rule: publish from a clone, never
   from this checkout") rather than by the sprint that introduced it. Sprint
   numbers are stable, but a sprint's *content* is not — sprint 46 is the proof,
   having changed technique after those messages were written.

   **2b. Sweep, do not spot-fix.** Search the repository for every cross-file
   reference that names a rule, a technique, or a section by sprint number, and
   check each still describes what it points at. Report what was checked and what
   was found, so the sweep's coverage is known rather than assumed. Fix what is
   wrong; leave correct references alone.

3. **Master Controller checks this repository before calling something
   unverified.** Add to `.claude/agents/master-controller.md`: before writing a
   FLAGGED ASSUMPTION, or any claim that a behaviour is unmeasured, search this
   repository's own record first — sprint files (including closed ones), the
   `docs/` findings documents, CHANGELOG entries, and **annotated git tags**,
   which is where 0.1.11's root cause lived and which nothing else in this
   framework tells anyone to read. If a prior measurement exists, cite it and
   state whether it still applies (CLI version, npm behaviour, and dates move);
   if it exists and is now wrong, say so and re-measure deliberately rather than
   flagging it as never-measured.

   **3a. State the cost, not the principle.** Name sprint 46 concretely: a
   release published with no `gitHead`, a FAIL round, and a fix round, from a
   behaviour this repository had measured twice, twenty days earlier. A rule with
   a price attached gets followed; an exhortation does not.

   **3b. Do not turn this into a mechanical gate.** No command refuses anything;
   this is planning discipline. If someone later wants it enforced, that is a
   finding for Master Controller and its own sprint.

4. **Version bump to one above the currently published version**, with a
   CHANGELOG entry covering Reqs 1–3. Authorized by the user, 24 September.
   Confirm with `npm view fully-completely version` at build time — 0.2.23 when
   this was written; do not trust that number.

5. **Tests.** Both suites pass, plus: the new script's own behaviour (a matching
   release passes; a planted mismatch fails; a missing `gitHead` is reported
   without failing the content check), and a test that no shipped file references
   a rule by a sprint number whose content no longer matches — if that proves
   impractical to automate, say why in a comment rather than shipping a test that
   asserts nothing.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1** — `liveqa.md` carries the method as a standing check. **1a** — the
  asymmetry is explicit and Pipeman's publish-time `gitHead` stop condition is
  **unchanged**; `git diff` on `pipeman.md`'s step 10.3 shows no weakening.
  **1b** — both questions are named. **1c** — the script exists, is distinct from
  `verify-tarball.sh` in purpose, and is referenced from `liveqa.md`.
- **Req 2** — all three messages name the current rule; **2a** — the reference is
  by rule, not sprint number; **2b** — the sweep's coverage is stated, and QA1
  runs its own independent grep rather than trusting that list.
- **Req 3** — `master-controller.md` names the four places to search, including
  annotated tags; **3a** — sprint 46's concrete cost is stated; **3b** — no
  command gained a gate.
- **Req 4** — version is published+1 at build time; CHANGELOG present.
- **Req 5** — QA1 runs both suites itself and confirms the new script's tests
  actually exercise a planted mismatch.

**LiveQA verifies live, after Pipeman publishes (with the user's own go-ahead):**

- **Use the new script on this very release** — that is the point of Req 1c. Run
  it against the published version and the audited commit; report the three
  counts. If the script cannot do what the method requires, that is a FAIL no
  matter how good the prose is.
- Confirm `gitHead` is present and correct as well (Pipeman's check is
  unchanged), and confirm that the two checks are reported as answering different
  questions rather than one standing in for the other.
- Read the installed `liveqa.md`, `master-controller.md` and the three repaired
  messages in a real install.
- Per `liveqa.md` step 7: run every runnable check before recording.

### Out of Scope

- **Changing Pipeman's publish technique or its `gitHead` stop condition.**
  Sprint 46 settled the clone, and the publish-time check is what caught its own
  failure. Req 1a demotes `gitHead` only on LiveQA's side.
- **Removing `gitHead` reporting anywhere.** It answers a question content
  comparison cannot (Req 1b).
- **A mechanical gate on Master Controller's planning step.** Req 3b.
- **Cleaning up the 24 dangling stash artifacts** from the retired
  detached-checkout technique (LiveQA, sprint 46). Harmless litter; a `git gc`
  housekeeping item for whenever Pipeman next has reason to touch it, not a
  sprint requirement.
- **A general "is this documentation still true" mechanism.** Req 2b sweeps
  today's references; a standing mechanism is a much larger design question and
  nobody has established it is needed.

### Human Prerequisites

- **The user's own publish authorization in Pipeman's session**, at the moment of
  publishing. Authorizing the bump in this file is not that.

### Dependencies

- **Blocks:** nothing.
- **Blocked by:** nothing. Sprint 46 is closed and 0.2.23 is published.
- **External:** npm's registry metadata (`dist.shasum`, `gitHead`) and tarball
  download behaviour, which the new script depends on.

### Team Assignments

- **Dev Team 1:** all of it.
- **Dev Team 2:** not assigned.

### Risks & Mitigations

- **Demoting `gitHead` reads as "provenance matters less".** — Req 1a states the
  asymmetry and leaves Pipeman's publish-time stop condition untouched; QA1
  checks that diff specifically.
- **The new script becomes another thing that exists and is not used.** — LiveQA
  must run it on this sprint's own release as an acceptance criterion, which is
  the same "prove it on yourself" shape that caught sprint 46's failure.
- **The reference sweep misses a category.** — Req 2b requires stating coverage;
  QA1 greps independently rather than trusting the list.
- **Req 3 becomes an exhortation nobody follows.** — Req 3a attaches the concrete
  price: a wasted release and two rounds, from knowledge twenty days old.
- **This sprint repeats the error it exists to fix, by asserting something the
  repository has already measured.** — Req 3 applies to this sprint too: check
  before flagging, and cite what exists.
