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

**Version anchor (sprint 21, Req 1 — the standing form for every CONFIRMED
entry from here on).** This document originally recorded no `claude`
version anywhere, for any entry — every CONFIRMED grading below was a
claim about an unspecified build. Sprint 12's own testing ran at
approximately `2.1.257`–`2.1.258` (not captured at the time; inferred
from adjacent records, not itself a CONFIRMED fact). **Every CONFIRMED
entry below has now been independently re-run against `claude 2.1.261`**
(sprint 21, 2026-09-06) and is tagged accordingly. The full methodology,
every command actually run, and the entries that could NOT be
re-verified this round (downgraded rather than left CONFIRMED with a
guessed version, per Req 1) are in **"Sprint 21 re-verification"** at the
end of this document — read that section for how each tag below was
earned, not just what it says. The launcher itself now warns (never
gates — see `run-role.js`'s `warnIfPermissionFindingsStale()`) when the
running CLI no longer matches `2.1.261`, the version this document is
now anchored to.

## The binary is false: scoping is real

The sprint's own framing was right to question the "blanket bypass or
nothing works" assumption. Three independent mechanisms, tested in
combination, produce a genuinely narrow, non-bypass permission profile:

### `--permission-mode acceptEdits` — CONFIRMED (v2.1.257–258; re-confirmed v2.1.261, sprint 21), and narrower than its name suggests

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

### `--allowedTools "Bash(<pattern>)"` — CONFIRMED (v2.1.257–258; re-confirmed v2.1.261, sprint 21) to narrow genuinely, not just nominally

`--allowedTools "Bash(npm *)"` unblocked `npm --version` while `curl`
stayed blocked in the same run — the allowlist doesn't leak into
categories it wasn't given. A single specific script path
(`Bash(./run-tests.sh)`) unblocked exactly that script; general script
execution wasn't opened by it. Compound commands are evaluated per
sub-command against the allowlist ("This Bash command contains multiple
operations. The following parts require approval: ..." — sprint 21
re-verified this exact behaviour still holds at v2.1.261, though the CLI
now phrases the denial differently; see "Sprint 21 re-verification"
below) — not a loophole for smuggling an unapproved command alongside an
approved one.

### `--disallowedTools "Edit,Write"` — CONFIRMED (v2.1.257–258; re-confirmed v2.1.261, sprint 21) to hard-disable the TOOLS, not to prevent all writes

With both tools disallowed, an attempted Edit call returned `No such tool
available: Edit. Edit is disabled for this session` — the tool doesn't
exist for that session at all, a stronger guarantee than a permission
prompt that something might talk its way past. (v2.1.261 phrases this as
"The Edit tool is disabled for this session" — same mechanism, same
zero-denials shape, wording only; see "Sprint 21 re-verification".)

**Correction (QA1 round 1 on this sprint): this does NOT mean "writes
nothing."** Disallowing Edit/Write only removes those two tools — Bash
itself is untouched, and a plain single-line redirect (`printf '%s'
"content" > file`) still succeeds under this exact profile, confirmed by
running it (re-confirmed v2.1.261, sprint 21). This is what
qa1.md/liveqa.md's own headless fallback (see below) actually relies on,
and QA1 correctly caught that the finding here previously described the
scope as stronger than it is — the two artifacts contradicted each
other, one saying "writes nothing," the other giving instructions for
how to write a file.

**The asymmetry QA1 flagged, checked**: does a Bash redirect stay confined
to the working directory the same way the Write tool was found to be?
CONFIRMED (v2.1.257–258; re-confirmed v2.1.261, sprint 21) yes, symmetric
— `printf ... > /tmp/outside-file.txt` from inside a different working
directory was blocked with `Output redirection to '/tmp/...' was
blocked. For security, Claude Code may only write to files in the
allowed working directories for this session: ...` — the identical
directory bound, enforced at the Bash-redirect level too, not only at
the Write-tool level. This was a real, correctly-flagged gap in this
document (asserted as a "free" bound from the Write-tool case alone,
never checked against Bash) — now closed by running, not assumed. **This
is the single most load-bearing finding in this document** — sprint 19's
entire owned-repository grant design rests on it, and re-verifying it was
sprint 21's own highest priority; see "Sprint 21 re-verification" for the
v2.1.261 command and its (differently worded, behaviourally identical)
denial text.

**A separate, narrower finding from the same round of testing: multi-line
heredoc syntax (`cat <<'EOF' > file` ... `EOF`) is rejected outright**,
regardless of location, with `Contains shell syntax (file_redirect) that
cannot be statically analyzed` — a different, stricter rejection than the
directory-confinement block above, and one that fires even for a write
fully inside the working directory. CONFIRMED (v2.1.257–258;
re-confirmed v2.1.261, sprint 21 — the exact denial wording has since
changed, the rejection itself has not; see "Sprint 21 re-verification").
A single-line `printf '%s\n' "line
one" "line two" ... > file` (single-quoted format string, so the outer
shell never touches `\n`) was confirmed to work instead, producing real
newline bytes (verified with `od -c`) and correctly refusing to expand a
literal backtick or `$VAR` passed as a quoted argument — the same safety
property the original `--notes-file` mandate exists to protect, delivered
by a command shape that actually executes under this profile
(v2.1.257–258). **The redirect executing at all was re-confirmed v2.1.261
(sprint 21, see below); the specific byte-level `od -c` check and the
backtick/`$VAR`-refusal sub-claim were NOT independently re-run this
round** — downgraded from CONFIRMED to WEAK for that narrower sub-claim
specifically (Req 1: an entry that couldn't be re-verified is downgraded,
not left CONFIRMED with a guessed version), pending someone re-running
exactly that byte-level check. The qa1.md/liveqa.md/sprint-qa1.md/
sprint-liveqa.md fallback previously recommended the heredoc form; it has
been corrected to the verified `printf` form.

## Per-role scope, from the above

- **Dev Team (writes source, runs the test suite):** `--permission-mode
  acceptEdits` covers Edit/Write and ordinary git. The test suite itself
  needs an explicit `--allowedTools "Bash(node scripts/launcher_test.js)"`
  (or the project's equivalent) — CONFIRMED (v2.1.257–258) pattern (the
  `./run-tests.sh` case, re-confirmed v2.1.261 sprint 21, both the
  bare-command block and the narrow-allowlist unblock), not yet run
  against the real command.
- **QA1 (runs tests and reads code, never writes SOURCE via Edit/Write —
  but can still write its own notes/state files via Bash, confined to the
  working directory):**
  `--permission-mode acceptEdits --disallowedTools "Edit,Write"` plus the
  same test-command allowlist as Dev Team — CONFIRMED (v2.1.257–258;
  re-confirmed v2.1.261, sprint 21) as a combination (this exact profile
  was run: Edit hard-disabled, the allowlisted script ran and produced
  real output). See the corrected `--disallowedTools`
  section above for what this profile does and does not actually prevent.
- **Pipeman (git + npm):** git needs nothing beyond `acceptEdits` —
  CONFIRMED (v2.1.257–258; re-confirmed v2.1.261, sprint 21), including a
  real push. `npm` needs an explicit
  `--allowedTools "Bash(npm *)"` — CONFIRMED (v2.1.257–258; re-confirmed
  v2.1.261, sprint 21) for `npm --version`; `npm view` was not
  independently re-run this round but shares the same allowlist
  mechanism just re-verified for `--version` and `publish --dry-run`
  below. **`npm publish` specifically is UNTESTED** — inferred to follow
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
(dry-run)"). CONFIRMED (v2.1.257–258; re-confirmed v2.1.261, sprint 21 —
a fresh scratch package, `npm publish --dry-run --tag fc21test`, same
allowlist, same clean result): the same `Bash(npm *)` allowlist that
unblocked `--version`/`view` also covers `publish --dry-run`, with
nothing narrower needed. A first attempt used a prerelease-tagged test
version and npm itself refused it ("You must specify a tag using --tag
when publishing a prerelease version") — that's npm's own validation,
not a permission block, and the corrected version published clean on
retry.

**Master Controller writing a sprint file, as its own scenario.** Tested
directly against the real mechanism (`node scripts/run-lifecycle.js new
--title-file ...`), not inferred from Edit/Write generically:
- The `Write` tool, writing a file WITHIN the working directory,
  succeeded under plain `acceptEdits` alone — CONFIRMED (v2.1.257–258;
  re-confirmed v2.1.261, sprint 21), no allowlist needed, matching the
  earlier Edit-tool finding.
- Running `node scripts/run-lifecycle.js new` itself required an explicit
  `--allowedTools "Bash(node scripts/run-lifecycle.js *)"` entry — it is
  NOT auto-approved like `git`, it's in the same "interpreter + script"
  category as `python3 scripts/*` and `node scripts/*` generally.
  CONFIRMED (v2.1.257–258; re-confirmed v2.1.261, sprint 21, using
  `node scripts/run-lifecycle.js` itself as the probe). This
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
  any `--add-dir` configuration. CONFIRMED (v2.1.257–258; re-confirmed
  v2.1.261, sprint 21 — same result, Write tool to `/tmp/...` denied,
  zero bytes written, wording now "I don't have permission to write to
  X — it's outside the working directories I have access to"). That's
  exactly the "caller-designated
  working directory" bound Req 2 asked to test — it looks like it comes
  free with `acceptEdits`, not something this framework needs to
  separately wire up. Stated as an observation from one test, not a
  guarantee across every possible path shape.

## Req 4: the real six-role discovery pass

**Not re-graded individually in sprint 21's version pass** — this section
is a narrative record of one specific historical run (real dollar costs,
turn counts, one particular sprint driven through both gates once), not
a standing behavioural claim the permission model depends on the way the
mechanism-level findings above are. The mechanism-level claims this pass
itself exercised — `acceptEdits`, the allowlists, the disallow list, the
directory confinement — are exactly the ones re-verified individually
above and in "Sprint 21 re-verification" below; re-running the entire
six-role pass to re-confirm a narrative log was judged out of proportion
to what Req 2 asks for. Kept as-is, dated to its own original run, not
retroactively re-graded.

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
under this sprint's own Req 3 scoped profile. All three proposed safe
alternatives on their own rather than being blocked or improvising
something unsafe: a quoted heredoc via Bash (later found, on QA1's own
round-2 audit, not to actually execute under this profile — corrected
above to the verified `printf` form), and confirming notes contain no
backtick/`$`/backslash before passing `--notes` inline. All three said
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

## Sprint 21 re-verification — re-run, not read

**QA1 carried "one CONFIRMED entry has already expired" across at least
sprints 19 and 20.** This section is the actual re-run, not a reading of
the original entries followed by agreement with them — that distinction
is Req 2's own load-bearing check, and a re-verification that only reads
the old entries and nods would produce a document that looks freshly
confirmed and is not.

**Where this ran:** a throwaway `git init` scratch directory
(`/tmp/fc-sprint21-scratch`), never this repo, plus a throwaway bare
remote for the push/disallow tests and a throwaway scratch npm package
for the publish test — same discipline as sprint 12's own testing.
**Against:** `claude 2.1.261 (Claude Code)`, confirmed via `claude
--version` immediately before this pass, 2026-09-06. Every command below
was actually executed and its `permission_denials` field and file-system
side effects (or their absence) inspected directly — not inferred from
the model's own prose summary, which sprint 21's own methodology check
below shows cannot be trusted alone.

**Coverage: at minimum the entries sprints 17 and 19 cite, and beyond.**
Every mechanism-level CONFIRMED claim in this document above was
individually re-run, tagged inline where it appears. In one place, in
addition:

**A methodology trap, caught and worth recording on its own.** A first
compound-command probe (`git status; echo done` under `--allowedTools
"Bash(git status *)"`) came back with zero `permission_denials` and no
literal "done" in the result text — ambiguous evidence, since
`acceptEdits` already auto-approves `git` and `echo` on its own,
independent of any `--allowedTools` list, so a clean result there proves
nothing about allowlist-vs-compound-command behaviour specifically.
Re-run against `git push origin main 2>&1; echo "EXIT:$?"` under
`--allowedTools "Bash(git push *)"` instead (exactly sprint 18's own real
case, where `git push` needs the explicit allowlist entry and would
otherwise be denied on its own) produced a clean, unambiguous denial:
`permission_denials` populated with the exact compound command, result
text explicitly naming it "a compound command (push + echo)". Recorded
here because it's the same discipline QA1 keeps asking for — check the
actual denial, not the absence of one, and pick a probe where a clean
result would actually mean something.

**Result: zero of the re-verified entries have expired in behaviour.**
Every mechanism this document's permission model depends on, including
the interpreter/redirect escapes sprint 19 found separately and the bare
`Bash(*)` wildcard finding sprint 19 built the whole owned-repository
grant list around, still behaves exactly as previously described at
v2.1.261. What *has* changed, in three places, is the exact wording of a
denial message the CLI produces — never the underlying behaviour, and
nothing in this codebase pattern-matches on that exact wording (checked:
`run-role.js` reads `permission_denials`' structured fields, never the
free-text message), so none of this drift is a live defect:

| Behaviour | v2.1.257–258 wording (original) | v2.1.261 wording (now) |
|---|---|---|
| Redirect outside working directory | `Output redirection to '/tmp/...' was blocked. For security, Claude Code may only write to files in the allowed working directories for this session: ...` | `The command was blocked because '/tmp/...' falls outside this session's allowed working directories (...)` |
| Heredoc rejected outright | `Contains shell syntax (file_redirect) that cannot be statically analyzed` | `blocked by policy regardless of sandbox settings, since redirects like this can't be statically analyzed for safety` |
| Compound command denied | `This Bash command contains multiple operations. The following parts require approval: ...` | `blocked by the permission system because it's a compound command (push + echo)` |

**Also re-verified, beyond this document's own original scope, because it
is the specific claim sprints 17/19's own citations lean on hardest** —
the sprint 19 finding that a bare `Bash(*)` allowlist entry (or the bare
tool name `Bash`, no pattern) disables the path-based redirect-confinement
check entirely, while a real, specific prefix pattern (even a broad one
like `Bash(git *)`) does not. Both re-confirmed directly at v2.1.261:
`--allowedTools "Bash(*)"` let `printf x > /tmp/fc21-wildcard-escape.txt`
through with zero denials, file created outside the working directory;
the identical command under `--allowedTools "Bash(git *)"` was blocked,
same denial shape as every other redirect-confinement case above. This is
exactly why `OWNED_REPOSITORY_ALLOWED_TOOLS` in `run-role.js` is a list of
real prefixes and never a wildcard — re-confirmed, not merely still
believed.

**Entries downgraded rather than left CONFIRMED with a guessed version**
(Req 1): the `od -c` byte-level check and the backtick/`$VAR`-refusal
sub-claim on the `printf` note-writing pattern (redirect mechanism
re-confirmed; that specific narrower sub-test was not independently
re-run this round — see inline note above); the Req 4 six-role narrative
log (a historical record of one run, not re-graded — see inline note
above); `npm view` specifically (the allowlist mechanism it shares with
`--version` and `publish --dry-run` was re-confirmed, `view` itself was
not separately re-invoked).

**A new finding, outside this document's original claims entirely,
surfaced while building the re-verification harness rather than asked
for — recorded per this project's own standing practice of not
minimizing a discovery to fit the original ask.** `--allowedTools`'s CLI
argument is variadic (`<tools...>`) and its consumption is greedy: given
`--allowedTools "Bash(npm *)" "some prompt text"` with no flag between
the allowlist value and a following bare argument, the CLI folds the
bare argument into the allowlist too and then reports no prompt was
given at all — confirmed directly, reproduced by hand outside any
project code. **Production is not affected**: `run-role.js`'s
`headlessLaunchArgs()` always inserts `--no-session-persistence` (or
`--bare`) between the last permission argument and the trailing prompt,
confirmed by spawning `claude` with the exact argv array
`headlessLaunchArgs()` itself produces — real command, real result,
prompt received correctly. This is not a live defect, but it is a real
hazard for any future edit that reorders those arguments and removes
that terminating flag, silently turning "run the role" into "the role
was never given a prompt, and the failure message won't obviously say
why." Worth a maintainer's attention, not a requirement's — recorded
here rather than acted on, since Out of Scope reserves "changing any
permission behaviour" for its own sprint and nothing here needs to
change.

**Staleness made visible going forward** (Req 3): `run-role.js` now
carries `PERMISSION_FINDINGS_ANCHOR_VERSION = '2.1.261'` and calls
`warnIfPermissionFindingsStale()` at the start of every headless launch.
It compares the running `claude --version` against that anchor and
prints one line to stderr — only when they differ; silence is the
default outcome, and it never blocks a run, mirroring this section's own
conclusion that a version difference is not itself a defect. **The
message names this document by path but does not claim the reader can
open it** — checked against a real unpacked tarball's installed target
(same method as sprint 20's own Req 3 fix): this file is not in
`install.js`'s `FRAMEWORK_OWNED` list, so it never reaches a downstream
project, and the warning says so rather than pointing at a path that
would dangle for most of its actual audience. See
`scripts/launcher_test.js` for its test coverage (Req 5): both branches
(silent on a match, one clear warning on a real mismatch), the
null/can't-determine case (never a false alarm), and a real subprocess
launch confirming the warning never changes the exit code.
