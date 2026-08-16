#!/usr/bin/env node
'use strict';
// Builds .vscode/tasks.json from the six agents' frontmatter (currently
// just `color:` — colors have to be baked into tasks.json at generation
// time because VS Code needs them before a task's terminal ever runs, it
// can't ask our launch script at launch time). Re-run this after changing
// any agent's `color:` field, or after flipping fullyCompletely.autoLaunch
// in .vscode/settings.json.
//
// Exports buildTasks(root) so scripts/install.js can reuse the exact same
// task shapes when merging them into a target project's own tasks.json.
const fs = require('fs');
const path = require('path');
const { ROOT, ROLES, readAgentMeta } = require('./agents');

function readAutoLaunchSetting(root) {
  const settingsPath = path.join(root, '.vscode', 'settings.json');
  try {
    const text = fs.readFileSync(settingsPath, 'utf8');
    const match = text.match(/"fullyCompletely\.autoLaunch"\s*:\s*(true|false)/);
    return match ? match[1] === 'true' : false;
  } catch {
    return false;
  }
}

function roleTask(role, meta, mode) {
  const isResume = mode === 'resume';
  const task = {
    label: `FC: ${isResume ? 'Resume' : 'Launch'} — ${role.label}`,
    type: 'shell',
    command: 'node',
    args: [
      path.posix.join('scripts', 'launcher', 'run-role.js'),
      role.id,
      ...(isResume ? ['--resume'] : []),
    ],
    options: { cwd: '${workspaceFolder}' },
    presentation: {
      panel: 'dedicated',
      reveal: 'always',
      focus: false,
      clear: false,
    },
    problemMatcher: [],
    icon: meta && meta.themeColor ? { id: role.icon, color: meta.themeColor } : { id: role.icon },
  };
  return task;
}

function shellTask() {
  return {
    label: 'FC: Launch — Shell',
    type: 'shell',
    command: 'exec zsh -l',
    options: { cwd: '${workspaceFolder}' },
    presentation: {
      panel: 'dedicated',
      reveal: 'always',
      focus: false,
      clear: false,
    },
    icon: { id: 'terminal' },
    problemMatcher: [],
  };
}

function buildTasks(root) {
  const autoLaunch = readAutoLaunchSetting(root);
  const roleMetas = ROLES.map((role) => ({ role, meta: readAgentMeta(role.id) }));

  const launchTasks = roleMetas.map(({ role, meta }) => roleTask(role, meta, 'launch'));
  const resumeTasks = roleMetas.map(({ role, meta }) => roleTask(role, meta, 'resume'));
  const shell = shellTask();

  const launchAll = {
    label: 'FC: Launch All',
    dependsOn: [...launchTasks.map((t) => t.label), shell.label],
    dependsOrder: 'parallel',
    problemMatcher: [],
  };
  if (autoLaunch) {
    launchAll.runOptions = { runOn: 'folderOpen' };
  }

  const resumeAll = {
    label: 'FC: Resume All',
    dependsOn: [...resumeTasks.map((t) => t.label), shell.label],
    dependsOrder: 'parallel',
    problemMatcher: [],
  };

  return {
    autoLaunch,
    tasks: [...launchTasks, ...resumeTasks, shell, launchAll, resumeAll],
  };
}

module.exports = { buildTasks };

if (require.main === module) {
  const { tasks, autoLaunch } = buildTasks(ROOT);
  const tasksPath = path.join(ROOT, '.vscode', 'tasks.json');
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(tasksPath, JSON.stringify({ version: '2.0.0', tasks }, null, 2) + '\n');
  console.log(
    `Wrote ${path.relative(ROOT, tasksPath)} (${tasks.length} tasks, auto-launch ${autoLaunch ? 'ON' : 'off'}).`
  );
}
