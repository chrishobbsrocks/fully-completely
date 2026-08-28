# Fully Completely — Global Instructions

This project uses a sprint workflow enforced by `scripts/sprint_lifecycle.py`.
Slash commands in `.claude/commands/` are the only supported way to move a
sprint forward. Never edit `docs/sprints/registry.json` or anything in
`docs/sprints/state/` by hand, and never move sprint files between folders
yourself, the script owns that. There are two deliberate exceptions: the
trivial fix fast lane (`## Trivial fix fast lane` below), and changes to
this repository's own tooling (`## Changes to this repo's own tooling`
below). The former is a narrow category of change, judged against an
objective checklist rather than a size or risk feeling, that skips the
sprint file and the state
machine entirely.

**Only Pipeman ever runs `git push`, no exceptions, ever.** This holds
regardless of which command you're running or which role's session is
active. In particular, running `/sprint-complete` never involves a push,
it only updates bookkeeping, if you're in Dev Team 1 or Dev Team 2's
session when a sprint wraps up (the common case), do not push as a
"finishing touch" just because you're the one closing it out. Commit
locally if needed, then hand off to Pipeman via `/sprint-ship` or
`/sprint-reship`.

**A sprint is never closed without the user's explicit, real-time
authorization, no exceptions.** Both QA1's audit and LiveQA's live test
passing tells you the code is ready to close, it does not tell you the user
has decided, right now, to close it, those are different facts and the
second is never inferred from the first. Once both gates are green, Dev
Team tells the user the sprint is ready and waits; it only runs
`/sprint-complete <N>` when the user explicitly says to, in that moment.
This is mechanically backstopped, not just an instruction: `complete`
requires `--user-said "..."`, quoting what the user actually said, and
refuses outright, no override, if it's missing or empty.

## The team

| Role | Shorthand | Agent file | Model | Job |
|---|---|---|---|---|
| Master Controller | MC | `.claude/agents/master-controller.md` | opus | Plans sprints, checks status read-only |
| Dev Team 1 | Dev1 | `.claude/agents/dev-team-1.md` | sonnet | Starts, builds, tests, fixes, closes its own sprint |
| Dev Team 2 | Dev2 | `.claude/agents/dev-team-2.md` | sonnet | Runs a separate, independent sprint in parallel, in its own git worktree |
| QA1 | QA1 | `.claude/agents/qa1.md` | opus | Static code audit (the only gate) |
| Pipeman | PM | `.claude/agents/pipeman.md` | sonnet | Only one who pushes to remote |
| LiveQA | LQ | `.claude/agents/liveqa.md` | opus | Live browser testing after every push |

Shorthand is for conversation only, never for file names or commands.

Run each role as its own dedicated Claude Code session, always, no
exceptions, a separate terminal tab is the simplest setup, pasting the
relevant agent file as that session's system prompt. Start each session
with the model listed above, e.g. `claude --model opus` for Master
Controller, QA1, or LiveQA.

**Never invoke another role via the Task/Agent tool as a substitute for
that role running in its own session, ever, regardless of which role's
session you're currently in.** A role's job is to do its own work and then
say so, that's the whole handoff, it is never to perform, simulate, or
spawn another role's actual work, through any mechanism, whether that's
running another role's slash command directly or invoking that role via
the Task/Agent tool. This has actually happened: Dev Team 1's session
spawned QA1 as a sub-agent via the Task tool, inside its own session,
instead of waiting for a real, separate QA1 session to run the audit,
because an earlier version of this file presented sub-agent invocation as
an equally-valid convenience option instead of the hard requirement it
actually is. When a role's work is done, it states its handoff message
and stops. Only the user, moving to the correct role's own session, acts
on that handoff.

## The lifecycle

```
/sprint-new "Title" --epic "Epic name"      Master Controller
        │  (fills in requirements/acceptance criteria in the file)
/sprint-start <N>                            Dev Team 1/2
        │
   dev_build  ─────────────────────────────  Dev Team 1/2 builds
        │
/sprint-qa1 <N> --verdict ...                QA1 (gate 1)
        │  FAIL/CONDITIONAL → back to dev_build
        │  PASS ↓
/sprint-dev-done <N>                         Dev Team (agreed done, NOT complete)
        │
