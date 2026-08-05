#!/usr/bin/env bun

// MinimeBench coordinator. The coordinator is deliberately outside the application worker:
// it owns only qrels/baseline aggregation and scorecard policy. Every corpus/repeat is executed
// by a fresh parent-owned test-database wrapper, which starts scripts/eval-search-worker.ts with
// only the restricted minime_app DSN.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
  missingBaselineMeasurements,
  seedFor,
} from "../src/search/eval";

const ROOT = join(import.meta.dir, "..");
const QRELS_DIR = join(ROOT, "fixtures/qrels");
const CORPORA_DIR = join(ROOT, "fixtures/eval-corpora");
const RESULTS_DIR = join(ROOT, "docs", "benchmarks");
const BASELINE_PATH = join(QRELS_DIR, "baseline.ndjson");
const EVAL_WRAPPER = join(ROOT, "scripts/with-test-database.ts");
const EVAL_WORKER = join(ROOT, "scripts/eval-search-worker.ts");

// Area → qrels file + which corpus it runs against. Order = printed/scorecard order.
export const AREAS: readonly { area: string; file: string; corpus: string }[] = [
  { area: "retrieval-en", file: "retrieval-en.json", corpus: "persona-en" },
  { area: "retrieval-zh", file: "retrieval-zh.json", corpus: "bilingual-zh" },
  { area: "graph", file: "graph.json", corpus: "persona-en" },
  { area: "identity", file: "identity.json", corpus: "persona-en" },
  { area: "time", file: "time.json", corpus: "persona-en" },
  { area: "provenance", file: "provenance.json", corpus: "persona-en" },
  { area: "robustness", file: "robustness.json", corpus: "persona-en" },
  { area: "decision-digest", file: "decision-digest.json", corpus: "decisions-en" },
];

export interface EvalArgs {
  mode: "mock" | "live";
  round: string;
  repeats: number;
  publishScorecard: boolean;
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("eval_args_invalid");
  return value;
}

/** Parse and validate coordinator flags before any database worker is started. */
export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  const known = new Set(["--mode", "--round", "--repeats", "--publish-scorecard"]);
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!known.has(token)) throw new Error("eval_args_invalid");
    if (seen.has(token)) throw new Error("eval_args_invalid");
    seen.add(token);
    if (token !== "--publish-scorecard") i++;
  }
  const modeValue = argValue(argv, "mode") ?? "mock";
  if (modeValue !== "mock" && modeValue !== "live") throw new Error("eval_mode_invalid");
  const round = argValue(argv, "round") ?? modeValue;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(round)) throw new Error("eval_round_invalid");
  const expectedRepeats = modeValue === "live" ? 3 : 1;
  const repeatsValue = argValue(argv, "repeats");
  const repeats = repeatsValue === undefined ? expectedRepeats : Number(repeatsValue);
  if (!Number.isInteger(repeats) || repeats !== expectedRepeats) {
    throw new Error("eval_repeats_invalid");
  }
  const publishScorecard = argv.includes("--publish-scorecard");
  if (publishScorecard && modeValue === "mock" && !round.startsWith("release-")) {
    throw new Error("eval_publish_mode_invalid");
  }
  return { mode: modeValue, round, repeats, publishScorecard };
}

export interface WorkerResult {
  protocol: 1;
  kind: "minime-eval-result";
  mode: "mock" | "live";
  round: string;
  repeat: number;
  corpus: string;
  seed: number;
  reports: AreaReport[];
}

function isAreaReport(value: unknown): value is AreaReport {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<AreaReport>;
  const metric = r.metrics;
  const finiteMetric =
    metric &&
    [
      metric.n,
      metric.hit1,
      metric.hit3,
      metric.hit5,
      metric.mrr,
      metric.ndcg5,
      metric.recall3,
    ].every((number) => typeof number === "number" && Number.isFinite(number));
  return (
    typeof r.area === "string" &&
    typeof r.corpus === "string" &&
    Number.isFinite(r.seed) &&
    Number.isInteger(r.seed) &&
    typeof r.n === "number" &&
    Number.isFinite(r.n) &&
    finiteMetric === true &&
    !!r.byBucket &&
    typeof r.byBucket === "object" &&
    typeof r.latencyP50 === "number" &&
    Number.isFinite(r.latencyP50) &&
    typeof r.latencyP95 === "number" &&
    Number.isFinite(r.latencyP95) &&
    typeof r.accuracy === "number" &&
    Number.isFinite(r.accuracy) &&
    Array.isArray(r.perQuery) &&
    Array.isArray(r.violations)
  );
}

