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

**A release is never published without the user's explicit, real-time
authorization, no exceptions.** Same shape as the rule just above, and
just as unconditional: it governs any project running this framework, not
only this framework's own package, the same way `--user-said` above
governs any project's sprint close, not only this repo's. QA1's review
passing, or a diff simply being ready and waiting, tells you the release
is ready, it does not tell you the user has decided, right now, to
publish it, those are different facts and the second is never inferred
from the first. The rule was written after a structural cause specific to
this repository's own tooling sprints made the gap impossible to ignore —
`## Changes to this repo's own tooling` below defines this framework's
own live test as installing the newly published package, which means
every sprint that changed this repo's own tooling and reached its
live-test gate has been *forcing* a publish just to get verified, and
nobody ever actually chose that, thirteen releases went out in two days
without the user being asked once — but the rule itself is not scoped to
that cause, it applies to every publish, in every project this framework
runs in, regardless of what made it necessary to state. Pipeman publishes
only on the user's own word, said directly, in Pipeman's own session,
right now, never inferred from a handoff or a relay from any other role —
including Master Controller, even one accurately reporting every gate as
green. See `.claude/agents/pipeman.md` for how this applies to Pipeman's
own process, and `.claude/agents/master-controller.md` for why a version
bump is no longer routine bookkeeping in a sprint's own requirements.

## The team

| Role | Shorthand | Agent file | Model | Job |
|---|---|---|---|---|
| Master Controller | MC | `.claude/agents/master-controller.md` | opus | Plans sprints, checks status read-only |
| Dev Team 1 | Dev1 | `.claude/agents/dev-team-1.md` | sonnet | Starts, builds, tests, fixes, closes its own sprint |
| Dev Team 2 | Dev2 | `.claude/agents/dev-team-2.md` | sonnet | Runs a separate, independent sprint in parallel, in its own git worktree |
| QA1 | QA1 | `.claude/agents/qa1.md` | opus | Static code audit (the only gate) |
| Pipeman | PM | `.claude/agents/pipeman.md` | sonnet | Only one who pushes to remote |
| LiveQA | LQ | `.claude/agents/liveqa.md` | opus | Live verification of the released artifact after every push — a browser is the common case, not the definition |

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

