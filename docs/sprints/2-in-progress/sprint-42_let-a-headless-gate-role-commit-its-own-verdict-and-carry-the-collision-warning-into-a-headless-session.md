---
id: 42
title: "Let a headless gate role commit its own verdict, and carry the collision warning into a headless session"
epic: "Headless parity: a role running headless can follow the same rules as one at a keyboard"
status: in_progress
created: 2026-09-22T00:00:00+00:00
---

# Master Controller Sprint Definition — Sprint 42

**Epic:** Headless parity — a role launched headless is held to the same rules
as one at a keyboard, so every rule this framework states must be followable
from both.
**Sprint Objective:** Give headless QA1 and LiveQA a sanctioned way to commit
the one bookkeeping file their own gate writes, and deliver the role-collision
warning into a headless session instead of only to a stderr stream nothing
reads — in one release.

### Context

Both items are measured facts, not hypotheses, and both were established by
LiveQA during sprints 40 and 41 rather than reasoned about.

**The bookkeeping-commit gap.** CLAUDE.md (sprint 32) requires each gate role to
commit its own verdict — `git commit -m "..." docs/sprints/state/sprint-<N>.json`,
no staging step — before handing off. Sprint 41's Req 6b measured what a headless
gate profile can actually do with git at CLI 2.1.278: for both `qa1` and
`liveqa`, `status`, `log` and `diff` pass, while `add` and that exact pathspec
commit are denied. That settles the cause: it is Claude Code's own read/write
gate, not our profiles being wider or narrower than documented (FMC's hypothesis,
confirmed). The consequence is that the rule is unfollowable headless, and it has
already cost a real record: in FMC's live Show Off run a headless LiveQA round-3
PASS sat uncommitted in `docs/sprints/state/sprint-2.json` until Dev Team
happened to sweep it into the close commit — anything reading git alone would
have seen a sprint closing with no live verdict. Sprint 40 confirmed the same
shape here, with a headless QA1 hitting "This command requires approval".

**The headless warning gap.** Sprint 41, Req 3 made the collision warning
readable by prepending it to the role's opening prompt — on the *interactive*
path only. `runHeadless()` is called without the warning at all (verified in
`run-role.js`: `roleWarning` is computed, printed to stderr, and never passed to
`runHeadless`), so both the built-in headless prompt and `--prompt-file` leave a
headless role unaware that another session of its own role was recorded starting
in the same tree. LiveQA flagged it as "may not carry"; it does not carry.

The shape of the first fix is already proven: sprint 36 measured that permission
patterns cannot confine a `git` invocation (`Bash(git commit -m *)` admitted
`git commit -m "msg" scripts/tool.js` with zero denials), and sprint 40 shipped
`mc-commit.js`, a wrapper enforcing its boundary in real code, which LiveQA then
verified refuses source files, traversal, prefix lookalikes, absolute paths and
undeclared paths. This sprint applies that same pattern, narrower.

### Requirements

