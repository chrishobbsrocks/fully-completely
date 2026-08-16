#!/usr/bin/env node
'use strict';
// Builds .vscode/tasks.json from the six agents' frontmatter (currently
// just `color:` — colors have to be baked into tasks.json at generation
// time because VS Code needs them before a task's terminal ever runs, it
// can't ask our launch script at launch time). Re-run this after changing
// any agent's `color:` field, or after flipping fullyCompletely.autoLaunch
// in .vscode/settings.json.
//
// Each role gets exactly one task, named after the role ("Master
// Controller", "QA1", ...) — that's also the terminal's tab name, since
// VS Code names a task's terminal after its label. It resumes a prior
// session automatically if one is recorded, falling back to fresh
// otherwise (see run-role.js).
//
// There is deliberately no separate "restart" task: VS Code ties a
// dedicated terminal's identity to the task's label, so a second task for
// the same role opens a second terminal alongside the first rather than
// replacing it (confirmed the hard way). To force a role fresh, run
// `node scripts/launcher/run-role.js <role-id> --restart` by hand from
// Shell instead — see the README.
//
// Exports buildTasks(root) so scripts/install.js can reuse the exact same
// task shapes when merging them into a target project's own tasks.json.
const fs = require('fs');
const path = require('path');
const { ROOT, ROLES, readAgentMeta } = require('./agents');
const { parseJsonc } = require('./jsonc');

function readAutoLaunchSetting(root) {
  const settingsPath = path.join(root, '.vscode', 'settings.json');
  try {
    // A real JSONC parse, not a raw regex over the file text — a regex
    // would happily match a commented-out
    // `// "fullyCompletely.autoLaunch": true` line as if it were live.
    const settings = parseJsonc(fs.readFileSync(settingsPath, 'utf8'));
    return settings['fullyCompletely.autoLaunch'] === true;
  } catch {
    return false;
  }
}

function roleTask(role, meta) {
  const task = {
    label: role.label,
    type: 'shell',
    command: 'node',
    args: [path.posix.join('scripts', 'launcher', 'run-role.js'), role.id],
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
    label: 'Shell',
    type: 'shell',
    // Default (macOS/Linux): drop into the user's own login shell,
    // whatever it is, rather than assuming zsh. $SHELL is expanded by the
    // shell this command itself runs in (not by VS Code), so the POSIX
    // ${SHELL:-/bin/sh} fallback works as written even if it's unset.
    command: 'exec ${SHELL:-/bin/sh} -l',
    // No POSIX $SHELL equivalent on Windows; PowerShell ships with every
    // supported Windows version, so it's a safe, dependency-free default.
    windows: {
      command: 'powershell',
    },
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

  const roleTasks = roleMetas.map(({ role, meta }) => roleTask(role, meta));
  const shell = shellTask();

  const startAll = {
    label: 'FC: Start All',
    dependsOn: [...roleTasks.map((t) => t.label), shell.label],
    dependsOrder: 'parallel',
    problemMatcher: [],
  };
  if (autoLaunch) {
    startAll.runOptions = { runOn: 'folderOpen' };
  }

  return {
    autoLaunch,
    tasks: [...roleTasks, shell, startAll],
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