/** Parse exactly one structured worker response; no textual score output is accepted. */
export function parseWorkerResult(text: string): WorkerResult {
  const lines = text
    .trim()
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean);
  if (lines.length !== 1) throw new Error("eval_worker_result_invalid");
  const line = lines[0]!;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("eval_worker_result_invalid");
  }
  if (!value || typeof value !== "object") throw new Error("eval_worker_result_invalid");
  const result = value as Partial<WorkerResult>;
  if (
    result.protocol !== 1 ||
    result.kind !== "minime-eval-result" ||
    (result.mode !== "mock" && result.mode !== "live") ||
    typeof result.round !== "string" ||
    !Number.isInteger(result.repeat) ||
    (result.repeat as number) < 0 ||
    typeof result.corpus !== "string" ||
    !Number.isInteger(result.seed) ||
    !Array.isArray(result.reports) ||
    result.reports.length === 0 ||
    result.reports.some((report) => !isAreaReport(report)) ||
    result.reports.some((report) => report.corpus !== result.corpus || report.seed !== result.seed)
  ) {
    throw new Error("eval_worker_result_invalid");
  }
  return result as WorkerResult;
}

function medianNumber(values: readonly number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function medianBlock(blocks: AreaReport["metrics"][]): AreaReport["metrics"] {
  return {
    n: medianNumber(blocks.map((b) => b.n)),
    hit1: medianNumber(blocks.map((b) => b.hit1)),
    hit3: medianNumber(blocks.map((b) => b.hit3)),
    hit5: medianNumber(blocks.map((b) => b.hit5)),
    mrr: medianNumber(blocks.map((b) => b.mrr)),
    ndcg5: medianNumber(blocks.map((b) => b.ndcg5)),
    recall3: medianNumber(blocks.map((b) => b.recall3)),
  };
}

/**
 * Aggregate reports by area, never by array position. Numeric metrics are medianed independently;
 * the seed-nearest report supplies per-query detail while the area table remains coherent.
 */
export function aggregateReports(runs: readonly AreaReport[][]): AreaReport[] {
  if (runs.length === 0) return [];
  const grouped = new Map<string, AreaReport[]>();
  for (const run of runs) {
    for (const report of run)
      grouped.set(report.area, [...(grouped.get(report.area) ?? []), report]);
  }
  const canonicalOrder = new Map(AREAS.map((area, index) => [area.area, index]));
  return [...grouped.entries()]
    .sort(([a], [b]) => {
      const aIndex = canonicalOrder.get(a);
      const bIndex = canonicalOrder.get(b);
      if (aIndex !== undefined && bIndex !== undefined) return aIndex - bIndex;
      if (aIndex !== undefined) return -1;
      if (bIndex !== undefined) return 1;
      return a.localeCompare(b);
    })
    .map(([, variants]) => {
      const ordered = variants.slice().sort((a, b) => a.seed - b.seed);
      const representative = ordered[Math.floor(ordered.length / 2)]!;
      const buckets = new Set(variants.flatMap((r) => Object.keys(r.byBucket)));
      const byBucket: AreaReport["byBucket"] = {};
      for (const bucket of buckets) {
        const blocks = variants
          .map((r) => r.byBucket[bucket])
          .filter((block): block is NonNullable<typeof block> => block !== undefined);
        if (blocks.length) byBucket[bucket] = medianBlock(blocks);
      }
      return {
        ...representative,
        seed: representative.seed,
        metrics: medianBlock(variants.map((r) => r.metrics)),
        byBucket,
        latencyP50: medianNumber(variants.map((r) => r.latencyP50)),
        latencyP95: medianNumber(variants.map((r) => r.latencyP95)),
        accuracy: medianNumber(variants.map((r) => r.accuracy)),
        violations: [...new Set(variants.flatMap((r) => r.violations))],
      };
    });
}

/** Refuse publication of a tracked or untracked scorecard from a dirty source tree. */
export function assertCleanWorkingTree(
  readStatus: () => string = () =>
    execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: ROOT,
      encoding: "utf8",
    }),
): void {
  let status: string;
  try {
    status = readStatus();
  } catch {
    throw new Error("eval_working_tree_check_failed");
  }
  if (status.trim()) throw new Error("eval_working_tree_dirty");
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function evaluatedCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
}

