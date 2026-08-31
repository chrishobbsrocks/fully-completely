---
id: 6
title: "Upgrade untouched user-owned files instead of never upgrading them"
epic: "Framework rules and distribution"
status: done
created: 2026-08-29T00:00:00+00:00
---

# Master Controller Sprint Definition — Sprint 6

**Epic:** Framework rules and distribution — the rules this framework defines have to reach the people running it, including the ones who installed months ago.
**Sprint Objective:** Record what the installer wrote, so an upgrade can tell a customised user-owned file from an untouched one, and update the untouched ones instead of protecting a customisation that was never made.

> **LiveQA's gate is REDEFINED, not skipped**, same as sprints 3–5 and for the
> same mechanical reason — `/sprint-complete` hard-requires a LiveQA PASS
> (`sprint_lifecycle.py:688`), no skip flag, no override. **"Live" here means
> real `npx fully-completely` installs and upgrades against scratch
> directories**, with files deliberately modified beforehand so the branch that
> must never fire can be observed not firing.
>
> This sprint's central risk is a *silent* wrong answer: overwriting a file
> somebody customised. No diff shows that. Only an upgrade run against a
> planted, modified target does.

### Context

`install.js` sorts every path into FRAMEWORK_OWNED (overwritten on upgrade, backed up), USER_OWNED (never overwritten, conflict reported), or MERGED. `USER_OWNED = ['.claude/agents', 'CLAUDE.md', 'docs/sprints']`. That means **every rule this framework defines about how its roles behave cannot reach a project that has already installed it.** Sprint 3 shipped the FAIL-demonstration standard into `qa1.md` and the transition-precondition rule into `CLAUDE.md`; both reach fresh installs only. An external team running this framework for two weeks reported the verified-how prompt missing, and they were right — it reached them only because `templates/` happens to be framework-owned. Had it been an agent-file change, no upgrade would ever have delivered it.

The category is not wrong. Agent personas and a project's own standards genuinely are the user's, and clobbering them would be worse than the problem. But "never overwrite" protects a customisation that, in most installs, was never made — `.claude/agents/` is shipped prose that many projects never touch. The installer has no way to tell the two cases apart because it records nothing about what it wrote. `.claude/fully-completely-version` records *which release* is installed; nothing records *what the files looked like* when it installed them. This sprint adds that, and nothing else.

### Requirements

1. **Record a manifest of the user-owned files the installer writes.** On every install and upgrade, after writing user-owned files, record a content hash per file in a framework-owned location alongside `.claude/fully-completely-version`. The manifest is the installer's record of what it put there, not a record of what is there now.

2. **On upgrade, use the manifest to decide per file.**
   - Installed file's current hash **matches** the manifest → the user never touched it → **overwrite with the new version, backing up first**, exactly as FRAMEWORK_OWNED already does.
   - Current hash **differs** → the user customised it → **do not overwrite.** Report a conflict, as today.

3. **No manifest entry means never overwrite. This is the safety-critical requirement.**
   Every project installed before this release has no manifest. If a missing entry is read as "unchanged," the first 0.1.5 upgrade silently destroys every customisation in every existing install. **Absence of evidence must resolve to the conservative branch, always** — no manifest entry, unreadable manifest, malformed entry, or hash mismatch on the manifest file itself all mean "treat as customised, do not overwrite." Build it so the dangerous branch requires positive proof rather than the safe branch requiring it.

4. **The conflict report says what changed upstream, not just that the file differs.** A user who is told `qa1.md` differs from upstream learns nothing actionable; the external team's whole failure was not knowing a rule existed. Name the file, state that upstream changed it since their installed version, and point at how to see the difference. Wording is Dev Team's; the requirement is that a reader can act on it without already knowing what changed.

5. **Apply the mechanism uniformly to `.claude/agents/` and `CLAUDE.md`.** The logic is identical. `CLAUDE.md` will benefit less in practice — the file explicitly invites project standards below a marked line, so most installs modify it and will land on the conflict branch. That is correct behaviour, not a shortfall, and the hard-marker approach that would let `CLAUDE.md` merge is a separate sprint.

6. **`docs/sprints` is excluded from the mechanism.** Only `SPRINT_SKELETON_FILES` is ever sourced from this repo, and a target's real sprint content is never written by the installer, so there is nothing to compare and nothing to upgrade. Leave that special case exactly as it is.

7. **Bump `package.json` to 0.1.5.** One line.

8. **Test coverage in `scripts/launcher_test.js`**, following the existing file's conventions. Cover at minimum: manifest written on first install; unchanged file upgraded and backed up; modified file preserved and reported; **missing manifest resolves to no-overwrite**; malformed manifest resolves to no-overwrite.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- Req 1: the manifest is written on both install and upgrade paths, in a framework-owned location, with a hash per user-owned file the installer wrote.
- Req 2: read the branch and confirm the match case overwrites *and backs up* — an overwrite without a backup is a regression against how FRAMEWORK_OWNED already behaves.
- **Req 3: the load-bearing check.** Trace every path by which the decision can be reached — no manifest file, file present but no entry for this path, unparseable JSON, entry present but malformed — and confirm each lands on no-overwrite. **If any path reaches "overwrite" without a positive hash match, this is a FAIL, not a CONDITIONAL.** State in the notes which paths were traced, so the next auditor can check the same list rather than re-deriving it.
- Req 4: read the conflict message cold, as someone who does not know what changed. If it does not tell them upstream moved and how to see what moved, it fails.
- Req 5: both `.claude/agents/` and `CLAUDE.md` go through the same code path.
- Req 6: `git diff` shows the `docs/sprints` special case unchanged.
- Req 7: `package.json` version is `0.1.5`, one-line diff.
- Req 8: `node scripts/launcher_test.js` passes and covers all five listed cases. **QA1 runs it, not just reads it.**
- Run `scripts/verify-tarball.sh`: `docs/sprints/` in the tarball holds only the `.gitkeep` placeholders, and the tarball still contains every path install.js needs. Sprint content appearing is a FAIL.

