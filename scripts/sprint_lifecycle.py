#!/usr/bin/env python3
"""
Fully Completely — sprint lifecycle enforcement script.

This is the ONLY thing that should ever create, move, or edit sprint
state. Slash commands in .claude/commands/ call this script; they do
not touch files directly. See CLAUDE.md at the project root for the
full command reference.

Phases (in order, with the loops):

  dev_build        -> Dev Team 1/2 is building
  qa1_audit        -> QA1 static audit (gate 1). FAIL/CONDITIONAL sends
                       it back to dev_build. QA1 re-reads the sprint file
                       fresh immediately before recording this verdict, so
                       a mid-build requirements amendment doesn't slip
                       through on a stale read. A PASS also records a hash
                       of the sprint file as audited; dev-done mechanically
                       refuses (no override) if the file has changed since,
                       rather than relying only on QA1 remembering to
                       re-read. See dev_agreed_done below.
  dev_agreed_done  -> Dev Team has told Master Controller the coding
                       side is done. NOT the same as sprint complete.
  shipped          -> Pipeman has pushed to remote. The same PASS that
                       records the sprint-file hash also records the
                       audited commit's tree hash (content, not the SHA,
                       so a legitimate rebase/squash/merge before push
                       doesn't trip this); ship refuses, no override, if
                       the commit it's pushing doesn't match.
  groundtruth_live -> GroundTruth is live-testing. FAIL/CONDITIONAL means
                       fixes + a reship, then GroundTruth tests again.
                       A recorded PASS here moves straight to
                       complete_ready — there used to be a QA1 "final
                       check" gate here (gate 2), but across ~13 real
                       sprints it never once caught anything gate 1 +
                       GroundTruth's live test hadn't already caught, so
                       it was removed. The one real value it had — a
                       fresh look after mid-build requirement changes —
                       is now QA1's responsibility at gate 1 (see above).
  complete_ready   -> Both gates (QA1 audit + GroundTruth live test) have
                       passed. Waiting for /sprint-complete to actually
                       close the sprint.
  complete         -> Closed. Sprint file moved to 3-done/.
  aborted          -> Abandoned. Sprint file moved to 5-abandoned/.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess  # nosec B404
import sys
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

try:
    import fcntl  # POSIX only (macOS, Linux)
    HAVE_FCNTL = True
except ImportError:
    HAVE_FCNTL = False
    import msvcrt  # Windows only

ROOT = Path(__file__).resolve().parent.parent
SPRINTS_DIR = ROOT / "docs" / "sprints"
STATE_DIR = SPRINTS_DIR / "state"
REGISTRY_PATH = SPRINTS_DIR / "registry.json"
TEMPLATE_PATH = ROOT / "templates" / "sprint-template.md"
LOCK_DIR = SPRINTS_DIR / ".locks"

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


LOCK_TIMEOUT_SECONDS = 30


@contextmanager
def locked(name: str):
    """Hold an exclusive OS file lock for the duration of the with-block.
    Every command's read-modify-write span (load_state/load_registry,
    mutate, save_state/save_registry) must run inside this, otherwise two
    invocations racing against the same sprint (or the registry's next_id
    counter) can interleave and silently lose one side's update, the last
    save wins and the other simply vanishes. Always acquire "registry"
    before any "sprint-<id>" lock (the convention every command below
    follows) so two locks are never taken in conflicting orders.

    Cross-platform: fcntl.flock on macOS/Linux (a real blocking exclusive
    lock), msvcrt.locking on Windows (no blocking mode, so this polls a
    non-blocking lock attempt instead, bounded by LOCK_TIMEOUT_SECONDS so
    a wedged process can't hang every future invocation forever)."""
    LOCK_DIR.mkdir(parents=True, exist_ok=True)
    lock_path = LOCK_DIR / f"{name}.lock"
    fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR)
    try:
        if HAVE_FCNTL:
            fcntl.flock(fd, fcntl.LOCK_EX)
        else:
            if os.fstat(fd).st_size < 1:
                os.write(fd, b"\0")  # msvcrt locks a byte range; needs >=1 byte to exist
                os.lseek(fd, 0, os.SEEK_SET)
            deadline = time.monotonic() + LOCK_TIMEOUT_SECONDS
            while True:
                try:
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        os.close(fd)
                        die(f"Timed out waiting {LOCK_TIMEOUT_SECONDS}s for the '{name}' lock, "
                            "another sprint_lifecycle.py invocation may be stuck.")
                    time.sleep(0.1)
        yield
    finally:
        if HAVE_FCNTL:
            fcntl.flock(fd, fcntl.LOCK_UN)
        else:
            try:
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
        os.close(fd)


