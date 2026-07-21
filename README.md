# Fully Completely

[![Scan and smoke test](https://github.com/chrishobbsrocks/fully-completely/actions/workflows/scan.yml/badge.svg)](https://github.com/chrishobbsrocks/fully-completely/actions/workflows/scan.yml)

Your six-role sprint workflow (Master Controller, Dev Team 1, Dev Team 2,
QA1, Pipeman, GroundTruth), with the enforcement mechanics borrowed from
Maestro: a state file per sprint, slash commands as the only way to move
things forward, and a script that refuses to skip steps.

The key difference from a simple "ask the agent nicely" workflow: closing
a sprint is not optional-honesty, `/sprint-complete` will not run unless
QA1's audit, GroundTruth's live test, and QA1's final check have all actually
been recorded as PASS. Try to close early and it tells you exactly what's
missing.

## What's here

```
CLAUDE.md                     Root instructions (read this first)
.claude/agents/                Six agent personas (Master Controller, Dev
                                Team 1/2, QA1, Pipeman, GroundTruth)
.claude/commands/               Slash commands, thin wrappers around the
                                script below
scripts/sprint_lifecycle.py    The actual enforcement logic
templates/sprint-template.md   Template used by /sprint-new
docs/sprints/                  Where sprint files and state live
  0-backlog/  1-todo/  2-in-progress/  3-done/  4-blocked/  5-abandoned/
  state/                       One JSON file per sprint tracking phase +
                                gate results (don't edit by hand)
  registry.json                Index of every sprint (created on first
                                /sprint-new, don't edit by hand)
```

## Install

1. Copy this whole folder into your project (or copy just `.claude/`,
   `scripts/`, `templates/`, `docs/sprints/`, and `CLAUDE.md` into an
   existing project root).
2. Requires only Python 3, no dependencies to install.
3. If you're not using Claude Code's native sub-agent feature, you can
   still use this by hand: open a terminal tab per role, start a session
   with the model noted in `CLAUDE.md`, and paste the matching file from
   `.claude/agents/` as your first message.

## Using it

```bash
# Master Controller kicks off a sprint
python3 scripts/sprint_lifecycle.py new "User auth with OAuth" --epic "Accounts"
# → fill in Requirements / Acceptance Criteria / Out of Scope in the
#   generated file, then:
python3 scripts/sprint_lifecycle.py start 1

# Dev Team builds, then hands off
python3 scripts/sprint_lifecycle.py qa1 1 --verdict PASS --notes "clean"
python3 scripts/sprint_lifecycle.py dev-done 1

# Pipeman ships
python3 scripts/sprint_lifecycle.py ship 1 --commit abc123

# GroundTruth tests the live deploy
python3 scripts/sprint_lifecycle.py groundtruth 1 --verdict PASS --notes "3/3 clean runs"

# QA1's final check, then Master Controller closes it
python3 scripts/sprint_lifecycle.py qa1-final 1 --verdict PASS --notes "all good"
python3 scripts/sprint_lifecycle.py complete 1
```

If you're running inside Claude Code, use the slash-command form instead
of calling the script directly, e.g. `/sprint-qa1 1 --verdict PASS --notes
"clean"`, the commands in `.claude/commands/` call the same script.

Check where anything stands at any point:

```bash
python3 scripts/sprint_lifecycle.py status 1 --verbose   # one sprint, full history
python3 scripts/sprint_lifecycle.py list                 # every sprint
```

## The two QA gates, and why they're separate

QA1 runs twice on purpose: once as a static code audit before anything
ships (gate 1), and once again after GroundTruth has proven the live product
actually works (gate 2). A clean diff and a working live product are
different claims, this system won't let either one stand in for the
other. If GroundTruth's live test fails, the fix loop is Dev Team fixes →
Pipeman `/sprint-reship` → GroundTruth retests, without needing to redo the
whole sprint. If QA1's *final* check fails, that's treated as serious
enough to send the sprint all the way back to `dev_build`, both gates get
re-earned from scratch.

## Security notes

This was scanned with bandit and pyflakes (both clean) before being made
public, plus a manual check for the failure mode that actually matters
for a tool built around slash commands: a slash command works by having
Claude substitute free text into a bash command string and run it. If
that free text (a sprint title, QA notes, an abort reason) contains a
`"` or `;` or a backtick, it can break out of the intended argument and
run something else entirely, this was verified, not theoretical.

All of this now runs automatically on every push and pull request via
`.github/workflows/scan.yml`: bandit, pyflakes, and
`scripts/smoke_test.sh`, a full lifecycle run including both fail-loops,
the two-gate close refusal, and a regression check that the exact
injection payload above stays inert. It runs on Python 3.9 and 3.12
both, so a future change that reintroduces a 3.10-only type hint gets
caught too.

The fix: every command that takes free text supports a `--*-file`
variant (`--title-file`, `--epic-file`, `--notes-file`,
`--reason-file`). The corresponding `.claude/commands/*.md` files
instruct Claude to write the free text to a temp file with the Write
tool first, then reference that file in the command, so untrusted text
never gets interpolated into a shell string. `sprint-start`,
`sprint-status`, `sprint-dev-done`, `sprint-ship`, `sprint-reship`,
`sprint-complete`, and `sprint-list` only take a sprint ID, verdict
keyword, or commit hash, low-entropy values you'd type yourself, so
they were left as direct arguments.

Also fixed:
- Sprint state and registry files are now written atomically (temp
  file + rename), so an interrupted write can't corrupt them.
- A stray `Path | None` type hint (Python 3.10+ only syntax) was
  replaced with `Optional[Path]`, the script now runs on Python 3.8+.
- Titles and epic names are escaped before being written into a
  sprint file's YAML frontmatter, a stray `"` in a title no longer
  breaks the file.

If you extend this with new commands that take free text, follow the
same `--*-file` pattern rather than embedding raw arguments in a bash
string.

## Customizing

- Add your own coding standards, git strategy, and tech stack notes to
  the bottom of `CLAUDE.md`, every agent should read it before starting.
- Dev Team 2 runs a second, independent sprint at the same time as Dev
  Team 1, not half of the same sprint. Only hand it a sprint that doesn't
  share files, types, or dependencies with whatever Dev Team 1 is on.
- The phase names and transitions live entirely in
  `scripts/sprint_lifecycle.py`, if your real process ever changes, that's
  the one file to edit.
