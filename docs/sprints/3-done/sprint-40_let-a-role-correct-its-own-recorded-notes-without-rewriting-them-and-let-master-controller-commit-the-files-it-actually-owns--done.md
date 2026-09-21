---
id: 40
title: "Let a role correct its own recorded notes without rewriting them, and let Master Controller commit the files it actually owns"
epic: "Downstream findings: FMC ShowOffTest run"
status: done
created: 2026-09-18T05:05:39+00:00
---

# Master Controller Sprint Definition — Sprint 40

**Epic:** Downstream findings: FMC ShowOffTest run — framework defects surfaced
by FMC driving real installs headless, routed upstream in
`~/Programming/Fifty_Mission_Cap/docs/proposals/fully-completely-findings-2026-09-13.md`
(outside this repo). Sprints 36 and 38 closed findings 1–5; sprint 39 covers 6–8.
**Sprint Objective:** Give a role an append-only way to correct a factual error
in its own recorded verdict notes without altering the verdict or the phase, and
give a downstream Master Controller a sanctioned way to commit the files it
legitimately owns outside `docs/sprints/` — in one release.

### Context

**Finding 9** (FMC sprint 75, 16 September): LiveQA recorded a verdict whose
notes contained a factual error of its own making — it claimed a check against a
bare remote that had silently failed, and named the wrong branch. The verdict
itself was sound. It verified the claim properly afterwards and had nowhere to
put the correction, because the sprint had moved phase, so the record still
carries the wrong claim and the correction lives only in a later report. The
immutability is right; the absence of any append-only way to say "this evidence
of mine was wrong" is not. This repo has had the same shape: in sprint 36, QA1
caught a factual error in text Dev Team had written into the sprint file, and the
only route was Master Controller editing the file by hand.

**Finding 10** (ShowOffTest, 16 September): after a 0.2.9 → 0.2.11 upgrade, a
downstream Master Controller recorded its upgrade decision in
`docs/rebuild/mc-decisions.md` and hand-merged `CLAUDE.md`, which the installer
had left unmerged. `mc-commit.js` refused both — correctly, by its own rule — and
the files then sat uncommitted, which is exactly the state the commit rule exists
to prevent and where another session's broad commit can sweep them up. The
restriction is sound as a default and must stay the default: sprint 36 measured
that `Bash(git commit -m *)` lets `git commit -m "msg" scripts/tool.js` through
with zero denials, which is why the boundary lives in real code rather than in a
permission pattern. Widening it has to preserve that property — an explicit,
code-enforced allowlist, never a looser pattern and never an arbitrary-path
escape hatch.

### Requirements

1. **A role can append a correction to its own recorded notes.** A new lifecycle
   command (name it in the command file; `/sprint-correct <N>` is the obvious
   shape) records an append-only correction event against a sprint's history.

   **1a. It never mutates anything already recorded.** The original event, its
   notes, the verdict fields, both audit hashes, `last_shipped_commit`, round
   counts and the sprint's phase are all untouched. It only appends a new history
   event. No phase restriction — the whole point is that it works after the
   sprint has moved on, including on a `complete` sprint.

   **1b. It says what it is correcting and who is correcting it.** The event
   records: the actor (from `CLAUDE_CODE_AGENT`, as `cmd_block` and `cmd_abort`
   do), which earlier event it corrects (at minimum the event name and its
   position or timestamp; refuse if that event does not exist), and the
   correction text itself. `--correction` / `--correction-file` is required and
   non-empty, the same shape as `--reason` on block and abort, with the same
   `--notes-file` safety reasoning as `/sprint-liveqa` (backticks and `$` in an
   inline argument have already been command-substituted out of a permanent
   record once).

   **1c. Only the role that recorded the event may correct it.** Compare the
   correcting actor to the actor on the event being corrected and refuse
   otherwise, naming both. A correction is a role saying its own evidence was
   wrong; it is not a route for one role to annotate another's verdict. If
   `CLAUDE_CODE_AGENT` is unset (actor `unknown`), refuse rather than allow an
   unattributable correction.

   **1d. It is visible where the verdict is read.** `/sprint-status <N>
   --verbose` shows the correction attached to, or immediately after, the event
   it corrects, so nobody reads the original evidence without seeing it was
   corrected. A reader who looks only at the summary line must still see that a
   correction exists.

   **1e. Documented as a correction, not a second verdict.** Update CLAUDE.md
   (quick reference plus a short paragraph) and add the command file. State
   plainly that it never changes a verdict, a gate, or a phase: a role that
   believes the *verdict* is wrong, not just its evidence, still re-runs its own
   gate (`/sprint-qa1`, `/sprint-liveqa`) rather than correcting the notes.
   Name it in `qa1.md` and `liveqa.md` as the route to take on finding an error
   in one's own recorded notes.

