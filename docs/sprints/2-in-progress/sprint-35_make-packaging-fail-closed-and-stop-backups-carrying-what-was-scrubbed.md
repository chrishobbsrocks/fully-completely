---
id: 35
title: "Make packaging fail-closed, and stop backups carrying what was scrubbed"
epic: "Framework rules and distribution"
status: in_progress
created: 2026-09-10T16:35:33+00:00
---

# Master Controller Sprint Definition — Sprint 35

**Epic:** Framework rules and distribution — what leaves this repository should
be what we chose to send, and an installed project should be able to tell the
truth about what it still holds.
**Sprint Objective:** Replace the fail-open packaging denylist with an
allowlist derived from what `install.js` actually reads, stop backup files from
being committable in downstream projects, and tell an upgrading user which
backups still exist.

### Context

This is a re-file of sprint 5, abandoned on 29 August after being deferred out
of sprints 3 and 4 for reasons that were correct at the time and expired thirty
sprints ago. Its three findings were re-verified today and all three are still
live: `package.json` has no `files` array, the managed `.gitignore` block is
still `['docs/sprints/.locks/']` with no `*.fc-bak-*`, and no install run
reports surviving backups.

The intervening six months produced the evidence the original sprint could only
predict. `.npmignore` has grown from three patterns to ten. Every entry past the
original three is someone noticing, after the fact, that something would
otherwise ship — including `docs/sprint-22-disclosure-sweep.md`, added by the
very sprint that swept for disclosures. A denylist that requires a human to
remember it on every new file is fail-open by construction, and the patch
history is the proof. Sprint 2 found this repository's entire sprint history had
been shipping to every install, unnoticed from the first publish.

The backup finding is sprint 4's, unclosed. `install.js` backs up before
replacing, so an upgraded project holds `<file>.fc-bak-<version>` carrying the
previous version's content. The managed ignore block does not cover it, so a
downstream project running `git add -A` commits it into its own history. Sprint
4's LiveQA verified a client name was gone from `session.js` and then found it
alive next door in exactly such a backup. Net exposure was unchanged, but the
remediation *looked* complete and was not, which is worse than visibly
incomplete.

Two things have changed since the original file was written and both remove
work from it. Sprint 22 ran the full disclosure sweep it listed as a follow-up.
Sprint 20 fixed CLAUDE.md's own-tooling clause, so the long banner the original
carried — arguing that LiveQA's gate is redefined rather than skipped — is now
just what CLAUDE.md says, and is not repeated here.

### Requirements

1. **Add a `files` allowlist to `package.json`, derived from what `install.js`
   actually reads — not from a directory listing.** Read the installer's own
   source-path handling and build the allowlist from the paths it copies,
   merges, and seeds. A list assembled by looking at the repo will drift from a
   list assembled from the code the moment either changes, and only one of
   those is the real dependency.

   **1a. Reconcile it with `.npmignore` explicitly; the two must not silently
   fight.** Both apply, with different precedence, and the current `.npmignore`
   does something the allowlist cannot express on its own: it ships the
   `docs/sprints/` phase-folder skeleton (the `.gitkeep` placeholders
   `install.js` needs to seed a target) while excluding every piece of real
   sprint content inside it. State the reasoning where the next person will
   find it, and prove the outcome by inspecting a packed tarball rather than by
   reasoning about precedence rules.

   **1b. The allowlist must be complete before it is minimal.** An
   over-inclusive allowlist ships something unnecessary; an under-inclusive one
   breaks installs. Those are not symmetrical failures. Where a path is
   genuinely uncertain, include it and note it, rather than trimming and hoping
   the tests notice.

2. **Add `*.fc-bak-*` to the `.gitignore` block `install.js` manages.**
   `BACKUP_MARKER` is `.fc-bak-` and the managed block is currently
   `['docs/sprints/.locks/']`. Backup files should never be committed by any
   project, which makes this correct independently of the disclosure that
   surfaced it.

   **2a. It merges, it does not overwrite.** `.gitignore` is in the installer's
   MERGED category; a target's own unrelated ignore rules stay untouched,
   exactly as the existing block behaves.

