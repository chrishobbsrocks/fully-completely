---
description: "Dev Team: signal that the coding side is agreed done (not the same as sprint complete)"
allowed-tools: [Bash]
---

# Dev Work Agreed Done

```bash
python3 scripts/sprint_lifecycle.py dev-done $ARGUMENTS
```

This only succeeds if QA1's first audit already returned PASS *against the current sprint file*. If the sprint file has changed since that PASS (a mid-build requirements amendment), this refuses and tells you to get QA1 to re-audit first, there is no override. It marks the coding as agreed done and hands off to Pipeman for `/sprint-ship`, it does not close the sprint. The sprint is only complete once LiveQA's live test passes too, see `/sprint-complete`.
