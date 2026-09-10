---
description: "Return an unbuildable sprint to the planner, without abandoning it"
allowed-tools: [Bash, Write]
---

# Block Sprint

Usage: `/sprint-block <sprint-id> --reason "..."`

**Security note**: do not interpolate `$ARGUMENTS` (or any free-text reason) directly into the bash command below. Write the reason to a temp file with the Write tool, then run:

**Headless note (sprint 14):** if the Write tool is unavailable, write the reason file with `printf` via Bash instead — `printf '%s\n' "line one" "line two" ... > sprint-block-reason.txt`, single-quoting the format string so the outer shell never touches `\n` — then pass the resulting path to `--reason-file` exactly as below. Not a heredoc: `cat <<'EOF' > file` fails under a scoped permission profile. **Always a path inside your working directory, never `/tmp`**: `/tmp` doesn't exist on a default Windows box in PowerShell (`C:\tmp` is absent) — a relative path works unchanged there, in Git Bash, and on macOS.

```bash
node scripts/run-lifecycle.js block <sprint-id> --reason-file sprint-block-reason.txt
```

Sprint 33, Req 4. Use this when you (any role) have correctly determined a sprint isn't currently buildable — real content doesn't exist yet, a required decision hasn't been made — and that determination is not grounds to abandon it. Unlike `/sprint-abort`:

- The sprint id is preserved, never burned.
- The file moves to `docs/sprints/4-blocked/`, never `5-abandoned`.
- Your analysis (`--reason`) is recorded in the sprint's own history, retrievable via `/sprint-status <id> --verbose` — this is what Master Controller reads to repair the file, so state the actual problem, not just "blocked."
- No `--user-said` is required — blocking isn't destructive, so it doesn't carry `/sprint-abort`'s human-authorization gate. `--reason` is still required and non-empty: a sprint may not be blocked without a stated cause.

**Re-filing is free, once Master Controller has repaired the sprint file**: Dev Team runs `/sprint-start <id>` again, exactly as it would for a brand-new sprint. `cmd_start` has no phase guard and always moves whatever the registry currently points at into `2-in-progress/`, so this works unchanged on a blocked sprint.
