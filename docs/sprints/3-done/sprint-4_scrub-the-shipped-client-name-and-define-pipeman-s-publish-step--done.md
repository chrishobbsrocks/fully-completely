---
id: 4
title: "Scrub the shipped client name and define Pipeman's publish step"
epic: "Framework rules and distribution"
status: done
created: 2026-08-28T19:24:33+00:00
---

# Master Controller Sprint Definition — Sprint 4

**Epic:** Framework rules and distribution — the rules this framework defines have to actually reach the people installing it, and what reaches them must not contain things that were never meant to ship.
**Sprint Objective:** Remove a real client's project name from a framework-owned file that installs into every target, and write the npm publish step into Pipeman's role so a release stops meaning "pushed to git."

> **LiveQA's gate is REDEFINED, not skipped**, on the same reasoning as sprint 3
> and for the same mechanical reason — `/sprint-complete` hard-requires a LiveQA
> PASS at `sprint_lifecycle.py:688`, no skip flag, no override. The npm package
> is a deployed product. **"Live" here means a real `npx fully-completely`
> upgrade from 0.1.3 to 0.1.4 against a scratch directory.**
>
> This sprint has an unusually clean live test, and it is the whole point:
> `scripts/launcher/` is **framework-owned**, so install.js overwrites it on
> upgrade. The scrub therefore *should* propagate to existing installs, and
> LiveQA can prove it by grepping the upgraded target. That is a real
> verification, not a formality — sprint 3 established that a shipped file
> reaching a target is not something a diff can demonstrate.

> **SHIPPING TAKES TWO ACTIONS.** `git push` does not update `npx`;
> `npx fully-completely` resolves from the npm registry. This sprint is not
> shipped until **`npm publish`** has run and the registry serves 0.1.4.
> Requirement 3 exists so this stops being folklore.

### Context

QA1's sprint 3 audit escalated an issue it correctly declined to block on. `scripts/launcher/session.js:67` carries a real client project name — `~/Programming/Licenseprofessor Edits and fixes` — plus a count of how many directories on this machine contain spaces, inside an otherwise excellent comment documenting how the Claude CLI encodes session directory paths. `scripts/launcher/` is framework-owned, so install.js writes it into every target and overwrites it on every upgrade. QA1 demonstrated this by installing the actual tarball into a scratch directory rather than reasoning from the file list. It has been public in 0.1.2 since 17 August and is republished in 0.1.3; it is pre-existing rather than a regression, which is why it was a scope call for Master Controller and not a sprint 3 blocker.

The second item is the gap that stalled sprint 3. Pipeman shipped `89c8a74` to git and the release reached nobody, because `.claude/agents/pipeman.md` contains no mention of npm, publish, registry or release — verified by grep, zero hits. Pipeman did exactly what its role file defines. That is the same failure this epic exists to fix, and it has now occurred three times: the retro edits in `192de1d`, sprint 3's own release, and it will recur on every release until the step is written down.

### Requirements

1. **Remove the client project name and the machine-specific directory count from `scripts/launcher/session.js`.** Replace the worked example with a synthetic path that demonstrates the same characters (a space, a dot, parentheses, consecutive spaces) without naming a real project or counting real directories on anyone's machine.

   **1a. Preserve the comment's evidentiary content. This is not a deletion.** The comment is good and it is the reason the encoding rule is trustworthy — it records that the rule was derived empirically, re-verified three ways, and that the Windows case is an extrapolation rather than a confirmed fact. **Only the identifying specifics change.** A scrub that flattens it into "paths are encoded" destroys the thing that made it worth keeping and fails this requirement.

   **1b. The scrubbed comment must not claim more than the evidence supports.** After the edit, re-read it as a stranger would: it may still say the rule was verified by hand against real session directories, because that happened. It must not imply that the *synthetic* example is the thing that was tested, or assert any verification that did not occur. If the honest version is weaker, write the weaker version.

2. **No behaviour change.** `sessionsDir()`'s logic and every other line of executable code in `scripts/launcher/` is untouched. This requirement is a comment edit and nothing else.

