---
id: 23
title: "Give headless LiveQA the browser access its own job description already assumes"
epic: "Framework rules and distribution"
status: done
created: 2026-09-08T21:50:56+00:00
---

# Master Controller Sprint Definition — Sprint 23

**Epic:** Framework rules and distribution — a role's permissions have to match the job its own description assigns it.
**Sprint Objective:** Scope the browser and API tooling into headless LiveQA's profile, and be honest that this framework cannot verify the result itself.

### Context

`liveqa.md` says the role *"drives a real browser via Playwright MCP tools (navigate, click, type, snapshot, screenshot, read the accessibility tree), or via the Claude in Chrome extension"*, and that for checks outside that it uses *"whatever MCP tools or direct API calls (Bash/curl) the project has available."*

`HEADLESS_PERMISSION_PROFILES['liveqa']` grants `run-lifecycle`, `sprint_lifecycle`, `npm install *` and `npx *`. **No browser tools. No `curl`. No `gh`.** A headless LiveQA cannot do the thing its own description opens by assigning it.

**This was not an oversight, and the reason it stayed open still holds.** `run-role.js:502` says so: *"The real browser-driving tools (Playwright/Chrome MCP) still aren't scoped here — out of reach of a synthetic-agent scratch test, untested as such, not assumed to need broader Bash."* Sprints 17 and 19 declined to grant what they could not exercise, which was the correct call under the standard this project applies.

**What changed is that someone can now exercise it.** A downstream orchestrator running the lifecycle unattended reports the gap blocks an entire sprint outright — aborted rather than left sitting — and that the profile is byte-identical between 0.1.19 and 0.1.23, so it is not a version-pin problem. Their supporting evidence is the part worth acting on: of three live tests run on one day, **two used no browser at all** — one gate was a CI pipeline, another was sixty `curl` requests plus platform APIs. And headless QA1 has found real defects, recorded environment limits rather than claiming what it could not execute, and retracted its own finding when wrong. **The judgment survives headless. Only the access does not.**

**One thing must be said plainly rather than discovered during the audit.** This profile already contains `Bash(npx *)`, which is an arbitrary-execution primitive — sprint 19 demonstrated that `curl -o`, `node -e` and `bash -c` all write outside the working directory with zero denials, and `npx` reaches at least as far. **LiveQA's bound is already trust rather than technical confinement.** Adding browser tools and `curl` does not change that posture; pretending it would is the overstatement this project has corrected three times.

**AMENDED AFTER THE BUILD WAS HELD — the premise changed, the goal did not.** Dev Team ran Req 1's "determine by running" instruction before writing code and found that a single unlisted Bash command ran without a denial on CLI 2.1.265. It stopped rather than building narrow allowlist entries onto a gate that might not gate, which was correct. A downstream consumer then ran our harness twice, byte-identical, same binary, same roles: **three of eight verdicts moved.** Compliance variance and enforcement variance cannot be separated in that data, and the only defensible statement is that **whether `allowedTools` gates a single Bash command is now unestablished** — not disproved, unestablished.

**What that changes here is the framing, not the work.** Headless LiveQA needs browser access either way: if the allowlist does not gate, granting the tools changes nothing; if it does, granting them is necessary. **Narrowness stays as a discipline — it is still better documentation of intent, and the gate may be intermittent rather than absent — but this sprint must not describe it as a security boundary.** That claim is what is unestablished, and sprint 23's own Context already says as much about `Bash(npx *)` being arbitrary execution.

The method finding itself is a separate sprint and a larger one: 23 CONFIRMED entries in `docs/sprint-12-permission-scope-findings.md` were measured by launching a role and reading `permission_denials`, and a method that cannot reproduce itself across identical runs cannot establish a bound. **Do not fix that here.**

### Requirements

1. **Scope the browser tooling into the headless LiveQA profile.** Playwright MCP tools at minimum, since that is what `liveqa.md` names first. **Determine by running what the `allowedTools` mechanism actually does with MCP tool names** — the existing entries are all `Bash(...)` patterns and MCP names are a different shape. If they cannot be scoped through that mechanism, say so and name what would be needed instead.

2. **Scope the non-browser checks the role's description already assumes** — `curl` for direct API calls, and whatever is needed for a CI-pipeline or platform-API gate. **Narrowest form that does the job**, per sprint 19's Req 3: enumerate verbs where a verb set exists, as `pipeman`'s git entries do, rather than reaching for a bare wildcard.
   - **State the posture honestly in the comment**, and it is now weaker than when this sprint was written. `Bash(npx *)` is already present and already arbitrary, so these additions are convenience for a role that could already reach anything. **And whether the allowlist gates a single unlisted Bash command at all is unestablished as of CLI 2.1.265** — see the amendment above. Write the comment so that a reader takes the entries as a statement of what the role is *meant* to need, not as a boundary this project can currently demonstrate.

