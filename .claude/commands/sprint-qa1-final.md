---
description: "QA1: final check after GroundTruth's live test has passed (gate 2)"
allowed-tools: [Bash, Write]
---

# QA1 Final Check

Usage: `/sprint-qa1-final <sprint-id> --verdict PASS|FAIL --notes "..."`

**Security note**: do not interpolate `$ARGUMENTS` (or any free-text notes) directly into the bash command below. Write the notes to a temp file with the Write tool, then run:

```bash
python3 scripts/sprint_lifecycle.py qa1-final <sprint-id> --verdict <verdict> --notes-file /tmp/qa1-final-notes.txt
```

Only valid once GroundTruth has recorded a PASS. A PASS here makes the sprint complete-ready, Master Controller can then run `/sprint-complete`. A FAIL sends the whole sprint back to `dev_build`, both gates will need to be re-earned from scratch.
