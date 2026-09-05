#!/usr/bin/env node
'use strict';
// Sprint 8, Req 2: this is the ONLY thing allowed to produce
// user-owned-content.json in this directory. A wrong hash in that table
// would silently authorize install.js overwriting a file somebody
// actually edited (see the sprint's own Risks section) — hand-editing it
// is exactly the failure mode this script exists to remove, so if the
// data ever needs to change, the fix is to re-run this script, not to
// touch the JSON by hand.
//
// Run it from the repo root whenever a new version publishes:
//
//   node scripts/baselines/generate.js
//
// Fetches the *live* list of published versions from the registry rather
// than a version list hardcoded in this file, so re-running this after a
// future release automatically covers it — "extends to future releases"
// (Req 2) without this script itself needing an edit. For each version,
// packs and unpacks the REAL published tarball (`npm pack
// <name>@<version>`) rather than trusting anything checked into git —
// git history for a path can be rewritten or squashed; a published
// tarball, once out, is the actual thing every existing install already
// received. Hashes CLAUDE.md and every `.claude/agents/*.md` file found
// in each tarball using scripts/launcher/content-hash.js — the exact same
// function install.js compares against at install time — so a baseline
// this script writes and a baseline install.js reads can never silently
// disagree about what "the same content" means.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { hashContent } = require('../launcher/content-hash');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PACKAGE_NAME = require(path.join(REPO_ROOT, 'package.json')).name;
const OUTPUT_PATH = path.join(__dirname, 'user-owned-content.json');

function publishedVersions() {
  const raw = execFileSync('npm', ['view', PACKAGE_NAME, 'versions', '--json'], { encoding: 'utf8' });
  const versions = JSON.parse(raw);
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error(`npm view ${PACKAGE_NAME} versions --json did not return a non-empty array`);
  }
  return versions;
}

// Sorts version strings numerically by dotted segment (0.1.9 before
// 0.1.10), not lexically — cosmetic (JSON.stringify key order is not
// semantically load-bearing here), but a lexically-sorted table would be
// actively misleading to read once this project publishes a double-digit
// patch version.
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Packs and unpacks the real published tarball for one version into
// `workdir`, hashes CLAUDE.md (if present) and every `.claude/agents/*.md`
// file actually found there (a dynamic discovery, not a fixed list — an
// early version may not have shipped every agent file that exists today,
// and hardcoding the current set here would silently miss that).
function hashesForVersion(version, workdir) {
  const tarballName = execFileSync('npm', ['pack', `${PACKAGE_NAME}@${version}`, '--silent'], {
    cwd: workdir,
    encoding: 'utf8',
  }).trim();
  const tarballPath = path.join(workdir, tarballName);
  execFileSync('tar', ['-xzf', tarballPath, '-C', workdir]);
  const pkgDir = path.join(workdir, 'package');

  const hashes = {};
  const claudeMdPath = path.join(pkgDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    hashes['CLAUDE.md'] = hashContent(fs.readFileSync(claudeMdPath));
  }
  const agentsDir = path.join(pkgDir, '.claude', 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir).sort()) {
      if (!entry.endsWith('.md')) continue;
      const relPath = path.posix.join('.claude', 'agents', entry);
      hashes[relPath] = hashContent(fs.readFileSync(path.join(agentsDir, entry)));
    }
  }
  return hashes;
}

function main() {
  const versions = publishedVersions().sort(compareVersions);
  const files = {};

  for (const version of versions) {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-baselines-'));
    try {
      const hashes = hashesForVersion(version, workdir);
      for (const [relPath, hash] of Object.entries(hashes)) {
        if (!files[relPath]) files[relPath] = {};
        files[relPath][version] = hash;
      }
      console.log(`  ${version}: ${Object.keys(hashes).length} file(s)`);
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  }

  // Sort keys for a stable, diff-friendly file — real behaviour doesn't
  // depend on this, readability of the next regeneration's diff does.
  const sortedFiles = {};
  for (const relPath of Object.keys(files).sort()) {
    const perVersion = files[relPath];
    const sortedPerVersion = {};
    for (const version of Object.keys(perVersion).sort(compareVersions)) {
      sortedPerVersion[version] = perVersion[version];
    }
    sortedFiles[relPath] = sortedPerVersion;
  }

  const output = {
    generatedAt: new Date().toISOString(),
    versions,
    paths: Object.keys(sortedFiles),
    files: sortedFiles,
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`Wrote ${OUTPUT_PATH}`);
}

// Sprint 16, Req 1: only runs main() (which hits the real network and
// writes the real file) when this file is executed directly, the same
// guard run-role.js already uses — required as a module (by
// check-staleness.js below, and by launcher_test.js's own tests), this
// triggers none of that. compareVersions/publishedVersions are exported
// so the staleness check reuses the exact same version ordering and the
// exact same "ask the registry, not a local guess" source of truth,
// rather than a second, potentially-diverging copy of either.
if (require.main === module) {
  main();
}

module.exports = { compareVersions, publishedVersions };
