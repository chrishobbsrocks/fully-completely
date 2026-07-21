---
description: "Master Controller: close a sprint once both QA gates have passed"
allowed-tools: [Bash]
---

# Complete Sprint

```bash
python3 scripts/sprint_lifecycle.py complete $ARGUMENTS
```

This refuses to run unless all three are true:
1. QA1's first audit passed
2. GroundTruth's live test passed
3. QA1's final check passed

If any is missing, the script tells you exactly which one. Do not close a sprint any other way, "dev work agreed done" is not the same as complete.
