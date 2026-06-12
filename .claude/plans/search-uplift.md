# Search uplift plan (2026-06-12, rev 2 — adds MinimeBench per gbrain-evals study)

Shared contract for the search-quality uplift derived from the GBrain comparison and
the gbrain-evals benchmark methodology (github.com/garrytan/gbrain-evals). The
orchestrator (main session, Fable 5) dispatches three Opus sub-agents in parallel
with worktree isolation, then integrates, benchmarks, and verifies.

## Phases and ownership

| Phase | Work | Agent | Owns (exclusive) |
|---|---|---|---|
| 1a | RRF fusion replaces weighted-sum; recency/graph become post-fusion multipliers. Title-phrase boost (token-boundary, stopword-guarded, CJK-aware). Zero-LLM intent classifier (entity/temporal/event/general) → weight nudges. | `fusion-engineer` | `src/search/hybrid.ts`, new `src/search/title-match.ts`, `src/search/intent.ts`; may add repo.ts read helpers |
| 1b | MinimeBench: area-based eval harness with committed bars, sealed gold, baseline snapshots, scorecards (see below). | `eval-engineer` | new `src/search/eval.ts`, `fixtures/qrels/`, `fixtures/eval-corpora/`, `test/m9.eval.test.ts`, Makefile targets, `docs/benchmarks/` |
| 2 | Compiled-notes layer: dream step distills entity/topic note pages (local classify provider; tier inherits sources; `derived_from` set; `source='dream:notes'`). | `notes-compiler` | `src/pipeline/notes.ts`, dream wiring, migration if needed |
| 2-int | Search boost for compiled notes (compiled notes ×~1.5; other derived keep ×0.85). | orchestrator (after merge — touches `hybrid.ts`) | — |

## MinimeBench — areas and committed bars

Modeled on gbrain-evals: each area is a real test with a committed pass/fail bar.
Current measured values become the regression floor; bars marked NEW get their
first measurement in this cycle. All corpora fictional; all gold answers sealed in
files the search path never reads.

| Area | What it checks | Bar | Source |
|---|---|---|---|
| Retrieval (en) | persona 100q | hit@1 ≥ 92%, hit@3 ≥ 99% | existing, port to qrels |
| Retrieval (zh/mixed) | bilingual 100q, 4 buckets | total hit@3 ≥ 95%; zh→zh hit@3 = 100%; zh→en hit@1 ≥ 47% | existing, port |
| Linking/graph | relational 15q over typed edges | 15/15; edge precision = 100% on fixture corpus | existing m7 eval, port |
| Identity | aliases/short names resolve to one person ("Tomasz" ↔ "Tomasz Wójcik") | recall ≥ 0.90 (NEW, ~15q) | new qrels |
| Time | "as of <month>", point/range/recency questions | as-of hit@3 ≥ 0.80 (NEW, ~15q) | new qrels |
| Provenance | top hit carries correct source row + `derived` flag; envelope cites real IDs | accuracy ≥ 0.95 (NEW, ~10 checks) | new checks |
| Speed | hybridSearch p95 on the 100q suite, local embed mock | p95 < 200ms (NEW) | harness timing |
| Robustness | adversarial query inputs (m6 fuzz strings + injection patterns) | 100% no-crash, no tier leak | reuse m6 inputs |

## Anti-gaming harness rules (from gbrain-evals, adopted verbatim)

- **Sealed gold**: answer keys live in `fixtures/qrels/*.json`, loaded only by the
  scorer — never by anything in the retrieval path.
- **Randomized question order** per run (seeded; seed printed in the scorecard).
- **Baseline snapshots**: `fixtures/qrels/baseline.ndjson` commits the current
  numbers; every `make eval-search` diffs against it and fails on regression
  beyond tolerance.
- **Tolerance bands**: live-embedding benches run N=3 and report min/median/max;
  mock benches are deterministic (N=1).
- **Publish the bad numbers**: every run writes a dated scorecard to
  `docs/benchmarks/YYYY-MM-DD-<round>-minimebench.md` including regressions and
  known-weak areas — never only the headline.
- **Pinned judges**: no LLM judging in MinimeBench v1 (all deterministic); if one
  is ever added, its model id is pinned in the scorecard.

## Acceptance gates (orchestrator, after integration)

1. `make verify` (m0–m8) green, full `bun test` green, `bunx tsc --noEmit` clean.
2. MinimeBench: all bars met, no baseline regression beyond tolerance.
3. `invariant-reviewer` pass on the combined diff.
4. DECISIONS.md entries: Phase-1 fusion (§9 amendment), MinimeBench adoption,
   Phase-2 notes layer (§15 early adoption — owner approved 2026-06-12).
5. Dated scorecard committed to `docs/benchmarks/`.

## Remediation and improvement loop

- **Near miss** (any bar missed by < 10 points / within 2× tolerance): dispatch a
  follow-up Opus agent with the exact failure report; fix only the regression;
  re-run gates.
- **Not even close** (bar missed by ≥ 10 points, or a NEW area far below bar):
  do NOT patch blindly. Orchestrator opens an improvement iteration:
  (1) analysis agent produces a written failure diagnosis (which queries fail,
  which pipeline stage loses the answer — candidates vs fusion vs boost);
  (2) targeted fix proposal recorded in the plan; (3) implement; (4) re-run.
- Two consecutive failed cycles on the same area → stop and report to the owner
  with the scorecard and diagnosis rather than iterating blind.

## Stretch (separate, owner-triggered): LongMemEval-s public benchmark

gbrain reports 97.6% recall@5 on LongMemEval-s (V1, 500 questions over chat
histories — much closer to Minime's domain than the V2 agent-trajectory benchmark
we ran). A `make eval-longmemeval` runner (stratified sample mode like gbrain's
`--stratify 10`) is a natural follow-up once MinimeBench is green; V1 has
per-question evidence-session labels, so recall@5 needs no reader or judge.
Not part of this cycle's gates.
