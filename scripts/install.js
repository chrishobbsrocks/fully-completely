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
const { hasComments, parseJsonc } = require('./launcher/jsonc');

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

function normalizeLineEndings(buf) {
  return buf.toString('utf8').replace(/\r\n/g, '\n');
}

function copyFile(relPath) {
  const src = path.join(SOURCE_ROOT, relPath);
  const dest = path.join(DEST_ROOT, relPath);
  if (fs.existsSync(dest)) {
    // Compare with line endings normalized, not a raw byte compare — a
    // Windows target with core.autocrlf=true has CRLF on disk against
    // this repo's LF source, which would otherwise report every framework
    // file as a conflict on every re-run even though nothing differs.
    const same = normalizeLineEndings(fs.readFileSync(src)) === normalizeLineEndings(fs.readFileSync(dest));
    (same ? skipped : conflicts).push(relPath);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  copied.push(relPath);
}

// Parses a target's existing JSONC file, or reports why it can't be
// safely merged. Deliberately refuses (rather than silently doing a lossy
// round-trip) when the file has comments: this tool only ever writes
// plain JSON.parse -> JSON.stringify, which would delete every comment
// in the file — including ones that say things like "DO NOT REMOVE".
function readExistingJsonc(destPath, relPath, adviceIfMissing) {
  if (!fs.existsSync(destPath)) return { value: null, existed: false };
  const raw = fs.readFileSync(destPath, 'utf8');
  if (hasComments(raw)) {
    conflicts.push(`${relPath} (has comments this tool can't preserve — ${adviceIfMissing} by hand instead)`);
    return { conflict: true };
  }
  try {
    return { value: parseJsonc(raw), existed: true };
  } catch {
    conflicts.push(`${relPath} (couldn't parse as JSON, left untouched — ${adviceIfMissing} by hand instead)`);
    return { conflict: true };
  }
}

function mergeSettings() {
  const relPath = path.join('.vscode', 'settings.json');
  const destPath = path.join(DEST_ROOT, relPath);
  const parsed = readExistingJsonc(destPath, relPath, 'add "fullyCompletely.autoLaunch": false');
  if (parsed.conflict) return;
  const obj = parsed.value || {};
  const existed = parsed.existed;

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

  const parsed = readExistingJsonc(destPath, relPath, 'merge the launcher tasks in');
  if (parsed.conflict) return;
  const existing = parsed.value || { version: '2.0.0', tasks: [] };
  const existed = parsed.existed;
  if (!Array.isArray(existing.tasks)) existing.tasks = [];

  // A label that already exists but isn't byte-identical to what we'd
  // generate is a real collision, not "already installed" — this repo's
  // own labels went from "FC: Launch — QA1" to a bare "QA1" for cleaner
  // terminal names, which means a target project's own unrelated task
  // (a bare "Shell" is hardly an exotic label) can now collide. Silently
  // skipping it would leave FC: Start All's dependsOn pointing at
  // whatever that project's task does instead of ours — including, for
  // the Shell task specifically, opening something other than the plain
  // no-claude shell docs/HUMAN_OVERRIDE.md depends on, with no warning.
  const existingByLabel = new Map(existing.tasks.map((t) => [t.label, t]));
  const collisions = [];
  let added = 0;
  for (const task of ourTasks) {
    const already = existingByLabel.get(task.label);
    if (!already) {
      existing.tasks.push(task);
      added += 1;
      continue;
    }
    if (JSON.stringify(already) !== JSON.stringify(task)) {
      collisions.push(task.label);
    }
  }

  if (collisions.length > 0) {
    conflicts.push(
      `${relPath} (task label(s) already exist here with different content: ${collisions.join(', ')} — ` +
        'rename one side before installing; nothing written)'
    );
    return;
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