1. **A headless gate role can commit exactly its own verdict file, and nothing
   else.** Provide a wrapper the `qa1` and `liveqa` headless profiles may run —
   extend `mc-commit.js` or add a sibling; choose deliberately and say why in a
   comment. It performs exactly one thing: `git commit -m "<message>"
   docs/sprints/state/sprint-<N>.json`, with no staging step, matching the shape
   CLAUDE.md already prescribes and for the reason it gives (a pathspec commit
   with no `git add` cannot sweep up a concurrent session's unrelated work).

   **1a. The boundary is enforced in code, not by a permission pattern.** Only
   `docs/sprints/state/sprint-<N>.json` for a real, existing sprint id is
   accepted, resolved through the same real-path check `mc-commit.js` uses.
   Refuse: any other path, more than one path, `..` traversal, a symlink whose
   target leaves that directory, prefix lookalikes, absolute paths outside the
   repo, and any attempt to pass extra `git` arguments. No flag or environment
   variable widens it (sprint 40, Req 2c).

   **1b. It does not push, stage, amend, or commit anything else** — no
   `git add`, no `-a`, no `--amend`, no second pathspec. "Only Pipeman ever runs
   `git push`" is untouched.

   **1c. The message comes from the role, safely.** Support `--message` and
   `--message-file` exactly as `mc-commit.js` does, for the same reason
   (`liveqa.md` documents a `--notes` argument being command-substituted out of a
   permanent record).

   **1d. Both gate profiles gain access to that wrapper and nothing else
   git-shaped.** `HEADLESS_PERMISSION_PROFILES` for `qa1` and `liveqa` gains the
   single script grant. No raw `git` pattern is added to either.

   **1e. Nothing changes for an operator-launched session.** A role at a keyboard
   keeps committing exactly as CLAUDE.md documents; the wrapper is an additional
   route, not a replacement, and the documented shape in CLAUDE.md, `qa1.md` and
   `liveqa.md` stays correct for that case. Update those files to say what a
   headless run does instead, naming the wrapper.

2. **A headless role receives the collision warning.** When
   `roleClaimWarning()` returns a warning, it reaches the headless session's
   opening prompt — both the built-in prompt and `--prompt-file` — the same way
   sprint 41 delivered it interactively. It still also goes to stderr; that is
   not a substitute, and removing it is out of scope.

   **2a.** A launch with no warning is byte-identical to today's, on both
   headless paths. Sprint 41's Req 3b property holds: it warns, it never gates,
   and it never delays.

   **2b.** `--prompt-file` content is the operator's, so the warning is
   prepended in a way that cannot corrupt or be mistaken for that content, and
   the prompt still reads as one coherent instruction. State the chosen framing
   in a comment.

3. **Version bump to one above the currently published version**, with a
   CHANGELOG entry covering Reqs 1–2. Authorized by the user for this sprint.
   Confirm with `npm view fully-completely version` at build time — 0.2.16 when
   this file was written.

4. **Tests.** `node scripts/launcher_test.js` and the Python lifecycle tests both
   pass, with new tests for: the wrapper committing a real state file; refusing
   each case in Req 1a, including a symlink with a real target outside the
   directory (sprint 40's LiveQA reported a false symlink escape from dangling
   links — use real targets); refusing a nonexistent sprint id; the profiles
   granting the wrapper and no raw `git`; the headless prompt carrying the
   warning on both headless paths; a no-warning headless launch being unchanged.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1** — read the wrapper: one commit, one path, no staging. **1a** — every
  refusal is enforced in code against a resolved real path, and tested; grep the
  diff for any run-time widening (a FAIL if present). **1b** — no `push`, `add`,
  `-a`, `--amend`, or pass-through of arbitrary `git` arguments anywhere in it.
  **1c** — both message forms, with the same safety reasoning recorded. **1d** —
  exactly one new grant per gate profile, no raw `git` pattern. **1e** — CLAUDE.md,
  `qa1.md` and `liveqa.md` describe both routes and keep the operator-launched
  shape correct.
- **Req 2** — the warning reaches both headless paths. **2a** — assert a
  no-warning launch's prompt is unchanged, byte-for-byte. **2b** — the framing is
  commented and cannot be confused with operator prompt content.
- **Req 3** — version is published+1 at build time; CHANGELOG present.
- **Req 4** — QA1 runs both suites itself.
- The cumulative diff is confined to the wrapper (`scripts/mc-commit.js` or its
  sibling), `scripts/launcher/run-role.js`, `CLAUDE.md`, `.claude/agents/`,
  tests, `package.json`, `CHANGELOG.md`, the version-derived tables the release
  regenerates, and `docs/sprints/` bookkeeping.

**LiveQA verifies live, after Pipeman publishes (with the user's own go-ahead):**

- Provenance: version and `gitHead` from `npm view`, matching
  `last_shipped_commit`.
- **Req 1 live, the whole point of this sprint:** in a scratch project, run a
  real headless QA1 through an audit to a recorded verdict, then have it commit
  that verdict through the wrapper — and confirm with `git log` that the commit
  exists and contains only `docs/sprints/state/sprint-<N>.json`. Repeat for
  headless LiveQA with a live verdict. Then confirm the refusals live: another
  path, two paths, a traversal, a real (not dangling) symlink out, a nonexistent
  sprint id, and an attempt to pass extra git arguments. Confirm `git add` and a
  raw pathspec commit are still denied in those sessions.
- **Req 2 live:** launch a headless role twice in the same tree so the second
  launch warns, and confirm the running session itself reports the warning —
  not only that stderr carried it. Test both the built-in prompt and
  `--prompt-file`. Then confirm a first, clean headless launch shows nothing
  extra.
- **Interactive regression:** an operator-launched gate role still commits its
  verdict the documented way, and sprint 41's interactive warning still arrives.
- macOS is sufficient for this sprint unless something platform-specific
  appears; both items are launcher and git behaviour with no Windows-specific
  surface. **Before relying on the Windows VM for anything, note its clock was
  three days behind as of 21 September, which made Claude Code there fail with
  an SSL error unrelated to this framework — fix the clock first, and do not
  record that failure as a framework result.**
- Per `liveqa.md` step 7: run every runnable check before recording.

### Out of Scope

- **Giving any role a raw `git` grant.** Req 1d. Sprint 36 measured why patterns
  cannot hold this boundary.
- **Changing who pushes.** Pipeman only, unchanged.
- **A commit wrapper for Dev Team or Pipeman.** Dev Team writes source and needs
  a genuinely broad grant; that is a separate question with a different risk
  profile, and nobody has reported it as a live problem.
- **Removing the stderr warning.** Req 2; it stays as well.
- **Changing what the warning says.** Sprint 25's wording stands.
- **Retrofitting past uncommitted verdicts.** FMC's Show Off record is theirs to
  correct, and `/sprint-correct` (sprint 40) is the route if they want it in the
  record.
- **The Windows VM clock.** An operator fix, noted in the live criteria so a
  gate round isn't burned on it, not work for this sprint.

### Human Prerequisites

- **None for the build.** For the live test: a published release (the user's own
  publish authorization in Pipeman's session), and — only if LiveQA elects to run
  any Windows check — the VM's clock corrected first.

### Dependencies

- **Blocks:** headless runs of this framework following CLAUDE.md's own
  bookkeeping-commit rule; FMC's headless gate roles hit the same wall.
- **Blocked by:** nothing. Sprint 41 is closed; its Req 6b measurement is what
  this sprint is built on.
- **External:** npm publish needs the user's own go-ahead in Pipeman's session.
  Req 1's grant behaviour depends on the Claude Code CLI; the version at build
  and at gate time is part of the record (it moved twice during the last epic).

### Team Assignments

- **Dev Team 1:** all of it. The two requirements are separable but share one
  release and `run-role.js`.
- **Dev Team 2:** not assigned. No parallelisable surface worth a worktree.

### Risks & Mitigations

- **The wrapper becomes a general git escape hatch.** — Req 1a/1b confine it to
  one path and one operation, enforced in code; QA1 greps for widening; LiveQA
  tests the refusals live, with real symlink targets after sprint 40's
  false-positive.
- **Prepending to `--prompt-file` corrupts an operator's prompt.** — Req 2b
  requires a framing that cannot be mistaken for the operator's own content, and
  a byte-identical no-warning path.
- **The CLI's read/write gate changes and the measurement expires.** — Sprint 21's
  version anchoring applies; record the CLI version at build and at gate time.
- **A headless role commits a verdict that is wrong rather than merely
  uncommitted.** — Unchanged by this sprint: the verdict is whatever the role
  recorded, and `/sprint-correct` (sprint 40) exists for a role that finds its own
  recorded evidence wrong.
