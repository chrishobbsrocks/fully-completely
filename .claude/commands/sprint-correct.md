---
description: "Append an append-only correction to your own recorded notes, without changing a verdict, gate, or phase"
allowed-tools: [Bash, Write]
---

# Correct Recorded Notes

Usage: `/sprint-correct <sprint-id> --event-index <N> --correction "..."`

**Security note**: do not interpolate `$ARGUMENTS` (or any free-text correction) directly into the bash command below — quotes, backticks, or `$` in what you write can break out and run unintended commands, or get command-substituted out of the record (this has happened once already, to a `--notes` argument). Write the correction to a temp file with the Write tool, then run:

**Headless note (sprint 14):** if the Write tool is unavailable, write the correction with `printf` via Bash instead — `printf '%s\n' "line one" "line two" ... > sprint-correction.txt`, single-quoting the format string so the outer shell never touches `\n` — then pass the resulting path to `--correction-file` exactly as below. Not a heredoc: `cat <<'EOF' > file` fails under a scoped permission profile. **Always a path inside your working directory, never `/tmp`**: `/tmp` doesn't exist on a default Windows box in PowerShell (`C:\tmp` is absent) — a relative path works unchanged there, in Git Bash, and on macOS.

```bash
node scripts/run-lifecycle.js correct <sprint-id> --event-index <N> --correction-file sprint-correction.txt
```

Sprint 40, Req 1. Use this when you find a factual error in your OWN recorded notes — not the verdict itself, the evidence text supporting it (FMC's own finding: LiveQA recorded a sound verdict whose notes claimed a check had silently failed and named the wrong branch; the verdict was right, the notes were wrong, and there was no route to say so that a later reader of the original record would ever see).

**This is append-only and never a verdict change.** The original event, its notes, every gate-result field, both audit hashes, `last_shipped_commit`, round counts, and the sprint's phase are all left exactly as they were — the only mutation is one new history event, appended. No phase restriction: it works on a `complete` sprint just as well as an in-progress one, because a correction to the historical record has to remain possible after the sprint closes.

**If you believe the VERDICT itself is wrong, not just its evidence, this is the wrong command.** Re-run the actual gate instead — `/sprint-qa1` or `/sprint-liveqa` — which is what actually changes what's on record. A correction here never does that, by design; using it to walk back a verdict without re-running the gate is exactly the back door Req 1a exists to close.

**Only the role that recorded the event may correct it.** `--event-index <N>` is the 0-based position of the event in this sprint's history, exactly as `/sprint-status <sprint-id> --verbose` prints it — read that first to find the right index. The command compares your `CLAUDE_CODE_AGENT` against the actor on that event and refuses on any mismatch, naming both — a disagreement with another role's own evidence is a fresh gate run, not something you correct on their behalf. It also refuses outright if `CLAUDE_CODE_AGENT` isn't set at all: an unattributable correction is worse than none.

The correction is recorded attached to the event it corrects — `/sprint-status <sprint-id> --verbose` shows it immediately after that event, and the plain (non-verbose) summary shows that a correction exists even without `--verbose`, so nobody reads the original evidence without also seeing it was corrected.

Every run prints a line like `[sprint_lifecycle] repo=... script=...` to stderr. Check that the `script=` path actually points into this repo's `scripts/sprint_lifecycle.py` before trusting the output — a same-named script elsewhere on disk, or a stale global slash command, will look plausible but resolve to something else entirely.
