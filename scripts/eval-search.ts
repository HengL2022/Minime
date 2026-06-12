// MinimeBench runner (Phase 1b). Loads each fictional corpus into a scratch DB
// (EVAL_DATABASE_URL), syncs it, runs every area's sealed qrels through hybridSearch,
// diffs against the committed baseline, writes a dated scorecard to docs/benchmarks/, prints
// the area table, and exits non-zero on any regression beyond tolerance.
//
//   bun run scripts/eval-search.ts --mode mock --round mock
//   bun run scripts/eval-search.ts --mode live --round live-r1 --repeats 3
//
// Offline (mock) is deterministic N=1; live runs N=3 and reports min/median/max latency.
// EVAL_DATABASE_URL must point at a throwaway database — the runner DROPs all tables in it.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AreaReport,
  type BaselineLine,
  type Measurement,
  areaTable,
  buildScorecard,
  diffBaseline,
  loadBaseline,
  measurements,
  runQrels,
  seedFor,
  serializeBaseline,
} from "../src/search/eval";
import { config } from "../src/util/config";

const ROOT = join(import.meta.dir, "..");
const QRELS_DIR = join(ROOT, "fixtures/qrels");
const CORPORA_DIR = join(ROOT, "fixtures/eval-corpora");
const RESULTS_DIR = join(ROOT, "docs", "benchmarks");
const BASELINE_PATH = join(QRELS_DIR, "baseline.ndjson");

// Area → qrels file + which corpus it runs against. Order = printed/scorecard order.
const AREAS: { area: string; file: string; corpus: string }[] = [
  { area: "retrieval-en", file: "retrieval-en.json", corpus: "persona-en" },
  { area: "retrieval-zh", file: "retrieval-zh.json", corpus: "bilingual-zh" },
  { area: "graph", file: "graph.json", corpus: "persona-en" },
  { area: "identity", file: "identity.json", corpus: "persona-en" },
  { area: "time", file: "time.json", corpus: "persona-en" },
  { area: "provenance", file: "provenance.json", corpus: "persona-en" },
  { area: "robustness", file: "robustness.json", corpus: "persona-en" },
];

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Sync a corpus into the freshly-reset scratch DB by pointing MINIME_DATA_DIR at it.
async function loadCorpus(corpus: string): Promise<void> {
  const { resetDb } = await import("../test/helpers");
  await resetDb(); // drop + migrate the scratch DB (sanctioned reset path)
  process.env.MINIME_DATA_DIR = join(CORPORA_DIR, corpus);
  (config as { dataDir: string }).dataDir = join(CORPORA_DIR, corpus);
  const { brainSync } = await import("../src/pipeline/brain-sync");
  const { drainEmbedBacklog } = await import("../src/search/index-parent");
  const stats = await brainSync();
  await drainEmbedBacklog();
  console.error(`  synced ${corpus}: ${JSON.stringify(stats)}`);
}

async function runAll(seed: number): Promise<AreaReport[]> {
  const reports: AreaReport[] = [];
  let loaded: string | null = null;
  for (const a of AREAS) {
    if (loaded !== a.corpus) {
      await loadCorpus(a.corpus);
      loaded = a.corpus;
    }
    const report = await runQrels({ qrelsPath: join(QRELS_DIR, a.file), seed });
    reports.push(report);
  }
  return reports;
}

// Merge N repeats: keep the median report per area, record min/median/max p95 latency.
function medianReports(runs: AreaReport[][]): AreaReport[] {
  if (runs.length === 1) return runs[0]!;
  const out: AreaReport[] = [];
  for (let i = 0; i < runs[0]!.length; i++) {
    const variants = runs.map((r) => r[i]!);
    const sorted = variants.slice().sort((a, b) => a.metrics.hit3 - b.metrics.hit3);
    const med = sorted[Math.floor(sorted.length / 2)]!;
    const p95s = variants.map((v) => v.latencyP95).sort((a, b) => a - b);
    out.push({
      ...med,
      latencyP95: p95s[Math.floor(p95s.length / 2)]!,
    });
    console.error(
      `  ${med.area}: hit@3 min/med/max = ${variants
        .map((v) => `${(100 * v.metrics.hit3).toFixed(1)}%`)
        .join(" / ")}; p95 ${p95s[0]}/${p95s[Math.floor(p95s.length / 2)]}/${p95s.at(-1)}ms`,
    );
  }
  return out;
}

