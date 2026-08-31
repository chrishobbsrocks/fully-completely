'use strict';
// Sprint 6/8: the one place the "what counts as the same content" rule
// lives. install.js's manifest (sprint 6) and its published-baseline
// table (sprint 8, scripts/baselines/generate.js) both have to agree on
// this exactly, or a baseline generated one way and compared another way
// would silently never match anything — Req 2's own warning about a
// wrong hash applies just as much to a *mismatched* hashing scheme as to
// a hand-typed one. Both call sites require this module rather than each
// defining their own copy.
//
// CRLF is collapsed to LF before hashing, not raw bytes — an editor's
// line-ending setting or git's autocrlf shouldn't manufacture a false
// "customised" result on every Windows checkout, and this project already
// treats CRLF/LF as the same content everywhere it compares files
// (install.js's own sameContent(), removeDeadGitignoreLines()'s CRLF
// preservation). A real content edit changes this hash exactly as surely
// as it would a raw-byte one; only line endings alone do not.
const crypto = require('crypto');

function normalizeLineEndings(buf) {
  return buf.toString('utf8').replace(/\r\n/g, '\n');
}

function hashContent(buf) {
  return crypto.createHash('sha256').update(normalizeLineEndings(buf)).digest('hex');
}

module.exports = { normalizeLineEndings, hashContent };
