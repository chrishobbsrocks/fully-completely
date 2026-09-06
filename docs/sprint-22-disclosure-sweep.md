# Sprint 22 — disclosure sweep of the published package

Sprint 4 scrubbed a real client's name out of `scripts/launcher/session.js`
after it had already been published to npm in 0.1.2, past the 72-hour
unpublish window and therefore permanent. That fixed one instance. This is
the first time since — seventeen sprints — that every file the package
actually ships has been read specifically for what it *discloses*, not for
whether it works. Read for disclosure means: names of real people or
organisations other than the author, client or project identifiers,
absolute paths carrying a username or directory structure, internal URLs,
tokens or key-shaped strings, email addresses, machine names, and anything
describing a third party's work.

**Deliberately excluded from scope, stated rather than silently applied**
(the sprint's own instruction): the author's own name ("Chris Hobbs") and
the repository URL (`github.com/chrishobbsrocks/fully-completely`) are
already public via `package.json`'s `author` field and the `repository`
link. Treating either as a finding would bury the real ones. Every
occurrence of the author's own already-public name found during this sweep
(`LICENSE`, `package.json`, `scripts/launcher/session.js`'s own Windows-path
example comment, `scripts/launcher_test.js`'s matching synthetic Windows-path
test fixture) was checked against this exclusion and correctly excluded —
none of them disclose anything beyond what `package.json` already does.

## What was read

Every one of the 57 files `npm pack --dry-run` actually lists for the
package at this commit, confirmed file-for-file against that exact list
(re-run this to regenerate it for the next sweep: `npm pack --dry-run
--json`, extract `.files[].path`, sort). Seven are `.gitkeep` placeholders
with zero bytes — enumerated, not skipped, since "nobody looked" and
"nothing there" must never be indistinguishable, but there is by
construction nothing in an empty file to disclose.

```
.claude/agents/dev-team-1.md
.claude/agents/dev-team-2.md
.claude/agents/liveqa.md
.claude/agents/master-controller.md
.claude/agents/pipeman.md
.claude/agents/qa1.md
.claude/commands/sprint-abort.md
.claude/commands/sprint-complete.md
.claude/commands/sprint-dev-done.md
.claude/commands/sprint-list.md
.claude/commands/sprint-liveqa.md
.claude/commands/sprint-new.md
.claude/commands/sprint-qa1.md
.claude/commands/sprint-reship.md
.claude/commands/sprint-ship.md
.claude/commands/sprint-start.md
.claude/commands/sprint-status.md
.claude/commands/sprint-worktree.md
.github/workflows/scan.yml
.vscode/settings.json
.vscode/tasks.json
CLAUDE.md
LICENSE
README.md
docs/HUMAN_OVERRIDE.md
docs/sprint-12-permission-scope-findings.md
docs/sprints/0-backlog/.gitkeep
docs/sprints/1-todo/.gitkeep
docs/sprints/2-in-progress/.gitkeep
docs/sprints/3-done/.gitkeep
docs/sprints/4-blocked/.gitkeep
docs/sprints/5-abandoned/.gitkeep
docs/sprints/state/.gitkeep
package.json
scripts/baselines/check-staleness.js
scripts/baselines/generate.js
scripts/baselines/user-owned-content.json
scripts/dev2_worktree.sh
scripts/install.js
scripts/launcher/agents.js
scripts/launcher/auth.js
scripts/launcher/claude-cmd.js
scripts/launcher/content-hash.js
scripts/launcher/generate-tasks.js
scripts/launcher/jsonc.js
scripts/launcher/prompts.js
scripts/launcher/python-interpreter.js
scripts/launcher/rel-path-key.js
scripts/launcher/run-role.js
scripts/launcher/session.js
scripts/launcher_test.js
scripts/run-lifecycle.js
scripts/smoke_test.sh
scripts/sprint_lifecycle.py
scripts/verify-tarball.sh
scripts/worktree_test.sh
templates/sprint-template.md
```

Method: every non-empty file above was read in full, not grepped. A
pattern-based sweep was run first as an aid (emails, absolute paths,
key-shaped strings, the author's own name, case-insensitive), specifically
*because* it cannot be trusted alone — sprint 4's own finding was a real
client name inside a plausible-looking example string, which is not
pattern-shaped and nothing pattern-shaped would have caught it. The
pattern sweep surfaced candidates to look at closely; every file was still
read as prose or code on its own terms.

## Result: this is not a clean sweep. Two findings, neither scrubbed here.

Per Req 2: found and stopped, not found and fixed in the same commit. A
disclosure finding may not be scrubbable at all once it has shipped — sprint
4's could not be unpublished, only stopped from recurring — and that
decision belongs to the user, not to whoever ran the sweep. Both findings
below are recorded, not corrected, in this commit.

### Finding 1 — `scripts/launcher/run-role.js:55` and `:444`

The code comment names a specific real downstream consumer's project
identifier directly: **"Fifty Mission Cap"**, described as "an external
orchestrator... that installs this framework and drives docs/sprints/ from
outside" (line 55) and again at line 444 discussing that consumer's likely
use of `--bare` mode. This is a client/project identifier, the exact
category Req 1 names.

**Already published.** Confirmed by packing every released version from
the npm registry and checking each: absent through 0.1.16, present in
every published version from **0.1.17 onward** (0.1.17 through the current
0.1.22 — 6 releases). Past npm's 72-hour unpublish window for all of them;
permanent, same as sprint 4's finding.

### Finding 2 — `scripts/launcher_test.js:154-155`

A test hardcodes the actual author's real local absolute path:
`/Users/chrishobbs/Programming/fully-completely`, passed to `sessionsDir()`
as a test fixture value. This is materially different from the excluded
"author's own name" case above: `package.json`'s `author` field discloses
the public name "Chris Hobbs"; this line additionally discloses the
author's real macOS account/login username (`chrishobbs` — not the same
string as the public display name) and a fact about their local directory
layout (a `Programming` folder). "Absolute paths carrying a username or
directory structure" is Req 1's own named category. Every other session/path
test in this same file correctly uses a placeholder (`/Users/x/proj`,
`/private/tmp/fc test.dir/...`); this one line does not.

**Already published.** Confirmed the same way: absent in 0.1.0, present in
every published version from **0.1.1 onward** (0.1.1 through 0.1.22 — 22
releases, essentially this project's entire published history). Permanent,
same reasoning as Finding 1.

(Line 192 of the same file, `C:\Users\Chris Hobbs\Programming\fully-completely`,
was checked and is **not** a separate finding — it is a synthetic,
clearly-hypothetical Windows-path fixture using the author's own
already-public display name, explicitly framed in its own comment as
testing "the derivation logic's consistency, not a claim about the real
Windows CLI's behavior." It discloses nothing beyond what `package.json`
already does.)

### What decision this needs

Both findings are permanent regardless of what happens next — they cannot
be unpublished from the releases that already carry them, only stopped
from recurring in the next one. That is a decision for the user: whether
to scrub the two lines going forward (a real, small code change — a
project-name placeholder and a path placeholder, matching the pattern
every neighbouring test already uses) is not something this sweep decides
or does. Req 3's mechanical check will keep failing against Finding 2's
exact class of leak (a real local path) until that decision is made and
acted on; that failure is the check working as designed, not a defect in
this sprint's own verification.

**If you are Pipeman and `scripts/verify-tarball.sh` fails on this exact
finding before you publish: stop, do not work around it, and do not
publish past it on your own judgement.** QA1's round-1 audit of this
sprint named this precondition directly: Pipeman cannot clear it (fixing
the underlying line is explicitly not this sprint's call, and reworking
the check to stop flagging a real, known leak would just be a quieter way
of publishing past it), so per this project's own transition-precondition
rule (CLAUDE.md), it needs a documented cross-role recovery path rather
than silently blocking. That path is: bring this to the user, point them
at this section, and get one of two explicit decisions on record before
publishing —
1. **Fix the two lines first** (a real, small commit — replace "Fifty
   Mission Cap" and the real local path with placeholders, matching every
   neighbouring test's existing pattern), then publish once
   `verify-tarball.sh` passes cleanly, or
2. **The user explicitly authorizes publishing 0.1.23 anyway**, on the
   reasoning that both findings already exist in every prior published
   release (0.1.17+ and 0.1.1+ respectively) and 0.1.23 carrying them
   forward unfixed changes nothing about what is already permanently
   public — but that reasoning is the user's to make and record, not
   Pipeman's to assume on the sprint's behalf.
Either way, record which decision was made and why, the same discipline
this framework already applies to `/sprint-complete`'s own
`--user-said` requirement — a real-time human decision, not inferred from
silence or from the sprint having reached this gate.

## What was NOT found, stated as a result rather than left silent

No email address other than the reserved, RFC 2606 `example.com` domain
(`scripts/smoke_test.sh`, `scripts/worktree_test.sh`, both synthetic git
test-fixture identities). No internal URL. No key- or token-shaped string
(`sk-`, `ghp_`, `AKIA`, `Bearer <token>` patterns, checked across every
file). No machine name. No description of a third party's actual work
beyond the two findings above. Per Req 2's own instruction: "nothing found"
and "nobody looked" must never be indistinguishable in a record that says
neither — the file list above, and the fact that both real findings above
were still caught, is what makes this an actual result rather than an
unstated clean sweep.

## For the next sweep

Start from the file list above, re-generated fresh (`npm pack --dry-run
--json`), not copied forward — a file added since this sweep will not be
on this list, and a file removed will make an entry here read as "still
present" when it no longer ships. Confirm the two findings above are
either still present (unresolved) or scrubbed (and say which, with the
commit that did it). This document is deliberately excluded from the
published package itself (see `.npmignore`) so recording these findings
does not itself become a second, ongoing vector for the same two strings —
scrub the two lines when the user decides to, but do not let a future
sweep skip re-reading everything on the theory that this record already
covers it; a sweep that only re-checks a prior sweep's own list is exactly
"nobody looked," restated.
