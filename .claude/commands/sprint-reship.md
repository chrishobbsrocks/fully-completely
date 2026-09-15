---
description: "Pipeman: push a fix during the LiveQA live-test loop"
allowed-tools: [Bash]
---

# Reship Fix

Usage: `/sprint-reship <sprint-id> --commit <hash>`

```bash
node scripts/run-lifecycle.js reship $ARGUMENTS
```

Use this when LiveQA found a live issue and Dev Team has fixed it. `--commit` must resolve to a real commit — this does not change the sprint's phase, but it does record the resolved SHA as what's now deployed, which LiveQA's next `/sprint-liveqa --deployed-commit` call is checked against. LiveQA should re-test and run `/sprint-liveqa` again.

**This refuses, no override, unless QA1 has a PASS on record for the exact commit's tree** (sprint 36, Req 3): either gate 1's own still-standing PASS, or a live-loop audit PASS QA1 recorded during this fix loop via `/sprint-qa1 <sprint-id> --verdict ... --commit <hash>`. If it refuses, the message names both trees and the exact recovery — hand the commit to QA1 for that live-loop audit (QA1's own session, not yours), then run this again once it PASSes. There is no way to push a reship through without it.