def git_tree_hash(ref: str) -> Optional[str]:
    """Resolve a git ref (branch, tag, commit hash, HEAD) to its tree hash,
    the content-addressed hash of the files at that commit, independent of
    commit metadata or history. Used to compare what QA1 audited against
    what actually ships, in a way that tolerates Pipeman's legitimate
    squash/rebase/merge (those change the commit SHA without changing any
    file content, so the tree hash stays the same) while still catching
    real content drift, new changes landed after the audit. Returns None
    if the ref doesn't resolve (not a git repo, bad ref, etc.)."""
    try:
        # Fixed argument list, no shell=True, nothing concatenated into a
        # shell string; "git" resolved via PATH is the same trust model
        # every other tool in this repo already uses.
        result = subprocess.run(  # nosec B603 B607
            ["git", "rev-parse", f"{ref}^{{tree}}"],
            cwd=ROOT, capture_output=True, text=True, check=True,
        )
        return result.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return None


def file_hash(path: Path) -> Optional[str]:
    if not path.exists():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def registry_sprint_file(sprint_id: int) -> Optional[Path]:
    reg = load_registry()
    entry = reg["sprints"].get(str(sprint_id))
    if not entry:
        return None
    return ROOT / entry["file"]


def find_sprint_file(sprint_id: int) -> Optional[Path]:
    for folder in STATUS_FOLDERS.values():
        d = SPRINTS_DIR / folder
        if not d.exists():
            continue
        for f in d.glob(f"sprint-{sprint_id}_*.md"):
            return f
    return None


def update_frontmatter_status(path: Path, new_status: str) -> None:
    """Rewrite the `status:` line in a sprint file's YAML frontmatter so the
    file itself agrees with registry.json instead of only the registry
    being updated. Every command that moves a sprint file between status
    folders must call this on the file's new path."""
    if not path.exists():
        return
    text = path.read_text()
    updated, count = re.subn(
        r"(?m)^status:\s*\S+\s*$", f"status: {new_status}", text, count=1
    )
    if count == 0:
        return
    atomic_write(path, updated)


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------

