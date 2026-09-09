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

**UNESTABLISHED (added sprint 26)**: measured by launching a role,
instructing it, and reading the JSON envelope it returned — a method
sprint 26 found does not reliably reproduce, even run twice, back to
back, at the identical `claude` version. Not disproved, not deleted: the
observation happened and is kept in full below. What changes is the
claim it supports — a CONFIRMED entry asserted a permission boundary held
*in general*; an UNESTABLISHED entry asserts only that a role reported
this outcome *once*, on the date given, under a method whose own
repeatability at a fixed version is now itself unestablished. See
"Sprint 26 re-grading" near the end of this document for the full
accounting, entry by entry, and for the two exceptions this document
still contains: one claim measured directly (no model in the loop) that
keeps its CONFIRMED grade, and one older narrative record sprint 21
already excluded from standing-claim grading for unrelated reasons.

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

**Superseded by sprint 26, read that section before trusting the
paragraph above.** "Independently re-run... and tagged accordingly" is
true as a description of what sprint 21 did; it is not true as a claim
that doing so established anything reliable. A downstream consumer later
ran the same kind of measurement twice, back to back, at one fixed
version, and got different answers both times. Almost every CONFIRMED
tag in this document — including ones re-run at v2.1.261 specifically —
is now UNESTABLISHED for that reason, tagged inline where it appears.
See "Sprint 26 re-grading" near the end of this document for the full
accounting, including the one entry that genuinely was measured directly
and still stands.

## The binary is false: scoping is real

The sprint's own framing was right to question the "blanket bypass or
nothing works" assumption. Three independent mechanisms, tested in
combination, produce a genuinely narrow, non-bypass permission profile:

### `--permission-mode acceptEdits` — UNESTABLISHED (model-mediated; was graded CONFIRMED, v2.1.257–258, re-confirmed v2.1.261 sprint 21 — see "Sprint 26 re-grading"), and narrower than its name suggests

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

**Stronger than "unestablished" for this specific claim (sprint 26):**
the "unlisted command gets blocked" half of this finding was not merely
re-measured by an unreliable method — it was directly contradicted on a
later version. `scripts/permission-gate-repro.js` (commit `867ba16`)
found that on claude 2.1.265, a single, non-chained Bash command with no
matching `allowedTools` entry, writing inside the working directory,
executed with **zero** permission denials. Sprint 23's own LiveQA later
narrowed the scope of that finding (see "Sprint 26 re-grading" below) —
it is not a general collapse — but this entry's original claim, as
stated, does not hold on every version tested since.

### `--allowedTools "Bash(<pattern>)"` — UNESTABLISHED (model-mediated; was graded CONFIRMED, v2.1.257–258, re-confirmed v2.1.261 sprint 21 — see "Sprint 26 re-grading") to narrow genuinely, not just nominally

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

### `--disallowedTools "Edit,Write"` — UNESTABLISHED (model-mediated; was graded CONFIRMED, v2.1.257–258, re-confirmed v2.1.261 sprint 21 — see "Sprint 26 re-grading") to hard-disable the TOOLS, not to prevent all writes

With both tools disallowed, an attempted Edit call returned `No such tool
available: Edit. Edit is disabled for this session` — the tool doesn't
exist for that session at all, a stronger guarantee than a permission
prompt that something might talk its way past. (v2.1.261 phrases this as
"The Edit tool is disabled for this session" — same mechanism, same
zero-denials shape, wording only; see "Sprint 21 re-verification".)

**Correction (QA1 round 1 on this sprint): this does NOT mean "writes
nothing."** Disallowing Edit/Write only removes those two tools — Bash
itself is untouched, and a plain single-line redirect (`printf '%s'
"content" > file`) still succeeds under this exact profile — UNESTABLISHED
(model-mediated; was graded CONFIRMED, re-confirmed v2.1.261 sprint 21 —
see "Sprint 26 re-grading"). This is what
qa1.md/liveqa.md's own headless fallback (see below) actually relies on,
and QA1 correctly caught that the finding here previously described the
scope as stronger than it is — the two artifacts contradicted each
other, one saying "writes nothing," the other giving instructions for
how to write a file.

