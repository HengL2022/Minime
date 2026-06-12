# MinimeBench scorecard — 2026-06-12 (live-final)

Mode: **live** (configured embed provider, N=3 min/median/max). Seed(s): 2654435770, 2654435769. Judges: none (all deterministic, MinimeBench v1).

## Area table

| Area | n | hit@1 | hit@3 | hit@5 | MRR | nDCG@5 | accuracy | p50ms | p95ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| retrieval-en | 100 | 92.0% | 98.0% | 100.0% | 0.950 | 0.952 | 98.0% | 511.9 | 911.61 |
| retrieval-zh | 100 | 76.0% | 96.0% | 97.0% | 0.853 | 0.880 | 96.0% | 509.23 | 784.72 |
| graph | 15 | 80.0% | 93.3% | 100.0% | 0.872 | 0.904 | 93.3% | 512.55 | 1316.02 |
| identity | 16 | 87.5% | 100.0% | 100.0% | 0.938 | 0.927 | 100.0% | 508.85 | 1035.66 |
| time | 16 | 100.0% | 100.0% | 100.0% | 1.000 | 1.000 | 100.0% | 516.06 | 1708.36 |
| provenance | 10 | 90.0% | 100.0% | 100.0% | 0.933 | 0.950 | 90.0% | 522.03 | 809.45 |
| robustness | 18 | 0.0% | 0.0% | 0.0% | 0.000 | 0.000 | 100.0% | 507.61 | 1014.93 |

## Baseline diff

No regression beyond tolerance. All committed floors held.

## retrieval-en — detail (corpus: persona-en)

Misses (2/100):

- en-77 rank=5 top="Biscuit the whippet" :: What is my home address?
- en-99 rank=4 top="Nyckelharpa" :: How many nyckelharpa tunes do I currently know by heart?

## retrieval-zh — detail (corpus: bilingual-zh)

Buckets:

| bucket | n | hit@1 | hit@3 | hit@5 | MRR |
|---|---:|---:|---:|---:|---:|
| zh→zh | 40 | 95.0% | 100.0% | 100.0% | 0.975 |
| en→zh | 20 | 40.0% | 85.0% | 90.0% | 0.604 |
| zh→en | 15 | 46.7% | 93.3% | 93.3% | 0.678 |
| mixed | 25 | 92.0% | 100.0% | 100.0% | 0.960 |

Misses (4/100):

- zh-47 rank=4 top="Volunteering" :: What does my younger brother do for work and at which company?
- zh-53 rank=- top="Coffee" :: Where do I buy Chinese cured sausage?
- zh-55 rank=- top="Volunteering" :: What time does my mom video call me every day?
- zh-71 rank=- top="工作 @ Seraya Pay" :: 我在汤厨房做的是什么工作？

## graph — detail (corpus: persona-en)

Misses (1/15):

- g-4 rank=4 top="About me" [miss] :: Where does my physiotherapist work?

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

