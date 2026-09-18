---
description: "Dev Team: start a sprint Master Controller assigned you"
allowed-tools: [Bash]
---

# Start Sprint

**CRITICAL**: Use the automation script ONLY.

```bash
node scripts/run-lifecycle.js start $ARGUMENTS
```

This moves the sprint file into `docs/sprints/2-in-progress/`, creates its state file, and sets the phase to `dev_build`. Dev Team 1 (or Dev Team 2) runs this directly once Master Controller has defined the sprint and pointed you at its ID, then reads the sprint file and begins building. Master Controller does not run this itself, it stays read-only (`/sprint-status`) once a sprint is handed off, running lifecycle commands from both sessions is what caused duplicate-attempt collisions in practice.

`/sprint-start` only ever proceeds on a sprint with no state file yet (never started) or one sitting at `blocked` — every other phase refuses outright, no override; the documented path there is `/sprint-block` (with a real `--reason`) followed by `/sprint-start` again, not this command acting directly on an in-flight or closed sprint.

**Re-filing a blocked sprint now takes one of two paths** (sprint 39, Req 2, extending sprint 36's own full-reset-only behavior):
- **Gates kept**: if a QA1 PASS is on record, `/sprint-block` recorded which phase this sprint was blocked from, and the sprint file is byte-for-byte unchanged since that PASS (a pure `status:` bookkeeping rewrite never counts as a change — sprint 39, Req 1), the sprint returns directly to its exact pre-block phase with every gate-result field and both round counts untouched. This is the common case for a sprint blocked purely over an undecided question, nothing about the code itself.
- **Gates reset**: every other case — the file changed, no PASS is on record, or the pre-block phase wasn't tracked (a sprint blocked by a version before this existed). Exactly the original sprint 36 behavior: history is kept (a new event is appended, never replaced), `audit_rounds`/`live_test_rounds`/the original `started` timestamp are kept, but phase goes back to `dev_build` and every gate-result field is cleared — a repaired file has to clear both gates again from scratch.

The printed output always says which path ran, and for a reset, why.

Every run prints a line like `[sprint_lifecycle] repo=... script=...` to stderr. Check that the `script=` path actually points into this repo's `scripts/sprint_lifecycle.py` before trusting the output — a same-named script elsewhere on disk, or a stale global slash command, will look plausible but resolve to something else entirely.
