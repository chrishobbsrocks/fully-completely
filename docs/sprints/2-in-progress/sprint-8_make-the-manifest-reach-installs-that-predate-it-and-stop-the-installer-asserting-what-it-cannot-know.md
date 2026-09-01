---
id: 8
title: "Make the manifest reach installs that predate it, and stop the installer asserting what it cannot know"
epic: "Framework rules and distribution"
status: in_progress
created: 2026-08-31T22:13:46+00:00
---

# Master Controller Sprint Definition — Sprint 8

**Epic:** Framework rules and distribution — the rules this framework defines have to reach the people running it, including the ones who installed months ago.
**Sprint Objective:** Give the upgrade a second source of positive proof — the content we actually published in prior releases — so an untouched file in a pre-0.1.5 install can finally be recognised and upgraded, and make the installer say only what it has established.

> **LiveQA's gate is REDEFINED, not skipped**, same as sprints 3–7 and for the
> same mechanical reason (`sprint_lifecycle.py:688`). **"Live" means real
> `npx fully-completely` installs and upgrades against scratch directories.**
> Sprint 6's staged targets — `/tmp/fc6-baseline`, `/tmp/fc6-fresh`,
> `/tmp/fc6-adv` — are directly reusable and were preserved for this.

### Context

Sprint 6 shipped as 0.1.5 and its live gate passed on every stated criterion. It is also, in the field, inert. LiveQA found that the first upgrade writes the manifest as `{}`, because at that moment the installer has no record of what it previously wrote — and Req 3 correctly forbids overwriting without positive proof. So every pre-0.1.5 install conflicts on all seven user-owned files, permanently, and receives nothing. **The epic goal is unmet for every install that existed before 0.1.5, which is all of them.** That is a specification failure, not an implementation one: sprint 6 built exactly what was asked, and what was asked could not reach backwards.

The fix is not to relax Req 3. It is that **there is a second form of positive proof we already own and did not use**: the content we actually published. If an installed `qa1.md` hashes to what 0.1.4's tarball shipped, that file demonstrably was never edited — that is proof, not an assumption, and it is exactly as strong as a manifest entry. Absence of evidence still resolves to never-overwrite; this sprint adds a second source of evidence rather than lowering the bar.

Two smaller defects went out in the same release and are live in users' terminals now. The conflict message says *"Upstream has updated qa1.md since the version you have"* when `git diff 976f3d2 ca7dc99 -- .claude/agents CLAUDE.md` is empty — upstream updated nothing; the user's own edits caused the conflict. **That wording is specified verbatim in sprint 6's Req 4, so it is Master Controller's defect, not Dev Team's.** And a fully successful upgrade exits 1, because seven conflicts set `exitCode`; the behaviour dates to sprint 3, but this release makes seven conflicts guaranteed on every existing install, so every scripted upgrade now reports failure.

### Requirements

1. **Ship content baselines for user-owned files as published in prior releases, and treat a baseline match as positive proof.** On upgrade, when a file has no manifest entry, hash the installed file and compare it against the known content of that path in every version we have published. A match against **any** published version proves the file was never edited → record it in the manifest and upgrade it, backing up first. No match → **still never overwrite**, exactly as today. State in a comment that this adds a second source of positive proof and does not weaken sprint 6's Req 3: the dangerous branch still requires proof, and absence of any match still resolves to the conservative side.

2. **Baselines are generated from published artifacts, never hand-written.** A wrong hash in this table silently overwrites somebody's edited file, which makes a hand-maintained list the single most dangerous thing this sprint could produce. Generate it from the published npm tarballs (`npm pack fully-completely@<version>`), commit the generating script alongside the data so it is reproducible and extends to future releases, and record in the file which versions and which paths it covers.

3. **A proven-untouched file must be recorded in the manifest as it is upgraded.** Otherwise the next upgrade repeats the baseline sweep from scratch and the manifest never becomes authoritative. Files that did not match anything stay out of the manifest — we do not know what they are, and guessing is the failure mode this whole mechanism exists to prevent.

