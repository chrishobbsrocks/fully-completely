---
description: "Dev Team: close a sprint once both QA gates have passed"
allowed-tools: [Bash]
---

# Complete Sprint

```bash
python3 scripts/sprint_lifecycle.py complete $ARGUMENTS
```

This refuses to run unless both are true:
1. QA1's first audit passed
2. GroundTruth's live test passed

If either is missing, the script tells you which one. Do not close a sprint any other way, "dev work agreed done" is not the same as complete.

Dev Team 1/2 runs this directly, the same session that ran `/sprint-start`, once GroundTruth's live test comes back PASS. Master Controller does not run this: it only reads status (`/sprint-status`) and stays out of the execution path, having both roles issuing lifecycle commands is what caused duplicate-attempt/"already complete" collisions in practice.

**This command never pushes anything, and neither should you.** Closing a sprint is bookkeeping, it moves a file and updates state, nothing more. If you're running this from Dev Team 1 or Dev Team 2's session (the common case, since that's the session that ran `/sprint-start`), do not also run `git push` or any other git command as a "finishing touch." Pushing to remote is Pipeman's job exclusively, every time, with no exception for sprint close. If code needs to reach remote, commit locally if needed and hand it to Pipeman via `/sprint-ship` or `/sprint-reship`, don't push it yourself just because you happen to be the one closing the sprint out.
