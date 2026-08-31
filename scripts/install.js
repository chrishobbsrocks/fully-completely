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
//     section). A differing file is reported as a conflict, same as
//     before, just louder about whose file it is (Req 3).
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
//
// Sprint 6 changes what "USER_OWNED ... never overwrites" means, for
// `.claude/agents/` and `CLAUDE.md` only (not `docs/sprints`, Req 6): a
// manifest alongside the version marker records the hash of every such
// file *as this installer wrote it*, so an upgrade can tell "shipped
// content nobody touched" from "the user customised this" and only
// overwrite the former — see readManifest()/writeManifest() and
// syncTrackedUserOwnedFile() below. Before this, every rule this
// framework ships into an agent file or CLAUDE.md reached fresh installs
// only, forever, because nothing recorded what had been written.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

// Sprint 6, Req 1: the manifest lives beside the version marker — a
// framework-owned location, not sprint state, same reasoning as
// VERSION_MARKER_PATH above. One JSON object, relPath -> sha256 hex (of
// CRLF-normalised content, see hashFile() below) of what this installer
// last wrote there.
const MANIFEST_PATH = path.join(DEST_ROOT, '.claude', 'fully-completely-manifest.json');

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

// Sprint 6, Req 1/3. Hashes normalised content (CRLF collapsed to LF),
// matching sameContent() below, rather than raw bytes — an editor's
// line-ending setting or git's autocrlf shouldn't manufacture a false
// "customised" conflict on every Windows install, and this codebase
// already treats CRLF/LF as the same content everywhere else it compares
// files (sameContent(), removeDeadGitignoreLines()'s own CRLF
// preservation). Req 3's safety property is about requiring positive
// proof of a match before overwriting, not about matching at the
// individual-byte level: a real content edit changes this hash exactly as
// surely as it would a raw-byte one, and only a real content edit does.
function hashFile(absPath) {
  return crypto.createHash('sha256').update(normalizeLineEndings(fs.readFileSync(absPath))).digest('hex');
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

// Req 3, the load-bearing function: every way this can fail — no manifest
// file, a manifest that isn't valid JSON, JSON that isn't a plain object,
// or a value for this specific path that isn't a well-formed sha256 hex
// string — returns null. Every caller below treats null as "no positive
// proof", which is what puts a file on the never-overwrite branch. There
// is no code path here that can throw past this and no code path that
// returns a value for a path it isn't confident about.
function readManifest() {
  let raw;
  try {
    raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  } catch {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed;
}

function manifestHashFor(manifest, relPath) {
  const value = manifest[relPath];
  return typeof value === 'string' && SHA256_HEX.test(value) ? value : null;
}

function writeManifest(manifest) {
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  const sorted = {};
  for (const key of Object.keys(manifest).sort()) sorted[key] = manifest[key];
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(sorted, null, 2) + '\n');
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

// Req 4: unlike copyUserOwnedFile's generic conflict line above (still
// used for docs/sprints, Req 6, where there is no manifest and never will
// be), this file is under the manifest mechanism — but "upstream has
// updated this file" is only a claim the no-manifest/mismatched-hash
// branch can back up when it's actually true. QA1 round 1 caught that the
// single-message version said it unconditionally: on a real 0.1.4 ->
// 0.1.5 upgrade with no manifest at all, every untouched agent file lands
// on this same branch, and five of seven were byte-identical to upstream
// — "upstream has updated this" was simply false for those five. `matches`
// (sameContent(src, dest), already computed by the caller) is what makes
// the message honest either way: if the file actually differs, point at
// how to see that; if it doesn't, say so and stop there, since there is
// nothing to reconcile. `npx fully-completely` into an empty directory is
// the one way to get a fresh copy that works regardless of how this
// project got installed (npx, a cloned repo, a git submodule), so it's
// what's pointed at here rather than guessing at a source path on this
// machine.
function trackedConflictMessage(relPath, matches) {
  const reason =
    "this doesn't match what this installer last wrote here, so this upgrade left it untouched to " +
    'protect anything you may have customised.';
  if (matches) {
    return (
      `${relPath} (yours — ${reason} Nothing to reconcile, though: this file is already byte-identical ` +
      "to what upstream ships now, so there's no diff to look at. It's flagged only because nothing " +
      "confirms you never touched it — no action needed if that's expected.)"
    );
  }
  return (
    `${relPath} (yours — ${reason} Upstream has updated ${relPath} since the version you have; to see ` +
    "exactly what's different, run `npx fully-completely` again inside an empty scratch directory to " +
    'get a fresh copy of the current upstream version, then diff it against your own file and merge ' +
    'anything you want by hand.)'
  );
}

// Req 1-3, Req 5: the manifest-governed replacement for copyUserOwnedFile,
// used for `.claude/agents/*` and `CLAUDE.md` (both walk through the same
// USER_OWNED loop below, so both get this uniformly, per Req 5).
//   - Missing at DEST_ROOT -> fresh copy, exactly like a first install
//     always has; record its hash.
//   - Present, and manifestHashFor() returns null (no manifest, unreadable
//     manifest, no entry for this path, or a malformed one) -> Req 3's
//     safe branch: conflict, untouched, and the old manifest entry (if
//     any survived being read) is carried forward unchanged rather than
//     guessed at.
//   - Present, and the recorded hash doesn't match the file's current
//     (CRLF-normalised) hash -> genuinely customised since our last write
//     -> same safe branch as above.
//   - Present, and the recorded hash matches -> positive proof nobody
//     touched it -> safe to bring current, same as FRAMEWORK_OWNED:
//     skip (record hash again) if upstream's own content hasn't changed
//     either, otherwise back up and overwrite, then record the new hash.
function syncTrackedUserOwnedFile(relPath, oldManifest, newManifest) {
  const src = path.join(SOURCE_ROOT, relPath);
  const dest = path.join(DEST_ROOT, relPath);

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copied.push(relPath);
    newManifest[relPath] = hashFile(dest);
    return;
  }

  const recordedHash = manifestHashFor(oldManifest, relPath);
  const currentHash = hashFile(dest);

  if (recordedHash === null || recordedHash !== currentHash) {
    conflicts.push(trackedConflictMessage(relPath, sameContent(src, dest)));
    if (recordedHash !== null) newManifest[relPath] = recordedHash;
    return;
  }

  if (sameContent(src, dest)) {
    skipped.push(relPath);
    newManifest[relPath] = currentHash;
    return;
  }
  const backup = backupPathFor(dest);
  fs.copyFileSync(dest, backup);
  fs.copyFileSync(src, dest);
  replaced.push(`${relPath} (upgraded, previous version backed up to ${path.relative(DEST_ROOT, backup)})`);
  newManifest[relPath] = hashFile(dest);
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

// Req 1: the manifest as it was before this run wrote anything, so
// "unchanged since our last write" means exactly that; newManifest is
// what gets written at the end, built up entry-by-entry as
// syncTrackedUserOwnedFile() below decides each path.
const oldManifest = readManifest();
const newManifest = {};

for (const p of USER_OWNED) {
  if (p === 'docs/sprints') {
    // Special-cased, not walked: see SPRINT_SKELETON_FILES above. Only
    // the empty phase-folder skeleton is ever sourced from this repo,
    // never its real sprint content. Req 6: excluded from the manifest
    // mechanism entirely — plain copyUserOwnedFile(), unchanged.
    for (const relPath of SPRINT_SKELETON_FILES) {
      if (fs.existsSync(path.join(SOURCE_ROOT, relPath))) copyUserOwnedFile(relPath);
    }
    continue;
  }
  // Req 5: `.claude/agents` (a directory) and `CLAUDE.md` (a single file)
  // both land here and both go through syncTrackedUserOwnedFile()
  // identically — nothing below branches on which one it is.
  const abs = path.join(SOURCE_ROOT, p);
  if (!fs.existsSync(abs)) continue;
  if (fs.statSync(abs).isDirectory()) {
    for (const relPath of collectPaths(SOURCE_ROOT, p)) syncTrackedUserOwnedFile(relPath, oldManifest, newManifest);
  } else {
    syncTrackedUserOwnedFile(p, oldManifest, newManifest);
  }
}

mergeSettings();
mergeTasks();
mergeGitignore();

writeInstalledVersion(CURRENT_VERSION);
writeManifest(newManifest);

function section(title, items) {
  if (items.length === 0) return;
  console.log(`\n${title} (${items.length}):`);
  for (const item of items) console.log(`  ${item}`);
}

// Req 5's own first clause is "distinguish a first install from an
// upgrade" — the version marker alone doesn't settle that in every case,
// only whether any framework-owned files actually got replaced or
// removed does. Two cases caught this the same way, one round apart:
//   - LiveQA: no marker (a pre-marker install) reported "Installed X
//     (first install)" while replacing and removing real files
//     underneath that claim.
//   - QA1, checking the sibling branch: a marker that already says
//     CURRENT_VERSION reported "Already at X, nothing to upgrade" while
//     doing exactly that below it — reachable for real, not just in
//     theory, by anyone who did sprint 1's Part B workaround (hand-
//     replacing the launcher folder) without the marker ever moving.
// Both are the same lie: claiming nothing changed, directly above a
// section listing what changed.
const didUpgradeWork = replaced.length > 0 || removed.length > 0;

console.log(`Fully Completely: installed into ${DEST_ROOT}`);
if (installedVersion && installedVersion !== CURRENT_VERSION) {
  console.log(`Upgraded ${installedVersion} -> ${CURRENT_VERSION}`);
} else if (installedVersion && didUpgradeWork) {
  const repairedCount = replaced.length + removed.length;
  console.log(
    `Already at ${CURRENT_VERSION}, but repaired ${repairedCount} file(s) that had drifted from it — see below`
  );
} else if (installedVersion) {
  console.log(`Already at ${CURRENT_VERSION} (re-run, nothing to upgrade)`);
} else if (didUpgradeWork) {
  console.log(`Upgraded unknown -> ${CURRENT_VERSION}`);
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
    'preflight check blocks only when Claude reports no usable credentials — ' +
    'it otherwise proceeds, so this is a courtesy check, not a hard requirement ' +
    'this script can verify.'
);

if (conflicts.length > 0) {
  console.log(
    `\n${conflicts.length} file(s) already exist here with different content and were not overwritten. ` +
      'Reconcile them by hand, then re-run this script if useful.'
  );
  process.exitCode = 1;
}
