# SkillEval — agents/skills behavioral contracts (round live-r1)

Driver model: bedrock:us.anthropic.claude-opus-4-8. Judge-free: tool-call assertions are read from the events
audit log (I8) through the same invokeTool door agents use (I2); answer checks are
regex + citation-of-returned-id. Tasks: fixtures/skill-tasks/. Baseline round —
committed pass bars follow once numbers stabilize.

| suite | n | passed | mean steps |
|---|---:|---:|---:|
| graph-query | 3 | 2/3 | 2.3 |
| person-brief | 2 | 2/2 | 2.0 |
| query | 5 | 5/5 | 3.6 |
| capture | 3 | 3/3 | 2.3 |
| **TOTAL** | 13 | 12/13 | 2.8 |

## Failures (published)

- `g-gp` (graph-query.md): answer matched none of [Tanjong]
