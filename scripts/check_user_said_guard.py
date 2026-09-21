#!/usr/bin/env python3
"""Sprint 41, Req 4a: assert no code path in this repository constructs,
defaults, templates, or otherwise supplies --user-said or --user-said-file
CONTENT. The only legitimate source of that text is a human's own typed
words, quoted by a role in the moment `/sprint-complete` or `/sprint-abort`
actually runs (CLAUDE.md's own rule, backed by cmd_complete's/cmd_abort's
own non-overridable refusal on empty --user-said). This guard exists so a
FUTURE change that helpfully "pre-fills" that text -- a launcher prompt, a
headless opening-prompt template, a doc's own worked example drifting from
a placeholder into a real-looking value -- fails the suite immediately,
rather than quietly eroding a rule that's currently protected by exactly
one refusal in scripts/sprint_lifecycle.py (see Req 4's own Context: "that
is precisely how a rule like this rots -- sprint 9's publish ordering was
fixed in prose and drifted on the very next release").

What this catches, by construction (see the two patterns below): anywhere
under scripts/, .claude/commands/, or .claude/agents/ (excluding this
project's own test suites, which legitimately construct these values to
simulate a human's typed input for automated testing -- that is not a
code path a real role session would ever execute), where --user-said or
--user-said-file is paired with a literal string value that is not the
established empty-default or the doc convention's own placeholder
("..."). Two shapes are checked, scanned against each file's FULL text
(not line by line -- QA1's round-1 audit demonstrated a line-by-line scan
misses a call formatted across multiple lines, e.g. a multi-line
`args.push(\n  '--user-said',\n  'real text'\n)`, since the flag and its
value never share a line in that formatting):

  (a) CODE-ARRAY shape: the flag itself as its own quoted literal,
      immediately followed (across any amount of whitespace, including
      newlines) by another quoted literal -- e.g.
      `args.push('--user-said', 'Sprint approved, closing automatically')`
      or the same call reformatted across several lines. This is the
      shape a launcher prompt or a subprocess argv builder would use to
      actually supply content.
  (b) CLI-EXAMPLE shape: the bare flag token followed directly by either
      whitespace or a literal `=` (both accepted -- QA1's round-1 audit
      also demonstrated `--user-said="yes, close it"` slipped past a
      whitespace-only separator, and argparse itself accepts `=` exactly
      as readily as a space) then a quoted value -- e.g. `--user-said
      "..."` in a doc, or a shell-style invocation built as an
      f-string/template. Flagged unless the value is the doc convention's
      own "..." placeholder.

argparse's own flag DEFINITION in sprint_lifecycle.py (`add_argument`) is
checked separately and held to a stricter rule: its `default=` must be
the empty string, always -- a non-empty default here is itself exactly
the violation this guard exists to catch (a missing --user-said would
then silently succeed instead of refusing).

KNOWN LIMIT, stated rather than implied (QA1's round-1 audit asked for
this explicitly): this is a literal-value scan, not a data-flow analysis.
A value passed through a variable or built from string concatenation --
`const said = buildText(); args.push('--user-said', said)` -- is
invisible to it; no purely lexical scan can see through that without
becoming a real static analyzer. This guard defends against a literal
appearing in the source, which is the shape every real drift this project
has actually seen has taken (sprint 9's publish-ordering prose, a doc's
own worked example) -- it is not a substitute for a human reviewer
reading a diff that introduces a --user-said-shaped variable at all.

This is a static scan, not an execution -- it never runs any of the code
it reads. Verified by negative control (this sprint, both the original
round and QA1's round-1 audit): a JS argv-builder call (single-line and
reformatted across multiple lines), a non-empty argparse default, a doc
example with real text instead of "...", and an `=`-separated CLI example
each independently made this script exit non-zero; the real, unmodified
repository tree scans clean.
"""
import re
import sys
import pathlib
import tempfile

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent

SCAN_DIRS = ["scripts", ".claude/commands", ".claude/agents"]
# This project's own test suites: they legitimately construct --user-said
# values to simulate a human's typed input for automated testing (see e.g.
# smoke_test.sh's own many `--user-said "close it"`-shaped calls). That is
# testing infrastructure exercising the real refusal, not a code path a
# real role session would ever execute -- excluded from this scan, not
# exempted from the rule it protects.
EXCLUDE_RELATIVE = {
    "scripts/launcher_test.js",
    "scripts/smoke_test.sh",
    "scripts/worktree_test.sh",
    "scripts/check_user_said_guard.py",
}
SCAN_SUFFIXES = (".py", ".js", ".md", ".sh")
SAFE_VALUES = {"", "..."}

