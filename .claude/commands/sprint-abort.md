---
description: "Abandon a sprint at any phase, with real human authorization"
allowed-tools: [Bash, Write]
---

# Abort Sprint

Usage: `/sprint-abort <sprint-id> --user-said "..." --reason "..."`

**Security note**: do not interpolate `$ARGUMENTS` (or any free-text `--user-said`/`--reason` value) directly into the bash command below, quotes or shell metacharacters in either can break out and run unintended commands. Parse the sprint ID yourself (a safe, low-entropy value), write both texts to separate temp files with the Write tool, then run:

**Headless note (sprint 14):** if the Write tool is unavailable, write a file with `printf` via Bash instead — `printf '%s\n' "line one" "line two" ... > sprint-abort-user-said.txt`, single-quoting the format string so the outer shell never touches `\n` — then pass the resulting path to `--user-said-file`/`--reason-file` exactly as below. Not a heredoc: `cat <<'EOF' > file` fails under a scoped permission profile. **Always a path inside your working directory, never `/tmp`**: `/tmp` doesn't exist on a default Windows box in PowerShell (`C:\tmp` is absent) — a relative path works unchanged there, in Git Bash, and on macOS.

```bash
node scripts/run-lifecycle.js abort <sprint-id> --user-said-file sprint-abort-user-said.txt --reason-file sprint-abort-reason.txt
```

Moves the sprint file to `docs/sprints/5-abandoned/` and marks its state as aborted, regardless of what phase it was in — this is the lifecycle's most destructive action: it burns the sprint id, and re-filing is a human act.

**Sprint 33: both arguments are required, non-empty, with no override.** Same non-overridable shape as `/sprint-complete`'s own `--user-said`:
- `--user-said` — quote what the user actually told you, in this session, that authorizes abandoning this sprint right now. Both gates or a role's own judgment are not authorization on their own; the human's real-time word is.
- `--reason` — why. A sprint may not be abandoned without a stated cause.

**If a ROLE, not a human, has determined this sprint isn't currently buildable (real content doesn't exist, a required decision is unmade), that is not grounds to abort it yourself.** Use `/sprint-block <sprint-id> --reason "..."` instead — it returns the sprint to the planner with your analysis intact, without destroying the sprint id or moving anything to `5-abandoned`. Abort is for a human's real decision to abandon the sprint entirely, not a role's own determination that it needs repair.
