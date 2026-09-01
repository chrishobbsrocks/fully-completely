'use strict';
// Sprint 10: the one place "what a manifest/baseline object's key looks
// like" is decided, factored out so it's directly testable — install.js
// itself is a top-level script with no exports, and the bug this fixes
// (a Windows-built relPath silently never matching a macOS-generated
// baseline table's forward-slash keys) can't be reproduced by running
// install.js's own CLI on a non-Windows machine, since path.join() never
// produces a backslash here. Testing this function directly, with a
// manually-constructed Windows-shaped string, is what makes the fix
// verifiable at all outside a real Windows run.
//
// Replaces the literal backslash character, not path.sep: path.sep is
// '/' on whatever machine runs the tests, so a version keyed off it could
// never be exercised outside a real Windows run — exactly how the defect
// this fixes went unnoticed through three sprints of verification.
// Matching the literal character is equally correct on real Windows,
// where path.join() also produces literal backslashes, and it means the
// fix is testable anywhere.
function toRelPathKey(relPath) {
  return relPath.split('\\').join('/');
}

module.exports = { toRelPathKey };
