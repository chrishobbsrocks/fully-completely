# Fully Completely — Global Instructions

This project uses a sprint workflow enforced by `scripts/sprint_lifecycle.py`.
Slash commands in `.claude/commands/` are the only supported way to move a
sprint forward. Never edit `docs/sprints/registry.json` or anything in
`docs/sprints/state/` by hand, and never move sprint files between folders
yourself, the script owns that.

## The team

| Role | Agent file | Model | Job |
|---|---|---|---|
| Master Controller | `.claude/agents/master-controller.md` | opus | Plans sprints, closes them once both gates pass |
| Dev Team 1 | `.claude/agents/dev-team-1.md` | sonnet | Builds, tests, fixes |
| Dev Team 2 | `.claude/agents/dev-team-2.md` | sonnet | Builds in parallel, tests, fixes |
| QA1 | `.claude/agents/qa1.md` | opus | Static code audit (gate 1) AND final check (gate 2) |
| Pipeman | `.claude/agents/pipeman.md` | sonnet | Only one who pushes to remote |
| QA-Auto | `.claude/agents/qa-auto.md` | opus | Live browser testing after every push |

Run each role as its own Claude Code session (a separate terminal tab is the
simplest setup), pasting the relevant agent file as the system prompt, or
invoke them as native Claude Code sub-agents via the Task tool if you'd
rather not manage tabs manually. Start each session with the model listed
above, e.g. `claude --model opus` for Master Controller, QA1, or QA-Auto.

## The lifecycle

```
/sprint-new "Title" --epic "Epic name"      Master Controller
        │  (fills in requirements/acceptance criteria in the file)
/sprint-start <N>                            Master Controller
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
   qa_auto_live ──────────────────────────── QA-Auto tests live
        │
/sprint-qa-auto <N> --verdict ...            QA-Auto
        │  FAIL/CONDITIONAL → Dev Team fixes, Pipeman /sprint-reship, loop
        │  PASS ↓
/sprint-qa1-final <N> --verdict ...          QA1 (gate 2)
        │  FAIL → back to dev_build, both gates must be re-earned
        │  PASS ↓
/sprint-complete <N>                         Master Controller closes it
```

A sprint is never complete just because Dev Team said so. It's only complete
once QA1's first audit, QA-Auto's live test, AND QA1's final check have all
independently passed. `/sprint-complete` enforces this and will refuse to
close a sprint that's missing any of the three, telling you exactly which
one.

## Quick reference

```bash
/sprint-new "Title" [--epic "Epic name"]
/sprint-start <N>
/sprint-status [<N>]
/sprint-list
/sprint-qa1 <N> --verdict PASS|FAIL|CONDITIONAL --notes "..."
/sprint-dev-done <N>
/sprint-ship <N> --commit <hash>
/sprint-reship <N> --commit <hash>
/sprint-qa-auto <N> --verdict PASS|FAIL|CONDITIONAL --notes "..."
/sprint-qa1-final <N> --verdict PASS|FAIL --notes "..."
/sprint-complete <N>
/sprint-abort <N> --reason "..."
```

## Project standards

Add your own project-specific standards below this line (tech stack,
domain type locations, error handling conventions, git strategy, testing
requirements, security baseline). Every agent above should read this file
before starting work, so keep it current.

---
