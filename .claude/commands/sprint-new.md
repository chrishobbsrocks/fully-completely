---
description: "Master Controller: create a new sprint"
allowed-tools: [Bash, Read, Write, Edit]
---

# New Sprint

**CRITICAL**: Use the automation script ONLY. Do not manually create sprint files or edit the registry.

Before creating a sprint, check whether this change actually needs one: if it meets every criterion in CLAUDE.md's `## Trivial fix fast lane` (exactly one file, presentational-only diff, no new dependencies, not a data file), skip this command entirely and hand Dev Team a direct instruction instead.

**Security note**: do not paste `$ARGUMENTS` directly into the bash command below. Free text (titles, especially anything copied from a PRD, an error message, or another document) can contain quotes, semicolons, or backticks that break out of the shell string and run unintended commands. Instead:

1. Parse `$ARGUMENTS` yourself to identify the title and, if present, an `--epic` value.
2. Write the title to a temp file with the Write tool, e.g. `sprint-title.txt` (a path inside your working directory, never `/tmp` — `/tmp` doesn't exist on a default Windows box in PowerShell, `C:\tmp` is absent, while a relative path works unchanged there, in Git Bash, and on macOS). Do the same for the epic name if one was given, e.g. `sprint-epic.txt`.

   **Headless note (sprint 14):** if the Write tool is unavailable (a headless Master Controller session under a scoped permission profile never has it — this was the second defect here: the instruction above required Write, and nothing else was offered, so headless Master Controller could not create a sprint at all), write both files with `printf` via Bash instead — `printf '%s\n' "line one" "line two" ... > sprint-title.txt`, single-quoting the format string so the outer shell never touches `\n`. Not a heredoc: `cat <<'EOF' > file` fails under a scoped permission profile.
3. Run:

```bash
node scripts/run-lifecycle.js new --title-file sprint-title.txt --epic-file sprint-epic.txt
```

(Omit `--epic-file` entirely if no epic was given.)

After running this, open the created file and fill in:
- Sprint Objective
- Requirements (numbered, testable)
- Acceptance Criteria (how QA1 will verify each requirement)
- Out of Scope
- Dependencies
- Risks & Mitigations

Do not run `/sprint-start` until those sections are filled in, Dev Team should never receive a sprint with placeholder requirements.