/sprint-ship <N> --commit <hash>             Pipeman
        │
   liveqa_live ──────────────────────────── LiveQA tests live
        │
/sprint-liveqa <N> --deployed-commit <sha> --verdict ...   LiveQA
        │  FAIL/CONDITIONAL → Dev Team fixes, Pipeman /sprint-reship, loop
        │  PASS ↓
/sprint-complete <N> --user-said "..."       Dev Team 1/2 closes it, only when told to
```

A sprint is never complete just because Dev Team said so mid-build. It's only
complete once QA1's static audit AND LiveQA's live test have both
independently passed, **and** the user has explicitly authorized closing it
right now. `/sprint-complete` enforces the first two and will refuse to
close a sprint that's missing either one, telling you exactly which; it
enforces the third by requiring a non-empty `--user-said`, see the note near
the top of this file. Gates passing is not authorization, don't run this
command just because both are green, wait for the user to actually say so.

There used to be a second QA1 gate here, a "final check" run after
LiveQA passed. Across ~13 real sprints it never once caught anything
gate 1 + the live test hadn't already caught, so it was removed — the one
thing it occasionally caught (a sprint file amended mid-build, after QA1's
first read) is now handled two ways: QA1 re-reads the sprint file fresh
immediately before recording its gate-1 verdict (see `.claude/agents/qa1.md`),
and `/sprint-dev-done` mechanically enforces it — a QA1 PASS records a hash
of the sprint file as audited, and dev-done refuses outright, no override,
if the file has changed since. The instruction covers understanding; the
hash check covers the case where the instruction gets skipped under load.

**Command ownership**: `/sprint-start` and `/sprint-complete` are run by
whichever Dev Team (1 or 2) owns the sprint, not by Master Controller. Master
Controller plans sprints and reads status (`/sprint-status`), it does not
issue lifecycle transition commands once a sprint is handed off. Running
those from both a Master Controller session and a Dev Team session at the
same time is what has actually caused duplicate-attempt races and stale
"already complete" errors, keep it to one issuer per sprint.

**Wrong-script safety net**: every `sprint_lifecycle.py` invocation prints a
`[sprint_lifecycle] repo=... script=...` line to stderr. If that path doesn't
point into *this* repo's `scripts/sprint_lifecycle.py`, stop, you're looking
at output from a different tool (a stale global command, a same-named script
elsewhere on disk), not this project's lifecycle state.

**QA1 audits code, not just the sprint file**: the same PASS that records
the sprint-file hash also records the audited commit's tree hash, the
content of the files at that commit, not its SHA. `/sprint-ship` resolves
whatever `--commit` Pipeman passes and refuses outright, no override, if
its content doesn't match what QA1 audited. Using tree content instead of
the raw commit SHA is deliberate: Pipeman's own process legitimately
squashes or rebases before pushing, which changes the SHA without changing
any file, and that must keep working. What must NOT keep working is a
new, unaudited change landing between QA1's PASS and the push, so a
content mismatch always means a fresh `/sprint-qa1` audit is required
before that commit can ship. If you already ran `/sprint-dev-done` once
and need a fresh audit (a new commit landed after the fact), re-running
`/sprint-qa1` is expected to work and resets the phase, run
`/sprint-dev-done` again afterward before shipping.

**Transition-precondition design rule**, credited to an external team who
named it during a cross-install review: *a precondition on a phase
transition must be clearable by the role that hits it, or it must ship with
a documented cross-role recovery path.* The tree-hash check just above is
the worked example: Pipeman is the one who hits it, and Pipeman cannot
clear it, only a fresh audit in QA1's session can. That is fine, not a gap,
because `cmd_qa1` already accepts a sprint sitting in `dev_agreed_done`
specifically so that error has a documented way out (re-run `/sprint-qa1`,
then `/sprint-dev-done` again) rather than being a dead end. Read this as a
constraint on *how* a precondition gets added, never as a reason not to add
one: the hash gates are themselves preconditions on transitions and they
are this framework's best mechanical protections. The rule is "pair every
gate with a recovery path," not "don't add gates."

## Trivial fix fast lane

Not every change needs the full lifecycle. On the downstream project this
is drawn from, the QA1 + LiveQA gate process has repeatedly caught
real bugs, a double-click scoring race, a requirement a static audit
missed but the live test caught, a synchronous-write race on a new storage
key, and every one of those catches was on a change that touched state,
logic, or persistence. None of the real catches were on visual/copy-only
changes. Running the full two-gate process on a one-line footer reorder is
where the actual friction lives, not the verification itself.

**Criteria** (all must hold, this is a checklist, not a size or risk
judgment call):
- The diff touches exactly one file.
- That file is a component/style file (`.tsx`/`.jsx`/`.css` or
  equivalent), **and** the diff itself is markup, text content, or
  style/className props only, no new or modified state, hooks, effects,
  function bodies, or business logic of any kind.
- No new dependencies.
- Not a data file (a `cards.json`/`players.json`-equivalent). Content
  changes still go through the existing lightweight content-sprint
  pattern, a print/export pipeline can be affected by a content change in
  ways a diff doesn't show.

If every criterion holds: Master Controller (or whoever's directing the
work) gives Dev Team a direct instruction, no `/sprint-new` required. Dev
Team builds it, self-verifies (build, lint, and test clean, plus an actual
manual check that it renders correctly, don't skip this because the diff
is small), and hands directly to Pipeman. QA1's static audit and
LiveQA's live test are both skipped, but only for this category
specifically, not the whole verification layer, Pipeman's normal pre-push
checks (branch hygiene, clean build) still apply exactly as they do for
every other push.

If a change fails even one criterion, it goes through the full process,
unchanged, no partial credit and no in-between tier. These criteria are
deliberately mechanical, file count, file type, diff content, dependency
changes, rather than a judgment call about how big or risky a change
*feels*, so "trivial" can't quietly stretch over time to cover changes
that actually needed a real audit. When in doubt, it isn't trivial, run
the full process.

## Running two sprints at once

Each sprint has its own ID and its own state file, so two sprints can be
in-flight at the same time, each moving through the lifecycle above
independently. Dev Team 2 exists for exactly this: Master Controller
assigns it a separate sprint from whatever Dev Team 1 is building. Checking
the Dependencies section of both sprint definitions for file/type overlap is
necessary but **not sufficient**, "independent" sprints on a small app
routinely both end up touching shared files (routing, a shared layout,
a shared config) even when their features don't conceptually overlap.

Because of that, Dev Team 2 always works in its own git worktree, a
separate working directory on its own branch, not the same checkout Dev
Team 1 is using. This is the default, not an opt-in:

```bash
/sprint-worktree <N>
```

run once, before Dev Team 2 starts building. It creates (or reuses) a
worktree at `../<repo>-devteam2-sprint-<N>` on branch `devteam2/sprint-<N>`
and prints the path. Dev Team 2's session should `cd` there before touching
any files, and stay there for the whole sprint. This is what actually
prevents the uncommitted-work collisions that "check for overlap first"
alone did not.

## Quick reference

```bash
/sprint-new "Title" [--epic "Epic name"]                                                        # Master Controller
/sprint-start <N>                                                                               # Dev Team 1/2
/sprint-worktree <N>                                                                            # Dev Team 2 only, before building
/sprint-status [<N>]                                                                            # any role, read-only
/sprint-list                                                                                    # any role, read-only
/sprint-qa1 <N> --verdict PASS|FAIL|CONDITIONAL --notes "..."                                   # QA1
/sprint-dev-done <N>                                                                            # Dev Team 1/2
/sprint-ship <N> --commit <hash>                                                                # Pipeman
/sprint-reship <N> --commit <hash>                                                              # Pipeman
/sprint-liveqa <N> --deployed-commit <sha> --verdict PASS|FAIL|CONDITIONAL --notes "..."        # LiveQA
/sprint-complete <N> --user-said "..."                                                          # Dev Team 1/2
/sprint-abort <N> --reason "..."                                                                # Dev Team 1/2
```

`/sprint-abort` isn't attributed to a role anywhere else in this file (it's absent from the lifecycle diagram above); "Dev Team 1/2" here is inferred from the "Command ownership" note further up — lifecycle transition commands belong to whichever Dev Team owns the sprint, not Master Controller — not a direct quote like the other eleven labels are.

## Sprint data persistence

`docs/sprints/` content (sprint files, `state/`, `registry.json`) is
tracked by git like everything else in this repo, so it's committed and
recoverable the same way any other change is — there's no ignore block
excluding it and nothing to configure. The only sprint-related ignore
rule is `docs/sprints/.locks/`, transient OS file locks used to serialize
concurrent `sprint_lifecycle.py` invocations, never sprint data — leave
that line alone.

## Changes to this repo's own tooling

Everything above describes the lifecycle a *downstream project* runs its
own sprints through, after installing this workflow. It does not describe
how changes to this repository itself (`scripts/`, `.claude/`,
`templates/`, this file) get made. Those are development on the tool, not
a sprint that runs through the tool's own state machine, and that's a
deliberate call, not an oversight:

- **QA1's gate still has a real referent here** (does a diff of
  `sprint_lifecycle.py` or an agent file actually do what it claims), so a
  real independent review before anything non-trivial merges is still
  expected, just not mechanized through `/sprint-qa1` and a sprint file
  for this repo's own commits.
- **LiveQA's gate does not.** LiveQA live-tests a deployed
  product in a browser. This repository has no deployed product, it *is*
  the workflow definition a downstream project deploys against. Forcing a
  browser-testable live-test step onto a change to a Python script or a
  markdown agent file would be fitting the process to itself rather than
  to what actually needs verifying, the same reasoning that produced the
  trivial fix fast lane, applied to the opposite end of the size scale.
- **Every change here should still be a real, committed diff before
  anyone reviews it**, for the same reason `qa1.md` tells QA1 to hold a
  verdict on uncommitted work: a review of a working-tree diff is a claim
  about code that might not exist by the time anyone acts on the review.
  This matters more here than usual, `/sprint-ship`'s commit-content check
  (see `## The lifecycle` above) depends on `git rev-parse HEAD` actually
  being the reviewed commit, not whatever was last pushed before the
  review started.

