'use strict';
// Shared metadata for the six sprint-workflow roles: where each agent file
// lives, how to read its frontmatter, and how to map its `color:` field to
// a VS Code terminal color. Model is deliberately NOT read or passed on the
// command line anywhere in this launcher — `claude --agent <id>` alone puts
// each agent's frontmatter `model:` in charge, and passing --model on top
// would only invite the two to drift, even though frontmatter wins either
// way (verified empirically: `--agent X --model haiku` still ran as X's
// frontmatter model).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const AGENTS_DIR = path.join(ROOT, '.claude', 'agents');

// Filenames, terminal labels, and icons are fixed by this framework's own
// role set, not derived from anything on disk.
const ROLES = [
  { id: 'master-controller', label: 'Master Controller', icon: 'organization' },
  { id: 'dev-team-1', label: 'Dev Team 1', icon: 'code' },
  { id: 'dev-team-2', label: 'Dev Team 2', icon: 'repo-forked' },
  { id: 'qa1', label: 'QA1', icon: 'verified' },
  { id: 'pipeman', label: 'Pipeman', icon: 'rocket' },
  { id: 'liveqa', label: 'LiveQA', icon: 'eye' },
];

// VS Code task icons only accept `terminal.ansi*` theme colors (see
// https://code.visualstudio.com/updates/v1_69, "Task icons"). There is no
// true ANSI orange or purple, so Dev Team 2 (orange) and LiveQA (purple)
// map to the closest available shade rather than an exact one.
const COLOR_MAP = {
  blue: 'terminal.ansiBlue',
  red: 'terminal.ansiRed',
  orange: 'terminal.ansiBrightYellow',
  yellow: 'terminal.ansiYellow',
  green: 'terminal.ansiGreen',
  purple: 'terminal.ansiMagenta',
};

function agentFilePath(roleId) {
  return path.join(AGENTS_DIR, `${roleId}.md`);
}

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

// Returns null if the agent file doesn't exist yet (caller decides how to
// report that; this module stays read-only and silent about it).
function readAgentMeta(roleId) {
  const file = agentFilePath(roleId);
  if (!fs.existsSync(file)) return null;
  const front = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  return {
    name: front.name || roleId,
    model: front.model || null,
    color: front.color || null,
    themeColor: COLOR_MAP[front.color] || null,
    // Sprint 11: added for headless's --agents payload (see run-role.js's
    // agentBody() usage below) — pre-existing callers destructure the
    // fields they already used, so an additional field is not a breaking
    // change to readAgentMeta's shape.
    description: front.description || null,
  };
}

// Sprint 11: the persona body — everything after the frontmatter block —
// discovered empirically to be needed because `--bare` mode does not read
// .claude/agents/*.md at all (confirmed against a real invocation:
// `--agent qa1` alone fails there with "not found. Available agents:
// claude, Explore, general-purpose, Plan, statusline-setup", Claude
// Code's own built-in agent types, not this project's). Headless supplies
// the persona explicitly instead, via `--agents '{"<id>":{"prompt":
// "<this>", ...}}'` alongside `--agent <id>`, confirmed to resolve
// correctly the same way (a fake API key then fails at the auth step
// instead of at agent resolution). Reuses parseFrontmatter's own
// frontmatter-block regex via its match, rather than a second copy of it,
// so the two can never drift about where the frontmatter ends.
function agentBody(roleId) {
  const file = agentFilePath(roleId);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---/);
  return (match ? raw.slice(match[0].length) : raw).trim();
}

module.exports = {
  ROOT,
  AGENTS_DIR,
  ROLES,
  COLOR_MAP,
  agentFilePath,
  parseFrontmatter,
  readAgentMeta,
  agentBody,
};