4. **The conflict message states only what has been established, and distinguishes two cases that are currently conflated.** With baselines, the installer can finally tell these apart, and they warrant different messages:
   - The file has local edits **and** upstream's copy changed between the installed version and this one → a real conflict; say so, name the file, and point at how to see what moved.
   - The file has local edits and **upstream did not change it** → there is nothing to reconcile; say that plainly and do not imply an update is pending.
   Wording is Dev Team's. The requirement is that no message asserts upstream moved unless upstream actually moved. Sprint 6's Req 4 got this wrong by specifying the claim rather than the condition; do not repeat it.

5. **A successful upgrade exits 0.** Reserve a non-zero exit for an actual failure. Sprint 3 introduced `exitCode = 1` on conflicts deliberately, so this is a conscious supersession, not an oversight to be quietly reverted: find that reasoning, state in the commit what the new contract is and why routine conflicts no longer justify a failure exit, and check whether anything in the repo or docs relies on the old behaviour.

6. **Bump `package.json` to 0.1.6.** One line.

7. **Test coverage in `scripts/launcher_test.js`**, following the existing file's conventions. At minimum: a file matching a published baseline is upgraded and recorded; a file matching nothing is preserved and reported; a corrupt or missing baseline table resolves to no-overwrite; the two conflict messages are selected by the right condition; a successful upgrade exits 0.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- **Req 1 is load-bearing, and it is the same check as sprint 6's Req 3 with one more accepted proof.** Trace every path to "overwrite" and confirm each requires either a manifest match or a published-baseline match. Missing manifest, missing baseline file, unparseable baseline JSON, malformed entry, no match found — every one must land on no-overwrite. **If any path reaches overwrite without a positive match, this is a FAIL, not a CONDITIONAL.** List the paths traced in the notes.
- **Req 2 is verified by regenerating, not by reading.** Run the generating script independently against the published tarballs and confirm the committed baseline data matches byte-for-byte. A hash in this table that does not correspond to real published content is a destructive overwrite waiting to happen, and reading the file cannot detect one.
- Req 3: confirm the manifest is written for upgraded files and that non-matching files are absent from it.
- Req 4: read both messages cold. Confirm which condition selects which, and that neither claims upstream moved unless it did. Check the wording against the actual 0.1.4→0.1.5 case, where upstream changed nothing.
- Req 5: confirm exit 0 on the success path, and that a genuine failure still exits non-zero. Confirm the sprint 3 reasoning was found and addressed rather than ignored.
- Req 7: **run `node scripts/launcher_test.js`**, don't just read it. Confirm all five cases.
- Run `scripts/verify-tarball.sh`. Sprint content in the tarball is a FAIL. Confirm the baseline data file is actually included — a baseline table excluded by `.npmignore` would ship a version of this feature that silently does nothing.

**LiveQA verifies live, after Pipeman publishes:**

- **Confirm 0.1.6 is on the registry** and its `gitHead` matches `last_shipped_commit`, from `npm view` rather than a handoff.
- **The epic goal, tested directly for the first time — and it must start from 0.1.2, not 0.1.4.** *Corrected after QA1 round 1 caught that the original criterion was unsatisfiable as written:* 0.1.4 already contains sprint 3's and sprint 4's content, because they shipped in 0.1.3 and 0.1.4. Starting there can show conflicts clearing and the manifest populating, but it cannot show a rule *arriving*, since no rule is missing. Verified: `demonstrated, not argued` appears once in 0.1.4's `qa1.md` and zero times in 0.1.2's.
  - **Install published 0.1.2** (or 0.1.0) into a scratch directory, leave everything untouched, upgrade to published 0.1.6, and confirm `.claude/agents/qa1.md` gains sprint 3's FAIL-demonstration standard, `CLAUDE.md` gains the transition-precondition rule, and `pipeman.md` gains sprint 4's publish step — each absent before and present after, with a backup written for every file replaced. **This is the thing the entire epic exists to do and it has never once been demonstrated against a published release.**
  - **Also run the 0.1.4 case**, which remains worth having for what it does prove: that sprint 6's seven permanent conflicts clear, the manifest populates for all seven paths, and exit is 0.
