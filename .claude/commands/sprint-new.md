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

   **Headless note (sprint 14, corrected round 2 after QA1 caught the round-1 version reasoning instead of running):** this framework's own default headless profile does NOT disable Write for Master Controller — only qa1 and liveqa lose it (see `HEADLESS_PERMISSION_PROFILES` in `scripts/launcher/run-role.js`). Confirmed by actually running a real headless Master Controller session through this exact command: it used the Write tool itself, unprompted, and created a sprint successfully. The round-1 version of this note claimed the opposite and was wrong — caught by QA1, not by running it first, which is the mistake this correction is fixing. What the original defect actually was: the old instruction wrote to an absolute path (`/tmp/sprint-title.txt`), and per sprint 12's own confirmed finding (`docs/sprint-12-permission-scope-findings.md`), `acceptEdits`'s auto-approval is confined to the launch working directory — a write outside it is blocked there too, on top of `/tmp` simply not existing on a default Windows box. The relative path above already fixes both, and needs no fallback on this framework's own default profile. If Write is genuinely unavailable for some other reason — a stricter or differently-scoped profile than this one — the same `printf` fallback qa1.md/liveqa.md use works here too: `printf '%s\n' "line one" "line two" ... > sprint-title.txt`, single-quoting the format string so the outer shell never touches `\n` (confirmed byte-identical to the Write-tool version, diffed in the same real test). Not a heredoc: `cat <<'EOF' > file` was tried directly under Master Controller's own scoped profile and rejected — `Contains shell syntax (file_redirect) that cannot be statically analyzed`, the identical denial qa1/liveqa hit, confirmed here rather than assumed to carry over.
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
