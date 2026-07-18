# Graph-hygiene live bake — 2026-07-18

Owner-run live bake of the W1 extractor-re-validation gate (dream step 3c_validate_edges)
against the planted graph-hygiene corpus (fixtures/graph-hygiene.ts), using the real
tier-routed classify model instead of the CI mock heuristic (verify-m14 covers that path
offline and deterministically).

Model(s) used: bedrock

Planted-bad flagged: 3/3
False flags (planted-good): 0/2

checked=5 confirmed=2 denied=3 unsure=0 flagged=3

| rule_key | checked | denied |
|---|---:|---:|
| mentions@0.8 | 3 | 2 |
| works_at@0.7 | 1 | 1 |
| works_at@0.85 | 1 | 0 |
