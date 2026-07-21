---
description: "Master Controller: start a sprint and hand it to Dev Team"
allowed-tools: [Bash]
---

# Start Sprint

**CRITICAL**: Use the automation script ONLY.

```bash
python3 scripts/sprint_lifecycle.py start $ARGUMENTS
```

This moves the sprint file into `docs/sprints/2-in-progress/`, creates its state file, and sets the phase to `dev_build`. Dev Team 1 (or Dev Team 2) should now read the sprint file and begin building.
