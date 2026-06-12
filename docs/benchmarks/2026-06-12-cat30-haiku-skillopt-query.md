# SkillOpt — query.md (round cat30-haiku)

Roles: target bedrock:global.anthropic.claude-haiku-4-5-20251001-v1:0 / optimizer bedrock:us.anthropic.claude-opus-4-8. Train: 4 tasks; held-out:
5 tasks (never shown to the optimizer). Gates: mechanical contamination
check → train must strictly improve → held-out must not regress.
Start: DEFICIENT skill from fixtures/skill-tasks/deficient-query.md (loop-validation run, gbrain cat30 analog).

| round | event | train | held-out |
|---|---|---:|---:|
| 0 | baseline (deficient start) | 4/4 | 2/5 |
| 1 | converged — train is perfect, nothing to learn from | — | — |

No candidate accepted — live skill unchanged.
