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
// headless — no terminal, no human in the loop:
//   node scripts/launcher/run-role.js <role-id> --headless --prompt-file <path> [--settings <path-or-json>]
// --settings is optional and forwarded verbatim to claude's own --settings
// flag — the real path for an apiKeyHelper-based project (see runHeadless()
// below); omit it when ANTHROPIC_API_KEY is set in the environment instead.
// Requested by an external orchestrator (Fifty Mission Cap) that installs
// this framework and drives docs/sprints/ from outside, through
// sprint_lifecycle.py and state files only, never reading agent files or
// editing sprint files. See runHeadless() and its neighbors below for
// what headless does differently from the interactive path above, and why.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ROOT, ROLES, agentFilePath, readAgentMeta, agentBody } = require('./agents');
const { initialPrompt, devTeam2ResumePrompt } = require('./prompts');
const { resolveSession } = require('./session');
const { checkAuth } = require('./auth');
const { claudeCommand } = require('./claude-cmd');

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
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
// Req 4: --bare is passed unconditionally, on every headless launch, with
// no way to opt out — headless must never inherit the launching
// operator's own OAuth/keychain session, which belongs to whoever is
// running this launcher interactively, not to an automated role
// invocation. --bare's own contract (confirmed against the pinned notes
// at 39a12fd, and against a real credential-less run here) reads strictly
// ANTHROPIC_API_KEY or apiKeyHelper, never OAuth or keychain, which is
// exactly the isolation this requirement asks for.
//
// Discovered by running it, not by reading: `--agent <id>` ALONE fails in
// --bare mode with "not found. Available agents: claude, Explore,
// general-purpose, Plan, statusline-setup" — Claude Code's own built-in
// types, not this project's .claude/agents/*.md personas, because --bare
// skips reading them entirely (consistent with its own documented
// CLAUDE.md-auto-discovery skip). The fix, also confirmed by running it
// (a fake API key then fails at the auth step instead of at agent
// resolution, at zero cost either way): supply the persona explicitly via
// `--agents '{"<id>":{"description":...,"prompt":...,"model":...}}'`
// alongside `--agent <id>` — agents.js's agentBody()/readAgentMeta() below
// build this from the exact same frontmatter/body split the interactive
// path already uses, so the two can never describe the persona
// differently. Whether `model` inside this JSON is actually honored
// (versus silently ignored, falling back to a default) is NOT verified —
// that needs a real successful run, which needs real credentials this
// build did not have; flagged rather than assumed.
//
// QA1 round 1 (Req 4): `settings`, when given, is forwarded to claude
// exactly as `--settings <value>` — a path to a JSON file or an inline
// JSON string, --bare's own documented mechanism for supplying
// apiKeyHelper. Without this, the precondition check below could name
// "--settings" as a remedy that this file never actually wired up, which
// is exactly the dead end QA1 demonstrated: a project relying solely on
// apiKeyHelper had no way to use headless at all, no matter what the
// error message claimed. Positioned before `prompt`, which must stay the
// final, positional argument.
function headlessLaunchArgs(role, prompt, settings) {
  const meta = readAgentMeta(role.id);
  const body = agentBody(role.id);
  const definition = { description: (meta && meta.description) || role.label, prompt: body };
  if (meta && meta.model) definition.model = meta.model;
  const agentsJson = JSON.stringify({ [role.id]: definition });
  const settingsArgs = settings ? ['--settings', settings] : [];
  return ['--agent', role.id, '--agents', agentsJson, '-p', '--output-format', 'json', '--bare', ...settingsArgs, prompt];
}

