---
description: "QA1: record the static code audit verdict (gate 1)"
allowed-tools: [Bash, Write]
---

# QA1 Audit

Usage: `/sprint-qa1 <sprint-id> --verdict PASS|FAIL|CONDITIONAL --notes "..."`

**Security note**: do not interpolate `$ARGUMENTS` (or any free-text notes) directly into the bash command below, quotes or shell metacharacters in the notes can break out and run unintended commands. Parse the sprint ID and verdict yourself (these are safe, low-entropy values), write the notes text to a temp file with the Write tool, and run:

**Headless note (sprint 12):** if the Write tool is unavailable (a headless QA1 session under sprint 12's scoped permission profile never has it), write the notes file with `printf` via Bash instead — `printf '%s\n' "line one" "line two" ... > /tmp/qa1-notes.txt`, single-quoting the format string so the outer shell never touches `\n` — the identical protection, then pass the resulting path to `--notes-file` exactly as below. **Not a heredoc**: `cat <<'EOF' > file` was tried first and confirmed to fail under this profile with `Contains shell syntax (file_redirect) that cannot be statically analyzed`, regardless of location.

```bash
node scripts/run-lifecycle.js qa1 <sprint-id> --verdict <verdict> --notes-file /tmp/qa1-notes.txt
```

A PASS moves the sprint to the point where Dev Team can run `/sprint-dev-done`, and records a hash of the sprint file as audited. If the sprint file changes after this (a mid-build requirements amendment), `/sprint-dev-done` will refuse until you run this again against the current file, no override exists for that. A FAIL or CONDITIONAL sends it back to `dev_build` for fixes, run this command again once they're addressed.
