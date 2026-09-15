---
description: "QA1: record the static code audit verdict (gate 1)"
allowed-tools: [Bash, Write]
---

# QA1 Audit

Usage: `/sprint-qa1 <sprint-id> --verdict PASS|FAIL|CONDITIONAL --notes "..."`

**Security note**: do not interpolate `$ARGUMENTS` (or any free-text notes) directly into the bash command below, quotes or shell metacharacters in the notes can break out and run unintended commands. Parse the sprint ID and verdict yourself (these are safe, low-entropy values), write the notes text to a temp file with the Write tool, and run:

**Headless note (sprint 12):** if the Write tool is unavailable (a headless QA1 session under sprint 12's scoped permission profile never has it), write the notes file with `printf` via Bash instead — `printf '%s\n' "line one" "line two" ... > qa1-notes.txt`, single-quoting the format string so the outer shell never touches `\n` — the identical protection, then pass the resulting path to `--notes-file` exactly as below. **Not a heredoc**: `cat <<'EOF' > file` was tried first and confirmed to fail under this profile with `Contains shell syntax (file_redirect) that cannot be statically analyzed`, regardless of location. **Use a path inside your working directory, never `/tmp`**: `run-role.js`'s own scoped profile blocks a write outside it — LiveQA caught a live instance of this file pointing the example at `/tmp` and getting denied on first use.

```bash
node scripts/run-lifecycle.js qa1 <sprint-id> --verdict <verdict> --notes-file qa1-notes.txt
```

A PASS moves the sprint to the point where Dev Team can run `/sprint-dev-done`, and records a hash of the sprint file as audited. If the sprint file changes after this (a mid-build requirements amendment), `/sprint-dev-done` will refuse until you run this again against the current file, no override exists for that. A FAIL or CONDITIONAL sends it back to `dev_build` for fixes, run this command again once they're addressed.

**While a sprint sits in the LiveQA fix loop (or at `complete_ready`), this command instead records a live-loop audit** — a verdict against one specific commit, added via `--commit <hash>` (`node scripts/run-lifecycle.js qa1 <sprint-id> --verdict <verdict> --commit <hash> --notes-file qa1-notes.txt`). It never touches phase, `qa1_audit_result`, or either gate-1 hash — it is a record, not gate 1 re-running. It IS, as of sprint 36 Req 3, what `/sprint-reship` checks: a reshipped commit's exact tree needs a QA1 PASS on record (this live-loop mechanism, or gate 1's own still-standing one) or reship refuses. Always pass `--commit` here for a real fix — an audit with no commit isn't tied to anything reship can check against.
