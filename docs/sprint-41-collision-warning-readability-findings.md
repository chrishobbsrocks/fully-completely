# Sprint 41, Req 3 — collision-warning readability, measured

**Flagged assumption, measured before building (Req 3a).** The collision
warning (`role-claims.js`'s `roleClaimWarning()`) was, before this sprint,
printed only to stderr by `run-role.js`, before `claude` starts. LiveQA's
sprint 38 round 2 report (both platforms, real VS Code) found Claude Code's
own full-screen interactive UI covers that line within well under a second —
readable on the CLI version the workshop guide was verified against, not on
later ones. This sprint measured, rather than reasoned about, which route
actually survives that redraw.

## Route measured: inject the warning into the opening prompt

**Method.** Real `claude` launches from this repo's own root, via
`--agent qa1 --session-id <uuid> -p "<prompt>" --output-format json`, using
the real `initialPrompt()` from `scripts/launcher/prompts.js` with a fake
collision warning (`role-claims.js`'s own real wording, carrying a unique
marker token) prepended — exactly the shape `freshLaunchArgs()`'s prompt
construction produces after this sprint's fix. Verdict decided only from the
model's own `result` field in the structured JSON output — a literal
substring match on the marker — never from narration about narration.

**Result — CONFIRMED, `claude 2.1.278`:**
- 3/3 real runs: the marker token appeared verbatim in the model's own
  generated reply every time, with the model explicitly reasoning about the
  collision in its own turn (e.g. "Possible second QA1 session… I can't tell
  whether that session is still live").
- This directly confirms the mechanism: text prepended to the opening prompt
  becomes part of the model's own turn, which Claude Code's interactive TUI
  renders into the conversation transcript/scrollback — the same rendering
  pipeline for headless and interactive launches, unlike a pre-launch
  `console.error()` line, which exists and is overwritten before the TUI
  process itself even starts.
- Extra check, 1/1: the same injection mechanism also works on `--resume`
  launches (`claude --agent <id> --resume <uuid> "<message>" -p …` — the
  trailing message was accepted and restated). This matters because, before
  this sprint, `resumeLaunchArgs()` sent **no** trailing prompt at all for
  any role except `dev-team-2`'s own worktree-resume note — a warning fired
  on a *resumed* collision would otherwise still go unsurfaced. Fixed in the
  same change (see `resumeLaunchArgs()`'s new `roleWarning` parameter).

## Route considered, not run live: hold the launch until acknowledged

Evaluated structurally, per Req 3a's own allowance ("or something else
measured to work" — this one was ruled out on structural grounds rather than
run, since it has no screen-reachable failure mode to actually execute
against without a live VS Code session): `FC: Start All` runs all six role
tasks with `dependsOrder: "parallel"`, each in its own dedicated VS Code
terminal pane, with no single point where one human input reaches all six.
A gate that blocks on a keypress only when a warning fires would still
require a human to individually visit and dismiss up to six separate panes
before those specific sessions proceed — a real degradation of "launch all
six in one action," conditional only on whether a warning happens to fire.
This is a structural fact about the task's own `parallel` shape, and Req 3b
explicitly forbids exactly this ("must not block or delay a launch... a
workshop attendee launching six agents must not face six extra prompts"), so
this route was not pursued further.

## Outcome (Req 3c does not apply)

The measured route was not worse than the current behavior — it directly
fixes the readability gap with no added delay or prompt on a clean launch —
so Req 3c's escape valve ("if every measured route is worse... change
nothing") does not apply. Implemented in `scripts/launcher/prompts.js`
(`initialPrompt()`) and `scripts/launcher/run-role.js`
(`freshLaunchArgs()`/`resumeLaunchArgs()`, both now take an optional
`roleWarning` parameter); the pre-launch `console.error()` line is kept
unconditionally alongside it (cheap, still correct for a headless/log-reading
consumer) — additive, not a replacement. A clean launch (no warning) produces
byte-identical prompt text to before this sprint, verified in
`scripts/launcher_test.js`.
