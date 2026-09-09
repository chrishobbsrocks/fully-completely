---
id: 30
title: "Record the conditions a permission denial was produced under, not just the denial"
epic: "Headless permission model"
status: in_progress
created: 2026-09-09T22:37:40+00:00
---

# Master Controller Sprint Definition — Sprint 30

**Epic:** Headless permission model — establish what the headless permission
model actually does, by measurement rather than inference.
**Sprint Objective:** Make every headless permission denial self-explaining, by
emitting the exact configuration a launch was made under alongside the launch
itself.

### Context

Two installs of this framework, both on CLI 2.1.267, produced opposite
observations of the same behaviour. Sprint 23's LiveQA observed that unlisted
single Bash commands inside the working directory were NOT denied. A downstream
install's unattended sprint-22 run recorded 84 denials across 15 role
invocations, including `node -e "console.log(1+1)"` — a single, non-chained,
wholly unlisted Bash command, refused. Both observations are direct
measurements of the class sprint 26 established as the only kind that counts.
Both were verified in this repo's own session, from the raw envelopes, not
from a summary.

They cannot be reconciled, and the reason is structural rather than empirical.
The persisted envelope carries `permission_denials` and nothing about the
conditions: no `allowedTools`, no `disallowedTools`, no permission mode, no
working directory, no measured CLI version. Every denial records *that* a
command was refused and none records *why it could have been*. Sprint 26
correctly established that only direct measurement counts; it did not establish
that a direct measurement needs its conditions recorded to be comparable to any
other measurement. This sprint fixes that gap, which is this framework's, not
the downstream install's — `run-role.js` builds the configuration and discards
it.

The fix is deliberately of the kind that does not depend on the permission model
behaving in any particular way. Recording what was passed is knowable with
certainty whatever the CLI then does with it. That is what makes this buildable
now, while the behaviour it will eventually explain is still unestablished.

### Requirements

1. Before launching a headless child, `run-role.js` emits the resolved
   permission configuration for that launch: the exact `--allowedTools` and
   `--disallowedTools` values passed, the permission mode, the resolved working
   directory, and whether an MCP config was supplied. Emitted to stderr, in a
   form a capturing process can parse without scraping prose.
2. The emitted record names the CLI version **measured at launch**, not
   `PERMISSION_FINDINGS_ANCHOR_VERSION`. The anchor is pinned at 2.1.261 and
   both known installs run 2.1.267; a record reporting the anchor would be
   confidently wrong, which is worse than absent.
3. The record is emitted for every role, including roles whose profile grants
   nothing. A role with no grants is a condition, not an absence of one, and an
   observation from it is only interpretable if that is stated.
4. The record distinguishes "MCP config supplied" from "no MCP config supplied".
   Sprint 27, Req 4 established directly that allowlisted MCP tools with no
   server behind them produce a tool-resolution failure, not a permission
   denial. Those two outcomes look different in a transcript and must be
   attributable to different causes.
5. The emission follows this repo's established receipt shape — the
   `[sprint_lifecycle] repo=... script=...` stderr line, and sprint 27's
   "print what you just wrote" notices. Printed once, at the moment it is
   true, as a receipt rather than a warning.

### Acceptance Criteria

- **Req 1** — QA1 reads `headlessLaunchArgs()`/`headlessPermissionArgs()` and
  confirms the emitted record is derived from the same values actually passed
  to the child, not rebuilt alongside them from a second source that could
  drift. A record assembled independently of the args is the defect this sprint
  exists to prevent, reproduced one layer up.
- **Req 2** — QA1 confirms the version is read at launch. LiveQA, on a real
  install of the published package, confirms the record reports the version
  its own machine is running, and that this is not `2.1.261` unless the machine
  genuinely runs it.
- **Req 3** — LiveQA launches a role whose profile grants nothing (`qa1` or
  `master-controller` carry no arbitrary-execution primitive) and confirms a
  record is still emitted, stating the empty grant explicitly.
- **Req 4** — LiveQA launches `liveqa` with no declared MCP config and confirms
  the record says so; the existing NOTE on that path is a separate message and
  does not satisfy this on its own.
- **Req 5** — QA1 confirms the emission is unconditional and not gated on a
  verbosity flag, environment variable, or debug mode.
- **Whole sprint** — after this ships, an operator holding only a captured
  stderr stream and its envelope can state which grants were in force when a
  denial was recorded, without access to the machine that produced it.

### Out of Scope

- **Capturing, storing, or aggregating the emitted record.** This framework
  provides the mechanism; the consumer provides the automation. The downstream
  install already persists role output and will pick this up for free.
  Building an orchestrator here is explicitly not this project's job.
- **Changing any grant in `HEADLESS_PERMISSION_PROFILES`.** Both this and the
  relative-path invocation defect across six profiles are real, and both are
  their own sprint. A sprint that both changes the conditions and starts
  recording them can attribute nothing.
- **Resolving the enforcement-versus-drift question itself.** This sprint makes
  that question answerable. Answering it needs observations taken after this
  ships, which by definition do not exist yet.
- **Re-grading the existing findings document.** Every observation in it
  predates conditions being recorded and none can be retrofitted with them.

### Dependencies

- Blocks: the relative-path invocation defect sprint — that one changes
  conditions, and should land after conditions are being recorded, so its
  effect is observable rather than inferred.
- Blocks: any future re-opening of the enforcement/drift question.
- Blocked by: nothing.
- External: the downstream install's raw envelopes at
  `~/.fifty-mission-cap/role-output/8349efd9f070d92c/sprint-22/` are the
  worked example of the gap; they are evidence for this sprint, not a
  dependency of it.

### Team Assignments

- Dev Team 1: all requirements. Single file, one concern.
- Dev Team 2: unassigned this sprint. The commit-rule work for `qa1.md` and
  `liveqa.md` is genuinely independent — different files, no shared types — and
  is the honest parallel candidate, but it is not yet written and must not be
  folded into this one.

### Risks & Mitigations

- **The record drifts from the args it claims to describe** — the exact defect
  this sprint fixes, reproduced one layer up. Mitigated by Req 1's acceptance
  criterion: derive the record from the values passed, never assemble it
  separately.
- **The record grows into a log format, then a schema, then an orchestrator** —
  this project provides mechanism, not automation, by explicit instruction.
  Mitigated by Out of Scope's first item and by Req 5's receipt shape: one
  line, at one moment, not a stream.
- **Emitting the full agent definition leaks a large prompt body into stderr** —
  `headlessLaunchArgs()` serialises the whole agent body into `--agents`. The
  permission configuration is the subject here; the prompt body is not, and
  including it would make the record unreadable at exactly the moment someone
  needs to read it.
