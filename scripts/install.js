#!/usr/bin/env node
'use strict';
// Copies the Fully Completely framework + VS Code launcher into an
// existing project, and upgrades it cleanly on every re-run after that.
// Run it from inside the target project:
//
//   node /path/to/fully-completely/scripts/install.js
//
// This is also the shape `npx fully-completely` runs: source = the
// package's own files, destination = wherever the user invoked it from.
//
// Sprint 2's taxonomy (Req 1) replaces the single copy/skip/conflict
// policy sprint 1 shipped with three explicit categories, each with its
// own rule:
//
//   FRAMEWORK_OWNED — shipped and maintained upstream; the user is never
//     expected to edit these. An upgrade OVERWRITES a changed file, always
//     backing up what was there first (Req 2), and REMOVES any file under
//     a framework-owned path that no longer exists upstream, also backed
//     up first (Req 4) — state.js, deleted in sprint 1, is the file that
//     motivated this: a stale install kept carrying it forever with no
//     way to clean it up.
//   USER_OWNED — designed to be customised (agent personas, this repo's
//     own CLAUDE.md inviting you to extend its "Project standards"
//     section). An upgrade NEVER overwrites these; a differing file is
//     reported as a conflict, same as before, just louder about whose
//     file it is (Req 3).
//   MERGED — .vscode/settings.json, .vscode/tasks.json, .gitignore. Real
//     merge logic, unchanged by this sprint except for one narrow
//     addition (removing a specific dead .gitignore line, Req 4).
//
// A small version marker (Req 5) records which release is installed, so a
// re-run can tell "first install" from "upgrade", name backups after the
// version being replaced, and report `installed X -> Y`. It lives under
// .claude/ (not .claude/agents or .claude/commands, so it never collides
// with either taxonomy) and is never sprint state, so it doesn't live
// under docs/sprints/.
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

// Req 1: the taxonomy, as explicit data. Every path this installer
// touches is listed in exactly one of FRAMEWORK_OWNED, USER_OWNED, or the
// three MERGED_PATHS handled by mergeSettings/mergeTasks/mergeGitignore
// below — nothing is classified by inference at call time.
//
// Framework-owned covers every script and template this repo ships and
// maintains, including install.js itself (an upgrade replaces the
// installer with the newer installer, so the *next* upgrade benefits too)
// and docs/HUMAN_OVERRIDE.md (an operational doc, not a customisation
// surface the way CLAUDE.md's "Project standards" section is).
const FRAMEWORK_OWNED = [
  '.claude/commands',
  'scripts/sprint_lifecycle.py',
  'scripts/smoke_test.sh',
  'scripts/dev2_worktree.sh',
  'scripts/worktree_test.sh',
  'scripts/launcher',
  'scripts/install.js',
  'templates/sprint-template.md',
  'docs/HUMAN_OVERRIDE.md',
];

// User-owned: designed to be customised, or — in docs/sprints's case —
// simply not ours to touch once installed. docs/sprints/ in a target
// project is that *project's own* sprint data (its registry, its sprint
// files, its state), never this repo's own. That distinction has to be
// enforced in code, not just claimed in a comment: QA1 round 1 caught
// that an earlier version of this file asserted "only ever supplies the
// initial empty-folder skeleton" while the actual code walked
// docs/sprints/ like any other directory, which on a real first install
// copied THIS repo's real registry.json, state/*.json (full QA1/LiveQA
// audit text), and sprint files straight into the target — corrupting its
// sprint numbering from the very first command. Fixed below:
// SPRINT_SKELETON_FILES is an explicit allowlist of only the phase
// folders' .gitkeep placeholders, and docs/sprints is special-cased in
// the USER_OWNED loop to install only from that list, never from a
// directory walk. Once a target has its own real sprint files, those are
// user-owned in the same never-overwrite sense as everything else in this
// category — they're just never *sourced* from this repo either way.
const USER_OWNED = ['.claude/agents', 'CLAUDE.md', 'docs/sprints'];

