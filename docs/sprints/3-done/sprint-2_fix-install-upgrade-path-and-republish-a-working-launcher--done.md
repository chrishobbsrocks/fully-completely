---
id: 2
title: "Fix install upgrade path and republish a working launcher"
epic: "Launcher reliability"
status: done
created: 2026-08-17T00:00:00+00:00
---

# Master Controller Sprint Definition — Sprint 2

**Epic:** Launcher reliability — the launcher must work on both platforms *and* actually reach the people installing it.
**Sprint Objective:** Make `npx fully-completely` deliver the fixed launcher to both new and existing installs, by giving `install.js` a real upgrade path and republishing at a bumped version.

> **Gates:** QA1's static audit applies unchanged. **LiveQA's gate applies and is redefined exactly as in Sprint 1** — no browser, because there is no deployed product. "Live" means the real installer actually running: Part A on macOS by LiveQA, Part B on Windows by the user. See Acceptance Criteria. *(Sprint 1 originally mis-stated this as "skipped," which would have deadlocked it — `/sprint-complete` hard-requires a LiveQA PASS at `sprint_lifecycle.py:688` with no override. Stated correctly here from the start.)*

### Context

Sprint 1 fixed the launcher and both gates passed, including the Windows drive-letter encoding nobody could verify until the user ran it. But LiveQA's round-2 report closed with two findings that are not Sprint 1 defects and are not fixed: **the published npm package still ships the broken launcher**, and **`install.js` has no upgrade path**. Both are confirmed. `package.json` says `0.1.0` and `npm view fully-completely version` says `0.1.0` — identical, with no git tags, so the tarball on npm is pre-fix code containing `state.js` and `--resume sessionTitle`. Anyone running `npx fully-completely` today gets exactly the bug Sprint 1 closed. npm will not accept a republish at the same version, so a bump is mandatory, not cosmetic.

The upgrade half is the more interesting defect. `copyFile()` (`scripts/install.js:73`) flags any existing-but-different file as a conflict and leaves it untouched — it never overwrites. That is correct behaviour for a first install into someone's existing project, and exactly wrong for an upgrade, where the framework's own files are precisely the ones that must be replaced. During Sprint 1's Part B this left `run-role.js` — the single most important file — stale and merely *reported*, and never removed the now-deleted `state.js`. Part B only succeeded because the launcher folder was replaced by hand. An existing user cannot currently receive a fix, which makes every future sprint in this epic undeliverable by the same mechanism.

Sequencing matters: fix the upgrade path first, then publish. Publishing a version whose installer cannot cleanly upgrade distributes the problem to a wider audience — and with a workshop in the picture, that audience is students.

### Requirements

