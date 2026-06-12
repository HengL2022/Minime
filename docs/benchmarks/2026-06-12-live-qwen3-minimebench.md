# MinimeBench scorecard — 2026-06-12 (live-qwen3)

Mode: **live** (configured embed provider, N=3 min/median/max). Seed(s): 2654435770. Judges: none (all deterministic, MinimeBench v1).

Engine config: qwen/qwen3-embedding-8b via OpenRouter (the owner's standing stack) +
local bge-reranker-v2-m3 rerank stage (no autocut). **Binding live record** — supersedes
2026-06-12-live-final-minimebench.md, which ran on the pre-OpenRouter local embedding
config (provider-priority decision, DECISIONS.md 2026-06-12).

## Area table

| Area | n | hit@1 | hit@3 | hit@5 | MRR | nDCG@5 | accuracy | p50ms | p95ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| retrieval-en | 100 | 94.0% | 97.0% | 99.0% | 0.960 | 0.966 | 97.0% | 862.88 | 1586.37 |
| retrieval-zh | 100 | 98.0% | 100.0% | 100.0% | 0.990 | 0.991 | 100.0% | 878.06 | 1371.6 |
| graph | 15 | 86.7% | 100.0% | 100.0% | 0.922 | 0.942 | 100.0% | 848.27 | 1495.83 |
| identity | 16 | 87.5% | 100.0% | 100.0% | 0.938 | 0.934 | 100.0% | 859.93 | 4485.55 |
| time | 16 | 100.0% | 100.0% | 100.0% | 1.000 | 1.000 | 100.0% | 868.49 | 1483.61 |
| provenance | 10 | 90.0% | 100.0% | 100.0% | 0.950 | 0.963 | 90.0% | 872.95 | 3905.3 |
| robustness | 18 | 0.0% | 0.0% | 0.0% | 0.000 | 0.000 | 100.0% | 841.85 | 1579.01 |

## Baseline diff

No regression beyond tolerance. All committed floors held.

## retrieval-en — detail (corpus: persona-en)

Misses (3/100):

- en-18 rank=4 top="Goals for 2026" :: What is the total budget of the SILDRE contract?
- en-44 rank=4 top="Work at Fjordsonics" :: Who is the research partner on SILDRE?
- en-77 rank=- top="About me" :: What is my home address?

## retrieval-zh — detail (corpus: bilingual-zh)

Buckets:

| bucket | n | hit@1 | hit@3 | hit@5 | MRR |
|---|---:|---:|---:|---:|---:|
| zh→zh | 40 | 100.0% | 100.0% | 100.0% | 1.000 |
| en→zh | 20 | 90.0% | 100.0% | 100.0% | 0.950 |
| zh→en | 15 | 100.0% | 100.0% | 100.0% | 1.000 |
| mixed | 25 | 100.0% | 100.0% | 100.0% | 1.000 |

Misses (0/100):

- none

## graph — detail (corpus: persona-en)

Misses (0/15):

- none

## identity — detail (corpus: persona-en)

Misses (0/16):

- none

## time — detail (corpus: persona-en)

Misses (0/16):

- none

## provenance — detail (corpus: persona-en)

Misses (1/10):

- p-1 rank=2 top="About me" [prov-ok] :: What breed is my dog?

## robustness — detail (corpus: persona-en)

Misses (0/18):

- none

