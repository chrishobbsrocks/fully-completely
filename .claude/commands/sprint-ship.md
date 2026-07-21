---
description: "Pipeman: push code to remote after dev work is agreed done"
allowed-tools: [Bash]
---

# Ship Sprint

Usage: `/sprint-ship <sprint-id> --commit <hash>`

```bash
python3 scripts/sprint_lifecycle.py ship $ARGUMENTS
```

Only succeeds once Dev Team has run `/sprint-dev-done`. Moves the sprint into the `qa_auto_live` phase, QA-Auto should now test the deployed product with `/sprint-qa-auto`.
