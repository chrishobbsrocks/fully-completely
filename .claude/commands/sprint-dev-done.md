---
description: "Dev Team: signal that the coding side is agreed done (not the same as sprint complete)"
allowed-tools: [Bash]
---

# Dev Work Agreed Done

```bash
python3 scripts/sprint_lifecycle.py dev-done $ARGUMENTS
```

This only succeeds if QA1's first audit already returned PASS. It marks the coding as agreed done and hands off to Pipeman for `/sprint-ship`, it does not close the sprint. The sprint is only complete once GroundTruth and QA1's final check both pass, see `/sprint-complete`.
