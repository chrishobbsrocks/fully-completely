#!/usr/bin/env node
'use strict';
// Invoked by .vscode/tasks.json, one process per role terminal:
//   node scripts/launcher/run-role.js <role-id> [--restart]
//
// Default (smart): resumes the highest existing session generation for
// this (role, repo) pair if one exists on disk (`claude --agent <id>
// --resume <uuid>`); otherwise launches fresh at generation 0 (`claude
// --agent <id> --session-id <uuid> --name <title> "<initial prompt>"`).
// Both the session ID and the resume-vs-fresh decision come from
// scripts/launcher/session.js, which derives everything from the
// filesystem — there is no local state file. This is the task actually
// named after the role ("Master Controller", "QA1", ...), since it's the
// one people run day to day.
//
// --restart: skip resume entirely and always start a brand-new named
// session at the next generation, even if one is already recorded.
// Previous history isn't deleted, just not reconnected to — but the new
// session becomes the one the *next* normal launch resumes, since that's
// just whatever the filesystem scan finds as the new highest generation.
// Not wired into any VS Code task — VS Code ties a dedicated terminal's
// identity to the task's label, so a second task for the same role would
// open a second terminal alongside the first rather than replacing it.
// Run this by hand instead (e.g. from Shell) when you actually want to
// abandon a session.
//
// Model is never passed here — `--agent <id>` alone puts the agent file's
// own frontmatter `model:` in charge (confirmed to win even over an
// explicit --model), so frontmatter stays the single place a model is set.
//
// Sprint 11 adds a second, separate launch path, for driving a role
// headless — no terminal, no human in the loop. The default, composed
// shape (Req 3, amended mid-build):
//   node scripts/launcher/run-role.js --headless --agent qa1 --sprint 4
// One parameter, the sprint id — the launcher composes the opening prompt
// itself, from this role's own built-in template (headlessPrompt() in
// prompts.js). --agent works as a flag here (not just the interactive
// path's leading positional argument) so this shape needs nothing else on
// the command line; the leading positional role-id still works too, for
// callers that prefer it (see main()'s roleId resolution below).
//
// An explicit override remains available, read from a path, never passed
// as prompt text on a command line, and wins over --sprint when given:
//   node scripts/launcher/run-role.js --headless --agent qa1 --prompt-file <path>
//
// By default headless runs on the operator's own logged-in Claude session
// (Req 4, reversed mid-build — see runHeadless() below). --bare opts into
// the original isolated-credential behavior instead, for a consumer that
// specifically wants headless not to share this session:
//   node scripts/launcher/run-role.js --headless --agent qa1 --sprint 4 --bare [--settings <path-or-json>]
// --settings is only meaningful alongside --bare — it forwards verbatim to
// claude's own --settings flag, the real path for an apiKeyHelper-based
// project (see runHeadless() below).
//
// Requested by an external orchestrator (Fifty Mission Cap) that installs
// this framework and drives docs/sprints/ from outside, through
// sprint_lifecycle.py and state files only, never reading agent files or
// editing sprint files. See runHeadless() and its neighbors below for
// what headless does differently from the interactive path above, and why.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ROOT, ROLES, agentFilePath, readAgentMeta, agentBody } = require('./agents');
const { initialPrompt, devTeam2ResumePrompt, headlessPrompt } = require('./prompts');
const { resolveSession } = require('./session');
const { checkAuth } = require('./auth');
const { parseJsonc } = require('./jsonc');
const { claudeCommand } = require('./claude-cmd');

// Req 10: every launcher-level failure — claude not on PATH, an unreadable
// prompt file, an unknown role id, a missing --sprint, missing credentials
// — exits with this one reserved code, deliberately distinct from
// anything `claude` itself is known to return (0 for a completed turn, 1
// for its own is_error:true failures like "Not logged in", confirmed by
// running both). 64 borrows BSD sysexits.h's EX_USAGE convention ("the
// command was used incorrectly") rather than inventing an arbitrary
// number — a plausible, recognizable choice for "the launcher refused to
// even try," not verified against claude's full exit-code space (there's
// no way to enumerate that), only against the two codes actually observed
// here. Applied uniformly to every fail() call, interactive path included
// — the interactive path has no documented or tested exit-code contract
// (Req 6 verifies its argv shape, never its exit code), so this isn't a
// regression there, and having one fail() implementation for both paths
// is safer than threading a headless-only flag through every call site.
const LAUNCHER_FAILURE_EXIT_CODE = 64;

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(LAUNCHER_FAILURE_EXIT_CODE);
}

function claudeOnPath() {
  const [cmd, args] = claudeCommand(['--version']);
  const probe = spawnSync(cmd, args, { stdio: 'ignore' });
  // On Windows this runs via cmd.exe, which doesn't surface ENOENT the
  // way a direct spawn does when the target is missing — it exits
  // non-zero instead, so that has to be checked too, not just probe.error.
  if (probe.error) return false;
  return probe.status === 0;
}

// Sprint 15, Req 3: fixes a real, confirmed orphan, established by running
// it rather than by reasoning about signal semantics. Repro before this
// fix (POSIX; this file's `spawn()` never passes `detached`, so the child
// starts in the same process group as this launcher): start a role, note
// the child claude PID from `ps`, `kill -TERM <this-launcher's-own-pid>`
// from a second shell, watch `ps -o ppid= -p <child-pid>` — the child's
// ppid flips to 1 within about five seconds and it is still running past
// a minute, unkilled and still billing. Matches the sprint file's own
// field report from published 0.1.13 exactly (a real orphan, not a
// hypothetical one).
//
// Cause: `kill <pid>` (a plain kill, and what a timeout-based external
// orchestrator's own kill() call does) signals exactly the one PID it's
// given — never the process group. With no handler registered here,
// Node's default SIGTERM disposition terminates only THIS process; the
// child is never sent anything at all, so it's simply abandoned mid-run,
// gets reparented to PID 1 by the kernel, and keeps going.
//
// Ctrl-C in an interactive terminal is a genuinely different delivery
// path, and was never broken: a terminal's job control signals the whole
// foreground PROCESS GROUP, which this launcher and its child already
// share (again, never detached) — both processes already receive Ctrl-C's
// SIGINT directly and independently from the terminal, with or without
// anything registered below. Established by running it, not by reasoning
// about terminal semantics: a real pseudo-terminal (Python's stdlib
// `pty.fork()`, since an actual keypress isn't scriptable) running a
// stand-in launcher+child pair, sent the real Ctrl-C byte (0x03) on the
// pty's master side so the kernel's own tty line discipline is what turns
// it into SIGINT — not a direct kill() from the test. Both processes gone
// afterward (checked via `ps` from outside the pty), run once with the
// guard installed on the child and once without: identical outcome, both
// times — this fix changes nothing about that path.
//
// So the fix only needs to cover the path Ctrl-C doesn't reach: a signal
// that arrives at this launcher process and nowhere else. SIGINT is
// deliberately NOT handled here — registering a listener for it would
// suppress Node's own default SIGINT action on THIS process, and this
// process already gets Ctrl-C's SIGINT delivered directly by the
// terminal's process-group signalling above; adding a second, redundant
// forwarding path for it would only risk racing behaviour that already
// works, for no benefit.
//
// Named limits, not implied coverage (Req 3's own instruction):
//   - SIGKILL cannot be caught by any process, by POSIX definition — no
//     code anywhere can make a SIGKILL'd launcher clean up its child.
//     An orchestrator that wants this cleanup to run MUST use SIGTERM
//     (the default signal both plain `kill` and Node's own
//     child_process .kill() send), not -9/SIGKILL.
//   - Windows has no POSIX signal delivery at all; Node's own docs are
//     explicit that SIGTERM/SIGHUP aren't meaningfully deliverable there.
//     This mechanism is POSIX-only (macOS/Linux) and unverified on
//     Windows — not assumed to also cover it. A `taskkill` there is closer
//     in effect to SIGKILL than SIGTERM: nothing intercepts it. `claude`
//     also runs as a grandchild of `cmd.exe` on Windows (see
//     claude-cmd.js), one more layer this mechanism doesn't reach.
function installOrphanGuard(child) {
  // child.exitCode/signalCode both stay null while the process is still
  // alive (Node's own documented meaning); checked so a signal arriving
  // after the child has already exited on its own never calls kill() on
  // a PID that may since have been reused by something unrelated.
  const relay = (signal) => () => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal);
      } catch {
        // Already gone between the check above and this call — nothing
        // left to signal, not an error worth surfacing on the way out.
      }
    }
    // Matches the shell convention (128 + signal number) rather than 0 or
    // 1, so a caller inspecting this launcher's own exit code can tell
    // "died to a forwarded signal" apart from either a normal exit or an
    // unrelated failure.
    process.exit(signal === 'SIGTERM' ? 143 : 129);
  };
  const onTerm = relay('SIGTERM');
  const onHup = relay('SIGHUP');
  process.on('SIGTERM', onTerm);
  process.on('SIGHUP', onHup);
  // Removed once the child has exited on its own (the normal, unkilled
  // path every existing run already takes) so these listeners never
  // outlive the run they were installed for and never fire a redundant
  // kill() at a process that's already gone.
  child.on('exit', () => {
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGHUP', onHup);
  });
}

