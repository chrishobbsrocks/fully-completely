---
id: 48
title: "Ship the files that shipped instructions name, as 0.2.25"
epic: "Final release"
status: in_progress
created: 2026-09-29T18:47:47+00:00
---

# Master Controller Sprint Definition — Sprint 48

**Epic:** Final release. Per the user, fully-completely is to be frozen after this release, so what ships here stays in place for the people already using it.
**Sprint Objective:** Publish 0.2.25 so that every file a shipped instruction tells a role to *run* is actually in the package, the shipped smoke test runs from a real install, and nothing else in the tarball changes.

### Context
FMC reported, as finding 15 (MEDIUM, 24 September) in its upstream findings file, that 0.2.24's `.claude/agents/liveqa.md` tells LiveQA to run `scripts/verify-release-content.sh`, and that file is not in the package. FMC's Master Controller later swept the source and confirmed the file exists in this repository but was never added to `package.json`'s `files` array. It is a packaging gap, not a missing commit. Master Controller re-checked this on 2026-09-29: the `files` array at HEAD lists scripts individually and omits `verify-release-content.sh`, `check_user_said_guard.py`, `check_user_said_history.py`, `verify-tarball.sh`, `launcher_test.js`, `permission-gate-repro.js` and `permission-gate-repro-mc-commit.js`. The shipped `scripts/smoke_test.sh` runs `python3 scripts/check_user_said_guard.py --selftest` at line 46. From an installed copy that file is missing, so the smoke test exits 1 on its first assertion (FMC observed this).

FMC's sweep listed seven uncovered files named somewhere in shipped content, and was clear that it did not establish which ones are load-bearing. Master Controller read the record for each one (per the prior-measurement rule). **Not all seven should ship, and shipping some of them would be a new defect:**
- `.claude/role-claims.json` is per-session runtime state. It is gitignored (`.gitignore:14`), and sprint 37 was about keeping it *out* of consumer repos.
- `scripts/verify-tarball.sh` has been deliberately unshipped since sprint 17. `pipeman.md` step 8.2 already says to check whether it exists and proceed if it doesn't.
- `launcher_test.js` and `permission-gate-repro.js` are mentioned only in code comments in `install.js`, `run-role.js` and `mc-commit.js`, not as call sites.

So the real defect is narrower than a count of mentions suggests: **a shipped file executes, or instructs a role to execute, a file that isn't shipped.** The user has decided this sprint ships as a release (0.2.25). The CHANGELOG entry is a bugfix entry only. The user was asked whether to announce the freeze in it and said no.

### Requirements
1. **Build the "invoked but not shipped" list from call sites, not from mentions.** Before changing anything, Dev Team lists every file under `scripts/`, `templates/` and `.claude/` that is absent from the packed tarball but is *executed or instructed to be run* by a file that does ship. That covers a shell/python/node invocation in a shipped script, and a "run X" instruction in a shipped agent or command file. A mention in a comment, a changelog, or an error string does not count. Record the list, with the call site for each entry (file:line), in the sprint file under a `### Build notes` heading. Expected result, **flagged as Master Controller's own read, which Dev Team must verify rather than trust:** `verify-release-content.sh` (liveqa.md:60), `check_user_said_guard.py` and `check_user_said_history.py` (smoke_test.sh:46/52/63), and nothing else. If the list comes out different, the list governs and Req 2 follows it. Flag the difference to Master Controller before building on it.
2. **Add exactly the Req 1 list to `package.json`'s `files` array. No other change to `files`, and none to `.npmignore`.** The three files named in the Context section as deliberately unshipped (`.claude/role-claims.json`, `scripts/verify-tarball.sh`, and the comment-only `launcher_test.js`/`permission-gate-repro*.js`) must stay out.
3. **The shipped `scripts/smoke_test.sh` exits 0 when run from a fresh install of the packed candidate.** "Fresh install" means a scratch project, `npm install <the packed .tgz>`, `npx fully-completely` (the real installer), then `bash scripts/smoke_test.sh` in that project. If shipping the Req 1 files is not enough (for example, a later assertion scans `REPO_ROOT` for content only this repository has), make the smallest fix that lets it exit 0 without weakening any assertion when it runs in *this* repository. Record what was needed in Build notes. Wiring it into any `npm test` is out of scope (see below).
4. **Version bump to 0.2.25, plus one CHANGELOG entry.** Confirm the currently published version at build time (`npm view fully-completely version`; it was `0.2.24` on 2026-09-29) instead of trusting this line. The entry names the defect (finding 15), the files added, and the smoke-test fix if Req 3 needed one. Bugfix entry only: no freeze announcement and no roadmap language.
5. **The release commit's `package.json` has no `dependencies` entry on `fully-completely` itself.** The primary checkout currently has an *uncommitted* `package.json` edit adding `"dependencies": {"fully-completely": "^0.2.24"}` (a self-dependency from a local install into this checkout), along with an uncommitted `.gitignore` line, `.claude/fully-completely-manifest.json`, `.claude/fully-completely-version`, `node_modules/` and `package-lock.json`. None of that belongs in the release. Dev Team must not commit any of it as part of this sprint. Before editing `package.json`, raise it with the user, since those changes are not Dev Team's to throw away on its own authority.