- **Sprint 6's safety property must still hold — this is a regression check and it is non-negotiable.** Plant a sentinel in `qa1.md` in a published-0.1.4 install, upgrade to 0.1.6, confirm the sentinel survives and a conflict is reported. If baselines have made the destructive branch reachable, this is where it shows, and it is a FAIL.
- **Both conflict messages, observed.** Produce each condition against real installs and confirm the right message appears. The "upstream did not change it" case is the common one for `CLAUDE.md` and must not read as an alarm.
- **Exit code is 0** on a successful upgrade, checked with `echo $?`, not inferred from the absence of an error.
- **Fresh install still works**, and its manifest is populated.

### Out of Scope

- **Naming framework-owned files that have drifted before replacing them.** The installer prints one `Replaced` line whether the user was merely behind or had a month of their own work in that file, and does not print the backup path. Real, and the external team's 271-line fork is the concrete instance. Deferred again deliberately: it is the *other* category, and this sprint is already carrying a safety-critical branch in the user-owned one.
- **Sprint 7's two gaps** (the live-loop audit record, and naming the tree). Written, scoped, and resequenced to 0.1.7 behind this.
- **A hard framework/user marker in `CLAUDE.md`.** Still the change that would let its framework half merge rather than conflict. Baselines make `CLAUDE.md`'s message honest; they do not make it upgradeable, because a project that added standards below the line matches no baseline and correctly conflicts forever. That is working as intended and is a separate sprint.
- **Backfilling a manifest for files that conflict.** We do not know what they are. That is the whole point.
- **Fixing CLAUDE.md's own-tooling clause**, still wrong about LiveQA not applying here. Seventh sprint working around it.
- **The uncommitted `.vscode/settings.json` change.** Still unrelated, still not ours.

### Dependencies

- **Blocks:** Sprint 7, on `package.json`'s version line. Sequential, not parallel — two releases in flight is how a mis-versioned publish happens.
- **Blocked by:** Sprint 6 closed and 0.1.5 live on the registry. Both hold: 0.1.5 serves with `gitHead ca7dc99`, and the baselines in Req 2 are generated from it and its predecessors.
- **External:** The npm publish is Pipeman's. Note from sprint 6's release: the first `npm publish` was denied by the environment and succeeded on retry after a `--dry-run`. **One observation, no established mechanism — do not encode it as a procedure.** If it recurs here, that is a second data point and then it is worth something.

### Team Assignments

- **Dev Team 1:** All of it. One installer, one mechanism, one release.
- **Dev Team 2:** Not assigned. Sequential with sprint 7 on the version line, and a safety-critical overwrite branch is a single review surface.

### Risks & Mitigations

- **A wrong baseline hash overwrites a file somebody edited.** The worst outcome available here, and worse than sprint 6's equivalent because it is *data* rather than logic — a plausible-looking wrong hash reads fine forever. *Mitigation:* Req 2 forbids hand-writing it; QA1 regenerates independently from published tarballs rather than reading the committed table.
- **Baselines make the mechanism look complete when it is not.** Only content we published can be recognised. A fork, a hand-patched file, or a version we never published still conflicts forever. *Mitigation:* accepted and correct — those files genuinely are not proven untouched. Say so in the conflict message rather than papering over it.
- **The exit-code change breaks something relying on exit 1.** *Mitigation:* Req 5 requires finding sprint 3's reasoning and stating the new contract, rather than reverting silently.
- **Scope pull toward the `CLAUDE.md` marker**, which this sprint will make newly tempting by fixing everything around it. *Mitigation:* it stays out, on the record, with the reason.
- **A second specification defect like sprint 6's Req 4.** That one specified a claim instead of a condition and shipped a falsehood to users. *Mitigation:* Req 4 here specifies conditions and leaves wording to Dev Team, and its acceptance criterion is read cold against the real 0.1.4→0.1.5 case rather than checked for presence.
