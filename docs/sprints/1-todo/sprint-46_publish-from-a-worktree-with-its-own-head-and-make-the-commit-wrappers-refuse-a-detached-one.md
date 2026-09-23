---
id: 46
title: "Publish from a worktree with its own HEAD, and make the commit wrappers refuse a detached one"
epic: "Shared-checkout safety: no role's operation may silently change what another role commits onto"
status: todo
created: 2026-09-23T00:00:00+00:00
---

# Master Controller Sprint Definition — Sprint 46

**Epic:** Shared-checkout safety — six roles work in one primary checkout, and no
role's operation may silently change the thing another role's commit attaches to.
**Sprint Objective:** Give Pipeman's publish its own HEAD by running it in a
dedicated worktree instead of detaching the shared checkout, and make both commit
wrappers refuse outright to commit onto a detached HEAD — closing the window that
stranded a Master Controller commit during sprint 44's publish.

### Context

Pipeman's own incident report, 23 September, reconstructed from git timestamps
rather than memory. During sprint 44's publish of 0.2.19, Pipeman stashed, ran
`git checkout 3cc6b90` in the **primary checkout**, and published from that
detached HEAD so npm would stamp `gitHead` with the audited commit rather than
main's drifted tip. `npm publish` hit EOTP, so the operator had to run it by hand
— a round trip of several real minutes with HEAD still detached. At 21:55:54,
inside that window, Master Controller's own session committed `93b8071` (sprint
44's Req 2a) in the same working directory. `git commit` attaches to whatever
HEAD resolves to, so that commit became a child of `3cc6b90` and was reachable
from no branch at all.

It was recovered: `git checkout main` printed git's own unconditional "you are
leaving 1 commit behind" warning, Pipeman read it, pinned the commit to a rescue
branch, confirmed its provenance, and cherry-picked it cleanly. **Nothing was
lost and the published artifact was never affected** — `gitHead` matched the
audited commit exactly. But as Pipeman states plainly, recovery depended on four
things that are not guaranteed: returning via `git checkout main` specifically,
git's warning firing, a human reading it in a noisy terminal, and the stranded
commit being a trivial conflict-free single-file change. A dropped stash, a
conflicting cherry-pick, or a scrolled-past warning each loses work.

The root cause is structural and Pipeman named it: **HEAD is one
repository-wide pointer, not a per-session one.** Master Controller, Dev Team 1,
QA1, LiveQA and Pipeman all work in the same primary checkout — only Dev Team 2
has a convention (`/sprint-worktree`) that gives it its own. Pipeman's technique
is legitimate and solves a real problem (bookkeeping commits land between the
audited commit and the publish, and `npm publish` stamps `gitHead` from whatever
HEAD literally is); what it lacks is isolation. Pipeman has already applied
harm reduction on its own — checking `npm whoami` before detaching, warning the
operator, watching for the return warning — and is explicit that these shorten
the window without closing it.

### Requirements

1. **Pipeman publishes from a dedicated worktree, never by detaching the primary
   checkout.** `git worktree add --detach <path> <audited-commit>` gives that
   directory its own HEAD; the primary checkout stays on main throughout, so any
   other session's commit lands where it expects. Pipeman `cd`s there, verifies
   the tarball, publishes, then removes the worktree.

   **1a. FLAGGED ASSUMPTION — measure before building on it.** That `npm publish`
   run inside a linked worktree stamps `gitHead` with the worktree's HEAD (the
   audited commit) is the entire point and is **unverified**. Establish it by
   publishing for real and reading `npm view <pkg>@<version> gitHead` — this
   sprint's own release is the natural test. If it does not hold, stop and report
   to Master Controller rather than shipping a technique that silently produces a
   wrong `gitHead`; the fallback (a throwaway `git clone` of the repo at that
   commit) is named here so nobody has to invent one under pressure.

   **1b. No stash of other sessions' work.** The old technique stashed an
   uncommitted state-file write. A worktree needs no stash at all, and Pipeman
   must not stash in the primary checkout as part of publishing — a downstream
   install's Pipeman once swallowed another session's in-progress file with an
   unfiltered `git stash -u`, which is the same class of accident as this one.

   **1c. Cleanup is explicit and safe.** Remove the worktree after publishing,
   following CLAUDE.md's existing rules for worktree removal: never remove a
   directory a session might still be in, and `git worktree remove` refuses on
   uncommitted changes. A publish worktree is throwaway and carries no commits of
   its own, so it has no branch to merge — say that plainly so nobody applies Dev
   Team 2's merge-first rule to it.

   **1d.** Update `.claude/agents/pipeman.md` (its publish steps) and CLAUDE.md
   to describe the worktree publish as the documented technique, replacing the
   detached-checkout one. State the reason in one line: HEAD is repository-wide,
   and a publish that moves it can strand another session's commit.

2. **Both commit wrappers refuse to commit onto a detached HEAD.**
   `scripts/mc-commit.js` and `scripts/gate-commit.js` exist to make a role's
   commit safe; committing onto a detached HEAD is never something Master
   Controller or a gate role legitimately does, and it is the exact failure this
   incident produced. Refuse, with a message that says HEAD is detached, names
   the current commit, says nothing has been committed, and tells the caller to
   wait — a publish may be in progress in this checkout.

   **2a.** Refuse before any git write, so a refused call leaves the index and
   working tree untouched.

   **2b. No override.** No flag or environment variable commits anyway. If a
   legitimate detached-HEAD commit case ever appears, it is a finding for Master
   Controller, not a switch.