3. **Write the publish step into `.claude/agents/pipeman.md`.** Record that shipping a release is two actions, not one: `git push` updates the repository, `npm publish` updates the registry, and `npx fully-completely` resolves from the registry. A sprint whose objective is a release is not shipped until the registry serves the new version.

   **3a. Include the pre-publish verification, because it already exists and is already documented.** `scripts/verify-tarball.sh` packs and installs from the actual tarball into a throwaway project. README already states it runs before any release ships. Pipeman's file should say so too, so the check does not depend on someone having read the README.

   **3b. Name the failure this prevents, with the instances.** Three releases have now been pushed to git and not published: `192de1d`/`0fd7973`, and sprint 3's own `89c8a74`. An instruction with its failure attached survives editing better than a bare rule.

4. **Bump `package.json` to 0.1.4.** One line. No other change to that file.

5. **The published tarball still contains none of this repo's own sprint content**, on the same terms as sprint 3 Req 5. `.npmignore` is unchanged by this sprint, so this is a re-verification rather than a new check — but it is a *release*, and the one thing established this epic is that a packaging result from a previous round is not evidence about this one.

6. **Nothing else changes.** No lifecycle script changes, no template changes, no `CLAUDE.md` changes.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- Req 1: `grep -rn "Licenseprofessor" scripts/ templates/ .claude/commands/ docs/` returns nothing. The replacement example is clearly synthetic and does not name a real project.
- Req 1a: **read the before and after side by side.** Confirm the comment still records that the rule was derived empirically, that it was re-verified across multiple character classes, and that the Windows case is flagged as extrapolation. If any of those three survived only in the original, this is a FAIL — the requirement is a scrub, not a trim.
- Req 1b: read the scrubbed comment cold and confirm nothing in it asserts a verification that did not happen, and that the synthetic example is not presented as the thing that was tested.
- Req 2: `git diff scripts/launcher/` shows changes to comment lines only. No executable line differs. `node scripts/launcher_test.js` passes unchanged — QA1 runs it, not just reads it.
- Req 3: `pipeman.md` states that a release requires both `git push` and `npm publish`, that `npx` resolves from the registry, and that a release is not shipped until the registry serves it. Req 3a: `scripts/verify-tarball.sh` is named as the pre-publish check. Req 3b: the three real instances are cited.
- Req 4: `package.json` version is `0.1.4` and the diff to that file is exactly one line.
- **Req 5: run `scripts/verify-tarball.sh`** (or `npm pack` and extract, if the script cannot run) and read the result. Confirm `docs/sprints/` in the tarball holds only the `.gitkeep` placeholders — no `registry.json`, no `state/*.json`, no sprint markdown, no `.claude/settings.local.json`. **Confirm the packed `session.js` is the scrubbed one.** As in sprint 3: if sprint content appears, this is a FAIL, not a CONDITIONAL.
- Req 6: the cumulative diff is confined to `scripts/launcher/session.js`, `.claude/agents/pipeman.md`, and `package.json`, plus `docs/sprints/` bookkeeping.

**LiveQA verifies live, after Pipeman publishes (no browser — the package is the product):**

- **Confirm 0.1.4 is actually on the registry.** `npm view fully-completely version` reports `0.1.4`. This is first because sprint 3 reached its live gate with nothing published, and the state file recorded a shipped commit that had never left git.
- **Upgrade for real, 0.1.3 → 0.1.4.** Install 0.1.3 into a scratch directory, then upgrade. Confirm the upgrade completes and reports the correct version in its printed output, not just in the version marker file.
- **The load-bearing check: grep the upgraded target.** `scripts/launcher/session.js` in the installed project must not contain the client name. `scripts/launcher/` is framework-owned and overwritten on upgrade, so this should pass — and if it does not, the scrub does not reach anyone who already installed, which would be the whole sprint failing quietly.
- **Confirm the comment survived the scrub in the shipped copy.** Read `session.js` in the upgraded target and confirm the encoding rule is still explained and still flags the Windows case as extrapolation. Verifying only the absence of the client name would pass a comment that had been deleted outright.
- **Confirm no sprint data landed in the target**, independently of QA1's tarball check.

### Out of Scope

