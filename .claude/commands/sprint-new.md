---
description: "Master Controller: create a new sprint"
allowed-tools: [Bash, Read, Write, Edit]
---

# New Sprint

**CRITICAL**: Use the automation script ONLY. Do not manually create sprint files or edit the registry.

**Security note**: do not paste `$ARGUMENTS` directly into the bash command below. Free text (titles, especially anything copied from a PRD, an error message, or another document) can contain quotes, semicolons, or backticks that break out of the shell string and run unintended commands. Instead:

1. Parse `$ARGUMENTS` yourself to identify the title and, if present, an `--epic` value.
2. Write the title to a temp file with the Write tool, e.g. `/tmp/sprint-title.txt`. Do the same for the epic name if one was given, e.g. `/tmp/sprint-epic.txt`.
3. Run:

```bash
python3 scripts/sprint_lifecycle.py new --title-file /tmp/sprint-title.txt --epic-file /tmp/sprint-epic.txt
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
