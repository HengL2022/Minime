// MinimeBench: area-based retrieval eval harness (Phase 1b, search-uplift plan).
//
// Two layers:
//   1. Pure IR metrics (precisionAtK / recallAtK / mrr / ndcgAtK / hitAtK) over plain
//      arrays — no DB, no I/O, unit-testable against hand-computed expectations.
//   2. runQrels(): loads a SEALED qrels file (the search path never reads these), runs
//      `hybridSearch` as a black box over the queries in seeded-random order, and returns
//      a structured report (per-query rank, per-bucket + per-area metrics, p50/p95 latency,
//      the seed). hybridSearch is consumed only through its public type — that black box is
//      exactly what keeps the gold sealed (anti-gaming rule).
//
// Graph + provenance areas additionally probe via existing repo READ functions
// (entitiesNamedIn / oneHopNeighbors / parentMeta / getRow) — never new SQL, never the LLM.

import { readFileSync } from "node:fs";
import { type ParentType, entitiesNamedIn, getRow, oneHopNeighbors, parentMeta } from "../db/repo";
import { type Hit, hybridSearch } from "./hybrid";

// ---------------------------------------------------------------- pure IR metrics
//
// Each takes a ranked list of item keys (`ranked`) and the set of relevant keys
// (`relevant`). Keys are opaque strings — titles, ids, whatever the caller compares on.
// rel[i] = 1 if ranked[i] is relevant, else 0.

function relevanceVector(ranked: string[], relevant: Iterable<string>, k: number): number[] {
  const rel = new Set(relevant);
  return ranked.slice(0, k).map((r) => (rel.has(r) ? 1 : 0));
}

/** Fraction of the top-k that are relevant. */
export function precisionAtK(ranked: string[], relevant: Iterable<string>, k: number): number {
  if (k <= 0) return 0;
  const hits = relevanceVector(ranked, relevant, k).reduce((a, b) => a + b, 0);
  return hits / k;
}

/** Fraction of relevant items recovered within the top-k. */
export function recallAtK(ranked: string[], relevant: Iterable<string>, k: number): number {
  const rel = new Set(relevant);
  if (rel.size === 0) return 0;
  const found = new Set(ranked.slice(0, k).filter((r) => rel.has(r)));
  return found.size / rel.size;
}

/** 1 if any relevant item appears in the top-k, else 0. */
export function hitAtK(ranked: string[], relevant: Iterable<string>, k: number): number {
  return relevanceVector(ranked, relevant, k).some((x) => x === 1) ? 1 : 0;
}

/** Reciprocal rank of the first relevant item within the top-k (0 if none). */
export function mrr(ranked: string[], relevant: Iterable<string>, k = ranked.length): number {
  const rel = new Set(relevant);
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (rel.has(ranked[i]!)) return 1 / (i + 1);
  }
  return 0;
}