async function runHeadless(role, promptFilePath, settings) {
  // Req 4: checked here, before claude is even invoked, so the common
  // failure (no credentials supplied at all) is immediate and unambiguous
  // rather than waiting for --bare's own response — which is ALSO legible
  // (a well-formed envelope with is_error:true and a "Not logged in"
  // result, confirmed against the pinned notes and against a real run in
  // an environment with no ANTHROPIC_API_KEY here) but easy for a careless
  // consumer to miss buried inside a JSON blob, exactly the risk the
  // pinned notes warn a naive metering caller into. This check reads the
  // LAUNCHING ENVIRONMENT (an env var and this file's own --settings
  // flag), never the envelope claude itself prints, so it doesn't touch
  // Req 2's "we emit, we do not parse" boundary at all.
  //
  // QA1 round 1: this used to hard-fail whenever ANTHROPIC_API_KEY was
  // unset, full stop, with a message naming "--settings" as a remedy that
  // didn't exist anywhere in this file — an apiKeyHelper-only project
  // could not use headless at all, no matter what it passed. Fixed by
  // actually accepting a `--settings <value>` flag (parsed in main() below,
  // forwarded into headlessLaunchArgs() above) and only hard-failing here
  // when NEITHER credential source was supplied. This does not validate
  // that a given --settings value actually configures apiKeyHelper — doing
  // that would mean re-implementing claude's own settings-file parsing
  // just to double-check it — so a meaningless --settings value (e.g.
  // '{}') still passes this check and falls through to --bare's own
  // legible is_error:true failure instead of this friendlier one. That's
  // an acceptable, deliberate trade: Req 4 asks for a legible failure, not
  // specifically an early one, and the same "don't block on an
  // inconclusive signal" reasoning already applies to checkAuth() on the
  // interactive path below.
  if (!process.env.ANTHROPIC_API_KEY && !settings) {
    fail(
      'Headless mode needs its own credentials — neither ANTHROPIC_API_KEY nor --settings ' +
        '<file-or-json> was supplied. --bare mode (which headless always uses) reads strictly ' +
        'ANTHROPIC_API_KEY or apiKeyHelper, never the OAuth/keychain session an interactive ' +
        'launch would use. Set ANTHROPIC_API_KEY, or pass --settings <path-or-inline-json> ' +
        "pointing at an apiKeyHelper config, and re-run: node scripts/launcher/run-role.js " +
        '<role-id> --headless --prompt-file <path> --settings <path-or-json>.'
    );
  }
  const prompt = readPromptFile(promptFilePath);
  const result = await spawnClaude(headlessLaunchArgs(role, prompt, settings));
  process.exitCode = result.code === null ? 0 : result.code;
}

async function main() {
  const [, , roleId, ...rest] = process.argv;
  const forceRestart = rest.includes('--restart');
  const headless = rest.includes('--headless');
  const promptFileFlagIndex = rest.indexOf('--prompt-file');
  const promptFilePath = promptFileFlagIndex === -1 ? null : rest[promptFileFlagIndex + 1];
  // QA1 round 1: forwarded to claude's own --settings, headless's real
  // (rather than merely claimed) apiKeyHelper path — see runHeadless()'s
  // comment above for why this exists.
  const settingsFlagIndex = rest.indexOf('--settings');
  const settings = settingsFlagIndex === -1 ? null : rest[settingsFlagIndex + 1];

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
    if (!promptFilePath) {
      fail('--headless requires --prompt-file <path>.');
    }
    await runHeadless(role, promptFilePath, settings);
    return;
  }

  // Req 6: only the interactive path checks the OPERATOR's own auth —
  // headless never does (see runHeadless() above); it checks for its own
  // credentials instead, and for a different reason (Req 4 forbids
  // headless from ever falling back to this operator's session, rather
  // than this check existing to protect the operator). Worded differently
  // from the not-on-PATH failure above so the two are never mistaken for
  // each other; only a *confident* "credentials unusable" blocks here, an
  // inconclusive probe proceeds rather than locking out a setup that
  // might work fine; the block can legitimately come from either a
  // genuine logout or a broken config directory, and this message states
  // the observation and the remedy, not a cause it doesn't actually know.
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

module.exports = { freshLaunchArgs, resumeLaunchArgs, headlessLaunchArgs };
