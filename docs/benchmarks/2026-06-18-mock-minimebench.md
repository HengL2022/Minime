# MinimeBench scorecard — 2026-06-18 (mock)

Mode: **mock** (MINIME_MOCK_OLLAMA=1, deterministic N=1). Seed(s): 2654435769. Judges: none (all deterministic, MinimeBench v1).

## Area table

| Area | n | hit@1 | hit@3 | hit@5 | MRR | nDCG@5 | accuracy | p50ms | p95ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| retrieval-en | 100 | 70.0% | 91.0% | 96.0% | 0.799 | 0.818 | 91.0% | 0.9 | 1.55 |
| retrieval-zh | 100 | 56.0% | 70.0% | 73.0% | 0.627 | 0.649 | 70.0% | 0.77 | 1.36 |
| graph | 15 | 53.3% | 73.3% | 80.0% | 0.639 | 0.680 | 80.0% | 0.8 | 1.59 |
| identity | 16 | 81.3% | 100.0% | 100.0% | 0.906 | 0.936 | 100.0% | 0.77 | 0.92 |
| time | 16 | 81.3% | 87.5% | 93.8% | 0.859 | 0.869 | 87.5% | 0.81 | 1.28 |
| provenance | 10 | 70.0% | 100.0% | 100.0% | 0.833 | 0.876 | 70.0% | 0.8 | 0.88 |
| robustness | 18 | 0.0% | 0.0% | 0.0% | 0.000 | 0.000 | 100.0% | 0.76 | 1.64 |
| decision-digest | 3 | 100.0% | 100.0% | 100.0% | 1.000 | 1.000 | 100.0% | 0.86 | 1.53 |

## Baseline diff

No regression beyond tolerance. All committed floors held.

## retrieval-en — detail (corpus: persona-en)

Misses (9/100):

- en-8 rank=- top="Family and friends" :: Which vet clinic does my dog go to?
- en-23 rank=4 top="Car — Škoda Octavia" :: Near which town do I want to buy a cabin?
- en-28 rank=5 top="Family and friends" :: What is my dog afraid of?
- en-33 rank=- top="Goals for 2026" :: What year did I move to Norway?
- en-64 rank=4 top="Work at Fjordsonics" :: Which company insures my dog?
- en-65 rank=4 top="Car — Škoda Octavia" :: What color is my dog's winter jumper?
- en-77 rank=- top="Biscuit the whippet" :: What is my home address?
- en-87 rank=4 top="Bouldering" :: Where does Ingrid work?
- en-92 rank=- top="Money goals" :: What book is the club reading in June 2026?

## retrieval-zh — detail (corpus: bilingual-zh)

Buckets:

| bucket | n | hit@1 | hit@3 | hit@5 | MRR |
|---|---:|---:|---:|---:|---:|
| zh→zh | 40 | 90.0% | 95.0% | 97.5% | 0.930 |
| en→zh | 20 | 5.0% | 35.0% | 35.0% | 0.158 |
| zh→en | 15 | 0.0% | 13.3% | 13.3% | 0.056 |
| mixed | 25 | 76.0% | 92.0% | 100.0% | 0.858 |

Misses (30/100):

- zh-2 rank=5 top="猫咪汤圆" :: 我的生日是哪天？
- zh-4 rank=- top="理财计划" :: 我读研究生时学的什么专业？
- zh-43 rank=- top="Volunteering" :: Who is my family doctor and at which clinic?
- zh-44 rank=- top="Goals for 2026" :: Which ryokan did I stay at in Kyoto?
- zh-45 rank=- top="Tiong Bahru apartment" :: Where did I see the most stunning illuminated autumn leaves?
- zh-46 rank=- top="Tiong Bahru apartment" :: What souvenir did I bring back for my cat from Kyoto?
- zh-47 rank=- top="Volunteering" :: What does my younger brother do for work and at which company?
- zh-48 rank=- top="Coffee" :: What is my cousin's bubble tea shop called?
- zh-50 rank=- top="健康笔记" :: Which Chopin piece am I practising?
- zh-52 rank=- top="Volunteering" :: What are the secrets to my grandmother's slow-simmered soup?
- zh-53 rank=- top="Book club" :: Where do I buy Chinese cured sausage?
- zh-54 rank=- top="外婆的食谱" :: When was my last allergic reaction?
- zh-55 rank=- top="Coffee" :: What time does my mom video call me every day?
- zh-57 rank=- top="Coffee" :: Am I leaning toward buying or adopting a second cat?
- zh-59 rank=- top="Goals for 2026" :: Which temple bridge in Kyoto was too crowded?
- zh-61 rank=- top="关于我" :: 读书会是几点、在哪里聚？
- zh-62 rank=- top="关于我" :: 读书会六月在读哪本书？
- zh-63 rank=- top="家人" :: 九月轮到我选书，我打算选哪本？
- zh-64 rank=- top="最近随想" :: 我每个月的房租是多少？
- zh-65 rank=- top="Book club" :: 我的房东是谁？
- zh-66 rank=- top="家人" :: 我的租约每年什么时候续？
- zh-67 rank=- top="最近随想" :: 我的手冲咖啡配方是什么？
- zh-68 rank=- top="Kingfisher 项目笔记" :: 我的磨豆机是什么牌子？
- zh-69 rank=- top="最近随想" :: 我的咖啡豆在哪里买？
- zh-70 rank=- top="最近随想" :: 我每个月在哪里做义工？
- zh-71 rank=- top="关于我" :: 我在汤厨房做的是什么工作？
- zh-73 rank=- top="Kingfisher 项目笔记" :: 2026年我的读书目标是多少本？
- zh-75 rank=- top="钢琴学习" :: 晚上九点后不看工作Slack的规矩，到现在破了几次？
- zh-91 rank=5 top="钢琴学习" :: BTO 首付的存钱目标是多少？
- zh-93 rank=4 top="Kingfisher 项目笔记" :: 到2026年5月我存到多少了？

## graph — detail (corpus: persona-en)

Misses (3/15):

- g-4 rank=- top="Work at Fjordsonics" [miss] :: Where does my physiotherapist work?
- g-8 rank=- top="Work at Fjordsonics" [miss] :: Where does my GP work?
- g-10 rank=4 top="Work at Fjordsonics" [miss] :: Which clinic does the vet work at?

## identity — detail (corpus: persona-en)

Misses (0/16):

- none

## time — detail (corpus: persona-en)

Misses (2/16):

- t-10 rank=4 top="Work at Fjordsonics" :: When did the SILDRE prototype review pass earlier this year?
- t-14 rank=- top="Car — Škoda Octavia" :: Which book is the club reading in June 2026?

## provenance — detail (corpus: persona-en)

Misses (3/10):

- p-1 rank=2 top="Car — Škoda Octavia" [prov-ok] :: What breed is my dog?
- p-3 rank=3 top="Books and media" [prov-ok] :: Which food am I severely allergic to?
- p-6 rank=2 top="Work at Fjordsonics" [prov-ok] :: What is my home address on Bakklandet?

## robustness — detail (corpus: persona-en)

Misses (0/18):

- none

## decision-digest — detail (corpus: decisions-en)

Buckets:

| bucket | n | hit@1 | hit@3 | hit@5 | MRR |
|---|---:|---:|---:|---:|---:|
| vendor-risk | 1 | 100.0% | 100.0% | 100.0% | 1.000 |
| rollout-risk | 1 | 100.0% | 100.0% | 100.0% | 1.000 |
| timing | 1 | 100.0% | 100.0% | 100.0% | 1.000 |

Misses (0/3):

- none