/** Binary-gain nDCG@k (ideal = relevant items packed at the front). */
export function ndcgAtK(ranked: string[], relevant: Iterable<string>, k: number): number {
  const rel = relevanceVector(ranked, relevant, k);
  const dcg = rel.reduce((acc, g, i) => acc + g / Math.log2(i + 2), 0);
  const ideal = Math.min(new Set(relevant).size, k);
  let idcg = 0;
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

/** 0-based rank of the first relevant item (−1 if none in the list). */
export function firstRelevantRank(ranked: string[], relevant: Iterable<string>): number {
  const rel = new Set(relevant);
  return ranked.findIndex((r) => rel.has(r));
}

// ---------------------------------------------------------------- seeded RNG
//
// mulberry32 — same PRNG family as the embedding mock; deterministic from a 32-bit seed so
// every run's question order is reproducible and the seed is printed in the scorecard.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle driven by a seeded PRNG; pure (returns a new array). */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = items.slice();
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ---------------------------------------------------------------- qrels format

export interface GraphProbe {
  probe: "worksAtOrg" | "employerOf" | "orgExists" | "byRelation";
  arg: string;
  expect: string[];
}

export interface QrelEntry {
  id: string;
  query: string;
  relevant?: string[];
  bucket?: string;
  asOf?: string;
  graph?: GraphProbe;
  prov?: { derived: boolean; created_by: string };
}

export interface QrelFile {
  version: number;
  corpus: string;
  area: string;
  note?: string;
  tierSentinel?: string;
  lockedTitle?: string;
  entries: QrelEntry[];
}

export function loadQrels(path: string): QrelFile {
  const data = JSON.parse(readFileSync(path, "utf8")) as QrelFile;
  if (!Array.isArray(data.entries)) throw new Error(`qrels ${path}: no entries[]`);
  return data;
}

// ---------------------------------------------------------------- report shapes

export interface PerQuery {
  id: string;
  query: string;
  bucket?: string;
  rank: number; // 0-based rank of the first relevant hit; -1 = miss
  hit1: boolean;
  hit3: boolean;
  hit5: boolean;
  reciprocalRank: number;
  ndcg5: number;
  latencyMs: number;
  topTitle: string | null;
  ok: boolean; // area-specific pass (retrieval: hit3; graph/prov/robustness: see runner)
  detail?: string; // why a non-retrieval check failed
}

export interface MetricBlock {
  n: number;
  hit1: number;
  hit3: number;
  hit5: number;
  mrr: number;
  ndcg5: number;
  recall3: number;
}

export interface AreaReport {
  area: string;
  corpus: string;
  seed: number;
  n: number;
  metrics: MetricBlock;
  byBucket: Record<string, MetricBlock>;
  latencyP50: number;
  latencyP95: number;
  /** area-specific headline accuracy (graph answer rate / provenance accuracy / robustness pass). */
  accuracy: number;
  perQuery: PerQuery[];
  /** robustness only: queries that crashed or leaked tier-locked content. */
  violations: string[];
}

function emptyBlock(): { n: number; sums: number[] } {
  return { n: 0, sums: [0, 0, 0, 0, 0, 0] };
}

function blockFrom(rows: PerQuery[]): MetricBlock {
  const n = rows.length;
  if (n === 0) return { n: 0, hit1: 0, hit3: 0, hit5: 0, mrr: 0, ndcg5: 0, recall3: 0 };
  const sum = (f: (r: PerQuery) => number) => rows.reduce((a, r) => a + f(r), 0);
  return {
    n,
    hit1: sum((r) => (r.hit1 ? 1 : 0)) / n,
    hit3: sum((r) => (r.hit3 ? 1 : 0)) / n,
    hit5: sum((r) => (r.hit5 ? 1 : 0)) / n,
    mrr: sum((r) => r.reciprocalRank) / n,
    ndcg5: sum((r) => r.ndcg5) / n,
    recall3: sum((r) => (r.hit3 ? 1 : 0)) / n, // single-target qrels: recall3 == hit3
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, idx)]! * 100) / 100;
}

// ---------------------------------------------------------------- graph probe (repo reads)
//
// Answers a relational question using ONLY the search-path graph primitives + parentMeta —
// the same reads hybridSearch uses for its 1-hop boost. No new SQL, no LLM.

async function namesOf(refs: { type: "person" | "org"; id: string }[]): Promise<string[]> {
  const out: string[] = [];
  const byType = new Map<ParentType, string[]>();
  for (const r of refs) byType.set(r.type, [...(byType.get(r.type) ?? []), r.id]);
  for (const [type, ids] of byType) {
    for (const [, m] of await parentMeta(type, ids)) out.push(m.title);
  }
  return out;
}

async function graphNeighborNames(query: string): Promise<string[]> {
  const named = await entitiesNamedIn(query);
  if (named.length === 0) return [];
  const neighbors = await oneHopNeighbors(named);
  const refs = [...neighbors].map((key) => {
    const [t, id] = key.split(":");
    return { type: t as "person" | "org", id: id! };
  });
  return namesOf(refs);
}

// ---------------------------------------------------------------- core runner

export interface RunOpts {
  qrelsPath: string;
  /** root dir whose `brain/` was synced into the scratch DB (recorded for the scorecard). */
  corpusDir?: string;
  seed?: number;
  limit?: number;
}

// Overrideable via env so live runs can vary the order per repeat.
export function seedFor(explicit?: number): number {
  if (explicit !== undefined) return explicit >>> 0;
  const env = process.env.MINIME_EVAL_SEED;
  if (env && /^\d+$/.test(env)) return Number(env) >>> 0;
  return 0x9e3779b9; // golden-ratio constant — fixed default keeps mock runs deterministic
}