function spawnClaude(args) {
  return new Promise((resolve) => {
    const [cmd, fullArgs] = claudeCommand(args);
    const child = spawn(cmd, fullArgs, { stdio: 'inherit', cwd: ROOT });
    installOrphanGuard(child);
    child.on('error', (err) => {
      fail(`Failed to start claude: ${err.message}`);
    });
    child.on('exit', (code) => {
      resolve({ code });
    });
  });
}

// Sprint 11, Req 6: the argv builders below are pure — no spawning, no
// I/O — specifically so the interactive path can be regression-verified
// mechanically (asserting on their exact output) rather than by a claim
// in a handoff, and without needing a real claude process or credentials
// to do it. This is the exact shape every interactive launch already
// used before this sprint touched the file; extracted, not changed.
function freshLaunchArgs(role, sessionTitle, uuid) {
  return ['--agent', role.id, '--session-id', uuid, '--name', sessionTitle, initialPrompt(role.label)];
}

function resumeLaunchArgs(role, uuid, repoName) {
  const args = ['--agent', role.id, '--resume', uuid];
  if (role.id === 'dev-team-2') {
    args.push(devTeam2ResumePrompt(repoName));
  }
  return args;
}

async function launchFresh(role, sessionTitle, uuid) {
  return spawnClaude(freshLaunchArgs(role, sessionTitle, uuid));
}

// Sprint 11, Req 3: the headless prompt is read from a file, never taken
// as a CLI argument or built from anything an external caller could pass
// as free text on a command line. This is not about *this* file's own
// spawn() call — an array-based spawn never goes through a shell on
// either platform (see claude-cmd.js's own comment), so there is no
// injection risk in how this file invokes claude. It's that a
// `--prompt <text>` flag would invite an EXTERNAL caller (an orchestrator
// building its own invocation of this script) to construct that
// invocation by concatenating free text into a shell command line —
// exactly the class of bug that command-substituted a backtick out of a
// permanent LiveQA record this week (a different file, same failure
// class). A file path is a small, low-entropy value; the free text never
// has to survive a shell at all, on either side of the call.
function readPromptFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    fail(
      `Could not read --prompt-file '${filePath}': ${err.message}. Headless mode needs the ` +
        'opening prompt in a real, readable file.'
    );
  }
  const trimmed = content.trim();
  if (!trimmed) {
    fail(`--prompt-file '${filePath}' is empty. Headless mode needs a real opening prompt.`);
  }
  return trimmed;
}

