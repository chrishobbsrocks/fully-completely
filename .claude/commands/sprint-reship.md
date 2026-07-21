---
description: "Pipeman: push a fix during the QA-Auto live-test loop"
allowed-tools: [Bash]
---

# Reship Fix

Usage: `/sprint-reship <sprint-id> --commit <hash>`

```bash
python3 scripts/sprint_lifecycle.py reship $ARGUMENTS
```

Use this when QA-Auto found a live issue and Dev Team has fixed it. This does not change the sprint's phase, it just logs the new commit, QA-Auto should re-test and run `/sprint-qa-auto` again.
