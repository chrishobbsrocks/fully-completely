# Changelog

Every version of `fully-completely` published to npm, newest first, with
what it actually shipped — sourced from this repository's own closed
sprints and commit history, not reconstructed from memory. Corrections of
an earlier release's defect are labeled **Corrects** rather than presented
as ordinary features; this project's own record would be less honest than
its process if they weren't.

`0.1.25` and `0.1.26` were never published: `0.1.25` (sprint 24) would
have retagged npm's `latest` dist-tag backward, since `0.1.27` (sprint 26)
had already gone out by the time it was ready. It was corrected to
`0.1.28` before `npm publish` ever ran. The registry goes `0.1.24` →
`0.1.27` → `0.1.28` → `0.1.29` with no gap in what actually shipped.

## 0.2.13 — Sprint 38 (Corrects 0.2.12, live-loop fix)

Found by LiveQA's own live test of 0.2.12: `FC: Start All` launches all
six roles' launcher processes within the same instant, and every one of
them independently read-modify-writes the same `.claude/role-claims.json`
with no coordination at all. Confirmed live and in scratch installs: a
real six-way launch lost 3-5 of the 6 claim records on both 0.2.11 and
0.2.12 — cosmetic on 0.2.11 (a lost record only ever meant a missing
warning), but dangerous starting with 0.2.12's own Req 1: a role whose
record was clobbered by another writer now reads back someone else's
(possibly dead) pid, silencing the relaunch NOTE for a role whose own
session is genuinely still running. LiveQA's own live criterion (launch a
role, then launch it again while the first is still up — the NOTE should
appear) failed live for pipeman, dev-team-2, and qa1 for exactly this
reason.

- **Corrects:** `recordRoleClaim` (`scripts/launcher/role-claims.js`) now
  guards its whole read-modify-write with an exclusive, atomic file lock
  (`fs.openSync(lockPath, 'wx')` — `O_CREAT|O_EXCL` on POSIX, `CREATE_NEW`
  on Windows), with staleness detection so a lock left behind by a
  crashed or killed holder doesn't block every future launch forever, and
  a bounded overall wait so a launch this can't lock (permissions, an
  unsupported filesystem) still proceeds unlocked rather than hanging —
  no worse than every launch already was before this fix, never a new way
  to block one.
- Added a concurrent-launch test (`scripts/launcher_test.js`) that starts
  all six roles' real launcher processes at essentially the same instant
  and asserts all six claim records survive — the shape the previous test
  suite didn't cover (every existing case launched one role at a time).
  Confirmed as a real regression test, not just a passing one: run
  against the lock disabled, it reliably fails, losing 4-5 of the 6
  records, matching LiveQA's own live findings.
- Windows was not covered by LiveQA's round-1 live test and needs
  covering in the retest, including whether `claude` itself outlives the
  launcher there — the orphan guard 0.2.12 added is POSIX-only.

## 0.2.12 — Sprint 38

Workshop readiness: stop a clean relaunch warning about a session that
isn't running, and name the branch correctly on a fresh repository —
both found by LiveQA running the workshop setup guides against published
0.2.10 on real Mac and Windows 11 ARM hardware.

- The role-claims relaunch NOTE (`recordRoleClaim`/`roleClaimWarning` in
  `scripts/launcher/role-claims.js`) no longer fires when the previously
  recorded session is demonstrably no longer running — a positive
  determination via the recorded launcher pid, not a lease and not a
  timeout: it still fires whenever the previous session genuinely is
  still running, or whenever that can't be determined at all (an
  unreadable or pre-0.2.12 record, a check that can't run on this
  platform). Before this, every relaunch printed a collision warning
  forever, regardless of whether anything was actually still running,
  teaching attendees to ignore the one warning that matters.
- `python3 scripts/sprint_lifecycle.py list` (and every other command
  that names the tree it looked in) now distinguishes a real,
  never-committed repository ("no commits yet") from not being a git
  repository at all, from a genuinely undeterminable case (detached
  HEAD, git missing from PATH). Previously both of the first two cases
  printed the identical "(branch unknown)", regardless of whether `git
  init` had been run — exactly the line the workshop guides tell
  attendees to check.

## 0.2.11 — Sprint 36 (Corrects 0.2.10)

Two defects found during 0.2.10's own LiveQA live-test loop, both message-
text only — neither changes any gate's actual behavior.