3. **The default profile stays the narrow one for every other role.** Nothing in this sprint touches `qa1`, `pipeman`, `master-controller` or the dev-team profiles.

4. **Bump `package.json` to 0.1.24.** One line.

5. **Test coverage in `scripts/launcher_test.js`** asserting the liveqa profile contains the new entries and that no other role's profile changed.

### Acceptance Criteria

**QA1 verifies statically, before anything is published:**

- Req 1: confirm the MCP scoping mechanism was **established by running**, not inferred from the shape of the existing `Bash(...)` entries. If it could not be established, confirm that is recorded as unestablished rather than assumed to work.
- **Req 2 is the narrowness check.** Confirm each addition is the tightest form that does the job. **A bare wildcard where a verb set exists is a finding**, exactly as it would have been in sprint 17.
- Req 2: read the posture comment cold. **If it claims this grant meaningfully widens LiveQA's reach, it is wrong** — `Bash(npx *)` already does. **And if it presents the allowlist as a demonstrated boundary, it is also wrong** — that is unestablished as of 2.1.265. Overstating a bound is the error this project has now corrected four times.
- Req 3: `git diff` shows no other profile changed.
- Req 4: `package.json` is `0.1.24`, one-line diff.
- Req 5: **run the suite.**
- Run `scripts/verify-tarball.sh`.

**LiveQA verifies live, after Pipeman publishes — and this gate is structurally limited here:**

- **Confirm 0.1.24 is on the registry**, verifying published bytes against the audited commit per sprint 13's rule.
- **Verify the grant, which is what this framework can verify.** Launch headless LiveQA against a published install and confirm the browser tools are **reachable rather than denied** — a tool that is present and has nothing meaningful to drive is a different result from a tool that is refused, and this project can distinguish those.
- **Do not claim the workflow was verified.** This framework's own released artifact is a package, not a deployed web app, so there is no deployment here to drive a browser against. **Record plainly that access was demonstrated and use was not** — that distinction is the whole reason the gap stayed open through sprints 17 and 19, and papering over it now would be worse than the gap.
- **Confirm the other roles are unaffected** — a headless `qa1` still cannot reach a browser.

### Out of Scope

- **The ship-to-verify path** — origin drift after a denied state write, no CI check at ship time, and the deployed-SHA drift that taxes every sprint. Three findings, one path, one moment, and **deliberately not split across sprints**: treating them separately would produce three partial fixes. Sprint 24, and it waits on the reporter's traces rather than being written from inference.
- **The cross-session ownership warning and sprint renaming.** Both small, both "the tool says what it knows"; sprint 25, kept off this one so it stays minimal and ships fast.
- **Any change to what LiveQA refuses.** It still does not read code, does not trust a static pass, and re-verifies live every time. Those properties produced its record and this sprint does not touch them.
- **Narrowing `Bash(npx *)`.** Real, and a separate decision — sprint 17 established there is no fixed prefix narrower than the subcommand, since the package name differs per project and per sprint.

### Dependencies

- **Blocks:** A downstream orchestrator's aborted sprint, which they can re-file the day this lands.
- **Blocked by:** Nothing. The board is empty.
- **External:** The reporter has offered state files, traces and reproductions. **For this sprint the useful one is confirmation that the granted tools actually work in their environment**, since this framework cannot demonstrate use — only access.

### Team Assignments

- **Dev Team 1:** All of it. One file.
- **Dev Team 2:** Not assigned.

### Risks & Mitigations

- **The grant is written to make the audit pass rather than to do the job**, because nobody here can drive it end to end. *Mitigation:* LiveQA's criterion separates access from use explicitly and forbids claiming the latter; the consumer confirms use in an environment that has one.
- **The posture comment overstates what changed.** *Mitigation:* Req 2 and a QA1 criterion that treats overstatement as the finding, given `Bash(npx *)` is already present.
- **MCP tool names turn out not to be scopable through `allowedTools` at all**, and the sprint delivers nothing. *Mitigation:* Req 1 permits "could not be established, here is what would be needed" as an honest outcome. That is a finding, not a failure.
- **This is a permission widening on a role whose bound is already trust.** *Mitigation:* named in Context rather than mitigated — the honest statement is that LiveQA could already reach anything, and this sprint makes its intended job possible rather than its reach larger.
