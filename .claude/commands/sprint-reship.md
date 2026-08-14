---
description: "Pipeman: push a fix during the GroundTruth live-test loop"
allowed-tools: [Bash]
---

# Reship Fix

Usage: `/sprint-reship <sprint-id> --commit <hash>`

```bash
python3 scripts/sprint_lifecycle.py reship $ARGUMENTS
```

Use this when GroundTruth found a live issue and Dev Team has fixed it. `--commit` must resolve to a real commit — this does not change the sprint's phase, but it does record the resolved SHA as what's now deployed, which GroundTruth's next `/sprint-groundtruth --deployed-commit` call is checked against. GroundTruth should re-test and run `/sprint-groundtruth` again.
