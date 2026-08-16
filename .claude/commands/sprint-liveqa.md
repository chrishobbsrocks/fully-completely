---
description: "LiveQA: record the live browser test verdict"
allowed-tools: [Bash, Write]
---

# LiveQA Live Test

Usage: `/sprint-liveqa <sprint-id> --deployed-commit <sha> --verdict PASS|FAIL|CONDITIONAL --notes "..."`

**Security note**: do not interpolate `$ARGUMENTS` (or any free-text notes, including exact page text or error strings you observed) directly into the bash command below. Write the notes to a temp file with the Write tool, then run:

```bash
python3 scripts/sprint_lifecycle.py liveqa <sprint-id> --deployed-commit <sha> --verdict <verdict> --notes-file /tmp/liveqa-notes.txt
```

`--deployed-commit` is the commit SHA you actually tested live — not free text, just a commit hash, so it carries no injection risk the way notes do (get it from Pipeman's handoff report, or `/sprint-status <sprint-id> --verbose`). It must match the commit Pipeman's most recent `/sprint-ship` or `/sprint-reship` recorded, an exact SHA match, not a content check. If it doesn't, the command refuses and names both commits — re-test against what's actually deployed, or if the wrong thing went out, tell Pipeman a fresh ship/reship is needed.

Only valid once Pipeman has shipped. A PASS makes the sprint complete-ready — that means the code is ready, not that anyone is authorized to close it. Dev Team tells the user it's ready and waits; `/sprint-complete` refuses without the user's explicit, real-time go-ahead (`--user-said`) regardless of gate status. A FAIL or CONDITIONAL means Dev Team fixes it and Pipeman reships (`/sprint-reship`) before you test again — `/sprint-status` will flag the sprint as not yet re-tested in the meantime.
