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
const LOCK_FILE = path.join(STATE_DIR, 'state.json.lock');
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 2000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A lock left behind by a crashed process would otherwise make every
// future call here wait out the full timeout, forever, with nothing ever
// fixing it. Anything older than LOCK_TIMEOUT_MS is assumed abandoned.
function reapStaleLock() {
  try {
    const stat = fs.statSync(LOCK_FILE);
    if (Date.now() - stat.mtimeMs > LOCK_TIMEOUT_MS) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {
    // gone already, or some other transient stat/unlink race — either way
    // there's nothing left to reap
  }
}

// FC: Start All launches all six role processes in parallel, and each one
// does a read-modify-write of state.json around its own spawn time — with
// no locking, two writes landing close together can race, and the loser
// silently clobbers the winner's just-written entry (a lost resume
// record, discovered only much later as "resume acted like it had never
// launched before"). This lock is deliberately fail-soft: if it can't be
// acquired within LOCK_TIMEOUT_MS, it proceeds without the lock rather
// than blocking or crashing an interactive session over a record that,
// worst case, just means one resume falls back to fresh next time.
function withLock(fn) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd = null;
  while (Date.now() < deadline) {
    try {
      fd = fs.openSync(LOCK_FILE, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') break; // some other error, proceed unlocked
      reapStaleLock();
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
      try {
        fs.unlinkSync(LOCK_FILE);
      } catch {
        // already gone (e.g. reaped by a concurrent caller as stale right
        // as we finished) — fine, the point was releasing it
      }
    }
  }
}

// Write to a temp file in the same directory, then rename over the
// target — an interrupted write leaves the previous state.json intact
// instead of a truncated/corrupt one. Same pattern this repo's own
// sprint_lifecycle.py already uses for its state files.
function atomicWrite(filePath, content) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

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
  withLock(() => {
    const state = readState();
    state[roleId] = { lastLaunched: new Date().toISOString() };
    atomicWrite(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  });
}

module.exports = { wasLaunched, markLaunched, STATE_DIR, STATE_FILE };
