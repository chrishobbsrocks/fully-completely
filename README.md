# Fully Completely

[![Scan and smoke test](https://github.com/chrishobbsrocks/fully-completely/actions/workflows/scan.yml/badge.svg)](https://github.com/chrishobbsrocks/fully-completely/actions/workflows/scan.yml)

Your six-role sprint workflow (Master Controller, Dev Team 1, Dev Team 2,
QA1, Pipeman, LiveQA), with enforcement mechanics built to make it
stick: a state file per sprint, slash commands as the only way to move
things forward, and a script that refuses to skip steps.

The key difference from a simple "ask the agent nicely" workflow: closing
a sprint is not optional-honesty, `/sprint-complete` will not run unless
QA1's audit and LiveQA's live test have both actually been recorded
as PASS, **and** the user has explicitly authorized closing it right now
(`--user-said "..."`, required, non-empty — both gates passing tells you
the code is ready, not that the user has decided to close it). Try to
close early, or without that authorization, and it tells you exactly
what's missing.

## What's here

```
CLAUDE.md                     Root instructions (read this first)
.claude/agents/                Six agent personas (Master Controller, Dev
                                Team 1/2, QA1, Pipeman, LiveQA)
.claude/commands/               Slash commands, thin wrappers around the
                                script below
scripts/sprint_lifecycle.py    The actual enforcement logic
scripts/run-lifecycle.js       What .claude/commands/ actually run — finds
                                a real Python 3 (python3/python/py) and
                                hands off to sprint_lifecycle.py above
scripts/dev2_worktree.sh       Creates Dev Team 2's isolated git worktree
scripts/smoke_test.sh          Full lifecycle test, runs in a sandbox
scripts/worktree_test.sh       Tests dev2_worktree.sh, also sandboxed
scripts/launcher_test.js       Tests the launcher's JSONC parser, task
                                generation, and install.js's taxonomy +
                                merge logic
scripts/launcher/               VS Code launcher: run-role.js, generate-tasks.js
scripts/install.js             Installs/upgrades this framework into
                                another project — see "Install" below
scripts/verify-tarball.sh      Installs from a real `npm pack` tarball
                                into a throwaway project before a release
                                ships
.vscode/tasks.json             Generated — one task per role, plus Shell
                                (don't hand-edit)
.vscode/settings.json          fullyCompletely.autoLaunch toggle (off by default)
templates/sprint-template.md   Template used by /sprint-new
docs/sprints/                  Where sprint files and state live
  0-backlog/  1-todo/  2-in-progress/  3-done/  4-blocked/  5-abandoned/
  state/                       One JSON file per sprint tracking phase +
                                gate results (don't edit by hand)
  registry.json                Index of every sprint (created on first
                                /sprint-new, don't edit by hand)
```

## Install

1. Copy this whole folder into your project, or run
   `node /path/to/fully-completely/scripts/install.js` from inside your
   project (see [`scripts/install.js`](#launching-the-agents) below) —
   re-running it later cleanly upgrades the framework files it owns
   (backing up what was there first) while never touching files you're
   meant to customise, reporting anything it skipped either way.
2. Requires Python 3 and Node.js, no packages to install for either.
   Runs on macOS, Linux, and Windows. `install.js` checks for a usable
   Python 3 interpreter (`python3`, then `python`, then `py`) and warns
   plainly if none is found — it doesn't block the rest of the install,
   but no `/sprint-*` command will run without one. Verify yours with
   whichever of those three prints a `Python 3.x.y` line. A python.org
   install on Windows registers `python`/`py`, never `python3` — every
   `/sprint-*` command already accounts for that by running
   `scripts/run-lifecycle.js` instead of hardcoding an interpreter name.
   The shell scripts (`smoke_test.sh`, `worktree_test.sh`,
   `dev2_worktree.sh`) need a POSIX-style shell, which Windows users
   typically already have via Git Bash or WSL; they aren't required to
   use `sprint_lifecycle.py` itself.
3. **Log in to Claude once before first running the launcher.** Open a
   normal terminal, run `claude`, complete login, then exit. The launcher's
   preflight check blocks with a clear message when Claude reports no
   usable credentials — a genuine logout or a broken config directory both
   land here, since either way no role could authenticate — instead of
   leaving terminals stuck at a login prompt. It otherwise proceeds (a
   probe it can't get a confident answer from at all, e.g. an older CLI,
   is never treated as "no usable credentials").
4. See "Launching the agents" below for both the VS Code launcher and the
   fully manual fallback (open a terminal tab per role yourself).

## Launching the agents

Each role runs as its own genuinely separate Claude Code session — never
one session sub-agenting another, that's forbidden absolutely (see
`CLAUDE.md`). The six sessions are `claude --agent <id>`, where `<id>` is
the agent's filename in `.claude/agents/` (`master-controller`,
`dev-team-1`, `dev-team-2`, `qa1`, `pipeman`, `liveqa`). `--agent` alone is
enough — the agent file's own `model:` frontmatter wins even over an
explicit `--model` on the same command line (verified on the CLI this was
built against), so frontmatter stays the single place a model is ever set.
Nothing in this launcher passes `--model`.

**By hand:** open a terminal tab per role, `cd` into the project root, run
`claude --agent <id>`, and you're running that role.

**VS Code launcher:** `.vscode/tasks.json` (generated, see below) gives
each role a task named exactly after it — `Master Controller`, `Dev Team
1`, `Dev Team 2`, `QA1`, `Pipeman`, `LiveQA` — since a task's label is also
its terminal's tab name. Every one of those is "smart": it resumes a prior
session automatically if one exists for that role in this repo, or
launches fresh with a short first message confirming the role and telling
it to check `docs/sprints/registry.json` and wait for instructions. There's
no local record file involved — each role's session ID is a UUID derived
deterministically from (role, repo path, generation), a generation being a
zero-based counter that only advances on `--restart` (see below), so it
can always be recomputed rather than remembered. "Does a prior session
exist" is answered by checking, for each generation in turn, whether
`~/.claude/projects/<encoded repo path>/<uuid>.jsonl` exists on disk — the
highest generation found is the one resumed — not by trusting anything the
launcher wrote down earlier. There's also **Shell**, a plain login shell
with no `claude` in it at all (your own
`$SHELL` on macOS/Linux, PowerShell on Windows) — for
`docs/HUMAN_OVERRIDE.md`'s override command (which must never be run from
inside an agent session, see that file) and any raw git you want to do
outside of Pipeman's session.

**FC: Start All** — Command Palette → "Tasks: Run Task" → `FC: Start All`
(or `Cmd/Ctrl+Shift+B` if it's your default build task) opens all seven
terminals in the project root using the smart per-role behavior above.
Observed as safe to run again later in the same window (VS Code left each
role's still-running dedicated terminal alone rather than restarting or
duplicating it, so re-running this just filled in whichever of the seven
weren't already open) — from one real test, not something that's been
exercised across VS Code versions or checked any other way.

There's deliberately no separate "restart" task: VS Code ties a dedicated
terminal's identity to the task's label, so a second task for the same
role opens a second terminal alongside the first instead of replacing it
(this actually happened — six roles briefly had two terminals apiece
before this got caught). If you want to abandon a role's session and
start clean rather than continue it, run this by hand instead, e.g. from
**Shell**:

```bash
node scripts/launcher/run-role.js qa1 --restart
```

That starts a brand-new named session for that role right there in
whatever terminal you ran it from (previous history isn't deleted, just
not reconnected to). It becomes the current session for that role purely
because it's now the newest one on disk — the next time you run that
role's own task, the resume check finds it as the latest and reconnects to
it. Close the role's stale existing terminal tab yourself once you're done
with it.

Dev Team 2 is the one role whose working directory can legitimately move
mid-sprint (into a separate git worktree, see "Customizing" below) — the
launcher itself never scans for or manages that worktree, it always
reopens Dev Team 2 in the project root and adds one extra line to its
resume message telling it to check the sprint registry and `cd` back into
an active worktree itself if one exists.

Each task's terminal gets the color from that agent's `color:` frontmatter
(VS Code only supports the ANSI terminal palette for this, so Dev Team 2's
orange and LiveQA's purple are the closest available shades, not exact).
Colors and the auto-launch setting below are baked into `tasks.json` at
generation time, not read live — after changing an agent's `color:` or
`.vscode/settings.json`'s `fullyCompletely.autoLaunch`, regenerate it:

```bash
node scripts/launcher/generate-tasks.js
```

**Auto-launch:** `.vscode/settings.json` → `"fullyCompletely.autoLaunch"`,
`false` by default. Set it to `true` and regenerate `tasks.json` to have
`FC: Start All` run automatically whenever this folder opens in VS Code
(VS Code will still ask you to trust automatic tasks the first time, that
prompt is native and this doesn't try to bypass it).

**Errors:** if `claude` isn't on PATH, or an agent's `.claude/agents/*.md`
file is missing, the corresponding terminal prints one line explaining
which and exits, rather than silently doing nothing.

**`scripts/install.js`** copies `.claude/`, `scripts/` (including the
launcher), `templates/`, `docs/sprints/`, `docs/HUMAN_OVERRIDE.md`, and
`CLAUDE.md` into an existing project, run from inside it — and, from
sprint 2 on, upgrades cleanly on every later re-run instead of just
flagging drift:

```bash
node /path/to/fully-completely/scripts/install.js
```

Every path it touches falls into exactly one of three categories:

- **Framework-owned** (`.claude/commands/`, every `scripts/` file
  including `scripts/launcher/**` and `install.js` itself, `templates/`,
  `docs/HUMAN_OVERRIDE.md`) — files this project ships and maintains, that
  you're never expected to hand-edit. On an upgrade these are **overwritten
  when they've changed**, with the previous version backed up first
  (`<name>.bak-<version you had installed>`), and any file that's no
  longer part of the framework at all (`state.js`, deleted in sprint 1, is
  the file that motivated this) is backed up and removed the same way.
- **User-owned** (`.claude/agents/`, `CLAUDE.md`, `docs/sprints/` — this
  project's own sprint data once installed) — designed to be customised,
  or simply not this tool's to touch. These are **never** overwritten; a
  file that differs from upstream is reported as a conflict for you to
  reconcile by hand, same as before.
- **Merged** — `.vscode/tasks.json`, `.vscode/settings.json`, and
  `.gitignore` get a real merge (your own unrelated tasks/settings/ignore
  rules are left alone; only this framework's own entries are added, and a
  couple of specific dead `.gitignore` lines from old releases are removed
  if present in exactly that form).

A small marker at `.claude/fully-completely-version` (not sprint state,
never under `docs/sprints/`) records which release is installed, so a
re-run can tell a first install from an upgrade, name backups after the
version being replaced, and report `Installed X (first install)` /
`Upgraded X -> Y` / `Already at X`. This is also the shape
`npx fully-completely` runs — before any release ships, `npm pack` is
verified for real via `scripts/verify-tarball.sh`, which installs from the
actual packed tarball into a throwaway project and confirms the result
matches source. `scripts/launcher_test.js` covers the taxonomy (overwrite
+ backup, removal, user-owned protection, a missing version marker
degrading to upgrade rather than crashing) alongside the merge logic
(comments present, colliding task labels, CRLF vs LF), the JSONC parser,
and generated task shapes, and runs in CI alongside `smoke_test.sh` and
`worktree_test.sh`.

## Using it

```bash
# Master Controller kicks off a sprint
node scripts/run-lifecycle.js new "User auth with OAuth" --epic "Accounts"
# → fill in Requirements / Acceptance Criteria / Out of Scope in the
#   generated file, then:
node scripts/run-lifecycle.js start 1

# Dev Team builds, then hands off
node scripts/run-lifecycle.js qa1 1 --verdict PASS --notes "clean"
node scripts/run-lifecycle.js dev-done 1

# Pipeman ships
node scripts/run-lifecycle.js ship 1 --commit abc123

# LiveQA tests the live deploy — --deployed-commit must match what was
# actually shipped, an exact SHA check, not free text
node scripts/run-lifecycle.js liveqa 1 --deployed-commit abc123 --verdict PASS --notes "3/3 clean runs"

# Dev Team closes it out (same session that ran `start`, not Master Controller),
# only once the user has actually said to close it, not just because both gates are green
node scripts/run-lifecycle.js complete 1 --user-said "close it"
```

If you're running inside Claude Code, use the slash-command form instead
of calling the script directly, e.g. `/sprint-qa1 1 --verdict PASS --notes
"clean"`, the commands in `.claude/commands/` run the same
`sprint_lifecycle.py`, through `scripts/run-lifecycle.js` (see above).

Check where anything stands at any point:

```bash
node scripts/run-lifecycle.js status 1 --verbose   # one sprint, full history
node scripts/run-lifecycle.js list                 # every sprint
```

## The two gates a sprint has to clear

A sprint only closes once two independent claims have both been verified:
QA1's static audit (does the diff actually match the requirements) and
LiveQA's live test (does the deployed product actually work). A clean
diff and a working live product are different claims, `/sprint-complete`
won't let either one stand in for the other, and refuses to close a sprint
missing either. If LiveQA's live test fails, the fix loop is Dev Team
fixes → Pipeman `/sprint-reship` → LiveQA retests, without needing to
redo the whole sprint.

Passing both gates is still not enough on its own: `/sprint-complete` also
requires `--user-said "..."`, quoting what the user actually said, in that
session, authorizing the close right now. Gate status answers "is the code
ready," not "did the user decide to ship it," and the two aren't allowed to
get conflated — Dev Team tells the user a sprint is ready and waits for
them to actually say so, rather than closing automatically the moment both
gates go green.

Earlier versions of this template ran QA1 twice, a static audit before
shipping and a second "final check" after LiveQA passed. Across ~13
real sprints that second check never once caught anything the first audit
and the live test hadn't already caught, so it was cut, LiveQA's PASS
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
of what actually got pushed. `/sprint-liveqa` requires
`--deployed-commit`, the SHA LiveQA actually tested, and refuses if
it doesn't match — an exact identity check this time, not a content
check, since there's no legitimate rebase step between shipping and
testing live the way there is between auditing and shipping. Nothing
here has an override: a mismatch always means the live test ran against
something other than what was actually deployed, closing the gap where a
verdict could otherwise get recorded against any deployment, correct or
not. `/sprint-status` also flags a sprint whose most recent ship or
reship landed after its last recorded LiveQA verdict, so a
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

**"QA1 / LiveQA wrote a full verdict report but the state file is
still empty."** Writing the report is not the same as recording it, the
verdict only exists once `/sprint-qa1` or `/sprint-liveqa` actually
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
