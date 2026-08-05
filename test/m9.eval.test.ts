// M9 (Phase 1b): MinimeBench eval harness. Three concerns:
//   1. pure IR metric math against hand-computed expectations (no DB);
//   2. runQrels() smoke test over a 3-doc inline corpus in the test DB;
//   3. baseline-regression detection — inject a fake regression, assert it is caught
//      (the same Regression[] that drives the runner's non-zero exit).

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateReports,
  assertCleanWorkingTree,
  parseEvalArgs,
  parseWorkerResult,
} from "../scripts/eval-search";
import { upsertPage } from "../src/db/repo";
import {
  type AreaReport,
  type BaselineLine,
  type Measurement,
  buildScorecard,
  diffBaseline,
  hitAtK,
  loadBaseline,
  loadQrels,
  missingBaselineMeasurements,
  mrr,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  runQrels,
  seededShuffle,
  serializeBaseline,
} from "../src/search/eval";
import { hybridSearch } from "../src/search/hybrid";
import { indexParent } from "../src/search/index-parent";
import { resetDb, testSql as sql } from "./helpers";

describe("pure IR metrics (hand-computed)", () => {
  // ranked = [A, B, C, D]; relevant = {B, D}
  const ranked = ["A", "B", "C", "D"];
  const rel = ["B", "D"];

  test("precision@k", () => {
    expect(precisionAtK(ranked, rel, 1)).toBe(0); // A not relevant
    expect(precisionAtK(ranked, rel, 2)).toBe(0.5); // {A,B} → 1/2
    expect(precisionAtK(ranked, rel, 4)).toBe(0.5); // {A,B,C,D} → 2/4
  });

  test("recall@k", () => {
    expect(recallAtK(ranked, rel, 1)).toBe(0); // none of {B,D} in top-1
    expect(recallAtK(ranked, rel, 2)).toBe(0.5); // B found → 1/2
    expect(recallAtK(ranked, rel, 4)).toBe(1); // both found
  });

  test("hit@k", () => {
    expect(hitAtK(ranked, rel, 1)).toBe(0);
    expect(hitAtK(ranked, rel, 2)).toBe(1); // B at rank 2
  });

  test("MRR — first relevant at rank 2 → 1/2", () => {
    expect(mrr(ranked, rel)).toBeCloseTo(0.5, 10);
    expect(mrr(["B", "A"], rel)).toBeCloseTo(1, 10);
    expect(mrr(["X", "Y"], rel)).toBe(0);
  });

  test("nDCG@4 — gains at ranks 2 and 4 vs ideal at ranks 1 and 2", () => {
    // DCG = 1/log2(3) + 1/log2(5) ; IDCG = 1/log2(2) + 1/log2(3)
    const dcg = 1 / Math.log2(3) + 1 / Math.log2(5);
    const idcg = 1 / Math.log2(2) + 1 / Math.log2(3);
    expect(ndcgAtK(ranked, rel, 4)).toBeCloseTo(dcg / idcg, 10);
    // perfect ordering → 1.0
    expect(ndcgAtK(["B", "D", "A", "C"], rel, 4)).toBeCloseTo(1, 10);
  });

  test("edge cases: empty relevant / empty ranked", () => {
    expect(recallAtK(ranked, [], 4)).toBe(0);
    expect(hitAtK([], rel, 4)).toBe(0);
    expect(ndcgAtK([], rel, 4)).toBe(0);
  });
});

describe("seeded shuffle is deterministic and a permutation", () => {
  test("same seed → same order; different seed → (usually) different", () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const a = seededShuffle(items, 42);
    const b = seededShuffle(items, 42);
    const c = seededShuffle(items, 43);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.slice().sort((x, y) => x - y)).toEqual(items); // still a permutation
    expect(items[0]).toBe(0); // input untouched (pure)
  });
});