3. **Report surviving backup files at the end of an install run.** List any
   `*.fc-bak-*` files present in the target, with a plain statement that they
   hold the previous version's content and can be deleted once the user is
   satisfied with the upgrade.

   **3a. Report only. Delete nothing, ever.** Backups exist so people can
   recover; removing them is a different risk class and is explicitly not in
   this sprint.

   **3b. This must cover backups from *earlier* versions, not only ones created
   by this run.** A project that upgraded months ago already holds a
   `.fc-bak-<old>` file and will get no new one from a clean upgrade. Reporting
   only this run's backups would miss precisely the population this requirement
   exists for.

4. **Bump `package.json` to 0.2.8.** The current published version is 0.2.7;
   confirm that is still true at build time rather than trusting this line,
   since this repository has shipped several releases in a single day.

5. **The published tarball contains none of this repository's own sprint
   content**, and carries more weight this round than in any previous sprint,
   because Requirement 1 changes the mechanism that produces it. A passing
   result from a previous release is not evidence about this one.

6. **Nothing else changes.** No lifecycle script changes, no `CLAUDE.md`
   changes, no agent-file changes.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1** — `package.json` has a `files` array. Confirm it was derived from
  `install.js`'s source handling by reading that code and checking every path
  the installer reads is covered. A review that only compares the array against
  a directory listing has not verified this requirement.
- **Req 1a** — the `files`/`.npmignore` reasoning is written down where the next
  person will find it. Verified by tarball inspection, not by precedence
  reasoning.
- **Req 1b** — any path included out of caution is noted as such.
- **Req 2** — the managed block in the gitignore merge includes `*.fc-bak-*`.
  **Req 2a** — confirm by reading the merge logic that unrelated existing lines
  in a target's `.gitignore` are preserved. The existing block already behaves
  this way, so this checks the change did not alter it.
- **Req 3** — the report exists in the installer's output path. **Req 3a** —
  grep the diff for any deletion of a `*.fc-bak-*` path; there must be none.
  **Req 3b** — confirm by reading the code that the scan finds pre-existing
  backups from any version, not only files written during the current run.
- **Req 4** — the version is one above what is currently published.
- **Req 5** — run `scripts/verify-tarball.sh` and read the result. Confirm
  `docs/sprints/` in the tarball holds only the `.gitkeep` placeholders — no
  `registry.json`, no `state/*.json`, no sprint markdown, no
  `.claude/settings.local.json`. **Additionally confirm the tarball still
  contains every path `install.js` needs**, which is the new failure mode this
  sprint introduces. If sprint content appears, FAIL not CONDITIONAL.
- **Req 6** — the cumulative diff is confined to `package.json`,
  `scripts/install.js`, `.npmignore`, and `docs/sprints/` bookkeeping.
- `node scripts/launcher_test.js` passes. QA1 runs it.

**LiveQA verifies live, after Pipeman publishes:**

- Confirm the new version is on the registry and its `gitHead` matches
  `last_shipped_commit`, established from `npm view` rather than from a handoff.
- **Fresh install into a clean scratch directory.** This is the criterion the
  allowlist most endangers: an under-inclusive `files` array produces a package
  that packs and publishes cleanly and then installs a broken project. Confirm
  the install completes and the target contains a working framework — the
  `docs/sprints/` phase skeleton, `scripts/launcher/`, `templates/`,
  `.claude/commands/`.
- **Upgrade for real**, from the previously published version. Confirm it
  completes and prints the correct version transition.
- **`.gitignore` in the upgraded target contains `*.fc-bak-*`**, and the
  target's own pre-existing unrelated ignore lines are still present. Plant an
  unrelated line before upgrading so this is proven rather than assumed.
- **The backup report appears and is accurate.** Plant a `*.fc-bak-<old>` file
  in the target before upgrading, then confirm the report names it — Req 3b's
  case. Confirm the file is **still on disk afterwards**; a report that quietly
  deletes fails Req 3a.
- **Confirm no sprint data landed in the target**, independently of QA1's
  tarball check.

### Out of Scope

