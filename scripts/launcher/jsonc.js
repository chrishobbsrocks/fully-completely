'use strict';
// One JSONC (JSON with // and /* */ comments, plus trailing commas)
// reader, shared by generate-tasks.js and install.js — QA1 caught that
// having two different ad hoc parsers for the same file shape (one a raw
// regex, one this module's predecessor) meant they could disagree, e.g.
// the regex matching a commented-out setting as if it were live.

// String- and escape-aware: a "//" or trailing comma sitting inside a
// real string value (a URL, a path, literal text) is never mistaken for
// a comment or stripped, unlike a blanket regex over the whole text.
function stripComments(text) {
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
  return out;
}

// Run only on already comment-free text. Drops a comma immediately
// before a closing `}`/`]` (VS Code allows trailing commas), but only
// when that comma is outside a string — a blanket regex over the whole
// text would also match a literal ", }" sitting inside a string value.
function stripTrailingCommas(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += text[i + 1];
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
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue; // drop trailing comma
    }
    out += c;
  }
  return out;
}

function hasComments(rawText) {
  return stripComments(rawText) !== rawText;
}

function parseJsonc(rawText) {
  return JSON.parse(stripTrailingCommas(stripComments(rawText)));
}

module.exports = { stripComments, stripTrailingCommas, hasComments, parseJsonc };
