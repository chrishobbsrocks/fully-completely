# Sprint 44, Req 3 — Dev Team 1 actually runs on Opus after the frontmatter
# change, confirmed by launching, not assumed

**Version anchor: `claude 2.1.280`.** Method matches this project's own
established standard throughout `docs/sprint-12-permission-scope-findings.md`:
real headless launches via this repo's own `scripts/launcher/run-role.js`,
`--output-format json`, verdict decided only from the JSON result envelope's
own structured `modelUsage` field (which names the exact model that actually
served the request, including its `canonicalModel`) — never the model's own
narration about which model it believes it's running as. Every probe run
twice minimum (sprint 26's own reproducibility bar).

## What was measured

Command shape (via the real launcher, not a hand-built approximation):

```
node scripts/launcher/run-role.js --headless --agent dev-team-1 \
  --prompt-file <a file containing: "Reply with only the single word: ack">
```

| # | Agent file `model:` at launch time | Rep | `modelUsage` key in the JSON result | `canonicalModel` |
|---|---|---|---|---|
| 1 | `opus` (this sprint's own change) | 1/2 | `claude-opus-5-5` | `claude-opus-5-5` |
| 2 | `opus` | 2/2 | `claude-opus-5-5` | `claude-opus-5-5` |
| 3 | `sonnet` (negative control — temporarily reverted, then restored) | 1/1 | `claude-sonnet-5` | (not applicable — this run's own purpose was confirming the mechanism distinguishes models at all, not re-establishing this sprint's own change) |

**Grade: CONFIRMED.** Both real launches with `model: opus` in
`.claude/agents/dev-team-1.md` report `claude-opus-5-5` as the model that
actually served the request — structured, authoritative evidence from the
CLI's own result envelope, not the model's own self-report (this session
never asked the launched agent what model it believed it was; the launched
agent's only instruction was to reply `ack`, and the model identity came
entirely from the JSON envelope's own `modelUsage`/`canonicalModel` fields).
The negative control — briefly reverting `dev-team-1.md`'s `model:` line back
to `sonnet`, running the identical probe, and restoring it immediately after —
reported `claude-sonnet-5` instead, confirming the measurement mechanism
genuinely distinguishes between the two models rather than reporting the same
value regardless of the frontmatter, which is exactly what "a launch that
merely doesn't error isn't evidence" (this sprint's own instruction) is
guarding against: a silent fallback to another model would have shown up
here as `claude-sonnet-5` (or some other model) persisting after the change,
and it did not.

## What this settles for the sprint

`.claude/agents/agents.js`'s and `run-role.js`'s own documented behavior — an
agent file's frontmatter `model:` is the single place a role's model is set,
and it wins even over an explicit `--model` flag — holds for Dev Team 1 under
the real headless launch path, on `claude 2.1.280`, confirmed by running it,
not by reading the code and assuming it. LiveQA's own live gate for this
sprint repeats this same measurement against the published package, in a
fresh install, for both Dev Team 1 and Dev Team 2, and on both the interactive
and headless launch paths — this document records only the build-time check
QA1 audits statically before anything ships.

## Correction, appended 23 September (sprint 45, Req 7b)

**The "wins even over an explicit `--model` flag" half of the closing
paragraph above was never tested by this document's own table, and is
false. This is an append-only correction, the same shape `/sprint-correct`
(sprint 40) uses for a role's own recorded notes: the measurement above is
left exactly as it was run, nothing in the table or its own conclusions
about Dev Team 1 running on `opus` is edited or withdrawn. Only the one
sentence that generalized past what was actually run is corrected, here,
not there.**

Look again at the three rows in "What was measured" above: every row
varies exactly one thing, the agent file's own `model:` frontmatter value
at launch time (`opus`, `opus`, then `sonnet` for the negative control).
**Not one of the three launches passed a `--model` flag at all.** The
probe command shape shown (`node scripts/launcher/run-role.js --headless
--agent dev-team-1 --prompt-file ...`) never included one, in any rep.
So this document is solid evidence that Dev Team 1's headless launch path
correctly passes the agent file's frontmatter `model:` through to the
real launch (the actual subject of sprint 44's own Req 3) — and it is
**no evidence at all**, despite the closing paragraph's own claim, about
what happens when a `--model` flag is *also* given alongside `--agent`.
That specific question — frontmatter versus an explicit `--model` — was
never run here; the closing paragraph's "and it wins even over an
explicit `--model` flag" clause was a generalization from a claim already
circulating elsewhere in this codebase (traced back to sprint 12, at an
earlier CLI version), not from this document's own measurement, and it
was wrong: sprint 45 found, measured directly at `claude 2.1.280`
(`claude --agent qa1 --model haiku` ran as haiku; `claude --agent qa1`
with no flag ran as opus), that `--model` now *wins* over the frontmatter
when given, the opposite of what was claimed here. See CLAUDE.md's own
team-table section for the corrected, version-anchored account — this
document's own withdrawal is limited to the one sentence above that
overreached its own table, nothing else in this record is in question.
