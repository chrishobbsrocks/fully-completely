#!/usr/bin/env python3
"""
Fully Completely — sprint lifecycle enforcement script.

This is the ONLY thing that should ever create, move, or edit sprint
state. Slash commands in .claude/commands/ call this script; they do
not touch files directly. See CLAUDE.md at the project root for the
full command reference.

Phases (in order, with the two loops):

  dev_build        -> Dev Team 1/2 is building
  qa1_audit        -> QA1 static audit (gate 1). FAIL/CONDITIONAL sends
                       it back to dev_build.
  dev_agreed_done  -> Dev Team has told Master Controller the coding
                       side is done. NOT the same as sprint complete.
  shipped          -> Pipeman has pushed to remote.
  groundtruth_live     -> GroundTruth is live-testing. FAIL/CONDITIONAL means
                       fixes + a reship, then GroundTruth tests again.
  qa1_final        -> QA1's final check (gate 2), only reachable once
                       groundtruth_live has a recorded PASS.
  complete_ready   -> Both gates have passed. Waiting on Master
                       Controller to actually close the sprint.
  complete         -> Closed. Sprint file moved to 3-done/.
  aborted          -> Abandoned. Sprint file moved to 5-abandoned/.
"""

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent
SPRINTS_DIR = ROOT / "docs" / "sprints"
STATE_DIR = SPRINTS_DIR / "state"
REGISTRY_PATH = SPRINTS_DIR / "registry.json"
TEMPLATE_PATH = ROOT / "templates" / "sprint-template.md"

STATUS_FOLDERS = {
    "backlog": "0-backlog",
    "todo": "1-todo",
    "in_progress": "2-in-progress",
    "done": "3-done",
    "blocked": "4-blocked",
    "abandoned": "5-abandoned",
}