**The role that runs a lifecycle command commits the bookkeeping that
command produced, before handing off** (sprint 27, Req 2 — extending a
rule sprint 18 first added to Master Controller alone, for sprint-file
amendments specifically, after five instances where it wasn't). `/sprint-start`
moves a file between phase folders and writes a state file; `/sprint-complete`
does the equivalent on the way out; every gate in between writes to
`docs/sprints/registry.json` and the sprint's own state file.
`sprint_lifecycle.py` never commits any of this itself, deliberately — the
script owns state, git belongs to a role, and that boundary stays intact
(see `## Changes to this repo's own tooling` for why this framework's own
copy of that script must never gain a `git commit`/`git add` call). That
means nothing else does either, unless the role sitting at the keyboard
does it. Every writing command now prints what it just wrote and that
it's uncommitted — a receipt, not a warning, printed once at the moment
it's true — precisely so this rule has something concrete to act on
instead of being trusted to remember on its own; prose alone has already
failed this exact way once (sprint 9's publish ordering, fixed in prose
and drifted on the very next release). Commit what the notice names
before telling the next role to act on it.

**The commit shape differs by what the command actually wrote** (sprint 32,
extending Req 2 above to QA1 and LiveQA, the two gate roles it hadn't yet
reached). A command that creates a new record has something untracked to
add before it can be committed: `/sprint-new` writes a brand-new sprint
file, `/sprint-start` writes a brand-new state file, so the role running
either stages what it just created — `git add <path>` for the new and
changed paths — before committing. QA1's `/sprint-qa1` and LiveQA's
`/sprint-liveqa` are different: each only ever modifies its sprint's own
already-tracked `docs/sprints/state/sprint-<N>.json`, nothing new to add,
so the commit is `git commit -m "..." docs/sprints/state/sprint-<N>.json`
with no `git add` step at all — `-m` is required here even though it's
easy to drop from an otherwise-minimal example: with no tty (every Bash
tool invocation), a message-less `git commit` aborts with "Aborting
commit due to empty commit message" and leaves the file uncommitted. That's deliberate, not a shortcut someone skipped:
a pathspec commit with no staging step can only ever capture the path
named, so it's structurally incapable of sweeping up a concurrent
session's unrelated uncommitted work the way a broader `git add -A` or
`git commit -a` could — a downstream install's Pipeman hit exactly that
with an unfiltered `git stash -u` swallowing another session's
in-progress file, which is why the no-staging shape is the correct one
for a role that must never touch anything but its own verdict. Both gate
roles are explicitly permitted to make this commit at all:
`SHIP_HASH_EXCLUDE_PATTERNS` in `scripts/sprint_lifecycle.py` excludes
`docs/sprints/.locks/*`, `docs/sprints/registry.json`,
`docs/sprints/state/*.json`, and `docs/sprints/*/*.md` from the
tree-hash comparison `/sprint-ship` and `/sprint-liveqa` themselves run —
exactly the paths a lifecycle command writes — so a gate role committing
its own bookkeeping cannot invalidate the audit or live test it just
recorded. And "Only Pipeman ever runs `git push`, no exceptions, ever"
(above) is narrower than it can read out of context: it reserves the
push, not the commit, and a local commit is explicitly sanctioned for
whichever role produced it, gate roles included.

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

**The worktree's life does not end at close** (sprint 34). Sprint 32 was
closed correctly from inside its own worktree — both gates verified, real
authorization obtained, `/sprint-complete` run — and came to rest on
`devteam2/sprint-32`, a branch no other checkout reads. Main, origin, and
every other worktree kept reporting it as still open; recovering it took a
real merge, by hand, after main had independently diverged with a
different sprint's own close in the meantime. The instruction above
described a one-way door: create the worktree, work in it, and said
nothing about the branch once the sprint is done. That gap is fixed here,
not by having Dev Team 2 push (it still never does, no exception), but by
naming the return path explicitly:

1. **Close, from inside the worktree, exactly as documented above** —
   `/sprint-complete <N> --user-said "..."`, same as any other sprint.
   `sprint_lifecycle.py` itself now checks whether the process it's
   running in is the primary checkout or a linked worktree, and if it's
   the latter, prints an unmissable statement, in the close's own output,
   that the record has not reached main — naming the branch and
   instructing the handoff below. This is a statement, not a gate: the
   close still succeeds, because a hard refusal here would leave Dev Team
   2 with no legal action at all (it cannot push its own way past it).
2. **Commit the bookkeeping** the close just wrote, same as every other
   lifecycle transition (see the commit-rule paragraph above) — this
   happens on `devteam2/sprint-<N>`, in the worktree, same as it always
   has.
3. **Hand off to Pipeman by name**, naming the branch (`devteam2/sprint-<N>`)
   and the commit just made (`git rev-parse HEAD`, run from the worktree,
   after committing). Pipeman merges that branch into main from the
   primary checkout — the only step here that touches git beyond a local
   commit, and it is Pipeman's, not Dev Team 2's, same as every push.
4. **Remove the worktree directory only after its branch has actually
   been merged into main**, and only once nothing is still using it as a
   working directory. `git worktree remove <path>` (run from the primary
   checkout) refuses on its own if the directory has uncommitted changes,
   but that is not the same guarantee as "merged" — an unmerged branch
   with a clean directory removes without complaint and takes its commits
   nowhere. Check the branch is actually reachable from main first
   (`git branch --merged main | grep devteam2/sprint-<N>`), and never
   remove a directory a session (this one or another) might still be
   `cd`'d into — Pipeman has correctly declined to act on exactly that
   shape of request before. An unmerged worktree, or one still in active
   use, is left in place; there is no time limit on when step 4 has to
   happen once steps 1–3 are done.

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
/sprint-repoint <N> --commit <hash>                                                             # Pipeman
/sprint-liveqa <N> --deployed-commit <sha> --verdict PASS|FAIL|CONDITIONAL --notes "..."        # LiveQA
/sprint-complete <N> --user-said "..."                                                          # Dev Team 1/2
/sprint-abort <N> --user-said "..." --reason "..."                                              # Dev Team 1/2
/sprint-block <N> --reason "..."                                                                # any role
/sprint-rename <N> --title "..."                                                                # Master Controller
```

`/sprint-abort` isn't attributed to a role anywhere else in this file (it's absent from the lifecycle diagram above); "Dev Team 1/2" here is inferred from the "Command ownership" note further up — lifecycle transition commands belong to whichever Dev Team owns the sprint, not Master Controller — not a direct quote like the other eleven labels are. Sprint 33 gave it a second required argument, `--user-said`, the same non-overridable shape as `/sprint-complete`'s own — abort is this lifecycle's most destructive action (it burns the sprint id and makes re-filing a human act) and used to require strictly less than closing a sprint does.

`/sprint-block` (sprint 33) is the non-destructive alternative abort was missing: a role that correctly determines a sprint isn't currently buildable (real content doesn't exist, a required decision is unmade) returns it to the planner instead of abandoning it. The sprint id is preserved, the file moves to `docs/sprints/4-blocked/` rather than `5-abandoned/`, and the role's own stated analysis is recorded in history for Master Controller to read and repair the file. No `--user-said` — blocking isn't destructive — but `--reason` is required and non-empty, same as abort's. Unlike every other command here, it has no single owning role: every headless profile's `Bash(python3 scripts/sprint_lifecycle.py *)` grant reaches every subcommand, so `cmd_abort` and `cmd_block` both derive the actor they log from `CLAUDE_CODE_AGENT` rather than a hardcoded string. Re-filing a blocked sprint is just `/sprint-start <N>` again, once the file's been repaired — `cmd_start` has no phase guard and always moves whatever the registry currently points at into `2-in-progress/`.

`/sprint-rename` (sprint 25) isn't a lifecycle-phase transition at all — it doesn't move a sprint between phases, it corrects a title that's stopped describing the sprint's current scope, the same kind of correction `/sprint-new` makes at creation. Master Controller here follows that same ownership, not the Dev Team pattern `/sprint-abort` uses. It updates the registry entry, the sprint file's own frontmatter, and the filename together, and preserves the original title. It never touches phase, verdicts, hashes, or history — but it does edit the sprint file itself, so renaming a sprint that already has a QA1 PASS on record will correctly require a fresh `/sprint-qa1` audit before `/sprint-dev-done` proceeds, the same as any other post-PASS edit to that file.

`/sprint-repoint` (sprint 28) recovers a `last_shipped_commit` orphaned by a rebase — the one gap this framework's own transition-precondition rule had left with no clearable path: `/sprint-reship` only works during the LiveQA live-test loop, and a rebase can orphan a shipped commit after a sprint is already complete, where reship has nothing to attach to and hand-editing `docs/sprints/state/` is forbidden. No phase restriction, deliberately, for that reason. It never touches `/sprint-ship`'s own tree-content comparison (still commit-hash based, protecting the same thing sprint 13 built it to protect) — it re-points `last_shipped_commit` only after confirming, via `git patch-id --stable`, that the new commit carries the exact same patch as the one on record, and refuses outright, no override, on anything else. Pipeman runs this; it's the role that meets the failure.

## Sprint data persistence

`docs/sprints/` content (sprint files, `state/`, `registry.json`) is
tracked by git like everything else in this repo, so it's committed and
recoverable the same way any other change is — there's no ignore block
excluding it and nothing to configure. The only sprint-related ignore
rule is `docs/sprints/.locks/`, transient OS file locks used to serialize
concurrent `sprint_lifecycle.py` invocations, never sprint data — leave
that line alone.

## Changes to this repo's own tooling

**"This repository" in this section means the `fully-completely`
framework's own upstream source repository — the one this framework
itself is built and released from — never a downstream project you have
installed `fully-completely` into.** Read from an installed copy of this
file, `scripts/`, `.claude/`, and `templates/` name directories that
exist in *your own project too*, because the install manifest puts them
there — but they are not what this section is about, and this section
does not license editing them. A downstream team nearly made exactly this
misreading, on day one, and stopped only because their own boundary held.
If you did not clone `fully-completely` itself to work on the framework —
if you ran `npx fully-completely` or an equivalent installer into your
own project — this whole section is not about you or your `scripts/`;
everything under `## The lifecycle` above is what applies to your
project's own sprints, in your own `scripts/`, `.claude/`, and
`templates/`.

Everything above `## The lifecycle` describes the lifecycle a
*downstream project* runs its own sprints through, after installing this
workflow. It does not describe how changes to *this framework's own
repository* (its own `scripts/`, `.claude/`, `templates/`, this file —
the copies inside `fully-completely`'s own source checkout, not inside
whatever project installed it) get made. Those are development on the
tool, not a sprint that runs through the tool's own state machine by
default, and that's a deliberate call, not an oversight:

- **QA1's gate still has a real referent here** (does a diff of
  `sprint_lifecycle.py` or an agent file actually do what it claims), so a
  real independent review before anything non-trivial merges is still
  expected, just not mechanized through `/sprint-qa1` and a sprint file
  for this repo's own commits.
