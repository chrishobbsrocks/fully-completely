#!/usr/bin/env node
'use strict';
// Invoked by .vscode/tasks.json, one process per role terminal:
//   node scripts/launcher/run-role.js <role-id> [--resume]
//
// Fresh launch:  claude --agent <id> --name <title> "<initial prompt>"
// Resume:        claude --agent <id> --resume <title> ["<extra prompt>"]
//   falling back to a fresh launch if this launcher never started a named
//   session for this role before, or if the resume attempt exits almost
//   immediately with a non-zero code (most likely: the recorded session no
//   longer exists on this machine).
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

function claudeOnPath() {
  const probe = spawnSync('claude', ['--version'], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  return !(probe.error && probe.error.code === 'ENOENT');
}

function spawnClaude(args) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn('claude', args, { stdio: 'inherit', cwd: ROOT });
    child.on('error', (err) => {
      fail(`Failed to start claude: ${err.message}`);
    });
    child.on('exit', (code) => {
      resolve({ code, elapsedMs: Date.now() - startedAt });
    });
  });
}

async function main() {
  const [, , roleId, ...rest] = process.argv;
  const isResume = rest.includes('--resume');

  const role = ROLES.find((r) => r.id === roleId);
  if (!role) {
    fail(`Unknown role '${roleId}'. Expected one of: ${ROLES.map((r) => r.id).join(', ')}.`);
  }

  if (!claudeOnPath()) {
    fail(
      "'claude' was not found on PATH. Install Claude Code and confirm " +
        "'claude' works in a plain terminal, then re-run this task."
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

  if (isResume && wasLaunched(role.id)) {
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
      const fresh = await spawnClaude(['--agent', role.id, '--name', sessionTitle, initialPrompt(role.label)]);
      markLaunched(role.id);
      process.exitCode = fresh.code === null ? 1 : fresh.code;
      return;
    }
    process.exitCode = result.code === null ? 0 : result.code;
    return;
  }

  if (isResume) {
    console.log(`No prior ${role.label} session recorded for this project, starting fresh instead.`);
  }
  const result = await spawnClaude(['--agent', role.id, '--name', sessionTitle, initialPrompt(role.label)]);
  markLaunched(role.id);
  process.exitCode = result.code === null ? 0 : result.code;
}

main();