- **Corrects:** `/sprint-reship`'s refusal message claimed a tree "has
  never been through QA1's audit successfully" even when a PASS had been
  recorded for it and was later superseded by a FAIL — untrue in that
  case. It also printed the same tree hash twice, once as "the commit
  being reshipped" and again as "Gate 1's currently PASSed tree ... which
  does not match," when the two were in fact identical. Found live by
  LiveQA. The gate itself needed no change — every behavioral case it
  tested passed — only the wording, which now says plainly when an
  earlier PASS for the exact tree has since been superseded, and only
  names gate 1's own tree when it's actually a different one.
- **Corrects:** a LiveQA FAIL/CONDITIONAL still told the reader "Dev
  Team: fix, then Pipeman: /sprint-reship," describing the pre-0.2.10
  loop with no QA1 audit step in between, even though `/sprint-reship`
  itself has refused an unaudited commit since 0.2.10. Found by the user,
  not by QA1 — QA1 missed it across all three of sprint 36's gate-1
  rounds and its own live-loop audit of the first fix above, and said so
  plainly on the next round rather than let a QA1 miss stand recorded as
  a QA1 catch. Now names the QA1 audit step explicitly.

## 0.2.10 — Sprint 36

Stop a mis-issued command erasing a sprint's record, require a QA1 audit
before a live-loop fix ships, and close three smaller downstream gaps —
all found by FMC driving a real 0.2.9 install headlessly.

- `/sprint-start` refuses on any sprint that has already started and
  isn't sitting at `blocked` — it used to have no phase guard at all, and
  a mis-issued `/sprint-start` on a sprint already in `liveqa_live`
  silently rebuilt its state file from scratch, nulling every verdict,
  both audit hashes, `last_shipped_commit`, and its entire history.
  Re-filing from `blocked` still works, unchanged, and now explicitly
  preserves history (appending a restart event, never replacing it),
  `audit_rounds`/`live_test_rounds`/the original `started` timestamp,
  while resetting every gate-result field.
- `/sprint-block` refuses on a `complete` or `aborted` sprint. Combined
  with the fix above, this closes a two-command path (block a closed
  sprint, then start it) that could erase a closed record in ordinary-
  looking steps.
- `/sprint-reship` now refuses, no override, unless the exact commit
  being reshipped has a QA1 PASS on record for its tree — either gate
  1's own still-standing PASS, or a live-loop audit PASS QA1 records
  mid-loop (`/sprint-qa1 <N> --verdict ... --commit <hash>`). Previously
  a reshipped fix went out with no audit at all, by design; two
  independent downstream incidents of unaudited content going live
  changed that. The live-loop audit's own append-only safety property
  (it can never touch anything gate 1 reads) is preserved via a new,
  separate `live_loop_audit_trees` state field.
- LiveQA now runs every runnable check before recording a FAIL or
  CONDITIONAL, instead of stopping at the first confirmed defect — a
  determined verdict still never waits on a check that's genuinely
  blocked (missing hardware, for instance), but every check that CAN run
  in the same round now does, with every defect found reported together.
- Headless Master Controller can now commit its own sprint-bookkeeping —
  via a dedicated wrapper script (`scripts/mc-commit.js`) rather than a
  raw `git` permission grant. A first attempt at scoping `git add`/`git
  commit` directly via Bash allow patterns was measured, during this same
  sprint's own QA1 audit, to be structurally unable to confine itself to
  `docs/sprints/` (a pathspec argument passes through a wildcarded allow
  pattern exactly as readily as a commit message does), so enforcement
  moved into the wrapper script's own code instead: every path is
  validated before anything reaches git, and the script has no way to be
  asked to `git push`, `git commit -a`/`-am`, or `git add -A`/`.`.
  Previously it had no git access at all, so amendments it made after a
  sprint started could sit uncommitted through no fault of the process.
- The installer's managed `.gitignore` block now includes
  `.claude/role-claims.json` (already excluded in this repo's own
  `.gitignore` since sprint 25, but never reached a consumer project
  through the installer until now).

## 0.2.0 — Sprint 27

Make the sprint record durable at the moments people rely on it.

- Every lifecycle-writing command now prints what it wrote and that it's
  uncommitted, once, at the moment that's true — a receipt, not a warning.
- The "commit the bookkeeping a lifecycle command produced" rule, which
  applied to Master Controller alone since sprint 18, now applies to
  every role.
- `cmd_liveqa` records — and never refuses on — a sprint file that changed
  since QA1's audit. The recovery cost of a full re-gate is documented in
  the code rather than assumed known.
- The launcher can declare an MCP server for headless LiveQA's browser
  tools (`fullyCompletely.liveqaMcpConfig` in `.vscode/settings.json`).
  When none is declared, it now says so and names what to configure,
  instead of a silent `TOOL NOT AVAILABLE`.
- **This is the milestone release** — see "What 0.2.0 means" in the
  README. Nothing here is breaking.

