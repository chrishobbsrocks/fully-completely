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

**This command never pushes anything, and neither should you.** Closing a sprint is bookkeeping, it moves a file and updates state, nothing more. If you're running this from Dev Team 1 or Dev Team 2's session (common, since that's often the active window when a sprint wraps up), do not also run `git push` or any other git command as a "finishing touch." Pushing to remote is Pipeman's job exclusively, every time, with no exception for sprint close. If code needs to reach remote, commit locally if needed and hand it to Pipeman via `/sprint-ship` or `/sprint-reship`, don't push it yourself just because you happen to be the one closing the sprint out.