2. **`mc-commit.js` accepts a small, code-enforced set of Master Controller-owned
   paths outside `docs/sprints/`.**

   **2a. The default stays exactly as it is.** `docs/sprints/` remains allowed.
   Everything not explicitly allowed is still refused with the current message,
   including `..` traversal, symlinks out, and prefix lookalikes like
   `docs/sprints-evil/x`. The allowlist is a named constant with a comment
   stating why each entry is Master Controller-owned. The additions are:
   `CLAUDE.md` (a fixed entry — every project has one, in the same place), and
   a Master Controller decisions log (declared per project, Req 2b). Resolve both through the
   same real-path check the existing boundary uses — an entry is a specific path,
   never a directory wildcard that swallows a subtree.

   **2b. The decisions-log path is read from the project's own declared
   configuration, with a standard default, and is validated rather than
   trusted.** Settled with FMC's Master Controller (18 September), whose
   reasoning stands: the path belongs to the project, not the framework —
   ShowOffTest keeps its decisions with its rebuild material
   (`docs/rebuild/mc-decisions.md`) and another project will want
   `docs/decisions.md` — so standardising one path would make downstream Master
   Controllers move files to suit the tool. Read the declaration the way sprint
   17 reads the project's declared test command, and fall back to a documented
   standard default so a project that declares nothing still works with no
   config at all.

   **Validate the declared value at the point of use, every time, never trust
   it:** it must resolve to exactly one file (not a directory, not a glob, not a
   list), inside the repository, not under `.git/`, and not any path the install
   manifest owns. A declaration failing any of those is refused with a message
   naming which check failed — it does not silently fall back to the default,
   because a project that declared something and got a different file committed
   is worse than a refusal. This is what keeps Req 2c's property intact: the
   widening is one operator-declared, use-time-validated file, not a run-time
   escape hatch.

   **2c. No escape hatch.** No flag, environment variable or argument may widen
   the allowlist at run time. Sprint 36's measurement is the reason: the boundary
   only holds because it is enforced in code against a fixed list, and a run-time
   widening is exactly the permission-pattern gap the wrapper was built to close.

   **2d.** Update `master-controller.md`, the headless note in `sprint-new.md`,
   and `docs/sprint-36-mc-commit-permission-findings.md` to state what the
   wrapper now accepts and what it still refuses.

3. **Version bump to one above the currently published version**, with a
   CHANGELOG entry covering Reqs 1–2. Authorized by the user for this sprint.
   Confirm with `npm view fully-completely version` at build time — 0.2.13 when
   this file was written, and sprint 39 publishes before this one.

4. **Tests.** `node scripts/launcher_test.js` and the Python lifecycle tests both
   pass, with new tests for: a correction appending an event and changing no
   verdict field, hash, round count or phase; a correction on a `complete`
   sprint; refusal when the target event does not exist; refusal when the actor
   differs from the corrected event's actor; refusal when the actor is unknown;
   refusal on empty correction text; `--verbose` output showing the correction
   with its target; `mc-commit.js` accepting each allowlisted path and still
   refusing traversal, symlink-out, prefix lookalikes and an arbitrary path.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1** — read the command: it only appends. **1a** — diff the state dict
  before and after in a test: nothing but `history` differs, phase included, on a
  `complete` sprint too. **1b** — actor, target event and text all recorded;
  required-and-non-empty enforced; the command file mandates the file-based
  input pattern. **1c** — the actor comparison exists and refuses on mismatch and
  on `unknown`, naming both actors. **1d** — assert on `--verbose` output that
  the correction appears with the event it corrects, and that the summary shows a
  correction exists. **1e** — CLAUDE.md, the command file, `qa1.md` and
  `liveqa.md` all say it is not a verdict change and name the re-run route.
- **Req 2** — **2a** the allowlist is a constant with per-entry reasoning;
  traversal, symlink-out and prefix-lookalike refusals are unchanged and tested.
  **2b** the declaration is read like sprint 17's test command, with a
  documented default; each validation (single file, inside the repo, not under
  `.git/`, not an install-manifest path, not a directory) is enforced in code
  and tested, and a failing declaration refuses with the reason rather than
  falling back to the default; a caller-supplied path cannot bypass the list. **2c** grep the diff for any run-time widening —
  finding one is a FAIL. **2d** docs updated.