function hashTree(
  root: string,
  hash: ReturnType<typeof createHash>,
  relative: string,
  excludedFile?: string,
): void {
  for (const name of readdirSync(root).sort()) {
    if (name === excludedFile) continue;
    const absolute = join(root, name);
    const rel = `${relative}/${name}`;
    const stat = statSync(absolute);
    if (stat.isDirectory()) hashTree(absolute, hash, rel, excludedFile);
    else if (stat.isFile()) {
      hash.update(`${rel}\0`);
      hash.update(readFileSync(absolute));
      hash.update("\0");
    }
  }
}

function datasetHash(): string {
  const hash = createHash("sha256");
  hashTree(QRELS_DIR, hash, "qrels", "baseline.ndjson");
  hashTree(CORPORA_DIR, hash, "corpora");
  return `sha256:${hash.digest("hex")}`;
}

function scorecardConfiguration(): {
  provider: string;
  model: string;
  reranker: { enabled: boolean; model: string; topIn: number };
} {
  const provider = process.env.EMBED_PROVIDER ?? "ollama";
  const model =
    provider === "openai"
      ? (process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small")
      : provider === "openrouter"
        ? (process.env.OPENROUTER_EMBED_MODEL ?? "qwen/qwen3-embedding-8b")
        : (process.env.EMBED_MODEL ?? "nomic-embed-text");
  return {
    provider,
    model,
    reranker: {
      enabled: Boolean(process.env.RERANK_URL),
      model: process.env.RERANK_MODEL ?? "",
      topIn: Number(process.env.RERANK_TOP_IN ?? 20),
    },
  };
}

function workerEnvironment(mode: EvalArgs["mode"]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      key !== "EVAL_DATABASE_URL" &&
      key !== "EVAL_PMB_DATABASE_URL" &&
      key !== "EVAL_SKILLS_DATABASE_URL" &&
      key !== "MINIME_TEST_DATABASE_URL"
    ) {
      env[key] = value;
    }
  }
  if (mode === "mock") env.MINIME_MOCK_OLLAMA = "1";
  return env;
}

async function invokeWorker(
  args: EvalArgs,
  repeat: number,
  seed: number,
  corpus: string,
  files: readonly string[],
): Promise<WorkerResult> {
  const command = [
    process.execPath,
    "run",
    EVAL_WRAPPER,
    "--label",
    "eval_search",
    "--database-env",
    "EVAL_DATABASE_URL",
    "--",
    process.execPath,
    "run",
    EVAL_WORKER,
    "--mode",
    args.mode,
    "--round",
    args.round,
    "--repeat",
    String(repeat),
    "--seed",
    String(seed),
    "--corpus",
    corpus,
    "--qrels",
    files.join(","),
  ];
  const child = Bun.spawn(command, {
    env: workerEnvironment(args.mode),
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit",
  });
  const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (exitCode !== 0) throw new Error(`eval_worker_failed:${corpus}:${repeat}:${exitCode}`);
  return parseWorkerResult(output);
}

function groupedAreas(): { corpus: string; files: string[] }[] {
  const byCorpus = new Map<string, string[]>();
  for (const area of AREAS)
    byCorpus.set(area.corpus, [...(byCorpus.get(area.corpus) ?? []), area.file]);
  return [...byCorpus.entries()].map(([corpus, files]) => ({ corpus, files }));
}

