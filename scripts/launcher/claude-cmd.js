'use strict';
// Cross-platform argv builder for invoking the `claude` CLI. Shared by
// run-role.js (spawning the actual six role sessions) and auth.js (the
// login preflight probe) so the Windows cmd.exe routing lives in exactly
// one place.
//
// On Windows, a global npm install of claude is typically a .cmd shim,
// which can't be exec'd directly the way a real macOS/Linux binary can.
// The tempting fix is spawn(..., {shell: true}), but that's actively
// unsafe: Node's shell:true mode does NOT escape array args, it just
// concatenates them (see the DEP0190 deprecation warning) — confirmed by
// hand, a prompt string containing parentheses breaks the shell outright,
// silently mangling every argument after it into separate shell tokens.
// Node's own docs recommend the alternative used here instead: spawn
// cmd.exe directly (shell: false, the safe default) with /c plus the
// target and its args as a normal array — Node's already-safe non-shell
// Windows argv quoting does the escaping, so there's nothing to hand-roll.
function claudeCommand(args) {
  if (process.platform === 'win32') {
    return ['cmd.exe', ['/c', 'claude', ...args]];
  }
  return ['claude', args];
}

module.exports = { claudeCommand };