export async function runQrels(opts: RunOpts): Promise<AreaReport> {
  const qrels = loadQrels(opts.qrelsPath);
  const seed = seedFor(opts.seed);
  const limit = opts.limit ?? 5;
  const order = seededShuffle(qrels.entries, seed);

  const perQuery: PerQuery[] = [];
  const violations: string[] = [];
  const latencies: number[] = [];

  for (const entry of order) {
    const t0 = performance.now();
    let hits: Hit[] = [];
    let crashed = false;
    try {
      hits = await hybridSearch({ query: entry.query, limit: Math.max(limit, 5) });
    } catch (e) {
      crashed = true;
      violations.push(`${entry.id} CRASH: ${(e as Error).message}`);
    }
    const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
    latencies.push(latencyMs);

    const titles = hits.map((h) => h.title);
    const relevant = entry.relevant ?? [];
    const rank = relevant.length ? firstRelevantRank(titles, relevant) : -1;
    const pq: PerQuery = {
      id: entry.id,
      query: entry.query,
      bucket: entry.bucket,
      rank,
      hit1: rank === 0,
      hit3: rank >= 0 && rank < 3,
      hit5: rank >= 0 && rank < 5,
      reciprocalRank: rank >= 0 ? 1 / (rank + 1) : 0,
      ndcg5: ndcgAtK(titles, relevant, 5),
      latencyMs,
      topTitle: titles[0] ?? null,
      ok: rank >= 0 && rank < 3,
    };

    // ---- area-specific overrides ----
    if (qrels.area === "robustness") {
      const sentinel = qrels.tierSentinel;
      const leaked =
        !crashed &&
        sentinel !== undefined &&
        hits.some((h) => h.title === qrels.lockedTitle || JSON.stringify(h).includes(sentinel));
      if (leaked) violations.push(`${entry.id} TIER-LEAK: surfaced locked content`);
      pq.ok = !crashed && !leaked;
      pq.detail = crashed ? "crashed" : leaked ? "tier-leak" : "no-crash/no-leak";
    } else if (qrels.area === "graph" && entry.graph) {
      const want = entry.graph.expect;
      const neighborNames = crashed ? [] : await graphNeighborNames(entry.query);
      const retrievedOk = pq.hit3;
      const graphOk = want.every((w) =>
        neighborNames.some((n) => n.toLowerCase().includes(w.toLowerCase())),
      );
      // graph answer rate: either the typed-edge graph yields every expected name, OR the
      // documenting page is retrieved in top-3 (relation-style queries name no entity).
      pq.ok = graphOk || retrievedOk;
      pq.detail = graphOk ? "graph-edges" : retrievedOk ? "retrieval-fallback" : "miss";
    } else if (qrels.area === "provenance" && entry.prov) {
      const top = hits[0] ?? null;
      const titleOk = top !== null && relevant.includes(top.title);
      let provOk = false;
      let detail = "no-top-hit";
      if (top) {
        const row = await getRow(top.type, top.id).catch(() => null);
        const idOk = row !== null;
        provOk =
          idOk && top.derived === entry.prov.derived && top.created_by === entry.prov.created_by;
        detail = !idOk
          ? "stale-id"
          : !provOk
            ? `prov-mismatch(derived=${top.derived},by=${top.created_by})`
            : "prov-ok";
      }
      pq.ok = titleOk && provOk;
      pq.detail = detail;
    }

    perQuery.push(pq);
  }

  // restore submission order (id-sorted) for stable scorecards
  perQuery.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  const byBucket: Record<string, MetricBlock> = {};
  const bucketKeys = new Set(perQuery.map((p) => p.bucket).filter(Boolean) as string[]);
  for (const b of bucketKeys) byBucket[b] = blockFrom(perQuery.filter((p) => p.bucket === b));

  const accuracy = perQuery.length ? perQuery.filter((p) => p.ok).length / perQuery.length : 0;

  return {
    area: qrels.area,
    corpus: qrels.corpus,
    seed,
    n: perQuery.length,
    metrics: blockFrom(perQuery),
    byBucket,
    latencyP50: percentile(latencies, 50),
    latencyP95: percentile(latencies, 95),
    accuracy,
    perQuery,
    violations,
  };
}

