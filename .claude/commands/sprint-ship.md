---
description: "Pipeman: push code to remote after dev work is agreed done"
allowed-tools: [Bash]
---

# Ship Sprint

Usage: `/sprint-ship <sprint-id> --commit <hash>`

```bash
node scripts/run-lifecycle.js ship $ARGUMENTS
```

Only succeeds once Dev Team has run `/sprint-dev-done`. Moves the sprint into the `liveqa_live` phase, LiveQA should now test the deployed product with `/sprint-liveqa`.
