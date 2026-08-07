# Fully Completely — Global Instructions

This project uses a sprint workflow enforced by `scripts/sprint_lifecycle.py`.
Slash commands in `.claude/commands/` are the only supported way to move a
sprint forward. Never edit `docs/sprints/registry.json` or anything in
`docs/sprints/state/` by hand, and never move sprint files between folders
yourself, the script owns that.

**Only Pipeman ever runs `git push`, no exceptions, ever.** This holds
regardless of which command you're running or which role's session is
active. In particular, running `/sprint-complete` never involves a push,
it only updates bookkeeping, if you're in Dev Team 1 or Dev Team 2's
session when a sprint wraps up (the common case), do not push as a
"finishing touch" just because you're the one closing it out. Commit
locally if needed, then hand off to Pipeman via `/sprint-ship` or
`/sprint-reship`.

## The team

| Role | Shorthand | Agent file | Model | Job |
|---|---|---|---|---|
| Master Controller | MC | `.claude/agents/master-controller.md` | opus | Plans sprints, checks status read-only |
| Dev Team 1 | Dev1 | `.claude/agents/dev-team-1.md` | sonnet | Starts, builds, tests, fixes, closes its own sprint |
| Dev Team 2 | Dev2 | `.claude/agents/dev-team-2.md` | sonnet | Runs a separate, independent sprint in parallel, in its own git worktree |
| QA1 | QA1 | `.claude/agents/qa1.md` | opus | Static code audit (the only gate) |
| Pipeman | PM | `.claude/agents/pipeman.md` | sonnet | Only one who pushes to remote |
| GroundTruth | GT | `.claude/agents/groundtruth.md` | opus | Live browser testing after every push |

Shorthand is for conversation only, never for file names or commands.

Run each role as its own Claude Code session (a separate terminal tab is the
simplest setup), pasting the relevant agent file as the system prompt, or
invoke them as native Claude Code sub-agents via the Task tool if you'd
rather not manage tabs manually. Start each session with the model listed
above, e.g. `claude --model opus` for Master Controller, QA1, or GroundTruth.

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
   groundtruth_live ──────────────────────────── GroundTruth tests live
        │
/sprint-groundtruth <N> --verdict ...            GroundTruth
        │  FAIL/CONDITIONAL → Dev Team fixes, Pipeman /sprint-reship, loop
        │  PASS ↓
/sprint-complete <N>                         Dev Team 1/2 closes it
```

A sprint is never complete just because Dev Team said so mid-build. It's only
complete once QA1's static audit AND GroundTruth's live test have both
independently passed. `/sprint-complete` enforces this and will refuse to
close a sprint that's missing either one, telling you exactly which.

There used to be a second QA1 gate here, a "final check" run after
GroundTruth passed. Across ~13 real sprints it never once caught anything
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
/sprint-new "Title" [--epic "Epic name"]
/sprint-start <N>
/sprint-worktree <N>            # Dev Team 2 only, before building
/sprint-status [<N>]
/sprint-list
/sprint-qa1 <N> --verdict PASS|FAIL|CONDITIONAL --notes "..."
/sprint-dev-done <N>
/sprint-ship <N> --commit <hash>
/sprint-reship <N> --commit <hash>
/sprint-groundtruth <N> --verdict PASS|FAIL|CONDITIONAL --notes "..."
/sprint-complete <N>
/sprint-abort <N> --reason "..."
```

## Sprint data persistence

This template's own `.gitignore` keeps `docs/sprints/` content (sprint files
and `state/`) untracked, so the template repo doesn't ship its own example
sprint data. If you installed this workflow into a real project, that
ignore block gets inherited wholesale and left in place, which means your
project's *actual* sprint definitions and state history are never
committed anywhere, a wipe of the working tree (bad `clean`, disk failure,
anything) loses them for good with no git history to recover from. See the
`## Install` section of `README.md` for the one-time fix: delete the
sprint-data block from your project's `.gitignore` so it rides along with
your commits like everything else.

## Project standards

Add your own project-specific standards below this line (tech stack,
domain type locations, error handling conventions, git strategy, testing
requirements, security baseline). Every agent above should read this file
before starting work, so keep it current.

---
