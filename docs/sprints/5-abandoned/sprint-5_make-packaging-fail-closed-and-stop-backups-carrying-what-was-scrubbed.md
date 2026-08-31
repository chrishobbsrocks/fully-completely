---
id: 5
title: "Make packaging fail-closed and stop backups carrying what was scrubbed"
epic: "Framework rules and distribution"
status: abandoned
created: 2026-08-29T00:00:00+00:00
---

# Master Controller Sprint Definition — Sprint 5

**Epic:** Framework rules and distribution — what leaves this repository should be what we chose to send, and an installed project should be able to tell the truth about what it still holds.
**Sprint Objective:** Replace the fail-open packaging denylist with an allowlist derived from what install.js actually reads, stop backup files from being committable in downstream projects, and tell an upgrading user which backups still exist.

> **LiveQA's gate is REDEFINED, not skipped**, on the same reasoning as sprints
> 3 and 4 and for the same mechanical reason — `/sprint-complete` hard-requires
> a LiveQA PASS (`sprint_lifecycle.py:688`), no skip flag, no override. The npm
> package is the deployed product. **"Live" here means a real
> `npx fully-completely` fresh install and a 0.1.4 → 0.1.5 upgrade against
> scratch directories.**
>
> **This sprint needs the live gate more than either predecessor.** Requirement 1
> changes what ships. If the allowlist omits something install.js reads, the
> tarball still packs cleanly, the diff still looks right, and installs break in
> a way no static read reveals. Sprint 4's own finding is the precedent: the
> backup file that carried the client name did not exist in the tarball, the
> diff, or anywhere at all until a real upgrade ran.

### Context

Two findings converge here, both from live runs rather than review. Sprint 4's LiveQA verified the client name is gone from `session.js` in an upgraded target, then found it alive next door: install.js backs up before replacing, so an upgraded project holds `scripts/launcher/session.js.fc-bak-0.1.3` at line 67 with the name intact. The `.gitignore` block install.js manages is `['docs/sprints/.locks/']` and matches nothing else, so a downstream project running `git add -A` commits it into its own history. Net exposure is unchanged — `session.js` was not ignored before the upgrade either — but the remediation now *looks* complete and is not, which is worse than visibly incomplete.

The second is older. `.npmignore` is a denylist with no `files` allowlist in `package.json`, so packaging fails open: anything new that lands outside its three patterns ships silently. Its own comments record that this repo's sprint history shipped to every install, unnoticed from the first publish until sprint 2 looked inside a tarball. It was deferred out of sprint 3 (verifying what ships while changing what ships makes the verification test the new mechanism) and out of sprint 4 (coupling a structural change to an urgent disclosure fix). Both deferrals were right, and both reasons are now spent: this is the sprint where the packaging mechanism is the subject rather than the confound.

### Requirements

1. **Add a `files` allowlist to `package.json`, derived from what `install.js` actually reads — not from a directory listing.** Read the installer's own source-path handling and build the allowlist from the paths it copies, merges, and seeds. A list assembled by looking at the repo will drift from a list assembled from the code the moment either changes, and only one of those is the real dependency.

   **1a. Reconcile it with `.npmignore` explicitly; the two must not silently fight.** `files` and `.npmignore` both apply, with different precedence, and the current `.npmignore` does something the allowlist cannot express on its own: it ships the `docs/sprints/` phase-folder skeleton (the `.gitkeep` placeholders install.js needs to seed a target) while excluding every piece of real sprint content inside it. Whatever combination is chosen, **state the reasoning in a comment or in `.npmignore`'s existing comment block**, and prove the outcome by inspecting a packed tarball rather than by reasoning about precedence rules.

   **1b. The allowlist must be complete before it is minimal.** An over-inclusive allowlist ships something unnecessary; an under-inclusive one breaks installs. Those are not symmetrical failures. Where a path is genuinely uncertain, include it and note it, rather than trimming and hoping the tests notice.

2. **Add `*.fc-bak-*` to the `.gitignore` block `install.js` manages.** `BACKUP_MARKER` is `.fc-bak-` (`install.js:115`) and the managed block is currently `['docs/sprints/.locks/']`. Backup files should never be committed by any project, which makes this correct independently of the disclosure that surfaced it.

   **2a. It merges, it does not overwrite.** `.gitignore` is in the installer's MERGED category; a target's own unrelated ignore rules stay untouched, exactly as the existing block behaves.

