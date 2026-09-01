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
//
// Sprint 8 adds a second source of the same kind of proof, because the
// manifest alone only ever proves something for installs made *after*
// sprint 6 shipped — every earlier install has no manifest at all, so
// every one of them conflicted on all seven tracked files, permanently
// (sprint 6's own live gate found this in the field). scripts/baselines/
// holds the real content of every user-owned path as it was actually
// published in every prior release, generated from real npm tarballs
// (never hand-written, see scripts/baselines/generate.js) — matching an
// installed file's hash against ANY of those is exactly as strong a proof
// of "never edited" as a manifest entry. See readBaselines() and
// baselineHashesFor() below; syncTrackedUserOwnedFile() only ever
// consults baselines when there is no manifest entry at all, never as an
// override for one that already disagrees with what's on disk.
const fs = require('fs');
const path = require('path');
const { hasComments, parseJsonc } = require('./launcher/jsonc');
const { normalizeLineEndings, hashContent } = require('./launcher/content-hash');

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

// Sprint 8, Req 1/2: the second source of positive proof — hashes of
// every tracked user-owned path as it was actually published in every
// prior release, generated by scripts/baselines/generate.js from real
// npm tarballs (never hand-written; see that script for why). This lives
// under SOURCE_ROOT (the installed package's own files, shipped alongside
// install.js itself), not DEST_ROOT — it's reference data this installer
// reads, not something a target project has any use for holding onto.
const BASELINES_PATH = path.join(SOURCE_ROOT, 'scripts', 'baselines', 'user-owned-content.json');

const copied = [];
const skipped = [];
const conflicts = [];
const replaced = [];
const removed = [];
const notes = [];

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