3. **The lifecycle script says so too, without gating.** A `sprint_lifecycle.py`
   command that writes state while the checkout is detached is not itself wrong —
   state files are written, not committed — but it is a strong signal that a
   publish is in progress and that any commit made now will strand. Print a
   warning (not a refusal) when HEAD is detached, in the same style as the
   existing uncommitted-bookkeeping receipts. **Do not gate any transition on
   it**: a refusal here would block a gate role during a publish for no benefit.

4. **Version bump to one above the currently published version**, with a
   CHANGELOG entry covering Reqs 1–3. Authorized by the user, 23 September.
   Confirm with `npm view fully-completely version` at build time — 0.2.21 when
   this was written; do not trust that number.

5. **Tests.** Both suites pass, with new tests for: each wrapper refusing on a
   detached HEAD and writing nothing; each still committing normally on a branch;
   the refusal message naming the detached commit; the lifecycle warning
   appearing when detached and absent when not; and the warning never changing an
   exit code or a phase.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1** — `pipeman.md` and CLAUDE.md describe the worktree publish, and the
  detached-checkout technique is gone rather than offered as an alternative.
  **1a** — the assumption is flagged in the file as unverified until this
  sprint's own publish proves it, with the clone fallback named. **1b** — no
  stash step survives anywhere in the publish path. **1c** — cleanup rules are
  stated, including that a publish worktree has no branch to merge.
- **Req 2** — both wrappers check before any git write (**2a**), with no override
  path (**2b**); grep the diff for any flag or env var that bypasses it. Confirm
  the message names the commit and says nothing was committed.
- **Req 3** — the warning is a warning: `git diff` shows no transition gated on
  it, and a test asserts the exit code and phase are unchanged when it fires.
- **Req 4** — version is published+1 at build time; CHANGELOG present.
- **Req 5** — QA1 runs both suites itself.
- The cumulative diff is confined to `scripts/mc-commit.js`,
  `scripts/gate-commit.js`, `scripts/sprint_lifecycle.py`,
  `.claude/agents/pipeman.md`, `CLAUDE.md`, tests, `package.json`,
  `CHANGELOG.md`, the version-derived tables the release regenerates, and
  `docs/sprints/` bookkeeping.

**LiveQA verifies live, after Pipeman publishes (with the user's own go-ahead):**

- **Req 1a is proved by this sprint's own publish:** confirm
  `npm view fully-completely@<new version> gitHead` equals the audited commit,
  published from a worktree. This is the requirement's whole risk; if `gitHead`
  is wrong, the technique failed regardless of anything else passing.
- **Confirm the primary checkout never left main during the publish** — from
  Pipeman's report of the operation, and by confirming no orphaned commits exist
  (`git fsck --lost-found` or equivalent) after it.
- **Req 2 live, in a scratch install:** detach HEAD, attempt a wrapper commit as
  a gate role and as Master Controller, confirm both refuse with nothing written
  (`git status` byte-identical before and after), then return to a branch and
  confirm both commit normally.
- **Req 3 live:** run a lifecycle command while detached and confirm the warning
  appears, the command still succeeds, and the phase is what it should be.
- Per `liveqa.md` step 7: run every runnable check before recording.

### Out of Scope

- **Giving every role its own worktree.** The real fix for shared-checkout
  hazards generally, and much larger than this incident warrants: it changes how
  every role is launched and how work moves between them. This sprint isolates
  the one operation that moves HEAD for minutes at a time. If the wrappers'
  refusals start firing often, that is evidence for the bigger change and a
  finding for Master Controller.
- **Changing how `gitHead` is determined.** npm stamps it from HEAD; this sprint
  arranges for HEAD to be right rather than fighting npm.
- **Pipeman's own harm-reduction habits** (checking `npm whoami` first, warning
  the operator before an OTP round trip). Keep them — they are good practice —
  but they are not the fix and this sprint does not make them requirements.
- **A lock or "publish in progress" marker.** A refusal that names the likely
  cause is enough; a lock file is state that can go stale, which is the failure
  mode sprint 25 rejected for role claims.
- **Recovering already-stranded commits.** None exist; `93b8071` was recovered as
  `91794a0` and is in main's history.

### Human Prerequisites

- **The user's own publish authorization in Pipeman's session**, at the moment of
  publishing — and for this sprint specifically, the publish is also the
  measurement Req 1a depends on, so it cannot be deferred without leaving 1a
  unproved.
- **The npm OTP**, if the account still requires it by hand; that round trip is
  what made the original window long enough to matter.

### Dependencies

- **Blocks:** nothing, but every future publish runs the old technique until this
  ships.
- **Blocked by:** nothing. Sprint 45 is closed and 0.2.21 is published.
- **External:** npm's behaviour when publishing from a linked worktree (Req 1a),
  and the registry's `gitHead` field.

### Team Assignments

- **Dev Team 1:** all of it.
- **Dev Team 2:** not assigned — and note the irony worth avoiding: do not create
  a Dev Team 2 worktree for this sprint, since the sprint is about worktree
  discipline and a second checkout would add exactly the kind of shared-state
  question it exists to remove.

### Risks & Mitigations

- **Publishing from a worktree stamps the wrong `gitHead`.** — Req 1a flags it as
  unverified, names the clone fallback, and LiveQA proves it against this
  sprint's own release before the sprint can pass.
- **The wrappers' refusal blocks a role during a legitimate publish window.** —
  That is the intended behaviour: the commit would strand. The message says to
  wait and why, and Req 3's warning makes the cause visible from the lifecycle
  commands too.
- **Someone reintroduces the detached technique later because it is simpler.** —
  Req 1d removes it from the documentation rather than leaving it as an option,
  and states the one-line reason it was removed.
- **The wrappers are not the only way a commit gets made.** True: an operator or
  a role using plain `git commit` is unprotected, and this sprint does not change
  that. Req 1 is what actually closes the window; Req 2 is the backstop for the
  paths this framework owns.
