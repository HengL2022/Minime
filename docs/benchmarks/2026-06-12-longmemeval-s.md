# LongMemEval-s — Minime hybrid retrieval (session-level recall)

Engine: RRF hybrid (qwen3-embedding-8b live), per-question haystack scoping, top-10 parents.
Reference: gbrain reports 97.6% recall@5 on this dataset.

| type | n | recall@1 | recall@5 | recall@10 | MRR@10 |
|---|---:|---:|---:|---:|---:|
| single-session-user | 10 | 90.0% | 100.0% | 100.0% | 0.950 |
| **TOTAL** | 10 | 90.0% | 100.0% | 100.0% | 0.950 |