async function main(): Promise<number> {
  const mode = (flag("mode", "mock") as "mock" | "live") ?? "mock";
  const round = flag("round", mode) ?? mode;
  const repeats = mode === "live" ? Number(flag("repeats", "3")) : 1;

  if (!process.env.EVAL_DATABASE_URL) {
    console.error("ERROR: EVAL_DATABASE_URL must point at a throwaway scratch database.");
    return 2;
  }
  // HARD GUARD (incident 2026-06-12): the pool binds to DATABASE_URL at module load, so an
  // in-process swap cannot retarget it. The runner must be STARTED with
  // DATABASE_URL=EVAL_DATABASE_URL (the make targets do this), and the connected database's
  // own name must say it is a scratch eval DB. Refuse otherwise — this runner drops tables.
  if (process.env.DATABASE_URL !== process.env.EVAL_DATABASE_URL) {
    console.error(
      "ERROR: refusing to run — DATABASE_URL must equal EVAL_DATABASE_URL at process start " +
        "(use the make targets; the pool binds before main() runs).",
    );
    return 2;
  }
  const { sql } = await import("../src/db/client");
  const [{ db }] = (await sql`select current_database() as db`) as unknown as [{ db: string }];
  if (!/eval/i.test(db)) {
    console.error(
      `ERROR: refusing to run — connected database "${db}" is not named like a scratch eval DB.`,
    );
    return 2;
  }
  (config as { databaseUrl: string }).databaseUrl = process.env.EVAL_DATABASE_URL;

  console.error(`MinimeBench: mode=${mode} round=${round} repeats=${repeats} db=${db}`);
  const runs: AreaReport[][] = [];
  for (let i = 0; i < repeats; i++) {
    const seed = seedFor(repeats > 1 ? (seedFor() + i) >>> 0 : undefined);
    console.error(`-- repeat ${i + 1}/${repeats} (seed ${seed}) --`);
    runs.push(await runAll(seed));
  }
  const reports = medianReports(runs);

  const baseline = loadBaseline(BASELINE_PATH);
  const baselineExisted = baseline.size > 0;
  const current: Measurement[] = reports.flatMap(measurements);
  // The committed floors are mock-mode (engine compute). In live mode, latency includes the
  // embedding provider's network round-trip (~0.5–1.5s) — report it, but never gate on it;
  // the p95 bar applies to engine compute, which the mock run measures.
  const regressions = diffBaseline(current, baseline).filter(
    (r) => !(mode === "live" && r.metric === "latency_p95_ms"),
  );

  // Scorecard (committed in docs/benchmarks/) — ALL numbers, misses included.
  mkdirSync(RESULTS_DIR, { recursive: true });
  const scorecardPath = join(RESULTS_DIR, `${todayStr()}-${round}-minimebench.md`);
  writeFileSync(
    scorecardPath,
    buildScorecard({ date: todayStr(), round, mode, reports, regressions, baselineExisted }),
  );

  // First real run establishes the committed floor (NEW areas marked provisional).
  if (!baselineExisted) {
    const lines = baselineLinesFrom(current);
    writeFileSync(BASELINE_PATH, serializeBaseline(lines));
    console.error(`baseline established: ${BASELINE_PATH} (${lines.length} metrics)`);
  }

  console.log(`\n${areaTable(reports)}\n`);
  console.error(`scorecard: ${scorecardPath}`);

  const violations = reports.flatMap((r) => r.violations);
  if (violations.length) {
    console.error(`ROBUSTNESS VIOLATIONS (${violations.length}):`);
    for (const v of violations) console.error(`  - ${v}`);
    return 1;
  }
  if (regressions.length) {
    console.error(`REGRESSIONS beyond tolerance (${regressions.length}):`);
    for (const r of regressions)
      console.error(`  - ${r.area}/${r.metric}: ${r.baseline} -> ${r.current} (${r.delta})`);
    return 1;
  }
  console.error("OK: all bars held, no regression.");
  return 0;
}

// NEW areas (no committed measurement before this cycle) get their plan bars recorded as
// provisional so the next run diffs against a real floor.
const PLAN_BARS: Record<string, Record<string, number>> = {
  "retrieval-en": { hit1: 0.92, hit3: 0.99 },
  "retrieval-zh": { hit3: 0.95 },
  graph: { accuracy: 1.0 },
  identity: { accuracy: 0.9 },
  time: { accuracy: 0.8 },
  provenance: { accuracy: 0.95 },
  robustness: { accuracy: 1.0 },
};
const NEW_AREAS = new Set(["identity", "time", "provenance", "robustness"]);

function baselineLinesFrom(current: Measurement[]): BaselineLine[] {
  return current.map((m) => {
    const bar = PLAN_BARS[m.area]?.[m.metric];
    return {
      area: m.area,
      metric: m.metric,
      value: m.value,
      ...(m.lowerBetter ? { lowerBetter: true } : {}),
      ...(NEW_AREAS.has(m.area) ? { provisional: true } : {}),
      ...(bar !== undefined ? { bar } : {}),
    };
  });
}

const code = await main();
const { closeDb } = await import("../src/db/client");
await closeDb();
process.exit(code);
