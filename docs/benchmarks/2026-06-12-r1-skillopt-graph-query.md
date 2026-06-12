# SkillOpt — graph-query.md (round r1)

Optimizer+target: bedrock:us.anthropic.claude-opus-4-8. Train: 3 tasks; held-out:
3 tasks (never shown to the optimizer). Gates: mechanical contamination
check → train must strictly improve → held-out must not regress.
Start: live skill.

| round | event | train | held-out |
|---|---|---:|---:|
| 0 | baseline (live skill) | 2/3 | 3/3 |
| 1 | rejected: train did not improve | 2/3 | — |
| 2 | rejected: train did not improve | 2/3 | — |
| 3 | rejected: train did not improve | 2/3 | — |

No candidate accepted — live skill unchanged.