// Sprint 11, Req 1: headless spawns claude as a genuinely separate OS
// process, exactly the way the interactive path above already does (same
// spawnClaude(), same child_process.spawn()) — stated explicitly here
// because CLAUDE.md forbids one role session sub-agenting another, and a
// headless launch path is exactly the kind of feature that could quietly
// become that loophole if this weren't kept true on purpose. A headless
// role never spawns, calls into, or shares a process with any other
// role's session; it is one process, doing one role's one-shot piece of
// work, printing one JSON result, then exiting.
//
// Discovered by running it, not by reading: `--agent <id>` ALONE fails in
// --bare mode with "not found. Available agents: claude, Explore,
// general-purpose, Plan, statusline-setup" — Claude Code's own built-in
// types, not this project's .claude/agents/*.md personas, because --bare
// skips reading them entirely (consistent with its own documented
// CLAUDE.md-auto-discovery skip). The fix, also confirmed by running it:
// supply the persona explicitly via
// `--agents '{"<id>":{"description":...,"prompt":...,"model":...}}'`
// alongside `--agent <id>` — agents.js's agentBody()/readAgentMeta() below
// build this from the exact same frontmatter/body split the interactive
// path already uses, so the two can never describe the persona
// differently. Confirmed against a real successful (non-bare, OAuth) run
// this round: `model` inside this JSON IS honored — a role launched via
// this path ran as its own frontmatter model, not a default.
//
// Req 4, amended mid-build: reverses the original isolation goal.
// --bare is now opt-in (see `bare` below), not unconditional — the
// default path runs on the operator's own logged-in session, same as
// interactive. --bare, when given, still needs its own credentials
// exactly as QA1 rounds 1-2 verified: ANTHROPIC_API_KEY, or `settings`
// forwarded verbatim as `--settings <value>` (a path to a JSON file or an
// inline JSON string — --bare's own documented apiKeyHelper mechanism,
// meaningless without --bare so only applied there). Positioned before
// `prompt`, which must stay the final, positional argument either way.
//
// Req 4's own bar: "a documented unsuppressible side effect is
// acceptable; an assumed-away one is not." --bare's help text names eight
// things it bundles: hooks, LSP, plugin sync, attribution, auto-memory,
// background prefetches, keychain reads, and CLAUDE.md auto-discovery.
// Findings below are what was actually run and observed on the non-bare
// path (QA1 round 3: these were missing from this comment entirely,
// which is indistinguishable from assuming them away — fixed now):
//   - Hooks: CONFIRMED still fire. A real project-level SessionStart hook
//     (a `.claude/settings.json` writing a marker file) fired on a plain
//     non-bare run with no --safe-mode. Unsuppressed, undocumented
//     workaround exists on this path.
//   - CLAUDE.md auto-discovery: CONFIRMED still happens. A real run in a
//     scratch directory with a marker phrase in CLAUDE.md echoed that
//     phrase back when asked. Unsuppressed.
//   - `--safe-mode` (the one flag that looked like it might suppress
//     several of these at once) is NOT usable here at all: confirmed by
//     running it, it also disables the explicit `--agents` override this
//     whole mechanism depends on — "--agent 'test' not found. Available
//     agents: claude, Explore, general-purpose, Plan" — so it was ruled
//     out, not left untried.
//   - Attribution: ONE real test (a headless run instructed to make a git
//     commit with an exact, explicit message) showed no attribution
//     trailer added. Weak evidence, stated as such — it doesn't rule out
//     attribution behavior on a commit message the model composes itself
//     rather than one dictated verbatim, which wasn't tested.
//   - Auto-memory: no `memory/` directory appeared under
//     ~/.claude/projects/<slug>/ after several trivial one-shot test runs
//     — but that plausibly reflects the prompts being too trivial to
//     trigger memory generation, not confirmed suppression. Inconclusive,
//     documented as such rather than claimed as a finding.
//   - LSP, plugin sync, background prefetches, keychain reads: NOT
//     individually tested — no practical way found to observe any of the
//     four from outside the process in the time available. Genuinely
//     unknown, not assumed suppressed.
// `--no-session-persistence` (--print-only, confirmed compatible with the
// explicit --agents override by running it) is NOT one of --bare's eight
// bundled items — it addresses a separate, independently-found footprint
// concern: a one-shot, unattended headless run has nothing to resume
// later, so letting it persist a session transcript under
// ~/.claude/projects/... anyway (confirmed: a real non-bare run left a
// `.jsonl` transcript file behind) is its own avoidable side effect, fixed
// here because a working, tested fix existed for it specifically.
// Sprint 12, Req 3: DECIDED — a scoped profile, not blanket bypass. Full
// evidence in docs/sprint-12-permission-scope-findings.md (sprint 12's own
// worktree): `--permission-mode acceptEdits` auto-approves Edit/Write
// WITHIN the launch directory (confirmed: a write outside it, to an
// absolute /tmp path, was still blocked under acceptEdits — the directory
// confinement Req 2 asked to test appears to already be inherent, not
// something this file needs to configure separately), but still requires
// approval for `npm`, `curl`, and running any interpreter-invoked script
// (`node scripts/*`, `python3 scripts/*`) — the exact wall Dev Team 1 hit
// directly attempting `node scripts/run-lifecycle.js status`.
// `--allowedTools "Bash(<pattern>)"` was confirmed to narrow genuinely
// rather than nominally (allowlisting npm never opened curl; allowlisting
// one script path never opened script execution generally; multiple
// space-separated patterns in one string — the shape used below — were
// confirmed to combine correctly). `--disallowedTools "Edit,Write"` was
// confirmed to hard-disable those TOOLS outright ("No such tool
// available"), used for qa1 and liveqa below since neither writes source.
//
// Sprint 17, Req 2 — the boundary this file kept getting wrong, stated
// once, plainly, here: **`acceptEdits` governs TOOL use (Edit, Write). It
// says nothing about Bash.** Every Bash command, including git, needs its
// own `--allowedTools` entry or it isn't approved — full stop, regardless
// of `--permission-mode`. This is the third time this exact conflation
// produced a real, shipped defect: sprint 12 itself found the sibling
// case (QA1's own finding, re-checked against this new wording as this
// Req's own criterion requires) — a plain Bash redirect (`echo x > file`)
// still WRITES even with `--disallowedTools "Edit,Write"` set, because
// disallowing the Edit/Write TOOLS never touched Bash's own ability to
// redirect output; and this sprint found the mirror image — this file's
// own comment claimed git was "free under acceptEdits" and pipeman's
// profile had no git entry at all, so a headless ship attempt was denied
// and correctly reported BLOCKED. Tools and Bash are two independent
// axes; neither `--permission-mode` nor `--disallowedTools` reaches
// across to the other, in either direction. State it once, here, so the
// next person extending a profile doesn't have to rediscover it a fourth
// time.
//
// Sprint 17, Req 1 finding, recorded honestly rather than smoothed over:
// re-testing the git-push denial directly against the CURRENT `claude`
// CLI (2.1.261 — a point release newer than 2.1.260, recorded during
// sprint 14's own testing days earlier) in the DEFAULT, non-`--bare`
// headless path, `git push` to a real bare local remote succeeded with
// ZERO permission_denials, using pipeman's OLD profile with no git entry
// at all — the exact opposite of this sprint's own Context claim, and of
// the denial LiveQA actually observed. Reproduced three times (a bare
// `git push`, a ten-command git sweep, a bare `git status`), all clean.
// This was NOT re-tested under `--bare` mode (no ANTHROPIC_API_KEY
// available in this environment) — an external, unattended orchestrator
// like Fifty Mission Cap is exactly the caller likely to use `--bare`,
// and that mode's Bash behavior was never independently confirmed here to
// match the default path's. Given that gap, and given the whole point of
// Req 2 above is that undocumented, version-dependent "it happens to work
// today" behavior is not something to build on, git is allowlisted
// explicitly below regardless of whether the symptom currently
// reproduces in default mode — the CLI already changed once inside this
// same investigation; relying on its current unlisted-git behavior
// staying this way would just be next sprint's instance of this same
// mistake.
//
// Every role needs the two lifecycle-script invocation patterns — every
// slash command ultimately runs through one of them. Beyond that, each
// role gets exactly what Req 1's own per-role breakdown named, nothing
// broader:
//   - dev-team-1/2: writes source (covered by acceptEdits alone) and runs
//     THIS PROJECT'S OWN declared test command (readDeclaredTestCommand()
//     below — the sprint's own "if the honest answer is that the target
//     must declare it, say so and define where": defined in
//     .vscode/settings.json's `fullyCompletely.testCommand`, merged in by
//     install.js with no default value, since no single command is
//     correct across every downstream project). No declaration -> no
//     test-running Bash permission at all, an honest gap rather than a
//     guess. The old hardcoded `Bash(node scripts/launcher_test.js)` and
//     `Bash(bash scripts/verify-tarball.sh)` patterns are gone entirely —
//     both are THIS repo's own dev tooling (see CLAUDE.md's "Changes to
//     this repo's own tooling"), never a downstream project's, and
//     verify-tarball.sh specifically has no downstream equivalent at all.
//   - qa1: the identical test-running mechanism as dev-team, for the
//     identical reason — QA1's own process (qa1.md) requires demonstrating
//     a FAIL with "a command whose output shows the defect," which means
//     running the target's own tests, not this repo's.
//   - pipeman: git, enumerated by subcommand rather than `Bash(git *)`
//     (Req 3's own named example) — status/log/diff/fetch (branch review,
//     step 2), add/commit (step 9.3 and conflict resolution), rebase/merge
//     (step 5), checkout (conflict resolution, step 4), push (steps 6 and
//     9.3, the headline gap). npm held to the same standard on QA1's
//     round-1 finding (round 1 shipped blanket `Bash(npm *)`, which — like
//     `Bash(git *)` — reaches well past pipeman's actual job: `npm
//     install` alone runs arbitrary unattended postinstall scripts, which
//     nothing pipeman.md documents it ever needing): `npm publish` (step
//     9.2, confirmed clean including `--dry-run` under exactly this
//     profile), `npm view` (step 10's `gitHead` check), `npm pack` (the
//     inspection step 9.1's own tarball leak-check performs when that
//     script is present — see pipeman.md step 9.1's own conditional).
//   - liveqa: npm and npx added and TESTED (not inferred from the
//     definition, per this Req's own instruction) — `npx <published
//     package>` into a scratch directory, confirmed clean under exactly
//     this profile. `npm install` narrowed the same way as pipeman's npm
//     (round-1 shipped blanket `Bash(npm *)` here too) — Req 1's own text
//     names installing a published package as the job, which `npm
//     install` states directly. `Bash(npx *)` deliberately stays broad,
//     an argued exception rather than an oversight: the whole point of
//     `npx <package>` here is running THIS SPRINT'S published package
//     under test, whose name is a different string for every downstream
//     project and every sprint — there is no fixed prefix narrower than
//     the subcommand itself to enumerate against, unlike git's or npm's
//     fixed, known verb set. The real browser-driving tools (Playwright/
//     Chrome MCP) still aren't scoped here — out of reach of a
//     synthetic-agent scratch test, untested as such, not assumed to need
//     broader Bash.
//   - master-controller: writes a sprint file (covered by acceptEdits
//     alone, confirmed directly in sprint 14 — not inferred, and
//     re-confirmed unregressed here). Unchanged by this sprint.
// Sprint 19, Req 1/5: the broad grant, opt-in per repository via
// resolveOwnedRepositoryGrant() above. Every entry here is a real,
// non-empty command prefix -- established by running it (this sprint's
// own build) that a bare `Bash(*)` (or the bare tool name `Bash` with no
// pattern at all) genuinely disables Claude Code's own separate,
// path-based redirect-confinement check: a write to an absolute path
// OUTSIDE the working directory succeeded, with zero permission_denials,
// under exactly that shape -- reproduced three times. A real, specific
// prefix pattern, even a broad one like `Bash(git *)`, does NOT have this
// effect -- confirmed directly, same test, same result every time: the
// identical "Output redirection ... was blocked" refusal Req 5 exists to
// re-verify. So this list is deliberately never a wildcard, no matter how
// broad -- that's not a stylistic choice, it's the only shape that keeps
// Req 5's confinement bound intact at all.
//
// Named as incomplete, on purpose (same principle as Req 6's own bare-
// interpreter list): this covers the toolchain surface actually reported
// (npx, a local node_modules binary, curl, git) plus the common
// neighbours of each, not literally every build tool that exists. A
// project whose toolchain needs something not listed here will still see
// a denial -- that denial is honest, not a defect this list claims to
// have eliminated. `git push` is carried in DISALLOWED, not left out of
// ALLOWED, so `git` stays broadly usable for review/build purposes while
// Req 7's own invariant ("Pipeman remains the only pusher") holds exactly
// as before -- confirmed directly: `Bash(git *)` allowed plus
// `Bash(git push *)` disallowed lets `git status` through and denies
// `git push` outright, in the same real test.
// `node *`, `python3 *`, `bash *`, `sh *` are deliberately included here,
// even though a BARE, argument-less declaration of any one of them is
// exactly what Req 6's readDeclaredTestCommand() validation exists to
// reject. The two are different trust boundaries, not a contradiction:
// Req 6 guards a value a TARGET PROJECT's own tracked settings file can
// declare -- reachable by anyone with write access to that file, with no
// separate act of trust from the operator running the agent. This list
// only ever applies once the operator has ALREADY made the highest-trust
// act available in this framework (declaring the repository their own,
// validated above) -- at that point, `node`/`bash`/`python3` are exactly
// the core toolchain commands a real build needs (`node scripts/build.js`,
// `bash setup.sh`, `python3 setup.py`), and excluding them would defeat
// this sprint's own motivating case.
//
// QA1 round 1, correcting a claim this comment used to make: the risk
// these four carry is NOT "bounded by directory confinement" the way the
// heading above implies. Checked directly, at QA1's own prompt, rather
// than left as an assertion: `bash -c 'echo x > /tmp/x'` and `python3 -c
// "open('/tmp/x','w').write('x')"` both wrote OUTSIDE the working
// directory, zero permission_denials, no refusal at all. The redirect-
// confinement check (the "Output redirection ... was blocked" message
// Req 5's own re-verification relies on) is narrower than its name
// suggests: it recognises literal `>`/`>>` shell syntax in the OUTER
// command Claude Code itself parses, and nothing past that boundary --
// not a redirect hidden inside a `bash -c '...'` quoted argument, and not
// a file write performed by an interpreter's OWN native API (`open()`,
// `fs.writeFileSync()`) with no shell redirect anywhere in the command at
// all. `node -e "require('fs').writeFileSync('/tmp/x','x')"` was checked
// the same way and escapes identically.
//
// This is NOT unique to the four interpreters, and narrowing to just
// those four would have been a cosmetic fix, not a real one: `curl -o
// /tmp/x <url>` was checked the same way, escapes identically, and `curl`
// was never in question. The actual boundary is: any tool with its own
// "write to this path" argument -- an interpreter's inline-eval flag, a
// downloader's `-o`/`-O`, and almost certainly others never explicitly
// tried here (this list was not exhaustively probed for every entry) --
// sits entirely outside what the redirect-confinement check's pattern
// matching was ever built to recognise. It is a real backstop against the
// most literal, careless shell redirect, not a filesystem sandbox, and
// this comment previously overstated it as the latter.
//
// What ACTUALLY bounds this grant, stated accurately: git recoverability
// for anything inside this repository except uncommitted work (Req 4,
// accepted and named) and .env (Req 3's own OS-level, command-independent
// protection -- the one file this sprint protects against exactly this
// class of escape, which is why Req 3 doesn't rely on Bash pattern
// matching at all). Nothing here stops a sufficiently determined or
// badly-instructed agent from writing somewhere else on the filesystem
// entirely, the same residual risk npx/npm already carry the moment
// arbitrary package execution is granted at all (a package's own code has
// exactly the same file-system reach as `node -e` does -- there was never
// a narrower boundary there either). The real control this sprint relies
// on, honestly: the operator's own explicit, auditable act of declaring
// this repository theirs, on their own machine, trusting the agent with
// it -- not a technical sandbox this file can prove airtight. See Out of
// Scope: this was never meant to make an unattended broad grant safe in
// someone else's accounts, and this finding is exactly why that line is
// there.
const OWNED_REPOSITORY_ALLOWED_TOOLS = [
  'Bash(npm *)',
  'Bash(npx *)',
  'Bash(node *)',
  'Bash(./node_modules/.bin/*)',
  'Bash(yarn *)',
  'Bash(pnpm *)',
  'Bash(curl *)',
  'Bash(wget *)',
  'Bash(python3 *)',
  'Bash(python *)',
  'Bash(pip *)',
  'Bash(pip3 *)',
  'Bash(pytest *)',
  'Bash(bash *)',
  'Bash(sh *)',
  'Bash(make *)',
  'Bash(go *)',
  'Bash(cargo *)',
  'Bash(git *)',
  // Found by running the full reversed-motivating-case check, not
  // reasoned in advance: `mkdir && printf && chmod +x && ./local-binary`
  // was denied specifically at `chmod +x` -- a compound command gets
  // approved part by part, and chmod, needed to make a just-built local
  // script executable before ./node_modules/.bin/* (already on this
  // list) can run it, wasn't covered. Added after that real denial, not
  // before it.
  'Bash(chmod *)',
];
const OWNED_REPOSITORY_DISALLOWED_TOOLS = ['Bash(git push *)'];

