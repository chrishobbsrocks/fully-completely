#!/usr/bin/env node
'use strict';
// Invoked by .vscode/tasks.json, one process per role terminal:
//   node scripts/launcher/run-role.js <role-id> [--restart]
//
// Default (smart): if this launcher has a local record of a prior session
// for this role, try to resume it (`claude --agent <id> --resume <title>`);
// otherwise, or if the resume attempt exits almost immediately (most
// likely: the recorded session no longer exists), launch fresh
// (`claude --agent <id> --name <title> "<initial prompt>"`). This is the
// task actually named after the role ("Master Controller", "QA1", ...),
// since it's the one people run day to day.
//
// --restart: skip resume entirely and always start a brand-new named
// session, even if one is already recorded. Previous history isn't
// deleted, just not reconnected to. Not wired into any VS Code task —
// VS Code ties a dedicated terminal's identity to the task's label, so a
// second task for the same role would open a second terminal alongside
// the first rather than replacing it. Run this by hand instead (e.g. from
// Shell) when you actually want to abandon a session.
//
// Model is never passed here — `--agent <id>` alone puts the agent file's
// own frontmatter `model:` in charge (confirmed to win even over an
// explicit --model), so frontmatter stays the single place a model is set.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ROOT, ROLES, agentFilePath } = require('./agents');
const { initialPrompt, devTeam2ResumePrompt } = require('./prompts');
const { wasLaunched, markLaunched } = require('./state');

const FAST_FAILURE_MS = 5000;

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

// On Windows, a global npm install of claude is typically a .cmd shim,
// which can't be exec'd directly the way a real macOS/Linux binary can.
// The tempting fix is spawn(..., {shell: true}), but that's actively
// unsafe: Node's shell:true mode does NOT escape array args, it just
// concatenates them (see the DEP0190 deprecation warning) — confirmed by
// hand, a prompt string containing parentheses breaks the shell outright,
// silently mangling every argument after it into separate shell tokens.
// Node's own docs recommend the alternative used here instead: spawn
// cmd.exe directly (shell: false, the safe default) with /c plus the
// target and its args as a normal array — Node's already-safe non-shell
// Windows argv quoting does the escaping, so there's nothing to hand-roll.
function claudeCommand(args) {
  if (process.platform === 'win32') {
    return ['cmd.exe', ['/c', 'claude', ...args]];
  }
  return ['claude', args];
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

function spawnClaude(args, { onSpawned } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const [cmd, fullArgs] = claudeCommand(args);
    const child = spawn(cmd, fullArgs, { stdio: 'inherit', cwd: ROOT });
    // Fires once the OS confirms the process actually started — the
    // earliest reliable "this happened" signal, well before markLaunched()
    // would ever race a user closing the terminal.
    child.on('spawn', () => {
      if (onSpawned) onSpawned();
    });
    child.on('error', (err) => {
      fail(`Failed to start claude: ${err.message}`);
    });
    child.on('exit', (code) => {
      resolve({ code, elapsedMs: Date.now() - startedAt });
    });
  });
}

async function launchFresh(role, sessionTitle) {
  // Record the launch at spawn time, not after the process exits.
  // Recording on exit meant closing the terminal tab (the normal way
  // people end these sessions, and the normal way VS Code kills the
  // whole process tree on window close) killed this script before it
  // ever reached the exit handler — the record never got written, and
  // "resume" silently degraded to always-fresh with no sign anything
  // was wrong.
  return spawnClaude(['--agent', role.id, '--name', sessionTitle, initialPrompt(role.label)], {
    onSpawned: () => markLaunched(role.id),
  });
}

async function main() {
  const [, , roleId, ...rest] = process.argv;
  const forceRestart = rest.includes('--restart');

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

  const repoName = path.basename(ROOT);
  const sessionTitle = `fc:${role.id}:${repoName}`;

  if (forceRestart) {
    console.log(`Restarting ${role.label}: starting a brand-new session (any prior one is left alone).`);
    const result = await launchFresh(role, sessionTitle);
    process.exitCode = result.code === null ? 0 : result.code;
    return;
  }

  if (!wasLaunched(role.id)) {
    const result = await launchFresh(role, sessionTitle);
    process.exitCode = result.code === null ? 0 : result.code;
    return;
  }

  const resumeArgs = ['--agent', role.id, '--resume', sessionTitle];
  if (role.id === 'dev-team-2') {
    resumeArgs.push(devTeam2ResumePrompt(repoName));
  }
  const result = await spawnClaude(resumeArgs);
  if (result.code && result.elapsedMs < FAST_FAILURE_MS) {
    console.log(
      `Resume of ${role.label} exited almost immediately (code ${result.code}), ` +
        `the recorded session probably no longer exists. Starting fresh instead.`
    );
    const fresh = await launchFresh(role, sessionTitle);
    process.exitCode = fresh.code === null ? 0 : fresh.code;
    return;
  }
  process.exitCode = result.code === null ? 0 : result.code;
}

main();