describe("read-only evaluator coordinator contracts", () => {
  const report = (area: string, seed: number, hit3: number, corpus = "fictional"): AreaReport => ({
    area,
    corpus,
    seed,
    n: 1,
    metrics: { n: 1, hit1: hit3, hit3, hit5: hit3, mrr: hit3, ndcg5: hit3, recall3: hit3 },
    byBucket: {},
    latencyP50: seed,
    latencyP95: seed + 1,
    accuracy: hit3,
    perQuery: [],
    violations: [],
  });

  test("mode and repeat validation fails closed", () => {
    expect(() => parseEvalArgs(["--mode", "unknown"])).toThrow(/eval_mode_invalid/);
    expect(() => parseEvalArgs(["--mode", "mock", "--repeats", "2"])).toThrow(
      /eval_repeats_invalid/,
    );
    expect(() => parseEvalArgs(["--mode", "live", "--repeats", "2"])).toThrow(
      /eval_repeats_invalid/,
    );
    expect(parseEvalArgs(["--mode", "live", "--round", "live-r1"])).toMatchObject({
      mode: "live",
      repeats: 3,
    });
  });

  test("aggregation is area-keyed and median-stable even when worker results are unsorted", () => {
    const runs = [
      [report("zeta", 2654435771, 0.2), report("alpha", 2654435771, 1)],
      [report("alpha", 2654435769, 0.4), report("zeta", 2654435769, 0.8)],
      [report("zeta", 2654435770, 0.6), report("alpha", 2654435770, 0.6)],
    ];
    const median = aggregateReports(runs);
    expect(median.map((r) => r.area)).toEqual(["alpha", "zeta"]);
    expect(median.map((r) => r.seed)).toEqual([2654435770, 2654435770]);
    expect(median.map((r) => r.metrics.hit3)).toEqual([0.6, 0.6]);
  });

  test("worker result parsing requires one corpus and an explicit seed", () => {
    const valid = JSON.stringify({
      protocol: 1,
      kind: "minime-eval-result",
      mode: "mock",
      round: "mock",
      repeat: 0,
      corpus: "persona-en",
      seed: 2654435769,
      reports: [report("retrieval-en", 2654435769, 1, "persona-en")],
    });
    expect(parseWorkerResult(valid).corpus).toBe("persona-en");
    expect(() => parseWorkerResult(valid.replace('"seed":2654435769', '"seed":null'))).toThrow(
      /eval_worker_result_invalid/,
    );
    expect(() =>
      parseWorkerResult(valid.replace('"reports":[', '"reports":[{"area":"other"},')),
    ).toThrow(/eval_worker_result_invalid/);
  });

  test("scorecard publication refuses a dirty working tree", () => {
    expect(() => assertCleanWorkingTree(() => " M src/search/hybrid.ts\n")).toThrow(
      /eval_working_tree_dirty/,
    );
    expect(() => assertCleanWorkingTree(() => "")).not.toThrow();
  });
});

