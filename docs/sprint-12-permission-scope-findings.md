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

### `--disallowedTools "Edit,Write"` — CONFIRMED to hard-disable the TOOLS, not to prevent all writes

With both tools disallowed, an attempted Edit call returned `No such tool
available: Edit. Edit is disabled for this session` — the tool doesn't
exist for that session at all, a stronger guarantee than a permission
prompt that something might talk its way past.

**Correction (QA1 round 1 on this sprint): this does NOT mean "writes
nothing."** Disallowing Edit/Write only removes those two tools — Bash
itself is untouched, and a plain single-line redirect (`printf '%s'
"content" > file`) still succeeds under this exact profile, confirmed by
running it. This is what qa1.md/liveqa.md's own headless fallback (see
below) actually relies on, and QA1 correctly caught that the finding here
previously described the scope as stronger than it is — the two artifacts
contradicted each other, one saying "writes nothing," the other giving
instructions for how to write a file.

**The asymmetry QA1 flagged, checked**: does a Bash redirect stay confined
to the working directory the same way the Write tool was found to be?
CONFIRMED yes, symmetric — `printf ... > /tmp/outside-file.txt` from
inside a different working directory was blocked with `Output redirection
to '/tmp/...' was blocked. For security, Claude Code may only write to
files in the allowed working directories for this session: ...` — the
identical directory bound, enforced at the Bash-redirect level too, not
only at the Write-tool level. This was a real, correctly-flagged gap in
this document (asserted as a "free" bound from the Write-tool case alone,
never checked against Bash) — now closed by running, not assumed.

**A separate, narrower finding from the same round of testing: multi-line
heredoc syntax (`cat <<'EOF' > file` ... `EOF`) is rejected outright**,
regardless of location, with `Contains shell syntax (file_redirect) that
cannot be statically analyzed` — a different, stricter rejection than the
directory-confinement block above, and one that fires even for a write
fully inside the working directory. A single-line `printf '%s\n' "line
one" "line two" ... > file` (single-quoted format string, so the outer
shell never touches `\n`) was confirmed to work instead, producing real
newline bytes (verified with `od -c`) and correctly refusing to expand a
literal backtick or `$VAR` passed as a quoted argument — the same safety
property the original `--notes-file` mandate exists to protect, delivered
by a command shape that actually executes under this profile. The
qa1.md/liveqa.md/sprint-qa1.md/sprint-liveqa.md fallback previously
recommended the heredoc form; it has been corrected to the verified
`printf` form.

## Per-role scope, from the above

- **Dev Team (writes source, runs the test suite):** `--permission-mode
  acceptEdits` covers Edit/Write and ordinary git. The test suite itself
  needs an explicit `--allowedTools "Bash(node scripts/launcher_test.js)"`
  (or the project's equivalent) — CONFIRMED pattern (the `./run-tests.sh`
  case), not yet run against the real command.
- **QA1 (runs tests and reads code, never writes SOURCE via Edit/Write —
  but can still write its own notes/state files via Bash, confined to the
  working directory):**
  `--permission-mode acceptEdits --disallowedTools "Edit,Write"` plus the
  same test-command allowlist as Dev Team — CONFIRMED as a combination
  (this exact profile was run: Edit hard-disabled, the allowlisted script
  ran and produced real output). See the corrected `--disallowedTools`
  section above for what this profile does and does not actually prevent.
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
  own help text) — not tested as a standalone mechanism, and turned out
  not to be needed: see "A finding this document didn't expect" below.

## Closing the two UNTESTED items (Req 3's own condition for Req 4 to run)

Both closed by running, before any Req 4 discovery pass began.

