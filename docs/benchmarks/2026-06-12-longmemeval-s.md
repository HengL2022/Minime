# LongMemEval-s — Minime hybrid retrieval (session-level recall)

Engine: RRF hybrid (qwen3-embedding-8b live), per-question haystack scoping, top-10 parents.
Reference: gbrain reports 97.6% recall@5 on this dataset.

| type | n | recall@1 | recall@5 | recall@10 | MRR@10 |
|---|---:|---:|---:|---:|---:|
| knowledge-update | 78 | 96.2% | 100.0% | 100.0% | 0.981 |
| multi-session | 133 | 90.2% | 98.5% | 100.0% | 0.939 |
| single-session-assistant | 56 | 100.0% | 100.0% | 100.0% | 1.000 |
| single-session-preference | 30 | 63.3% | 83.3% | 90.0% | 0.739 |
| single-session-user | 70 | 81.4% | 98.6% | 100.0% | 0.882 |
| temporal-reasoning | 133 | 87.2% | 95.5% | 99.2% | 0.913 |
| **TOTAL** | 500 | 88.6% | 97.2% | 99.2% | 0.925 |