const SPRINT_SKELETON_FILES = [
  'docs/sprints/0-backlog/.gitkeep',
  'docs/sprints/1-todo/.gitkeep',
  'docs/sprints/2-in-progress/.gitkeep',
  'docs/sprints/3-done/.gitkeep',
  'docs/sprints/4-blocked/.gitkeep',
  'docs/sprints/5-abandoned/.gitkeep',
  'docs/sprints/state/.gitkeep',
];

// The marker every backup file's name contains (Req 2/4). Framework-owned
// backups are deliberately written as *siblings* of the original — same
// directory — per Req 2's own wording, which means the same directory
// walk that finds real framework files also finds our own backups. QA1
// caught that without this exclusion, a backup created on run 1 gets
// treated as "no longer part of the framework" on run 2, gets backed up
// *again* (nesting the suffix), and so on — a compounding rename every
// run, eventually exceeding filesystem filename limits. Every path
// collectPaths() returns is filtered against this marker so a backup is
// never mistaken for a real framework file at any point after the run
// that created it.
const BACKUP_MARKER = '.fc-bak-';

function isBackupPath(relPath) {
  return path.basename(relPath).includes(BACKUP_MARKER);
}

const VERSION_MARKER_PATH = path.join(DEST_ROOT, '.claude', 'fully-completely-version');
const CURRENT_VERSION = require(path.join(SOURCE_ROOT, 'package.json')).version;

const copied = [];
const skipped = [];
const conflicts = [];
const replaced = [];
const removed = [];
const notes = [];

function normalizeLineEndings(buf) {
  return buf.toString('utf8').replace(/\r\n/g, '\n');
}

function sameContent(src, dest) {
  return normalizeLineEndings(fs.readFileSync(src)) === normalizeLineEndings(fs.readFileSync(dest));
}

// Collects every plain file under relPath (a single file returns itself)
// as an array of paths relative to `root`. Used on both SOURCE_ROOT (what
// *should* exist) and DEST_ROOT (what currently *does* exist) for the
// same framework-owned entry, so overwrite and removal can each work off
// the right side of that comparison.
//
// Two safety filters, both from QA1 round 2:
//   - lstatSync, not statSync, and a symlink is never descended into. A
//     symlink under a framework-owned directory could point anywhere —
//     following it would let removeStaleFrameworkFile() walk into, and
//     potentially delete, files completely outside the framework-owned
//     set, which Req 4 forbids without qualification.
//   - a path matching BACKUP_MARKER is excluded entirely, so our own
//     backups (siblings of the files they back up, per Req 2) are never
//     mistaken for framework content on a later run.
function collectPaths(root, relPath) {
  const abs = path.join(root, relPath);
  if (!fs.existsSync(abs)) return [];
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) return [];
  if (st.isDirectory()) {
    const results = [];
    for (const entry of fs.readdirSync(abs)) {
      results.push(...collectPaths(root, path.join(relPath, entry)));
    }
    return results;
  }
  return isBackupPath(relPath) ? [] : [relPath];
}