- **A `files` allowlist in `package.json`.** Deferred from sprint 3 and deferred again, deliberately. It is the right structural fix for `.npmignore` being a fail-open denylist, but this sprint's urgent deliverable is a disclosure scrub, and coupling an urgent fix to a change in *what ships* means a packaging mistake delays the scrub. Its own sprint, next, with its own tarball verification as the subject rather than the confound.
- **`chrishobbs` and `Chris Hobbs` in `scripts/launcher_test.js`** (lines 128, 129, 166). Not scrubbed, and this is a decision rather than an oversight: the author's name is publicly declared in `package.json`'s `author` field, the repository URL, and every commit's git metadata. Removing it from a test fixture removes nothing that is not already public, while changing test data that legitimately uses this project's own path. The client name is a third-party disclosure; the author's own name is not.
- **Unpublishing or deprecating 0.1.2 and 0.1.3.** 0.1.2 is past npm's 72-hour unpublish window, and deprecation adds a warning without removing content. Neither reduces exposure. If a registry-side action is wanted it is a separate decision, made with the knowledge that publishing a scrubbed version is the only step that actually helps.
- **Changing `install.js`'s file-category taxonomy** so user-owned framework rules can reach existing installs. Real, and the deeper half of this epic's distribution problem — `CLAUDE.md` and `.claude/agents/` never upgrade, so sprint 3's rules reach fresh installs only. It is a design change to how upgrades work and deserves its own sprint rather than riding along with a comment scrub.
- **Fixing CLAUDE.md's own-tooling clause**, still wrong about LiveQA not applying here. Third sprint in a row that has had to work around it. Still its own scope.
- **The uncommitted `.vscode/settings.json` change.** Unrelated, still in the working tree, leave it alone.

### Dependencies

- **Blocks:** Every install of 0.1.3 and earlier continues to receive the client name until this ships. Also blocks the `files` allowlist sprint, which should follow immediately and needs a stable packaging baseline.
- **Blocked by:** **Sprint 3 reaching completion.** 0.1.3 must be published and LiveQA-verified before 0.1.4 is built on top of it, or the two releases interleave and neither live test means anything. Dev Team should not run `/sprint-start 4` until sprint 3 is closed.
- **External:** The npm publish itself. Pipeman owns it, and as of this sprint's creation `pipeman.md` does not yet describe it — Requirement 3 is what fixes that, which means for *this* sprint the publish still depends on Pipeman being told directly rather than reading it in role. Flagged rather than assumed.

### Team Assignments

- **Dev Team 1:** All of it. Two file edits and a version bump that must land in one release.
- **Dev Team 2:** Not assigned. Three files, one release, no parallelisable surface. A worktree would create a second checkout racing the same `package.json`.

### Risks & Mitigations

- **The scrub guts a good comment.** The highest risk here, and the least obvious. The comment is the reason anyone trusts the encoding rule; a careless edit leaves a correct file that has forgotten why it is correct. *Mitigation:* Req 1a is written as a preservation requirement, and its acceptance criterion is a before/after read with three named elements that must survive, not a grep for absence.
- **The scrubbed comment quietly starts lying.** Replacing a real example with a synthetic one makes it easy to imply the synthetic path is what was tested. *Mitigation:* Req 1b, and an acceptance criterion that reads the result cold. This is the verified-how discipline applied to a fix for a different problem.
- **The scrub does not reach existing installs.** Would make the sprint cosmetic. *Mitigation:* `scripts/launcher/` is framework-owned and overwritten on upgrade, so it should propagate — but "should" is exactly the kind of assertion this epic keeps getting wrong, so LiveQA greps the upgraded target rather than trusting the taxonomy.
- **0.1.4 is pushed to git and never published.** Three occurrences already. *Mitigation:* Requirement 3 writes the step into Pipeman's file, and LiveQA's first criterion is `npm view`, so an unpublished release fails the gate immediately instead of being discovered four documents later.
- **Publishing 0.1.4 republishes something else nobody has looked for.** The client name was found only because QA1 installed the tarball and read it. *Mitigation:* Req 5's tarball check, and the acceptance criterion now names the scrubbed `session.js` specifically. Beyond that, this sprint does not claim to have audited the whole package for disclosures — see the follow-up note below.
- **Scope pressure toward "while we're in there."** There are four deferred items in Out of Scope and every one of them is real. *Mitigation:* they stay deferred. This sprint removes a client's name from a public package and writes down one missing step; a release that does two things and does them cleanly is worth more than one that does six.

### Follow-up, not this sprint

A full disclosure sweep of everything the package ships has never been done. The client name surfaced from a single audit of one file. Worth its own scoped pass — every framework-owned path, read for real paths, names, credentials and machine-specific detail — rather than being discovered one comment at a time.
