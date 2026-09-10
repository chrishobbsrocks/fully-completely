---
id: 31
title: "Make a role's invocation match the grant it holds, and protect the args-derivation property in CI"
epic: "Headless permission model"
status: done
created: 2026-09-09T23:39:39+00:00
---

# Master Controller Sprint Definition — Sprint 31

**Epic:** Headless permission model — establish what the headless permission
model actually does, by measurement rather than inference.
**Sprint Objective:** Make every role's actual invocation match the grant it
holds, by telling it the form its grant matches, and stop sprint 30's
args-derivation property from regressing unobserved.

### Context

Six shipped profiles carry `Bash(node scripts/run-lifecycle.js *)` — a
relative path. A downstream install recorded a real denial of the same script
invoked by its absolute path, on a role holding that grant, and reported that
matching appears to be on the literal command string rather than the resolved
target. That much was expected to be the whole defect.

Inspecting this repo showed it is not. No agent file mentions
`run-lifecycle.js` at all, and the launcher never tells a role which form to
use. The child is spawned with `cwd: ROOT`, so the relative form does work when
a role happens to choose it — but that is a coincidence between an unstated
convention and an unstated grant, not a design. A role that constructs an
absolute path from its own working directory, which is a reasonable thing to
do and which the downstream install observed happening, is denied while holding
a grant that reads as though it covers the call. The grant and the invocation
have never been connected to each other by anything.

The fix deliberately does not widen any pattern. Adding an absolute-path
variant would be another grant this framework cannot demonstrate works, and
sprint 26 is the standing record of what that costs. Stating the required form
where the role will see it makes instruction and grant agree by construction,
and holds regardless of how matching actually behaves — the same property that
made sprint 30 buildable while the behaviour it records is still unestablished.

This sprint also lands the regression protection sprint 30's own LiveQA asked
for. Their args-derivation check compared the emitted record against the
child's actual argv via a stub `claude` — a stronger test than the one QA1
proposed, and explicitly one that will not run in CI.

### Requirements

1. Every role holding a script-invocation grant is told, at launch, the exact
   command form that grant matches, in a place the role reads before acting.
2. That instruction and the grant derive from a single source, so the two
   cannot drift apart. A second literal naming the same command form, kept in
   sync by hand, reproduces this sprint's defect in a new location.
3. Sprint 30's receipt records the grants in force; after this sprint the pair
   is checkable — an operator holding only stderr can see both the grant and
   the form the role was told to use, and tell whether a denial was a
   mismatched invocation or a genuinely unlisted command.
4. The args-derivation property from sprint 30, Req 1 — that the emitted record
   is derived from the values actually passed to the child rather than
   reassembled from a second source — is protected by a test that runs in CI.
5. No pattern in `HEADLESS_PERMISSION_PROFILES` is widened, and no grant is
   added, by this sprint.

### Acceptance Criteria

- **Req 1** — QA1 confirms the instruction reaches the role through the launch
  itself, not through a file a role may or may not consult. LiveQA confirms, on
  a real install, that a launched role receives it.
- **Req 2** — QA1 traces the instruction and the grant to one constant, and
  confirms that changing the grant changes the instruction with no second edit.
  This is the requirement most likely to be satisfied in appearance only; a
  reviewer should be able to point at the single source, not at two places that
  currently agree.
- **Req 3** — LiveQA launches a role, captures stderr, and demonstrates from
  that capture alone that the grant and the instructed form correspond. The
  test of this criterion is whether the correspondence is visible without
  access to the source.
- **Req 4** — QA1 confirms the test asserts against values passed to the child
  process, not against a recomputation of them, and that it runs under the
  project's normal test command with no stub binary or manual setup. A test
  that recomputes what it is checking would pass while the defect it guards
  against is present.
- **Req 5** — QA1 diffs `HEADLESS_PERMISSION_PROFILES` and confirms it is
  unchanged.

### Out of Scope

- **Widening any grant to accept an absolute path.** That is the obvious fix
  and it is the wrong one: it adds a grant whose behaviour this framework
  cannot demonstrate, to solve a problem that a stated convention solves
  without one.
- **Re-anchoring `PERMISSION_FINDINGS_ANCHOR_VERSION`.** It is six versions
  stale and its NOTE now fires on nearly every launch, which is real and is
  its own sprint. Re-anchoring means re-establishing findings, and doing that
  in a sprint that is simultaneously changing how roles invoke things would
  measure the change rather than the baseline.
- **Resolving the drift-versus-enforcement question.** Still open, still
  requires observations taken after sprint 30, still not this sprint.
- **Changing what any role is permitted to do.** This sprint changes what roles
  are told, not what they are allowed.

### Dependencies

- Blocks: re-anchoring the permission findings — that should measure a launcher
  whose invocations and grants already agree, or it re-measures this defect.
- Blocked by: sprint 30, shipped in 0.2.3. Its receipt is what makes Req 3
  checkable at all.
- External: the downstream install's absolute-path denial is the observation
  that prompted this; it is evidence, not a dependency.

### Team Assignments

- Dev Team 1: all requirements. `scripts/launcher/run-role.js` plus a test file.
- Dev Team 2: sprint 32, in its own worktree per `/sprint-worktree 32`. Sprint
  32 touches `qa1.md` and `liveqa.md` only, and shares no file with this
  sprint.

### Risks & Mitigations

- **The single source becomes two sources that currently agree** — the exact
  defect being fixed, relocated. Mitigated by Req 2's acceptance criterion
  demanding a reviewer point at one constant.
- **The CI test is written against the launcher's internals rather than its
  output**, and then passes while the child receives something else. Mitigated
  by Req 4: assert against what is passed to the child.
- **The instruction is added to an agent file instead of the launch**, which
  puts it in a user-owned file that installs may have diverged. Mitigated by
  Req 1's acceptance criterion.
