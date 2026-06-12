> NOTE: this run measured the REJECTED 0.8/0.2 blend calibration (round name says live-r1 because the runner overwrote that file; chronologically it is r2). It is kept because we publish the bad numbers. The shipped engine's record is 2026-06-12-live-final-minimebench.md.

# MinimeBench scorecard — 2026-06-12 (live-r1)

Mode: **live** (configured embed provider, N=3 min/median/max). Seed(s): 2654435770. Judges: none (all deterministic, MinimeBench v1).

## Area table

| Area | n | hit@1 | hit@3 | hit@5 | MRR | nDCG@5 | accuracy | p50ms | p95ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| retrieval-en | 100 | 92.0% | 98.0% | 100.0% | 0.950 | 0.952 | 98.0% | 518.33 | 915.05 |
| retrieval-zh | 100 | 76.0% | 95.0% | 97.0% | 0.850 | 0.878 | 95.0% | 522.59 | 941.99 |
| graph | 15 | 80.0% | 86.7% | 100.0% | 0.867 | 0.899 | 86.7% | 524.03 | 991.47 |
| identity | 16 | 87.5% | 100.0% | 100.0% | 0.938 | 0.927 | 100.0% | 511.65 | 717.44 |
| time | 16 | 100.0% | 100.0% | 100.0% | 1.000 | 1.000 | 100.0% | 500.95 | 1013.72 |
| provenance | 10 | 90.0% | 100.0% | 100.0% | 0.933 | 0.950 | 90.0% | 507.57 | 898.76 |
| robustness | 18 | 0.0% | 0.0% | 0.0% | 0.000 | 0.000 | 100.0% | 518.34 | 1705.94 |

## Baseline diff

| Area | Metric | Baseline | Current | Delta | Provisional |
|---|---|---:|---:|---:|:---:|
| retrieval-en | latency_p95_ms | 3.55 | 915.05 | 911.5 | no |
| retrieval-zh | latency_p95_ms | 2.72 | 941.99 | 939.27 | no |
| graph | latency_p95_ms | 2.72 | 991.47 | 988.75 | no |
| identity | latency_p95_ms | 1.15 | 717.44 | 716.29 | yes |
| time | latency_p95_ms | 1.25 | 1013.72 | 1012.47 | yes |
| provenance | latency_p95_ms | 0.77 | 898.76 | 897.99 | yes |
| robustness | latency_p95_ms | 1.31 | 1705.94 | 1704.63 | yes |

## retrieval-en — detail (corpus: persona-en)

Misses (2/100):

- en-77 rank=5 top="Biscuit the whippet" :: What is my home address?
- en-99 rank=4 top="Nyckelharpa" :: How many nyckelharpa tunes do I currently know by heart?

## retrieval-zh — detail (corpus: bilingual-zh)

Buckets:

| bucket | n | hit@1 | hit@3 | hit@5 | MRR |
|---|---:|---:|---:|---:|---:|
| zh→zh | 40 | 95.0% | 100.0% | 100.0% | 0.971 |
| en→zh | 20 | 40.0% | 85.0% | 90.0% | 0.604 |
| zh→en | 15 | 46.7% | 86.7% | 93.3% | 0.672 |
| mixed | 25 | 92.0% | 100.0% | 100.0% | 0.960 |

Misses (5/100):

- zh-47 rank=4 top="Volunteering" :: What does my younger brother do for work and at which company?
- zh-53 rank=- top="Coffee" :: Where do I buy Chinese cured sausage?
- zh-55 rank=- top="Volunteering" :: What time does my mom video call me every day?
- zh-71 rank=- top="工作 @ Seraya Pay" :: 我在汤厨房做的是什么工作？
- zh-75 rank=4 top="工作 @ Seraya Pay" :: 晚上九点后不看工作Slack的规矩，到现在破了几次？

## graph — detail (corpus: persona-en)

Misses (2/15):

- g-4 rank=4 top="About me" [miss] :: Where does my physiotherapist work?
- g-8 rank=4 top="About me" [miss] :: Where does my GP work?

## identity — detail (corpus: persona-en)

Misses (0/16):

- none

## time — detail (corpus: persona-en)

Misses (0/16):

- none

## provenance — detail (corpus: persona-en)

Misses (1/10):

- p-3 rank=3 top="Biscuit the whippet" [prov-ok] :: Which food am I severely allergic to?

## robustness — detail (corpus: persona-en)

Misses (0/18):

- none

