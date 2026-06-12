# LongMemEval-s — Minime hybrid retrieval (session-level recall)

Engine: RRF hybrid (qwen3-embedding-8b live), per-question haystack scoping, top-10 parents.
Reference: gbrain reports 97.6% recall@5 on this dataset.

| type | n | recall@1 | recall@5 | recall@10 | MRR@10 |
|---|---:|---:|---:|---:|---:|
| knowledge-update | 78 | 83.3% | 100.0% | 100.0% | 0.905 |
| multi-session | 133 | 72.2% | 96.2% | 98.5% | 0.825 |
| single-session-assistant | 56 | 100.0% | 100.0% | 100.0% | 1.000 |
| single-session-preference | 30 | 53.3% | 70.0% | 86.7% | 0.604 |
| single-session-user | 70 | 67.1% | 95.7% | 98.6% | 0.788 |
| temporal-reasoning | 133 | 70.7% | 90.2% | 96.2% | 0.792 |
| **TOTAL** | 500 | 74.8% | 94.0% | 97.6% | 0.830 |