1. **Classify every installed path as framework-owned, user-owned, or merged.** The single `copyFile()` policy is the root defect. Make the taxonomy explicit and data-driven, not inferred per-call:
   - **Framework-owned** — `scripts/sprint_lifecycle.py`, `scripts/launcher/**`, `.claude/commands/**`, `templates/**`. The user is never expected to edit these; an upgrade replaces them.
   - **User-owned** — `.claude/agents/**` and `CLAUDE.md`. These are *designed* to be customised (agent personas, the project-standards section this repo's own CLAUDE.md explicitly invites you to extend). An upgrade must **not** silently overwrite them.
   - **Merged** — `.vscode/settings.json`, `.vscode/tasks.json`, `.gitignore`. Existing merge logic stays as-is; this sprint does not change it.
2. **Framework-owned files are overwritten on upgrade, with a backup.** Before replacing a framework file whose content differs, write the existing copy to a sibling backup (`<name>.bak-<installed-version>` or equivalent). Overwriting must always be recoverable. Report what was replaced and where the backups went.
3. **User-owned files keep today's conflict behaviour, and say so louder.** Never overwrite; report as a conflict with an explicit line telling the user this file is theirs to reconcile and what changed upstream. A user who customised an agent persona must not lose it to an upgrade.
4. **Remove framework files that no longer exist upstream.** `state.js` is the live example — Sprint 1 deleted it, and existing installs still carry it. Removal applies **only** to framework-owned paths, is backed up per Req 2 before deletion, and is reported. Never delete anything outside the framework-owned set. Also drop the now-dead `.claude-launcher/` line from a previously-installed `.gitignore` if the merge logic can do so safely; if it cannot, report it rather than leaving it silently.
5. **Version awareness.** Record the installed framework version in the target project (a small marker file is fine; it is not sprint state and must not live under `docs/sprints/`). Use it to distinguish a first install from an upgrade, to name backups, and to report `installed X → Y` in the summary. A missing marker means "unknown previous version" and must degrade to the upgrade path, not to a crash.
6. **Bump the version and republish.** Bump `package.json` from `0.1.0` to a version reflecting a bug-fix release of previously-broken code, tag the release commit in git (there are currently no tags at all, which is why the published/source divergence was invisible), and publish. **Publishing is Pipeman's operation, not Dev Team's** — Dev Team prepares the bump and tag; Pipeman publishes, exactly as it alone pushes.
7. **Verify the tarball before publishing, not after.** `npm pack` produces the exact artifact `npx` would deliver. Install *from that tarball* into a throwaway directory and confirm the launcher files match the fixed source, before anything is published. This removes the chicken-and-egg of needing a published version to test a publish.
8. **Test coverage in `scripts/launcher_test.js`**, following the existing conventions (real behaviour, throwaway temp fixtures under the OS temp dir, never against this repo, every test runs regardless of earlier failures). Cover at minimum: framework-owned file overwritten and backed up; user-owned file left untouched and reported as a conflict; merged file behaviour unchanged; removed-upstream framework file deleted and backed up; a file outside the framework set never deleted; missing version marker degrades to upgrade rather than crashing; and a first install into an empty directory still behaves exactly as it does today.

### Acceptance Criteria

**QA1 verifies statically:**

- Req 1: the taxonomy exists as explicit data, not scattered conditionals. Every path the installer touches falls into exactly one category — QA1 should be able to enumerate them and find no unclassified path.
- Req 2/3: framework files overwrite with a backup; user-owned files never overwrite. Confirm `.claude/agents/**` and `CLAUDE.md` are in the user-owned set — misfiling either is the change most likely to destroy someone's work.
- Req 4: deletion is reachable **only** for framework-owned paths. Trace it and confirm no input can route a user-owned or merged path to deletion. This is the highest-severity code in the sprint; audit it as such.
- Req 5: the version marker is written, read, and used; a missing marker degrades to upgrade. Confirm the marker is not under `docs/sprints/`.
- Req 6: `package.json` version is bumped and a matching git tag exists. **QA1 confirms only that the bump and tag are correct — QA1 does not publish and does not gate on publication.**
- Req 7: the tarball verification is a real step someone runs, with its procedure written down, not an aspiration in a comment.
- Req 8: `node scripts/launcher_test.js` passes and covers every case listed. QA1 runs it.
- Regression: Sprint 1's launcher behaviour is untouched. `scripts/launcher/**` should not change in this sprint except by deletion-of-nothing; if it does, that needs a stated reason.

**LiveQA Part A — macOS, run by LiveQA against the real installer:**

- **First install** into an empty throwaway project from the packed tarball. Confirm the launcher files land, and that a role actually launches — reuse Sprint 1's load-bearing check (independently predict the UUID, confirm `<uuid>.jsonl` appears).
- **Upgrade over a simulated stale install, run at least TWICE in a row.** Construct a project containing the *old* launcher (`state.js` present, old `run-role.js`), run the installer, and confirm: `run-role.js` is replaced with the fixed version, `state.js` is gone, backups exist, and the summary reports all three accurately. **A stale `run-role.js` surviving is the exact Sprint 1 Part B failure and is an automatic FAIL.**

  **The second run is not optional, and this is QA1's instruction, not a suggestion.** A single run passed even *before* the round-2 fix — the backup-compounding defect lived entirely in the second run (nesting backups, growing filenames, and falsely reporting files as "no longer part of the framework"). A one-shot check would have shipped it. On run two, expect: the same backup filenames as run one, no new nesting, and no "Removed" section. Run three should be identical to run two.
- **Customisation survives.** Edit an agent persona and a CLAUDE.md project-standards line, run the upgrade, confirm both are intact and reported as conflicts rather than silently replaced.
- **Nothing outside the framework set is deleted.** Put an unrelated file in the project, upgrade, confirm it is untouched.

**LiveQA Part B — Windows, executed by the user, evaluated by LiveQA:**

- **The headline check:** from a genuinely clean Windows state, `npx fully-completely@<new-version>` then `FC: Start All` gives six working terminals. This is the check that discharges Sprint 1's undischarged Dependencies line, and it is the whole point of this sprint.
- **Upgrade over the broken install** already on that machine — the one that needed a hand-replaced launcher folder during Sprint 1. Confirm it now upgrades cleanly with no manual intervention.
- Backups and the removal of `state.js` behave the same as on macOS, and paths with spaces and a drive letter are handled correctly by any new path logic (Sprint 1's encoding rule is verified, but this sprint adds new file operations over those same paths).

### Out of Scope

- **Changing the launcher's runtime behaviour.** Sprint 1's session-ID, resume, restart, and auth logic are verified and closed. This sprint changes how files are *delivered*, not what they do.
- **Rewriting the merge logic** for `.vscode/*` and `.gitignore`. It works, it has tests, and it is genuinely the hard case. Req 4's `.gitignore` line is the one narrow exception, and it may be reported rather than solved.
- **An uninstall command.** Adjacent and tempting once removal logic exists; a different feature with its own risks.
- **Session-file cleanup.** Still out of scope, same reasoning as Sprint 1: deleting a user's conversation history deserves its own decision.
- **A general plugin/update-checking mechanism.** This sprint makes `install.js` idempotent and upgrade-safe. It does not add update notifications or auto-upgrade.

### Dependencies

- **Blocks:** Discharging Sprint 1's outstanding Dependencies line — *"any confident recommendation of `npx fully-completely` to Windows users."* Sprint 1 is closed; that obligation moved here and is not discharged until Part B's headline check passes. Also blocks retiring the private "Windows launcher unverified" note in full: the *launcher* half is now verified, the *npx* half is not.
- **Blocked by:** Nothing. Sprint 1 is complete and its code is on `origin/main`.
- **External:** **npm publish rights**, and the irreversibility that comes with them — a published version cannot be replaced, only superseded, which is exactly why Req 7 verifies the tarball first. **Part B again depends entirely on the user**, the only person with a Windows machine, including access to a genuinely clean Windows state for the first-install check.

### Team Assignments

- **Dev Team 1:** All of it. Requirements 1–8.
- **Dev Team 2:** Not assigned. Requirements 1–5 are one coherent change to `install.js`'s file-handling core, and 6–7 are sequentially dependent on them — you cannot meaningfully verify a tarball before deciding what the installer puts in it. Splitting this manufactures a conflict in one file for no throughput gain. No worktree needed.

### Risks & Mitigations

- **An installer that deletes files is the most dangerous code in this repo.** A misclassified path or a bad prefix match could remove a user's work. *Mitigation:* deletion restricted to an explicit framework-owned list (Req 4), backed up before removal (Req 2), tested for the negative case (Req 8), and called out for QA1 as the highest-severity item in the sprint. If the classification cannot be made airtight, **ship the overwrite half and report stale files instead of deleting them** — a stale `state.js` is inert; a deleted user file is not.
- **Publishing is irreversible.** A bad publish cannot be recalled, only superseded, and the audience includes workshop students. *Mitigation:* Req 7's tarball verification happens before publish, and Pipeman owns the operation.
- **Misfiling `.claude/agents/**` as framework-owned would silently destroy customised personas** — plausible, since they *look* like framework files and this repo ships them. *Mitigation:* named explicitly in Req 1, in QA1's criteria, and in a LiveQA Part A check.
- **Windows again cannot be verified by the people writing the code**, exactly as in Sprint 1. *Mitigation:* Part B is a hard gate, and the first-install check requires a genuinely clean state — a machine already carrying a hand-fixed install cannot demonstrate that npx works for a new user.
- **The same class of gap could recur invisibly**, since nothing today detects that the published version has diverged from source. *Mitigation:* Req 6's git tag makes divergence visible. A CI check comparing published version to `package.json` is a reasonable follow-up sprint, deliberately not scoped here.