describe("runQrels smoke test (3-doc inline corpus)", () => {
  const docs = [
    {
      path: "smoke/quokka.md",
      title: "Quokka habitat field notes",
      body: "# Quokka habitat field notes\n\nQuokkas live on Rottnest Island and smile for photos.",
    },
    {
      path: "smoke/nyckelharpa.md",
      title: "Nyckelharpa basics",
      body: "# Nyckelharpa basics\n\nThe nyckelharpa is a Swedish keyed fiddle with sympathetic strings.",
    },
    {
      path: "smoke/sourdough.md",
      title: "Sourdough starter Gunnar",
      body: "# Sourdough starter Gunnar\n\nMy sourdough starter is named Gunnar and lives in the fridge.",
    },
  ];
  let qrelsPath: string;

  beforeAll(async () => {
    await resetDb();
    for (const d of docs) {
      const { id } = await upsertPage({
        path: d.path,
        title: d.title,
        bodyMd: d.body,
        contentHash: d.path,
      });
      await indexParent("page", id, d.body, d.title, 1);
    }
    const dir = mkdtempSync(join(tmpdir(), "minimebench-qrels-"));
    qrelsPath = join(dir, "smoke.json");
    writeFileSync(
      qrelsPath,
      JSON.stringify({
        version: 1,
        corpus: "smoke",
        area: "retrieval-smoke",
        entries: [
          {
            id: "s-1",
            query: "Swedish keyed fiddle sympathetic strings",
            relevant: ["Nyckelharpa basics"],
          },
          {
            id: "s-2",
            query: "what is my sourdough starter called",
            relevant: ["Sourdough starter Gunnar"],
          },
          {
            id: "s-3",
            query: "Rottnest Island animal that smiles",
            relevant: ["Quokka habitat field notes"],
          },
        ],
      }),
    );
  });

  test("hybridSearch finds the right doc for each query; report is well-formed", async () => {
    const report = await runQrels({ qrelsPath, seed: 7 });
    expect(report.n).toBe(3);
    expect(report.area).toBe("retrieval-smoke");
    expect(report.seed).toBe(7);
    // every query should retrieve its single relevant doc somewhere in top-5
    expect(report.metrics.hit5).toBe(1);
    expect(report.perQuery).toHaveLength(3);
    for (const p of report.perQuery) {
      expect(p.latencyMs).toBeGreaterThanOrEqual(0);
      expect(p.rank).toBeGreaterThanOrEqual(0);
    }
    expect(report.latencyP95).toBeGreaterThanOrEqual(report.latencyP50);
    // direct sanity check via the same black box
    const hits = await hybridSearch({ query: docs[0]!.body, limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
  });

  test("per-query order in the report is stable (id-sorted) regardless of seed", async () => {
    const a = await runQrels({ qrelsPath, seed: 1 });
    const b = await runQrels({ qrelsPath, seed: 999 });
    expect(a.perQuery.map((p) => p.id)).toEqual(["s-1", "s-2", "s-3"]);
    expect(b.perQuery.map((p) => p.id)).toEqual(["s-1", "s-2", "s-3"]);
  });
});

describe("sealed qrels load and parse", () => {
  test("all committed qrels files parse with the required shape", () => {
    const files = readdirSync(join(import.meta.dir, "../fixtures/qrels"))
      .filter((f) => f.endsWith(".json"))
      .sort();
    expect(files).toContain("decision-digest.json");
    for (const f of files) {
      const q = loadQrels(join(import.meta.dir, "../fixtures/qrels", f));
      expect(q.version).toBe(1);
      expect(q.entries.length).toBeGreaterThan(0);
      for (const e of q.entries) {
        expect(typeof e.id).toBe("string");
        expect(typeof e.query).toBe("string");
      }
    }
  });
});

describe("baseline regression detection", () => {
  const baseline = new Map<string, BaselineLine>([
    ["retrieval-en::hit1", { area: "retrieval-en", metric: "hit1", value: 0.92 }],
    ["retrieval-en::hit3", { area: "retrieval-en", metric: "hit3", value: 0.99 }],
    [
      "retrieval-en::latency_p95_ms",
      { area: "retrieval-en", metric: "latency_p95_ms", value: 100, lowerBetter: true },
    ],
    ["identity::accuracy", { area: "identity", metric: "accuracy", value: 0.9, provisional: true }],
  ]);

  test("a metric dropping below baseline − tolerance is flagged", () => {
    const current: Measurement[] = [
      { area: "retrieval-en", metric: "hit1", value: 0.8 }, // −0.12 → regression
      { area: "retrieval-en", metric: "hit3", value: 0.99 }, // unchanged → ok
    ];
    const regs = diffBaseline(current, baseline);
    expect(regs).toHaveLength(1);
    expect(regs[0]!.metric).toBe("hit1");
    expect(regs[0]!.current).toBe(0.8);
    expect(regs[0]!.baseline).toBe(0.92);
    // this non-empty array is exactly what makes the runner exit non-zero
    expect(regs.length > 0).toBe(true);
  });

  test("within-tolerance jitter does not regress; latency rise does", () => {
    const ok: Measurement[] = [{ area: "retrieval-en", metric: "hit3", value: 0.985 }]; // −0.005 < tol
    expect(diffBaseline(ok, baseline)).toHaveLength(0);
    const slow: Measurement[] = [
      { area: "retrieval-en", metric: "latency_p95_ms", value: 300, lowerBetter: true },
    ];
    expect(diffBaseline(slow, baseline)).toHaveLength(1);
  });

  test("provisional regressions are flagged but tagged provisional", () => {
    const current: Measurement[] = [{ area: "identity", metric: "accuracy", value: 0.5 }];
    const regs = diffBaseline(current, baseline);
    expect(regs).toHaveLength(1);
    expect(regs[0]!.provisional).toBe(true);
  });

  test("missing metric floors are reported when a baseline exists", () => {
    const current: Measurement[] = [
      { area: "retrieval-en", metric: "hit1", value: 0.92 },
      { area: "retrieval-en", metric: "bucket:new-bucket:hit3", value: 1 },
    ];
    const gaps = missingBaselineMeasurements(current, baseline);
    expect(gaps).toEqual([{ area: "retrieval-en", metric: "bucket:new-bucket:hit3", current: 1 }]);
  });

  test("baseline round-trips through serialize", () => {
    const text = serializeBaseline([...baseline.values()]);
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(baseline.size);
    expect(JSON.parse(lines[0]!)).toHaveProperty("area");
  });

  test("missing, empty, unreadable, and malformed baselines fail closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "minimebench-baseline-validation-"));
    const missing = join(dir, "missing.ndjson");
    expect(() => loadBaseline(missing)).toThrow(/baseline.*missing/i);
    expect(existsSync(missing)).toBe(false);

    const empty = join(dir, "empty.ndjson");
    writeFileSync(empty, "\n");
    expect(() => loadBaseline(empty)).toThrow(/baseline.*empty/i);

    const malformed = join(dir, "malformed.ndjson");
    writeFileSync(malformed, '{"area":"retrieval-en"}\n');
    expect(() => loadBaseline(malformed)).toThrow(/baseline.*malformed/i);

    const unreadable = join(dir, "unreadable.ndjson");
    mkdirSync(unreadable);
    expect(() => loadBaseline(unreadable)).toThrow(/baseline.*unreadable/i);
  });

  test("published scorecards retain evaluated metadata and every run result", () => {
    const report = (seed: number, hit3: number): AreaReport => ({
      area: "retrieval-en",
      corpus: "persona-en",
      seed,
      n: 1,
      metrics: { n: 1, hit1: hit3, hit3, hit5: 1, mrr: hit3, ndcg5: hit3, recall3: hit3 },
      byBucket: {},
      latencyP50: seed,
      latencyP95: seed + 1,
      accuracy: hit3,
      perQuery: [
        {
          id: `q-${seed}`,
          query: "q",
          rank: hit3 === 1 ? 0 : -1,
          hit1: hit3 === 1,
          hit3: hit3 === 1,
          hit5: hit3 === 1,
          reciprocalRank: hit3,
          ndcg5: hit3,
          latencyMs: seed,
          topTitle: hit3 === 1 ? "answer" : null,
          ok: hit3 === 1,
        },
      ],
      violations: [],
    });
    const md = buildScorecard({
      date: "2026-08-05",
      round: "release-v1",
      mode: "live",
      baselineExisted: true,
      regressions: [],
      reports: [report(12, 0.5)],
      runs: [[report(11, 1)], [report(12, 0.5)]],
      evaluatedCommit: "abc1234",
      datasetHash: "sha256:deadbeef",
      configuration: {
        provider: "openrouter",
        model: "qwen/qwen3-embedding-8b",
        reranker: { enabled: true, model: "bge-reranker-v2-m3", topIn: 20 },
      },
    });

    expect(md).toContain("Evaluated commit: `abc1234`");
    expect(md).toContain("Dataset hash: `sha256:deadbeef`");
    expect(md).toContain("Provider: `openrouter`");
    expect(md).toContain("Model: `qwen/qwen3-embedding-8b`");
    expect(md).toContain("Reranker: enabled (bge-reranker-v2-m3, top-in 20)");
    expect(md).toContain("Run 1 (seed 11)");
    expect(md).toContain("Run 2 (seed 12)");
    expect(md).toContain("50.0%");
    expect(md).toContain("100.0%");
  });

  test("scorecard publishes regressions, never headline-only", () => {
    const md = buildScorecard({
      date: "2026-06-12",
      round: "test",
      mode: "mock",
      baselineExisted: true,
      regressions: [
        {
          area: "retrieval-en",
          metric: "hit1",
          baseline: 0.92,
          current: 0.8,
          delta: -0.12,
          provisional: false,
        },
      ],
      reports: [
        {
          area: "retrieval-en",
          corpus: "persona-en",
          seed: 1,
          n: 1,
          metrics: { n: 1, hit1: 0.8, hit3: 1, hit5: 1, mrr: 1, ndcg5: 1, recall3: 1 },
          byBucket: {},
          latencyP50: 1,
          latencyP95: 2,
          accuracy: 0.8,
          perQuery: [
            {
              id: "x-1",
              query: "q",
              rank: -1,
              hit1: false,
              hit3: false,
              hit5: false,
              reciprocalRank: 0,
              ndcg5: 0,
              latencyMs: 1,
              topTitle: null,
              ok: false,
            },
          ],
          violations: [],
        },
      ],
    });
    expect(md).toContain("Baseline diff");
    expect(md).toContain("0.12"); // the regression delta is published
    expect(md).toContain("Misses (1/1)"); // bad numbers shown
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
  });
});
