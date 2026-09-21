#!/usr/bin/env python3
"""Sprint 41, Req 4b: the reverse of check_user_said_guard.py's own Req 4a
assertion. That guard asserts no code path INVENTS --user-said content;
this one asserts the rule was never satisfied by OMISSION either -- every
sprint close actually recorded in history carries the real thing. Together
they close both directions FMC's own sprint 91 named: a close with no
authorization on record, and a close whose authorization was fabricated by
code rather than typed by a human, are different failures and each needs
its own guard.

cmd_complete (scripts/sprint_lifecycle.py) logs exactly one event per real
close: `log_event(state, "dev-team", "sprint_closed", f"user_said={text}")`
-- refusing to reach that line at all unless `text.strip()` is already
non-empty (its own --user-said is-required check runs first, with no
override). This script re-derives that same guarantee from the recorded
history itself, independent of trusting cmd_complete's own code path never
regresses: read every docs/sprints/state/sprint-*.json in this repository,
find every "sprint_closed" event in its history, and assert the event's
own detail string both has the "user_said=" prefix cmd_complete always
writes and a non-empty value after it.

Verified by negative control (this sprint): a state file with a
"sprint_closed" event carrying an empty user_said, and one carrying no
user_said= prefix at all, each independently made this script exit
non-zero against a scratch copy; every REAL recorded close in this
repository's own docs/sprints/state/ scans clean.
"""
import json
import sys
import pathlib

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
STATE_DIR = REPO_ROOT / "docs" / "sprints" / "state"

USER_SAID_PREFIX = "user_said="


def scan(state_dir: pathlib.Path):
    violations = []
    if not state_dir.exists():
        return violations
    for path in sorted(state_dir.glob("sprint-*.json")):
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            violations.append((path.name, -1, f"could not read/parse state file: {exc}"))
            continue
        for i, event in enumerate(state.get("history", [])):
            if event.get("event") != "sprint_closed":
                continue
            detail = event.get("detail", "")
            if not detail.startswith(USER_SAID_PREFIX):
                violations.append((path.name, i, f"sprint_closed detail missing '{USER_SAID_PREFIX}' prefix: {detail!r}"))
                continue
            said = detail[len(USER_SAID_PREFIX):]
            if not said.strip():
                violations.append((path.name, i, f"sprint_closed recorded with an empty --user-said: {detail!r}"))
    return violations


def main():
    violations = scan(STATE_DIR)
    if violations:
        print("USER_SAID_HISTORY_VIOLATIONS_FOUND")
        for name, idx, reason in violations:
            print(f"  {name} (history[{idx}]): {reason}")
        return 1
    print("USER_SAID_HISTORY_OK: every recorded sprint_closed event carries a non-empty --user-said.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