**The asymmetry QA1 flagged, checked**: does a Bash redirect stay confined
to the working directory the same way the Write tool was found to be?
UNESTABLISHED (model-mediated; was graded CONFIRMED, v2.1.257–258,
re-confirmed v2.1.261 sprint 21 — see "Sprint 26 re-grading") yes, symmetric
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

**Fresher, still model-mediated, but a cleaner comparison (sprint 26,
via sprint 23's own LiveQA live test):** on claude 2.1.266, one release
past the version where the in-working-directory drift above was found, a
single Bash command writing OUTSIDE the working directory (the harness's
probe D) was denied — same mechanism, same outcome, on a newer version
than this entry's own last re-confirmation. That does not move this
entry's grade back to CONFIRMED (still model-mediated, still one run),
but it is a real, later, independent data point in this claim's favor,
unlike most of the entries below.

**A separate, narrower finding from the same round of testing: multi-line
heredoc syntax (`cat <<'EOF' > file` ... `EOF`) is rejected outright**,
regardless of location, with `Contains shell syntax (file_redirect) that
cannot be statically analyzed` — a different, stricter rejection than the
directory-confinement block above, and one that fires even for a write
fully inside the working directory. UNESTABLISHED (model-mediated; was
graded CONFIRMED, v2.1.257–258, re-confirmed v2.1.261 sprint 21 — the
exact denial wording has since changed, the rejection itself was not
independently re-examined after the drift finding; see "Sprint 21
re-verification" and "Sprint 26 re-grading").
A single-line `printf '%s\n' "line
one" "line two" ... > file` (single-quoted format string, so the outer
shell never touches `\n`) — UNESTABLISHED (model-mediated; base redirect
claim was graded CONFIRMED, v2.1.257–258, re-confirmed v2.1.261 sprint 21
— see "Sprint 26 re-grading") — was reported to work instead, producing
real newline bytes (verified with `od -c`) and correctly refusing to
expand a literal backtick or `$VAR` passed as a quoted argument — the
same safety property the original `--notes-file` mandate exists to
protect, delivered by a command shape that actually executes under this
profile (v2.1.257–258). **The specific byte-level `od -c` check and the
backtick/`$VAR`-refusal sub-claim were NOT independently re-run at
v2.1.261 either** — that narrower sub-claim was already downgraded to
WEAK for that reason (Req 1, sprint 21: an entry that couldn't be
re-verified is downgraded, not left CONFIRMED with a guessed version);
sprint 26 changes nothing about that sub-claim's grade (WEAK is not
CONFIRMED, so it was never eligible to become UNESTABLISHED — it was
already marked as resting on less than a full observation), but it is
model-mediated the same way everything else here is, and is named as
such rather than left implicitly exempt. The
qa1.md/liveqa.md/sprint-qa1.md/sprint-liveqa.md fallback previously
recommended the heredoc form; it has been corrected to the verified
`printf` form, and that correction (a documentation change, not a
behavioral claim) is unaffected by any of this.

## Per-role scope, from the above

- **Dev Team (writes source, runs the test suite):** `--permission-mode
  acceptEdits` covers Edit/Write and ordinary git. The test suite itself
  needs an explicit `--allowedTools "Bash(node scripts/launcher_test.js)"`
  (or the project's equivalent) — UNESTABLISHED (model-mediated; was graded
  CONFIRMED, v2.1.257–258, re-confirmed v2.1.261 sprint 21 — see "Sprint 26
  re-grading") pattern (the `./run-tests.sh` case, both the bare-command
  block and the narrow-allowlist unblock), not yet run against the real
  command.
- **QA1 (runs tests and reads code, never writes SOURCE via Edit/Write —
  but can still write its own notes/state files via Bash, confined to the
  working directory):**
  `--permission-mode acceptEdits --disallowedTools "Edit,Write"` plus the
  same test-command allowlist as Dev Team — UNESTABLISHED (model-mediated;
  was graded CONFIRMED, v2.1.257–258, re-confirmed v2.1.261 sprint 21 —
  see "Sprint 26 re-grading") as a combination (this exact profile was
  run: Edit hard-disabled, the allowlisted script ran and produced real
  output). See the corrected `--disallowedTools`
  section above for what this profile does and does not actually prevent.
- **Pipeman (git + npm):** git needs nothing beyond `acceptEdits` —
  UNESTABLISHED (model-mediated; was graded CONFIRMED, v2.1.257–258,
  re-confirmed v2.1.261 sprint 21 — see "Sprint 26 re-grading"), including a
  real push. `npm` needs an explicit
  `--allowedTools "Bash(npm *)"` — UNESTABLISHED (model-mediated; was
  graded CONFIRMED, v2.1.257–258, re-confirmed v2.1.261 sprint 21 — see
  "Sprint 26 re-grading") for `npm --version`; `npm view` was not
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
(dry-run)"). UNESTABLISHED (model-mediated; was graded CONFIRMED,
v2.1.257–258, re-confirmed v2.1.261 sprint 21 — see "Sprint 26
re-grading" — a fresh scratch package, `npm publish --dry-run --tag
fc21test`, same allowlist, same clean result): the same `Bash(npm *)`
allowlist that
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
  succeeded under plain `acceptEdits` alone — UNESTABLISHED (model-mediated;
  was graded CONFIRMED, v2.1.257–258, re-confirmed v2.1.261 sprint 21 —
  see "Sprint 26 re-grading"), no allowlist needed, matching the
  earlier Edit-tool finding.
- Running `node scripts/run-lifecycle.js new` itself required an explicit
  `--allowedTools "Bash(node scripts/run-lifecycle.js *)"` entry — it is
  NOT auto-approved like `git`, it's in the same "interpreter + script"
  category as `python3 scripts/*` and `node scripts/*` generally.
  UNESTABLISHED (model-mediated; was graded CONFIRMED, v2.1.257–258,
  re-confirmed v2.1.261 sprint 21 — see "Sprint 26 re-grading" — using
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
  any `--add-dir` configuration. UNESTABLISHED (model-mediated; was graded
  CONFIRMED, v2.1.257–258, re-confirmed v2.1.261 sprint 21 — same result,
  Write tool to `/tmp/...` denied,
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
text explicitly naming it "a compound command (push + echo)". UNESTABLISHED
(model-mediated; was graded as re-confirming entry #3 in "Sprint 26
re-grading"'s enumeration — the underlying "compound commands evaluated
per-subcommand" claim). Recorded here because it's the same discipline
QA1 keeps asking for — check the actual denial, not the absence of one,
and pick a probe where a clean result would actually mean something; that
discipline is unaffected by the method's own reliability problem, even
though the conclusion it supported is.

**"Result: zero of the re-verified entries have expired in behaviour" —
THIS SENTENCE, AS ORIGINALLY WRITTEN HERE, IS ITSELF ONE OF THIS
DOCUMENT'S OWN FALSE REASSURANCES (sprint 26).** It was wrong twice over:
first, on the method — it reported a single-run result as settled, and
sprint 26 found a single run of this exact method does not reproduce
even against itself; second, on the object level — the redirect-
confinement claim it lists as unexpired was later found, directly, to
NOT hold for the specific case of a single unlisted Bash command writing
inside the working directory (`scripts/permission-gate-repro.js`, commit
`867ba16`, claude 2.1.265). Kept here, struck through in substance rather
than deleted, because Req 2 keeps observations rather than erasing a
wrong conclusion quietly — a corrected document that shows no trace of
having been wrong is not more trustworthy than one that shows its work.
See "Sprint 26 re-grading," near the end of this document, for what
actually changed and did not. What *has* changed in wording, in three
places, regardless of the above — a fact still true on its own terms —
is the exact text of a denial message the CLI produces, never
demonstrated to be a live defect since nothing in this codebase
pattern-matches on that exact wording (checked: `run-role.js` reads
`permission_denials`' structured fields, never the free-text message):

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
same denial shape as every other redirect-confinement case above.
UNESTABLISHED (model-mediated — entry #13 in "Sprint 26 re-grading"'s
enumeration; no fresher observation either way since v2.1.261, unlike the
plain outside-cwd redirect case above, which sprint 23's LiveQA happened
to re-observe on 2.1.266 using the profile's actual granted prefixes,
never a bare wildcard). This is exactly why `OWNED_REPOSITORY_ALLOWED_TOOLS`
in `run-role.js` remains a list of real prefixes and never a wildcard —
the reasoning for that design doesn't depend on this entry's grade, only
the original observation that a real prefix and a bare wildcard behaved
differently at least once, which still stands as a single observation.

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
given at all — **DIRECT (entry #14 in "Sprint 26 re-grading"'s
enumeration; the one entry in this document graded direct, not
model-mediated — this is CLI argument-parsing, not tool-call permission
enforcement, and it happens before any model turn: no API call, no
`claude` session, `exit 1`, plain stderr text).** Re-confirmed today,
sprint 26, on the currently-installed claude (2.1.265, not 2.1.261 —
this finding was never anchored to a specific version and this
re-confirmation didn't need to be): `claude -p --allowedTools "Bash(npm
*)" "say the word BANANA and nothing else" --output-format json` exits
`1` immediately with `Error: Input must be provided either through stdin
or as a prompt argument when using --print` on stderr, no JSON envelope
produced at all — the CLI's own preflight argument check, verifiable by
exit code and stderr text alone, with nothing for a model to have
decided.
**Production is not affected**: `run-role.js`'s `headlessLaunchArgs()`
always inserts `--no-session-persistence` (or `--bare`) between the last
permission argument and the trailing prompt — UNESTABLISHED (model-
mediated; this specific sub-claim, unlike the parsing behaviour above,
required a completed model turn to confirm the prompt was actually
received and answered correctly, and so carries the same method problem
as every other entry in this document; see "Sprint 26 re-grading"),
confirmed by spawning `claude` with the exact argv array
`headlessLaunchArgs()` itself produces — real command, real result,
prompt received correctly, once, that one time. This is not a live
defect on the evidence available, but it is a real hazard for any future
edit that reorders those arguments and removes that terminating flag,
silently turning "run the role" into "the role was never given a prompt,
and the failure message won't obviously say why." Worth a maintainer's
attention, not a requirement's — recorded here rather than acted on,
since Out of Scope reserves "changing any permission behaviour" for its
own sprint and nothing here needs to change.

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

**Corrected, sprint 26 (Req 5):** the warning's own message used to add
"this bound has already survived one real CLI update unchanged" —
removed outright, not updated to a new count, since it was never a claim
this method could support at any version, including the one it named.
See "Sprint 26 re-grading" immediately below.

## Sprint 26 re-grading — by measurement method, not by confidence

**What happened.** A downstream consumer ran `scripts/permission-gate-
repro.js` (commit `867ba16`) twice against the identical `claude` binary
(2.1.265), same two roles, nothing differing but the clock. Three of
eight verdicts moved between the two runs. No single `(role, probe)`
pair produced a DRIFT verdict on both runs. QA1's own resulting
sentence, and the one everything below follows from: **a single run of
this harness cannot support a cross-version comparison.** Generalized
one level up, because the harness measures permission behaviour the same
way essentially every entry in this document does — launch a role,
instruct it, read the envelope — **the method itself cannot distinguish
a real bound from a coin.** Sprints 17 and 21 both returned CONFIRMED on
the redirect-confinement claim, two sprints apart; on this evidence,
those are two samples of a variable process that happened to agree,
which is what agreement looks like when a method manufactures it, not
necessarily what agreement looks like when a bound is real. Sprint 21's
own anchoring of this evidence to a CLI version made this worse, not
better — precision stacked on top of noise reads as more solid than
noise alone, and that is exactly backwards.

**The two measurement classes (Req 1).** The grade is about the method,
not the confidence — an entry can be carefully observed, written up at
length, cross-checked by a second person, and still be model-mediated.

- **Direct** — a shell command, a filesystem check, a hash comparison,
  something with no model deciding whether to act. Verifiable by exit
  code, stderr text, or a byte comparison, independent of what any agent
  chose to do.
- **Model-mediated** — launch a role, instruct it, read the JSON envelope
  it returns (`permission_denials`, the model's own prose, or both).
  This is how virtually every permission-behaviour claim in this
  document, from sprint 12 onward, was actually established: you cannot
  observe what Claude Code's own tool-permission layer does with a tool
  call unless something — a model, deciding — actually attempts that
  tool call. The layer evaluates `tool_use` blocks the model itself
  produces during a live turn; it has no other input.

**The count (Req 2), stated precisely rather than rounded** — QA1 round 1
correctly caught this document's own first draft undercounting by one:
this document has made **16 distinct, gradable claims** about permission
behaviour, organized as **15 numbered entries**, since entry 14 splits
into two sub-claims (14a, 14b) that warrant different method grades and
so are graded separately rather than as one. Of those 16 claims: **14
are model-mediated and are now graded UNESTABLISHED** (rows 1–13, plus
14b) — not disproved, not deleted, the observations are kept in place
inline, tagged, above. **1 (14a) is graded direct and keeps its CONFIRMED
grade.** The remaining numbered entry, **15** (the Req 4 six-role
narrative discovery pass), was already excluded from this grading system
by sprint 21's own text, for an unrelated reason (a historical record of
one run, never presented as a standing behavioural claim) — left exactly
as sprint 21 left it. 14 + 1 + 1 (excluded) accounts for all 16 claims
across all 15 numbered entries.

| # | Entry (short form) | Method | Grade after sprint 26 | Fresher context |
|---|---|---|---|---|
| 1 | `acceptEdits` auto-approves Edit/git/echo; blocks npm/curl/script-exec | model-mediated | UNESTABLISHED | **Contradicted**, not just unestablished, for the unlisted-single-command-inside-cwd case — see below |
| 2 | `--allowedTools "Bash(pattern)"` narrows genuinely, doesn't leak categories | model-mediated | UNESTABLISHED | **Contradicted**, same case as #1 |
| 3 | Compound commands evaluated per-subcommand against the allowlist | model-mediated | UNESTABLISHED | Re-run once more at v2.1.261 (methodology-trap paragraph), no fresher data since |
| 4 | `--disallowedTools "Edit,Write"` hard-disables those tools ("no such tool") | model-mediated | UNESTABLISHED | none |
| 5 | A plain Bash redirect still succeeds despite Edit/Write disallowed | model-mediated | UNESTABLISHED | none |
| 6 | Bash-redirect writes confined to the working directory, symmetric with Write tool | model-mediated | UNESTABLISHED | **Fresher supporting observation**: sprint 23's LiveQA re-observed this (outside-cwd denial) on 2.1.266 |
| 7 | Heredoc syntax rejected outright, any location | model-mediated | UNESTABLISHED | none |
| 8 | `printf` multi-line pattern works as a heredoc substitute | model-mediated | UNESTABLISHED | none (byte-level/backtick-refusal sub-claim already WEAK, unaffected) |
| 9 | `npm publish --dry-run` succeeds under the shared `Bash(npm *)` allowlist | model-mediated | UNESTABLISHED | none |
| 10 | Write tool succeeds inside the working directory under `acceptEdits` alone | model-mediated | UNESTABLISHED | none |
| 11 | `node scripts/run-lifecycle.js new` requires an explicit allowedTools entry | model-mediated | UNESTABLISHED | none |
| 12 | Write tool to an absolute path outside the working directory is blocked | model-mediated | UNESTABLISHED | none (distinct mechanism from #6 — Write tool, not Bash redirect) |
| 13 | Bare `Bash(*)`/`Bash` wildcard disables redirect-confinement; a real prefix does not | model-mediated | UNESTABLISHED | none — sprint 23's re-observation (#6) used real prefixes, never a bare wildcard |
| 14a | `--allowedTools`'s CLI argument is variadic and greedy, swallowing a trailing prompt | **direct** | **CONFIRMED** (re-confirmed today, v2.1.265) | CLI argv-parsing, not tool-call enforcement — a different question from every other row |
| 14b | Production's own argv ordering avoids 14a, prompt received correctly | model-mediated | UNESTABLISHED | none |
| 15 | Req 4's six-role narrative discovery pass | model-mediated | *(excluded from grading by sprint 21, unrelated reason)* | — |

**Which mechanism, not only how it was measured (per this sprint's own
Context).** Grading everything UNESTABLISHED with no further
differentiation would read as a general collapse, which is not what the
evidence shows and would be its own kind of overclaim in the opposite
direction from the original document's. Three mechanisms have more to
say than "unestablished, no further data":

- **Row 1/2 — contradicted, not merely unestablished.** The specific
  claim that an unlisted single Bash command writing inside the working
  directory gets blocked was directly shown NOT to hold, on claude
  2.1.265 (`scripts/permission-gate-repro.js`, commit `867ba16`). This is
  the strongest correction in this document: not "the method can't tell
  us," but "the method told us the opposite of the original claim, at
  least once, on a real later version."
- **Row 6 — a real, later, still model-mediated but independent
  supporting observation.** Sprint 23's LiveQA, running against claude
  2.1.266 with a real `@playwright/mcp` server, found the harness's own
  outside-working-directory Bash-redirect control (probe D) denied —
  the same mechanism, the same outcome, one version past where row 1/2's
  contradiction was found. That sprint also found the MCP-tool-name
  `allowedTools` matching mechanism itself enforces cleanly (`browser_navigate`
  ran, `browser_run_code_unsafe` was denied by name, a role granted no
  MCP tools at all was denied `browser_navigate` outright) — a mechanism
  this document never previously tested at all, so it isn't one of the
  15 numbered entries above, but it is real, current, model-mediated evidence that
  **the drift found in row 1/2 is scoped to unlisted single Bash commands
  writing inside the working directory specifically, not a general
  collapse of `allowedTools` enforcement.**
- **Every other row — genuinely unestablished, no fresher data either
  way.** Rows 3, 4, 5, 7, 8, 9, 10, 11, 12, 13 and 14b have not been
  re-examined since their last model-mediated observation. Not
  contradicted. Not reconfirmed. Unknown, and stated as such rather than
  assumed either direction.

**What can be probed without a model (Req 3), tried rather than
reasoned about in advance.** Three attempts, in order of how promising
each looked before trying it:

1. **A dedicated CLI subcommand or dry-run mode for permission
   evaluation.** `claude --help`'s full command list (`agents`, `attach`,
   `auth`, `auto-mode`, `doctor`, `gateway`, `import`, `install`, `logs`,
   `mcp`, `plugin`, `project`, `respawn`, `rm`, `setup-token`, `stop`,
   `ultrareview`, `update`) was read in full. None evaluates or reports
   on `--allowedTools`/`--disallowedTools` matching against a candidate
   tool call. No dry-run or explain mode exists for this.
2. **Injecting a synthetic assistant `tool_use` block via
   `--input-format stream-json`, bypassing the model's own decision
   entirely.** Tried directly: a JSONL input containing a real user
   message followed by a hand-crafted `{"type":"assistant","message":
   {"role":"assistant","content":[{"type":"tool_use",...,"name":"Bash",
   "input":{"command":"whoami"}}]}}` line was piped into `claude -p
   --input-format stream-json --output-format stream-json --verbose`.
   Result: the injected line was silently disregarded. The CLI generated
   a fresh assistant turn responding only to the real user message
   ("Hi!"), `permission_denials` empty, no sign the injected `tool_use`
   was ever seen by the permission layer. `--input-format stream-json`
   accepts streamed USER turns for a live conversation; it is not a
   channel for supplying the assistant's own turn. This closes off what
   looked like the most promising direct-probe avenue.
3. **CLI argument preflight validation**, which the investigation above
   for row 14a already used without originally being framed as a Req-3
   answer: this IS directly probable, and was — but it tests argument
   *parsing*, not tool-call *enforcement*. It answers "did the CLI accept
   this invocation," never "would this specific Bash command have been
   approved."

**Conclusion, stated plainly rather than softened into a design
proposal:** as far as this sprint could establish by trying, **nothing
about actual tool-call permission enforcement can currently be observed
without a model deciding to attempt a tool call**, because Claude Code's
permission layer only ever evaluates `tool_use` blocks the model itself
generates during a live turn, and no input channel, CLI mode, or
dry-run facility was found that supplies one without a model behind it.
This is a real constraint on what this framework can ever claim about
permissions, not a gap this sprint failed to close. **No replacement
measurement method was designed against this** (Out of Scope): a method
built on top of an unestablished surface is exactly how the original 15
entries above were produced.

**What this means for anyone building on this document next.** Sprints
17, 19, 21 and 23 each cited one or more of the rows above as settled —
17 and 19 in designing the original per-role headless profiles and the
owned-repository broad grant, 21 in anchoring this document to a CLI
version and declaring it re-verified, 23 in describing LiveQA's own
posture as resting partly on this evidence. None of those profiles are
changed by this sprint (Out of Scope) — what changes is that the
evidence they were built on is now named for what it actually is: one
model-mediated observation per row, not a demonstrated, reproducible
bound. That is not the same as "the profiles don't work" — it is "the
profiles' own justification document overstated what had been shown,"
which is a narrower and more honest claim, and the distinction is this
whole sprint's point.
