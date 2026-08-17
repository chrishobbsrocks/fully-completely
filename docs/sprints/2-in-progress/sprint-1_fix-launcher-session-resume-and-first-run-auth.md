---
id: 1
title: "Fix launcher session resume and first-run auth"
epic: "Launcher reliability"
status: in_progress
created: 2026-08-17T02:59:56+00:00
---

# Master Controller Sprint Definition — Sprint 1

**Epic:** Launcher reliability — the VS Code six-terminal launcher must survive first run and restart on both macOS and Windows.
**Sprint Objective:** Make `FC: Start All` reliably open six working agent terminals on a fresh machine, by resuming sessions via real session IDs instead of display names, and by failing clearly when the user isn't logged in.

> **LiveQA's gate is REDEFINED for this sprint, not skipped.** *(Corrected
> mid-sprint — the original wording said "skipped," which was wrong and
> would have deadlocked this sprint. `/sprint-complete` hard-requires a
> LiveQA PASS at `sprint_lifecycle.py:688`, with no skip flag and no
> override, and editing state by hand to get around it is forbidden.)*
>
> Per CLAUDE.md's `## Changes to this repo's own tooling`, LiveQA normally
> live-tests a deployed product in a browser. This repository has no
> deployed product and this change is a Node launcher script, so **there is
> no browser in this sprint's live test** — but there is still a real live
> test: running the actual launcher on a real Windows machine.
>
> **"Live" here means the real launcher actually running, not a browser.**
> The launcher is the product, and it is executable. LiveQA's live test has
> two parts:
>
> **Part A — macOS end-to-end, executed by LiveQA itself.** This is the
> larger part and the higher-value one. QA1's 38 tests ran against *fixture*
> session files, which encode our own assumption about where the CLI writes
> sessions — the tests and the code share that assumption, so no static
> audit can falsify it. **Nobody has yet observed the real Claude CLI,
> given `--session-id <derived-uuid>`, actually create `<derived-uuid>.jsonl`
> where we predict.** That unobserved fact is what the whole design rests
> on. See Part A steps in Acceptance Criteria.
>
> **Part B — Windows, executed by the user.** LiveQA cannot run this; no one
> on the team has Windows hardware. The user runs the Windows steps and
> reports results; **LiveQA evaluates those results** and folds them into
> its verdict, with notes stating plainly which parts it observed directly
> and which it is accepting on the user's report. That keeps the audit trail
> honest about who actually saw what.
>
> **LiveQA owns the gate and records the verdict** via
> `/sprint-liveqa 1 --deployed-commit <sha> --verdict ...`. A PASS requires
> both parts.
>
> QA1's static gate applies unchanged.

### Context

First real Windows verification of the `npx fully-completely` launcher found it broken on first run. The user ran `FC: Start All` before logging in to Claude. All six terminals spawned, one was used to complete the OAuth login, and the other five never became usable. Killing the window and re-running produced the same result: one working agent, five stuck.

Investigation found three defects, all in the resume path, and the trigger is not the real problem. `run-role.js` resumes with `claude --agent <id> --resume "fc:<role>:<repo>"`, but that string is a *display name* set via `--name`, not a session ID. Per the CLI's own help, `--resume [value]` resumes by session ID **or "opens interactive picker with optional search term."** A display name isn't an ID, so it degrades to a search term and opens the picker — five terminals sat in a zero-result fuzzy picker waiting for keyboard input a background tab never receives. Because a picker never exits, `child.on('exit')` never fires, so the `FAST_FAILURE_MS` fallback to `launchFresh()` is unreachable in exactly the case it was written for. And `markLaunched()` fires on spawn, so it records "we started a process," not "a resumable session exists" — a process that died at a login prompt still gets written down as launched. 56 orphaned `.jsonl` session files in this repo's session directory corroborate that resume has likely never reconnected, on any platform.

The fix is available and cheap: `claude --session-id <uuid>` lets us **assign** the session ID at launch rather than discover it. That removes more code than deleting the feature would.

### Requirements

1. **Assign session IDs at launch.** Fresh launches must pass `--session-id <uuid>` alongside `--agent`, `--name`, and the initial prompt. The UUID must be stable and deterministic, so it can be recomputed rather than remembered.

   **1a. The UUID is derived from (role id, repo root, generation), not just (role id, repo root).** Generation is a zero-based integer. This corrects an over-constraint in the original wording: one permanent address per role made "resume the current session" and "start a new current session" mutually exclusive, which `--restart` cannot live with.

   **1b. The filesystem is the generation registry — there is still no state file.** Both decisions are made by computing candidate UUIDs and testing whether `<uuid>.jsonl` exists, extending the exact principle Requirement 4 already establishes:
   - *Normal launch:* resume the **highest** generation whose session file exists. If none exists, launch fresh at generation 0.
   - *`--restart`:* launch fresh at **highest existing generation + 1**.

   Cap the scan at a sane bound (100 is ample) and fall back to a random `crypto.randomUUID()` if somehow exceeded. Use *highest existing*, not *first gap*, so a manually deleted middle generation can't reassign a live ID.

   **1c. `--session-id` is never passed an ID that is already in use.** Because a new session is only ever assigned a generation whose file does not exist, the untested CLI behaviour flagged in Risks below is structurally avoided rather than relied upon. Dev Team does not need to test what reusing an in-use ID does — this design never asks.
2. **The UUID must be RFC-valid.** The CLI requires "a valid UUID". A raw hash is not one. Derive it deterministically (UUIDv5-style over role id + repo root) with correct version and variant bits, using only Node's built-in `crypto` — no new dependencies.
3. **Resume by session ID only, never by display name.** `--resume` must receive the assigned UUID. The display name stays on `--name` for human readability in the picker and terminal title, and must never again be passed to `--resume`.
4. **Decide resume-vs-fresh by checking the session file on disk**, not by interpreting an exit code. Resume only when the session's `<uuid>.jsonl` exists in the project session directory; otherwise launch fresh. Derive that directory path — do not hardcode the macOS encoding.
5. **Delete the state-tracking machinery this replaces.** `scripts/launcher/state.js` (state file, lock file, stale-lock reaper, atomic write, `wasLaunched`/`markLaunched`), the `FAST_FAILURE_MS` constant, and the fast-failure fallback relaunch all go. Remove the now-dead `.claude-launcher/` entry from `.gitignore`.

   **5a. `--restart` must keep working, and the session it starts must stick.** It forces a fresh session at generation +1 (per 1b), never deletes or renames prior history, and — critically — **the restarted session becomes the one the next normal launch resumes.** A restart that yields a one-off side conversation, leaving the next launch to reconnect to the session the user just deliberately abandoned, does not satisfy this requirement. `run-role.js`'s own comment defines restart as being for "when you actually want to abandon a session"; abandonment that silently reverses itself is a trap.
6. **Preflight the login check.** Before spawning anything, detect that the user is not authenticated and exit with a single clear message telling them to run `claude`, log in, then re-run the task. This must be distinguishable from the existing "claude not on PATH" failure — a logged-out user and a missing install must not produce the same message.

   **6a. ~~Use the exit code. Do not parse JSON.~~ — SUPERSEDED by 6a-revised.** *(The original text claimed "the exit code already carries it." LiveQA measured that claim false against CLI 2.1.233. Recorded rather than deleted, because the reasoning error matters for the retro.)*

   **6a-revised. Read `loggedIn` from `--json`. Block only on positive `loggedIn: false`.** The exit code carries **half** the bit, not the whole one: exit 0 reliably means authenticated, but exit non-zero is overloaded across *logged out* and at least four measured non-auth failures (unrecognised subcommand, unrecognised flag, unreadable config dir, config dir is a file). Exit code alone therefore cannot supply the positive evidence 6b requires, and 6a as originally written made 6b unsatisfiable — honour 6b strictly under exit-code-only and the preflight can never block, which deletes Requirement 6's entire purpose.

   The classification is:
   - `loggedIn === true` (or a clean exit 0) → **authenticated**, proceed.
   - `loggedIn === false`, parsed explicitly from the probe's JSON → **unauthenticated**, block.
   - Everything else — non-zero without a parseable `loggedIn: false`, malformed or absent JSON, missing field, spawn error, signal, timeout → **inconclusive**, proceed.

   **Why parsing is now safe, when it wasn't before.** The original objection was that guessing at an undocumented shape risks a wrong answer. Requirement 6b removes the harmful direction of that risk: if the shape changes and `loggedIn` can't be found, the result is *inconclusive → proceed*. The failure mode becomes "we stop blocking" — harmless, no worse than today — rather than "we falsely block a working install." 6b is what makes 6a-revised safe, so the two must be implemented together. Parse `loggedIn` and nothing else; do not read `authMethod`, `email`, `subscriptionType`, or any other field, and do not branch on them.

   **6b. The preflight has three outcomes, not two.** It must never hard-block a working setup:
   - *Confidently not authenticated* → block, print the login message, spawn nothing.
   - *Confidently authenticated* → proceed.
   - *Inconclusive* — the `auth status` subcommand is missing or unrecognised on an older CLI, or the probe fails for a reason unrelated to auth → **proceed with the launch anyway.** Do not block, and do not claim the user is logged out.

   The asymmetry driving 6b: a false "you're logged in" costs a confusing fan-out, but Requirements 1–5 have already removed the picker hang that made that fan-out catastrophic. A false "you're logged out" hard-blocks someone whose setup works fine, with no way past it. This preflight is a courtesy layered on top of the real fix, and a courtesy must never be able to lock a working install out of its own launcher.

   **6b-clarified — the line is "could the probe answer?", not "why can't the user authenticate?"** Inconclusive means *we failed to obtain an answer* (non-JSON output, no `loggedIn` field, spawn error, signal, timeout). It does **not** mean "the answer was bad for a reason we consider unfair." When the CLI reports `loggedIn: false` it is telling us the credentials it has are unusable, and the launcher must accept that at face value and block — whether the cause is a never-logged-in machine or a broken config directory, all six agents fail identically, so there is no working setup to protect. Never inspect `authMethod` or anything else to second-guess the cause; that is the "guessing at undocumented shape" 6a-revised rules out.

   **6c. Wording.** Because a `loggedIn: false` block can now legitimately arise from a broken config directory as well as a genuine logout, the message must not assert a cause it cannot know. State the observation and the remedy: something to the effect of *"Claude reports no usable credentials. Open a normal terminal, run `claude`, sign in, then re-run this task."* The remedy line holds for both causes — a user with a broken config dir who runs `claude` by hand hits the real error immediately and self-corrects. Keep it textually distinct from the not-on-PATH message (Req 6).
7. **Document the login prerequisite.** README's prerequisites (currently "Requires only Python 3 and Node.js") and `install.js`'s post-install output must both state that you log in to Claude once, in a normal terminal, before first running the launcher.
8. **Test coverage in `scripts/launcher_test.js`**, following the existing file's conventions (real behaviour, throwaway temp fixtures, every test runs regardless of earlier failures). Cover at minimum: UUID determinism for the same inputs; UUID differs across roles and across repo roots; UUID passes RFC validity; session-directory path derivation on both POSIX and Windows-style paths; resume-vs-fresh selection driven by a fixture session file existing or not.

### Acceptance Criteria

**QA1 verifies statically:**

- Req 1–3: `run-role.js` passes `--session-id <uuid>` on fresh launch and `--resume <uuid>` on resume. Grep the whole launcher: no call path can reach `--resume` with the `fc:<role>:<repo>` display name. `--name` still carries it.
- Req 2: UUID generation uses only `node:crypto`; version and variant bits are set correctly, not merely hash-hex reformatted. `package.json` dependencies unchanged.
- Req 4: the resume decision reads the filesystem. No exit-code or elapsed-time heuristic remains anywhere in the decision. Path derivation contains no literal `-Users-` or hardcoded separator assumption.
- Req 1a/1b: the UUID derivation takes a generation argument. Normal launch resolves to the **highest** existing generation; `--restart` resolves to highest + 1. The scan is bounded with a random-UUID fallback. No state file is reintroduced in any form.
- Req 1c: confirm by inspection that no code path can pass `--session-id` an ID whose `.jsonl` already exists. This is the criterion that makes the untested in-use-ID behaviour a non-issue; if it doesn't hold, the design is not as specified.
- Req 5: `scripts/launcher/state.js` is deleted, no module still requires it, `FAST_FAILURE_MS` is gone, `.gitignore` no longer references `.claude-launcher/`, and `--restart` still forces a fresh session.
- Req 5a: **the round trip, not just the restart.** Verify that after a `--restart`, a subsequent *normal* launch resumes the restarted session and not the abandoned one. Req 8 must cover this with fixture session files at multiple generations — it is the whole point of 1a and the easiest thing to implement halfway.
- Req 6: the logged-out path exits before any role process spawns, and its message text is distinct from the not-on-PATH message.
- Req 6a-revised: the preflight parses `loggedIn` from `claude auth status --json` and blocks **only** on an explicit `loggedIn === false`. No other JSON field is read or branched on. Malformed JSON, absent JSON, and a missing `loggedIn` field must each resolve to *inconclusive → proceed*, not to a block — verify each with a test, since these are the paths that turn a shape change into a false lockout.
- Req 6a/6b interaction — **corrected**. The earlier version of this criterion demanded all four of LiveQA's measured scenarios resolve to *proceed*. That was wrong: it copied a QA scenario list without checking the four were the same kind of failure. Dev Team captured stdout (LiveQA had only exit codes) and found they split two and two. The correct split, each needing a test:
  - **Probe could not answer → inconclusive → proceed.** Unrecognised subcommand and unrecognised flag (`--bogusflag`) both emit non-JSON error text, so `loggedIn` is absent. Auth itself is fine; only our probe broke. These are the cases 6b exists for.
  - **CLI answered that credentials are unusable → block.** Genuine logout, config dir `chmod 000`, and config dir-is-a-file all emit a well-formed `{"loggedIn": false, ...}`. Byte-identical, and correctly so — in all three the user cannot run Claude, so all six agents would fail to authenticate. Blocking is right; proceeding would spawn six doomed terminals, which is the original bug reproduced. The launcher must not try to distinguish *why* credentials are unusable, and must not read `authMethod` to attempt it.
- Req 6b: all three outcomes are implemented and distinguishable in the code, not just the two obvious ones. Specifically verify the inconclusive branch **proceeds with the launch** rather than blocking — an implementation that treats "probe failed" as "not logged in" fails this criterion, because that is the exact case that would lock an older-CLI user out of a working launcher. Req 8 tests must cover this branch.
- Req 7: both README and `install.js` output state the login prerequisite.
- Req 8: `node scripts/launcher_test.js` passes and covers every case listed in Req 8. QA1 runs it, not just reads it.

**LiveQA Part A — macOS end-to-end, run by LiveQA against the real CLI (no browser, no fixtures):**

- **The load-bearing check.** Launch one role fresh. Independently compute the expected UUID for (role, repo, generation 0), then confirm a file named exactly `<that-uuid>.jsonl` now exists in the derived session directory. Compute the expectation *separately* from the launcher's own output — if you only read back what the launcher reports, you've verified nothing. This is the assumption QA1's fixtures could not falsify.
- **Resume actually resumes.** Launch a role, tell it a specific fact it could not otherwise know, exit. Relaunch normally. Ask for that fact back. A terminal opening is not a pass; the answer is the pass.
- **Restart round trip, for real.** Run with `--restart`. Confirm a new generation file appears and the prior one is untouched on disk. Then launch *normally* and confirm it resumes the **restarted** session, not the abandoned one (Req 5a) — verified by content, as above.
- **No orphan accumulation.** Record the session-file count before and after a full `FC: Start All`. Expect exactly the six new sessions, no strays. This is the regression that started the sprint.
- **Auth preflight, all three branches.** Verify the logged-out message is clear and spawns nothing. Verify the inconclusive branch **proceeds** rather than blocking (simulate by making the probe fail in a way unrelated to auth) — Req 6b, the branch most likely to be implemented backwards.

**LiveQA Part B — Windows, executed by the user, evaluated by LiveQA (this sprint cannot close without it):**

- On a Windows machine, **logged out**: run `FC: Start All`. Expect a clear "log in first" message, and **no** terminals left sitting at a picker or prompt.
- Log in via a normal terminal, close it, re-run `FC: Start All`. Expect **all six** agent terminals to come up working, each announcing its own role.
- Close VS Code, reopen, run `FC: Start All` again. Expect all six to **resume** their prior conversations — verified by asking one of them something only the earlier conversation would know, not by the terminal merely opening.
- Confirm no new orphan `.jsonl` files accumulate per launch beyond the six expected sessions.
- **The drive-letter colon, flagged by QA1 in round 2.** `C:\Users\Chris Hobbs\...` should derive to `C--Users-Chris-Hobbs-...` — the colon and the backslash each becoming their own dash, producing a genuine double dash. This is the one character class with **no macOS evidence behind it**; the encoding rule was verified only against POSIX paths. Confirm the derived directory matches the one the CLI actually creates. If it doesn't, that is a real Windows failure, not a labelling problem.

### Out of Scope

- **Rewriting the sprint state machine.** `sprint_lifecycle.py`, `docs/sprints/`, and the lifecycle commands are untouched. This sprint is `scripts/launcher/` plus the two docs surfaces in Req 7.
- **Session cleanup / garbage collection.** The 56 orphaned `.jsonl` files are evidence of the bug, not a target. Deleting user session history is a destructive operation that deserves its own decision; this sprint stops creating new orphans and leaves existing ones alone.
- **Automated Windows CI.** Real value, wrong sprint — we need this fixed before we invest in a Windows runner. The manual gate above covers it for now.
- **Changing which model or prompt each role launches with.** `--agent` frontmatter stays in charge, per the existing comment in `agents.js`. No behaviour change there.
- **The auto-launch-on-folder-open setting.** `fullyCompletely.autoLaunch` is currently modified in the working tree and unrelated to this fix. Leave it alone; do not commit an incidental change to it.

### Dependencies

- **Blocks:** Any further launcher work, and any confident recommendation of `npx fully-completely` to Windows users. Also blocks retiring the `Windows launcher unverified` note — that note should be updated as part of this sprint once the Windows gate passes.
- **Blocked by:** Nothing. All prerequisites confirmed: `--session-id <uuid>` exists, session files are `<uuid>.jsonl` under a per-project directory, and `launcher_test.js` already provides the harness.
- **External:** **The Windows acceptance gate depends entirely on the user.** No one else on this team has a Windows machine. Dev Team must treat "QA1 passed" as *not done* and expect a wait.

### Team Assignments

- **Dev Team 1:** All of it. Requirements 1–8, single sequential sprint.
- **Dev Team 2:** Not assigned. This is one tightly-coupled change to one small module — the session-ID scheme, the resume decision, and the deletion of `state.js` are the same edit viewed from three angles. Splitting it would manufacture a merge conflict in `run-role.js` for no gain. No worktree needed.

### Risks & Mitigations

- **Windows session-directory path encoding differs from macOS** (drive letters, backslashes) — the single most likely way this fix passes QA1 and still fails on Windows. *Mitigation:* Req 4 forbids hardcoding, Req 8 requires tests over Windows-style paths, and the Windows gate tests the real thing. If derivation proves unreliable, fall back to always-fresh rather than shipping a path guess — a launcher that works without resume beats one that hangs.
- **~~`--session-id` may behave differently than documented when the ID is already in use~~ — resolved by design, see Req 1c.** The generation scheme only ever assigns a generation whose session file does not exist, so an in-use ID is never passed and the undocumented behaviour is never invoked. Dev Team does not need to test it. *Still open:* whether `--session-id` behaves as documented when combined with `--agent`. Verify that much by hand on macOS before building around it; if it doesn't behave, stop and report rather than working around it silently — that finding changes the sprint.
- **The fix is unverifiable by the people writing it.** Every previous launcher bug reached the user because macOS passed. *Mitigation:* the Windows gate is a hard requirement above, and the "ask it something only the prior conversation knows" check exists specifically to stop "the terminal opened" being mistaken for "resume worked."
- **Deleting `state.js` removes the lock and atomic-write logic added in response to a real prior audit finding.** *Mitigation:* that machinery guarded a file that will no longer exist; QA1 should confirm nothing else reads it, rather than assuming the deletion is safe because this file says so.
- **Scope creep into session cleanup.** The orphan files are visible and tempting. *Mitigation:* explicitly out of scope above; raise it as a follow-up sprint if it matters.