If a change to this repo's own tooling ever turns out to need something
sprint-shaped (recorded requirements, a documented audit trail across
multiple rounds), that's a case for `/sprint-new` with LiveQA's step
explicitly skipped and noted why, not a case for forcing a live-test step
that doesn't apply.

## Project standards

Add your own project-specific standards below this line (tech stack,
domain type locations, error handling conventions, git strategy, testing
requirements, security baseline). Every agent above should read this file
before starting work, so keep it current.

**This is Fully Completely, not Maestro.** The machine running this may also
have a separate, unrelated sprint-workflow product called Maestro installed
globally (`maestro-*`/`epic-*`/`project-*` skills). If those skills show up
in the available-skills list, that's a fact about this machine, not about
this project. It shares structural similarity with this project (both are
sprint-lifecycle workflows) and possibly some shared lineage, but they are
two different systems. Do not refer to this project as "Maestro," assume
it uses Maestro's conventions, or treat the two as interchangeable, even
when the global skill list shows Maestro skills alongside this project's
own `.claude/commands/sprint-*` and `.claude/agents/` files.

**State-field access convention (`scripts/sprint_lifecycle.py`).** Fields
that have been in a sprint's `state` dict since it was first created
(`id`, `title`, `phase`, `qa1_audit_result`, `groundtruth_result`,
`audit_rounds`, `live_test_rounds`, `started`, `completed`, `history`) are
indexed directly, `state["phase"]`, never `state.get("phase")`. **This is
not the same list as `cmd_start`'s dict literal** — that literal seeds a
brand-new sprint with the *full current* schema, so it also initializes
every post-hoc field (`qa1_audit_file_hash`, `qa1_audited_tree_hash`,
`last_shipped_commit`), which must stay `.get()`-only everywhere else in
the file for the sprints that predate them; don't take "it's in
`cmd_start`'s literal" as license to index a field directly. A missing
base-schema field means the state file is
corrupt, and that must fail loudly with a `KeyError` rather than silently
evaluating to `None` and letting a malformed state limp through the state
machine. Fields added to the schema *after* sprints already existed are
read with `.get()` and an explicit default instead, because state files for
sprints started before that field existed genuinely lack the key, and
that's expected, not corruption. `cmd_dev_done`'s handling of
`qa1_audit_file_hash` is the precedent: it reads
`state.get("qa1_audit_file_hash")`, with a comment explaining that `None`
there means "this sprint PASSed under a version of this script from before
the hash field existed," not "the field failed to save." Follow this for
the next field added to the schema: `.get()` with a default only for fields
younger than some sprint still in flight could be; direct indexing for
everything in the base schema.

---
