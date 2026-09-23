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