## 0.1.29 — Sprint 25

Warn when another session is already working here, and let a narrowed
sprint be renamed.

- A second Claude session claiming a role already claimed elsewhere now
  gets a warning naming the prior claim, instead of silently colliding.
- `/sprint-rename` lets a sprint whose scope has legitimately narrowed be
  retitled without touching phase, verdicts, or history — the same kind
  of correction `/sprint-new` makes at creation, owned by Master
  Controller.

## 0.1.28 — Sprint 24

Give `cmd_liveqa` the same tree-content comparison `cmd_ship` gained in
`0.1.14` — a bookkeeping-only difference between the commit Pipeman
shipped and the commit actually deployed (its own state-file commit
landing on top before a branch-tracking deploy) no longer refuses a valid
LiveQA verdict, while a real product-code difference between them still
does. `/sprint-ship` and `/sprint-reship` now also refuse over a red CI
run for the exact commit being shipped, treating a run that finished
without its steps executing the same as a failure; an undeterminable
status (no CI configured, no run yet) does not gate, so a project with no
CI at all doesn't become unshippable by accident. And an
origin-ahead-of-record drift — the record trailing what's actually on
`origin/main` — is now surfaced, never gated on, at `cmd_status` and
everywhere `last_shipped_commit` is read.

*Published as `0.1.28`, not the originally planned `0.1.25` — see the note
at the top of this file.*

## 0.1.27 — Sprint 26

**Corrects the honesty of every permission-scope claim made since
sprint 12.** Re-graded every entry in the permission findings document by
*how it was measured* rather than by confidence: 14 of 16 distinct claims
previously cited as CONFIRMED were re-tagged UNESTABLISHED once graded
against the actual measurement method behind each one. Also found what
can be probed without a live model at all, and recorded that separately
from what still requires one.

## 0.1.24 — Sprint 23

Give headless LiveQA the browser access its own job description already
assumed. Scoped 23 real Playwright MCP browser tool names and a narrow
`curl`/`gh` set into headless LiveQA's permission profile — the grant
LiveQA needs to actually drive a live browser test, not just describe one.

## 0.1.23 — Sprint 22

**The disclosure sweep.** Read every file this package actually ships —
not for correctness, for what it *discloses*: names, identifiers, paths,
tokens, anything that describes a third party. This was unscheduled for
seventeen sprints, since sprint 4 (see `0.1.4` below) fixed one instance
and never generalized the check. Also recorded two budgets that had been
moving in one direction, unwatched: the `--agents` argv payload against
Windows' `CreateProcess` limit (14,164 of 32,767 characters at the time,
monotonic — every agent-file rule added since spends it and nothing
reclaims it), and LiveQA's self-reported rate of probing a neighbouring
surface before the one actually under test.

## 0.1.22 — Sprint 21

Anchor every confirmed permission finding to the `claude` CLI version it
was confirmed against, and make staleness against a newer CLI version
detectable instead of silent.

## 0.1.21 — Sprint 20

**Corrects five self-descriptions** that had each already caused a real
misreading, in the files every install receives.

## 0.1.20 — Sprint 18

**Corrects four overstated claims** — two in code, two in agent files —
that asserted more than had actually been established. Also decided the
compound-command cost question, retired the "directory-confined"
terminology, and added the Master Controller workflow rule whose absence
had already cost five gate rounds.

## 0.1.19 — Sprint 19

**The ownership grant.** Let an operator explicitly declare a repository
as their own and grant a broader headless permission profile only inside
such a repository. Every part of the grant refuses rather than silently
sanitizing input it can't safely handle.

## 0.1.18 — Sprint 16

Wire baseline-table regeneration into the release path so the table can't
silently fall behind again, and decouple the tests that had been breaking
whenever it did.

## 0.1.17 — Sprint 17

Rewrite the headless permission profiles, which had been derived from
this repository's own commands rather than from what each role's job
actually needs, and resolve the tool-vs-Bash confusion that had produced
them.

## 0.1.16 — Sprint 15

Widen the live-loop audit's window to the moment the need for it actually
becomes visible, fix a killed launcher leaving a billed child process
running, and make `sprint_lifecycle.py`'s own output ASCII-clean.

## 0.1.15 — Sprint 14

Remove the last three things that only broke on a default Windows box,
and fix a sprint-header form gap that had nearly let a testable gate go
unrecorded.

## 0.1.14 — Sprint 13