- **LiveQA's gate applies here too, with a different surface, not a
  different rule.** `sprint_lifecycle.py`'s own `cmd_complete` refuses to
  close *any* sprint without a recorded LiveQA PASS, with no override —
  that includes a sprint about this framework's own tooling, exactly as
  much as one in a downstream project. What differs is what "live" means:
  LiveQA verifies the released artifact in a real environment, after
  distribution (see `liveqa.md`), and this framework's own released
  artifact is the published npm package, not a deployed web app. A sprint
  that changes `sprint_lifecycle.py` or an agent file is verified live by
  installing the newly published version into a real scratch project and
  confirming the change actually reached it — the install manifest (since
  0.1.6) is what makes that reachable at all, and it is exactly what this
  repository's own sprints (fourteen and counting) have actually been
  running as their live test, not a browser stand-in and not a skipped
  step.
- **Every change here should still be a real, committed diff before
  anyone reviews it**, for the same reason `qa1.md` tells QA1 to hold a
  verdict on uncommitted work: a review of a working-tree diff is a claim
  about code that might not exist by the time anyone acts on the review.
  This matters more here than usual, `/sprint-ship`'s commit-content check
  (see `## The lifecycle` above) depends on `git rev-parse HEAD` actually
  being the reviewed commit, not whatever was last pushed before the
  review started.
