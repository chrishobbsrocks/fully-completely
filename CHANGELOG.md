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

Close three gaps between shipping a commit and verifying what actually
got served: a CI-status check wired into `/sprint-ship`, `/sprint-reship`,
`/sprint-status`, and `/sprint-liveqa`; and the ship gate compares tree
*content* rather than the raw commit SHA, so a legitimate Pipeman
squash/rebase — which changes the SHA without changing a shipped byte —
no longer false-fails.

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
