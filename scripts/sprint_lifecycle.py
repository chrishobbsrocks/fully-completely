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
import fnmatch
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

# Sprint 13, Req 1 — QA1 round 1 caught this: excluding all of
# "docs/sprints/" was WRONG, not just imprecise. .npmignore does NOT
# exclude the phase folders' .gitkeep placeholders (seven of them,
# confirmed in the published tarball) — only the specific patterns below
# — so a blanket docs/sprints/ prefix let an unaudited change to a
# shipped .gitkeep slip past the ship-time content comparison, the
# opposite of what "the ship gate compares what ships" is supposed to
# mean. These glob patterns (fnmatch syntax, matched against each
# git-tree path from git_tree_hash_excluding() below) are copied EXACTLY
# from .npmignore's own docs/sprints/-related lines — not "docs/sprints/"
# as a shorthand for it. KEEP THESE TWO LISTS IN SYNC BY HAND: reading
# .npmignore at runtime instead was considered and rejected as bigger
# than what Req 1 actually asked for — .npmignore also excludes things
# entirely unrelated to docs/sprints/ (__pycache__/, *.pyc, .DS_Store,
# .claude/settings.local.json), and Req 1 is scoped to docs/sprints/
# only; broadening the ship-time comparison to mirror the WHOLE
# .npmignore file is a different, larger change nothing here asked for.
# If .npmignore's docs/sprints/ patterns ever change, this list has to
# change with them by hand, and nothing will warn if it doesn't — a real,
# named limitation, not an assumed-away one.
#
# docs/sprints/.locks/* was missing from the first version of this list
# (only the three "new for sprint 2" .npmignore lines were copied, not
# the earlier docs/sprints/.locks/ line grouped with the OS/Python
# cruft) — caught by this sprint's OWN smoke test failing, not by
# inspection: a real bookkeeping-only commit that happened to create a
# lock file tripped the "no regression" test the fix to THIS finding was
# supposed to pass. Lock files are transient, per-invocation, and never
# sprint data (see CLAUDE.md's "Sprint data persistence"); they belong in
# this list for the same reason registry.json and the state files do.
SHIP_HASH_EXCLUDE_PATTERNS = (
    "docs/sprints/.locks/*",
    "docs/sprints/registry.json",
    "docs/sprints/state/*.json",
    "docs/sprints/*/*.md",
)

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

