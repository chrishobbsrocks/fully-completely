'use strict';
// Tiny local record of which roles this launcher has already started a
// named session for, so "Resume" can tell a genuine first-ever launch
// (nothing to resume, go fresh immediately) apart from "a session was
// started before, try to resume it." Never committed — see .gitignore.
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./agents');

const STATE_DIR = path.join(ROOT, '.claude-launcher');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function wasLaunched(roleId) {
  return Boolean(readState()[roleId]);
}

function markLaunched(roleId) {
  const state = readState();
  state[roleId] = { lastLaunched: new Date().toISOString() };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

module.exports = { wasLaunched, markLaunched, STATE_DIR, STATE_FILE };