**Corrects `0.1.8`'s "matches by construction" claim** (see below) —
`last_shipped_commit` is now read mechanically from the npm registry
instead of asserted in prose, which had already drifted on the very next
release twice. Also excluded `docs/sprints/` bookkeeping from the ship
gate's tree-hash comparison, so the lifecycle's own commits stop
invalidating an audit that changed no file that actually ships, and added
a warning (never a gate) when a sprint file differs across git worktrees.

## 0.1.13 — Sprint 12 (republish)

Same content as `0.1.12`. Republished under a new version number because
`0.1.12` was already published and npm forbids republishing an
already-published version.

## 0.1.12 — Sprint 12

Settle the narrowest workable headless permission scope by testing it
rather than reasoning about it, put that decision to the user on real
evidence, and complete the six-role opening-prompt discovery that
sprint 11 had to rescope out.

## 0.1.11 — Sprint 11

A headless launch path for `run-role.js`: a separate OS process, a clean
machine-readable stdout stream, an opening prompt composed by the
launcher instead of passed on argv, and a reserved exit-code range that
separates a launcher failure from a role's own verdict. Also fixed the
publish-order trigger in `pipeman.md` (see `0.1.8`). The six per-role
headless prompt templates shipped as an explicitly provisional,
unvalidated-by-running design — validating them by actually running the
roles was rescoped to sprint 12 on the record, not quietly dropped.

## 0.1.10 — Sprint 10

Fix a path-separator bug that made the manifest and baseline mechanism
silently inert on Windows, and make the framework state what it needs to
run instead of failing with a message that pointed somewhere else.

*This release is also the second real instance of `0.1.8`'s "matches by
construction" claim turning out false: it published with `gitHead` not
matching the audited commit and needed a post-hoc correction — the exact
failure sprint 9 was built to eliminate, recurring on the very next
release. See `0.1.14`.*

## 0.1.9 — Sprint 9 (republish)

Same content as `0.1.8`. Republished under a new version number: `0.1.8`
was already published by the time this was ready, and npm forbids
republishing an already-published version.

## 0.1.8 — Sprint 9

Three honesty fixes: Pipeman now publishes before committing ship
bookkeeping, so the commit npm stamps as `gitHead` and the commit
recorded as shipped were meant to match **by construction**, with no
after-the-fact correction; QA1 checks that a version-pair acceptance
criterion is actually satisfiable before accepting it; Master Controller
no longer asserts something is untestable without having attempted it.

**The "matches by construction" claim was itself false.** It held only as
long as nothing else committed on top of the audited commit before
publish — which Dev Team's own QA1-PASS and dev-agreed-done bookkeeping
does, every release. It broke on the very next version (`0.1.10`) and
again on the one after (`0.1.11`, which published with `gitHead` missing
entirely). Corrected properly in `0.1.14`, by making the answer mechanical
instead of a prose promise.

## 0.1.7 — Sprint 7

Let QA1 record a live-loop audit, and name which working tree a sprint
file was read from when that isn't obvious.

## 0.1.6 — Sprint 8

**Corrects `0.1.5`.** Adds published-content baselines as a second,
independent source of proof, so a file untouched since before `0.1.5`
existed can finally be recognized as untouched and upgraded — every
pre-`0.1.5` install had been conflicting on all seven user-owned files and
receiving nothing. Also fixes a conflict message that claimed "upstream
updated this file" in cases where upstream had not, and fixes a fully
successful upgrade exiting `1`.

## 0.1.5 — Sprint 6

Manifest-gated upgrades for `.claude/agents/` and `CLAUDE.md`, so a rule
this framework adds to its own agent files can reach a project that
already installed it, not just a fresh install.

**Shipped inert.** The very first upgrade run wrote the manifest as `{}`,
because at that moment the installer had no record of what it had
previously written — so every install that existed before `0.1.5`
conflicted on every user-owned file, permanently, and received nothing.
Correctly conservative, and useless in the field. Corrected in `0.1.6`.

## 0.1.4 — Sprint 4

**Scrubbed a real client's name** out of `scripts/launcher/session.js`,
where it had been shipping since `0.1.2`, past npm's 72-hour unpublish
window and therefore permanent in those two releases. Also defined
Pipeman's publish step for the first time.

## 0.1.3 — Sprint 3

The FAIL-demonstration evidence standard, the transition-precondition
design rule, and the state-field access convention — all still in force.

## 0.1.2 — Sprint 2

**Corrects `0.1.1`.** Fixed the install upgrade path and republished a
launcher whose version-reporting had lied during a real upgrade, caught
by LiveQA's CONDITIONAL verdict against the previous release.

## 0.1.1 — Sprint 1

Session-resume and first-run authentication fixes for the VS Code
launcher.

## 0.1.0

Initial publish. `npx fully-completely` becomes installable.
