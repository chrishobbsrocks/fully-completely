---
description: "Dev Team 2: create the dedicated git worktree for a parallel sprint"
allowed-tools: [Bash]
---

# Dev Team 2 Worktree

Usage: `/sprint-worktree <sprint-id>`

```bash
bash scripts/dev2_worktree.sh <sprint-id>
```

Run this once, before writing any code, whenever Master Controller hands
Dev Team 2 a sprint to run in parallel with Dev Team 1. It creates (or
reuses) a git worktree at `../<repo>-devteam2-sprint-<id>` on branch
`devteam2/sprint-<id>` and prints the path.

`cd` into that path and stay there for the whole sprint. Checking the
sprint file's Dependencies section for file/type overlap is still worth
doing, but it isn't sufficient on its own, "independent" sprints on a small
app routinely still touch shared files (routing, layout, config) even when
the features don't conceptually overlap. A separate worktree is what
actually prevents Dev Team 1 and Dev Team 2 from colliding on
uncommitted work in the same checkout.
