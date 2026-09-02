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

function spawnClaude(args) {
  return new Promise((resolve) => {
    const [cmd, fullArgs] = claudeCommand(args);
    const child = spawn(cmd, fullArgs, { stdio: 'inherit', cwd: ROOT });
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
function headlessLaunchArgs(role, prompt, { bare, settings } = {}) {
  const meta = readAgentMeta(role.id);
  const body = agentBody(role.id);
  const definition = { description: (meta && meta.description) || role.label, prompt: body };
  if (meta && meta.model) definition.model = meta.model;
  const agentsJson = JSON.stringify({ [role.id]: definition });
  const base = ['--agent', role.id, '--agents', agentsJson, '-p', '--output-format', 'json'];
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
  const result = await spawnClaude(headlessLaunchArgs(role, prompt, { bare, settings }));
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

module.exports = { freshLaunchArgs, resumeLaunchArgs, headlessLaunchArgs, LAUNCHER_FAILURE_EXIT_CODE };