3. **Report surviving backup files at the end of an install run.** After an upgrade, list any `*.fc-bak-*` files present in the target, with a plain statement that they hold the previous version's content and can be deleted once the user is satisfied with the upgrade.

   **3a. Report only. Delete nothing, ever.** Backups exist so people can recover; removing them is a different risk class and is explicitly not in this sprint. The report closes the gap sprint 4 found, where a user greps the scrubbed file, sees it clean, and reasonably concludes they are done.

   **3b. This must cover backups from *earlier* versions, not only ones created by this run.** A project that upgraded to 0.1.4 already holds a `.fc-bak-0.1.3` file and will get no new one from a clean 0.1.5 upgrade. Reporting only this run's backups would miss precisely the population this requirement exists for.

4. **Bump `package.json` to 0.1.5.** One line beyond Requirement 1's `files` addition to the same file.

5. **The published tarball contains none of this repo's own sprint content**, on the same terms as sprints 3 and 4 — and this round it carries more weight than either, because Requirement 1 changes the mechanism that produces it. A passing result from a previous release is not evidence about this one.

6. **Nothing else changes.** No lifecycle script changes, no `CLAUDE.md` changes, no agent-file changes, no changes to `session.js`.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- Req 1: `package.json` has a `files` array. **Confirm it was derived from `install.js`'s source handling** by reading that code and checking every path the installer reads is covered — a review that only compares the array against a directory listing has not verified this requirement.
- Req 1a: the reasoning for the `files`/`.npmignore` interaction is written down where the next person will find it. **Verified by tarball inspection, not by precedence reasoning.**
- Req 1b: any path included out of caution is noted as such.
- Req 2: the managed block in `mergeGitignore()` includes `*.fc-bak-*`. Req 2a: confirm by reading the merge logic that unrelated existing lines in a target's `.gitignore` are preserved — the existing block already behaves this way, so this is a check that the change did not alter it.
- Req 3: the report exists in the installer's output path. Req 3a: **grep the diff for any deletion of a `*.fc-bak-*` path** — there must be none. Req 3b: confirm by reading the code that the scan finds pre-existing backups from any version, not only files written during the current run.
- Req 4: `package.json` version is `0.1.5`.
- **Req 5: run `scripts/verify-tarball.sh`** and read the result. Confirm `docs/sprints/` in the tarball holds only the `.gitkeep` placeholders — no `registry.json`, no `state/*.json`, no sprint markdown, no `.claude/settings.local.json`. **Additionally confirm the tarball still contains every path install.js needs**, which is the new failure mode this sprint introduces. If sprint content appears, FAIL not CONDITIONAL.
- Req 6: the cumulative diff is confined to `package.json`, `scripts/install.js`, and `docs/sprints/` bookkeeping.
- `node scripts/launcher_test.js` passes. QA1 runs it.

**LiveQA verifies live, after Pipeman publishes:**

- **Confirm 0.1.5 is on the registry** and its `gitHead` matches `last_shipped_commit`, established from `npm view` rather than from a handoff.
- **Fresh install into a clean scratch directory.** This is the criterion the allowlist most endangers: an under-inclusive `files` array produces a package that packs and publishes cleanly and then installs a broken project. Confirm the install completes and the target contains a working framework — the `docs/sprints/` phase skeleton, `scripts/launcher/`, `templates/`, `.claude/commands/`.
- **Upgrade for real, 0.1.4 → 0.1.5.** Confirm it completes and prints the correct version transition.
- **`.gitignore` in the upgraded target contains `*.fc-bak-*`**, and the target's own pre-existing unrelated ignore lines are still present. Plant an unrelated line before upgrading so this is proven rather than assumed.
- **The backup report appears and is accurate.** Plant a `*.fc-bak-0.1.3` file in the target before upgrading, then confirm the report names it — Req 3b's case. Confirm the file is **still on disk afterwards**; a report that quietly deletes fails Req 3a.
- **Confirm no sprint data landed in the target**, independently of QA1's tarball check.

### Out of Scope