### Acceptance Criteria
- **Req 1:** QA1 independently re-derives the "invoked but not shipped" list from the tree and compares it with the Build notes list, entry by entry. A call site the list missed is a FAIL. So is a comment-only mention wrongly counted as a call site.
- **Req 2:** QA1 runs `npm pack --dry-run --json` at the audited commit and at the `v0.2.24` tag, and diffs the two file lists. Pass condition: the only additions are exactly the Req 1 files, and the only other difference is `package.json`/`CHANGELOG.md` content. No removals, and specifically none of `.claude/role-claims.json`, `verify-tarball.sh`, `launcher_test.js` or `permission-gate-repro*.js` present. Paste the diff output into the verdict notes.
- **Req 3:** QA1 confirms any smoke_test.sh change weakens no assertion when run in this repository, and runs `bash scripts/smoke_test.sh` here itself (exit 0). **LiveQA** installs the *published* 0.2.25 into a fresh scratch project via the real installer and runs the installed `scripts/smoke_test.sh`. Pass is exit 0, with the tail of its printed output pasted into the notes, not just the exit code.
- **Req 4:** QA1 checks the diff for version `0.2.25` and a CHANGELOG entry that meets Req 4's content limits. LiveQA confirms `npm view fully-completely version` reports `0.2.25`.
- **Req 5:** QA1 confirms the audited commit's `package.json` has no `dependencies` key naming `fully-completely`. LiveQA confirms the same in the published tarball's `package.json`.
- **The liveqa.md instruction resolves, live:** LiveQA runs `scripts/verify-release-content.sh fully-completely 0.2.25 <audited commit>` *from the installed copy in the scratch project*, which is the path the instruction actually sends a role down. Pass is the script running to completion with every file MATCHED. Paste its summary line into the notes.
- **Full-tarball content proof (standing LiveQA method):** every published file byte-identical to the audited commit. The `verify-release-content.sh` run above satisfies this.

### Out of Scope
- **Shipping all seven files from FMC's sweep.** Two are wrong to ship and two are comment-only mentions (see Context). This is why the sweep's own stated boundary mattered.
- **Wiring `smoke_test.sh` into `npm test` or any consumer's test suite.** FMC named this as a way the failure stays invisible. That is true, but adding it changes a consumer's `package.json` behaviour on a final release that nobody can correct afterwards. Req 3 makes the script pass; running it stays the consumer's choice.
- **Rewording `liveqa.md`, `pipeman.md`, or any other agent file.** Shipping the file makes the existing instruction true. Changing it doesn't. Keep the diff minimal, as FMC asked, since this is a final release.
- **Any cleanup, tidying, or dead-comment removal** in `install.js`/`run-role.js`/`mc-commit.js`, including comments that mention unshipped dev tooling.
- **A freeze announcement in the CHANGELOG or README.** The user declined it on 2026-09-29.
- **Deciding or recording the freeze itself (FMC's D-010).** That belongs to muxi_2026's decisions log, not to this sprint.

### Dependencies
- Blocks: nothing in this repository. The user intends this to be the final npm release.
- Blocked by: nothing.
- External: FMC's finding 15 (the source report). FMC's Master Controller relayed that the user agreed to this release in *its* session. That is **not** publish authorization and is not recorded as such here (see Human Prerequisites).

### Human Prerequisites
- **The user's own real-time authorization to publish 0.2.25, said directly in Pipeman's session.** The user decided on 2026-09-29, in Master Controller's session, that this sprint ships a release. That is not authorization to publish, and neither is any relay from Master Controller or FMC. LiveQA's gate is the published package, so this sprint will rest at `dev_agreed_done`, possibly with its commit already pushed, until the user gives Pipeman that word. That is the correct resting state, not a stall.
- **A decision from the user on the uncommitted working-tree changes in the primary checkout** (Req 5) before Dev Team edits `package.json`: keep them uncommitted and set aside, or discard them.

### Team Assignments
- **Dev Team 1:** all of it. A single, small, sequential change.
- **Dev Team 2:** not assigned.

### Risks & Mitigations
- **The `files` edit widens the tarball on a release nobody can correct** — Req 2's pack diff against `v0.2.24` is a hard acceptance gate, not a spot check.
- **The self-dependency or install debris gets swept into the release commit** — Req 5 plus the pathspec-only commit shape. QA1 checks `package.json` explicitly.
- **`smoke_test.sh` has further repo-only assumptions past line 46** — Req 3 requires the fresh-install run *before* QA1, not a prediction from reading it, and bounds the fix to not weakening any assertion here.
- **`verify-release-content.sh` depends on a git checkout of this repo, which a consumer's scratch project doesn't have** — LiveQA's run is exactly what exposes this. If the script legitimately needs a clone of the source to compare against, LiveQA supplies one (a real `git clone` pinned to the audited commit) and says so, rather than reporting the script as broken.