**`npm publish` under Pipeman's profile.** `npm publish --dry-run` run
under exactly `--permission-mode acceptEdits --allowedTools "Bash(npm *)"`
in a scratch package succeeded cleanly — no permission block, only npm's
own dry-run output (tarball contents, shasum, "Publishing to
https://registry.npmjs.org/ with tag latest and default access
(dry-run)"). CONFIRMED: the same `Bash(npm *)` allowlist that unblocked
`--version`/`view` also covers `publish --dry-run`, with nothing narrower
needed. A first attempt used a prerelease-tagged test version and npm
itself refused it ("You must specify a tag using --tag when publishing a
prerelease version") — that's npm's own validation, not a permission
block, and the corrected version published clean on retry.

**Master Controller writing a sprint file, as its own scenario.** Tested
directly against the real mechanism (`node scripts/run-lifecycle.js new
--title-file ...`), not inferred from Edit/Write generically:
- The `Write` tool, writing a file WITHIN the working directory,
  succeeded under plain `acceptEdits` alone — CONFIRMED, no allowlist
  needed, matching the earlier Edit-tool finding.
- Running `node scripts/run-lifecycle.js new` itself required an explicit
  `--allowedTools "Bash(node scripts/run-lifecycle.js *)"` entry — it is
  NOT auto-approved like `git`, it's in the same "interpreter + script"
  category as `python3 scripts/*` and `node scripts/*` generally. This
  was a genuine surprise relative to this document's original inference
  ("the same acceptEdits-covers-Write profile Dev Team uses") — the write
  itself needed nothing extra, but the script invocation that actually
  creates a real sprint (the mechanism MC's own command file specifies)
  did.
- A write attempted to an absolute path OUTSIDE the working directory
  (`/tmp/...`) was BLOCKED even under `acceptEdits` — "Claude requested
  permissions to write to X, but you haven't granted it yet." This is new
  evidence, not previously in this document: `acceptEdits`'s auto-approval
  appears to already be confined to the launch working directory, without
  any `--add-dir` configuration. That's exactly the "caller-designated
  working directory" bound Req 2 asked to test — it looks like it comes
  free with `acceptEdits`, not something this framework needs to
  separately wire up. Stated as an observation from one test, not a
  guarantee across every possible path shape.

## Req 4: the real six-role discovery pass

Run for real, in the same scratch throwaway repo used for Reqs 1-2 (a
published-shaped install via `npm pack` of this repo's own code, not the
synthetic `test` agent — the real six `--agents` personas, built through
`agentBody()`/`readAgentMeta()` exactly as production headless does),
driving one real sprint (`hello.txt` gains a header comment) through both
gates, all six roles, in sequence:

1. **Dev Team 1** — built the change, committed, self-reviewed, correct
   handoff. $0.19, 9 turns, `is_error: false`.
2. **QA1** — full audit, PASS recorded, byte-level verification (`od`
   against both blobs) rather than trusting the commit message. $1.47, 25
   turns.
3. **Dev Team 1** (second invocation, `/sprint-dev-done`) — correctly
   recognized no new work was needed, ran dev-done, produced a correct
   handoff naming Pipeman as next. $0.20, 9 turns.
4. **Pipeman** — pushed for real to a local bare remote, correctly
   determined this scratch repo has no `package.json` (so no release, no
   npm step — Req 11's fix validated in a real run: no false-positive
   publish attempt), recorded the ship. $0.37, 22 turns.
5. **LiveQA** — correctly identified there is no deployed product to
   browser-test, verified what genuinely exists instead (byte-level
   content check against the pushed remote, commit SHA match), PASS with
   an explicit scope note rather than either fabricating a browser session
   or refusing to run. $1.62, 28 turns.
6. **Master Controller** — read-only status report, explicitly declined to
   amend the sprint file (would invalidate QA1's audited-file hash),
   correctly refused to treat "both gates green" as closure authorization.
   $0.73, 9 turns.
7. **Dev Team 2** (closing the loop on all six roles within this one
   sprint) — confirmed the same status, correctly refused to run
   `/sprint-complete` without real user authorization. $0.20, 8 turns.

Total: ~$4.78 across seven real headless invocations. Every run:
`is_error: false`, exit 0, correct tool use, no fabricated results.

### A finding this document didn't expect: the templates themselves needed no changes

Per Req 5's own framing ("where a run confirms the design, say so; where
it contradicts it, say what was wrong") — the fixed scaffold and per-role
pointers in `scripts/launcher/prompts.js` are UNCHANGED by this pass.
Every role oriented correctly from nothing but "read the sprint file and
state file" plus its own persona. The desk design survived contact.

### The real finding: three roles independently hit the same tooling gap

**QA1, LiveQA, and Master Controller each separately flagged, unprompted,
that `.claude/agents/qa1.md` and `liveqa.md`'s `--notes-file` mandate is
unusable headless** — both files require the Write tool for the
`--notes-file` pattern, and Write is correctly disallowed for qa1/liveqa
under this sprint's own Req 3 scoped profile. All three found working, safe
alternatives on their own (a quoted heredoc via Bash; confirming notes
contain no backtick/`$`/backslash before passing `--notes` inline) rather
than being blocked or improvising something unsafe — but all three said
this should be fixed at the source, not worked around every time. Three
independent roles reaching the identical conclusion, unprompted, is strong
evidence this is real, not a fluke of one role's phrasing. See the round-5
handoff for the actual fix to `qa1.md`/`liveqa.md`.

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
