#!/usr/bin/env node
'use strict';
// Sprint 16, Req 1: a stale scripts/baselines/user-owned-content.json
// fails a check, mechanically, instead of drifting until someone
// remembers to regenerate it. This has happened four times (QA1 flagged
// it in sprints 9 and 10; it recurred again in sprint 12; the table sat
// at 0.1.0-0.1.8 through nine more releases before this sprint) because
// nothing ever failed loudly about it — every occurrence got worked
// around in the round it appeared, in scripts/launcher_test.js's own
// baseline-match tests, without touching the actual cause.
//
// The pure comparison (missingVersions) takes no I/O of its own, on
// purpose: it's the part Req 5 asks to be tested in both directions, and
// a function that just compares two arrays is trivially testable with
// fake data, without needing a real npm registry call or a real
// baselines file in every test run. The I/O — reading the real table,
// asking the real registry what's actually published — is this file's
// own CLI wrapper below, run once, for real, from verify-tarball.sh.
//
// "The last published version" is deliberately the REGISTRY's answer
// (generate.js's own publishedVersions(), the same call it already makes
// to decide what to hash), not package.json's current version minus one
// computed locally. Those two happen to agree today, because this
// project's own discipline is to confirm the prior version is live
// before ever bumping package.json — but the registry is the actual
// source of truth for "published," and asking it directly is what makes
// Req 1's own N-1 rule correct BY CONSTRUCTION rather than by convention:
// the version currently sitting in package.json, about to ship, cannot
// itself be on the registry yet (this check runs pre-publish, per
// pipeman.md step 9.1's own ordering), so it can never appear in
// publishedVersions() and this check can never wrongly demand the table
// cover it. No separate "subtract one" logic exists anywhere here to get
// wrong.
const path = require('path');
const { compareVersions, publishedVersions } = require('./generate');

const BASELINES_PATH = path.join(__dirname, 'user-owned-content.json');

// Sorted (compareVersions, not lexical — 0.1.9 before 0.1.10) so a
// failure message reads as an ordered list, not registry-response order.
function missingVersions(coveredVersions, actualPublishedVersions) {
  const covered = new Set(coveredVersions);
  return actualPublishedVersions.filter((v) => !covered.has(v)).sort(compareVersions);
}

function main() {
  let table;
  try {
    table = require(BASELINES_PATH);
  } catch (err) {
    console.error(`ERROR: could not read or parse ${BASELINES_PATH}: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const covered = Array.isArray(table.versions) ? table.versions : [];

  let published;
  try {
    published = publishedVersions();
  } catch (err) {
    console.error(`ERROR: could not read the published version list from the npm registry: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const missing = missingVersions(covered, published);
  if (missing.length > 0) {
    console.error(
      `ERROR: scripts/baselines/user-owned-content.json is stale. Missing version(s): ${missing.join(', ')}. ` +
        `Table covers through ${covered.sort(compareVersions).slice(-1)[0] || '(none)'}; ` +
        `the registry's latest published version is ${published.sort(compareVersions).slice(-1)[0]}. ` +
        'Run `node scripts/baselines/generate.js` (or `npm run baselines:generate`) and commit the result.'
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `OK: scripts/baselines/user-owned-content.json covers every published version ` +
      `(through ${published.sort(compareVersions).slice(-1)[0]}).`
  );
}

if (require.main === module) {
  main();
}

module.exports = { missingVersions };