const HEADLESS_PERMISSION_PROFILES = {
  'master-controller': {
    disallowedTools: [],
    allowedTools: ['Bash(node scripts/run-lifecycle.js *)', 'Bash(python3 scripts/sprint_lifecycle.py *)'],
  },
  'dev-team-1': {
    disallowedTools: [],
    allowedTools: ['Bash(node scripts/run-lifecycle.js *)', 'Bash(python3 scripts/sprint_lifecycle.py *)'],
    needsTestCommand: true,
    eligibleForOwnedRepositoryGrant: true,
  },
  'dev-team-2': {
    disallowedTools: [],
    allowedTools: ['Bash(node scripts/run-lifecycle.js *)', 'Bash(python3 scripts/sprint_lifecycle.py *)'],
    needsTestCommand: true,
    eligibleForOwnedRepositoryGrant: true,
  },
  qa1: {
    disallowedTools: ['Edit', 'Write'],
    allowedTools: ['Bash(node scripts/run-lifecycle.js *)', 'Bash(python3 scripts/sprint_lifecycle.py *)'],
    needsTestCommand: true,
    eligibleForOwnedRepositoryGrant: true,
  },
  pipeman: {
    disallowedTools: [],
    allowedTools: [
      'Bash(node scripts/run-lifecycle.js *)',
      'Bash(python3 scripts/sprint_lifecycle.py *)',
      'Bash(npm publish *)',
      'Bash(npm view *)',
      'Bash(npm pack *)',
      'Bash(git status *)',
      'Bash(git log *)',
      'Bash(git diff *)',
      'Bash(git fetch *)',
      'Bash(git add *)',
      'Bash(git commit *)',
      'Bash(git rebase *)',
      'Bash(git merge *)',
      'Bash(git checkout *)',
      'Bash(git push *)',
    ],
  },
  liveqa: {
    disallowedTools: ['Edit', 'Write'],
    allowedTools: [
      'Bash(node scripts/run-lifecycle.js *)',
      'Bash(python3 scripts/sprint_lifecycle.py *)',
      'Bash(npm install *)',
      'Bash(npx *)',
    ],
  },
};

