// M9 (Phase 1b): MinimeBench eval harness. Three concerns:
//   1. pure IR metric math against hand-computed expectations (no DB);
//   2. runQrels() smoke test over a 3-doc inline corpus in the test DB;
//   3. baseline-regression detection — inject a fake regression, assert it is caught
//      (the same Regression[] that drives the runner's non-zero exit).

import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertPage } from "../src/db/repo";
import {
  type BaselineLine,
  type Measurement,
  buildScorecard,
  diffBaseline,
  hitAtK,
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
