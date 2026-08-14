# Fully Completely

[![Scan and smoke test](https://github.com/chrishobbsrocks/fully-completely/actions/workflows/scan.yml/badge.svg)](https://github.com/chrishobbsrocks/fully-completely/actions/workflows/scan.yml)

Your six-role sprint workflow (Master Controller, Dev Team 1, Dev Team 2,
QA1, Pipeman, GroundTruth), with enforcement mechanics built to make it
stick: a state file per sprint, slash commands as the only way to move
things forward, and a script that refuses to skip steps.

The key difference from a simple "ask the agent nicely" workflow: closing
a sprint is not optional-honesty, `/sprint-complete` will not run unless
QA1's audit and GroundTruth's live test have both actually been recorded
as PASS, **and** the user has explicitly authorized closing it right now
(`--user-said "..."`, required, non-empty — both gates passing tells you
the code is ready, not that the user has decided to close it). Try to
close early, or without that authorization, and it tells you exactly
what's missing.

## What's here

```
CLAUDE.md                     Root instructions (read this first)
.claude/agents/                Six agent personas (Master Controller, Dev
                                Team 1/2, QA1, Pipeman, GroundTruth)
.claude/commands/               Slash commands, thin wrappers around the
                                script below
scripts/sprint_lifecycle.py    The actual enforcement logic
scripts/dev2_worktree.sh       Creates Dev Team 2's isolated git worktree
scripts/smoke_test.sh          Full lifecycle test, runs in a sandbox
scripts/worktree_test.sh       Tests dev2_worktree.sh, also sandboxed
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
2. Requires only Python 3, no dependencies to install. Runs on macOS, Linux, and Windows. The shell scripts (`smoke_test.sh`, `worktree_test.sh`, `dev2_worktree.sh`) need a POSIX-style shell, which Windows users typically already have via Git Bash or WSL; they aren't required to use `sprint_lifecycle.py` itself.
3. If you're not using Claude Code's native sub-agent feature, you can
   still use this by hand: open a terminal tab per role, start a session
   with the model noted in `CLAUDE.md`, and paste the matching file from
   `.claude/agents/` as your first message.
4. **Open `.gitignore` and delete the block marked `TEMPLATE-ONLY`.** It
   keeps this template repo from shipping its own example sprint data, but
   left in place in your project it means every real sprint you create and
   all QA/GroundTruth gate history in `docs/sprints/state/` is untracked,
   so a wiped working tree loses it for good with nothing to recover from
   git. `docs/sprints/registry.json` is already tracked by default and
   needs no change.

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

# GroundTruth tests the live deploy — --deployed-commit must match what was
# actually shipped, an exact SHA check, not free text
python3 scripts/sprint_lifecycle.py groundtruth 1 --deployed-commit abc123 --verdict PASS --notes "3/3 clean runs"

# Dev Team closes it out (same session that ran `start`, not Master Controller),
# only once the user has actually said to close it, not just because both gates are green
python3 scripts/sprint_lifecycle.py complete 1 --user-said "close it"
```

If you're running inside Claude Code, use the slash-command form instead
of calling the script directly, e.g. `/sprint-qa1 1 --verdict PASS --notes
"clean"`, the commands in `.claude/commands/` call the same script.

Check where anything stands at any point:

```bash
python3 scripts/sprint_lifecycle.py status 1 --verbose   # one sprint, full history
python3 scripts/sprint_lifecycle.py list                 # every sprint
```

## The two gates a sprint has to clear

A sprint only closes once two independent claims have both been verified:
QA1's static audit (does the diff actually match the requirements) and
GroundTruth's live test (does the deployed product actually work). A clean
diff and a working live product are different claims, `/sprint-complete`
won't let either one stand in for the other, and refuses to close a sprint
missing either. If GroundTruth's live test fails, the fix loop is Dev Team
fixes → Pipeman `/sprint-reship` → GroundTruth retests, without needing to
redo the whole sprint.

Passing both gates is still not enough on its own: `/sprint-complete` also
requires `--user-said "..."`, quoting what the user actually said, in that
session, authorizing the close right now. Gate status answers "is the code
ready," not "did the user decide to ship it," and the two aren't allowed to
get conflated — Dev Team tells the user a sprint is ready and waits for
them to actually say so, rather than closing automatically the moment both
gates go green.

Earlier versions of this template ran QA1 twice, a static audit before
shipping and a second "final check" after GroundTruth passed. Across ~13
real sprints that second check never once caught anything the first audit
and the live test hadn't already caught, so it was cut, GroundTruth's PASS
now sends the sprint straight to complete-ready. The one thing the second
check occasionally caught, a sprint file amended mid-build after QA1's
first read, is now covered two ways: QA1 re-reads the sprint file fresh
before recording its (single) verdict rather than relying on whatever it
read earlier in a long session (see `.claude/agents/qa1.md`), and
`/sprint-dev-done` mechanically enforces the same thing, a QA1 PASS
records a hash of the sprint file, and dev-done refuses, no override, if
the file changed after that audit. Deliberately no escape hatch: an
override just relocates the judgment call from "did I re-read" to "was
this change worth re-checking," which is exactly as skippable under
deadline pressure as the thing it replaced. If a re-audit of a trivial
one-line change feels too slow to be worth doing, that's a signal to make
re-audits faster, not to add a bypass.

The same PASS also records the audited commit's tree hash, the content
of its files, not its SHA. `/sprint-ship` refuses, no override, if the
commit Pipeman is pushing doesn't match it. Tree hash rather than commit
SHA is deliberate: Pipeman's own process legitimately squashes or
rebases before pushing, which changes the SHA without changing any file,
and that has to keep working, only a real, unaudited content change
should block a ship.

`/sprint-ship` (and `/sprint-reship`) also record the resolved full SHA
of what actually got pushed. `/sprint-groundtruth` requires
`--deployed-commit`, the SHA GroundTruth actually tested, and refuses if
it doesn't match — an exact identity check this time, not a content
check, since there's no legitimate rebase step between shipping and
testing live the way there is between auditing and shipping. Nothing
here has an override: a mismatch always means the live test ran against
something other than what was actually deployed, closing the gap where a
verdict could otherwise get recorded against any deployment, correct or
not. `/sprint-status` also flags a sprint whose most recent ship or
reship landed after its last recorded GroundTruth verdict, so a
not-yet-re-tested sprint doesn't require reconstructing that from raw
timestamps by hand.

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
the close refusal (both gates, and the user-authorization requirement),
and a regression check that the exact injection payload above stays
inert. It runs on Python 3.9 and 3.12
both, so a future change that reintroduces a 3.10-only type hint gets
caught too.

The fix: every command that takes free text supports a `--*-file`
variant (`--title-file`, `--epic-file`, `--notes-file`,
`--reason-file`, `--user-said-file`). The corresponding
`.claude/commands/*.md` files instruct Claude to write the free text to
a temp file with the Write tool first, then reference that file in the
command, so untrusted text never gets interpolated into a shell string.
`sprint-start`, `sprint-status`, `sprint-dev-done`, `sprint-ship`,
`sprint-reship`, and `sprint-list` only take a sprint ID, verdict
keyword, or commit hash, low-entropy values you'd type yourself, so
they were left as direct arguments. `sprint-complete` looks similar at
a glance but isn't: `--user-said` is free text (it quotes what the user
actually said), so it gets the same `--user-said-file` treatment as
`--reason` and `--notes`, not the low-entropy treatment.

Also fixed:
- Sprint state and registry files are now written atomically (temp
  file + rename), so an interrupted write can't corrupt them.
- A stray `Path | None` type hint (Python 3.10+ only syntax) was
  replaced with `Optional[Path]`, the script now runs on Python 3.8+.
- Titles and epic names are escaped before being written into a
  sprint file's YAML frontmatter, a stray `"` in a title no longer
  breaks the file.
- Every read-modify-write span (a sprint's state, the registry's
  `next_id` counter) now holds an OS file lock for its duration, so two
  invocations racing against the same sprint can't interleave and
  silently lose one side's update, exercised by a smoke test that runs
  two `qa1` verdicts concurrently and asserts both landed. This uses
  `fcntl` on macOS/Linux and falls back to `msvcrt` on Windows (stdlib
  both ways, no new dependency), a first version imported `fcntl`
  unconditionally, which would have broken every command on Windows,
  not just locking.
- `/sprint-new`'s template substitution no longer uses `str.format()`,
  which would raise on a custom template containing literal `{ }` (a
  JSON or CSS example block); it now does targeted `{id}`/`{epic}`
  replacement instead, leaving any other braces alone.
- `smoke_test.sh` itself used to `rm -rf` `docs/sprints/` directly
  against whatever repo it was invoked from, both on start and via a
  `trap ... EXIT`. It has actually destroyed a real downstream
  project's sprint history twice. It now copies the script into a
  throwaway `mktemp -d` sandbox and runs that copy, verified by
  planting a canary sprint in this repo and hash-diffing it before and
  after a full test run.

If you extend this with new commands that take free text, follow the
same `--*-file` pattern rather than embedding raw arguments in a bash
string.

## Troubleshooting

**"The output looks plausible but the numbers/state are wrong."** Every
`sprint_lifecycle.py` invocation prints `[sprint_lifecycle] repo=...
script=...` to stderr. Confirm `script=` points at *this* repo's
`scripts/sprint_lifecycle.py` before trusting anything it printed. This
has actually happened twice on a downstream project: once by shelling out
to a different, same-named script, and once because a slash command
resolved to a stale global command definition instead of this repo's
`.claude/commands/`. Both times the output looked plausible enough to
almost act on.

**"QA1 / GroundTruth wrote a full verdict report but the state file is
still empty."** Writing the report is not the same as recording it, the
verdict only exists once `/sprint-qa1` or `/sprint-groundtruth` actually
runs. Both agents' instructions end with an explicit step to re-run
`/sprint-status` and confirm the verdict shows up before considering the
work done, if you're seeing this, that step got skipped.

## Customizing

- Add your own coding standards, git strategy, and tech stack notes to
  the bottom of `CLAUDE.md`, every agent should read it before starting.
- Dev Team 2 runs a second, independent sprint at the same time as Dev
  Team 1, not half of the same sprint, and always in its own git worktree
  (`/sprint-worktree <N>`, see `CLAUDE.md`), not the same checkout Dev Team
  1 is using. "Independent" sprints on a small app still routinely touch
  the same shared files (routing, layout, config) even when their features
  don't overlap, checking the Dependencies section alone isn't enough.
- `/sprint-start` and `/sprint-complete` are run directly by whichever Dev
  Team owns the sprint. Master Controller plans and reads status, it
  doesn't issue lifecycle commands once a sprint is handed off.
- The phase names and transitions live entirely in
  `scripts/sprint_lifecycle.py`, if your real process ever changes, that's
  the one file to edit.
