# Human override — read this before you use it

This file is deliberately not linked from `README.md`, `CLAUDE.md`, any
`.claude/commands/*.md`, or any `.claude/agents/*.md`. None of the six roles
in this workflow know this exists, and none of their instructions ever tell
them to look for it. That's not an oversight, it's the point: this is for
the human ultimately accountable for this project, not for an agent to
reach for in the middle of a build.

## Why this exists

Four of this project's mechanical checks refuse outright, no override, by
design:

- `/sprint-dev-done` refuses if the sprint file has changed since QA1's
  PASS.
- `/sprint-ship` refuses if the commit being shipped doesn't match what
  QA1 audited.
- `/sprint-liveqa` refuses if `--deployed-commit`, the commit you
  actually tested live, doesn't match what Pipeman's last ship or reship
  recorded. This one doesn't get a gate here either, on purpose: unlike
  the QA1-to-ship check above, there's no legitimate transform (rebase,
  squash, whatever) that would make these two differ and still be fine.
  A mismatch always means the live test ran against something other than
  what was actually deployed — there's nothing to responsibly re-stamp,
  only a wrong deployment to go re-test against the right one.
- `/sprint-complete` refuses without a non-empty `--user-said`, quoting
  what the user actually told you authorizes closing the sprint right
  now. Both gates passing is not that; there is nothing to re-stamp or
  unstick here, only the user's own word suffices, so `override` doesn't
  apply to this one either.

All four are deliberately absolute in every piece of documentation an agent
reads. That's correct — the moment an agent (or a human moving fast inside
an agent-driven session) has a `--override` flag sitting next to the
command it's already running, the check stops meaning anything. It becomes
"was this worth re-checking," a judgment call exactly as skippable under
deadline pressure as the "did I re-read" judgment call it replaced.

But a human with full context, genuinely stuck, has historically had
exactly one way around a refusal like that: hand-edit the state JSON
directly. `CLAUDE.md` explicitly forbids this, for good reason — it
bypasses atomic writes, file locking, and leaves no record. This command
exists so that when you've actually reviewed the drift yourself and decided
it's fine, you have a way to say so that's still safer than the
alternative it's actually competing with.

## What it does, and does not do

`override` never fabricates a QA1 PASS that never happened. Both gates
still require the real precondition first — a PASS actually on record for
`dev-done-hash`, `dev_agreed_done` phase actually reached for `ship-hash`.
All it does is re-stamp the hash the gate compares against, so the
normal command (`/sprint-dev-done` or `/sprint-ship`) then proceeds through
its own normal path. There's no separate "override path" duplicating what
those commands do.

Every use is permanently written into the sprint's history (`/sprint-status
<N> --verbose` will show it forever) with whatever reason you gave.

## Usage

```bash
# Unstick /sprint-dev-done after a reviewed, harmless sprint-file amendment
python3 scripts/sprint_lifecycle.py override <id> \
  --gate dev-done-hash \
  --reason "reviewed the amendment myself, cosmetic wording only" \
  --confirm OVERRIDE

# Unstick /sprint-ship after a reviewed, harmless post-audit commit
python3 scripts/sprint_lifecycle.py override <id> \
  --gate ship-hash \
  --reason "reviewed the extra commit myself, typo fix only, safe to ship" \
  --confirm OVERRIDE
  # optionally --commit <hash> if you're not shipping HEAD
```

`--confirm` must be the literal word `OVERRIDE`, typed deliberately.
`--reason` is required and non-empty — write what you actually reviewed,
not just "urgent."

There is no `/sprint-override` slash command and there never should be.
Run this from the CLI, directly, yourself.

## When not to use this

If you're reaching for this because getting a fresh `/sprint-qa1` audit
feels too slow, that's the signal to make re-audits faster (see the
"Deliberately no escape hatch" reasoning in `README.md`'s gate-mechanics
section), not to use this instead. This exists for genuine cases — the
reviewer's unavailable and there's a real deadline, the drift is something
you've personally verified is inert — not as a faster path through the
normal process.
