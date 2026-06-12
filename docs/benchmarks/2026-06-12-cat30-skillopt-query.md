# SkillOpt — query.md (round cat30)

Optimizer+target: bedrock:us.anthropic.claude-opus-4-8. Train: 4 tasks; held-out:
5 tasks (never shown to the optimizer). Gates: mechanical contamination
check → train must strictly improve → held-out must not regress.
Start: DEFICIENT skill from fixtures/skill-tasks/deficient-query.md (loop-validation run, gbrain cat30 analog).

| round | event | train | held-out |
|---|---|---:|---:|
| 0 | baseline (deficient start) | 3/4 | 3/5 |
| 1 | ACCEPTED | 4/4 | 4/5 |
| 2 | converged — train is perfect, nothing to learn from | — | — |

Accepted candidate written to /Users/heng/Minime/agents/skills/candidates/query-2026-06-12-cat30.md — review and apply manually; live skills are never auto-modified.
