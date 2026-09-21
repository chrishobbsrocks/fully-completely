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

What this catches, by construction (see the two patterns below): any line,
anywhere under scripts/, .claude/commands/, or .claude/agents/ (excluding
this project's own test suites, which legitimately construct these values
to simulate a human's typed input for automated testing -- that is not a
code path a real role session would ever execute), where --user-said or
--user-said-file is paired, ON THE SAME LINE, with a literal string value
that is not the established empty-default or the doc convention's own
placeholder ("...").  Two shapes are checked:

  (a) CODE-ARRAY shape: the flag itself as its own quoted literal,
      immediately followed by another quoted literal -- e.g.
      `args.push('--user-said', 'Sprint approved, closing automatically')`
      or `['--user-said', 'some text']`. This is the shape a launcher
      prompt or a subprocess argv builder would use to actually supply
      content.
  (b) CLI-EXAMPLE shape: the bare flag token followed directly by
      whitespace then a quoted value -- e.g. `--user-said "..."` in a doc,
      or a shell-style invocation built as an f-string/template. Flagged
      unless the value is the doc convention's own "..." placeholder.

argparse's own flag DEFINITION in sprint_lifecycle.py (`add_argument`) is
checked separately and held to a stricter rule: its `default=` must be
the empty string, always -- a non-empty default here is itself exactly
the violation this guard exists to catch (a missing --user-said would
then silently succeed instead of refusing).

This is a static scan, not an execution -- it never runs any of the code
it reads. Verified by negative control (this sprint): planting each of
the three violation shapes above (a JS argv-builder call, a non-empty
argparse default, and a doc example with real text instead of "...")
each independently made this script exit non-zero, and the real,
unmodified repository tree scans clean.
"""
import re
import sys
import pathlib

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
PATTERN_ARRAY = re.compile(
    r"""(?P<fq>['"])--user-said(?:-file)?(?P=fq)\s*,\s*(?P<vq>['"])(?P<val>.*?)(?P=vq)"""
)
PATTERN_CLI = re.compile(
    r"""--user-said(?:-file)?\s+(?P<vq>['"])(?P<val>.*?)(?P=vq)"""
)


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
            for lineno, line in enumerate(text.splitlines(), start=1):
                if "--user-said" not in line:
                    continue
                m = DEFINITION_RE.search(line)
                if m:
                    if m.group("val") not in SAFE_VALUES:
                        violations.append(
                            (rel, lineno, line.strip(), f"argparse default is non-empty: {m.group('val')!r}")
                        )
                    continue
                for pat in (PATTERN_ARRAY, PATTERN_CLI):
                    for mm in pat.finditer(line):
                        if mm.group("val") not in SAFE_VALUES:
                            violations.append(
                                (rel, lineno, line.strip(), f"literal value alongside the flag: {mm.group('val')!r}")
                            )
    return violations


def main():
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