- **A sprint touching this repo's own tooling can now legitimately sit at
  `dev_agreed_done` awaiting release authorization, sometimes for a
  while, with its code already pushed to git but not yet published.** The
  bullet above makes this repo's own live test mean installing the newly
  published package; `## The lifecycle` above makes publishing itself
  require the user's own real-time word. Pipeman's own process
  (`pipeman.md`, step 8) asks for that authorization *before* recording
  `/sprint-ship`, deliberately, so nothing sits half-written while it
  waits — which means a sprint awaiting authorization is not parked at
  `liveqa_live` with a partial record, it simply hasn't reached
  `/sprint-ship` yet, and the phase stays exactly where `/sprint-dev-done`
  left it. Put together, the live test literally cannot start until the
  user says to publish, so a sprint sitting at `dev_agreed_done` with its
  commit already on the remote is the correct resting state here, not a
  stall. Say so if you're the one who finds it: the right move is asking
  the user whether to publish now, never pushing a publish through on
  someone else's word to unstick what looks like a stuck sprint, and
  never reading "already pushed, still at `dev_agreed_done`" as evidence
  that `/sprint-ship` was forgotten — check whether it's this wait before
  assuming that.

If a change to this framework's own tooling ever turns out to need
something sprint-shaped (recorded requirements, a documented audit trail
across multiple rounds), that's a case for `/sprint-new` — LiveQA's gate
applies exactly as it does everywhere else, redefined per `liveqa.md` to
mean a real install of the newly published package, never skipped.

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
