---
description: "Abandon a sprint at any phase"
allowed-tools: [Bash, Write]
---

# Abort Sprint

Usage: `/sprint-abort <sprint-id> --reason "..."`

**Security note**: do not interpolate `$ARGUMENTS` (or any free-text reason) directly into the bash command below. Write the reason to a temp file with the Write tool, then run:

```bash
python3 scripts/sprint_lifecycle.py abort <sprint-id> --reason-file /tmp/abort-reason.txt
```

Moves the sprint file to `docs/sprints/5-abandoned/` and marks its state as aborted, regardless of what phase it was in.