VALID_VERDICTS = {"PASS", "FAIL", "CONDITIONAL"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def slugify(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return slug or "untitled"


def atomic_write(path: Path, content: str) -> None:
    """Write content to path atomically: write to a temp file in the same
    directory, then rename over the target. A crash or interrupt mid-write
    leaves the original file untouched instead of a truncated/corrupt one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
        os.replace(tmp_path, path)
    except Exception:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise


def resolve_text(value: Optional[str], file_value: Optional[str]) -> str:
    """Prefer a --*-file value over a raw flag value. Reading free text
    from a file (written by the Write tool) rather than interpolating it
    into a shell command line avoids quote-breakout / injection when a
    slash command builds the invocation from user-supplied text."""
    if file_value:
        return Path(file_value).read_text().strip()
    return value or ""


def yaml_escape(value: str) -> str:
    """Make a string safe to sit inside a double-quoted YAML scalar:
    escape backslashes and quotes, and collapse newlines so a pasted
    multi-line title can't break the frontmatter block."""
    value = value.replace("\\", "\\\\").replace('"', '\\"')
    value = re.sub(r"\s*\n\s*", " ", value)
    return value


def load_registry() -> dict:
    if REGISTRY_PATH.exists():
        return json.loads(REGISTRY_PATH.read_text())
    return {"next_id": 1, "sprints": {}}


def save_registry(reg: dict) -> None:
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(REGISTRY_PATH, json.dumps(reg, indent=2) + "\n")


def state_path(sprint_id: int) -> Path:
    return STATE_DIR / f"sprint-{sprint_id}.json"


def load_state(sprint_id: int) -> dict:
    p = state_path(sprint_id)
    if not p.exists():
        die(f"No state file for sprint {sprint_id}. Run /sprint-start {sprint_id} first.")
    return json.loads(p.read_text())


def save_state(sprint_id: int, state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    atomic_write(state_path(sprint_id), json.dumps(state, indent=2) + "\n")


def die(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def log_event(state: dict, actor: str, event: str, detail: str = "") -> None:
    state.setdefault("history", []).append(
        {"ts": now(), "actor": actor, "event": event, "detail": detail}
    )


def find_sprint_file(sprint_id: int) -> Optional[Path]:
    for folder in STATUS_FOLDERS.values():
        d = SPRINTS_DIR / folder
        if not d.exists():
            continue
        for f in d.glob(f"sprint-{sprint_id}_*.md"):
            return f
    return None


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------

def cmd_new(args) -> None:
    title = Path(args.title_file).read_text().strip() if args.title_file else args.title
    epic = Path(args.epic_file).read_text().strip() if args.epic_file else (args.epic or "")
    if not title:
        die("Sprint title cannot be empty.")

    reg = load_registry()
    sprint_id = reg["next_id"]
    slug = slugify(title)
    folder = SPRINTS_DIR / STATUS_FOLDERS["todo"]
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / f"sprint-{sprint_id}_{slug}.md"

    template = TEMPLATE_PATH.read_text() if TEMPLATE_PATH.exists() else (
        "# Master Controller Sprint Definition — Sprint {id}\n\n"
        "**Epic:** {epic}\n**Sprint Objective:** \n\n"
        "### Context\n\n### Requirements\n\n### Acceptance Criteria\n\n"
        "### Out of Scope\n\n### Dependencies\n\n### Risks & Mitigations\n"
    )
    content = template.format(id=sprint_id, epic=epic or "(none)")
    frontmatter = (
        "---\n"
        f"id: {sprint_id}\n"
        f"title: \"{yaml_escape(title)}\"\n"
        f"epic: \"{yaml_escape(epic)}\"\n"
        "status: todo\n"
        f"created: {now()}\n"
        "---\n\n"
    )
    atomic_write(dest, frontmatter + content)

    reg["next_id"] = sprint_id + 1
    reg["sprints"][str(sprint_id)] = {
        "title": title,
        "epic": epic,
        "status": "todo",
        "file": str(dest.relative_to(ROOT)),
    }
    save_registry(reg)
    print(f"Created sprint {sprint_id}: {dest.relative_to(ROOT)}")
    print("Master Controller: fill in Requirements, Acceptance Criteria, and "
          "Out of Scope in that file before running /sprint-start.")


def cmd_start(args) -> None:
    sprint_id = args.id
    reg = load_registry()
    entry = reg["sprints"].get(str(sprint_id))
    if not entry:
        die(f"Sprint {sprint_id} not found in registry.")

    src = ROOT / entry["file"]
    dest_dir = SPRINTS_DIR / STATUS_FOLDERS["in_progress"]
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / src.name
    if src.exists() and src != dest:
        shutil.move(str(src), str(dest))
        entry["file"] = str(dest.relative_to(ROOT))

    entry["status"] = "in_progress"
    save_registry(reg)

    state = {
        "id": sprint_id,
        "title": entry["title"],
        "phase": "dev_build",
        "qa1_audit_result": None,
        "groundtruth_result": None,
        "qa1_final_result": None,
        "audit_rounds": 0,
        "live_test_rounds": 0,
        "started": now(),
        "completed": None,
        "history": [],
    }
    log_event(state, "system", "sprint_started")
    save_state(sprint_id, state)
    print(f"Sprint {sprint_id} started. Phase: dev_build.")
    print("Dev Team: build the sprint, then run /sprint-qa1 when ready for audit.")


def cmd_status(args) -> None:
    if args.id is None:
        reg = load_registry()
        if not reg["sprints"]:
            print("No sprints yet. Use /sprint-new to create one.")
            return
        for sid, entry in sorted(reg["sprints"].items(), key=lambda kv: int(kv[0])):
            print(f"Sprint {sid}: {entry['title']} — {entry['status']}")
        return

    state = load_state(args.id)
    print(f"Sprint {state['id']}: {state['title']}")
    print(f"Phase: {state['phase']}")
    print(f"QA1 audit result: {state['qa1_audit_result']} (rounds: {state['audit_rounds']})")
    print(f"GroundTruth live result: {state['groundtruth_result']} (rounds: {state['live_test_rounds']})")
    print(f"QA1 final result: {state['qa1_final_result']}")
    if args.verbose:
        print("\nHistory:")
        for h in state["history"]:
            print(f"  [{h['ts']}] {h['actor']}: {h['event']} {h['detail']}")


def cmd_qa1(args) -> None:
    state = load_state(args.id)
    if state["phase"] not in ("dev_build", "qa1_audit"):
        die(f"Sprint {args.id} is in phase '{state['phase']}', not ready for QA1's first audit.")
    verdict = args.verdict.upper()
    if verdict not in VALID_VERDICTS:
        die(f"Verdict must be one of {sorted(VALID_VERDICTS)}.")

    notes = resolve_text(args.notes, args.notes_file)
    state["qa1_audit_result"] = verdict
    state["audit_rounds"] += 1
    log_event(state, "qa1", "audit", f"{verdict}: {notes}")

    if verdict == "PASS":
        state["phase"] = "qa1_audit"
        print(f"QA1 audit PASSED (round {state['audit_rounds']}).")
        print("Dev Team: run /sprint-dev-done when ready to tell Master Controller "
              "the coding side is agreed done. This does NOT mark the sprint complete.")
    else:
        state["phase"] = "dev_build"
        print(f"QA1 audit {verdict} (round {state['audit_rounds']}). Back to Dev Team for fixes.")

    save_state(args.id, state)


def cmd_dev_done(args) -> None:
    state = load_state(args.id)
    if state["phase"] != "qa1_audit" or state["qa1_audit_result"] != "PASS":
        die(f"Sprint {args.id} needs a QA1 PASS on the first audit before dev work can be "
            f"marked agreed-done. Current phase: {state['phase']}, "
            f"QA1 result: {state['qa1_audit_result']}.")
    state["phase"] = "dev_agreed_done"
    log_event(state, "dev-team", "dev_agreed_done")
    save_state(args.id, state)
    print(f"Sprint {args.id}: dev work agreed done (not yet complete).")
    print("Pipeman: run /sprint-ship when ready to push to remote.")


def cmd_ship(args) -> None:
    state = load_state(args.id)
    if state["phase"] != "dev_agreed_done":
        die(f"Sprint {args.id} is in phase '{state['phase']}', Pipeman can't ship yet, "
            "dev work must be agreed done first.")
    state["phase"] = "groundtruth_live"
    log_event(state, "pipeman", "shipped", f"commit={args.commit or ''}")
    save_state(args.id, state)
    print(f"Sprint {args.id}: shipped (commit {args.commit or '?'}). Phase: groundtruth_live.")
    print("GroundTruth: run /sprint-groundtruth once you've live-tested the deploy.")


def cmd_reship(args) -> None:
    state = load_state(args.id)
    if state["phase"] != "groundtruth_live":
        die(f"Sprint {args.id} is in phase '{state['phase']}', reship only applies during "
            "the GroundTruth live-test fix loop.")
    log_event(state, "pipeman", "reshipped", f"commit={args.commit or ''}")
    save_state(args.id, state)
    print(f"Sprint {args.id}: fix reshipped (commit {args.commit or '?'}). "
          "GroundTruth: re-test and run /sprint-groundtruth again.")


def cmd_groundtruth(args) -> None:
    state = load_state(args.id)
    if state["phase"] != "groundtruth_live":
        die(f"Sprint {args.id} is in phase '{state['phase']}', not ready for a GroundTruth live test.")
    verdict = args.verdict.upper()
    if verdict not in VALID_VERDICTS:
        die(f"Verdict must be one of {sorted(VALID_VERDICTS)}.")

    notes = resolve_text(args.notes, args.notes_file)
    state["groundtruth_result"] = verdict
    state["live_test_rounds"] += 1
    log_event(state, "groundtruth", "live_test", f"{verdict}: {notes}")

    if verdict == "PASS":
        print(f"GroundTruth live test PASSED (round {state['live_test_rounds']}).")
        print("QA1: run /sprint-qa1-final for the second gate.")
    else:
        print(f"GroundTruth live test {verdict} (round {state['live_test_rounds']}). "
              "Dev Team: fix, then Pipeman: /sprint-reship.")

    save_state(args.id, state)


def cmd_qa1_final(args) -> None:
    state = load_state(args.id)
    if state["phase"] != "groundtruth_live" or state["groundtruth_result"] != "PASS":
        die(f"Sprint {args.id} needs a GroundTruth PASS before QA1's final check. "
            f"Current phase: {state['phase']}, GroundTruth result: {state['groundtruth_result']}.")
    verdict = args.verdict.upper()
    if verdict not in {"PASS", "FAIL"}:
        die("Final verdict must be PASS or FAIL.")

    notes = resolve_text(args.notes, args.notes_file)
    state["qa1_final_result"] = verdict
    log_event(state, "qa1", "final_check", f"{verdict}: {notes}")

    if verdict == "PASS":
        state["phase"] = "complete_ready"
        print(f"QA1 final check PASSED. Sprint {args.id} is complete-ready.")
        print("Master Controller: run /sprint-complete to close it out.")
    else:
        state["phase"] = "dev_build"
        state["qa1_audit_result"] = None
        state["groundtruth_result"] = None
        print(f"QA1 final check FAILED. Sprint {args.id} sent back to dev_build, "
              "both gates will need to be re-earned.")

    save_state(args.id, state)


def cmd_complete(args) -> None:
    state = load_state(args.id)
    missing = []
    if state["qa1_audit_result"] != "PASS":
        missing.append("QA1 first audit has not passed")
    if state["groundtruth_result"] != "PASS":
        missing.append("GroundTruth live test has not passed")
    if state["qa1_final_result"] != "PASS":
        missing.append("QA1 final check has not passed")
    if state["phase"] != "complete_ready" or missing:
        die("Sprint is not ready to close:\n  - " + "\n  - ".join(missing or [f"phase is '{state['phase']}'"]))

    reg = load_registry()
    entry = reg["sprints"][str(args.id)]
    src = ROOT / entry["file"]
    dest_dir = SPRINTS_DIR / STATUS_FOLDERS["done"]
    dest_dir.mkdir(parents=True, exist_ok=True)
    if src.exists():
        new_name = src.stem + "--done" + src.suffix
        dest = dest_dir / new_name
        shutil.move(str(src), str(dest))
        entry["file"] = str(dest.relative_to(ROOT))
    entry["status"] = "done"
    save_registry(reg)

    state["phase"] = "complete"
    state["completed"] = now()
    log_event(state, "master-controller", "sprint_closed")
    save_state(args.id, state)
    print(f"Sprint {args.id} closed. Both gates confirmed: QA1 audit, GroundTruth live test, QA1 final.")


def cmd_abort(args) -> None:
    reg = load_registry()
    entry = reg["sprints"].get(str(args.id))
    if entry:
        src = ROOT / entry["file"]
        dest_dir = SPRINTS_DIR / STATUS_FOLDERS["abandoned"]
        dest_dir.mkdir(parents=True, exist_ok=True)
        if src.exists():
            dest = dest_dir / src.name
            shutil.move(str(src), str(dest))
            entry["file"] = str(dest.relative_to(ROOT))
        entry["status"] = "abandoned"
        save_registry(reg)

    reason = resolve_text(args.reason, args.reason_file)
    if state_path(args.id).exists():
        state = load_state(args.id)
        state["phase"] = "aborted"
        log_event(state, "human", "aborted", reason)
        save_state(args.id, state)
    print(f"Sprint {args.id} aborted. Reason: {reason or '(none given)'}")


def cmd_list(args) -> None:
    reg = load_registry()
    if not reg["sprints"]:
        print("No sprints yet.")
        return
    for sid, entry in sorted(reg["sprints"].items(), key=lambda kv: int(kv[0])):
        print(f"{sid:>3}  {entry['status']:<12} {entry['title']}")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="sprint_lifecycle.py")
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("new")
    s.add_argument("title", nargs="?", default=None,
                    help="Sprint title. Prefer --title-file for text pasted from elsewhere.")
    s.add_argument("--title-file", help="Read the title from this file instead of the command line.")
    s.add_argument("--epic")
    s.add_argument("--epic-file", help="Read the epic name from this file instead of the command line.")
    s.set_defaults(func=cmd_new)

    s = sub.add_parser("start"); s.add_argument("id", type=int); s.set_defaults(func=cmd_start)

    s = sub.add_parser("status"); s.add_argument("id", type=int, nargs="?"); s.add_argument("--verbose", action="store_true"); s.set_defaults(func=cmd_status)

    s = sub.add_parser("qa1")
    s.add_argument("id", type=int); s.add_argument("--verdict", required=True)
    s.add_argument("--notes", default="")
    s.add_argument("--notes-file", help="Read notes from this file instead of the command line.")
    s.set_defaults(func=cmd_qa1)

    s = sub.add_parser("dev-done"); s.add_argument("id", type=int); s.set_defaults(func=cmd_dev_done)

    s = sub.add_parser("ship"); s.add_argument("id", type=int); s.add_argument("--commit", default=""); s.set_defaults(func=cmd_ship)

    s = sub.add_parser("reship"); s.add_argument("id", type=int); s.add_argument("--commit", default=""); s.set_defaults(func=cmd_reship)

    s = sub.add_parser("groundtruth")
    s.add_argument("id", type=int); s.add_argument("--verdict", required=True)
    s.add_argument("--notes", default="")
    s.add_argument("--notes-file", help="Read notes from this file instead of the command line.")
    s.set_defaults(func=cmd_groundtruth)

    s = sub.add_parser("qa1-final")
    s.add_argument("id", type=int); s.add_argument("--verdict", required=True)
    s.add_argument("--notes", default="")
    s.add_argument("--notes-file", help="Read notes from this file instead of the command line.")
    s.set_defaults(func=cmd_qa1_final)

    s = sub.add_parser("complete"); s.add_argument("id", type=int); s.set_defaults(func=cmd_complete)

    s = sub.add_parser("abort")
    s.add_argument("id", type=int)
    s.add_argument("--reason", default="")
    s.add_argument("--reason-file", help="Read the reason from this file instead of the command line.")
    s.set_defaults(func=cmd_abort)

    s = sub.add_parser("list"); s.set_defaults(func=cmd_list)

    return p


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
