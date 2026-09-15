---
id: 37
title: "Let headless Master Controller commit its own amendments, and give consumers the role-claims ignore entry"
epic: "Downstream findings: FMC ShowOffTest run"
status: abandoned
created: 2026-09-14T23:17:42+00:00
---

# Master Controller Sprint Definition — Sprint 37

> **SUPERSEDED — DO NOT START OR BUILD.** Its scope (headless Master
> Controller commit grant; consumer `role-claims.json` ignore entry) was folded
> into sprint 36 as Reqs 6 and 7, because the user chose one release for this
> work and this repository's live test cannot serve two sprints from one
> publish. This file is placeholder-only. Dev Team: abort it with
> `/sprint-abort 37` once the user authorizes that in your session.

**Epic:** Downstream findings: FMC ShowOffTest run
**Sprint Objective:** [One sentence — what this sprint delivers]

### Context
[Why we're doing this now. Two paragraphs max.]

### Requirements
- [Specific, testable requirement. If it asserts how an external tool, CLI, or API behaves — verified how? Either confirm it by hand before writing the requirement around it, or write it as a flagged assumption Dev Team must verify before building on it, not as settled fact. Two real sprint failures came from a requirement asserting CLI behavior nobody had actually measured.]
- [Specific, testable requirement]
- [If this sprint ships a release, state the version bump explicitly as its own requirement — confirm the currently published version at build time rather than trusting a line written earlier in the sprint's own life. Omit this entirely for a sprint that doesn't publish anything.]

### Acceptance Criteria
- [How QA1 verifies requirement 1. If the requirement says the tool "reports X" or "the message says Y", the acceptance criterion must assert on the printed/displayed output itself — not only on the resulting file or data effect. A message can lie about a state change that happened correctly underneath it, and a test that only checks the file effect will never catch that.]
- [How QA1 verifies requirement 2]

### Out of Scope
- [Thing you're explicitly NOT building this sprint, with reason]

### Dependencies
- Blocks: [what this sprint blocks downstream]
- Blocked by: [what must be done first]
- External: [APIs, services, decisions waiting on others]

### Team Assignments
- **Dev Team 1:** [what they own, or "not assigned"]
- **Dev Team 2:** [what they own, or "not assigned"; if both teams are assigned, confirm here that the split is genuinely independent — no shared files, types, or dependencies — and name the worktree Dev Team 2 must build in]

### Risks & Mitigations
- [Risk] — [Mitigation]
