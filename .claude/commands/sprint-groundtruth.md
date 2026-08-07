---
description: "GroundTruth: record the live browser test verdict"
allowed-tools: [Bash, Write]
---

# GroundTruth Live Test

Usage: `/sprint-groundtruth <sprint-id> --verdict PASS|FAIL|CONDITIONAL --notes "..."`

**Security note**: do not interpolate `$ARGUMENTS` (or any free-text notes, including exact page text or error strings you observed) directly into the bash command below. Write the notes to a temp file with the Write tool, then run:

```bash
python3 scripts/sprint_lifecycle.py groundtruth <sprint-id> --verdict <verdict> --notes-file /tmp/groundtruth-notes.txt
```

Only valid once Pipeman has shipped. A PASS makes the sprint complete-ready — Dev Team can then run `/sprint-complete`. A FAIL or CONDITIONAL means Dev Team fixes it and Pipeman reships (`/sprint-reship`) before you test again.
