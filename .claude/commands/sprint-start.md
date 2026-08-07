---
description: "Dev Team: start a sprint Master Controller assigned you"
allowed-tools: [Bash]
---

# Start Sprint

**CRITICAL**: Use the automation script ONLY.

```bash
python3 scripts/sprint_lifecycle.py start $ARGUMENTS
```

This moves the sprint file into `docs/sprints/2-in-progress/`, creates its state file, and sets the phase to `dev_build`. Dev Team 1 (or Dev Team 2) runs this directly once Master Controller has defined the sprint and pointed you at its ID, then reads the sprint file and begins building. Master Controller does not run this itself, it stays read-only (`/sprint-status`) once a sprint is handed off, running lifecycle commands from both sessions is what caused duplicate-attempt collisions in practice.

Every run prints a line like `[sprint_lifecycle] repo=... script=...` to stderr. Check that the `script=` path actually points into this repo's `scripts/sprint_lifecycle.py` before trusting the output — a same-named script elsewhere on disk, or a stale global slash command, will look plausible but resolve to something else entirely.
