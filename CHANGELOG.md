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

## 0.2.21 — Sprint 45 (Corrects 0.2.20, `--model` precedence)

`0.2.20`'s own new claim about `--model`/frontmatter precedence was
backwards, caught by LiveQA's live test rather than shipping unnoticed:
CLAUDE.md said the agent file's own `model:` frontmatter wins even over
an explicit `--model` flag (sprint 12's own measurement, at an earlier
CLI version). At `claude 2.1.280` it doesn't — the flag now wins.
Reproduced independently, multiple times across this fix loop, always
from the structured `modelUsage` result field, never narration: `claude
--agent qa1 --model haiku` ran as haiku; `claude --agent qa1` with no
flag ran as opus, both directions confirmed.

- **Corrects (LiveQA, round 1; re-confirmed by QA1's own live-loop
  audit):** both CLAUDE.md passages that stated or relied on the old,
  now-false precedence. The frontmatter-honored claim is now scoped to
  "when no `--model` flag is given"; a new, explicitly version-anchored
  paragraph (`claude 2.1.280`) states the flag now overrides frontmatter,
  framed as a CLI property to re-verify at the current version rather
  than a settled fact — this behavior has evidently changed at least once
  already and this framework does not control it. The operator
  instruction changed from "the flag does nothing" to "never add it — it
  now silently overrides the role's intended model instead of being
  harmlessly ignored," tied explicitly to this same release's own "taking
  a cost by default is not the same as choosing it" paragraph.
