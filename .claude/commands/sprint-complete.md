---
description: "Dev Team: close a sprint once both QA gates have passed AND the user explicitly authorizes closing it"
allowed-tools: [Bash, Write]
---

# Complete Sprint

Usage: `/sprint-complete <sprint-id> --user-said "..."`

**Security note**: do not interpolate `$ARGUMENTS` (or any free-text
`--user-said` value) directly into the bash command below, quotes or shell
metacharacters in what the user said can break out and run unintended
commands. Parse the sprint ID yourself (a safe, low-entropy value), write
the `--user-said` text to a temp file with the Write tool, and run:

```bash
python3 scripts/sprint_lifecycle.py complete <sprint-id> --user-said-file /tmp/sprint-complete-user-said.txt
```

This refuses to run unless all three are true:
1. QA1's first audit passed
2. LiveQA's live test passed
3. `--user-said "..."` is given, quoting what the user actually told you, in this session, that authorizes closing this sprint right now

If any is missing, the script tells you which one. Do not close a sprint any other way, "dev work agreed done" is not the same as complete.

**Gates passing is not the same as being authorized to close.** The first two conditions tell you the code is ready; they are not the user's permission to act. Once both gates are green, tell the user the sprint is ready to close and wait, don't run this command on your own initiative just because the gates happen to be green. Only run it when the user explicitly tells you to, right now, in this session, e.g. "close it" or "run sprint-complete" — then quote what they said in `--user-said`. There is no override for a missing `--user-said`, unlike the hash gates elsewhere in this lifecycle: this isn't drift to unstick, it's the one place the human's real-time word is the actual requirement.

Dev Team 1/2 runs this directly, the same session that ran `/sprint-start`, once LiveQA's live test has come back PASS *and* the user has explicitly said to close it. Master Controller does not run this: it only reads status (`/sprint-status`) and stays out of the execution path, having both roles issuing lifecycle commands is what caused duplicate-attempt/"already complete" collisions in practice.

**This command never pushes anything, and neither should you.** Closing a sprint is bookkeeping, it moves a file and updates state, nothing more. If you're running this from Dev Team 1 or Dev Team 2's session (the common case, since that's the session that ran `/sprint-start`), do not also run `git push` or any other git command as a "finishing touch." Pushing to remote is Pipeman's job exclusively, every time, with no exception for sprint close. If code needs to reach remote, commit locally if needed and hand it to Pipeman via `/sprint-ship` or `/sprint-reship`, don't push it yourself just because you happen to be the one closing the sprint out.
