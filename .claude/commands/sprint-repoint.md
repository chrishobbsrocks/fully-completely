---
description: "Pipeman: recover a shipped commit orphaned by a rebase"
allowed-tools: [Bash]
---

# Repoint Shipped Commit

Usage: `/sprint-repoint <sprint-id> --commit <new-commit>`

```bash
node scripts/run-lifecycle.js repoint-shipped-commit $ARGUMENTS
```

Sprint 28, Req 3. For exactly one situation: a sprint's `last_shipped_commit` became unreachable after the fact — usually a rebase moved it — and `/sprint-liveqa`'s deployed-commit check can no longer match it. `/sprint-reship` doesn't help here (it only works during the LiveQA live-test loop, and this can surface on an already-complete sprint too). Hand-editing `docs/sprints/state/` is forbidden. This command is the documented way back.

`--commit` is the commit that now carries the same work, after whatever rebase relocated it. Before re-pointing, this checks `git patch-id --stable` on both the recorded commit and `--commit` and refuses outright, no override, if they don't match — a mismatch here would turn this into a way to point a completed sprint at arbitrary different content, which is not what this recovers. On a match, `last_shipped_commit` is updated and the equivalence (both commits, the matching patch-id) is recorded in the sprint's history, so a later reader sees it was checked rather than asserted.

No phase restriction — works whether you hit this mid-`liveqa_live` or after the sprint is already complete. It only touches `last_shipped_commit`; it does not re-run or replace `/sprint-liveqa`, `/sprint-ship`'s own tree-content comparison (which stays commit-hash based, unchanged — a real content difference from what QA1 audited still needs a fresh audit, not this command), or anything else that reads the field.