def cmd_new(args) -> None:
    title = Path(args.title_file).read_text().strip() if args.title_file else args.title
    epic = Path(args.epic_file).read_text().strip() if args.epic_file else (args.epic or "")
    if not title:
        die("Sprint title cannot be empty.")

    with locked("registry"):
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
        # Targeted substitution, not str.format(): a custom template can
        # legitimately contain literal { } (a JSON/CSS example block), and
        # .format() would raise on those instead of leaving them alone.
        content = template.replace("{id}", str(sprint_id)).replace("{epic}", epic or "(none)")
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
    with locked("registry"), locked(f"sprint-{sprint_id}"):
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
        update_frontmatter_status(dest, "in_progress")

        entry["status"] = "in_progress"
        save_registry(reg)

        state = {
            "id": sprint_id,
            "title": entry["title"],
            "phase": "dev_build",
            "qa1_audit_result": None,
            "qa1_audit_file_hash": None,
            "qa1_audited_tree_hash": None,
            "groundtruth_result": None,
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
    if args.verbose:
        print("\nHistory:")
        for h in state["history"]:
            print(f"  [{h['ts']}] {h['actor']}: {h['event']} {h['detail']}")


def cmd_qa1(args) -> None:
    with locked(f"sprint-{args.id}"):
        state = load_state(args.id)
        # dev_agreed_done is included so a sprint can get a fresh audit
        # after dev-done already succeeded once, this is the recovery path
        # ship's tree-hash check sends people to when a new, unaudited
        # commit lands after dev-done. Without it that check's own error
        # message ("run /sprint-qa1 again") would be a dead end.
        if state["phase"] not in ("dev_build", "qa1_audit", "dev_agreed_done"):
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
            state["qa1_audit_file_hash"] = file_hash(registry_sprint_file(args.id))
            state["qa1_audited_tree_hash"] = git_tree_hash("HEAD")
            print(f"QA1 audit PASSED (round {state['audit_rounds']}).")
            print("Dev Team: run /sprint-dev-done when ready to tell Master Controller "
                  "the coding side is agreed done. This does NOT mark the sprint complete.")
        else:
            state["phase"] = "dev_build"
            state["qa1_audit_file_hash"] = None
            state["qa1_audited_tree_hash"] = None
            print(f"QA1 audit {verdict} (round {state['audit_rounds']}). Back to Dev Team for fixes.")

        save_state(args.id, state)


def cmd_dev_done(args) -> None:
    with locked(f"sprint-{args.id}"):
        state = load_state(args.id)
        if state["phase"] != "qa1_audit" or state["qa1_audit_result"] != "PASS":
            die(f"Sprint {args.id} needs a QA1 PASS on the first audit before dev work can be "
                f"marked agreed-done. Current phase: {state['phase']}, "
                f"QA1 result: {state['qa1_audit_result']}.")

        current_hash = file_hash(registry_sprint_file(args.id))
        audited_hash = state.get("qa1_audit_file_hash")
        if audited_hash is None:
            # Same distinction as cmd_ship's tree-hash check: a sprint that
            # PASSed under a version of this script from before the hash
            # field existed has nothing recorded to verify against, "has
            # changed" would misleadingly imply a real, detected drift.
            die(f"Sprint {args.id} has no QA1-audited sprint-file hash on record to check "
                "against (this sprint predates the stale-file check). Run /sprint-qa1 now "
                "so there's something real to check dev-done against. No override.")
        if current_hash != audited_hash:
            die(f"Sprint {args.id}'s sprint file has changed since QA1's PASS "
                f"(round {state['audit_rounds']}), requirements may have been amended after "
                "the audit. Run /sprint-qa1 again against the current file before marking dev "
                "work done. No override, re-audit is the only path past this.")

        state["phase"] = "dev_agreed_done"
        log_event(state, "dev-team", "dev_agreed_done")
        save_state(args.id, state)
    print(f"Sprint {args.id}: dev work agreed done (not yet complete).")
    print("Pipeman: run /sprint-ship when ready to push to remote.")


def cmd_ship(args) -> None:
    with locked(f"sprint-{args.id}"):
        state = load_state(args.id)
        if state["phase"] != "dev_agreed_done":
            die(f"Sprint {args.id} is in phase '{state['phase']}', Pipeman can't ship yet, "
                "dev work must be agreed done first.")

        shipped_tree = git_tree_hash(args.commit) if args.commit else None
        audited_tree = state.get("qa1_audited_tree_hash")
        if shipped_tree is None:
            die(f"'{args.commit or ''}' does not resolve to a real commit in this repo. "
                "--commit must be an actual commit hash Pipeman is about to push.")
        if audited_tree is None:
            # Distinct from a real mismatch below: this fires either for a
            # sprint that reached dev_agreed_done before this check existed
            # (an older state file has no qa1_audited_tree_hash key at all)
            # or one where QA1 never actually PASSed. Either way nothing
            # was recorded to verify against, so "doesn't match" would be
            # a misleading thing to tell Pipeman here.
            die(f"Sprint {args.id} has no QA1-audited commit on record to verify this "
                "ship against (either QA1 hasn't PASSed yet, or this sprint predates the "
                "commit-content check). Run /sprint-qa1 now so there's something real to "
                "check the ship against. No override.")
        if shipped_tree != audited_tree:
            die(f"Sprint {args.id}: the commit being shipped doesn't match what QA1 audited "
                "(its file contents differ, even accounting for a rebase/squash/merge that "
                "preserves content). New changes landed after QA1's PASS need a fresh "
                "/sprint-qa1 audit before they can ship. No override.")

        state["phase"] = "groundtruth_live"
        log_event(state, "pipeman", "shipped", f"commit={args.commit or ''}")
        save_state(args.id, state)
    print(f"Sprint {args.id}: shipped (commit {args.commit or '?'}). Phase: groundtruth_live.")
    print("GroundTruth: run /sprint-groundtruth once you've live-tested the deploy.")


def cmd_reship(args) -> None:
    # No tree-hash check here, unlike cmd_ship: a reship's whole purpose is
    # pushing a fix GroundTruth's live test found and QA1 never re-audited
    # (that's intentional in this two-gate design, GroundTruth's retest
    # after reship is the check for this code, not a fresh QA1 pass). So
    # this commit is *expected* to differ in content from what QA1 audited.
    with locked(f"sprint-{args.id}"):
        state = load_state(args.id)
        if state["phase"] != "groundtruth_live":
            die(f"Sprint {args.id} is in phase '{state['phase']}', reship only applies during "
                "the GroundTruth live-test fix loop.")
        log_event(state, "pipeman", "reshipped", f"commit={args.commit or ''}")
        save_state(args.id, state)
    print(f"Sprint {args.id}: fix reshipped (commit {args.commit or '?'}). "
          "GroundTruth: re-test and run /sprint-groundtruth again.")


def cmd_groundtruth(args) -> None:
    with locked(f"sprint-{args.id}"):
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
            state["phase"] = "complete_ready"
            print(f"GroundTruth live test PASSED (round {state['live_test_rounds']}). "
                  f"Sprint {args.id} is complete-ready.")
            print("Dev Team: run /sprint-complete to close it out.")
        else:
            print(f"GroundTruth live test {verdict} (round {state['live_test_rounds']}). "
                  "Dev Team: fix, then Pipeman: /sprint-reship.")

        save_state(args.id, state)


def cmd_complete(args) -> None:
    with locked("registry"), locked(f"sprint-{args.id}"):
        state = load_state(args.id)
        missing = []
        if state["qa1_audit_result"] != "PASS":
            missing.append("QA1 first audit has not passed")
        if state["groundtruth_result"] != "PASS":
            missing.append("GroundTruth live test has not passed")
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
            update_frontmatter_status(dest, "done")
        entry["status"] = "done"
        save_registry(reg)

        state["phase"] = "complete"
        state["completed"] = now()
        log_event(state, "dev-team", "sprint_closed")
        save_state(args.id, state)
    print(f"Sprint {args.id} closed. Both gates confirmed: QA1 audit, GroundTruth live test.")


def cmd_abort(args) -> None:
    reason = resolve_text(args.reason, args.reason_file)
    with locked("registry"), locked(f"sprint-{args.id}"):
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
                update_frontmatter_status(dest, "abandoned")
            entry["status"] = "abandoned"
            save_registry(reg)

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

    s = sub.add_parser("complete"); s.add_argument("id", type=int); s.set_defaults(func=cmd_complete)

    s = sub.add_parser("abort")
    s.add_argument("id", type=int)
    s.add_argument("--reason", default="")
    s.add_argument("--reason-file", help="Read the reason from this file instead of the command line.")
    s.set_defaults(func=cmd_abort)

    s = sub.add_parser("list"); s.set_defaults(func=cmd_list)

    return p


def main() -> None:
    # Printed on every invocation so a wrong-script situation (a stale
    # global command, a same-named script earlier on PATH, a different
    # repo's copy of this tool) is obvious immediately instead of
    # discovered after acting on plausible-looking but wrong output.
    print(f"[sprint_lifecycle] repo={ROOT} script={Path(__file__).resolve()}", file=sys.stderr)
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
