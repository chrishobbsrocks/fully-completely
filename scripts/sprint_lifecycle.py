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
                       the commit it's pushing doesn't match. Ship (and
                       reship) also record the full SHA actually pushed,
                       as last_shipped_commit, an identity, not content,
                       fact for liveqa_live below to check against.
  liveqa_live      -> LiveQA is live-testing (this role was named
                       GroundTruth before this rename; the CLI subcommand
                       and this phase string both still accept the old
                       "groundtruth"/"groundtruth_live" names too, see
                       LIVEQA_PHASES and the "groundtruth" subparser alias
                       below — one transition period, so an in-flight
                       sprint elsewhere isn't stranded mid-phase). LiveQA
                       must pass --deployed-commit, the SHA it actually
                       tested; this has to match last_shipped_commit
                       exactly, no tolerance for a differing SHA the way
                       ship's content check tolerates a rebase, there's no
                       legitimate reason a live test and what was shipped
                       would differ. FAIL/CONDITIONAL means fixes + a
                       reship, then LiveQA tests again. A recorded PASS
                       here moves straight to complete_ready — there used
                       to be a QA1 "final check" gate here (gate 2), but
                       across ~13 real sprints it never once caught
                       anything gate 1 + LiveQA's live test hadn't already
                       caught, so it was removed. The one real value it
                       had — a fresh look after mid-build requirement
                       changes — is now QA1's responsibility at gate 1
                       (see above).
  complete_ready   -> Both gates (QA1 audit + LiveQA live test) have
                       passed. Waiting for /sprint-complete AND the user's
                       explicit, real-time go-ahead (--user-said) to
                       actually close the sprint.
  complete         -> Closed. Sprint file moved to 3-done/.
  aborted          -> Abandoned. Sprint file moved to 5-abandoned/.

The "no override" language above is accurate for every path an agent can
reach: no flag on dev-done or ship bypasses either hash check, and neither
is documented anywhere an agent reads. There is a separate `override`
subcommand below (cmd_override) for the human running this project, not
wired to any slash command, not mentioned in CLAUDE.md or any agent file
on purpose, see docs/HUMAN_OVERRIDE.md before using it. LiveQA's
deployed-commit check has no override at all, in cmd_override or anywhere
else: unlike the QA1-to-ship content check, there's no legitimate
transform (rebase, squash, whatever) that would make a live test and what
was actually shipped differ and still be fine, so there's nothing here to
responsibly re-stamp.
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
from collections import Counter
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

# GroundTruth was renamed LiveQA. New sprints reaching this phase always get
# the new name (LIVEQA_PHASE); every phase-equality check against it accepts
# LIVEQA_PHASES instead, so a sprint already sitting at the old phase string
# somewhere else isn't stranded mid-phase by this rename. Same reasoning as
# the "groundtruth" CLI subparser alias further down — one transition
# period, remove both once no in-flight sprint anywhere still uses the old
# name.
LIVEQA_PHASE = "liveqa_live"
_LEGACY_LIVEQA_PHASE = "groundtruth_live"
LIVEQA_PHASES = (LIVEQA_PHASE, _LEGACY_LIVEQA_PHASE)

# Sprint 7, Req 1: deliberately not "audit" — cmd_gates' verdict-counting
# functions (sprints_with_non_pass, the crossover section) filter history
# events by exact name, so a live-loop audit recorded under this distinct
# name is invisible to every gate-catch calculation by construction, not
# because cmd_gates was taught to special-case it (Req 9: cmd_gates itself
# is untouched by this sprint).
LIVE_LOOP_AUDIT_EVENT = "live_loop_audit"


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
        die(f"No state file for sprint {sprint_id} in {tree_description()}. "
            f"Run /sprint-start {sprint_id} first.")
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


def git_commit_sha(ref: str) -> Optional[str]:
    """Resolve a git ref to its full commit SHA, not the tree hash. Used to
    record exactly which commit Pipeman shipped, and later to check that
    LiveQA's live test ran against that same commit. This is an
    identity check, not a content check like the QA1-to-ship tree-hash
    comparison: there's no legitimate rebase/squash/merge step between
    shipping and deploying that would need tolerating here, a mismatch
    always means LiveQA tested something other than what actually
    went out. Returns None if the ref doesn't resolve."""
    try:
        result = subprocess.run(  # nosec B603 B607
            ["git", "rev-parse", ref],
            cwd=ROOT, capture_output=True, text=True, check=True,
        )
        return result.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return None


def is_git_repository() -> bool:
    """True only if ROOT is inside a real git working tree. Sprint 7, Req
    12: git_tree_hash() and git_commit_sha() above both collapse two very
    different causes into the same None — 'this isn't a git repository at
    all' and 'a ref inside a real repository doesn't resolve' — and every
    message downstream that reads one of those None results has to guess
    which, then guesses wrong: a directory with no repository at all gets
    told "run /sprint-qa1", which it already did, forever. This function
    is what lets a caller ask the two questions separately. Same
    subprocess-failure handling as git_tree_hash/git_commit_sha: no repo,
    no git on PATH, or any other failure to run git at all means False,
    never a raised exception."""
    try:
        result = subprocess.run(  # nosec B603 B607
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=ROOT, capture_output=True, text=True, check=True,
        )
        return result.stdout.strip() == "true"
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return False


def current_branch() -> Optional[str]:
    """The branch this checkout is on, or None if that can't be
    determined (detached HEAD, git missing from PATH, not a git
    repository at all). Sprint 7, Req 7: this must never be the reason a
    read-only command fails to answer at all, so every failure mode here
    collapses to None exactly like git_tree_hash/git_commit_sha above,
    and tree_description() below already treats a missing branch as
    something to omit, not something to error on."""
    try:
        result = subprocess.run(  # nosec B603 B607
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=ROOT, capture_output=True, text=True, check=True,
        )
        branch = result.stdout.strip()
        return branch if branch and branch != "HEAD" else None
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return None


def tree_description() -> str:
    """Sprint 7, Req 6: names which tree a command looked in and found
    nothing, at the point it says so — not as more banner text at the top
    of the output (main()'s wrong-script line already does that, Req 8,
    and it printed correctly in every one of the four wrong readings that
    motivated this). An agent reads the answer, not the header; this
    puts the answer in the sentence that's actually read."""
    branch = current_branch()
    return f"{ROOT} (branch: {branch})" if branch else f"{ROOT} (branch unknown)"


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
            "last_shipped_commit": None,
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
            print(f"No sprints yet in {tree_description()}. Use /sprint-new to create one.")
            return
        for sid, entry in sorted(reg["sprints"].items(), key=lambda kv: int(kv[0])):
            print(f"Sprint {sid}: {entry['title']} — {entry['status']}")
        return

    state = load_state(args.id)
    print(f"Sprint {state['id']}: {state['title']}")
    print(f"Phase: {state['phase']}")
    print(f"QA1 audit result: {state['qa1_audit_result']} (rounds: {state['audit_rounds']})")
    print(f"LiveQA live result: {state['groundtruth_result']} (rounds: {state['live_test_rounds']})")
    if state["phase"] in LIVEQA_PHASES:
        # Pure observability, doesn't gate anything: a ship/reship that
        # landed after the last recorded live_test verdict means whatever
        # verdict is on record was tested against older code. cmd_liveqa
        # already refuses a mismatched --deployed-commit when someone tries
        # to record a new verdict, this just makes that already-mechanically-
        # enforced fact legible to whoever reads status, instead of it only
        # surfacing as a refusal message at the moment someone tries.
        history = state.get("history", [])
        ship_indices = [i for i, h in enumerate(history) if h["event"] in ("shipped", "reshipped")]
        test_indices = [i for i, h in enumerate(history) if h["event"] == "live_test"]
        if ship_indices and test_indices and ship_indices[-1] > test_indices[-1]:
            print("Code has changed since the last recorded LiveQA verdict — not yet re-tested.")
    if args.verbose:
        print("\nHistory:")
        for h in state["history"]:
            print(f"  [{h['ts']}] {h['actor']}: {h['event']} {h['detail']}")


def _qa1_live_loop_audit(args, state) -> None:
    """Sprint 7, Req 1: records an audit QA1 performed during the LiveQA
    fix loop, without touching anything either gate reads.

    This function must NEVER assign to state["phase"],
    state["qa1_audit_result"], state["audit_rounds"],
    state["qa1_audit_file_hash"], or state["qa1_audited_tree_hash"] — the
    last two are exactly what cmd_ship compares a shipped commit's content
    against, so writing them here with a value unrelated to what gate 1
    actually audited would let a mismatched commit ship, which is worse
    than the recording gap this closes. The append-only property is not a
    convention this function happens to follow, it IS the safety
    argument: log_event() below is the only mutation of `state` anywhere
    in this function. There is no line here that could ever launder an
    inconvenient gate-1 verdict, by construction, not by rule — there is
    simply nothing else in this function that writes to `state` at all.

    Called with the sprint's lock already held (cmd_qa1 acquires it
    before dispatching here) and saves state itself, exactly like the
    gate-1 branch does."""
    verdict = args.verdict.upper()
    if verdict not in VALID_VERDICTS:
        die(f"Verdict must be one of {sorted(VALID_VERDICTS)}.")

    notes = resolve_text(args.notes, args.notes_file)

    # Req 2: optional, resolved with the same helper cmd_reship uses, and
    # refused if given but unresolvable — an audit record naming a commit
    # that doesn't exist is worse than one naming none at all. Omitting
    # it entirely is unchanged from how this argument didn't exist before
    # this sprint: this is purely additive.
    detail = f"{verdict}: {notes}"
    if args.commit:
        resolved = git_commit_sha(args.commit)
        if resolved is None:
            die(f"'{args.commit}' does not resolve to a real commit in this repo. "
                "--commit, if given, must be an actual commit hash — a live-loop audit "
                "record naming a commit that doesn't exist is worse than one naming none.")
        detail += f" | commit={resolved}"

    log_event(state, "qa1", LIVE_LOOP_AUDIT_EVENT, detail)
    save_state(args.id, state)
    # Req 3: printed plainly as a record, not a verdict — a reader must
    # not be able to mistake this for gate 1 passing or failing. Neither
    # gate moves: phase stays exactly what it was above.
    print(f"Sprint {args.id}: live-loop audit recorded ({verdict}). This is a RECORD, not a "
          "gate verdict — it does not change the sprint's phase and does not substitute for "
          "either gate. LiveQA's live-test retest remains what actually gates this code; "
          "run /sprint-liveqa once Pipeman has reshipped.")


def cmd_qa1(args) -> None:
    with locked(f"sprint-{args.id}"):
        state = load_state(args.id)

        # Sprint 7, Req 1: a distinct branch for a sprint currently in the
        # LiveQA fix loop — QA1 can now record an audit performed during
        # that loop, but it can never reach the gate-1 logic below, and
        # the gate-1 logic below can never run for a sprint in this phase
        # either. See _qa1_live_loop_audit()'s own docstring for the
        # safety argument.
        if state["phase"] in LIVEQA_PHASES:
            _qa1_live_loop_audit(args, state)
            return

        # dev_agreed_done is included so a sprint can get a fresh audit
        # after dev-done already succeeded once, this is the recovery path
        # ship's tree-hash check sends people to when a new, unaudited
        # commit lands after dev-done. Without it that check's own error
        # message ("run /sprint-qa1 again") would be a dead end.
        if state["phase"] not in ("dev_build", "qa1_audit", "dev_agreed_done"):
            die(f"Sprint {args.id} is in phase '{state['phase']}'. QA1's first audit only runs "
                "during dev_build/qa1_audit/dev_agreed_done; a live-loop audit record "
                f"only runs during {'/'.join(LIVEQA_PHASES)}. Neither applies to this phase.")
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
            if state["qa1_audited_tree_hash"] is None and not is_git_repository():
                # Req 12: say so now, at the moment the gap is created,
                # rather than letting it surface later as cmd_ship's "no
                # QA1-audited commit on record" — which names the wrong
                # cause here: QA1 DID pass, there is simply no repository
                # for a tree hash to exist in.
                print(f"WARNING: {ROOT} is not a git repository, so no audited commit hash "
                      "could be recorded. /sprint-ship will refuse until this sprint is in a "
                      "real git repository and re-audited — that refusal will not be a QA1 "
                      "failure, there is simply nothing yet for ship to check a commit against.")
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

        # Req 12: checked before either hash-comparison message below, so a
        # missing repository is never reported as "no QA1-audited commit on
        # record" — that message is correct for a real repo where QA1 truly
        # never PASSed, and actively wrong (an unclearable dead end, QA1
        # DID pass) when the actual cause is that this directory isn't a
        # git repository at all. Behaviour inside a real repository is
        # unaffected: is_git_repository() is True there, so this never
        # fires and every check below runs exactly as before.
        if not is_git_repository():
            die(f"{ROOT} is not a git repository. Run this from inside a real git repository — "
                "there is nothing here for --commit to resolve against.")

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

        shipped_commit = git_commit_sha(args.commit)
        if shipped_commit is None:
            die(f"'{args.commit}' resolved a tree hash but not a full commit SHA — "
                "unexpected, please investigate before shipping.")

        state["phase"] = LIVEQA_PHASE
        state["last_shipped_commit"] = shipped_commit
        log_event(state, "pipeman", "shipped", f"commit={args.commit or ''}")
        save_state(args.id, state)
    print(f"Sprint {args.id}: shipped (commit {args.commit or '?'}). Phase: {LIVEQA_PHASE}.")
    print("LiveQA: run /sprint-liveqa once you've live-tested the deploy.")


def cmd_reship(args) -> None:
    # No tree-hash check here, unlike cmd_ship: a reship's whole purpose is
    # pushing a fix for something LiveQA's live test found, and there is
    # normally no time to route back through gate 1 first, so this commit
    # ships without ever having been through QA1's static audit. That is
    # NOT "LiveQA's retest instead of a fresh QA1 pass" — the two gates
    # are not interchangeable, see CLAUDE.md and every agent file — it is
    # a commit gate 1 has simply never seen. If QA1 does look at it,
    # sprint 7's live-loop audit (cmd_qa1, called while phase is in
    # LIVEQA_PHASES) is how that gets put on the record, without touching
    # anything either gate reads. This commit still has to resolve to a
    # real commit: last_shipped_commit is what cmd_liveqa's
    # --deployed-commit check compares against, and an unresolved ref
    # would leave nothing real recorded to check.
    with locked(f"sprint-{args.id}"):
        state = load_state(args.id)
        if state["phase"] not in LIVEQA_PHASES:
            die(f"Sprint {args.id} is in phase '{state['phase']}', reship only applies during "
                "the LiveQA live-test fix loop.")
        # Req 12: same distinction as cmd_ship — say plainly when the cause
        # is no repository at all, rather than letting it surface as
        # "doesn't resolve to a real commit" below, which is correct for a
        # bad ref but misleading for a missing repository. Unaffected
        # inside a real repository.
        if not is_git_repository():
            die(f"{ROOT} is not a git repository. Run this from inside a real git repository — "
                "there is nothing here for --commit to resolve against.")
        reshipped_commit = git_commit_sha(args.commit) if args.commit else None
        if reshipped_commit is None:
            die(f"'{args.commit or ''}' does not resolve to a real commit in this repo. "
                "--commit must be an actual commit hash Pipeman is about to push.")
        state["last_shipped_commit"] = reshipped_commit
        log_event(state, "pipeman", "reshipped", f"commit={args.commit or ''}")
        save_state(args.id, state)
    print(f"Sprint {args.id}: fix reshipped (commit {args.commit or '?'}). "
          "LiveQA: re-test and run /sprint-liveqa again.")


def cmd_liveqa(args) -> None:
    if getattr(args, "_invoked_as", "liveqa") == "groundtruth":
        print("[sprint_lifecycle] note: 'groundtruth' is a deprecated alias for 'liveqa', "
              "kept for one transition period. Update your usage.", file=sys.stderr)
    with locked(f"sprint-{args.id}"):
        state = load_state(args.id)
        if state["phase"] not in LIVEQA_PHASES:
            die(f"Sprint {args.id} is in phase '{state['phase']}', not ready for a LiveQA live test.")

        # Req 12: same distinction as cmd_ship/cmd_reship — say plainly
        # when the cause is no repository at all, rather than letting it
        # surface as "doesn't resolve to a real commit" below. Unaffected
        # inside a real repository.
        if not is_git_repository():
            die(f"{ROOT} is not a git repository. Run this from inside a real git repository — "
                "there is nothing here for --deployed-commit to resolve against.")

        # Identity check, not a content check: unlike the QA1-to-ship
        # tree-hash comparison, there's no legitimate rebase/squash step
        # between shipping and deploying that would need tolerating here —
        # a mismatch always means this live test ran against something
        # other than what Pipeman actually shipped.
        deployed_commit = git_commit_sha(args.deployed_commit)
        if deployed_commit is None:
            die(f"'{args.deployed_commit}' does not resolve to a real commit in this repo. "
                "--deployed-commit must be the actual commit hash you tested live.")
        last_shipped = state.get("last_shipped_commit")
        if last_shipped is None:
            # Same distinction as ship's tree-hash check: either this sprint
            # predates the deployed-commit field, or ship/reship never
            # actually ran, either way nothing was recorded to verify
            # against, so a "doesn't match" message would be misleading.
            die(f"Sprint {args.id} has no shipped commit on record to verify this live test "
                "against (either this sprint predates the deployed-commit check, or Pipeman "
                "hasn't actually run /sprint-ship yet). Run /sprint-ship (or /sprint-reship) "
                "first so there's something real to check this against. No override.")
        if deployed_commit != last_shipped:
            die(f"Sprint {args.id}: the commit you tested ({deployed_commit}) doesn't match "
                f"what Pipeman actually shipped ({last_shipped}). Re-test against what was "
                "actually deployed, or if the wrong thing went out, Pipeman needs a fresh "
                "/sprint-ship or /sprint-reship first. No override.")

        verdict = args.verdict.upper()
        if verdict not in VALID_VERDICTS:
            die(f"Verdict must be one of {sorted(VALID_VERDICTS)}.")

        notes = resolve_text(args.notes, args.notes_file)
        state["groundtruth_result"] = verdict
        state["live_test_rounds"] += 1
        # New recordings use the "liveqa" actor name going forward; a
        # history[] entry logged under the old "groundtruth" actor before
        # this rename is an audit trail of what actually happened and stays
        # exactly as recorded, never rewritten.
        log_event(state, "liveqa", "live_test", f"{verdict}: {notes}")

        if verdict == "PASS":
            state["phase"] = "complete_ready"
            print(f"LiveQA live test PASSED (round {state['live_test_rounds']}). "
                  f"Sprint {args.id} is complete-ready.")
            print("Dev Team: tell the user the sprint is ready and wait. "
                  "/sprint-complete requires the user's explicit, real-time "
                  "go-ahead (--user-said) — both gates passing is not that.")
        else:
            print(f"LiveQA live test {verdict} (round {state['live_test_rounds']}). "
                  "Dev Team: fix, then Pipeman: /sprint-reship.")

        save_state(args.id, state)


def cmd_complete(args) -> None:
    # Both gates passing is necessary but never sufficient on its own to
    # close a sprint, that only tells you the code is ready, not that the
    # human has actually decided, right now, to close it. This check runs
    # before the lock and before the gate checks below on purpose, same as
    # override's --confirm/--reason: it's argument validation, independent
    # of sprint state, and it should refuse before touching anything else.
    # No override exists for this, unlike the hash gates: this isn't
    # drift to unstick, it's the one place in the lifecycle a human's
    # real-time word is the actual requirement, not a proxy for one.
    user_said = resolve_text(args.user_said, args.user_said_file)
    if not user_said.strip():
        die("--user-said is required and must be non-empty. Quote what the "
            "user actually told you, in this session, that authorizes closing "
            "this sprint right now. Both QA1 and LiveQA passing means the "
            "code is ready to close, not that you're authorized to close it, "
            "don't infer authorization from gate status alone, wait for the "
            "user to actually say so.")

    with locked("registry"), locked(f"sprint-{args.id}"):
        state = load_state(args.id)
        missing = []
        if state["qa1_audit_result"] != "PASS":
            missing.append("QA1 first audit has not passed")
        if state["groundtruth_result"] != "PASS":
            missing.append("LiveQA live test has not passed")
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
        log_event(state, "dev-team", "sprint_closed", f"user_said={user_said}")
        save_state(args.id, state)
    print(f"Sprint {args.id} closed. Confirmed: QA1 audit, LiveQA live test, user authorization.")


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


def cmd_override(args) -> None:
    """Human-only escape hatch. Deliberately absent from .claude/commands/ (no
    slash command wraps this) and never mentioned in CLAUDE.md or any agent
    file, see docs/HUMAN_OVERRIDE.md. QA1's and Pipeman's hash checks refuse
    outright with no override by design, that's what makes them mean
    something; this exists for the human ultimately accountable to force
    past drift they've personally reviewed, not for any of the six roles to
    reach for. It never fabricates a QA1 PASS that never happened, only
    re-stamps the hash a gate compares against, so the underlying
    requirement (a real PASS on record) still has to be true first."""
    if args.confirm != "OVERRIDE":
        die("Refusing: --confirm must be exactly the literal word OVERRIDE, typed "
            "deliberately. This command exists for a human who has personally "
            "reviewed the drift and is taking explicit responsibility for it.")
    reason = resolve_text(args.reason, args.reason_file)
    if not reason.strip():
        die("--reason is required and must be non-empty. State exactly what you "
            "reviewed and why it's safe to proceed despite the mismatch, this is "
            "written permanently into the sprint's history.")

    with locked(f"sprint-{args.id}"):
        state = load_state(args.id)

        if args.gate == "dev-done-hash":
            if state["qa1_audit_result"] != "PASS":
                die(f"Sprint {args.id} has no QA1 PASS on record. This overrides drift "
                    "since a real PASS, it does not substitute for one, QA1 still has "
                    "to actually pass this sprint first.")
            if state["phase"] != "qa1_audit":
                die(f"Sprint {args.id} is in phase '{state['phase']}', not qa1_audit. "
                    "dev-done-hash only re-stamps the sprint-file hash /sprint-dev-done "
                    "checks, and only makes sense before that command has run. If you're "
                    "trying to unstick a mismatch at ship time instead, use --gate ship-hash.")
            current_hash = file_hash(registry_sprint_file(args.id))
            if current_hash is None:
                die(f"Sprint {args.id}'s sprint file could not be read, nothing to stamp.")
            old_hash = state.get("qa1_audit_file_hash")
            state["qa1_audit_file_hash"] = current_hash
            log_event(state, "human-override", "dev_done_hash_override",
                      f"reason={reason} | old_hash={old_hash} | new_hash={current_hash}")
            save_state(args.id, state)
            print(f"Sprint {args.id}: sprint-file hash re-stamped to current content.")
            print("/sprint-dev-done will now proceed normally. This override is "
                  "permanently recorded in the sprint's history.")

        elif args.gate == "ship-hash":
            if state["phase"] != "dev_agreed_done":
                die(f"Sprint {args.id} is in phase '{state['phase']}', not ready to ship, "
                    "override doesn't change that, dev work must be agreed done first.")
            target_ref = args.commit or "HEAD"
            current_tree = git_tree_hash(target_ref)
            if current_tree is None:
                die(f"'{target_ref}' does not resolve to a real commit in this repo, "
                    "nothing to stamp.")
            old_tree = state.get("qa1_audited_tree_hash")
            state["qa1_audited_tree_hash"] = current_tree
            log_event(state, "human-override", "ship_hash_override",
                      f"reason={reason} | old_tree={old_tree} | new_tree={current_tree}")
            save_state(args.id, state)
            print(f"Sprint {args.id}: audited commit re-stamped to '{target_ref}'s current content.")
            print("/sprint-ship will now proceed normally for a commit matching that "
                  "content. This override is permanently recorded in the sprint's history.")

        else:
            die(f"Unknown --gate '{args.gate}'. Valid gates: dev-done-hash, ship-hash.")


def cmd_list(args) -> None:
    reg = load_registry()
    if not reg["sprints"]:
        print(f"No sprints yet in {tree_description()}.")
        return
    for sid, entry in sorted(reg["sprints"].items(), key=lambda kv: int(kv[0])):
        print(f"{sid:>3}  {entry['status']:<12} {entry['title']}")


def cmd_gates(args) -> None:
    """Read-only cross-sprint aggregate over every completed sprint's
    history[]. Never writes to state, the registry, or any sprint file,
    this only reads docs/sprints/state/*.json and prints. Scoped to
    phase == "complete" only: an aborted sprint or one still mid-loop
    isn't a verdict on the gates yet, so it's excluded rather than
    counted as some kind of non-event.

    Every number below is followed by the sprint IDs that produced it,
    on purpose, so any of this is checkable by hand against the state
    files instead of having to trust the aggregate.
    """
    if not STATE_DIR.exists():
        print(f"No sprint state yet in {tree_description()}. Nothing to aggregate.")
        return

    completed = []
    for path in sorted(STATE_DIR.glob("sprint-*.json")):
        try:
            state = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError) as exc:
            print(f"WARNING: skipping unreadable state file {path}: {exc}", file=sys.stderr)
            continue
        if not isinstance(state, dict) or "id" not in state:
            print(f"WARNING: skipping malformed state file {path}: not a sprint state object", file=sys.stderr)
            continue
        if state.get("phase") == "complete":
            completed.append(state)
    completed.sort(key=lambda s: s["id"])

    if not completed:
        print("No completed sprints yet (phase == 'complete'). Nothing to aggregate. "
              "This counts only sprints that finished /sprint-complete, not ones still "
              "mid-loop or aborted.")
        return

    n = len(completed)
    ids = [s["id"] for s in completed]
    print(f"Gates aggregate over {n} completed sprint{'s' if n != 1 else ''}: {ids}")
    if n == 1:
        print("Only one completed sprint on record — treat every number below as a "
              "single data point, not a rate.")
    print()

    def verdict_of(event: dict) -> Optional[str]:
        # Matched against VALID_VERDICTS rather than trusting whatever sits
        # before the first colon: if cmd_qa1/cmd_liveqa's "{verdict}:
        # {notes}" detail format ever changes, this returns None instead of
        # silently treating garbage as a real verdict.
        token = event["detail"].split(":", 1)[0].strip()
        return token if token in VALID_VERDICTS else None

    def counts_str(sids: list) -> str:
        tally = Counter(sids)
        return ", ".join(f"{sid}(x{tally[sid]})" if tally[sid] > 1 else str(sid)
                          for sid in sorted(tally)) or "(none)"

    # --- 1. Crossover: did LiveQA catch something QA1's audit had
    # already passed, or something QA1 never got a second look at? Walk
    # each sprint's history in order; for every live_test FAIL/CONDITIONAL,
    # find the shipped/reshipped event immediately before it, then check
    # whether a qa1 audit PASS landed between that ship and the ship before
    # it. A "reshipped" ship never has one by design (cmd_reship skips the
    # hash/audit check on purpose), so those always land in the unaudited
    # bucket. A "shipped" ship normally does, since cmd_ship refuses to
    # record one without it — UNLESS a ship-hash override (cmd_override
    # --gate ship-hash) also landed in that same window: that means the
    # content Pipeman actually pushed differs from what QA1's PASS covered,
    # a human vouched for it, not QA1, so it must not be counted as an
    # audited miss either. Anything that doesn't fit one of these shapes is
    # flagged rather than guessed into a bucket.
    #
    # This assumes at most one "shipped" event per sprint, true for every
    # reachable state today (cmd_ship only fires from dev_agreed_done, and
    # nothing currently routes liveqa_live back to dev_agreed_done —
    # every ship after the first is necessarily a reship). If that ever
    # changes, this window math needs to change with it.
    audited_miss = []
    unaudited_fix_miss = []
    unclassified = []

    for state in completed:
        sid = state["id"]
        history = state.get("history", [])
        ship_positions = [i for i, h in enumerate(history) if h["event"] in ("shipped", "reshipped")]
        for i, h in enumerate(history):
            if h["event"] != "live_test":
                continue
            verdict = verdict_of(h)
            if verdict is None:
                unclassified.append((sid, f"history[{i}] live_test has an unrecognized verdict format: {h['detail']!r}"))
                continue
            if verdict not in ("FAIL", "CONDITIONAL"):
                continue
            prior_ships = [sp for sp in ship_positions if sp < i]
            if not prior_ships:
                unclassified.append((sid, f"history[{i}] live_test has no preceding shipped/reshipped event"))
                continue
            ship_idx = prior_ships[-1]
            ship_event = history[ship_idx]
            if ship_event["event"] == "reshipped":
                unaudited_fix_miss.append(sid)
                continue
            earlier_ships = [sp for sp in ship_positions if sp < ship_idx]
            window_start = (earlier_ships[-1] + 1) if earlier_ships else 0
            window = history[window_start:ship_idx]
            audited_in_window = any(e["event"] == "audit" and verdict_of(e) == "PASS" for e in window)
            overridden_in_window = any(e["actor"] == "human-override" and e["event"] == "ship_hash_override"
                                        for e in window)
            if overridden_in_window:
                unclassified.append((sid, f"history[{i}] live_test followed a 'shipped' event whose ship-hash "
                                          "was human-overridden — the content that actually shipped was not "
                                          "vetted by QA1's own audit, needs a human look, not an automatic bucket"))
            elif audited_in_window:
                audited_miss.append(sid)
            else:
                unclassified.append((sid, f"history[{i}] live_test followed a 'shipped' event "
                                          "with no qa1 audit PASS found in the preceding window"))

    print("1. Crossover (LiveQA catching what shipped, split by audit provenance):")
    print(f"   Audited miss — QA1 passed fresh, LiveQA still caught it: "
          f"{len(audited_miss)} — sprints: {counts_str(audited_miss)}")
    print(f"   Unaudited-fix miss — fix reshipped without a fresh QA1 re-audit, not evidence "
          f"QA1 missed anything: {len(unaudited_fix_miss)} — sprints: {counts_str(unaudited_fix_miss)}")
    if unclassified:
        print("   UNCLASSIFIED (doesn't match the expected shipped/reshipped state machine, "
              "check by hand):")
        for sid, note in unclassified:
            print(f"     sprint {sid}: {note}")
    print()

    # --- 2. Per-gate catch rate: did each gate ever return non-PASS on a
    # completed sprint, and how many rounds did it take? Independent of the
    # crossover bucketing above.
    def sprints_with_non_pass(event_name: str) -> list:
        # An unparseable verdict (verdict_of returns None) must not silently
        # count as "caught something" just because None != "PASS" — that's
        # the same guessing this function's crossover section above refuses
        # to do. Flag it and exclude it instead, same as a malformed state
        # file gets a WARNING rather than being silently included or crashing.
        result = []
        for s in completed:
            found_non_pass = False
            for h in s.get("history", []):
                if h["event"] != event_name:
                    continue
                verdict = verdict_of(h)
                if verdict is None:
                    print(f"WARNING: sprint {s['id']} has a '{event_name}' event with an "
                          f"unrecognized verdict format, excluded from the catch-rate count: "
                          f"{h['detail']!r}", file=sys.stderr)
                    continue
                if verdict != "PASS":
                    found_non_pass = True
            if found_non_pass:
                result.append(s["id"])
        return result

    qa1_catch = sprints_with_non_pass("audit")
    liveqa_catch = sprints_with_non_pass("live_test")

    print("2. Per-gate catch rate (completed sprints where the gate ever returned non-PASS):")
    print(f"   QA1: {len(qa1_catch)} of {n} — sprints: {qa1_catch or '(none)'}")
    print(f"   LiveQA: {len(liveqa_catch)} of {n} — sprints: {liveqa_catch or '(none)'}")
    print("   Round-count distribution (audit_rounds / live_test_rounds), per completed sprint:")
    for state in completed:
        print(f"     sprint {state['id']}: audit_rounds={state.get('audit_rounds', 0)}, "
              f"live_test_rounds={state.get('live_test_rounds', 0)}")
    print()

    # --- 3. Hash-drift override frequency: how often did a human have to
    # clear the content-drift safety net (cmd_override), grouped by which
    # gate's hash it re-stamped. This is not "QA1/LiveQA overridden" —
    # no such override exists in this codebase, only the hash checks do.
    def override_event_sprints(event_name: str) -> list:
        return [s["id"] for s in completed for h in s.get("history", [])
                if h["actor"] == "human-override" and h["event"] == event_name]

    dev_done_hash_events = override_event_sprints("dev_done_hash_override")
    ship_hash_events = override_event_sprints("ship_hash_override")

    print("3. Hash-drift override frequency (content-drift safety net manually cleared, "
          "NOT a QA1/LiveQA override — no such override exists):")
    print(f"   dev-done-hash overrides: {len(dev_done_hash_events)} — sprints: {counts_str(dev_done_hash_events)}")
    print(f"   ship-hash overrides: {len(ship_hash_events)} — sprints: {counts_str(ship_hash_events)}")


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
    s.add_argument("--commit", default="",
                    help="Live-loop audits only: the commit this audit covers, resolved and "
                    "refused if it doesn't exist, then recorded in the event detail. Optional; "
                    "omitting it is unchanged from before this existed. Has no effect on a "
                    "gate-1 audit.")
    s.set_defaults(func=cmd_qa1)

    s = sub.add_parser("dev-done"); s.add_argument("id", type=int); s.set_defaults(func=cmd_dev_done)

    s = sub.add_parser("ship"); s.add_argument("id", type=int); s.add_argument("--commit", default=""); s.set_defaults(func=cmd_ship)

    s = sub.add_parser("reship"); s.add_argument("id", type=int); s.add_argument("--commit", default=""); s.set_defaults(func=cmd_reship)

    # LiveQA was named GroundTruth before this rename. "groundtruth" is kept
    # as a deprecated alias for one transition period so an in-flight sprint
    # elsewhere isn't stranded by this rename (same reasoning as
    # LIVEQA_PHASES above). Both names route to the same handler through a
    # shared parent parser so their arguments can never drift apart; args
    # also carries which name was actually typed (_invoked_as), so cmd_liveqa
    # can note the alias is deprecated without needing a second copy of the
    # command logic.
    liveqa_args = argparse.ArgumentParser(add_help=False)
    liveqa_args.add_argument("id", type=int)
    liveqa_args.add_argument("--verdict", required=True)
    liveqa_args.add_argument("--deployed-commit", required=True,
                    help="The commit SHA you actually tested live. Must match the commit "
                    "Pipeman's most recent /sprint-ship or /sprint-reship recorded — an "
                    "exact identity match, not a content/tree-hash comparison.")
    liveqa_args.add_argument("--notes", default="")
    liveqa_args.add_argument("--notes-file", help="Read notes from this file instead of the command line.")

    s = sub.add_parser("liveqa", parents=[liveqa_args])
    s.set_defaults(func=cmd_liveqa, _invoked_as="liveqa")

    s = sub.add_parser("groundtruth", parents=[liveqa_args],
                        help="Deprecated alias for 'liveqa', kept for one transition period "
                        "so an in-flight sprint elsewhere isn't stranded by the rename.")
    s.set_defaults(func=cmd_liveqa, _invoked_as="groundtruth")

    s = sub.add_parser("complete")
    s.add_argument("id", type=int)
    s.add_argument("--user-said", default="",
                    help="Required. Quote what the user actually told you, in this "
                    "session, that authorizes closing this sprint right now. Both "
                    "gates passing is not authorization on its own.")
    s.add_argument("--user-said-file", help="Read --user-said from this file instead of the command line.")
    s.set_defaults(func=cmd_complete)

    s = sub.add_parser("abort")
    s.add_argument("id", type=int)
    s.add_argument("--reason", default="")
    s.add_argument("--reason-file", help="Read the reason from this file instead of the command line.")
    s.set_defaults(func=cmd_abort)

    # Deliberately not wired to any .claude/commands/*.md slash command, and
    # never mentioned in CLAUDE.md or any agent file, see cmd_override's
    # docstring and docs/HUMAN_OVERRIDE.md. Keeping it CLI-only, undiscoverable
    # via / autocomplete, is intentional.
    s = sub.add_parser("override")
    s.add_argument("id", type=int)
    s.add_argument("--gate", required=True, choices=["dev-done-hash", "ship-hash"])
    s.add_argument("--reason", default="")
    s.add_argument("--reason-file", help="Read the reason from this file instead of the command line.")
    s.add_argument("--confirm", required=True, help="Must be exactly the literal word OVERRIDE.")
    s.add_argument("--commit", default="", help="ship-hash only: which commit to stamp as audited (defaults to HEAD).")
    s.set_defaults(func=cmd_override)

    s = sub.add_parser("list"); s.set_defaults(func=cmd_list)

    s = sub.add_parser("gates", help="Read-only cross-sprint gate aggregate over completed sprints.")
    s.set_defaults(func=cmd_gates)

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
