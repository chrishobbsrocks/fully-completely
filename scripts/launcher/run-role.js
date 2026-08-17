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
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ROOT, ROLES, agentFilePath } = require('./agents');
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

async function launchFresh(role, sessionTitle, uuid) {
  return spawnClaude(['--agent', role.id, '--session-id', uuid, '--name', sessionTitle, initialPrompt(role.label)]);
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

  // Req 6: deliberately worded differently from the not-on-PATH failure
  // above so the two are never mistaken for each other. Req 6b: only a
  // *confident* "credentials unusable" blocks here — an inconclusive
  // probe proceeds with the launch rather than locking out a setup that
  // might work fine. Req 6c: the block can legitimately come from either
  // a genuine logout or a broken config directory (see auth.js), and this
  // message can't tell which — so it states the observation and the
  // remedy, not a cause it doesn't actually know.
  if (checkAuth() === 'unauthenticated') {
    fail(
      "Claude reports no usable credentials. Open a normal terminal, run " +
        "'claude', sign in, then re-run this task."
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
  const { resume, sessionId: uuid } = resolveSession(role.id, ROOT, { restart: forceRestart });

  if (forceRestart) {
    console.log(`Restarting ${role.label}: starting a brand-new session (any prior one is left alone).`);
    const result = await launchFresh(role, sessionTitle, uuid);
    process.exitCode = result.code === null ? 0 : result.code;
    return;
  }

  if (!resume) {
    const result = await launchFresh(role, sessionTitle, uuid);
    process.exitCode = result.code === null ? 0 : result.code;
    return;
  }

  const resumeArgs = ['--agent', role.id, '--resume', uuid];
  if (role.id === 'dev-team-2') {
    resumeArgs.push(devTeam2ResumePrompt(repoName));
  }
  const result = await spawnClaude(resumeArgs);
  process.exitCode = result.code === null ? 0 : result.code;
}

main();