// ---------------------------------------------------------------- measurements & baseline
//
// A "measurement" is one (area, metric, value) triple. Higher is better for every metric
// except those flagged lowerBetter (latency). The baseline file commits the floor; a run
// regresses when a metric drops below baseline − tolerance (or, for latency, rises above
// baseline + tolerance). NEW-area bars from the plan ship as `provisional` until the first
// real run replaces them.

export interface Measurement {
  area: string;
  metric: string;
  value: number;
  lowerBetter?: boolean;
}

// Default tolerance band. The mock embedding is byte-identical across machines, but pgvector's
// HNSW index is APPROXIMATE and breaks near-cosine ties differently across pg builds (CI pg16
// vs a dev box's pg17) — identical code produced a 0.02 swing between the baseline commit and
// its first CI run. On small-n areas the metric resolution is already coarse (identity n=16 →
// 0.0625 per hit@1 flip), so the band must absorb a single cross-environment tie-flip. 0.03
// catches a genuine ≥2-item regression while ignoring approximate-index jitter (DECISIONS.md
// 2026-06-12). Latency tolerance is absolute milliseconds.
export const DEFAULT_TOLERANCE = 0.03;
export const LATENCY_TOLERANCE_MS = 50;

export function measurements(report: AreaReport): Measurement[] {
  const m = report.metrics;
  const out: Measurement[] = [
    { area: report.area, metric: "hit1", value: round(m.hit1) },
    { area: report.area, metric: "hit3", value: round(m.hit3) },
    { area: report.area, metric: "hit5", value: round(m.hit5) },
    { area: report.area, metric: "mrr", value: round(m.mrr) },
    { area: report.area, metric: "ndcg5", value: round(m.ndcg5) },
    { area: report.area, metric: "accuracy", value: round(report.accuracy) },
    {
      area: report.area,
      metric: "latency_p95_ms",
      value: report.latencyP95,
      lowerBetter: true,
    },
  ];
  for (const [bucket, blk] of Object.entries(report.byBucket)) {
    out.push({ area: report.area, metric: `bucket:${bucket}:hit3`, value: round(blk.hit3) });
    out.push({ area: report.area, metric: `bucket:${bucket}:hit1`, value: round(blk.hit1) });
  }
  return out;
}

function round(x: number): number {
  return Math.round(x * 10000) / 10000;
}

export interface BaselineLine {
  area: string;
  metric: string;
  value: number;
  lowerBetter?: boolean;
  provisional?: boolean;
  bar?: number; // committed plan bar, for reference in the scorecard
}

export function loadBaseline(path: string): Map<string, BaselineLine> {
  const out = new Map<string, BaselineLine>();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out; // no baseline yet → first run establishes it
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const obj = JSON.parse(t) as BaselineLine;
    out.set(`${obj.area}::${obj.metric}`, obj);
  }
  return out;
}

export function serializeBaseline(lines: BaselineLine[]): string {
  return `${lines
    .slice()
    .sort((a, b) => `${a.area}::${a.metric}`.localeCompare(`${b.area}::${b.metric}`))
    .map((l) => JSON.stringify(l))
    .join("\n")}\n`;
}

export interface Regression {
  area: string;
  metric: string;
  baseline: number;
  current: number;
  delta: number;
  provisional: boolean;
}

/** Compare current measurements against the baseline; return regressions beyond tolerance. */
export function diffBaseline(
  current: Measurement[],
  baseline: Map<string, BaselineLine>,
): Regression[] {
  const regressions: Regression[] = [];
  for (const cur of current) {
    const base = baseline.get(`${cur.area}::${cur.metric}`);
    if (!base) continue; // metric not yet committed → no floor to violate
    const tol = cur.lowerBetter ? LATENCY_TOLERANCE_MS : DEFAULT_TOLERANCE;
    const regressed = cur.lowerBetter ? cur.value > base.value + tol : cur.value < base.value - tol;
    if (regressed) {
      regressions.push({
        area: cur.area,
        metric: cur.metric,
        baseline: base.value,
        current: cur.value,
        delta: round(cur.value - base.value),
        provisional: base.provisional ?? false,
      });
    }
  }
  return regressions;
}