**LiveQA verifies live, after Pipeman publishes:**

- **Confirm 0.1.5 is on the registry** and its `gitHead` matches `last_shipped_commit`, established from `npm view` rather than a handoff.
- **The branch that must never fire.** Install 0.1.4 into a scratch directory, **edit `.claude/agents/qa1.md`** (add a recognisable sentinel line), then upgrade to 0.1.5. The sentinel must still be there afterwards, and the run must report a conflict naming the file. This is the case that destroys user work if Req 3 is wrong, and 0.1.4 has no manifest at all, so it exercises Req 3 directly.
- **The branch that must fire.** Install 0.1.5 fresh, confirm the manifest exists, leave `qa1.md` untouched, then upgrade to a build with a changed `qa1.md`. Confirm it updated, that a backup of the previous version exists, and that the change is present in the installed copy. If a second published version isn't available to upgrade to, say so plainly in the notes and record what was and wasn't demonstrated rather than inferring it.
- **`CLAUDE.md` on a real upgrade.** With project standards added below the marked line, confirm it is preserved and reported, not overwritten.
- **Fresh install still works** — the manifest write must not break a first install.
- **Confirm no sprint data landed in the target.**

### Out of Scope

- **A hard framework/user marker in `CLAUDE.md`** so its framework half can merge like `.gitignore` does. The natural next sprint, and deliberately not this one: it needs a delimiter that does not exist in any installed copy yet, which is a migration problem on top of a merge problem. This sprint gets `CLAUDE.md` onto the mechanism; that one makes it useful.
- **Merging prose inside agent files.** Same reason, worse: there is no boundary in them at all. They are framework-authored personas end to end. Whole-file compare is the honest granularity available today.
- **The `files` allowlist in `package.json`.** Shelved with sprint 5. Preventive, and the known hole it closes is already plugged by `.npmignore`.
- **`*.fc-bak-*` in the managed `.gitignore`, and reporting stale backups.** Also shelved with sprint 5. Note this sprint *creates more backups* by design, which strengthens the case for picking them back up afterwards — but bundling them here would mix a safety-critical change with hygiene.
- **Fixing CLAUDE.md's own-tooling clause**, still wrong about LiveQA not applying here. Fifth sprint working around it.
- **The full disclosure sweep** of everything the package ships. Still unscheduled since sprint 4.
- **The uncommitted `.vscode/settings.json` change.** Still unrelated, leave it alone.

### Dependencies

- **Blocks:** Every rule this framework adds to an agent file or `CLAUDE.md` continues to reach fresh installs only until this ships. That includes both of sprint 3's additions.
- **Blocked by:** **Sprint 4 closed, and sprint 5 shelved** (`/sprint-abort 5`). 0.1.4 must be the live baseline, since LiveQA's first upgrade test starts from it precisely because it has no manifest.
- **External:** The npm publish is Pipeman's and is now described in `pipeman.md` — sprint 4's Req 3 landed and its release reached the registry without anyone being told by hand.

### Team Assignments

- **Dev Team 1:** All of it. One file, one mechanism, one release.
- **Dev Team 2:** Not assigned. Single-file change with a safety-critical branch; a second engineer here adds coordination cost and no parallelism.

### Risks & Mitigations

- **The safe/dangerous branches get inverted and an upgrade destroys customised agent files and project standards.** By far the worst outcome available in this sprint, it lands in other people's repositories, and it is silent — the user finds out when their customisation is gone. *Mitigation:* Req 3 states it as positive-proof-required; QA1's criterion enumerates the paths and makes it a FAIL rather than a CONDITIONAL; Req 8 tests the missing and malformed cases; and LiveQA's first live check upgrades from 0.1.4, which has no manifest, with a planted sentinel.
- **The manifest and reality drift.** It records what the installer wrote, not what is there now, which is the point — but a bug that refreshes it at the wrong moment (say, on read rather than on write) would mark a customised file as untouched and clear the way to overwrite it. *Mitigation:* Req 1 fixes the write points to install and upgrade only; QA1 should confirm no other code path writes it.
- **A user edits a file, then edits it back.** They land on the untouched branch and get an upgrade they might not expect. *Mitigation:* accepted. The file is byte-identical to what we shipped; upgrading it loses nothing, and the backup is there regardless.
- **The conflict report is technically correct and practically useless.** The failure that started this epic was somebody not knowing a rule existed, and "this file differs" reproduces it. *Mitigation:* Req 4, with an acceptance criterion read cold rather than checked for presence.
- **More backups accumulate**, since this sprint makes upgrades write them for files that previously were never replaced. *Mitigation:* none here, deliberately. It strengthens the case for the shelved sprint-5 items and is noted in Out of Scope rather than absorbed.
- **Scope pull toward the `CLAUDE.md` marker**, which is the change that would make this genuinely complete. *Mitigation:* it stays out. This sprint is a safety-critical branch in someone else's repository; it should do one thing and be checkable.