async function runRepeat(args: EvalArgs, repeat: number, seed: number): Promise<AreaReport[]> {
  const byArea = new Map<string, AreaReport>();
  for (const group of groupedAreas()) {
    const result = await invokeWorker(args, repeat, seed, group.corpus, group.files);
    if (result.mode !== args.mode || result.round !== args.round || result.repeat !== repeat) {
      throw new Error("eval_worker_result_invalid");
    }
    const expectedAreas = AREAS.filter((area) => area.corpus === group.corpus).map(
      (area) => area.area,
    );
    const actualAreas = result.reports.map((report) => report.area);
    if (
      actualAreas.length !== expectedAreas.length ||
      expectedAreas.some((area) => !actualAreas.includes(area))
    ) {
      throw new Error("eval_worker_result_invalid");
    }
    for (const report of result.reports) byArea.set(report.area, report);
  }
  return AREAS.map((area) => byArea.get(area.area)).filter(
    (report): report is AreaReport => report !== undefined,
  );
}

export async function main(argv: readonly string[] = Bun.argv.slice(2)): Promise<number> {
  let args: EvalArgs;
  try {
    args = parseEvalArgs(argv);
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : "eval_args_invalid"}`);
    return 2;
  }

  let baseline: Map<string, BaselineLine>;
  try {
    baseline = loadBaseline(BASELINE_PATH);
  } catch (error) {
    console.error(`ERROR: ${(error as Error).message}`);
    return 2;
  }

  console.error(`MinimeBench: mode=${args.mode} round=${args.round} repeats=${args.repeats}`);
  const runs: AreaReport[][] = [];
  for (let i = 0; i < args.repeats; i++) {
    const seed = seedFor(args.repeats > 1 ? (seedFor() + i) >>> 0 : undefined);
    console.error(`-- repeat ${i + 1}/${args.repeats} (seed ${seed}) --`);
    runs.push(await runRepeat(args, i, seed));
  }
  const reports = aggregateReports(runs);

  const current: Measurement[] = reports.flatMap(measurements);
  const missingBaselineAreas = [
    ...new Set(
      reports
        .map((r) => r.area)
        .filter((area) => ![...baseline.keys()].some((key) => key.startsWith(`${area}::`))),
    ),
  ];
  const missingBaselineMetrics = missingBaselineMeasurements(current, baseline);
  const regressions = diffBaseline(current, baseline).filter(
    (r) => !(args.mode === "live" && r.metric === "latency_p95_ms"),
  );
  const violations = reports.flatMap((r) => r.violations);

  if (args.publishScorecard) {
    try {
      assertCleanWorkingTree();
    } catch (error) {
      console.error(`ERROR: ${(error as Error).message}`);
      return 2;
    }
    mkdirSync(RESULTS_DIR, { recursive: true });
    const scorecardPath = join(RESULTS_DIR, `${todayStr()}-${args.round}-minimebench.md`);
    writeFileSync(
      scorecardPath,
      buildScorecard({
        date: todayStr(),
        round: args.round,
        mode: args.mode,
        reports,
        runs,
        regressions,
        baselineExisted: true,
        evaluatedCommit: evaluatedCommit(),
        datasetHash: datasetHash(),
        configuration: scorecardConfiguration(),
      }),
    );
    console.error(`scorecard: ${scorecardPath}`);
  }

  console.log(`\n${areaTable(reports)}\n`);
  if (violations.length) {
    console.error(`ROBUSTNESS VIOLATIONS (${violations.length}):`);
    for (const violation of violations) console.error(`  - ${violation}`);
    return 1;
  }
  if (missingBaselineAreas.length) {
    console.error(`MISSING BASELINE AREAS: ${missingBaselineAreas.join(", ")}`);
    return 1;
  }
  if (missingBaselineMetrics.length) {
    console.error(`MISSING BASELINE METRICS (${missingBaselineMetrics.length}):`);
    for (const metric of missingBaselineMetrics)
      console.error(`  - ${metric.area}/${metric.metric}: current ${metric.current}`);
    return 1;
  }
  if (regressions.length) {
    console.error(`REGRESSIONS beyond tolerance (${regressions.length}):`);
    for (const regression of regressions)
      console.error(
        `  - ${regression.area}/${regression.metric}: ${regression.baseline} -> ${regression.current} (${regression.delta})`,
      );
    return 1;
  }
  console.error("OK: all bars held, no regression.");
  return 0;
}

if (import.meta.main) process.exit(await main());