- **Req 3** — version is published+1 at build time; CHANGELOG present.
- **Req 4** — QA1 runs both suites itself.
- The cumulative diff is confined to `scripts/sprint_lifecycle.py`,
  `scripts/mc-commit.js`, `.claude/commands/`, `.claude/agents/`, `CLAUDE.md`,
  tests, `package.json`, `CHANGELOG.md`, the version-derived tables the release
  regenerates, `docs/sprint-36-mc-commit-permission-findings.md`, and
  `docs/sprints/` bookkeeping.

**LiveQA verifies live, after Pipeman publishes (with the user's own go-ahead):**

- Provenance: version and `gitHead` from `npm view`, matching
  `last_shipped_commit`.
- **Fresh install, correction end to end:** drive a throwaway sprint to a
  recorded verdict, record a correction against it as the same role, and confirm
  via `/sprint-status --verbose` that the original notes are unchanged, the
  correction is visible against them, and phase and verdict fields are identical
  before and after (compare the state file). Repeat on a `complete` sprint.
  Confirm each refusal in Req 1c/1b live: a different actor, an unknown actor, a
  missing target event, empty text.
- **Headless:** confirm a headless role (QA1 or LiveQA, whose profiles allow the
  lifecycle script) can run the correction command, and that the file-based input
  path works under that profile — the `printf` route `liveqa.md` documents.
- **`mc-commit.js` live:** in the scratch project, as Master Controller, commit
  a change to `CLAUDE.md` and to the decisions log through the wrapper — both
  succeed. Then confirm it still refuses `scripts/`, a `..` traversal, a
  symlink pointing out, and `docs/sprints-evil/x`. Confirm no flag or environment
  variable widens it.
- Per `liveqa.md` step 7: run every runnable check before recording.

### Out of Scope

- **Editing or deleting a recorded verdict.** Req 1a. Immutability is the
  property being preserved, not worked around.
- **Correcting another role's record.** Req 1c. A disagreement with another
  role's verdict is a re-run of that gate, not an annotation.
- **Letting `mc-commit.js` commit source, tests or scripts.** Master Controller
  does not write code; the wrapper should never be the route by which it could.
- **A general-purpose commit wrapper for other roles.** Dev Team, QA1, LiveQA
  and Pipeman have their own documented commit shapes.
- **LiveQA's two workshop notes** — the warning being unreadable before Claude's
  UI covers it, and the installer downgrading silently. Their own sprint, next.
- **Finding 4.** Already fixed: sprint 36, Req 5 rewrote `liveqa.md` step 7 and
  shipped in 0.2.11.

### Dependencies

- **Blocks:** retirement of FMC's workarounds for findings 9 and 10.
- **Blocked by:** sprint 39 closing. Both touch `sprint_lifecycle.py`,
  `mc-commit.js` docs and the agent files, and releases are sequential.
- **External:** npm publish needs the user's own go-ahead in Pipeman's session.

### Team Assignments

- **Dev Team 1:** all of it, after sprint 39 closes.
- **Dev Team 2:** not assigned. Reqs 1 and 2 are separable in code but share the
  agent files, CLAUDE.md and one release; sprint 39 holds the queue ahead.

### Risks & Mitigations

- **The correction command becomes a back door for changing a verdict.** — Req 1a
  forbids mutation and a test diffs the whole state dict; Req 1e documents the
  re-run route for an actually-wrong verdict; Req 1c stops cross-role
  annotation.
- **A correction is recorded and nobody reading the verdict sees it.** — Req 1d
  requires it in `--verbose` against its target event and visible in the summary.
- **Req 2 reopens the gap sprint 36 measured and closed.** — Req 2a keeps the
  real-path check and every existing refusal; 2c forbids run-time widening; QA1
  FAILs on finding one; LiveQA re-tests each refusal live.
- **The decisions-log path is guessed wrong and downstream projects still can't
  commit theirs.** — Req 2b reads the project's own declaration with a standard
  default, settled with FMC.
- **A bad or hostile declaration turns Req 2b into the escape hatch Req 2c
  forbids.** — The declared value is validated at every use (single file, inside
  the repo, not `.git/`, not install-manifest-owned, not a directory) and
  refused with the reason rather than silently defaulting.
