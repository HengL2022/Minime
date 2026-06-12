# SkillOpt — query.md (round r2-haiku)

Roles: target bedrock:global.anthropic.claude-haiku-4-5-20251001-v1:0 / optimizer bedrock:us.anthropic.claude-opus-4-8. Train: 4 tasks; held-out:
5 tasks (never shown to the optimizer). Gates: mechanical contamination
check → train must strictly improve → held-out must not regress.
Start: live skill.

| round | event | train | held-out |
|---|---|---:|---:|
| 0 | baseline (live skill) | 3/4 | 4/5 |
| 1 | rejected: train did not improve | 3/4 | — |
| 2 | rejected: train did not improve | 3/4 | — |
| 3 | rejected: train did not improve | 3/4 | — |

No candidate accepted — live skill unchanged.