DEFINITION_RE = re.compile(
    r'add_argument\(\s*["\']--user-said(?:-file)?["\']\s*,\s*default\s*=\s*(?P<q>["\'])(?P<val>.*?)(?P=q)'
)
# (a) CODE-ARRAY shape. \s* already matches newlines (no re.DOTALL needed
# for that -- only `.` requires it, and this pattern uses none between the
# tokens themselves), which is what lets this match a call reformatted
# across multiple lines.
PATTERN_ARRAY = re.compile(
    r"""(?P<fq>['"])--user-said(?:-file)?(?P=fq)\s*,\s*(?P<vq>['"])(?P<val>.*?)(?P=vq)"""
)
# (b) CLI-EXAMPLE shape. Separator is whitespace OR a literal `=`
# (argparse's own `--flag=value` form), not whitespace alone.
PATTERN_CLI = re.compile(
    r"""--user-said(?:-file)?(?:\s+|=)\s*(?P<vq>['"])(?P<val>.*?)(?P=vq)"""
)


def _lineno_at(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def _line_text(text: str, offset: int) -> str:
    start = text.rfind("\n", 0, offset) + 1
    end = text.find("\n", offset)
    if end == -1:
        end = len(text)
    return text[start:end].strip()


def scan(repo_root: pathlib.Path):
    violations = []
    for scan_dir in SCAN_DIRS:
        base = repo_root / scan_dir
        if not base.exists():
            continue
        for path in sorted(base.rglob("*")):
            if not path.is_file():
                continue
            rel = str(path.relative_to(repo_root))
            if rel in EXCLUDE_RELATIVE or path.suffix not in SCAN_SUFFIXES:
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            if "--user-said" not in text:
                continue

            definition_spans = []
            for m in DEFINITION_RE.finditer(text):
                definition_spans.append(m.span())
                if m.group("val") not in SAFE_VALUES:
                    violations.append(
                        (rel, _lineno_at(text, m.start()), _line_text(text, m.start()),
                         f"argparse default is non-empty: {m.group('val')!r}")
                    )

            def _overlaps_definition(span):
                return any(s0 <= span[0] < s1 or s0 < span[1] <= s1 for s0, s1 in definition_spans)

            for pat in (PATTERN_ARRAY, PATTERN_CLI):
                for mm in pat.finditer(text):
                    if _overlaps_definition(mm.span()):
                        continue
                    if mm.group("val") not in SAFE_VALUES:
                        violations.append(
                            (rel, _lineno_at(text, mm.start()), _line_text(text, mm.start()),
                             f"literal value alongside the flag: {mm.group('val')!r}")
                        )
    return violations


# Sprint 41, Req 4a (QA1 round 1): a permanent regression test for the
# scanner's own detection logic, not just "does the real repo scan
# clean" -- QA1's round-1 audit found two real detection gaps (a
# multi-line-formatted argv call, an `=`-separated CLI example) by
# planting them and watching the scanner miss both. Re-running that same
# check is now built into the scanner itself, not left to the next
# person auditing this file to rediscover by hand: `--selftest` builds a
# scratch fixture per known violation shape (plus one clean control) and
# asserts the scanner's own verdict on each, covering every shape this
# guard has ever been shown to miss.
_SELFTEST_CASES = [
    (
        "single-line code-array",
        "function evil(args) {\n"
        "  args.push('--user-said', 'Sprint approved, closing automatically');\n"
        "  return args;\n}\n",
        True,
    ),
    (
        "multi-line code-array (QA1 round 1 finding)",
        "function evil(args) {\n"
        "  args.push(\n"
        "    '--user-said',\n"
        "    'Sprint approved, closing automatically'\n"
        "  );\n"
        "  return args;\n}\n",
        True,
    ),
    (
        "argparse non-empty default",
        's.add_argument("--user-said", default="approved", help="x")\n',
        True,
    ),
    (
        "doc example with real text instead of the \"...\" placeholder",
        'Usage: `/sprint-complete <sprint-id> --user-said "Sprint approved, ship it"`\n',
        True,
    ),
    (
        "= -separated CLI example (QA1 round 1 finding)",
        'Example: `/sprint-complete 41 --user-said="yes, close it"`\n',
        True,
    ),
    (
        "clean control: doc placeholder + empty argparse default",
        'Usage: `/sprint-complete <sprint-id> --user-said "..."`\n'
        's.add_argument("--user-said", default="", help="x")\n',
        False,
    ),
]


def selftest() -> int:
    failures = []
    for name, content, expect_violation in _SELFTEST_CASES:
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / "scripts").mkdir()
            (root / "scripts" / "fixture.js").write_text(content, encoding="utf-8")
            found = bool(scan(root))
            if found != expect_violation:
                failures.append(
                    f"  {name}: expected {'a violation' if expect_violation else 'no violation'}, "
                    f"got {'one' if found else 'none'}"
                )
    if failures:
        print("USER_SAID_GUARD_SELFTEST_FAILED")
        print("\n".join(failures))
        return 1
    print(f"USER_SAID_GUARD_SELFTEST_OK: all {len(_SELFTEST_CASES)} known shapes correctly classified.")
    return 0


def main():
    if "--selftest" in sys.argv[1:]:
        return selftest()
    violations = scan(REPO_ROOT)
    if violations:
        print("USER_SAID_GUARD_VIOLATIONS_FOUND")
        for rel, lineno, line, reason in violations:
            print(f"  {rel}:{lineno}: {reason}\n    {line}")
        return 1
    print("USER_SAID_GUARD_OK: no code path supplies --user-said/--user-said-file content.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