// ---------------------------------------------------------------- area table & scorecard

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

/** The compact area table printed to stdout by both make targets. */
export function areaTable(reports: AreaReport[]): string {
  const head = "| Area | n | hit@1 | hit@3 | hit@5 | MRR | nDCG@5 | accuracy | p50ms | p95ms |";
  const sep = "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|";
  const rows = reports.map((r) => {
    const m = r.metrics;
    return `| ${r.area} | ${r.n} | ${pct(m.hit1)} | ${pct(m.hit3)} | ${pct(m.hit5)} | ${m.mrr.toFixed(3)} | ${m.ndcg5.toFixed(3)} | ${pct(r.accuracy)} | ${r.latencyP50} | ${r.latencyP95} |`;
  });
  return [head, sep, ...rows].join("\n");
}

export interface ScorecardInput {
  date: string; // YYYY-MM-DD
  round: string; // e.g. "mock", "live-r1"
  mode: "mock" | "live";
  reports: AreaReport[];
  regressions: Regression[];
  baselineExisted: boolean;
}

/** Full markdown scorecard — ALL numbers, including misses and known-weak areas. */
export function buildScorecard(input: ScorecardInput): string {
  const { reports, regressions } = input;
  const seeds = [...new Set(reports.map((r) => r.seed))].join(", ");
  const lines: string[] = [];
  lines.push(`# MinimeBench scorecard — ${input.date} (${input.round})`);
  lines.push("");
  lines.push(
    `Mode: **${input.mode}** (${input.mode === "mock" ? "MINIME_MOCK_OLLAMA=1, deterministic N=1" : "configured embed provider, N=3 min/median/max"}). ` +
      `Seed(s): ${seeds}. Judges: none (all deterministic, MinimeBench v1).`,
  );
  lines.push("");
  lines.push("## Area table");
  lines.push("");
  lines.push(areaTable(reports));
  lines.push("");

  lines.push("## Baseline diff");
  lines.push("");
  if (!input.baselineExisted) {
    lines.push("No prior baseline — this run establishes `fixtures/qrels/baseline.ndjson`.");
  } else if (regressions.length === 0) {
    lines.push("No regression beyond tolerance. All committed floors held.");
  } else {
    lines.push("| Area | Metric | Baseline | Current | Delta | Provisional |");
    lines.push("|---|---|---:|---:|---:|:---:|");
    for (const r of regressions) {
      lines.push(
        `| ${r.area} | ${r.metric} | ${r.baseline} | ${r.current} | ${r.delta} | ${r.provisional ? "yes" : "no"} |`,
      );
    }
  }
  lines.push("");

  // Publish the bad numbers: per-area misses + robustness violations, never headline-only.
  for (const r of reports) {
    lines.push(`## ${r.area} — detail (corpus: ${r.corpus})`);
    lines.push("");
    if (Object.keys(r.byBucket).length) {
      lines.push("Buckets:");
      lines.push("");
      lines.push("| bucket | n | hit@1 | hit@3 | hit@5 | MRR |");
      lines.push("|---|---:|---:|---:|---:|---:|");
      for (const [b, blk] of Object.entries(r.byBucket)) {
        lines.push(
          `| ${b} | ${blk.n} | ${pct(blk.hit1)} | ${pct(blk.hit3)} | ${pct(blk.hit5)} | ${blk.mrr.toFixed(3)} |`,
        );
      }
      lines.push("");
    }
    const misses = r.perQuery.filter((p) => !p.ok);
    lines.push(`Misses (${misses.length}/${r.n}):`);
    lines.push("");
    if (misses.length === 0) {
      lines.push("- none");
    } else {
      for (const p of misses) {
        const top = p.topTitle ? `top="${p.topTitle}"` : "top=∅";
        const why = p.detail ? ` [${p.detail}]` : "";
        lines.push(`- ${p.id} rank=${p.rank >= 0 ? p.rank + 1 : "-"} ${top}${why} :: ${p.query}`);
      }
    }
    if (r.violations.length) {
      lines.push("");
      lines.push("Violations (must be empty):");
      for (const v of r.violations) lines.push(`- ${v}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