// Req 5: a missing marker means "unknown previous version" and must
// degrade to the upgrade path, not crash — readInstalledVersion() simply
// returns null, which every caller below already treats as "unknown".
function readInstalledVersion() {
  try {
    const raw = fs.readFileSync(VERSION_MARKER_PATH, 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

function writeInstalledVersion(version) {
  fs.mkdirSync(path.dirname(VERSION_MARKER_PATH), { recursive: true });
  fs.writeFileSync(VERSION_MARKER_PATH, `${version}\n`);
}

const installedVersion = readInstalledVersion();

// Backups are named after the version being replaced, so several upgrades
// over time don't collide and it's obvious from the filename what release
// a backup came from. If that exact name is somehow already taken (e.g. a
// previous run backed up this same file already) and holds *different*
// content, a numeric suffix is appended rather than silently clobbering
// someone's earlier backup; if it holds the *same* content, it's reused
// rather than piling up identical duplicates.
function backupPathFor(destPath) {
  const versionTag = installedVersion || 'unknown';
  const base = `${destPath}${BACKUP_MARKER}${versionTag}`;
  if (!fs.existsSync(base)) return base;
  if (sameContent(destPath, base)) return base;
  let n = 2;
  let candidate = `${base}-${n}`;
  while (fs.existsSync(candidate) && !sameContent(destPath, candidate)) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  return candidate;
}

// Req 2: framework-owned file, single-file granularity. Absent at the
// destination -> plain copy (this is what makes a first install behave
// identically to today's, since every branch below it is upgrade-only).
// Present and identical -> skip. Present and different -> back up, then
// overwrite.
function overwriteFrameworkFile(relPath) {
  const src = path.join(SOURCE_ROOT, relPath);
  const dest = path.join(DEST_ROOT, relPath);
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copied.push(relPath);
    return;
  }
  if (sameContent(src, dest)) {
    skipped.push(relPath);
    return;
  }
  const backup = backupPathFor(dest);
  fs.copyFileSync(dest, backup);
  fs.copyFileSync(src, dest);
  replaced.push(`${relPath} (upgraded, previous version backed up to ${path.relative(DEST_ROOT, backup)})`);
}

// Req 4: a file that exists under a framework-owned path at the
// destination but no longer exists upstream at all — state.js is the
// motivating example. Backed up (same naming as an overwrite) before
// removal, and reported.
function removeStaleFrameworkFile(relPath) {
  const dest = path.join(DEST_ROOT, relPath);
  const backup = backupPathFor(dest);
  fs.copyFileSync(dest, backup);
  fs.unlinkSync(dest);
  removed.push(
    `${relPath} (no longer part of the framework, backed up to ${path.relative(DEST_ROOT, backup)}, then removed)`
  );
}

// Drives both halves of Req 2/4 for one FRAMEWORK_OWNED entry (a single
// file or a whole directory): overwrite everything that should exist,
// then remove anything at the destination that shouldn't. Deliberately
// two full directory walks rather than one combined pass — overwrite must
// finish (so "what does upstream currently look like" is unambiguous)
// before removal decides what's stale, and the two operations have
// different failure modes worth keeping visually separate in the code.
function syncFrameworkPath(relPath) {
  const sourceFiles = collectPaths(SOURCE_ROOT, relPath);
  const destFilesBefore = collectPaths(DEST_ROOT, relPath);
  const sourceSet = new Set(sourceFiles);

  for (const file of sourceFiles) overwriteFrameworkFile(file);

  for (const file of destFilesBefore) {
    if (!sourceSet.has(file)) removeStaleFrameworkFile(file);
  }
}

// Req 3: user-owned file. Same shape as sprint 1's original copyFile() —
// never overwrite — but a differing file is now reported with an
// explicit "this is yours" line instead of the old generic conflict
// message, since silence here is exactly how a customised persona would
// have been mistaken for a stale framework file before this sprint drew
// the line between the two.
function copyUserOwnedFile(relPath) {
  const src = path.join(SOURCE_ROOT, relPath);
  const dest = path.join(DEST_ROOT, relPath);
  if (fs.existsSync(dest)) {
    if (sameContent(src, dest)) {
      skipped.push(relPath);
    } else {
      conflicts.push(
        `${relPath} (yours — this framework never overwrites a file in this category. ` +
          'The upstream version has changed; review the difference and merge anything you want by hand.)'
      );
    }
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

// Req 4's one narrow addition to otherwise-unchanged merge logic: drop a
// specific, now-dead line this framework used to add but no longer needs
// (.claude-launcher/, dead since sprint 1 deleted state.js). Only removed
// when it appears as its own exact, standalone line — unambiguous to
// strip regardless of surrounding content. If the reference survives in
// any other form (folded into a broader pattern, edited by hand into
// something else), this leaves it alone and reports it rather than
// attempting a riskier rewrite.
function removeDeadGitignoreLines() {
  const relPath = '.gitignore';
  const destPath = path.join(DEST_ROOT, relPath);
  const deadLines = ['.claude-launcher/'];
  if (!fs.existsSync(destPath)) return;
  const raw = fs.readFileSync(destPath, 'utf8');
  // Preserve whatever line ending the file already uses — QA1 caught that
  // split(/\r?\n/).join('\n') silently converts CRLF to LF on rewrite,
  // harmless on macOS but exactly the kind of thing Part B's Windows gate
  // exists to catch.
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const kept = [];
  const removedHere = [];
  for (const line of lines) {
    if (deadLines.includes(line.trim())) {
      removedHere.push(line.trim());
    } else {
      kept.push(line);
    }
  }
  if (removedHere.length > 0) {
    fs.writeFileSync(destPath, kept.join(eol));
    removed.push(`${relPath} (removed now-dead line(s): ${removedHere.join(', ')})`);
    return;
  }
  const stillPresent = deadLines.some((dead) => raw.includes(dead));
  if (stillPresent) {
    notes.push(
      `${relPath} (found a reference to ${deadLines.join(', ')} that isn't a plain standalone line — ` +
        'left untouched; remove it by hand if you no longer need it)'
    );
  }
}

function mergeGitignore() {
  removeDeadGitignoreLines();

  const relPath = '.gitignore';
  const destPath = path.join(DEST_ROOT, relPath);
  const block = ['docs/sprints/.locks/'];
  let existingLines = [];
  let existed = fs.existsSync(destPath);
  if (existed) {
    existingLines = fs.readFileSync(destPath, 'utf8').split(/\r?\n/);
  }
  const missing = block.filter((line) => !existingLines.includes(line));
  if (missing.length === 0) {
    if (existed) skipped.push(`${relPath} (already has the lines this framework needs)`);
    return;
  }
  const addition = ['', '# Fully Completely (added by scripts/install.js)', ...missing, ''].join('\n');
  fs.appendFileSync(destPath, existed ? addition : addition.trimStart());
  copied.push(existed ? `${relPath} (appended ${missing.length} line(s))` : relPath);
}

for (const p of FRAMEWORK_OWNED) {
  if (!fs.existsSync(path.join(SOURCE_ROOT, p))) continue;
  syncFrameworkPath(p);
}

for (const p of USER_OWNED) {
  if (p === 'docs/sprints') {
    // Special-cased, not walked: see SPRINT_SKELETON_FILES above. Only
    // the empty phase-folder skeleton is ever sourced from this repo,
    // never its real sprint content.
    for (const relPath of SPRINT_SKELETON_FILES) {
      if (fs.existsSync(path.join(SOURCE_ROOT, relPath))) copyUserOwnedFile(relPath);
    }
    continue;
  }
  const abs = path.join(SOURCE_ROOT, p);
  if (!fs.existsSync(abs)) continue;
  if (fs.statSync(abs).isDirectory()) {
    for (const relPath of collectPaths(SOURCE_ROOT, p)) copyUserOwnedFile(relPath);
  } else {
    copyUserOwnedFile(p);
  }
}

mergeSettings();
mergeTasks();
mergeGitignore();

writeInstalledVersion(CURRENT_VERSION);

function section(title, items) {
  if (items.length === 0) return;
  console.log(`\n${title} (${items.length}):`);
  for (const item of items) console.log(`  ${item}`);
}

console.log(`Fully Completely: installed into ${DEST_ROOT}`);
if (installedVersion && installedVersion !== CURRENT_VERSION) {
  console.log(`Upgraded ${installedVersion} -> ${CURRENT_VERSION}`);
} else if (installedVersion) {
  console.log(`Already at ${CURRENT_VERSION} (re-run, nothing to upgrade)`);
} else {
  console.log(`Installed ${CURRENT_VERSION} (first install)`);
}
section('Replaced (framework files upgraded, previous versions backed up)', replaced);
section('Removed (no longer part of the framework, backed up first)', removed);
section('Copied', copied);
section('Already present, unchanged', skipped);
section('Notes', notes);
section('Conflicts — left untouched, review by hand', conflicts);
console.log(
  '\nBefore first running the launcher: log in to Claude once, in a normal ' +
    "terminal — run 'claude', complete login, then exit. The launcher's " +
    'preflight check will refuse to start any role session until this is done.'
);

if (conflicts.length > 0) {
  console.log(
    `\n${conflicts.length} file(s) already exist here with different content and were not overwritten. ` +
      'Reconcile them by hand, then re-run this script if useful.'
  );
  process.exitCode = 1;
}