- **Corrects (QA1's live-loop audit, round 1):** `README.md` carried the
  identical false claim (it also ships in the npm package and renders on
  the package page — the more public of the two files, and LiveQA's own
  0.2.20 retest was scoped to CLAUDE.md, so this would not have been
  caught there). Corrected to the same shape as CLAUDE.md's own fix.
- **Corrects (operator decision, mid-loop, sprint 45's own Req 7):** two
  more shipped copies of the identical stale claim, found by a repo-wide
  sweep rather than left for a later report — `scripts/launcher/agents.js`
  and `scripts/launcher/run-role.js`'s own header comments, both
  corrected to the same shape, keeping the still-true half (this launcher
  deliberately never passes `--model` itself, so frontmatter is the
  single place a model is *meant* to be set) and dropping only the
  unsupported "and it would win anyway" half. No launcher behavior
  changed — no code path here ever passed `--model` and none starts now.
  `docs/sprint-44-dev-team-opus-model-findings.md` also generalized a
  real, narrower measurement (frontmatter alone, never varying `--model`)
  into this same false claim; corrected with an appended, dated
  correction note rather than an edit to its own table, since the
  measurement it actually ran was sound and only the unsupported
  generalization is withdrawn.

## 0.2.20 — Sprint 45

Four carry-overs from sprint 44, documentation and one test extension only
— no permission grant or other behavior change.

- **States, beside CLAUDE.md's own team table, what actually reads
  `model:`.** An interactive launch (`claude --agent <id>`) has the CLI
  itself read that role's own agent-file frontmatter — this framework's
  launcher never passes `--model` on that path, and frontmatter wins even
  when one is given anyway. A headless launch passes it explicitly, in
  `headlessLaunchArgs()`'s own `--agents` JSON. Both were confirmed live
  in sprint 44, from the structured result envelope of a real launch, not
  narration — a frontmatter string that parses is not itself evidence a
  role runs on it.
- **Corrects a stale example** that CLAUDE.md's own team-table change
  orphaned: "Start each session... e.g. `claude --model opus` for Master
  Controller, QA1, or LiveQA" implied the `--model` flag is what sets a
  role's model, and was already wrong about which roles use `opus` (five,
  not three). Replaced with what actually determines it: `claude --agent
  <id>`.
- **The role-color test now catches a near-miss, not only an exact
  collision.** Sprint 44's test asserted six distinct resolved
  `terminal.ansi*` values, which would not have caught the actual defect
  that reached an operator — `orange` and `yellow` were always distinct
  strings (`terminal.ansiBrightYellow` vs `terminal.ansiYellow`); they
  *rendered* alike. A new test checks resolved colors against a
  deliberately conservative, hand-maintained list of pairs known (or
  obviously implied by the same reasoning — a color and its own bright
  variant) to look alike, seeded with the confirmed pair. Stated plainly
  in the test's own comment: this list is judgment, not a claim about
  every theme, and a person actually looking at the rendered tabs (sprint
  44's own screenshot) remains the only real coverage for a pair this
  list doesn't name.
- **CLAUDE.md gains one general paragraph**, credited to FMC's Master
  Controller: taking a cost by default is not the same as choosing it.
  `--user-said` and the publish-authorization rule are both instances of
  it; a role's model changing under an unattended run on an upgrade is
  named as the case that has no gate and does not get one here — stated
  so whoever designs the next gate can ask the question deliberately,
  rather than discovering it only after the cost has already been paid
  by default. Introduces no mechanism and no behavior change.

## 0.2.19 — Sprint 44

The operator's decision, 22 September: Dev Team 1 and Dev Team 2 now run on
Opus (the bare `opus` alias, never a pinned version string) instead of
Sonnet — cheaper than Opus 5 and comparable in capability at the time this
was decided. `opus` already resolves to Opus 5.5, so writing the bare alias
rather than a pinned string keeps the framework tracking whatever Anthropic
currently ships as Opus, and means all four of Master Controller, QA1,
LiveQA and now both Dev Teams share the same alias.

- `.claude/agents/dev-team-1.md` and `.claude/agents/dev-team-2.md`:
  `model: sonnet` → `model: opus`. CLAUDE.md's own team table updated to
  match.
- Confirmed by launching, not assumed: two real headless Dev Team 1
  launches, `claude 2.1.280`, both report `claude-opus-5-5` in the CLI's own
  structured `modelUsage` result field — never the model's own narration. A
  negative control (briefly reverting to `model: sonnet` for one launch,
  then restoring) reported `claude-sonnet-5` instead, confirming the
  measurement actually distinguishes between the two rather than reporting
  the same value regardless of the frontmatter. Full record:
  `docs/sprint-44-dev-team-opus-model-findings.md`.
- Pipeman, Master Controller, QA1, and LiveQA are unchanged — Pipeman stays
  on `sonnet`; the other three already ran `opus`.
- **Corrects a real rendering collision, reported by the operator mid-sprint:
  Dev Team 2's terminal tab read as QA1's.** The cause was the color map,
  not the agent files: VS Code task icons accept only `terminal.ansi*`
  theme colors, and `orange` mapped to `terminal.ansiBrightYellow`, which
  sits beside QA1's own `terminal.ansiYellow` and reads alike in most
  themes. `dev-team-2.md` now declares `color: cyan`
  (`terminal.ansiCyan`, a real, distinct ANSI color — no approximation
  needed), and `COLOR_MAP` in `scripts/launcher/agents.js` gains that
  entry. `orange` stays in the map for a downstream project's own agent
  file that may still declare it — removing it would silently break that
  project's own tab color for no gain here. The role-color test now
  asserts all six roles resolve to six *distinct* values, not just that
  Master Controller is blue, so a future collision (a literal duplicate
  color name across two roles) fails the suite instead of shipping quietly.

## 0.2.18 — Sprint 43

Documentation and tests only — no permission grant or other code change.
LiveQA's own live test of sprint 42 measured something that sprint hadn't
asked about: `gate-commit.js` is a real, tool-enforced boundary for QA1,
and only a convenience for LiveQA, which already holds a broad enough
grant to reach `git` directly. Both `qa1.md` and `liveqa.md` previously
implied more uniformity between the two roles than actually holds.

- **`liveqa.md` now states plainly that LiveQA's confinement is
  instructional, not enforced.** `Bash(node *)` reaches a child process
  and therefore `git` the same way it reaches the filesystem — measured
  directly (`claude 2.1.278`): a `node -e` git-commit attempt was not
  stopped by the permission layer at all. Tied to the file's own existing
  "you do not write or modify code" instruction as the same principle
  extended, not a new license.
- **`qa1.md` now states, conditionally, that QA1's confinement IS
  enforced on its default profile** — no `Bash(node *)`/`Bash(npx *)`,
  `Edit`/`Write` disallowed, and the identical `node -e` probe was
  DENIED. Three qualifications stated plainly rather than left implied:
  `gate-commit.js` is a narrow, purpose-built exception, not the
  arbitrary-execution primitive the claim is about; a project that
  validly declares `fullyCompletely.ownedRepository` in
  `.claude/settings.local.json` hands QA1 the identical broad grant Dev
  Team gets, at which point the boundary is instructional instead,
  exactly like LiveQA's; and "narrowest of the six roles" was dropped as
  its own overclaim (Master Controller's default profile is equally
  narrow and never eligible for the broader grant at all).
- **The measurement is recorded in
  `docs/sprint-12-permission-scope-findings.md`**, in the established
  format, and states plainly that it confirms sprint 39's own conclusion
  (`Bash(node *)` widens nothing beyond what `Bash(npx *)` already
  permitted) rather than contradicting it.
- **CLAUDE.md gains one general paragraph**: a role whose job is running
  published or arbitrary code cannot be confined by a tool grant, so
  where a rule matters for such a role it must be stated as an
  instruction and verified by review, never assumed enforced.
- **A new test asserts the pairing structurally, not just prose against
  grants.** Any profile that disallows `Edit`/`Write` while also
  granting a route to an arbitrary child process (`node *`, `npx *`,
  `bash`, `sh`, `git *`, or eligibility for the owned-repository grant
  set) must carry the instructional-not-enforced wording in its own
  agent file — derived generically from the real profile data, not
  hardcoded to QA1/LiveQA by name, so a future role or grant change that
  reproduces the same shape is caught even if nobody remembers to update
  a name-based test. A companion test exercises the detection logic
  directly against constructed adversarial profiles.
- `HEADLESS_PERMISSION_PROFILES` is byte-unchanged by this release.

## 0.2.17 — Sprint 42

Two items, both measured facts rather than hypotheses, both established by
LiveQA during sprints 40 and 41: a headless gate role (QA1, LiveQA) could
not commit its own verdict bookkeeping at all, and a headless role had no
way to see a role-collision warning in its own transcript, only on a stderr
stream nothing reads.

- **A headless gate role can now commit exactly its own verdict, and
  nothing else.** `scripts/gate-commit.js` is a new wrapper — a sibling to
  `mc-commit.js`, not an extension of it, since the two enforce genuinely
  different boundaries (no staging at all, vs. mc-commit.js's own
  unconditional `git add`; a single path matching
  `docs/sprints/state/sprint-<N>.json` for a real, registered sprint id,
  not a directory-prefix allowlist). Enforced in real code, not a
  permission pattern: refuses any other path, more than one path, `..`
  traversal, a symlink whose target leaves the directory (real targets,
  not dangling-link false positives), prefix lookalikes, absolute paths
  outside the repo, a nonexistent sprint id, and any unrecognized
  argument — no environment variable or flag widens it. QA1's and
  LiveQA's headless profiles are granted `Bash(node scripts/gate-commit.js
  *)` and nothing else git-shaped — no raw `git` pattern was added to
  either, closing exactly the gap sprint 41's Req 6b measured (`claude
  2.1.278`: this exact pathspec commit was denied outright for both roles
  headless, "This command requires approval," even with the broader
  owned-repository grant set). An operator-launched gate role keeps
  committing the documented raw `git commit` form, unchanged — this is an
  additional route, headless only, never a replacement.
- **A headless role now receives the collision warning in its own opening
  prompt**, the headless counterpart to sprint 41's interactive fix — both
  the built-in prompt and a `--prompt-file` override. Framed in explicit
  `=== FRAMEWORK NOTICE ===` markers rather than a bare join, since a
  `--prompt-file`'s content is the operator's own and a bare join could be
  mistaken for part of it. Still also goes to stderr, unconditionally —
  additive, not a replacement. A clean launch (no warning) produces
  byte-identical prompt text to before this release; nothing is delayed or
  gated.

## 0.2.16 — Sprint 41

Four items, all found by running the framework rather than reading it: the
launcher's own transient lock files were showing up as untracked in a
downstream project's git status, a downgrade install happened silently,
a real collision warning was unreadable in practice (gone before the
person it's for could see it), and the `--user-said` human-authorization
rule was protected by exactly one refusal with no test defending either
direction of it.

- **The launcher's own lock files (and steal siblings) no longer show up
  as untracked project files.** `role-claims.json.lock` and
  `role-claims.json.lock.stolen-*` are now in the managed `.gitignore`
  block every install writes (fresh and upgrade), and in this repository's
  own `.gitignore` — both derived from `role-claims.js`'s own
  `LOCK_SUFFIX`/`CLAIMS_RELATIVE_PATH` constants, with a divergence-guard
  test for the one hand-kept copy (a plain `.gitignore` can't `require()`
  a JS module). An upgrade adds the new lines while preserving whatever
  else was already in a target's `.gitignore`, exactly as the existing
  block merge already guaranteed.
- **The installer now says so when it's about to install an older version
  than the one already present**, naming both versions, in the same place
  the normal version-transition line prints. A deliberate rollback still
  works exactly as before — this only makes it visible rather than silent.
  Upgrade and same-version wording are unchanged.
- **A collision warning now survives long enough to actually be read.**
  Measured first, not reasoned about: Claude Code's own interactive TUI
  covers a pre-launch `console.error()` line within well under a second
  (LiveQA, sprint 38 round 2), so the warning is now also prepended to the
  role's own opening prompt — fresh launch and resume alike — where it
  becomes part of the model's own first turn and rides the same rendering
  pipeline the TUI already uses for the conversation itself. Confirmed
  live, 3/3 real headless runs at `claude 2.1.278`, including on
  `--resume` (which previously carried no trailing message at all for any
  role but Dev Team 2's own worktree note). A clean launch — no
  collision — produces byte-identical prompt text to before this release;
  nothing is delayed or gated. Full measurement:
  `docs/sprint-41-collision-warning-readability-findings.md`.
- **The `--user-said` human-authorization rule is now defended by tests on
  both sides**, not just `cmd_complete`'s own single refusal: one static
  scan asserts no code path in this repository's `scripts/`, command
  files, or agent files ever constructs, defaults, or otherwise supplies
  `--user-said`/`--user-said-file` content (`scripts/check_user_said_guard.py`),
  and one asserts every sprint close actually recorded in this project's
  own history carries a non-empty one
  (`scripts/check_user_said_history.py`). Neither test touches
  `cmd_complete`'s own behavior — the rule is unchanged, just harder to
  erode unnoticed the way an earlier rule (sprint 9's publish ordering)
  once did.
- **The sprint template gains a `### Human Prerequisites` section**
  (between Dependencies and Team Assignments) for anything a person must
  do outside the repository before a sprint's gates can pass — a
  migration, a DNS record, an account, a device at hand. QA1, LiveQA, and
  Master Controller's own agent files now say to route a predicted
  operator-side blocker there at planning/repair time, not bury it as a
  warning inside a verdict's own notes read only after a live-test
  failure — the gap that cost FMC two live-test rounds on a real,
  effectively-predicted blocker.
- **Two permission-model gaps re-measured, not fixed** (Req 6c: no grant
  changed this release). A `node -e` write outside the launch working
  directory succeeds for headless LiveQA while a plain read (`cat`/`ls`)
  of that same outside path is denied — confinement holds for reads and
  not for writes, the opposite of symmetric. And under the live headless
  profiles, `qa1`/`liveqa` can both run read-only git (`status`/`log`/
  `diff`) with zero denials despite no git grant at all, while `git add`
  and the sprint-32 pathspec bookkeeping commit are both denied for both
  roles regardless of grant — including for `qa1` with its
  `eligibleForOwnedRepositoryGrant` set, meaning neither gate role can
  currently execute the commit CLAUDE.md's own rule requires of it,
  headless. Both findings are stated plainly in `liveqa.md`/`qa1.md` and
  recorded in `docs/sprint-12-permission-scope-findings.md`; the fix is
  routed to Master Controller as its own sprint, not designed here.

## 0.2.15 — Sprint 40

Two more downstream findings from FMC's own use of this framework, routed
upstream: a role had no way to correct a factual error in its own
recorded notes without also reopening the verdict, and Master Controller
had no sanctioned way to commit files it legitimately owns outside
`docs/sprints/`.

- **New command, `/sprint-correct <N> --event-index <N> --correction "..."`.**
  An append-only correction to a role's own recorded notes — never a
  verdict, gate, or phase change. Closes a real gap: LiveQA once recorded
  a sound verdict whose notes contained a factual error of its own making
  (a claim about a check that had silently failed, and the wrong branch
  name), verified the claim properly afterward, and had nowhere to put
  the correction because the sprint had already moved phase — the
  original record still carried the wrong claim. The new command appends
  exactly one history event and touches nothing else (diffed and tested:
  every gate-result field, both audit hashes, `last_shipped_commit`,
  round counts, and phase are all provably unchanged), with no phase
  restriction — it works on a `complete` sprint too. Only the role that
  recorded the target event may correct it: the correcting actor is
  compared against the target event's own recorded actor and refused on
  any mismatch, naming both, and refused outright if `CLAUDE_CODE_AGENT`
  isn't set at all. `/sprint-status --verbose` shows the correction
  attached to (immediately after) the event it corrects, and the plain
  summary names that a correction exists even without `--verbose`.
- **`mc-commit.js` now also accepts `CLAUDE.md` itself and a project's own
  decisions log**, alongside the unchanged `docs/sprints/` default — each
  an exact single-file match, never a directory. The decisions-log path
  is read from the project's own declared configuration
  (`.vscode/settings.json`'s `"fullyCompletely.mcDecisionsLog"`, the same
  way this framework already reads a project's declared test command),
  falling back to a documented default (`docs/decisions.md`) when nothing
  is declared. Validated fresh on every run, never trusted: a declared
  path that resolves outside the repository, inside `.git/`, inside a
  path this framework's own installer manages, to a directory rather than
  a file, or in a glob/list shape is refused with the specific reason —
  it never silently falls back to the default. No escape hatch: no
  environment variable or flag can widen the allowlist at run time,
  confirmed by both a source-level check and a real subprocess test.
  Full measurement record: `docs/sprint-36-mc-commit-permission-findings.md`.

## 0.2.14 — Sprint 39

Three downstream findings from FMC's own use of this framework, routed
upstream (`~/Programming/Fifty_Mission_Cap/docs/proposals/fully-completely-findings-2026-09-13.md`,
outside this repo): a blocked sprint's own bookkeeping write was
indistinguishable from a real edit, headless LiveQA couldn't run a
Node-based live check, and a failing test named repeatedly across
verdicts was mistaken for a real decision to accept it.

- The sprint-file hash used for `qa1_audit_file_hash` now excludes only
  the one frontmatter line this script itself rewrites as bookkeeping
  (`status:`, on start/block/complete/abort) — title/original_title stay
  in the hash, a rename still forces a fresh audit. A hash recorded
  before this release (the old, whole-file scheme) is replayed under
  that same scheme wherever it's compared, so an in-flight sprint
  upgrading mid-build neither false-fails nor silently passes an edited
  file.
- **A sprint blocked purely over an unmade decision, with its file
  otherwise unchanged, now returns to its exact pre-block phase with
  every gate-result field and both round counts intact on re-filing** —
  only when a QA1 PASS is on record, `/sprint-block` recorded which
  phase it was blocked from, and the file hashes equal to what QA1
  actually audited. Every other case (the file changed, no PASS existed,
  or the pre-block phase wasn't tracked) falls back to exactly the prior
  release's behavior: phase back to `dev_build`, every gate cleared. The
  printed output always says which path ran, and for a reset, why.
  Restoring the phase never loosens `/sprint-ship`'s, `/sprint-reship`'s,
  or `/sprint-liveqa`'s own tree/commit-content checks.
- Headless LiveQA is now granted `node *`, so a target whose live check
  is a Node script can actually be run instead of reported CONDITIONAL
  for want of a tool grant. Measured live before adding it (`claude
  2.1.276`, full record in `docs/sprint-12-permission-scope-findings.md`):
  the `npx *` grant LiveQA already had reaches arbitrary
  program-mediated writes, inside and outside its working directory,
  with zero confinement — `node *` is convenience for a reach it already
  had, not a new capability, and isn't narrowed to exclude `node -e`
  since that measurement showed narrowing would buy no real safety.
  LiveQA's own instruction not to write source is unchanged and remains
  an instruction, not something the tool profile enforces on its own.
- QA1's and Dev Team's own agent files now say plainly: a failing test
  may be reported as "known" or "pre-existing" only by citing a specific
  recorded decision to accept it — a commit, a sprint, or Master
  Controller's own recorded call. Without one, the first report names it
  and routes it to Master Controller as unowned, and every later report
  says it is still unowned, rather than letting repeated naming stand in
  for an actual decision — the exact gap that let a real downstream
  finding go unowned for five sprints.

## 0.2.13 — Sprint 38 (Corrects 0.2.12, live-loop fix)

Three defects in `.claude/role-claims.json`'s own bookkeeping, found
across LiveQA's live test of 0.2.12 and two rounds of QA1's own live-loop
audit of the fix, all in the same dangerous direction: a role whose
session is genuinely still running gets its relaunch NOTE silenced
anyway.

- **Corrects (LiveQA, round 1):** `FC: Start All` launches all six roles'
  launcher processes within the same instant, and every one of them
  independently read-modify-writes the same role-claims file with no
  coordination at all. Confirmed live and in scratch installs: a real
  six-way launch lost 3-5 of the 6 claim records on both 0.2.11 and
  0.2.12 — cosmetic on 0.2.11 (a lost record only ever meant a missing
  warning), but dangerous starting with 0.2.12's own Req 1: a role whose
  record was clobbered by another writer now reads back someone else's
  (possibly dead) pid, silencing the relaunch NOTE for a role whose own
  session is genuinely still running. LiveQA's own live criterion (launch
  a role, then launch it again while the first is still up — the NOTE
  should appear) failed live for pipeman, dev-team-2, and qa1 for exactly
  this reason. Fixed: `recordRoleClaim` now guards its whole read-modify-
  write with an exclusive, atomic file lock (`fs.openSync(lockPath,
  'wx')` — `O_CREAT|O_EXCL` on POSIX, `CREATE_NEW` on Windows), with
  staleness detection so a lock left behind by a crashed or killed holder
  doesn't block every future launch forever, and a bounded overall wait so
  a launch that can't lock (permissions, an unsupported filesystem) still
  proceeds unlocked rather than hanging — no worse than every launch
  already was before this fix, never a new way to block one.
- **Corrects (QA1, live-loop audit of the fix above):** even with the lock
  in place, a role's claims file still kept only its single MOST RECENT
  launch, unconditionally overwritten every time — a second way to reach
  the identical silencing. Real repro: launch A (still running); launch B
  while A is up (correctly warns, then B itself exits); launch C, with A
  still genuinely alive — no warning, because B's own now-dead pid had
  already replaced A's still-live record the moment B launched. An
  ordinary duplicate-tab-then-relaunch sequence, not a contrived edge
  case. Fixed: a role's claims are now a list, not a single record — every
  launch prunes only the entries POSITIVELY confirmed gone (the same bar
  already used for whether to warn) and appends its own, so a still-
  running earlier launch's record survives a later launch's own claim
  being written, and is only ever dropped once IT is confirmed to have
  exited. A pre-0.2.13 single-record file, and every existing single-
  object caller, are read as a one-element list, unchanged.
- **Corrects (QA1, second live-loop audit):** the list fix above
  introduced its own regression on an UPGRADED install: a claim written by
  0.2.10/0.2.11 has no `pid` at all, so it can never be positively
  confirmed dead and the previous fix kept it in the file forever —
  meaning every relaunch warned, permanently, on any tree with pre-0.2.13
  homework already done. Fixed: an undeterminable-because-pid-less claim
  still warns on the launch that reads it (Req 1a is unchanged — an
  undeterminable record always warns), but is now dropped from what gets
  WRITTEN BACK, so it never resurfaces on a later launch. A modern
  (has-a-pid) claim whose liveness merely can't be determined right now
  (a platform check that failed once) is unaffected — it keeps its own
  chance to be positively confirmed dead on a later check, unlike a
  pid-less record which never can be.
- **Corrects (QA1, second live-loop audit):** the stale-lock TOCTOU fix
  from the round above did not actually close the race — `renameSync`
  onto a unique path is atomic with respect to WHICH CALLER wins against
  a given source path, but has no way to tell WHICH FILE currently
  occupies that path, and the staleness decision is made from a `stat()`
  taken before the rename runs. QA1 confirmed live, by interleaving two
  real `acquireClaimsLock` calls, that one process's rename could still
  carry off another process's freshly re-acquired lock. Fixed: after the
  rename, the moved file's identity (inode, corroborated by mtime) is
  compared against what was actually observed stale; a mismatch means
  someone else's fresh lock was grabbed by accident, so it's renamed back
  to its rightful place and the attempt retries from scratch instead of
  treating the mismatch as a successful acquisition.
- Added: a concurrent-launch test asserting all six roles' claim records
  survive `FC: Start All`; an end-to-end real-subprocess test for the
  A/B/C sequence above; a real-subprocess test planting a pre-0.2.13
  claims file and asserting the NOTE fires once, not on every relaunch;
  and a deterministic, white-box test of the stale-lock identity check
  (simulating the exact interleaving QA1 found by intercepting this
  module's own `fs.statSync` call). All four confirmed as real regression
  tests, not just passing ones: run against each fix disabled in turn,
  every one reliably fails, matching the finding that motivated it.
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