// Sprint 6, Req 1/3; sprint 8 moved the actual hashing into
// scripts/launcher/content-hash.js so scripts/baselines/generate.js can
// share the exact same algorithm rather than risk a second, silently
// different implementation that would never match anything (see that
// module's own comment).
function hashFile(absPath) {
  return hashContent(fs.readFileSync(absPath));
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

// Sprint 8, Req 1: same load-bearing shape as readManifest() above — every
// failure (no file, unparseable JSON, wrong top-level shape) returns {},
// under which baselineHashesFor() below finds nothing for any path,
// exactly like a missing manifest. This is OUR OWN shipped data, so a
// failure here is a packaging defect rather than a target project's own
// state, but it still must degrade to "no evidence" rather than take an
// install down — Req 3's conservative default applies to every source of
// proof, not just the manifest.
function readBaselines() {
  let raw;
  try {
    raw = fs.readFileSync(BASELINES_PATH, 'utf8');
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
  const files = parsed.files;
  if (files === null || typeof files !== 'object' || Array.isArray(files)) return {};
  return files;
}

// Every well-formed hash on record for relPath, across every published
// version that shipped it — Req 1's "match against any published
// version". A malformed individual entry (wrong type, not 64-hex) is
// filtered out rather than allowed to poison the comparison; it simply
// isn't counted as a match for anything.
function baselineHashesFor(baselines, relPath) {
  const entry = baselines[relPath];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
  return Object.values(entry).filter((v) => typeof v === 'string' && SHA256_HEX.test(v));
}

// The one recorded hash for relPath at exactly `version`, or null if we
// have no (well-formed) data for that specific version. Used only by
// hasUpstreamChangedSinceInstall() below, to ask a narrower question than
// baselineHashesFor()'s "any version at all".
function baselineHashForVersion(baselines, relPath, version) {
  const entry = baselines[relPath];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const value = entry[version];
  return typeof value === 'string' && SHA256_HEX.test(value) ? value : null;
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

// Sprint 8, Req 4: unlike copyUserOwnedFile's generic conflict line above
// (still used for docs/sprints, Req 6, which has no manifest or baseline
// and never will), this file is under the proof mechanism, so a claim
// about upstream is one we can actually check rather than assert. QA1
// round 1 (sprint 6) caught the single-message version asserting
// "upstream has updated this file" unconditionally, which was false on 5
// of 7 conflicts in a real upgrade. QA1 round 2 then flagged the fix
// itself: "differs from what's on disk right now" still isn't the same
// claim as "upstream changed it" — a file whose shipped content has never
// changed at all can still differ from a hand-edited copy, and that
// difference is entirely the user's doing, not an update.
//
// `upstreamChanged` (computed by the caller, see hasUpstreamChangedSinceInstall()
// below) is what makes this honest: true only when this path's shipped
// content has actually moved at some point across every published
// baseline plus what's about to ship. When it's false, EITHER the file
// already matches what we'd install (nothing to show), OR upstream's
// content has simply never changed (so any observed difference is 100%
// the user's edit, not a pending update) — both are truthfully "nothing
// to reconcile from our side," which is exactly why the caller only needs
// to pass one boolean rather than every intermediate fact. `npx
// fully-completely` into an empty directory is the one way to get a fresh
// copy that works regardless of how this project got installed (npx, a
// cloned repo, a git submodule), so that's what's pointed at rather than
// guessing at a source path on this machine.
//
// `preciseToInstalledVersion` (sprint 9, QA1's round-1 CONDITIONAL on
// sprint 9 itself): whether "since the version you have" is a claim this
// run can actually back up. Sprint 9's Req 5 tightened the true-branch
// wording to that phrase on the assumption hasUpstreamChangedSinceInstall
// always establishes it — but that function's own fallback path (no
// baseline data for the exact installed version) only establishes the
// weaker "changed somewhere in the versions we do have data for", not
// "since the version you have" specifically. QA1 caught this live: the
// baseline table lagged three published releases behind at the time, so
// EVERY 0.1.6/0.1.7/0.1.8 install hit the fallback, and a user on any of
// those who'd edited a file that genuinely never changed (liveqa.md,
// constant since 0.1.3) was told upstream had updated it — false, and not
// a rare case, the common one at the time. Regenerating the baseline
// table fixes today's installs; this is what keeps the message honest
// even when that table goes stale again next release, since the true
// branch below only claims what's actually known instead of assuming
// the precise case.
function trackedConflictMessage(relPath, upstreamChanged, preciseToInstalledVersion) {
  const reason =
    "this doesn't match what this installer last wrote here, so this upgrade left it untouched to " +
    'protect anything you may have customised.';
  if (!upstreamChanged) {
    return (
      `${relPath} (yours — ${reason} There's no upstream update pending for this file — if it looks ` +
      "different from what we'd install, that difference is entirely your own edit, not something we " +
      'changed. Nothing to reconcile; no action needed unless you want one.)'
    );
  }
  const since = preciseToInstalledVersion
    ? 'since the version you have'
    : "at some point since it was first published — this installer doesn't have exact data for the " +
      "version you're on to say precisely when";
  return (
    `${relPath} (yours — ${reason} This file's shipped content has changed ${since}; to see exactly ` +
    "what's different in the current release, run `npx fully-completely` again inside an empty " +
    'scratch directory to get a fresh copy, then diff it against your own file and merge anything ' +
    'you want by hand.)'
  );
}

// Sprint 8, Req 4: true only when relPath's shipped content actually
// differs between the version this project was last installed at and
// what's about to ship — false otherwise. Used only to choose which
// conflict message applies; it never influences whether to overwrite
// (that gate is entirely in syncTrackedUserOwnedFile below, and doesn't
// call this at all).
//
// This is deliberately install-version-bounded, not "has this path ever
// changed across all of history" — a file that changed once, long before
// this project's own install, and has been constant ever since is
// unchanged from this user's point of view, and QA1's own acceptance
// check is exactly this case: CLAUDE.md and every agent file changed at
// some point between 0.1.0 and 0.1.5, but NOT between 0.1.4 and 0.1.5
// specifically, which is the upgrade every existing install actually
// takes. A "has it ever changed" version of this function would have
// wrongly answered "yes" for those files and reproduced the same
// misattribution this Requirement exists to fix, just one layer deeper.
//
// installedVersion (or a version we have no baseline data for at all —
// pre-Req-5 installs, or a version this table doesn't cover yet) means
// there is no version to bound the comparison by; the best available
// conservative fallback is then "has this path differed anywhere across
// every version we DO have data for" — if it's been constant everywhere
// known, it certainly didn't change since an install we can't otherwise
// place either.
function hasUpstreamChangedSinceInstall(relPath, baselines) {
  const currentSourceHash = hashFile(path.join(SOURCE_ROOT, relPath));
  const installedHash = installedVersion !== null ? baselineHashForVersion(baselines, relPath, installedVersion) : null;
  if (installedHash !== null) {
    return installedHash !== currentSourceHash;
  }
  const hashes = new Set(baselineHashesFor(baselines, relPath));
  hashes.add(currentSourceHash);
  return hashes.size > 1;
}

// Sprint 9 (round 2): read-only, message-wording-only — never consulted
// by hasUpstreamChangedSinceInstall() above or by Req 1/3's overwrite
// gate, only by trackedConflictMessage() to decide whether "since the
// version you have" is a claim it can actually make. True exactly when
// installedVersion is known AND the baseline table has a real entry for
// that exact version; this is deliberately the same condition that puts
// hasUpstreamChangedSinceInstall() on its precise path rather than its
// fallback one, kept as its own function so a caller that only needs the
// wording question doesn't have to re-derive it from that function's
// internals.
function installedVersionHasBaselineData(relPath, baselines) {
  return installedVersion !== null && baselineHashForVersion(baselines, relPath, installedVersion) !== null;
}

// Sprint 6 Req 1-3/5, sprint 8 Req 1-4: the proof-governed replacement for
// copyUserOwnedFile, used for `.claude/agents/*` and `CLAUDE.md`.
//   - Missing at DEST_ROOT -> fresh copy, exactly like a first install
//     always has; record its hash.
//   - A manifest entry exists for this path -> it is direct, instance-
//     specific proof of what THIS installer last wrote here, and it wins
//     outright: matches current content -> proven; doesn't -> genuinely
//     edited since our last write, full stop. Baselines are not consulted
//     in this branch at all — they are evidence about what we published,
//     not about this specific installed copy's history, and cannot
//     override a manifest record that already disagrees with reality
//     (Req 1's own "when a file has no manifest entry" scoping).
//   - No manifest entry at all -> Req 1's second source of proof: does the
//     current content match ANY published version's real content for this
//     path? A match is exactly as strong as a manifest match — record it
//     and treat it identically. No match at all -> Req 3's safe branch,
//     unchanged from sprint 6: conflict, nothing recorded.
//   - Proven either way -> safe to bring current, same as FRAMEWORK_OWNED:
//     skip (record hash again) if upstream's own content hasn't changed
//     either, otherwise back up and overwrite, then record the new hash.
function syncTrackedUserOwnedFile(relPath, oldManifest, newManifest, baselines) {
  const src = path.join(SOURCE_ROOT, relPath);
  const dest = path.join(DEST_ROOT, relPath);

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copied.push(relPath);
    newManifest[relPath] = hashFile(dest);
    return;
  }

  const currentHash = hashFile(dest);
  const recordedHash = manifestHashFor(oldManifest, relPath);
  const proven = recordedHash !== null ? recordedHash === currentHash : baselineHashesFor(baselines, relPath).includes(currentHash);

  if (!proven) {
    const upstreamChanged = !sameContent(src, dest) && hasUpstreamChangedSinceInstall(relPath, baselines);
    const preciseToInstalledVersion = installedVersionHasBaselineData(relPath, baselines);
    conflicts.push(trackedConflictMessage(relPath, upstreamChanged, preciseToInstalledVersion));
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
// syncTrackedUserOwnedFile() below decides each path. baselines (sprint
// 8) is read once too — it never changes during a run, it's read-only
// reference data about what this project has published.
const oldManifest = readManifest();
const newManifest = {};
const baselines = readBaselines();

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
    for (const relPath of collectPaths(SOURCE_ROOT, p)) syncTrackedUserOwnedFile(relPath, oldManifest, newManifest, baselines);
  } else {
    syncTrackedUserOwnedFile(p, oldManifest, newManifest, baselines);
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
// QA1's sprint 6 round-2 informational note: this heading said "framework
// files" back when only FRAMEWORK_OWNED paths ever landed in `replaced`.
// Sprint 6 made a manifest/baseline-proven user-owned file land here too,
// so the old wording was inaccurate for exactly the files this epic
// exists to reach — fixed here since it's the same reporting-accuracy
// class of issue this sprint's Req 4 is about, and the fix is a label.
section('Replaced (upgraded, previous versions backed up)', replaced);
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

// Sprint 8, Req 5: conflicts no longer set a non-zero exit code. The
// original commit (3b52121, sprint "Add VS Code launcher...") introduced
// `process.exitCode = 1` here with no comment explaining why; the closest
// available reasoning is that a conflict was, at the time, a rare signal
// worth a script or CI wrapper treating as noteworthy. Sprint 6 changed
// what a conflict IS: every one of these categories (a user-owned file we
// can't prove untouched, a merge we can't safely perform) is the
// installer correctly DECLINING an unsafe action and reporting it loudly
// — the mechanism working as designed, not a failure of the tool. Sprint
// 6's own Context is the concrete case this makes acute: every pre-0.1.5
// install conflicts on all seven user-owned files on its first upgrade,
// permanently (now reduced, not eliminated, by sprint 8's baselines) — an
// exit code that fires on that outcome is indistinguishable from "always
// fires for every existing install", which has no signalling value left.
// The new contract: exit 0 means the run completed without the installer
// itself failing to do its job; a non-zero exit is reserved for an actual
// error — the "run this from inside the target project, not from this
// repo" guard near the top of this file (still a hard `process.exit(1)`)
// and an uncaught exception are the only ways to reach one. One real call
// site branches on this exit code — scripts/verify-tarball.sh:47's `(cd
// "$TARGET" && node "$UNPACKED/scripts/install.js") || fail ...` — and it
// is unaffected and actually improved by this change: that target is
// always a fresh empty directory, so it never produced a conflict to
// begin with, and the new contract makes a genuine install.js failure
// (what that check exists to catch) distinguishable from a routine
// conflict in a way the old blanket exitCode=1 never was; README,
// package.json, and launcher_test.js's own runInstall() helper don't
// branch on the exit code at all.
if (conflicts.length > 0) {
  console.log(
    `\n${conflicts.length} file(s) already exist here with different content and were not overwritten. ` +
      'Reconcile them by hand, then re-run this script if useful.'
  );
}