- **Deleting or cleaning up backup files.** Req 3a. Report only. If automatic cleanup is ever wanted it is a separate decision with a separate risk profile, made deliberately rather than as a convenience bolted onto a reporting change.
- **Removing the client name from backups already on disk in existing projects.** Not reachable from here — those are local files in projects we cannot see. Requirements 2 and 3 are what make them visible and non-committable; the rest is the project owner's call, which is the correct place for it.
- **Unpublishing or deprecating 0.1.2 and 0.1.3.** Unchanged from sprint 4: past npm's unpublish window, and deprecation adds a warning without removing content. Still a separate decision if wanted.
- **Changing `install.js`'s file-category taxonomy** so user-owned framework rules reach existing installs. Still the deeper half of this epic's distribution problem — `CLAUDE.md` and `.claude/agents/` never upgrade, so sprint 3's rules reach fresh installs only. Still its own sprint.
- **Fixing CLAUDE.md's own-tooling clause**, still wrong about LiveQA not applying here. Fourth sprint in a row working around it. It has earned its own sprint and should get one soon.
- **Extending the sprint template's "verified how?" prompt beyond the Requirements section.** Real and cheap, and deliberately not here: this sprint's theme is what leaves the repository, and planning-discipline changes are a different concern. See the follow-up note.
- **The uncommitted `.vscode/settings.json` change.** Still unrelated, still in the working tree, still leave it alone.

### Dependencies

- **Blocks:** Nothing downstream is waiting on this. It is preventive rather than urgent, which is why it was correctly deferred twice.
- **Blocked by:** **Sprint 4 reaching completion.** 0.1.4 must be closed and live before 0.1.5 is built on it, or the upgrade test has no stable baseline. Dev Team should not run `/sprint-start 5` until sprint 4 is closed.
- **External:** The npm publish is Pipeman's. As of this sprint, `pipeman.md` **does** describe it — sprint 4's Req 3 landed and sprint 4's release reached the registry without anyone being told directly. This is the first sprint in the epic where that dependency is genuinely in role rather than carried by hand.

### Team Assignments

- **Dev Team 1:** All of it. Two files and a version bump; the three requirements interact through `install.js` and the tarball.
- **Dev Team 2:** Not assigned. No parallelisable surface, and a second checkout racing `package.json` would collide immediately.

### Risks & Mitigations

- **The allowlist is under-inclusive and installs break.** The highest risk in this sprint and the one most likely to reach a user, because it produces a package that passes every static check and then fails in someone's project. *Mitigation:* Req 1 requires deriving the list from `install.js` rather than from a listing; Req 1b makes complete-before-minimal explicit; QA1's Req 5 check adds "contains every path install.js needs"; and LiveQA's fresh-install criterion exists specifically for this.
- **`files` and `.npmignore` interact in a way nobody reasoned about correctly.** Precedence between the two is subtle, and the current `.npmignore` does something non-obvious — ships a folder skeleton while excluding its contents. *Mitigation:* Req 1a forbids settling it by reasoning; the tarball is the evidence.
- **The backup report misses the population it exists for.** Reporting only backups created during the current run would skip every project that upgraded to 0.1.4 — the exact users this addresses. *Mitigation:* Req 3b, and a LiveQA criterion that plants a pre-existing backup rather than relying on one being created.
- **The report grows into cleanup.** "It would be helpful to just remove them" is a small step from here and a different risk class entirely. *Mitigation:* Req 3a, plus an acceptance criterion that greps the diff for deletions.
- **Coupling three changes to one release delays the small ones.** Requirement 1 is structural and the likeliest to take rounds; 2 and 3 are small and complete sprint 4's remediation. *Mitigation:* explicit descope path — **if Requirement 1 has not passed QA1 by round 2, drop it and ship Requirements 2–6 as 0.1.5.** The allowlist then gets its own sprint. Master Controller's call, not Dev Team's, and a scope decision rather than a failure. Note this reverses sprint 3's descope, where the structural item was kept and the doc edits were droppable.
- **Requirement 2 helps nobody already on 0.1.4 until they upgrade again.** Unavoidable — an ignore rule can only arrive with an install. *Mitigation:* Requirement 3's report is what covers the interim, which is why the two belong in the same sprint.

### Follow-up, not this sprint

Two carried forward, both real, neither belonging here:

- **A full disclosure sweep of everything the package ships.** Raised in sprint 4 and still unscheduled. The client name surfaced because one auditor read one file. Every framework-owned path deserves a scoped pass for real paths, names, credentials and machine-specific detail, rather than being found one comment at a time.
- **The "verified how?" prompt covers Requirements only.** Across sprints 3–4, Master Controller made four assertions about tool behaviour without measuring them, and three of the four were in Context, Dependencies, or Risks — sections the prompt does not reach. Every one was catchable with a single command. Worth extending the template, and worth someone other than Master Controller deciding how.