// Sprint 17, Req 1: reads the target project's own declared test command
// from its .vscode/settings.json (merged in by install.js's
// mergeSettings(), see that function's own comment) — the framework
// cannot know a downstream project's test command in advance, so this is
// the one place that project gets to say what it is, rather than this
// file hardcoding its own. Read from ROOT (this file's own two-levels-up
// resolution in agents.js), which is the actual installed project root
// at runtime, not wherever this session happens to be invoked from.
// Returns null on anything short of a real, non-empty declared string —
// missing file, unparseable JSONC, wrong type, blank — every one of those
// means "not declared," and the caller's job is to grant no test-running
// permission at all rather than guess, same conservative-default shape
// resolve_text()/readBaselines() already use elsewhere in this project.
// `root` defaults to the module-level ROOT (real production behavior) but
// is overridable so tests can point this at a scratch directory instead
// of this repo's own real, off-limits .vscode/settings.json.
function readDeclaredTestCommand(root = ROOT) {
  const settingsPath = path.join(root, '.vscode', 'settings.json');
  let raw;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = parseJsonc(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const value = parsed['fullyCompletely.testCommand'];
  const command = typeof value === 'string' && value.trim() ? value.trim() : null;
  // Sprint 19, Req 6: a bare interpreter here would become
  // `Bash(<command> *)`, which matches `node -e "<anything>"` exactly as
  // readily as a real test invocation -- rejected rather than granted,
  // printed loudly (a silently-dropped declaration would look identical
  // to a typo, with no way to tell them apart) and treated as "not
  // declared" (no test-running permission at all) rather than the
  // launcher guessing at what was actually meant.
  if (command && isBareInterpreter(command)) {
    console.error(
      `WARNING: .vscode/settings.json declares "fullyCompletely.testCommand": "${command}" -- a bare ` +
        'interpreter with no script/arguments. Rejected: this would grant Bash access to that interpreter\'s ' +
        'own inline-code flags (e.g. `node -e`), which is arbitrary code execution, not a scoped test ' +
        'command. No test-running permission granted for this session. Declare the real command instead, ' +
        'e.g. "node test/all.js" or "npm test".'
    );
    return null;
  }
  return command;
}

// Sprint 19: bare interpreters that, combined with the trailing ` *`
// wildcard readDeclaredTestCommand()'s caller appends, yield arbitrary
// code execution (`Bash(node *)` matches `node -e "<anything>"` just as
// readily as it matches a real test invocation). Named explicitly rather
// than pattern-matched, and named as incomplete: this catches the exact
// shape Req 6 names (a bare interpreter, no arguments) and nothing more —
// `node --experimental-x script.js` or a wrapper script that itself execs
// an interpreter are NOT caught here. Sprint 18's own remaining items
// (the compound-command `; echo $?` question) are a separate, larger
// problem, deliberately left there rather than folded in here.
const BARE_INTERPRETERS = new Set(['node', 'bash', 'sh', 'zsh', 'python3', 'python', 'python2', 'ruby', 'perl', 'php']);

function isBareInterpreter(command) {
  return BARE_INTERPRETERS.has(command.trim());
}

// Sprint 19, Req 2: a plain, direct check — `git rev-parse
// --is-inside-work-tree` prints exactly "true" and exits 0 inside a real
// git working tree (including a linked worktree), anything else (not a
// repo, git missing, a bare repo) is treated as "not a git repository"
// rather than distinguishing why, since every one of those cases gets the
// identical refusal here.
function isGitRepository(dir) {
  const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf8' });
  return !result.error && result.status === 0 && result.stdout.trim() === 'true';
}

// Sprint 19, Req 1: reads the RAW declared value from .claude/settings.local.json
// -- Claude Code's own established convention for personal, machine-local,
// git-ignored-by-convention settings (this repo's own .npmignore already
// excludes its own copy of this exact path, for exactly that reason: "not
// part of the framework being installed, and install.js never reads this
// path either" -- still true here; install.js does not manage this file).
// Deliberately NOT .vscode/settings.json: that file is typically tracked
// by git and travels with the repository to everyone who clones it, which
// is the opposite of what an ownership declaration must be -- an act by
// THIS operator, on THIS machine, never inherited by a colleague, a CI
// runner, or a client who receives the same repository.
//
// Returns `{ present: false }` for every shape that means "nothing was
// declared, at all" -- no file, unparseable JSONC, wrong top-level shape,
// key absent, or present as a blank string (an operator who explicitly
// writes "" almost certainly means "not now", the same convention
// readDeclaredTestCommand() already treats install.js's own default
// empty string as) -- the caller must never refuse for any of these, only
// fall back to the narrow default profile in silence.
//
// Returns `{ present: true, value }` for everything else, INCLUDING a
// non-string value (a number, a boolean, an object) -- QA1 round 1 caught
// this asymmetry directly: a wrong-type declaration was silently treated
// as "not declared" while a wrong-*path* declaration was refused loudly,
// both fail-closed but inconsistently so, for a Req whose own stated
// principle is "validated, never sanitised." A `true` where a path string
// belongs is not "opting out", it's very likely a typo an operator would
// want to know about -- so the caller (resolveOwnedRepositoryGrant below)
// now refuses THIS shape loudly too, the same as every other malformed
// declaration, rather than quietly granting the narrow profile and
// leaving the operator to wonder why the broad one never applied.
function readOwnedRepositoryDeclaration(root) {
  const settingsPath = path.join(root, '.claude', 'settings.local.json');
  let raw;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch {
    return { present: false };
  }
  let parsed;
  try {
    parsed = parseJsonc(raw);
  } catch {
    return { present: false };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { present: false };
  if (!Object.prototype.hasOwnProperty.call(parsed, 'fullyCompletely.ownedRepository')) return { present: false };
  const value = parsed['fullyCompletely.ownedRepository'];
  if (typeof value === 'string' && !value.trim()) return { present: false };
  return { present: true, value: typeof value === 'string' ? value.trim() : value };
}

// Sprint 19, Req 1/2: the pure validator -- "validated, never sanitised."
// No fail() call anywhere in this function, deliberately: it only ever
// returns a verdict, `{ valid: true }` or `{ valid: false, reason: "..." }`,
// which is what makes it directly unit-testable with fake declarations and
// fake roots, without needing a subprocess just to avoid a real
// process.exit() firing mid test-run. resolveOwnedRepositoryGrant() below
// is the thin wrapper that turns an invalid verdict into a real, loud
// refusal; this function itself never exits anything.
//
// Checked, in order, each one a real adversarial case named in the sprint
// file: a relative path is refused outright (ambiguous relative to what,
// in a headless invocation with no interactive cwd to anchor it); then
// both the declared path and the real root are resolved with
// fs.realpathSync (resolves symlinks AND normalises case on
// case-insensitive filesystems -- macOS's default HFS+/APFS included) and
// compared for exact equality, which is what catches a declaration naming
// a parent directory, a sibling, a symlink pointing elsewhere, or a
// same-looking path with different casing; then, only once the path
// itself is proven correct, whether it's a real git repository (Req 2) --
// checked last so a non-git refusal never gets confused with a path
// mismatch.
function validateOwnedRepositoryDeclaration(declared, root) {
  if (!path.isAbsolute(declared)) {
    return {
      valid: false,
      reason:
        `.claude/settings.local.json declares "fullyCompletely.ownedRepository": "${declared}", which is not ` +
        'an absolute path. A relative declaration is ambiguous (relative to what?) and is refused rather than ' +
        'guessed -- declare the full absolute path to this exact repository, or remove the key entirely to ' +
        'use the default, narrower profile.',
    };
  }

  let realDeclared;
  try {
    realDeclared = fs.realpathSync(declared);
  } catch (err) {
    return {
      valid: false,
      reason:
        `.claude/settings.local.json declares "fullyCompletely.ownedRepository": "${declared}", which does not ` +
        `resolve to a real, existing path (${err.code || err.message}). Refused -- correct the path or remove ` +
        'the key to use the default, narrower profile.',
    };
  }
  const realRoot = fs.realpathSync(root);
  if (realDeclared !== realRoot) {
    return {
      valid: false,
      reason:
        `.claude/settings.local.json declares "fullyCompletely.ownedRepository": "${declared}" (resolves to ` +
        `${realDeclared}), which does not match the repository this session is actually running in ` +
        `(${realRoot}). A declaration must name this exact repository -- not a parent directory, not a ` +
        'sibling, not a symlink pointing elsewhere -- refused rather than granted against the wrong scope.',
    };
  }

  if (!isGitRepository(root)) {
    return {
      valid: false,
      reason:
        `.claude/settings.local.json declares "${root}" as an owned repository, but it is not a real git ` +
        "repository. Refused, not warned: git is the recovery boundary every downstream gate in this " +
        "framework assumes (QA1's audit, Pipeman's push, LiveQA's live test), and outside a repository none " +
        'of them runs early enough to prevent a loss. Run this inside a real git repository, or remove the ' +
        'declaration to use the default, narrower profile.',
    };
  }

  return { valid: true };
}

// The thin, I/O-and-fail() wrapper: not opted in -> { granted: false };
// invalid -> fail() (real process.exit, never returns); valid -> { granted: true }.
function resolveOwnedRepositoryGrant(root) {
  const declaration = readOwnedRepositoryDeclaration(root);
  if (!declaration.present) return { granted: false };
  // QA1 round 1: a non-string declared value must refuse loudly, same as
  // any other malformed declaration -- see readOwnedRepositoryDeclaration()'s
  // own comment for why this used to silently degrade to "not declared"
  // instead, and why that was the wrong default for this specific Req.
  if (typeof declaration.value !== 'string') {
    fail(
      '.claude/settings.local.json declares "fullyCompletely.ownedRepository" as type ' +
        `${Array.isArray(declaration.value) ? 'array' : typeof declaration.value} (${JSON.stringify(declaration.value)}), ` +
        'not a string. Refused -- declare the full absolute path to this repository as a plain string, or remove ' +
        'the key entirely to use the default, narrower profile.'
    );
  }
  const verdict = validateOwnedRepositoryDeclaration(declaration.value, root);
  if (!verdict.valid) {
    fail(verdict.reason);
  }
  return { granted: true };
}

// Sprint 19, Req 4: warns, then proceeds -- a deliberate choice, not a
// silent default. Refusing on a dirty tree was considered and rejected:
// dev-team's entire job is writing code, which means uncommitted changes
// are dev-team's OWN normal working state, not an anomaly -- a hard
// refusal here would make the broad grant nearly unusable for the exact
// role it exists for. The real risk this Req names (two sessions
// interleaving in one checkout) is not created by this grant and is not
// solved by refusing to launch; it is a pre-existing risk of any
// concurrent editing, and the operator's own ownership declaration already
// accepts responsibility for how the repository is used. What the warning
// buys: a real, timestamped line in the launcher's own stderr (visible to
// whatever orchestrator or terminal is watching it, even though the AGENT
// itself has no channel to read it back) naming exactly what was already
// uncommitted before this session touched anything -- useful after the
// fact, when two sessions' changes turn out tangled, to tell "already
// there" apart from "this session's own work."
function warnIfUncommittedWork(root) {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) return; // not a git repo, or git unavailable -- resolveOwnedRepositoryGrant already refused that case
  const dirty = result.stdout.split('\n').filter((line) => line.trim());
  if (dirty.length > 0) {
    console.error(
      `WARNING: ${root} has ${dirty.length} uncommitted change(s) before this session started: ` +
        `${dirty.slice(0, 10).join(', ')}${dirty.length > 10 ? ', ...' : ''}. Proceeding anyway (sprint 19, ` +
        "Req 4's own deliberate choice) -- recorded here so a later tangle between two sessions can be traced."
    );
  }
}

// Sprint 19, Req 3: .env* protection at the OS level, not via Claude
// Code's own Bash allow/deny patterns -- established by running it that
// those patterns cannot express "block writes to this specific file
// regardless of which command does it" (a disallowedTools entry
// targeting the redirect target, e.g. "Bash(printf * > .env*)", was
// tested directly and does NOT block "printf x > .env"; there is no
// generic file-target restriction in that system, only command-prefix
// matching). What DOES work, confirmed by running it: the filesystem's
// own immutable flag. macOS's `chflags uchg` blocks writes AND deletes
// with a real OS-level EPERM, regardless of which of several different
// commands (printf redirect, rm) attempts either -- confirmed directly,
// three ways, in the same real test. Linux's `chattr +i` is the
// documented equivalent (ext2/3/4) but was NOT independently verified in
// this build -- no Linux environment was available -- named as an
// unverified-but-expected case, not claimed as confirmed. Windows has no
// equivalent single command; `attrib +r` is meaningfully weaker (does not
// reliably block deletion) and is not attempted here -- named as a real
// gap rather than papered over with a partial mechanism presented as
// protection.
function envFilesIn(root) {
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  return entries.filter((name) => name === '.env' || name.startsWith('.env.')).map((name) => path.join(root, name));
}

function protectCommandFor(platform) {
  if (platform === 'darwin') return (file) => spawnSync('chflags', ['uchg', file]);
  if (platform === 'linux') return (file) => spawnSync('chattr', ['+i', file]);
  return null;
}

function unprotectCommandFor(platform) {
  if (platform === 'darwin') return (file) => spawnSync('chflags', ['nouchg', file]);
  if (platform === 'linux') return (file) => spawnSync('chattr', ['-i', file]);
  return null;
}

// Verifies protection actually took, rather than trusting the protecting
// command's own exit code -- some `chattr`-shaped tools silently no-op on
// filesystems that don't support the flag (overlay filesystems, tmpfs,
// some container/CI setups), which would otherwise look identical to a
// real success. A real write attempt is the only proof that means
// anything here.
function verifyEnvProtected(file) {
  const probe = spawnSync('sh', ['-c', `printf x >> ${JSON.stringify(file)} 2>/dev/null`]);
  return probe.status !== 0;
}

// Returns the list of files it actually protected (for unprotectEnvFiles
// to reverse later) and the list it could NOT verify as protected. Never
// throws; the caller decides what a non-empty `failed` list means for the
// grant as a whole.
function protectEnvFiles(root) {
  const protect = protectCommandFor(process.platform);
  const files = envFilesIn(root);
  const protected_ = [];
  const failed = [];
  for (const file of files) {
    if (!protect) {
      failed.push(file);
      continue;
    }
    protect(file);
    if (verifyEnvProtected(file)) {
      protected_.push(file);
    } else {
      failed.push(file);
    }
  }
  return { protected: protected_, failed };
}

function unprotectEnvFiles(files) {
  const unprotect = unprotectCommandFor(process.platform);
  if (!unprotect) return;
  for (const file of files) {
    unprotect(file);
  }
}

// `root` defaults to the module-level ROOT (real production behaviour)
// but is overridable, same reasoning as readDeclaredTestCommand() above,
// so tests can point the ownership check at a scratch directory instead
// of this repo's own real .claude/settings.local.json.
function headlessPermissionArgs(role, root = ROOT) {
  const profile = HEADLESS_PERMISSION_PROFILES[role.id];
  if (!profile) {
    // Every ROLES entry (agents.js) has a profile above; this only fires
    // if a role is ever added there without a matching update here —
    // fail loudly rather than silently launching with no scope at all.
    throw new Error(`No headless permission profile defined for role '${role.id}'.`);
  }
  const allowedTools = [...profile.allowedTools];
  const disallowedTools = [...profile.disallowedTools];
  if (profile.needsTestCommand) {
    const testCommand = readDeclaredTestCommand(root);
    // A trailing ` *` wildcard, matching every other multi-word pattern in
    // this file — confirmed (sprint 17) to also match the bare command
    // with no trailing arguments at all, not just one-or-more.
    if (testCommand) allowedTools.push(`Bash(${testCommand} *)`);
  }
  // Sprint 19, Req 1: only roles marked eligible above are even checked —
  // pipeman, liveqa, and master-controller keep exactly their sprint 17
  // profiles regardless of any declaration present, matching Req 7 ("every
  // downstream gate stays exactly as it is"). resolveOwnedRepositoryGrant()
  // itself calls fail() and never returns if a declaration IS present but
  // invalid, so reaching the `if` below with `{ granted: false }` means
  // either nothing was declared, or the role isn't eligible to receive it.
  if (profile.eligibleForOwnedRepositoryGrant) {
    const grant = resolveOwnedRepositoryGrant(root);
    if (grant.granted) {
      allowedTools.push(...OWNED_REPOSITORY_ALLOWED_TOOLS);
      disallowedTools.push(...OWNED_REPOSITORY_DISALLOWED_TOOLS);
    }
  }
  const args = ['--permission-mode', 'acceptEdits'];
  if (allowedTools.length) {
    args.push('--allowedTools', allowedTools.join(' '));
  }
  if (disallowedTools.length) {
    args.push('--disallowedTools', disallowedTools.join(','));
  }
  return args;
}

function headlessLaunchArgs(role, prompt, { bare, settings } = {}) {
  const meta = readAgentMeta(role.id);
  const body = agentBody(role.id);
  const definition = { description: (meta && meta.description) || role.label, prompt: body };
  if (meta && meta.model) definition.model = meta.model;
  const agentsJson = JSON.stringify({ [role.id]: definition });
  const base = ['--agent', role.id, '--agents', agentsJson, '-p', '--output-format', 'json', ...headlessPermissionArgs(role)];
  if (bare) {
    const settingsArgs = settings ? ['--settings', settings] : [];
    return [...base, '--bare', ...settingsArgs, prompt];
  }
  return [...base, '--no-session-persistence', prompt];
}

async function runHeadless(role, { sprintId, promptFilePath, bare, settings }) {
  // Req 4, amended: the credential check now branches on whether --bare
  // was requested, since it changes which credential source is actually
  // in play.
  //
  // --bare (opt-in isolation, unchanged reasoning from QA1 rounds 1-2):
  // checked here, before claude is even invoked, so the common failure
  // (no credentials supplied at all) is immediate and unambiguous rather
  // than waiting for --bare's own response — which is ALSO legible (a
  // well-formed envelope with is_error:true and a "Not logged in" result,
  // confirmed against the pinned notes and against a real credential-less
  // run) but easy for a careless consumer to miss buried inside a JSON
  // blob. This does not validate that a given --settings value actually
  // configures apiKeyHelper — doing that would mean re-implementing
  // claude's own settings-file parsing just to double-check it — so a
  // meaningless --settings value still passes this check and falls
  // through to --bare's own legible failure instead of this friendlier
  // one; an accepted trade, unchanged from round 1.
  //
  // Default (operator's own session): reuses checkAuth(), the EXACT same
  // check and the exact same credential source the interactive path below
  // already uses — Req 4 now explicitly wants headless to run on that
  // session, so checking it any other way would mean two different tests
  // of the same fact. Only a *confident* "unauthenticated" blocks; an
  // inconclusive probe proceeds, same reasoning as the interactive check.
  if (bare) {
    if (!process.env.ANTHROPIC_API_KEY && !settings) {
      fail(
        'Headless --bare mode needs its own credentials — neither ANTHROPIC_API_KEY nor ' +
          '--settings <file-or-json> was supplied. --bare reads strictly ANTHROPIC_API_KEY or ' +
          'apiKeyHelper, never the OAuth/keychain session an interactive launch (or headless ' +
          'without --bare) would use. Set ANTHROPIC_API_KEY, or pass --settings ' +
          '<path-or-inline-json> pointing at an apiKeyHelper config, and re-run: ' +
          'node scripts/launcher/run-role.js --headless --agent <role-id> --sprint <id> --bare ' +
          '--settings <path-or-json>.'
      );
    }
  } else if (checkAuth() === 'unauthenticated') {
    fail(
      'Claude reports no usable credentials for this operator session. Open a normal terminal, ' +
        "run 'claude', sign in, then re-run this task — or pass --bare with its own " +
        'ANTHROPIC_API_KEY or --settings if you specifically want this headless run isolated ' +
        'from this session instead.'
    );
  }
  // The file override wins when given, regardless of whether --sprint was
  // also passed — Req 3: an explicit override is the escape hatch, never
  // the default, so a caller reaching for it gets exactly what it asked
  // for rather than a silent tie-break the other way.
  const prompt = promptFilePath ? readPromptFile(promptFilePath) : headlessPrompt(role, sprintId);
  // headlessLaunchArgs() -> headlessPermissionArgs() already resolved and
  // validated any ownership declaration as part of building the args
  // above (fail()ing, and exiting, if one was present but invalid) — this
  // re-resolves the same, already-validated grant only to decide whether
  // the .env/uncommitted-work side effects below apply. Redundant, not
  // unsafe: resolveOwnedRepositoryGrant() is pure validation, no side
  // effects of its own, so calling it twice costs a little work, never a
  // different answer.
  const profile = HEADLESS_PERMISSION_PROFILES[role.id];
  const grant = profile && profile.eligibleForOwnedRepositoryGrant ? resolveOwnedRepositoryGrant(ROOT) : { granted: false };
  let protectedEnvFiles = [];
  if (grant.granted) {
    warnIfUncommittedWork(ROOT);
    // Sprint 19, Req 3: refuses the whole launch rather than proceeding
    // with an unprotected .env — established by running it that Claude
    // Code's own Bash allow/deny patterns cannot express "block writes to
    // this file" at all (see OWNED_REPOSITORY_ALLOWED_TOOLS's own
    // comment), so this OS-level step is the ONLY protection Req 3 has;
    // silently granting the broad profile anyway if it fails would be
    // exactly the unearned confidence this sprint exists to avoid. No
    // .env* files present at all is not a failure (protectEnvFiles()
    // naturally returns an empty `failed` list in that case) — most
    // target projects will have none, and the broad grant proceeds
    // normally.
    const protection = protectEnvFiles(ROOT);
    protectedEnvFiles = protection.protected;
    if (protection.failed.length > 0) {
      fail(
        `Could not verify .env protection for: ${protection.failed.join(', ')}. Refusing the broad ` +
          "owned-repository grant rather than proceeding with these files unprotected — this platform's " +
          'immutable-flag mechanism (chflags on macOS, chattr on Linux) may be unavailable or unsupported ' +
          'on this filesystem. Remove the ownedRepository declaration to fall back to the narrower default ' +
          'profile, or protect these files by hand before retrying.'
      );
    }
  }
  let result;
  try {
    result = await spawnClaude(headlessLaunchArgs(role, prompt, { bare, settings }));
  } finally {
    if (protectedEnvFiles.length > 0) unprotectEnvFiles(protectedEnvFiles);
  }
  // Req 10, documented per its own requirement: once claude has actually
  // been spawned, its exit code is passed through UNMODIFIED (null, from
  // a signal, still maps to 0 — pre-existing behavior from before this
  // sprint, unchanged here). This is deliberate, not an oversight: a
  // completed turn — QA1 auditing and recording a FAIL is exactly this —
  // exits 0 (confirmed by running a real turn to completion), so
  // pass-through already gives "recorded any verdict -> exit 0" for free,
  // without this launcher needing to parse the JSON envelope to know it
  // (Req 2's "we emit, we do not parse" boundary stays intact). The known
  // edge this does NOT cleanly cover: a real is_error:true response from
  // claude itself (confirmed by running one — "Not logged in", exit 1)
  // that gets past the credential precondition above because checkAuth()
  // only blocks on a *confident* unauthenticated result, not an
  // inconclusive one. In that rare case, exit 1 here overlaps with what a
  // genuine crashed session might also return — a real, accepted gap
  // rather than a claimed guarantee, and distinct from the reserved range
  // above, which only ever covers failures this launcher detected BEFORE
  // spawning claude at all.
  process.exitCode = result.code === null ? 0 : result.code;
}

async function main() {
  const argv = process.argv.slice(2);

  function flagValue(flag) {
    const i = argv.indexOf(flag);
    return i === -1 ? null : argv[i + 1];
  }

  const forceRestart = argv.includes('--restart');
  const headless = argv.includes('--headless');
  // Req 3, amended: --agent <role-id> is now a real flag, not just
  // shorthand for the interactive path's leading positional argument —
  // the canonical headless shape (`--headless --agent qa1 --sprint 4`)
  // never puts the role first. The old leading-positional form still
  // works too (falls through to argv[0] when --agent isn't present),
  // which is what keeps the interactive path's own invocation
  // (`<role-id> [--restart]`) unchanged, per Req 6.
  const roleId = flagValue('--agent') || argv[0];
  const sprintId = flagValue('--sprint');
  const promptFilePath = flagValue('--prompt-file');
  const bare = argv.includes('--bare');
  // Only meaningful alongside --bare (apiKeyHelper) — see runHeadless()'s
  // comment above.
  const settings = flagValue('--settings');

  const role = ROLES.find((r) => r.id === roleId);
  if (!role) {
    fail(`Unknown role '${roleId}'. Expected one of: ${ROLES.map((r) => r.id).join(', ')}.`);
  }

  if (!claudeOnPath()) {
    // A non-zero exit here could mean claude isn't on PATH, but on
    // Windows (routed through cmd.exe) it could also mean claude was
    // found and --version itself failed for some other reason — the two
    // aren't reliably distinguishable across platforms, so the message
    // doesn't claim more precisely than it knows.
    fail(
      "'claude --version' didn't succeed in a plain terminal — either " +
        "it's not on PATH, or something else is wrong with the install. " +
        "Confirm 'claude --version' works by hand, then re-run this task."
    );
  }

  const agentFile = agentFilePath(role.id);
  if (!fs.existsSync(agentFile)) {
    fail(
      `Agent file missing: ${path.relative(ROOT, agentFile)}. Reinstall or ` +
        `restore the framework files, then re-run this task.`
    );
  }

  if (headless) {
    if (!promptFilePath && !sprintId) {
      fail(
        '--headless requires either --sprint <id> (composes the opening prompt from this ' +
          "role's own built-in template — the default) or --prompt-file <path> (an explicit " +
          'override, read from a path, never passed as prompt text on a command line).'
      );
    }
    await runHeadless(role, { sprintId, promptFilePath, bare, settings });
    return;
  }

  // Req 6: the interactive path checks the OPERATOR's own auth here, via
  // checkAuth(). Req 4, amended mid-build: headless's default (non-bare)
  // path now checks the exact same thing, the exact same way, inside
  // runHeadless() above — it used to deliberately never touch operator
  // auth at all, back when --bare was unconditional; that reasoning no
  // longer applies now that the default headless path IS the operator's
  // session. Worded differently from the not-on-PATH failure above so the
  // two are never mistaken for each other; only a *confident* "credentials
  // unusable" blocks here, an inconclusive probe proceeds rather than
  // locking out a setup that might work fine; the block can legitimately
  // come from either a genuine logout or a broken config directory, and
  // this message states the observation and the remedy, not a cause it
  // doesn't actually know.
  if (checkAuth() === 'unauthenticated') {
    fail(
      "Claude reports no usable credentials. Open a normal terminal, run " +
        "'claude', sign in, then re-run this task."
    );
  }

  const repoName = path.basename(ROOT);
  const sessionTitle = `fc:${role.id}:${repoName}`;
  const { resume, sessionId: uuid } = resolveSession(role.id, ROOT, { restart: forceRestart });

  if (forceRestart) {
    // Sprint 11, Req 2: stderr, not stdout, unconditionally — this line
    // (on the --restart path) was the one place the interactive path ever
    // wrote to stdout outside the inherited child stream, and the one
    // named offender in this sprint's own Context. It shows up in the
    // same VS Code terminal pane either way (stdout and stderr are
    // interleaved there), so this has no observable effect on the
    // interactive path; what it does is keep this code path safe should
    // a future headless variant ever reach it, rather than relying on
    // headless simply never calling it today.
    console.error(`Restarting ${role.label}: starting a brand-new session (any prior one is left alone).`);
    const result = await launchFresh(role, sessionTitle, uuid);
    process.exitCode = result.code === null ? 0 : result.code;
    return;
  }

  if (!resume) {
    const result = await launchFresh(role, sessionTitle, uuid);
    process.exitCode = result.code === null ? 0 : result.code;
    return;
  }

  const result = await spawnClaude(resumeLaunchArgs(role, uuid, repoName));
  process.exitCode = result.code === null ? 0 : result.code;
}

// Sprint 11, Req 6: only runs main() (which parses real argv and, on
// success, actually spawns claude) when this file is executed directly —
// `node scripts/launcher/run-role.js ...`, exactly as every VS Code task
// and every headless caller already does. Requiring this file as a
// module (as the regression tests below do, to reach the pure argv
// builders) does not trigger any of that. Zero behaviour change for the
// real CLI: require.main === module is true for every existing way this
// file is actually invoked.
if (require.main === module) {
  main();
}

module.exports = {
  freshLaunchArgs,
  resumeLaunchArgs,
  headlessLaunchArgs,
  headlessPermissionArgs,
  LAUNCHER_FAILURE_EXIT_CODE,
  installOrphanGuard,
  readDeclaredTestCommand,
  HEADLESS_PERMISSION_PROFILES,
  isBareInterpreter,
  isGitRepository,
  readOwnedRepositoryDeclaration,
  validateOwnedRepositoryDeclaration,
  resolveOwnedRepositoryGrant,
  envFilesIn,
  protectEnvFiles,
  unprotectEnvFiles,
  OWNED_REPOSITORY_ALLOWED_TOOLS,
  OWNED_REPOSITORY_DISALLOWED_TOOLS,
};
