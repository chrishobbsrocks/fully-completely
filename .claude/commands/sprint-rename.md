---
description: "Rename a sprint whose scope legitimately narrowed"
allowed-tools: [Bash, Write]
---

# Rename Sprint

Usage: `/sprint-rename <sprint-id> --title "..."`

**Security note**: do not interpolate `$ARGUMENTS` (or any free-text title) directly into the bash command below. Write the title to a temp file with the Write tool, then run:

**Headless note (sprint 14):** if the Write tool is unavailable, write the title file with `printf` via Bash instead — `printf '%s\n' "line one" "line two" ... > rename-title.txt`, single-quoting the format string so the outer shell never touches `\n` — then pass the resulting path to `--title-file` exactly as below. Not a heredoc: `cat <<'EOF' > file` fails under a scoped permission profile. **Always a path inside your working directory, never `/tmp`**: `/tmp` doesn't exist on a default Windows box in PowerShell (`C:\tmp` is absent) — a relative path works unchanged there, in Git Bash, and on macOS.

```bash
node scripts/run-lifecycle.js rename <sprint-id> --title-file rename-title.txt
```

Updates the registry entry, the sprint file's own frontmatter, and the filename together — the three things hand-editing the registry (forbidden, see CLAUDE.md) would otherwise have to keep in sync by hand. Preserves the original title (a new `original_title` field, set once, on the first rename) — a sprint that narrowed legitimately shows what it was and what it became, not just the latest name.

Never changes phase, verdicts, hashes, or history. Master Controller (or whoever's directing the work) runs this when a sprint's scope has genuinely narrowed and its title no longer describes it — sprint 18's own title, left stale after its first requirement was absorbed elsewhere, is the motivating instance.

**One real consequence, worth knowing before you run this on a sprint QA1 has already passed:** the rename edits the sprint file itself (the title line, plus the new `original_title` line), so if this sprint already has a recorded QA1 PASS, the next `/sprint-dev-done` will correctly refuse and ask for a fresh `/sprint-qa1` look — the same as any other edit to an already-audited file. This is intended, not a bug: a rename is a real change to the exact file QA1 read, and the mechanism can't tell "cosmetic title change" from "the requirements changed" without a human looking again.