# Sprint 15, Req 1: the live-loop audit's own dispatch phases in cmd_qa1,
# widened beyond LIVEQA_PHASES to also include complete_ready — the exact
# moment a sprint has passed both gates but isn't closed yet, which is
# precisely when an audit performed during the fix loop (sprint 12's own
# outstanding case: QA1 audited a reshipped commit and had nowhere to put
# it) becomes unrecordable. LIVEQA_PHASES' own phases end the instant
# LiveQA records a PASS — straight to complete_ready, no transition moves
# backward — so nothing downstream of that point could ever reach this
# branch without this widening. LIVEQA_PHASES itself is untouched: every
# other use of it below (cmd_status, cmd_reship, cmd_liveqa) is about a
# sprint still actively mid-live-test, a different question than "can an
# audit still be recorded here", so widening LIVEQA_PHASES directly would
# have changed answers to questions this sprint never asked.
#
# "complete" is deliberately NOT included here, and the boundary is
# narrower than "nothing writes to a closed sprint": what a closed sprint
# must never gain is an AUDIT event — a judgement about whether code is
# sound, exactly the kind of entry a late addition could use to launder an
# inconvenient gate-1 verdict after the sprint is already shut. It MAY
# gain a VERIFICATION event — a record that a mechanical comparison ran
# against an artifact that still exists, with no judgement call in it.
# cmd_verify_publish (sprint 13) already does exactly this: it appends
# gitHead_check/content_check events to closed sprints (11 and 12, in its
# first real use) with no phase gate at all, because "does the registry's
# published content match what shipped" has a fixed yes/no answer forever,
# unlike "is this code sound", which is only ever true as of the moment
# QA1 last looked. Verdicts close with the sprint; comparisons remain
# runnable. That distinction, not a blanket "closed means frozen", is why
# this tuple stops at complete_ready.
LIVE_LOOP_AUDIT_PHASES = LIVEQA_PHASES + ("complete_ready",)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def slugify(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return slug or "untitled"


# Sprint 27, Req 1: every path a writing command actually wrote THIS
# invocation, populated by atomic_write() itself below — the one function
# every real file write in this script funnels through (save_state,
# save_registry, update_frontmatter_status, cmd_new's own sprint-file
# creation, cmd_rename's frontmatter rewrite; nothing else in this file
# writes a file's content anywhere). Hooking the lowest common choke
# point, the same shape sprint 25's last_claim stamping already
# established one level up at save_state() specifically, means no
# individual command needed to be touched to get this notice, and a
# future command that writes a file gets it automatically as long as it
# goes through atomic_write() — which every write in this file already
# must, since it's the only function here that performs one safely.
# Reset per-process (this script is a fresh interpreter on every
# invocation, never long-running), so this only ever reflects THIS
# invocation's own writes.
_WRITES_THIS_INVOCATION: list = []


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
    try:
        _WRITES_THIS_INVOCATION.append(str(path.relative_to(ROOT)))
    except ValueError:
        _WRITES_THIS_INVOCATION.append(str(path))


def resolve_text(value: Optional[str], file_value: Optional[str]) -> str:
    """Prefer a --*-file value over a raw flag value. Reading free text
    from a file (written by the Write tool, or by Bash via `printf` when
    Write is unavailable headless — see qa1.md/liveqa.md's own fallback)
    rather than interpolating it into a shell command line avoids
    quote-breakout / injection when a slash command builds the invocation
    from user-supplied text.

    Sprint 14, Req 1: this used to let a missing or unreadable file raise
    a bare, unhandled FileNotFoundError straight out of this function —
    exactly the failure LiveQA found on a default Windows box, where a
    command file's own example path (historically /tmp/...) doesn't
    exist and nothing gets recorded, just a stack trace. Now fails
    legibly instead, naming the exact path that couldn't be read, via
    die() — which itself writes to stderr and exits non-zero, never a
    silent, unrecorded crash. Called from inside a `with locked(...)`
    block at every real call site; die()'s sys.exit(1) still runs that
    block's `finally` and releases the lock, the same as every other
    die() call already made from inside one of those blocks."""
    if file_value:
        try:
            return Path(file_value).read_text(encoding="utf-8").strip()
        except OSError as exc:
            die(f"Could not read '{file_value}': {exc}. The text was expected there - "
                "check the path exists and is readable, then try again.")
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
    # Sprint 25, Req 2: stamps state["last_claim"] on EVERY save, uniformly,
    # regardless of which command called this -- the same "can't forget it"
    # shape Req 1 gets in run-role.js by hooking the one point every launch
    # already passes through. This is the choke point every write command in
    # this file already funnels through, so no individual command needed to
    # be touched to get this for free.
    #
    # REACHABILITY, ESTABLISHED BY RUNNING, not assumed (Req 2's own
    # explicit instruction): Claude Code sets CLAUDE_CODE_SESSION_ID and
    # CLAUDE_CODE_AGENT in the environment of every session it runs, headless
    # or interactive, inherited by any subprocess that session's own Bash
    # tool spawns -- confirmed directly, twice: once by inspecting this
    # exact process's own environment while writing this comment (running
    # as sprint 25's own Dev Team 1 session), and again by spawning a
    # genuinely fresh, standalone `claude -p --agent qa1 ...` and having
    # THAT session report its own environment back, independent of any
    # nesting or nested-session artifact the first check might have carried.
    # Both showed CLAUDE_CODE_AGENT matching the --agent flag that session
    # was launched with, and a fresh CLAUDE_CODE_SESSION_ID each time. This
    # is Claude Code's own behaviour, not something run-role.js sets --
    # confirmed by grepping run-role.js itself for any assignment to either
    # variable: there is none.
    #
    # Both are None when running outside a claude session entirely (a human
    # at a bare terminal, or a test) -- recorded as None rather than
    # omitted, an honest "no session identity available" rather than a
    # silently missing field, matching this file's own established
    # convention (getClaudeVersionString()'s sibling in run-role.js does the
    # same for a comparable "can't determine" case).
    state["last_claim"] = {
        "claude_session_id": os.environ.get("CLAUDE_CODE_SESSION_ID"),
        "claude_agent": os.environ.get("CLAUDE_CODE_AGENT"),
        "ts": now(),
    }
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    atomic_write(state_path(sprint_id), json.dumps(state, indent=2) + "\n")


def last_claim_line(state: dict) -> Optional[str]:
    """Sprint 25, Req 2: formats state.get("last_claim") (see save_state())
    for cmd_status. .get() with a None default throughout, per this file's
    own established convention (see the module-level state-field-access
    comment) — this field was added after sprints already existed, so a
    state file saved before this sprint genuinely lacks it, and that's
    expected, not corruption. Returns None (print nothing) for that case.

    Not a collision check, unlike Req 1's role-claims warning in
    run-role.js — Req 2 only asks this to "surface" the claim, not to
    compare it against anything. Both claude_session_id and claude_agent
    are None when the last write happened outside a claude session
    entirely (a human at a bare terminal, a test) — stated as such rather
    than silently omitted."""
    claim = state.get("last_claim")
    if not claim:
        return None
    agent = claim.get("claude_agent") or "(unknown — not running inside a claude session)"
    session = claim.get("claude_session_id")
    session_part = f", session {session}" if session else ""
    return f"Last touched by: {agent}{session_part}, at {claim.get('ts')}."


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


def git_tree_hash_excluding(ref: str, exclude_patterns) -> Optional[str]:
    """Sprint 13, Req 1 (Finding A), corrected on QA1 round 1: resolve a
    git ref (branch, tag, commit hash, HEAD) to a content hash of
    everything EXCEPT paths matching exclude_patterns (fnmatch glob
    syntax, matched with fnmatch.fnmatch against each git-tree path) —
    used to compare what QA1 audited against what actually ships without
    the lifecycle's own bookkeeping ever being able to invalidate an
    audit it never touched.

    Round 1 passed a single "docs/sprints/" PREFIX here instead of real
    patterns, on the reasoning that ".npmignore already excludes
    docs/sprints/ from the published tarball" — QA1 demonstrated that
    claim false by publishing a real tarball and finding seven .gitkeep
    placeholders inside it (install.js's phase-folder skeleton), which
    the prefix version silently stopped guarding even though they
    genuinely ship. SHIP_HASH_EXCLUDE_PATTERNS (module level, above) now
    mirrors .npmignore's own three docs/sprints/-specific lines exactly,
    not a shorthand for the whole directory — see that constant's own
    comment for why a runtime read of .npmignore itself was considered
    and rejected as broader than Req 1 asked for.

    This is deliberately NOT `git rev-parse ref^{tree}`, which has no
    "this tree minus a subtree" mode — there's no single git primitive
    for that. Instead: `git ls-tree -r` lists every (mode, type,
    blob-sha, path) entry in the tree recursively; entries matching any
    exclude pattern are dropped, the rest sorted for determinism, and
    hashed with sha256. The result is NOT a real git object hash (nothing
    reads it as one, e.g. `git cat-file`) — it only needs to support
    equality comparison between two calls with the same exclude_patterns,
    which a stable hash over the same deterministic listing does exactly
    as reliably as a native tree hash would.

    PRESERVED PROTECTION, stated explicitly per this requirement's own
    instruction, and re-confirmed on QA1 round 1 by inspecting the diff
    directly: the sprint FILE itself stays guarded by qa1_audit_file_hash,
    a separate, unrelated gate checked by cmd_dev_done (a stale-sprint-file
    mid-build amendment is caught there, before this function is ever
    called, and cmd_dev_done is untouched by this sprint). Excluding
    exactly what .npmignore excludes from THIS content hash removes an
    overlap between two gates that were both independently guarding the
    same thing — this function's own gate (cmd_ship's tree comparison) is
    only asking "did anything that ships change since the audit," and
    these specific patterns never ship. Everything else is still hashed
    and still compared exactly as before; a source change landing between
    audit and ship is still caught, with no override, unchanged — QA1
    round 1 demonstrated this directly against ten different source paths
    on scratch repos, including a file that didn't exist at audit time.

    Returns None if the ref doesn't resolve (not a git repo, bad ref,
    etc.), collapsing every subprocess failure the same way
    git_commit_sha() does, for the same reason: a caller here should
    never have to distinguish "not a repo" from "bad ref" itself."""
    try:
        # Fixed argument list, no shell=True, nothing concatenated into a
        # shell string; "git" resolved via PATH is the same trust model
        # every other tool in this repo already uses.
        result = subprocess.run(  # nosec B603 B607
            ["git", "ls-tree", "-r", ref],
            cwd=ROOT, capture_output=True, text=True, check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return None
    entries = []
    for line in result.stdout.splitlines():
        # Each line: "<mode> <type> <blob-sha>\t<path>" — split once on the
        # tab so a path containing a space is never mis-parsed.
        meta, sep, path = line.partition("\t")
        if not sep:
            continue  # malformed line, shouldn't happen; skip rather than crash
        if any(fnmatch.fnmatch(path, pattern) for pattern in exclude_patterns):
            continue
        entries.append(f"{meta}\t{path}")
    entries.sort()
    return hashlib.sha256("\n".join(entries).encode("utf-8")).hexdigest()


def differing_paths_excluding(ref_a: str, ref_b: str, exclude_patterns) -> Optional[list]:
    """Sprint 24, Req 1: when git_tree_hash_excluding(ref_a, ...) and
    git_tree_hash_excluding(ref_b, ...) disagree, a caller needs to say
    WHICH paths actually differ, not just that the hashes do — the
    reporter's own LiveQA had to run this by hand to know its verdict was
    valid, which is exactly the gap this closes.

    `git diff --name-only ref_a ref_b` lists every path that changed
    between the two trees (added, removed, or modified); paths matching
    exclude_patterns are dropped the same way git_tree_hash_excluding()
    drops them, so what's left is exactly the set of paths responsible
    for a content-hash mismatch computed with the same exclude_patterns —
    if the hashes disagree, this list is never empty, and if the hashes
    agree, calling this at all is pointless (callers should check the
    hash first, this only explains a real mismatch, it doesn't detect
    one).

    Returns None, not an empty list, if the diff itself couldn't be
    computed at all (bad ref, not a git repo) — collapsing every
    subprocess failure the same way git_tree_hash_excluding() does, for
    the same reason: distinguishing "no ref" from "ref resolved but diff
    failed" is not a distinction any caller here needs to make."""
    try:
        result = subprocess.run(  # nosec B603 B607
            ["git", "diff", "--name-only", ref_a, ref_b],
            cwd=ROOT, capture_output=True, text=True, check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return None
    paths = [p for p in result.stdout.splitlines() if p.strip()]
    paths = [p for p in paths if not any(fnmatch.fnmatch(p, pattern) for pattern in exclude_patterns)]
    paths.sort()
    return paths


def git_commit_sha(ref: str) -> Optional[str]:
    """Resolve a git ref to its full commit SHA, not the tree hash. Used to
    record exactly which commit Pipeman shipped, and to resolve whatever
    ref a caller (cmd_liveqa, cmd_ship, the live-loop audit) needs turned
    into a real commit identity. Returns None if the ref doesn't resolve.

    Sprint 24: this function's own docstring used to also claim there's
    "no legitimate rebase/squash/merge step between shipping and
    deploying" that cmd_liveqa's comparison would need to tolerate — that
    claim belonged to cmd_liveqa's specific use of this function, not to
    this function itself (git_commit_sha() is also called from cmd_ship
    and elsewhere, where no such claim was ever true or relevant), and it
    turned out to be wrong for cmd_liveqa's own case besides: a
    bookkeeping commit landing on top of a shipped commit before
    deployment is exactly this kind of step, and it's legitimate. See
    cmd_liveqa's own comment for the corrected reasoning about what its
    comparison protects and how."""
    try:
        result = subprocess.run(  # nosec B603 B607
            ["git", "rev-parse", ref],
            cwd=ROOT, capture_output=True, text=True, check=True,
        )
        return result.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return None


def is_commit_reachable(commit: str, ref: str = "HEAD") -> bool:
    """Sprint 28, Req 2: is `commit` actually reachable from `ref` (an
    ancestor of it, or equal to it)? A commit already unreachable at ship
    time should never become last_shipped_commit — nothing checked this
    before this Req, and it is exactly how a hash could be recorded for
    something that a subsequent push doesn't actually carry.

    `git merge-base --is-ancestor <commit> <ref>` — exit 0 means yes
    (including commit == ref, confirmed by running: a commit is its own
    ancestor), exit 1 means no (cleanly, no stderr noise), any other exit
    code (128 for a ref that doesn't resolve at all, `gh`-style tool
    failures) means "couldn't determine" and is treated as NOT reachable
    here — the conservative branch, deliberately: this Req exists to stop
    an unverifiable commit from being recorded as shipped, so a check
    that can't run must refuse exactly like a check that ran and found
    the commit missing, never silently wave it through."""
    try:
        result = subprocess.run(  # nosec B603 B607
            ["git", "merge-base", "--is-ancestor", commit, ref],
            cwd=ROOT, capture_output=True, text=True,
        )
    except (FileNotFoundError, OSError):
        return False
    return result.returncode == 0


def is_git_repository() -> bool:
    """True only if ROOT is inside a real git working tree. Sprint 7, Req
    12: git_tree_hash_excluding() and git_commit_sha() above both collapse two very
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


def _find_sprint_file_under(sprints_dir: Path, sprint_id: int) -> Optional[Path]:
    """Same search find_sprint_file() does, generalized to an arbitrary
    docs/sprints/ directory instead of always this process's own
    SPRINTS_DIR — needed by worktree_divergence_warning() below to look
    for the same sprint's file inside OTHER worktrees, which live under a
    different ROOT entirely."""
    for folder in STATUS_FOLDERS.values():
        d = sprints_dir / folder
        if not d.exists():
            continue
        for f in d.glob(f"sprint-{sprint_id}_*.md"):
            return f
    return None


def _other_worktree_roots() -> list:
    """Sprint 29, Req 1: factored out of worktree_divergence_warning()
    (sprint 13) so state_divergence_warning() (below) can reuse the exact
    same enumeration instead of a second copy of this subprocess call —
    and so a caller iterating many sprints (cmd_list, cmd_status with no
    id) can compute this ONCE per invocation rather than once per sprint.
    Same failure handling as every other git-touching function in this
    file: no git, not a worktree-using repo, or any subprocess failure
    collapses to an empty list, never raises."""
    try:
        result = subprocess.run(  # nosec B603 B607
            ["git", "worktree", "list", "--porcelain"],
            cwd=ROOT, capture_output=True, text=True, check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return []
    roots = []
    for line in result.stdout.splitlines():
        if not line.startswith("worktree "):
            continue
        candidate = Path(line[len("worktree "):]).resolve()
        if candidate != ROOT.resolve():
            roots.append(candidate)
    return roots


def worktree_divergence_warning(sprint_id: int) -> Optional[str]:
    """Sprint 13, Req 3 (Finding C): a sprint file amended in one working
    tree is invisible to a gate running in another — the hash gates were
    working exactly as designed while blind to this, since they only ever
    read the tree they're invoked in. `git worktree list` is local,
    enumerable, and needs no network; comparing against `origin/*` was
    ruled out in sprint 7 and stays ruled out for the same reason: a
    stale or unfetched remote ref produces a NEW confidently-wrong answer,
    which is exactly the class of defect this epic exists to remove.

    This WARNS ONLY. It must never gate anything — the roles working in
    worktrees (Dev Team 2 always, Dev Team 1 when a sprint says to) is
    the normal, correct use of this framework, not a problem to block.
    Every failure mode collapses silently to None: no git, a single
    worktree, another worktree missing docs/sprints/ entirely, a file
    that can't be read — this must never be the reason a read-only or
    gating command fails to answer, the same discipline every other
    git-touching function in this file already follows.

    Returns a human-readable warning if another worktree's copy of this
    sprint's file has different BYTE CONTENT than the one this process
    found, naming which worktree(s) diverge; None if there's nothing to
    warn about.

    Sprint 29: only ever compares the sprint FILE. See
    state_divergence_warning() below for why that alone misses most of
    the lifecycle — this function is deliberately left as-is rather than
    widened, the new function covers what this one structurally can't."""
    other_roots = _other_worktree_roots()
    if not other_roots:
        return None

    this_file = find_sprint_file(sprint_id)
    if this_file is None:
        return None
    try:
        this_content = this_file.read_bytes()
    except OSError:
        return None

    diverging = []
    for other_root in other_roots:
        other_file = _find_sprint_file_under(other_root / "docs" / "sprints", sprint_id)
        if other_file is None:
            continue
        try:
            other_content = other_file.read_bytes()
        except OSError:
            continue
        if other_content != this_content:
            diverging.append(str(other_root))

    if not diverging:
        return None
    plural = "worktree" if len(diverging) == 1 else "worktrees"
    return (
        f"WARNING: sprint {sprint_id}'s file differs from the copy in {len(diverging)} "
        f"other {plural}: {', '.join(diverging)}. This read is from {ROOT} only — if "
        "another session amended the sprint file elsewhere, this may be a stale copy. "
        "Not gated: worktrees are exactly how this framework expects roles to work in "
        "parallel, this only makes the divergence visible rather than silent."
    )


def state_divergence_warning(
    sprint_id: int,
    this_phase: Optional[str] = None,
    this_registry_status: Optional[str] = None,
    other_roots: Optional[list] = None,
) -> Optional[str]:
    """Sprint 29, Req 1 (Finding A): extends sprint 13's cross-tree warning
    from the sprint FILE to STATE FILES and the REGISTRY — precisely what
    a close (and almost every other phase transition) actually writes.

    worktree_divergence_warning() above only ever compares the sprint
    file's byte content, which changes at exactly three transitions —
    new, start, complete — the only ones that call
    update_frontmatter_status(). Every other transition this lifecycle
    has (a QA1 verdict, dev_agreed_done, shipped, reshipped, a LiveQA
    verdict, a repoint) touches ONLY docs/sprints/state/sprint-<id>.json,
    invisible to that check entirely. Master Controller named the gap
    precisely: sprint 13's mechanism "says nothing about state files or
    the registry, which is precisely what a close writes." A stranded
    close (Finding A's own motivating incident) happens to ALSO change
    the sprint file's frontmatter (status: in_progress -> done), so
    worktree_divergence_warning() would catch that one case by accident —
    this function is the general fix, not a narrower one aimed only at
    closing.

    Same discipline as worktree_divergence_warning(): warns, never gates,
    and every failure mode (no git, no other worktrees, another tree's
    state file or registry missing or unreadable) collapses silently to
    None — this must never be the reason a read-only or gating command
    fails to answer.

    Compares TWO independent things per other worktree, either one
    enough to warn on its own: state.json's own `phase` (fine-grained,
    authoritative — dev_build, qa1_audit, liveqa_live, complete, ...),
    and registry.json's `status` for this sprint id (the coarse
    todo/in_progress/done bucket cmd_list and cmd_status's no-id view
    actually print). The stranded-close incident changes both; a
    mid-lifecycle phase change (e.g. dev_agreed_done -> shipped) changes
    only the first, and Req 1 requires that be visible too, not only the
    close case.

    `other_roots`, `this_phase`, `this_registry_status` are accepted as
    parameters, not always re-derived, so a caller iterating many sprints
    (cmd_list, cmd_status with no id) can compute `other_roots` ONCE via
    _other_worktree_roots() and reuse it across every sprint, instead of
    a redundant `git worktree list` subprocess call per sprint. A caller
    with only one sprint to check (cmd_status with an id, which already
    has `state` loaded) can pass what it already has and let this
    function derive the rest itself.

    QA1 round 1 FINDING, FIXED HERE: this used to `return None` the
    moment THIS tree had no local state file at all — which is exactly
    the case for a sprint created in main and then started AND closed
    entirely inside a worktree (CLAUDE.md's own documented order: create
    the sprint, run /sprint-worktree BEFORE building, start there). That
    early return bailed out before the REGISTRY comparison below ever
    ran, so Req 2's own sentence — "must not report a sprint as open
    when another tree has closed it" — silently failed on exactly the
    path it names. A missing local state file is real information (there
    is no local phase to report), not a reason to skip the comparison
    entirely: `this_phase` stays None and the registry check, which the
    caller may already have supplied, still runs. Silence is preserved
    correctly for the genuinely-nothing-to-compare case (see the
    `this_phase is None and this_registry_status is None` check below) —
    confirmed directly: a sprint reading 'todo' in both trees, with no
    state file in either, still produces no warning."""
    if other_roots is None:
        other_roots = _other_worktree_roots()
    if not other_roots:
        return None

    if this_phase is None:
        this_state_path = state_path(sprint_id)
        if this_state_path.exists():
            try:
                this_phase = json.loads(this_state_path.read_text()).get("phase")
            except (OSError, json.JSONDecodeError):
                this_phase = None
        # else: genuinely no state file here — this_phase stays None,
        # but execution must continue; the registry comparison below is
        # still real and still needs to run (this is the bug QA1 found).
    if this_registry_status is None:
        reg = load_registry()
        entry = reg["sprints"].get(str(sprint_id))
        this_registry_status = entry["status"] if entry else None
    if this_phase is None and this_registry_status is None:
        return None  # genuinely nothing here to compare against anything

    diverging = []
    for other_root in other_roots:
        other_phase = None
        other_state_file = other_root / "docs" / "sprints" / "state" / f"sprint-{sprint_id}.json"
        if other_state_file.exists():
            try:
                other_phase = json.loads(other_state_file.read_text()).get("phase")
            except (OSError, json.JSONDecodeError):
                other_phase = None

        other_registry_status = None
        other_registry_file = other_root / "docs" / "sprints" / "registry.json"
        if other_registry_file.exists():
            try:
                other_reg = json.loads(other_registry_file.read_text())
                other_entry = (other_reg.get("sprints") or {}).get(str(sprint_id))
                other_registry_status = other_entry["status"] if other_entry else None
            except (OSError, json.JSONDecodeError, KeyError, TypeError):
                other_registry_status = None

        if other_phase is None and other_registry_status is None:
            continue  # nothing readable there for this sprint — absence, not divergence

        phase_differs = other_phase is not None and other_phase != this_phase
        status_differs = other_registry_status is not None and other_registry_status != this_registry_status
        if not (phase_differs or status_differs):
            continue

        bits = []
        if other_phase is not None:
            bits.append(f"phase '{other_phase}'")
        if status_differs:
            bits.append(f"registry status '{other_registry_status}'")
        diverging.append(f"{other_root} ({', '.join(bits)})")

    if not diverging:
        return None
    plural = "worktree" if len(diverging) == 1 else "worktrees"
    this_phase_desc = f"phase '{this_phase}'" if this_phase is not None else "no state file here at all"
    return (
        f"WARNING: sprint {sprint_id}'s state here shows {this_phase_desc} "
        f"(registry status '{this_registry_status}'), but {len(diverging)} "
        f"other {plural} disagree: {'; '.join(diverging)}. This read is from {ROOT} only — "
        "if another session moved this sprint further (closed it, shipped it, recorded a "
        "verdict) in a different worktree, this may be stale. Not gated: worktrees are "
        "exactly how this framework expects roles to work in parallel, this only makes the "
        "divergence visible rather than silent."
    )


def origin_ahead_of_record_warning(last_shipped: Optional[str]) -> Optional[str]:
    """Sprint 24, Req 3 (Finding C): `cmd_ship` never runs when Claude
    Code's own permission classifier denies the push step before
    `cmd_ship` starts — confirmed directly, both entry points, same
    denial. So nothing INSIDE `cmd_ship` can prevent a push landing
    without its matching state write (a second, real ship — often a
    headless Pipeman's own twin — closing the window before this one's
    bookkeeping caught up). Detection after the fact, wherever
    `last_shipped_commit` is read to make a decision, is the achievable
    thing; this is that detector.

    ADDRESSING `worktree_divergence_warning()`'s OWN PRECEDENT DIRECTLY,
    rather than silently building something that looks like it
    contradicts it: that function's docstring rules out comparing against
    `origin/*` at all, because "a stale or unfetched remote ref produces
    a NEW confidently-wrong answer." This function also reads
    `origin/<upstream>`, and does NOT `git fetch` first either — so it
    earns re-examining that ruling, not just citing a different Req
    number past it.

    The two checks are not the same shape, and that's why the ruling
    doesn't transfer. `worktree_divergence_warning()` was answering "does
    another location have a DIFFERENT sprint file than this one" — a
    stale origin ref there could read as agreement when the real answer
    is unknown in either direction, a genuine false confidence. This
    function only ever answers "does origin contain at least one commit
    beyond `last_shipped_commit`" — a strictly MONOTONIC, one-directional
    question. Git history is append-only on a branch nobody force-pushes
    (this project's own standing assumption elsewhere: only Pipeman
    pushes, and never with --force). Under that assumption, a stale local
    view of `origin/<upstream>` can only ever make this function see
    FEWER of origin's commits than actually exist, never invent commits
    that aren't there — so staleness here produces under-reporting
    (silently missing a real drift a fresh fetch would show), never a
    false alarm. That is a real, named limitation, not a hidden one: run
    `git fetch` yourself first for the freshest picture. It is not the
    same failure mode `worktree_divergence_warning()` was refusing to
    risk, which is why this function is allowed to exist where that
    ruling still correctly stands for its own, different check.

    Returns None — the common, correct case — when there is nothing to
    report: no `last_shipped_commit` yet, not a git repository, no
    upstream configured for the current branch (detached HEAD, a
    local-only branch), or origin is not ahead. Returns a warning STRING,
    never raises, when it is: worded to say exactly "origin carries a
    commit your record does not," never "someone bypassed the push
    rule" — Pipeman's own first, wrong reading of this exact situation,
    the misreading this message exists to prevent.

    Sprint 29, Req 3: NAMES the commits (short SHA + subject line, via
    `git log --oneline`, capped so a long drift doesn't dump an
    unreadable wall of text), not merely a count with a suggestion to go
    look — this is deliberately the same question this function already
    answers cheaply, `git log --oneline A..B` costs no more than the
    `git rev-list --count` this replaced and returns the commits it
    would have counted anyway. This is also the mechanism cmd_liveqa uses
    to detect the branch tip moving off `last_shipped_commit` DURING the
    live gate (Finding B) — see the dedicated comment at that call site
    for why that context warns rather than refuses; this function's own
    behaviour (warn, never gate) is unchanged, only its message grew
    more specific."""
    if not last_shipped or not is_git_repository():
        return None
    upstream = subprocess.run(  # nosec B603 B607
        ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        cwd=ROOT, capture_output=True, text=True,
    )
    if upstream.returncode != 0:
        return None  # no upstream configured — nothing to compare against
    origin_ref = upstream.stdout.strip()
    if not origin_ref:
        return None
    log = subprocess.run(  # nosec B603 B607
        ["git", "log", "--oneline", f"{last_shipped}..{origin_ref}"],
        cwd=ROOT, capture_output=True, text=True,
    )
    if log.returncode != 0:
        return None  # last_shipped or origin_ref doesn't resolve locally
    commits = [line for line in log.stdout.splitlines() if line.strip()]
    if not commits:
        return None
    count = len(commits)
    plural = "commit" if count == 1 else "commits"
    max_named = 5
    named = "; ".join(commits[:max_named])
    if count > max_named:
        named += f"; ...and {count - max_named} more"
    return (
        f"NOTE: {origin_ref} carries {count} {plural} beyond this sprint's own recorded "
        f"last_shipped_commit ({last_shipped}): {named}. This means the remote and this "
        "record have drifted apart — it does NOT mean someone bypassed the push-only-Pipeman "
        "rule. The most common causes: a second, real ship (often a headless Pipeman's own "
        "instance) landing after this one, before its own bookkeeping state write caught up; "
        "or ordinary, legitimate work on another sprint landing on the same shared branch — "
        "any push moves the one tip everyone shares, regardless of which worktree it came "
        "from. Not a block — informational. (Compares against the locally cached view of "
        "origin — run `git fetch` first for the freshest picture; a stale local view "
        "under-reports this, it never over-reports it.)"
    )


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
    # Sprint 14, Req 1: was its own duplicated, unguarded
    # Path(...).read_text() pair — the exact same unhandled-crash shape
    # resolve_text() above already fixed for every other --*-file
    # argument. Reusing it here instead of a second copy means a missing
    # --title-file/--epic-file now fails the same legible way (die(),
    # naming the path) rather than reinventing that fix a second time.
    title = resolve_text(args.title, args.title_file)
    epic = resolve_text(args.epic, args.epic_file)
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
        # Sprint 29, Req 2: computed ONCE for the whole listing, not once
        # per sprint — see state_divergence_warning()'s own docstring for
        # why a caller iterating many sprints passes this in rather than
        # letting the function re-derive it every time.
        other_roots = _other_worktree_roots()
        for sid, entry in sorted(reg["sprints"].items(), key=lambda kv: int(kv[0])):
            print(f"Sprint {sid}: {entry['title']} - {entry['status']}")
            if other_roots:
                divergence = state_divergence_warning(
                    int(sid), this_registry_status=entry["status"], other_roots=other_roots)
                if divergence:
                    print(f"  {divergence}")
        return

    # Sprint 29, Req 2 (QA1 round 1 finding): load_state() below dies with
    # "Run /sprint-start N first" whenever this tree has no local state
    # file — actively wrong advice for a sprint started AND closed
    # entirely inside another worktree (CLAUDE.md's documented order:
    # create in main, /sprint-worktree BEFORE building, start there). It
    # is not this function's job to render a full detail view from
    # another tree's data (that would blur "what this tree's own read
    # says" — the property every other divergence check here protects),
    # but the refusal message itself can and must stop telling someone to
    # start a sprint somebody already finished. Checked before
    # load_state() so the better message wins when there's a better one
    # to give; falls through to load_state()'s own generic die() — still
    # correct — when genuinely no tree has this sprint's state at all.
    if not state_path(args.id).exists():
        found_elsewhere = []
        for other_root in _other_worktree_roots():
            other_state_file = other_root / "docs" / "sprints" / "state" / f"sprint-{args.id}.json"
            if not other_state_file.exists():
                continue
            try:
                other_phase = json.loads(other_state_file.read_text()).get("phase")
            except (OSError, json.JSONDecodeError):
                other_phase = None
            found_elsewhere.append(f"{other_root} (phase '{other_phase}')" if other_phase else str(other_root))
        if found_elsewhere:
            die(f"Sprint {args.id} has no state file in {tree_description()} (this tree), but it "
                f"exists in {len(found_elsewhere)} other worktree(s): {'; '.join(found_elsewhere)}. "
                "This sprint was likely started (and possibly closed) entirely inside another "
                "worktree — it was never /sprint-start'ed here, so there is genuinely nothing "
                "local to show. Read status from the tree that actually holds it, not this one.")

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
            print("Code has changed since the last recorded LiveQA verdict - not yet re-tested.")
    # Sprint 13, Req 3 (Finding C): warns, never gates — see
    # worktree_divergence_warning()'s own docstring.
    divergence = worktree_divergence_warning(args.id)
    if divergence:
        print(divergence)
    # Sprint 29, Req 1/2 (Finding A): the sprint-FILE check above misses
    # most of the lifecycle (see state_divergence_warning()'s own
    # docstring) — this is the general check, passing this_phase since
    # `state` is already loaded here.
    state_divergence = state_divergence_warning(args.id, this_phase=state["phase"])
    if state_divergence:
        print(state_divergence)
    # Sprint 24, Req 3 (Finding C): same "warns, never gates" shape, a
    # different divergence — see origin_ahead_of_record_warning()'s own
    # docstring for why comparing against origin here doesn't repeat the
    # mistake worktree_divergence_warning() above was written to rule out.
    origin_drift = origin_ahead_of_record_warning(state.get("last_shipped_commit"))
    if origin_drift:
        print(origin_drift)
    # Sprint 25, Req 2: surfaced here, on the one read-only command this
    # Req names explicitly ("/sprint-status must stay read-only" -- this
    # function never calls save_state() itself, so it only ever displays
    # whatever the last WRITE command already recorded, never stamps its
    # own). Not a collision warning like Req 1's role-claims -- just the
    # one fact available: who (if identifiable) last wrote this sprint's
    # state, and when.
    claim_line = last_claim_line(state)
    if claim_line:
        print(claim_line)
    if args.verbose:
        print("\nHistory:")
        for h in state["history"]:
            print(f"  [{h['ts']}] {h['actor']}: {h['event']} {h['detail']}")


def _qa1_live_loop_audit(args, state) -> None:
    """Sprint 7, Req 1: records an audit QA1 performed during the LiveQA
    fix loop, without touching anything either gate reads. Sprint 15,
    Req 1: also reachable from complete_ready (see LIVE_LOOP_AUDIT_PHASES'
    own comment for why that phase and not "complete") — the function
    itself needed no change for that widening, which is the point: it was
    already generic over "which phase got us here", touching nothing
    phase-specific except what it prints, below.

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
                "--commit, if given, must be an actual commit hash - a live-loop audit "
                "record naming a commit that doesn't exist is worse than one naming none.")
        detail += f" | commit={resolved}"

    log_event(state, "qa1", LIVE_LOOP_AUDIT_EVENT, detail)
    save_state(args.id, state)
    # Req 3: printed plainly as a record, not a verdict — a reader must
    # not be able to mistake this for gate 1 passing or failing. Neither
    # gate moves: phase stays exactly what it was above.
    #
    # Sprint 15, Req 1: the second sentence is phase-conditional, because
    # this branch now fires from two genuinely different situations. Mid
    # LiveQA fix loop (LIVEQA_PHASES), there IS a next live-test retest
    # still to come, so saying so is accurate and useful. At
    # complete_ready, both gates have already passed and nothing further
    # is pending — telling that reader to wait on another LiveQA retest
    # would be describing a step that isn't going to happen, the exact
    # kind of misleading gate language Req 2 exists to stop elsewhere in
    # this same sprint.
    if state["phase"] in LIVEQA_PHASES:
        next_step = ("LiveQA's live-test retest remains what actually gates this code; "
                     "run /sprint-liveqa once Pipeman has reshipped.")
    else:
        next_step = ("Both gates already passed for this sprint before this record was made; "
                     "this adds an audit record for a commit reached during the fix loop, it "
                     "does not reopen or re-gate anything.")
    print(f"Sprint {args.id}: live-loop audit recorded ({verdict}). This is a RECORD, not a "
          f"gate verdict - it does not change the sprint's phase and does not substitute for "
          f"either gate. {next_step}")


def cmd_qa1(args) -> None:
    with locked(f"sprint-{args.id}"):
        state = load_state(args.id)

        # Sprint 13, Req 3 (Finding C): surfaced here specifically because
        # this is the moment QA1 is told to re-read the sprint file fresh
        # (see this function's own review-process instruction) — a stale
        # read here is exactly the damage this warning exists to prevent.
        # Warns only; never gates, never blocks the audit below.
        divergence = worktree_divergence_warning(args.id)
        if divergence:
            print(divergence)

        # Sprint 7, Req 1: a distinct branch for a sprint currently in the
        # LiveQA fix loop — QA1 can now record an audit performed during
        # that loop, but it can never reach the gate-1 logic below, and
        # the gate-1 logic below can never run for a sprint in this phase
        # either. See _qa1_live_loop_audit()'s own docstring for the
        # safety argument. Sprint 15, Req 1: widened from LIVEQA_PHASES to
        # LIVE_LOOP_AUDIT_PHASES (adds complete_ready, deliberately stops
        # short of "complete" — see that constant's own comment).
        if state["phase"] in LIVE_LOOP_AUDIT_PHASES:
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
                f"only runs during {'/'.join(LIVE_LOOP_AUDIT_PHASES)}. Neither applies to this phase.")
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
            state["qa1_audited_tree_hash"] = git_tree_hash_excluding("HEAD", SHIP_HASH_EXCLUDE_PATTERNS)
            print(f"QA1 audit PASSED (round {state['audit_rounds']}).")
            if state["qa1_audited_tree_hash"] is None and not is_git_repository():
                # Req 12: say so now, at the moment the gap is created,
                # rather than letting it surface later as cmd_ship's "no
                # QA1-audited commit on record" — which names the wrong
                # cause here: QA1 DID pass, there is simply no repository
                # for a tree hash to exist in.
                print(f"WARNING: {ROOT} is not a git repository, so no audited commit hash "
                      "could be recorded. /sprint-ship will refuse until this sprint is in a "
                      "real git repository and re-audited - that refusal will not be a QA1 "
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


# Sprint 24, Req 2: CI is red for exactly the commit being shipped, and
# nothing checked it — the reporter's own two-day-red build, `npm ci`
# exiting `EUSAGE` in five to seven seconds because a lockfile was out of
# sync, lint/test/build never running at all. Their own diagnosis is the
# requirement: a check asking only "did a run exist" or "did it finish"
# would have passed every red run they had. This checks the CONCLUSION of
# the latest run(s) for the EXACT commit, and whether real steps executed
# — not merely that something with that name happened.
CI_STATUS_GREEN = "green"
CI_STATUS_RED = "red"
CI_STATUS_UNDETERMINABLE = "undeterminable"


def workflows_configured_at(commit_sha: str) -> bool:
    """Sprint 28, Req 1: the local discriminator between "no CI is
    configured" and "CI is configured but produced no run for this
    commit" — `.github/workflows/` in the repository AT THE COMMIT BEING
    SHIPPED, not at HEAD or on GitHub's current view of the repo.

    ESTABLISHED BY RUNNING, per this Req's own instruction to check
    whether `gh` also separates the two cases and prefer whichever is
    more reliable: `gh workflow list` DOES report configured workflows,
    but it reads GitHub's current state of the default branch, not the
    tree at any specific commit — wrong question for a check that is
    supposed to be scoped to "the exact commit", the same principle
    `check_ci_status()`'s own docstring already states for run lookups.
    It also requires network and auth. `git ls-tree -r --name-only
    <commit_sha> -- .github/workflows/` answers the precise question (did
    THIS commit's tree have workflow files) with no API call and nothing
    that can fail for network reasons — confirmed directly: it exits 0
    and prints matching paths when they exist, and exits 0 with empty
    output (not an error) when the path doesn't exist in that tree at
    all, verified against both a real commit in this repo and a scratch
    repo with no .github/workflows/ whatsoever.

    Returns False (i.e. "nothing configured") on any subprocess failure
    too — collapsing "couldn't check" into the benign case is deliberate
    here and asymmetric with check_ci_status()'s own None-handling: a
    tool failure on THIS check must never manufacture the "workflows
    exist but produced nothing" alarm, which is what would make a ship
    gate flaky for a reason that has nothing to do with CI."""
    try:
        result = subprocess.run(  # nosec B603 B607
            ["git", "ls-tree", "-r", "--name-only", commit_sha, "--", ".github/workflows/"],
            cwd=ROOT, capture_output=True, text=True, check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return False
    return bool(result.stdout.strip())


def check_ci_status(commit_sha: str):
    """Returns (status, detail). status is one of CI_STATUS_GREEN,
    CI_STATUS_RED, CI_STATUS_UNDETERMINABLE — never raises, mirroring
    every other git/network-touching function in this file: a caller
    here should never have to separately catch an exception on top of
    branching on the result.

    Implementation: `gh run list --commit <sha>` (GitHub CLI; this
    project already depends on it being available and authenticated for
    Pipeman's own documented flow, so no new external dependency is
    introduced here). Filtering by the exact commit SHA, not by branch or
    "latest run" generally, is deliberate and load-bearing — a check
    scoped to a branch can read a DIFFERENT commit's green run as this
    one's, which is a worse defect than the one being fixed here.

    CI_STATUS_RED fires on ANY run found for this commit that either (a)
    completed with a conclusion other than "success" (failure, cancelled,
    timed_out, etc. — this alone already catches the reporter's own
    5-second `EUSAGE` case, since a failed install step fails the job),
    or (b) completed with conclusion "success" but, on inspection via
    `gh run view --json jobs`, has no job with at least one step that
    actually reports `status: completed` and a non-skipped conclusion —
    guarding against a workflow trivially "succeeding" because its real
    steps never ran at all (an `if:` misconfiguration, an empty job), the
    literal "whether its steps actually executed" half of this Req, which
    a bare conclusion check alone would miss. No project-specific step
    names (no hardcoded "lint"/"test"/"build") — this framework can't
    know a downstream project's own job structure, so the check is
    generic: real steps ran, or they didn't.

    A run still `in_progress`/`queued`/not yet `completed` for this
    commit is NOT graded red — this tool has no wait/poll mechanism (out
    of scope; a synchronous CLI command blocking on a running CI job is a
    materially bigger feature nobody asked for) — it is graded
    undeterminable, with its own distinct wording, so it isn't confused
    with "no CI at all."

    CI_STATUS_UNDETERMINABLE fires when: `gh` isn't installed/
    authenticated or this isn't a GitHub repository (the subprocess call
    itself fails); no CI is configured at all for this commit (see below);
    or every run found is still pending. Per this Req's own explicit
    instruction, undeterminable is NOT treated as red — a project with no
    CI, or CI this tool can't see, must not become unshippable by
    accident.

    Sprint 28, Req 1: "no runs exist yet for this exact commit" used to be
    a single undeterminable case, and it isn't one — it conflates "no CI
    configured" (benign) with "workflows exist and produced nothing for
    this commit" (not benign: indistinguishable from a pipeline broken
    badly enough to never even start, which is a real incident this
    project shipped over silently). workflows_configured_at(commit_sha)
    (above) is the split: no workflow files in this commit's own tree
    stays CI_STATUS_UNDETERMINABLE with the same benign wording as
    before; workflow files present but zero runs found for this commit
    is graded CI_STATUS_RED — reusing the existing refuse-and-say-why
    path in both callers below rather than inventing a fourth status, so
    "distinguished in behaviour, not only in wording" (this Req's own
    acceptance criterion) falls out of the existing branches for free.

    Both callers — cmd_ship AND cmd_reship (Req 4, added mid-flight once QA1 named the gap: a
    reshipped commit has never been through QA1's static audit at all,
    so exempting it here would give the least-audited path the least
    mechanical scrutiny) — print this as a warning and proceed; neither
    gates on it. Keep both callers consistent if this function's own
    grading ever changes; two call sites giving different answers to the
    same question is exactly the defect Req 4 exists to remove.

    Every subprocess call here is wrapped the same way
    git_tree_hash_excluding() and git_commit_sha() already are —
    (CalledProcessError is never raised, `check` is never passed, but
    FileNotFoundError/OSError are caught) — because `gh` simply not being
    installed at all (not just unauthenticated, or the wrong repo) is a
    real, ordinary case for a downstream project, and it must degrade to
    undeterminable exactly like every other unreachable-CI case, never an
    unhandled crash taking `cmd_ship` down with it. A 30s timeout on each
    call exists for the same reason `resolve_text()`'s file-read failures
    get a legible message instead of hanging forever: a network-touching
    command that can hang must not be able to wedge Pipeman's whole ship
    step waiting on it."""
    try:
        probe = subprocess.run(  # nosec B603 B607
            ["gh", "run", "list", "--commit", commit_sha, "--limit", "20",
             "--json", "databaseId,conclusion,status,workflowName,name"],
            cwd=ROOT, capture_output=True, text=True, timeout=30,
        )
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as exc:
        return (CI_STATUS_UNDETERMINABLE,
                f"could not run gh to query CI runs for {commit_sha} ({exc}) — gh may not be "
                "installed, or the query timed out.")
    if probe.returncode != 0:
        reason = (probe.stderr or "").strip() or "gh run list failed"
        return (CI_STATUS_UNDETERMINABLE,
                f"could not query CI runs for {commit_sha} ({reason}) — gh may not be "
                "installed or authenticated, or this may not be a GitHub repository.")
    try:
        runs = json.loads(probe.stdout or "[]")
    except json.JSONDecodeError:
        return (CI_STATUS_UNDETERMINABLE, f"gh run list returned unparseable output for {commit_sha}.")
    if not runs:
        # Sprint 28, Req 1: the split. workflows_configured_at() answers
        # from the commit's own tree, no API call, can't fail for network
        # reasons — see that function's own docstring for why it's
        # preferred over asking `gh` the same question.
        if not workflows_configured_at(commit_sha):
            return (CI_STATUS_UNDETERMINABLE,
                    f"no CI runs found for commit {commit_sha}, and no CI is configured "
                    "(.github/workflows/ is empty or absent in this commit's own tree) — benign, "
                    "this project has no CI for this tool to see.")
        return (CI_STATUS_RED,
                f"workflows are configured (.github/workflows/ is non-empty in commit {commit_sha}'s "
                "own tree) but gh found zero runs for this exact commit — indistinguishable from a "
                "pipeline broken badly enough to never even start (a bad trigger condition, a "
                "workflow-syntax error, CI not yet caught up). Not treated as benign undeterminable: "
                "unlike 'no CI configured', this is exactly what a silently broken pipeline looks "
                "like. If CI genuinely hasn't had time to start yet, wait for it and retry.")

    problems = []
    pending = []
    for run in runs:
        label = run.get("workflowName") or run.get("name") or str(run.get("databaseId"))
        status = run.get("status")
        conclusion = run.get("conclusion")
        if status != "completed":
            pending.append(f"{label}: still {status or 'unknown'}")
            continue
        if conclusion != "success":
            problems.append(f"{label}: concluded {conclusion or 'unknown'}")
            continue
        run_id = run.get("databaseId")
        try:
            view = subprocess.run(  # nosec B603 B607
                ["gh", "run", "view", str(run_id), "--json", "jobs"],
                cwd=ROOT, capture_output=True, text=True, timeout=30,
            )
        except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as exc:
            problems.append(f"{label}: could not inspect its jobs to confirm steps actually executed ({exc})")
            continue
        if view.returncode != 0:
            problems.append(f"{label}: could not inspect its jobs to confirm steps actually executed")
            continue
        try:
            jobs = json.loads(view.stdout or "{}").get("jobs", [])
        except json.JSONDecodeError:
            problems.append(f"{label}: job detail was unparseable")
            continue
        if not jobs:
            problems.append(f"{label}: reported success but has no jobs recorded")
            continue
        for job in jobs:
            steps = job.get("steps") or []
            # GitHub Actions itself always injects "Set up job" and
            # "Complete job" (and a "Post <action>" cleanup step per
            # `uses:` action) — confirmed against a real run's own step
            # list, not assumed. Those succeed trivially even when EVERY
            # step the workflow's own author actually defined was skipped
            # (a misconfigured `if:`, an empty job) — checking for "any
            # non-skipped completed step" without excluding them would
            # make this check pass on precisely the case it exists to
            # catch, since "Set up job" alone already satisfies it. Real
            # work means something OTHER than these synthetic bookends
            # actually ran.
            real_steps = [
                s for s in steps
                if s.get("name") not in ("Set up job", "Complete job")
                and not str(s.get("name", "")).startswith("Post ")
            ]
            executed = [
                s for s in real_steps
                if s.get("status") == "completed" and s.get("conclusion") not in ("skipped", None)
            ]
            if not executed:
                problems.append(f"{label} / {job.get('name', '?')}: reported success but no real step actually executed (only setup/teardown, or everything skipped)")

    if problems:
        return (CI_STATUS_RED, "; ".join(problems))
    if pending:
        return (CI_STATUS_UNDETERMINABLE,
                f"CI run(s) for {commit_sha} exist but have not finished yet: "
                f"{'; '.join(pending)}. This check does not wait for a run to complete — "
                "re-run /sprint-ship once it has finished.")
    return (CI_STATUS_GREEN,
            f"{len(runs)} CI run(s) for {commit_sha} all completed successfully with real steps executed.")


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
            die(f"{ROOT} is not a git repository. Run this from inside a real git repository - "
                "there is nothing here for --commit to resolve against.")

        shipped_tree = git_tree_hash_excluding(args.commit, SHIP_HASH_EXCLUDE_PATTERNS) if args.commit else None
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
            die(f"'{args.commit}' resolved a tree hash but not a full commit SHA - "
                "unexpected, please investigate before shipping.")

        # Sprint 28, Req 2: nothing checked, before this, that the commit
        # being recorded as shipped is actually reachable from the branch
        # being pushed. pipeman.md's documented flow pushes shipped_commit
        # to remote BEFORE this command runs (see the comment just below),
        # so at this point it should already be part of local HEAD's
        # history — a stale/typo'd --commit, or a rebase/reset landing
        # between the push and this command, are exactly the cases this
        # catches. Checked BEFORE last_shipped_commit is ever written
        # (this Req's own ordering requirement), against local HEAD, since
        # that's what pipeman.md's flow pushes.
        if not is_commit_reachable(shipped_commit, "HEAD"):
            die(f"Sprint {args.id}: {shipped_commit} is not reachable from HEAD — it is not an "
                "ancestor of the branch you're about to push (or you're not on that branch). A "
                "commit already unreachable at ship time must never become last_shipped_commit. "
                "Confirm you're on the right branch and --commit is correct. No override.")

        # Sprint 24, Req 2: by this point pipeman.md's own documented flow
        # has already pushed shipped_commit to remote (step 6, before
        # /sprint-ship is even run in step 8) — so a CI run for this exact
        # commit either exists or has had the chance to start. pipeman.md
        # step 3 already told Pipeman to "check the CI/CD pipeline status,
        # all checks green" — prose nothing enforced, which is exactly how
        # a two-day-red build shipped: Pipeman found it only by going to
        # look afterwards. This is that check made mechanical.
        ci_status, ci_detail = check_ci_status(shipped_commit)
        if ci_status == CI_STATUS_RED:
            die(f"Sprint {args.id}: CI is red for the exact commit being shipped "
                f"({shipped_commit}): {ci_detail} Fix CI and land a green run for this "
                "commit before shipping. No override.")
        elif ci_status == CI_STATUS_UNDETERMINABLE:
            print(f"WARNING: could not determine CI status for {shipped_commit}: {ci_detail} "
                  "Shipping anyway — an undeterminable status is not treated as red (Req 2, "
                  "sprint 24): a project with no CI, or CI this tool can't see, must not "
                  "become unshippable by accident.", file=sys.stderr)
        else:
            print(f"CI check: {ci_detail}")

        state["phase"] = LIVEQA_PHASE
        state["last_shipped_commit"] = shipped_commit
        log_event(state, "pipeman", "shipped", f"commit={args.commit or ''} | ci={ci_status}: {ci_detail}")
        save_state(args.id, state)
    # Sprint 15, Req 4: shipped_commit (the resolved SHA, already computed
    # above and what's actually stored as last_shipped_commit) rather than
    # args.commit (the raw ref Pipeman typed — often literally "HEAD").
    # LiveQA's --deployed-commit has to match last_shipped_commit exactly;
    # printing "HEAD" here left no way to read back which real commit that
    # was without going and looking at the state file by hand.
    print(f"Sprint {args.id}: shipped (commit {shipped_commit}). Phase: {LIVEQA_PHASE}.")
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
            die(f"{ROOT} is not a git repository. Run this from inside a real git repository - "
                "there is nothing here for --commit to resolve against.")
        reshipped_commit = git_commit_sha(args.commit) if args.commit else None
        if reshipped_commit is None:
            die(f"'{args.commit or ''}' does not resolve to a real commit in this repo. "
                "--commit must be an actual commit hash Pipeman is about to push.")

        # Sprint 24, Req 4 (added mid-flight, on QA1's own carried
        # question): the identical check cmd_ship runs, same reasoning.
        # Req 2 as originally written named /sprint-ship only, which was a
        # correct reading of the text and the wrong place to stop — a
        # reshipped commit carries STRICTLY LESS verification than a
        # shipped one (it has never been through QA1's static audit at
        # all, see this function's own opening comment), so exempting it
        # from the CI check would mean the least-audited path gets the
        # least mechanical scrutiny, the exact inversion of what this
        # sprint exists to fix. Same three outcomes, same undeterminable-
        # status decision, applied consistently rather than decided twice.
        ci_status, ci_detail = check_ci_status(reshipped_commit)
        if ci_status == CI_STATUS_RED:
            die(f"Sprint {args.id}: CI is red for the exact commit being reshipped "
                f"({reshipped_commit}): {ci_detail} Fix CI and land a green run for this "
                "commit before reshipping. No override.")
        elif ci_status == CI_STATUS_UNDETERMINABLE:
            print(f"WARNING: could not determine CI status for {reshipped_commit}: {ci_detail} "
                  "Reshipping anyway — an undeterminable status is not treated as red (Req 2/4, "
                  "sprint 24): a project with no CI, or CI this tool can't see, must not "
                  "become unshippable by accident.", file=sys.stderr)
        else:
            print(f"CI check: {ci_detail}")

        state["last_shipped_commit"] = reshipped_commit
        log_event(state, "pipeman", "reshipped", f"commit={args.commit or ''} | ci={ci_status}: {ci_detail}")
        save_state(args.id, state)
    # Sprint 15, Req 2: says, at the moment reship runs (not buried in an
    # agent file nobody re-reads mid-loop), that this exact commit is
    # unaudited and that the live-loop audit exists for it — sprint 7's own
    # lesson, that naming a thing at the point of the wrong conclusion is
    # what works. Deliberately does NOT say LiveQA's retest checks the same
    # thing QA1 would: that conflation has reached three separate handoffs
    # despite the code never having said it, per this requirement's own
    # note, so this is worded to foreclose it rather than merely avoid
    # repeating it. reshipped_commit (resolved), not args.commit (the raw
    # ref) — the same fix Req 4 makes to cmd_ship's print, incidental here
    # (not itself asked for) but the identical bug on the identical line
    # this requirement already has open, so fixed rather than left for a
    # future sprint to rediscover.
    print(f"Sprint {args.id}: fix reshipped (commit {reshipped_commit}). "
          "This commit has NOT been through QA1's static audit -- LiveQA's live test is a "
          "different check of different things, not a substitute for one. If QA1 wants to "
          "look at this commit, /sprint-qa1 will record a live-loop audit while this sprint "
          "stays in the fix loop; it is a record, not a gate, and does not replace the retest "
          "below. LiveQA: re-test and run /sprint-liveqa again.")


def npm_registry_view(package: str, version: str) -> Optional[dict]:
    """Sprint 13, Req 2: a real, network read of the public npm registry
    via `npm view <package>@<version> --json` — never asserted by whoever
    is reporting, per this requirement's own instruction. Returns the
    parsed dict (which includes `gitHead` when the registry has one, and
    always includes `dist.shasum`/`dist.tarball` for a real published
    version), or None on any failure: npm missing, no network, the
    version not actually published, or output that doesn't parse as JSON.
    A verification helper must never crash the CLI for any of those."""
    try:
        result = subprocess.run(  # nosec B603 B607
            ["npm", "view", f"{package}@{version}", "--json"],
            capture_output=True, text=True, check=True, timeout=30,
        )
        return json.loads(result.stdout)
    except (subprocess.CalledProcessError, FileNotFoundError, OSError,
            json.JSONDecodeError, subprocess.TimeoutExpired):
        return None


def pack_commit_shasum(commit: str) -> Optional[str]:
    """Sprint 13, Req 2's content-based fallback for when the registry has
    no `gitHead` to compare — confirmed absent entirely on 0.1.11, likely
    from publishing off a linked git worktree rather than a real clone.
    Packs `commit`'s own tree — not the working tree, not HEAD, exactly
    the commit named — via `git archive` into a throwaway directory, runs
    `npm pack` there, and returns the shasum npm itself computes for the
    result. That's directly comparable to the registry's own dist.shasum,
    since dist.shasum records npm's identical computation performed at
    publish time — a stronger proof than gitHead ever was: it confirms
    the published bytes, not just a commit reference that may or may not
    have been stamped correctly.

    `git archive` rather than a real checkout or worktree: no .git
    directory is needed for `npm pack` to run, and this avoids touching
    the git worktree subsystem at all for what is fundamentally a
    read-only export — sprint 12's own worktree was found gone entirely
    partway through that sprint, worth not depending on that subsystem
    here if a plain archive does the job.

    Returns None on any failure (no git, no npm, no tar, the commit
    doesn't resolve, npm pack itself fails) rather than raising — a
    verification helper must never crash the CLI."""
    if shutil.which("npm") is None or shutil.which("tar") is None:
        return None
    tmp = tempfile.mkdtemp(prefix="fc-verify-publish-")
    try:
        try:
            archive = subprocess.run(  # nosec B603 B607
                ["git", "archive", "--format=tar", commit],
                cwd=ROOT, capture_output=True, check=True, timeout=30,
            )
        except (subprocess.CalledProcessError, FileNotFoundError, OSError,
                subprocess.TimeoutExpired):
            return None
        try:
            subprocess.run(  # nosec B603 B607
                ["tar", "-x", "-C", tmp],
                input=archive.stdout, capture_output=True, check=True, timeout=30,
            )
        except (subprocess.CalledProcessError, FileNotFoundError, OSError,
                subprocess.TimeoutExpired):
            return None
        try:
            pack = subprocess.run(  # nosec B603 B607
                ["npm", "pack", "--pack-destination", tmp, "--json"],
                cwd=tmp, capture_output=True, text=True, check=True, timeout=60,
            )
            pack_info = json.loads(pack.stdout)
            return pack_info[0]["shasum"]
        except (subprocess.CalledProcessError, FileNotFoundError, OSError,
                json.JSONDecodeError, KeyError, IndexError, subprocess.TimeoutExpired):
            return None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def cmd_verify_publish(args) -> None:
    """Sprint 13, Req 2 (Finding B), made mechanical rather than a
    reporting instruction — sprint 9 fixed the equivalent gap with prose
    in pipeman.md and it drifted on the very next release (0.1.10 needed
    the post-hoc gitHead correction sprint 9 was built to eliminate).
    This reads the registry itself and prints a definitive result; it
    does not ask a role to run `npm view` by hand and assert what they
    saw.

    THE DETERMINATION THIS REQUIREMENT ASKED FOR, from actually reading
    cmd_liveqa rather than reasoning about it: cmd_liveqa's own
    --deployed-commit check is a PURE LOCAL IDENTITY comparison against
    state["last_shipped_commit"] — the exact commit SHA Pipeman named via
    --commit at ship/reship time. It never reads the npm registry and
    never needs gitHead to be present, correct, or even published at all
    to do its job. The registry-gitHead question this command answers is
    a SEPARATE, additional confidence check every sprint's LiveQA
    criteria have asked for in prose ("confirm gitHead matches
    last_shipped_commit, from npm view") — real and worth answering
    mechanically, but not something cmd_liveqa's own gate depends on.

    Primary check: if the registry has gitHead, compare it to
    last_shipped_commit exactly — a real, disk-based value now, not an
    instruction to eyeball one.

    Fallback, when gitHead is absent (recorded as a stated fact, not an
    error — sprint 9's post-hoc correction may turn out to be the correct
    workflow rather than a defect, and this command says which, plainly,
    rather than presupposing): pack_commit_shasum() against the
    registry's own dist.shasum.

    Neither outcome is a gate — this command only reports and records via
    log_event(); it never changes phase or blocks anything downstream.
    Sprint 13's Req 2 asked for a first-class step, not a new refusal.

    The slow parts (a network call, and possibly a full `npm pack`) run
    BEFORE this takes the sprint's lock, deliberately — holding a lock
    across a network round-trip would block every other command against
    this sprint for however long the registry takes to answer. The lock
    is only held for the final read-modify-write of the state file, with
    a fresh load right before it, so a concurrent ship/reship that landed
    during the slow part is never silently overwritten by a stale copy of
    `state` read before this command's own network calls even started."""
    # Read-only, unlocked: matches cmd_status's own "reads don't need the
    # lock" precedent, and this needs last_shipped_commit only to know
    # WHAT to verify, not to mutate anything yet.
    state = load_state(args.id)
    last_shipped = state.get("last_shipped_commit")
    if last_shipped is None:
        die(f"Sprint {args.id} has no shipped commit on record - run /sprint-ship "
            "(or /sprint-reship) first, there is nothing here yet to verify against the "
            "registry.")

    # Sprint 24, Req 3: this reads last_shipped_commit to decide what to
    # verify against the registry — exactly the kind of read the warning
    # exists for. Warns, never gates: see origin_ahead_of_record_warning().
    origin_drift = origin_ahead_of_record_warning(last_shipped)
    if origin_drift:
        print(origin_drift)

    package = args.package
    if not package:
        pkg_json_path = ROOT / "package.json"
        try:
            package = json.loads(pkg_json_path.read_text(encoding="utf-8"))["name"]
        except (OSError, json.JSONDecodeError, KeyError):
            die("Could not read a package name from package.json, and none was given via "
                "--package. Pass --package explicitly.")

    version = args.version
    if not version:
        try:
            pkg_json_raw = subprocess.run(  # nosec B603 B607
                ["git", "show", f"{last_shipped}:package.json"],
                cwd=ROOT, capture_output=True, text=True, check=True, timeout=15,
            ).stdout
            version = json.loads(pkg_json_raw)["version"]
        except (subprocess.CalledProcessError, FileNotFoundError, OSError,
                json.JSONDecodeError, KeyError, subprocess.TimeoutExpired):
            die(f"Could not read package.json's version from the shipped commit "
                f"({last_shipped}), and none was given via --version. Pass --version explicitly.")

    registry = npm_registry_view(package, version)
    if registry is None:
        die(f"Could not read {package}@{version} from the npm registry - not published yet, "
            "npm isn't available, or there's no network from here. Nothing to verify against.")

    event_name = "gitHead_check"
    registry_git_head = registry.get("gitHead")
    if registry_git_head:
        if registry_git_head == last_shipped:
            detail = (f"MATCH: registry gitHead={registry_git_head} == "
                      f"last_shipped_commit={last_shipped} for {package}@{version}.")
        else:
            detail = (f"MISMATCH: registry gitHead={registry_git_head} != "
                      f"last_shipped_commit={last_shipped} for {package}@{version}.")
    else:
        event_name = "content_check"
        # gitHead absent — a stated fact, not an error, then the content
        # fallback, printed as its own line so it's visible even though
        # only the final `detail` line below gets logged to history.
        print(f"Registry has no gitHead recorded for {package}@{version} "
              "(a real, published fact, not an error here - likely a linked-worktree "
              "publish; falling back to content verification, which is the stronger "
              "proof anyway).")
        registry_shasum = (registry.get("dist") or {}).get("shasum")
        if not registry_shasum:
            detail = (f"INCONCLUSIVE: {package}@{version} has neither gitHead nor a "
                      "readable dist.shasum on the registry — nothing here to verify against.")
        else:
            local_shasum = pack_commit_shasum(last_shipped)
            if local_shasum is None:
                detail = (f"INCONCLUSIVE: could not pack commit {last_shipped} locally to "
                          f"compare against registry dist.shasum={registry_shasum} "
                          "(npm/git/tar unavailable, or packing itself failed).")
            elif local_shasum == registry_shasum:
                detail = (f"MATCH (content): packing commit {last_shipped} locally "
                          f"produces shasum={local_shasum}, identical to the registry's "
                          f"dist.shasum for {package}@{version}. No gitHead needed — the "
                          "published bytes are confirmed to be exactly this commit's content.")
            else:
                detail = (f"MISMATCH (content): packing commit {last_shipped} locally "
                          f"produces shasum={local_shasum}, but the registry's dist.shasum "
                          f"for {package}@{version} is {registry_shasum}. What's published "
                          "does not match what was shipped.")

    print(detail)
    with locked(f"sprint-{args.id}"):
        # Fresh load: state may have moved on (a reship, another
        # verify-publish run) during the network/pack work above.
        current_state = load_state(args.id)
        log_event(current_state, "verify-publish", event_name, detail)
        save_state(args.id, current_state)


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
            die(f"{ROOT} is not a git repository. Run this from inside a real git repository - "
                "there is nothing here for --deployed-commit to resolve against.")

        # Sprint 24, Req 1: WAS a pure identity check ("no legitimate
        # rebase/squash step between shipping and deploying that would
        # need tolerating here"). That was wrong for the shape of drift
        # this Req exists to fix: on any target that deploys from a
        # branch, the served commit is routinely the SHIPPED commit plus
        # Pipeman's own bookkeeping landing on top of it (see cmd_ship's
        # own comment above) — a real, legitimate, expected step, not an
        # anomaly. What this check was protecting is unchanged and still
        # protects it: a mismatch must still mean this live test ran
        # against something genuinely OTHER than what Pipeman shipped — a
        # real different deployment, a stale one, the wrong environment.
        # What changes is that bookkeeping-only drift is no longer treated
        # as "something other". Reuses git_tree_hash_excluding() and
        # SHIP_HASH_EXCLUDE_PATTERNS — sprint 13 already carried this exact
        # reasoning through a FAIL-level audit on the ship side (does a
        # rebase/squash that preserves content still ship); this is a
        # second call site for that same, already-audited mechanism, not a
        # new one, per this Req's own explicit instruction not to build a
        # second.
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
            deployed_tree = git_tree_hash_excluding(deployed_commit, SHIP_HASH_EXCLUDE_PATTERNS)
            shipped_tree = git_tree_hash_excluding(last_shipped, SHIP_HASH_EXCLUDE_PATTERNS)
            if deployed_tree is None or shipped_tree is None or deployed_tree != shipped_tree:
                diffs = differing_paths_excluding(last_shipped, deployed_commit, SHIP_HASH_EXCLUDE_PATTERNS)
                if diffs:
                    where = "differs in: " + ", ".join(diffs)
                elif deployed_tree is None or shipped_tree is None:
                    where = "the content comparison itself could not be computed (a ref failed to resolve)"
                else:
                    where = "differs, but the exact paths could not be listed"
                die(f"Sprint {args.id}: the commit you tested ({deployed_commit}) doesn't match "
                    f"what Pipeman actually shipped ({last_shipped}), and it's not just "
                    f"bookkeeping — {where}. Re-test against what was actually deployed, or if "
                    "the wrong thing went out, Pipeman needs a fresh /sprint-ship or "
                    "/sprint-reship first. No override.")
            # Content matches — the exact commit differs only by
            # bookkeeping on top (or below/around) it. Accepted, and
            # recorded as such rather than silently treated as identical,
            # so the history shows what actually happened.
            print(f"Sprint {args.id}: deployed commit ({deployed_commit}) differs from "
                  f"last_shipped_commit ({last_shipped}) by identity, but their shipped "
                  "content is byte-identical (bookkeeping only). Accepted.")

        # Sprint 29, Req 3 (Finding B): this is also where the branch tip
        # moving off last_shipped_commit DURING the live gate gets
        # detected — any push (by any role, on any sprint) moves the one
        # branch tip the deploy platform tracks, and the docs-only case
        # (Finding B's own motivating incident: a commit touching only
        # docs/sprints/, inside sprint 13's ship-hash exclusion, so no
        # content comparison anywhere could ever see it) is exactly what
        # this catches, since git rev-list/log counts commits, not paths.
        #
        # THE DECISION, STATED RATHER THAN DEFAULTED: THIS WARNS, IT DOES
        # NOT REFUSE. A refusal's recovery is a reship (Req 3's own named
        # cost), and the true rate of "something landed on origin since
        # ship" is high by this framework's own design — Dev Team 2's
        # worktrees, headless Pipeman instances, and ordinary parallel
        # sprints all push to the SAME shared branch, so refusing here
        # would make LiveQA unable to record a verdict on almost any
        # sprint that isn't the only one in flight, the same
        # unworkable-for-its-own-model failure Req 1/2's FAIL-level
        # criteria exist to prevent for the cross-tree warning. A warning
        # is not "too weak for a gate whose job is testing what is
        # deployed" (the risk this Req names) BECAUSE this gate's actual
        # identity/content check just above already refuses on any REAL
        # content mismatch between --deployed-commit and last_shipped —
        # this warning's only job is the residual case content can't
        # cover: origin has moved further than what was even tested,
        # regardless of whether that content matched. Recording that
        # fact, naming the commits, is proportionate; blocking every such
        # verdict is not.
        origin_warning = origin_ahead_of_record_warning(last_shipped)
        if origin_warning:
            print(origin_warning)

        # Sprint 27, Req 3: RECORDS a sprint file changed since QA1's PASS.
        # Does NOT refuse. This is deliberately asymmetric with
        # cmd_dev_done's own hash gate (which DOES refuse, no override) —
        # stated here, not just in the sprint file, because a future
        # reader must see this was decided, not overlooked (Out of Scope:
        # "A symmetric hash gate at liveqa_live. Rejected on reasoning both
        # projects arrived at independently").
        #
        # WHY REFUSE THERE BUT NOT HERE: cmd_dev_done's refusal has a cheap
        # recovery — re-run /sprint-qa1, then /sprint-dev-done again, both
        # in the same sitting, no live test involved yet. A refusal HERE
        # would cost a full lap instead: CONDITIONAL, back to dev_build, a
        # fresh gate-1 audit, dev-done, a reship, another live round — for
        # what is very often a legitimate prose amendment (an
        # unsatisfiable acceptance criterion, an unbuildable requirement,
        # discovered exactly where a Master Controller reading this file
        # during the live-test window would find it). A refusal whose only
        # recovery is disproportionate to the change makes the honest,
        # recorded amendment more expensive than a quiet, unrecorded one —
        # the exact failure mode this records-not-refuses shape exists to
        # avoid, per this project's own transition-precondition rule (the
        # role that hits a precondition must be able to clear it cheaply,
        # or the precondition needs a real recovery path; here there is no
        # cheap recovery to offer, so this isn't a precondition at all).
        #
        # WHAT RE-GATING WOULD ACTUALLY COST, checked against the code
        # rather than assumed (Req 3's own instruction): a QA1 verdict
        # recorded here — via /sprint-qa1 while this sprint sits in
        # LIVEQA_PHASES — is an OPINION, not a re-gate. Confirmed directly:
        # cmd_qa1's own phase dispatch (`if state["phase"] in
        # LIVE_LOOP_AUDIT_PHASES: _qa1_live_loop_audit(args, state);
        # return`) returns immediately for a sprint in this phase and never
        # reaches the gate-1 logic below it that writes qa1_audit_result,
        # qa1_audit_file_hash, or qa1_audited_tree_hash.
        # _qa1_live_loop_audit()'s own docstring states, and its own body
        # confirms, that log_event() is its ONLY mutation of state —
        # nothing in this codebase can silently repair the gate-1 hash
        # from inside the live-test loop; only a fresh, real gate-1 audit,
        # after this sprint returns to dev_build, can.
        sprint_file_drift = None
        audited_hash = state.get("qa1_audit_file_hash")
        if audited_hash is not None:
            current_hash = file_hash(registry_sprint_file(args.id))
            if current_hash is not None and current_hash != audited_hash:
                sprint_file_drift = (
                    f"NOTE: sprint {args.id}'s file has changed since QA1's PASS "
                    f"(audited hash {audited_hash[:12]}..., current {current_hash[:12]}...). "
                    "Recorded, not refused — see this function's own comment for why. If this "
                    "sprint's own acceptance criteria changed for a real reason, that's worth a "
                    "fresh /sprint-qa1 look once the live-test loop settles; if it was a "
                    "cosmetic edit, this note is the whole record of it."
                )

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
        if sprint_file_drift:
            # A separate history event, distinguishable from the live_test
            # verdict itself — this is a fact about the file, not part of
            # what was tested.
            log_event(state, "liveqa", "sprint_file_drift_since_audit", sprint_file_drift)
            print(sprint_file_drift)

        if verdict == "PASS":
            state["phase"] = "complete_ready"
            print(f"LiveQA live test PASSED (round {state['live_test_rounds']}). "
                  f"Sprint {args.id} is complete-ready.")
            print("Dev Team: tell the user the sprint is ready and wait. "
                  "/sprint-complete requires the user's explicit, real-time "
                  "go-ahead (--user-said) - both gates passing is not that.")
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
    """Sprint 33: the lifecycle's most destructive action -- moves the file
    to 5-abandoned, marks the registry, burns the sprint id, makes
    re-filing a human act -- used to have strictly less protection than
    /sprint-complete, the least destructive one. Three defects, all fixed
    here.

    Req 1: the actor is no longer a hardcoded "human". Every other
    command in this file logs a fixed string because each one is only
    ever run by one specific role (cmd_ship -> "pipeman", cmd_complete ->
    "dev-team"); abort has no such owner -- Out of Scope names exactly
    why: every role's headless profile grants
    Bash(python3 scripts/sprint_lifecycle.py *), so every role reaches
    every subcommand, abort included. A fixed string here would just
    replace one wrong assertion with another. CLAUDE_CODE_AGENT is this
    file's own established way of asking "which role is actually running
    right now" (see save_state()'s last_claim, sprint 25) -- reused here
    for the identical question, on the identical footing as every other
    command's actor: a truthful statement of who acted, not a guess.

    Req 2: --user-said, same mechanical shape and same non-overridability
    as cmd_complete's own gate -- checked before the lock and before any
    state or file mutation, argument validation independent of sprint
    state. No flag, environment variable, or code path bypasses it.

    Req 5: the refusal names the Req 4 alternative by its actual command,
    not "see the docs" -- a role that hit this gate because IT (not a
    human) determined the sprint isn't buildable has somewhere to go
    without reading anything else, which is what makes gating abort
    admissible under this framework's own transition-precondition rule
    (a precondition must be clearable by the role that hits it, or ship
    with a documented cross-role recovery path -- this is the former).

    Req 3: --reason is now required and non-empty, same ordering as
    --user-said. "(none given)" can no longer be produced."""
    user_said = resolve_text(args.user_said, args.user_said_file)
    if not user_said.strip():
        die("--user-said is required and must be non-empty. Quote what the user actually told "
            "you, in this session, that authorizes abandoning this sprint right now -- this is "
            "the lifecycle's most destructive action: it moves the file to 5-abandoned, marks "
            "the registry, burns the sprint id, and makes re-filing a human act. No override "
            "exists for this check. If a ROLE, not a human, has determined this sprint isn't "
            "buildable, that determination is not grounds to abort it yourself -- run "
            f"`/sprint-block {args.id} --reason \"...\"` instead, which returns the sprint to "
            "the planner with your analysis intact, without destroying anything.")

    reason = resolve_text(args.reason, args.reason_file)
    if not reason.strip():
        die("--reason is required and must be non-empty. A sprint may not be abandoned without "
            "a stated cause.")

    actor = os.environ.get("CLAUDE_CODE_AGENT") or "unknown"
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
            log_event(state, actor, "aborted", reason)
            save_state(args.id, state)
    print(f"Sprint {args.id} aborted. Reason: {reason}")


def cmd_block(args) -> None:
    """Sprint 33, Req 4: the non-destructive alternative to abort, for a
    role that correctly determines a sprint is not currently buildable
    (real content doesn't exist, a required decision is unmade) without
    that being grounds to abandon it. Returns the sprint to the planner:
    the sprint id is preserved (never burned), the file is not moved to
    5-abandoned, and the role's own stated analysis is recorded in
    history where Master Controller can read it to repair the file --
    "this sprint is not buildable and here is why" is exactly what
    abandoning used to throw away.

    Moves the file to 4-blocked/, mirroring every sibling transition's
    own established pattern (new -> todo, start -> in_progress, complete
    -> done, abort -> abandoned) -- STATUS_FOLDERS["blocked"] has existed
    since this constant was defined and nothing had ever used it.
    Re-filing is already free: cmd_start() has no phase guard and always
    moves whatever the registry currently points at into 2-in-progress/,
    so /sprint-start <id> on a blocked sprint works unchanged, once
    Master Controller has read the analysis and fixed the file (Req 6).

    Same actor derivation as cmd_abort, for the identical reason -- this
    command has no single owning role either. No --user-said: blocking
    is not destructive, so it does not carry cmd_complete/cmd_abort's
    human-authorization gate, only a required, non-empty analysis of
    why."""
    reason = resolve_text(args.reason, args.reason_file)
    if not reason.strip():
        die("--reason is required and must be non-empty. State the analysis of why this sprint "
            "isn't currently buildable -- this is what Master Controller reads to repair it, and "
            "it is the whole point of blocking rather than abandoning.")

    actor = os.environ.get("CLAUDE_CODE_AGENT") or "unknown"
    with locked("registry"), locked(f"sprint-{args.id}"):
        reg = load_registry()
        entry = reg["sprints"].get(str(args.id))
        if not entry:
            die(f"Sprint {args.id} not found in registry.")

        src = ROOT / entry["file"]
        dest_dir = SPRINTS_DIR / STATUS_FOLDERS["blocked"]
        dest_dir.mkdir(parents=True, exist_ok=True)
        if src.exists():
            dest = dest_dir / src.name
            if src != dest:
                shutil.move(str(src), str(dest))
                entry["file"] = str(dest.relative_to(ROOT))
            update_frontmatter_status(dest, "blocked")
        entry["status"] = "blocked"
        save_registry(reg)

        state = load_state(args.id)
        state["phase"] = "blocked"
        log_event(state, actor, "blocked", reason)
        save_state(args.id, state)
    print(f"Sprint {args.id} blocked, returned to the planner. Sprint id and analysis preserved, "
          "nothing moved to 5-abandoned.")
    print(f"Analysis: {reason}")
    print("Master Controller: read the analysis above (or /sprint-status "
          f"{args.id} --verbose), repair the sprint file, then Dev Team runs /sprint-start "
          f"{args.id} again to resume building.")


DONE_FILENAME_SUFFIX = "--done"  # matches cmd_complete's own src.stem + "--done" + src.suffix


def cmd_rename(args) -> None:
    """Sprint 25, Req 4: updates the registry entry, the sprint file's own
    frontmatter, and the filename together -- the three things hand-editing
    the registry (forbidden, see CLAUDE.md) would otherwise have to keep in
    sync by hand. This repo's own sprint 18 is the motivating instance
    named in the sprint file: its title stopped describing it once its
    first requirement was absorbed into another sprint, and there was no
    command to fix it, so Master Controller recorded the title as
    historical in Dependencies rather than correcting it where a reader
    would actually see it first.

    PRESERVES THE ORIGINAL TITLE (Req 4's own instruction): the registry
    entry and the frontmatter both gain an `original_title` field, set
    ONCE, on the FIRST rename, and never overwritten by a later one -- so
    it always names the sprint's true original title, not merely "the
    title before this particular rename." A sprint renamed twice still
    shows what it was at creation, not just what it was most recently.

    DELIBERATELY DOES NOT TOUCH (Req 4's own named list): phase,
    qa1_audit_result, groundtruth_result, audit_rounds, live_test_rounds,
    history, or either recorded hash (qa1_audit_file_hash,
    qa1_audited_tree_hash). state["title"] IS updated, for the identical
    reason the registry's title is -- a title nobody can ever correct is
    the bug this Req exists to fix, and title is not one of the fields
    the Req's own list protects.

    THE HASH QUESTION, TESTED RATHER THAN ASSUMED (Req 4's own explicit
    instruction: "confirm the sprint-file hash gate behaves correctly
    across a rename... if renaming invalidates a recorded QA1 PASS, say so
    and decide whether that is right"). Confirmed directly, against a real
    scratch sprint (see scripts/smoke_test.sh's own sprint-25 rename
    tests): renaming a sprint that already has a QA1 PASS on record DOES
    cause the next /sprint-dev-done to refuse, because file_hash() (see
    cmd_qa1's own qa1_audit_file_hash) hashes the sprint file's raw bytes,
    and this command's own frontmatter rewrite (new title line, plus an
    inserted original_title line on a first rename) changes those bytes --
    the same way any other edit to an audited sprint file does.

    THE DECISION: this is correct, not a bug to work around, and no
    special-case exemption is carved out here. Every other content change
    to an audited sprint file already requires a fresh /sprint-qa1 look
    before /sprint-dev-done will proceed (see that function's own
    comment) -- a rename is a real edit to the exact file QA1 read, and
    this mechanism has no way to distinguish "cosmetic title change" from
    "the requirements actually changed" without a human's judgement,
    which is exactly what re-running QA1 provides. Renaming BEFORE a QA1
    PASS (the common case Context describes -- scope narrowing discovered
    during the build) has nothing to invalidate and is unaffected."""
    title = resolve_text(args.title, args.title_file)
    if not title:
        die("A new title cannot be empty.")

    with locked("registry"), locked(f"sprint-{args.id}"):
        reg = load_registry()
        entry = reg["sprints"].get(str(args.id))
        if not entry:
            die(f"Sprint {args.id} not found in registry.")

        src = ROOT / entry["file"]
        if not src.exists():
            die(f"Sprint {args.id}'s recorded file ({entry['file']}) does not exist on disk -- "
                "nothing here to rename. Investigate before retrying.")

        old_title = entry["title"]
        if title == old_title:
            die(f"Sprint {args.id} is already titled \"{title}\" -- nothing to rename.")
        # Set once, on the first rename; a later rename keeps naming the
        # TRUE original, never "whatever it was called before THIS rename."
        original_title = entry.get("original_title", old_title)

        slug = slugify(title)
        had_done_suffix = src.stem.endswith(DONE_FILENAME_SUFFIX)
        new_stem = f"sprint-{args.id}_{slug}" + (DONE_FILENAME_SUFFIX if had_done_suffix else "")
        dest = src.parent / f"{new_stem}{src.suffix}"
        if dest != src and dest.exists():
            die(f"Cannot rename: {dest.relative_to(ROOT)} already exists.")

        text = src.read_text(encoding="utf-8")
        updated, count = re.subn(
            r'(?m)^title:\s*".*?"\s*$', f'title: "{yaml_escape(title)}"', text, count=1
        )
        if count == 0:
            die(f"Could not find a title: line in {src.relative_to(ROOT)}'s frontmatter -- "
                "refusing to guess at a malformed sprint file rather than writing something wrong.")
        if not re.search(r"(?m)^original_title:", updated):
            # Inserted directly after the title: line -- a fixed,
            # predictable position on every renamed sprint from here on,
            # not appended wherever a regex happened to find room.
            updated = re.sub(
                r'(?m)(^title:\s*".*?"\s*$)',
                lambda m: m.group(1) + f'\noriginal_title: "{yaml_escape(original_title)}"',
                updated, count=1,
            )

        if dest != src:
            atomic_write(dest, updated)
            src.unlink()
        else:
            atomic_write(dest, updated)

        entry["title"] = title
        entry["original_title"] = original_title
        entry["file"] = str(dest.relative_to(ROOT))
        save_registry(reg)

        if state_path(args.id).exists():
            state = load_state(args.id)
            state["title"] = title
            save_state(args.id, state)

    print(f"Sprint {args.id} renamed: \"{old_title}\" -> \"{title}\".")
    print(f"  registry, frontmatter and filename updated: {dest.relative_to(ROOT)}")
    print(f"  original title preserved: \"{original_title}\"")
    print("  Phase, verdicts, hashes and history are untouched. If this sprint already has a "
          "recorded QA1 PASS, the sprint file's content just changed (the title/original_title "
          "lines did) -- the next /sprint-dev-done will correctly ask for a fresh /sprint-qa1 "
          "look first, the same as any other post-PASS edit to the file. This is expected, not "
          "a bug.")


def commit_patch_id(commit: str) -> Optional[str]:
    """Sprint 28, Req 3: a content-equivalence check for "is this the same
    patch, relocated" -- deliberately NOT git_tree_hash_excluding(), which
    answers a different question (see cmd_repoint()'s own docstring and
    Req 4). `git patch-id --stable` hashes a diff's actual content
    independent of the commit's parent or position in history, which is
    exactly the property a rebase/cherry-pick preserves and a tree hash
    does not (a relocated commit's resulting TREE differs from the
    original's by definition -- it now sits on a different base).
    `--stable` (not the default `git patch-id` mode) keeps the id stable
    across git versions/whitespace-context churn, per its own man page.

    ESTABLISHED BY RUNNING: `git show <commit> | git patch-id --stable`
    gives the SAME id for a commit and a cherry-picked copy of it onto a
    different base (confirmed directly, this sprint, in a scratch repo:
    identical patch-id for the original and a relocated copy carrying
    unrelated commits underneath it), and a DIFFERENT id for genuinely
    different content. `git show`'s own commit-message header above the
    diff does not confuse `git patch-id`, which parses only the diff
    hunks -- also confirmed directly rather than assumed from its man
    page.

    Returns None on any failure to compute one: the commit doesn't
    resolve, `git show`/`git patch-id` aren't available, or the diff is
    empty (a `git show` on a genuinely content-free commit produces no
    patch-id line -- rare, but real, and "no failure" would be the wrong
    signal to give a caller that exists specifically to refuse on
    anything it can't verify)."""
    try:
        shown = subprocess.run(  # nosec B603 B607
            ["git", "show", commit],
            cwd=ROOT, capture_output=True, text=True, check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return None
    try:
        patch_id_proc = subprocess.run(  # nosec B603 B607
            ["git", "patch-id", "--stable"],
            cwd=ROOT, input=shown.stdout, capture_output=True, text=True, check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return None
    line = patch_id_proc.stdout.strip()
    if not line:
        return None
    return line.split()[0]


def cmd_repoint(args) -> None:
    """Sprint 28, Req 3: recover a shipped commit orphaned by a rebase, by
    re-pointing last_shipped_commit at a commit whose git patch-id
    matches the orphaned one -- checked every time, never asserted, and
    refused (no override) on any mismatch or any failure to compute
    either patch-id at all. See commit_patch_id()'s own docstring for why
    patch-id, not a tree hash, is the right equivalence check here.

    NO PHASE RESTRICTION, unlike every other lifecycle transition in this
    file except cmd_rename (same precedent, same reasoning: this recovery
    exists BECAUSE the normal phase-gated paths have no way out here).
    Context Finding B is explicit that this surfaces on a COMPLETE
    sprint -- cmd_reship refuses there (LIVEQA_PHASES only, its whole
    reason for existing is the live-test fix loop), and hand-editing
    docs/sprints/state/ is forbidden. The only real precondition is that
    a last_shipped_commit already exists to re-point; nothing else to
    recover otherwise. This also means the same command works whether
    Pipeman meets this failure mid-liveqa_live or after the sprint is
    already complete -- one mechanism, not two.

    Req 4's own instruction, worth restating here since this is the one
    function that could quietly violate it: this does NOT touch, read, or
    call git_tree_hash_excluding() anywhere. The ship gate's tree
    comparison answers "is this what QA1 audited" and must keep doing
    that with trees, unchanged -- patch-id answers a genuinely different
    question ("is this the same work, relocated") and belongs only here,
    a separate command Pipeman chooses to run, never folded into
    /sprint-ship itself.

    Deliberately does NOT re-run any other check last_shipped_commit
    feeds (cmd_liveqa's deployed-commit comparison, cmd_status's
    origin-ahead warning) -- re-pointing the field is the whole job;
    whatever reads it next re-evaluates against the new value on its own,
    exactly as it would if last_shipped_commit had always held that
    value."""
    with locked(f"sprint-{args.id}"):
        state = load_state(args.id)
        old_commit = state.get("last_shipped_commit")
        if not old_commit:
            die(f"Sprint {args.id} has no last_shipped_commit on record -- nothing to re-point. "
                "This recovery is for a commit that WAS shipped and later became unreachable "
                "(a rebase, typically), not a substitute for /sprint-ship.")

        if not is_git_repository():
            die(f"{ROOT} is not a git repository. Run this from inside a real git repository - "
                "there is nothing here for --commit to resolve against.")

        new_commit = git_commit_sha(args.commit) if args.commit else None
        if new_commit is None:
            die(f"'{args.commit or ''}' does not resolve to a real commit in this repo. "
                "--commit must be the commit that now carries the same work, after the rebase.")

        if new_commit == old_commit:
            die(f"Sprint {args.id}'s last_shipped_commit is already {old_commit} -- nothing to "
                "re-point.")

        # Req 3's own FAIL-level criterion: a re-point succeeding on an
        # unmatched patch-id is a FAIL, not a CONDITIONAL. No override
        # exists on this branch, and none should be added.
        old_patch_id = commit_patch_id(old_commit)
        new_patch_id = commit_patch_id(new_commit)
        if old_patch_id is None or new_patch_id is None:
            die(f"Sprint {args.id}: could not compute a patch-id for both {old_commit} and "
                f"{new_commit} (old={old_patch_id}, new={new_patch_id}) -- refusing to re-point "
                "without a checked equivalence. If the old commit object no longer exists at all "
                "(pruned, not merely unreachable), there is nothing left here to verify against, "
                "and this recovery does not apply.")
        if old_patch_id != new_patch_id:
            die(f"Sprint {args.id}: {new_commit} is NOT the same patch as {old_commit} "
                f"(patch-id {new_patch_id} != {old_patch_id}). Refusing to re-point -- this "
                "recovery restores a path for a commit relocated by a rebase; it is not a way to "
                "point a completed sprint at different content. No override.")

        log_event(state, "pipeman", "repointed_shipped_commit",
                  f"old={old_commit} new={new_commit} patch_id={new_patch_id} (verified equal on "
                  "both commits via git patch-id --stable)")
        state["last_shipped_commit"] = new_commit
        save_state(args.id, state)
    print(f"Sprint {args.id}: last_shipped_commit re-pointed {old_commit} -> {new_commit}.")
    print(f"  patch-id {new_patch_id} confirmed equal on both commits -- recorded in history.")
    print("  The ship gate's own tree comparison is untouched by this command (Req 4); only "
          "last_shipped_commit changed.")


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
            current_tree = git_tree_hash_excluding(target_ref, SHIP_HASH_EXCLUDE_PATTERNS)
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
    # Sprint 29, Req 2: same reasoning as cmd_status's no-id branch —
    # computed once, reused across every sprint below.
    other_roots = _other_worktree_roots()
    for sid, entry in sorted(reg["sprints"].items(), key=lambda kv: int(kv[0])):
        print(f"{sid:>3}  {entry['status']:<12} {entry['title']}")
        if other_roots:
            divergence = state_divergence_warning(
                int(sid), this_registry_status=entry["status"], other_roots=other_roots)
            if divergence:
                print(f"     {divergence}")


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
        print("Only one completed sprint on record - treat every number below as a "
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
    print(f"   Audited miss - QA1 passed fresh, LiveQA still caught it: "
          f"{len(audited_miss)} - sprints: {counts_str(audited_miss)}")
    print(f"   Unaudited-fix miss - fix reshipped without a fresh QA1 re-audit, not evidence "
          f"QA1 missed anything: {len(unaudited_fix_miss)} - sprints: {counts_str(unaudited_fix_miss)}")
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
    print(f"   QA1: {len(qa1_catch)} of {n} - sprints: {qa1_catch or '(none)'}")
    print(f"   LiveQA: {len(liveqa_catch)} of {n} - sprints: {liveqa_catch or '(none)'}")
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
          "NOT a QA1/LiveQA override - no such override exists):")
    print(f"   dev-done-hash overrides: {len(dev_done_hash_events)} - sprints: {counts_str(dev_done_hash_events)}")
    print(f"   ship-hash overrides: {len(ship_hash_events)} - sprints: {counts_str(ship_hash_events)}")


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

    s = sub.add_parser("repoint-shipped-commit",
                        help="Sprint 28, Req 3: recover a last_shipped_commit orphaned by a "
                        "rebase — re-points it to --commit only after confirming (via git "
                        "patch-id --stable, no override on a mismatch) that --commit carries the "
                        "exact same patch as the commit currently on record. No phase "
                        "restriction: this is the recovery for exactly the case where the "
                        "normal phase-gated paths (reship, a fresh ship) have no way back, "
                        "including on a sprint that's already complete.")
    s.add_argument("id", type=int)
    s.add_argument("--commit", default="",
                    help="The commit that now carries the same work as the orphaned "
                    "last_shipped_commit, after whatever rebase relocated it.")
    s.set_defaults(func=cmd_repoint)

    s = sub.add_parser("verify-publish",
                        help="Sprint 13: mechanically verify a shipped sprint's registry "
                        "publish against last_shipped_commit — gitHead when the registry "
                        "has one, a content-based (npm pack) fallback when it doesn't. "
                        "Read-only against the sprint's phase; only appends a history event.")
    s.add_argument("id", type=int)
    s.add_argument("--package", default="", help="Defaults to package.json's own \"name\".")
    s.add_argument("--version", default="",
                    help="Defaults to the version in the shipped commit's own package.json.")
    s.set_defaults(func=cmd_verify_publish)

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
    s.add_argument("--user-said", default="",
                    help="Required. Quote what the user actually told you, in this session, "
                    "that authorizes abandoning this sprint right now. Same non-overridable "
                    "gate as /sprint-complete's own --user-said -- abort is this lifecycle's "
                    "most destructive action.")
    s.add_argument("--user-said-file", help="Read --user-said from this file instead of the command line.")
    s.add_argument("--reason", default="", help="Required. Why this sprint is being abandoned.")
    s.add_argument("--reason-file", help="Read the reason from this file instead of the command line.")
    s.set_defaults(func=cmd_abort)

    s = sub.add_parser("block",
                        help="Sprint 33, Req 4: the non-destructive alternative to abort, for a "
                        "sprint that isn't currently buildable. Returns it to the planner -- "
                        "sprint id preserved, never moved to 5-abandoned, your analysis recorded "
                        "for Master Controller to read and repair the file.")
    s.add_argument("id", type=int)
    s.add_argument("--reason", default="",
                    help="Required. Your analysis of why this sprint isn't currently buildable "
                    "-- what Master Controller needs to repair it.")
    s.add_argument("--reason-file", help="Read the reason from this file instead of the command line.")
    s.set_defaults(func=cmd_block)

    s = sub.add_parser("rename",
                        help="Sprint 25, Req 4: updates the registry entry, the sprint file's "
                        "own frontmatter, and the filename together, for a sprint whose scope "
                        "legitimately narrowed. Preserves the original title. Never touches "
                        "phase, verdicts, hashes, or history.")
    s.add_argument("id", type=int)
    s.add_argument("--title", default=None, help="The new title. Prefer --title-file for text pasted from elsewhere.")
    s.add_argument("--title-file", help="Read the new title from this file instead of the command line.")
    s.set_defaults(func=cmd_rename)

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
    try:
        args.func(args)
    finally:
        # Sprint 27, Req 1: a completion NOTICE, not a drift warning —
        # deliberately not a `git status` check. "Is docs/sprints/ dirty"
        # would be true almost always (bookkeeping is uncommitted by
        # default after every transition, per this Req's own Context),
        # which is exactly the always-fires `repo=` banner above, read
        # wrong four times because it never says anything different
        # depending on whether it matters. This instead states a fact
        # that's true unconditionally, once, right when a write actually
        # happened: _WRITES_THIS_INVOCATION only ever contains paths THIS
        # process itself wrote, via atomic_write() (see that function's
        # own comment) — empty for every read-only command (status, list,
        # gates never call atomic_write at all), so this never fires for
        # them, and the wording is a receipt, not an alarm, checked by
        # QA1's own criterion for exactly that tone. Runs in `finally` so
        # a command that writes something and THEN dies() partway through
        # still gets an honest receipt for what actually landed on disk —
        # what's there is there, uncommitted, regardless of whether the
        # command's own logic finished.
        #
        # Deliberately does NOT commit anything itself (Req 1's own "do
        # not make the script commit" — the script owns state, git
        # belongs to a role, and that boundary is checked by QA1 as a
        # zero-`git commit`/`git add`-calls-in-this-file criterion). This
        # only ever prints; committing what it names is Req 2's rule, for
        # whichever role's session is running the command.
        if _WRITES_THIS_INVOCATION:
            seen = []
            for p in _WRITES_THIS_INVOCATION:
                if p not in seen:
                    seen.append(p)
            print(
                f"Wrote: {', '.join(seen)}. Not committed — this script never touches git, by "
                "design. Commit these before handing off (CLAUDE.md's own commit rule).",
                file=sys.stderr,
            )


if __name__ == "__main__":
    main()