- **Deleting or cleaning up backup files.** Req 3a. Report only. Automatic
  cleanup is a separate decision with a separate risk profile, made
  deliberately rather than bolted onto a reporting change.
- **Removing content from backups already on disk in existing projects.** Not
  reachable from here — those are local files in projects nobody here can see.
  Requirements 2 and 3 make them visible and non-committable; the rest is the
  project owner's call, which is the right place for it.
- **Unpublishing or deprecating old versions.** Past npm's unpublish window,
  and deprecation adds a warning without removing content. A separate decision
  if wanted.
- **Changing `install.js`'s file-category taxonomy so user-owned files upgrade.**
  Still the deeper half of this epic's distribution problem, and now better
  characterised than when sprint 5 named it: sprint 32's LiveQA established the
  determinant is *touched versus untouched*, not fresh versus upgrade — an
  untouched user-owned file does receive updates; a customised one does not.
  Its own sprint, still open.
- **The installer naming a conflict without naming what did not arrive.** The
  other open item from that same finding. Related, deliberately separate.
- **The permission anchor being six CLI versions behind.** Unrelated to
  packaging; still open; its own sprint.
- **Extending the sprint template's prompts.** Real, cheap, and deliberately
  not here — this sprint's subject is what leaves the repository, not planning
  discipline. Being handled as a direct change to this framework's own tooling.
- **The uncommitted `.vscode/settings.json` change.** Still unrelated, still in
  the working tree, still leave it alone.

### Dependencies

- **Blocks:** nothing downstream is waiting on this. It is preventive rather
  than urgent, which is why it was correctly deferred twice — and why it then
  sat abandoned for thirty sprints, which was not correct.
- **Blocked by:** nothing. Sprint 5's original blocker, sprint 4, closed long
  ago. Sprints 31 through 34 are all closed and landed on main.
- **External:** the npm publish is Pipeman's, and `pipeman.md` describes it.

### Team Assignments

- **Dev Team 1:** all of it. Two files and a version bump; the three
  requirements interact through `install.js` and the tarball.
- **Dev Team 2:** not assigned. No parallelisable surface, and a second
  checkout racing `package.json` would collide immediately.

### Risks & Mitigations

- **The allowlist is under-inclusive and installs break.** The highest risk
  here and the one most likely to reach a user, because it produces a package
  that passes every static check and then fails in someone's project — and this
  framework is installed by workshop attendees who have no way to diagnose it.
  *Mitigation:* Req 1 derives the list from `install.js` rather than a listing;
  Req 1b makes complete-before-minimal explicit; QA1's Req 5 check adds
  "contains every path install.js needs"; LiveQA's fresh-install criterion
  exists specifically for this.
- **`files` and `.npmignore` interact in a way nobody reasoned about
  correctly.** Precedence is subtle, and the current `.npmignore` ships a
  folder skeleton while excluding its contents. *Mitigation:* Req 1a forbids
  settling it by reasoning; the tarball is the evidence.
- **The backup report misses the population it exists for.** Reporting only
  backups created during the current run would skip every project that upgraded
  earlier — the exact users this addresses. *Mitigation:* Req 3b, and a LiveQA
  criterion that plants a pre-existing backup rather than relying on one being
  created.
- **The report grows into cleanup.** "It would be helpful to just remove them"
  is a small step from here and a different risk class. *Mitigation:* Req 3a,
  plus an acceptance criterion that greps the diff for deletions.
- **Coupling three changes to one release delays the small ones.**
  Requirement 1 is structural and likeliest to take rounds; 2 and 3 are small
  and close sprint 4's remediation. *Mitigation:* explicit descope path — **if
  Requirement 1 has not passed QA1 by round 2, drop it and ship Requirements
  2–6.** The allowlist then gets its own sprint. Master Controller's call, not
  Dev Team's, and a scope decision rather than a failure.
- **Requirement 2 helps nobody already installed until they upgrade again.**
  Unavoidable — an ignore rule can only arrive with an install. *Mitigation:*
  Requirement 3's report covers the interim, which is why the two belong in the
  same sprint.
