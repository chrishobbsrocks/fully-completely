---
description: "Abandon a sprint at any phase"
allowed-tools: [Bash, Write]
---

# Abort Sprint

Usage: `/sprint-abort <sprint-id> --reason "..."`

**Security note**: do not interpolate `$ARGUMENTS` (or any free-text reason) directly into the bash command below. Write the reason to a temp file with the Write tool, then run:

**Headless note (sprint 14):** if the Write tool is unavailable, write the reason file with `printf` via Bash instead — `printf '%s\n' "line one" "line two" ... > abort-reason.txt`, single-quoting the format string so the outer shell never touches `\n` — then pass the resulting path to `--reason-file` exactly as below. Not a heredoc: `cat <<'EOF' > file` fails under a scoped permission profile. **Always a path inside your working directory, never `/tmp`**: `/tmp` doesn't exist on a default Windows box in PowerShell (`C:\tmp` is absent) — a relative path works unchanged there, in Git Bash, and on macOS.

```bash
node scripts/run-lifecycle.js abort <sprint-id> --reason-file abort-reason.txt
```

Moves the sprint file to `docs/sprints/5-abandoned/` and marks its state as aborted, regardless of what phase it was in.
