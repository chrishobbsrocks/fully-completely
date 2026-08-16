#!/usr/bin/env node
'use strict';
// Copies the Fully Completely framework + VS Code launcher into an
// existing project, non-destructively. Run it from inside the target
// project:
//
//   node /path/to/fully-completely/scripts/install.js
//
// A plain file is only ever copied if the destination doesn't already have
// it, or already has byte-identical content. Anything else is reported as
// a conflict and left untouched — this never overwrites a customized
// CLAUDE.md, an unrelated tasks.json, etc. .vscode/tasks.json,
// .vscode/settings.json, and .gitignore get a real merge instead of a
// copy/skip decision, since a real project is likely to already have its
// own versions of all three.
//
// This is also the shape a future `npx fully-completely` would run: source
// = the package's own files, destination = wherever the user invoked it
// from.
const fs = require('fs');
const path = require('path');

const SOURCE_ROOT = path.resolve(__dirname, '..');
const DEST_ROOT = process.cwd();

if (path.resolve(DEST_ROOT) === path.resolve(SOURCE_ROOT)) {
  console.error(
    'ERROR: run this from the project you want to install into, not from ' +
      'the fully-completely template repo itself.'
  );
  process.exit(1);
}

// Framework files/directories that ship as-is.
const COPY_PATHS = [
  '.claude/agents',
  '.claude/commands',
  'scripts/sprint_lifecycle.py',
  'scripts/smoke_test.sh',
  'scripts/dev2_worktree.sh',
  'scripts/worktree_test.sh',
  'scripts/launcher',
  'scripts/install.js',
  'templates/sprint-template.md',
  'docs/HUMAN_OVERRIDE.md',
  'docs/sprints',
  'CLAUDE.md',
];

const copied = [];
const skipped = [];
const conflicts = [];

function walkFiles(relPath, visit) {
  const abs = path.join(SOURCE_ROOT, relPath);
  if (fs.statSync(abs).isDirectory()) {
    for (const entry of fs.readdirSync(abs)) {
      walkFiles(path.join(relPath, entry), visit);
    }
  } else {
    visit(relPath);
  }
}

function copyFile(relPath) {
  const src = path.join(SOURCE_ROOT, relPath);
  const dest = path.join(DEST_ROOT, relPath);
  if (fs.existsSync(dest)) {
    const same = fs.readFileSync(src).equals(fs.readFileSync(dest));
    (same ? skipped : conflicts).push(relPath);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  copied.push(relPath);
}

function stripJsonComments(text) {
  // Minimal JSONC stripper: string- and escape-aware, so a "//" inside a
  // real string value (a URL, a path) is never mistaken for a comment.
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        out += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next;
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1'); // trailing commas, VS Code allows them
}

function readJsonc(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(stripJsonComments(raw));
}

function mergeSettings() {
  const relPath = path.join('.vscode', 'settings.json');
  const destPath = path.join(DEST_ROOT, relPath);
  let obj = {};
  let existed = fs.existsSync(destPath);
  if (existed) {
    try {
      obj = readJsonc(destPath);
    } catch {
      conflicts.push(`${relPath} (couldn't parse as JSON, left untouched — add "fullyCompletely.autoLaunch": false by hand)`);
      return;
    }
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'fullyCompletely.autoLaunch')) {
    skipped.push(`${relPath} (fullyCompletely.autoLaunch already set)`);
    return;
  }
  obj['fullyCompletely.autoLaunch'] = false;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, JSON.stringify(obj, null, 2) + '\n');
  copied.push(existed ? `${relPath} (added fullyCompletely.autoLaunch key to your existing file)` : relPath);
}

function mergeTasks() {
  const relPath = path.join('.vscode', 'tasks.json');
  const destPath = path.join(DEST_ROOT, relPath);
  const { buildTasks } = require(path.join(SOURCE_ROOT, 'scripts', 'launcher', 'generate-tasks.js'));
  const { tasks: ourTasks } = buildTasks(DEST_ROOT);

  let existing = { version: '2.0.0', tasks: [] };
  let existed = fs.existsSync(destPath);
  if (existed) {
    try {
      existing = readJsonc(destPath);
      if (!Array.isArray(existing.tasks)) existing.tasks = [];
    } catch {
      conflicts.push(`${relPath} (couldn't parse as JSON, left untouched — merge the launcher tasks in by hand)`);
      return;
    }
  }

  const existingLabels = new Set(existing.tasks.map((t) => t.label));
  let added = 0;
  for (const task of ourTasks) {
    if (existingLabels.has(task.label)) continue;
    existing.tasks.push(task);
    added += 1;
  }

  if (added === 0 && existed) {
    skipped.push(`${relPath} (all launcher tasks already present)`);
    return;
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, JSON.stringify(existing, null, 2) + '\n');
  copied.push(
    existed
      ? `${relPath} (added ${added} launcher task(s) to your existing file, left the rest untouched)`
      : `${relPath} (${added} tasks)`
  );
}

function mergeGitignore() {
  const relPath = '.gitignore';
  const destPath = path.join(DEST_ROOT, relPath);
  const block = ['.claude-launcher/', 'docs/sprints/.locks/'];
  let existingLines = [];
  let existed = fs.existsSync(destPath);
  if (existed) {
    existingLines = fs.readFileSync(destPath, 'utf8').split(/\r?\n/);
  }
  const missing = block.filter((line) => !existingLines.includes(line));
  if (missing.length === 0) {
    skipped.push(`${relPath} (already has the lines this framework needs)`);
    return;
  }
  const addition = [
    '',
    '# Fully Completely (added by scripts/install.js)',
    ...missing,
    '',
  ].join('\n');
  fs.appendFileSync(destPath, existed ? addition : addition.trimStart());
  copied.push(existed ? `${relPath} (appended ${missing.length} line(s))` : relPath);
}

for (const p of COPY_PATHS) {
  const abs = path.join(SOURCE_ROOT, p);
  if (!fs.existsSync(abs)) continue;
  if (fs.statSync(abs).isDirectory()) {
    walkFiles(p, copyFile);
  } else {
    copyFile(p);
  }
}

mergeSettings();
mergeTasks();
mergeGitignore();

function section(title, items) {
  if (items.length === 0) return;
  console.log(`\n${title} (${items.length}):`);
  for (const item of items) console.log(`  ${item}`);
}

console.log(`Fully Completely: installed into ${DEST_ROOT}`);
section('Copied', copied);
section('Already present, unchanged', skipped);
section('Conflicts — left untouched, review by hand', conflicts);

if (conflicts.length > 0) {
  console.log(
    `\n${conflicts.length} file(s) already exist here with different content and were not overwritten. ` +
      'Reconcile them by hand, then re-run this script if useful.'
  );
  process.exitCode = 1;
}
