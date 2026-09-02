# Sprint 12, Reqs 1–2 — headless permission scope, tested not read

This records what was actually run to establish the narrowest workable
permission scope for a headless role, per sprint 12's Req 1 ("report what
each role minimally requires and what each demonstrably does not") and
Req 2 ("test whether scoping actually works before anyone concludes it
doesn't... grade the findings the way sprint 11 graded its side effects").

**Where this ran:** a throwaway `git init` scratch directory, never this
repo, using a minimal synthetic `test` agent (not the real six personas) —
the goal here is characterizing `claude`'s own permission-mode/tool-scoping
mechanics in general, not yet the real per-role discovery pass (that's
Req 4, still blocked on the Req 3 decision this document feeds).

**Grading key**, carried from sprint 11: CONFIRMED (run and observed),
WEAK (run once, evidence has a named limitation), INCONCLUSIVE (run,
result doesn't settle the question), UNTESTED (not run — never claimed as
either working or not).

## The binary is false: scoping is real

The sprint's own framing was right to question the "blanket bypass or
nothing works" assumption. Three independent mechanisms, tested in
combination, produce a genuinely narrow, non-bypass permission profile:

### `--permission-mode acceptEdits` — CONFIRMED, and narrower than its name suggests

Auto-approves without prompting: the `Edit` tool, and Bash commands like
`echo`, `rm`, and `git` (including `git push` to a real, if local-path,
remote — confirmed by an actual push landing on a bare repo).

Still blocked, "This command requires approval", even under `acceptEdits`:
`npm` (any subcommand — even the fully harmless `npm --version`), `curl`
(a real network fetch), and execution of an arbitrary local script file
(`./run-tests.sh`). This is not a network-vs-local distinction — `git
push` reaches a remote and was allowed; `npm --version` touches nothing
and was blocked. It reads as a command-category classifier (the same
kind of mechanism that blocked Dev Team 1's own edits to `run-role.js`
this sprint — worth knowing it's the same wall, not a separate one).

### `--allowedTools "Bash(<pattern>)"` — CONFIRMED to narrow genuinely, not just nominally

`--allowedTools "Bash(npm *)"` unblocked `npm --version` while `curl`
stayed blocked in the same run — the allowlist doesn't leak into
categories it wasn't given. A single specific script path
(`Bash(./run-tests.sh)`) unblocked exactly that script; general script
execution wasn't opened by it. Compound commands are evaluated per
sub-command against the allowlist ("This Bash command contains multiple
operations. The following parts require approval: ...") — not a loophole
for smuggling an unapproved command alongside an approved one.

### `--disallowedTools "Edit,Write"` — CONFIRMED to hard-disable, not just discourage

With both tools disallowed, an attempted Edit call returned `No such tool
available: Edit. Edit is disabled for this session` — the tool doesn't
exist for that session at all, a stronger guarantee than a permission
prompt that something might talk its way past.

## Per-role scope, from the above

- **Dev Team (writes source, runs the test suite):** `--permission-mode
  acceptEdits` covers Edit/Write and ordinary git. The test suite itself
  needs an explicit `--allowedTools "Bash(node scripts/launcher_test.js)"`
  (or the project's equivalent) — CONFIRMED pattern (the `./run-tests.sh`
  case), not yet run against the real command.
- **QA1 (runs tests and reads code, writes nothing):**
  `--permission-mode acceptEdits --disallowedTools "Edit,Write"` plus the
  same test-command allowlist as Dev Team — CONFIRMED as a combination
  (this exact profile was run: Edit hard-disabled, the allowlisted script
  ran and produced real output).
- **Pipeman (git + npm):** git needs nothing beyond `acceptEdits` —
  CONFIRMED, including a real push. `npm` needs an explicit
  `--allowedTools "Bash(npm *)"` — CONFIRMED for `npm --version` and `npm
  view`. **`npm publish` specifically is UNTESTED** — inferred to follow
  the same command-prefix pattern as the two `npm` subcommands actually
  run, but publishing a real package was out of scope for a scratch test
  and nothing here should be read as having run it.
- **Master Controller (writes a sprint file):** not separately tested —
  inferred to need the same `acceptEdits`-covers-Write profile Dev Team
  uses, since creating a sprint file is a plain file write. **UNTESTED as
  its own case.**

## Explicitly untested, not assumed

- The other four `--permission-mode` choices (`auto`, `manual`, `dontAsk`,
  `plan`) — only `acceptEdits` and `bypassPermissions` (sprint 11) were
  run.
- `--restricted` mode's actual runtime behavior — its help text describes
  what it removes/confines, but that description wasn't independently
  verified by running it here.
- `--add-dir`-based directory confinement (mentioned in `--restricted`'s
  own help text) — not tested as a standalone mechanism.
- Whether this scope profile holds when applied to the REAL six persona
  files (`--agents` JSON built from `agentBody()`) rather than the
  synthetic `test` agent used throughout this document — plausible, not
  confirmed.

## What this settles, and what it doesn't

Blanket `bypassPermissions` is **not** the only way to make headless
usable. A scoped profile — `acceptEdits` plus a per-command
`--allowedTools` list plus `--disallowedTools "Edit,Write"` where a role
should never write source — is real, tested, and narrower by a wide
margin: it never grants network access, package installation/publishing,
or arbitrary script execution by default, only what's explicitly named.

What it doesn't settle: which profile to actually ship, and whether the
residual risk of a scoped-but-still-real permission grant (a headless
role that can `git push`, run an allowlisted test command, and edit files
in whatever directory it's launched from) is one the user wants to accept
per sprint 12's Req 3 — that decision is the user's, on this evidence,
not something this document or Dev Team decides.
