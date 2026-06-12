// LongMemEval-s (V1, 500 questions over chat histories) — retrieval recall benchmark.
// Sessions are deduped globally and ingested ONCE; each question searches ONLY its own
// haystack via hybridSearch's scopeParentIds (the benchmark contract). Evidence-session
// labels make recall judge-free. Reference point: gbrain reports 97.6% recall@5 here.
//
// Usage (via make eval-longmemeval):
//   DATABASE_URL=$EVAL_LME_DATABASE_URL EVAL_LME_DATABASE_URL=... \
//     bun run scripts/eval-longmemeval.ts [--phase ingest|run|all] [--limit N]
// Dataset: ~/datasets/longmemeval/longmemeval_s.json (HF xiaowu0162/longmemeval).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DATASET = join(process.env.HOME ?? "~", "datasets", "longmemeval", "longmemeval_s.json");
const RESULTS_DIR = join(ROOT, "docs", "benchmarks");

interface Turn {
  role: string;
  content: string | null;
}
interface Question {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  answer: string;
  answer_session_ids: string[];
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: Turn[][];
}

function flag(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? dflt) : dflt;
}

function sessionMd(turns: Turn[], date: string): string {
  const lines = [`Date: ${date}`, ""];
  for (const t of turns) {
    if (!t.content) continue;
    lines.push(`${(t.role ?? "user").toUpperCase()}: ${t.content}`, "");
  }
  return lines.join("\n");
}

const pathFor = (sid: string) => `lme1/${sid}.md`;

async function guard(): Promise<void> {
  if (
    !process.env.EVAL_LME_DATABASE_URL ||
    process.env.DATABASE_URL !== process.env.EVAL_LME_DATABASE_URL
  ) {
    console.error(
      "ERROR: refusing to run — start with DATABASE_URL=EVAL_LME_DATABASE_URL (scratch DB; the pool binds at module load).",
    );
    process.exit(2);
  }
  const { sql } = await import("../src/db/client");
  const [{ db }] = (await sql`select current_database() as db`) as unknown as [{ db: string }];
  if (!/eval/i.test(db)) {
    console.error(`ERROR: refusing to run — connected database "${db}" is not a scratch eval DB.`);
    process.exit(2);
  }
  // benchmarks must be LOUD about stage health: a fail-open reranker silently degrading
  // turns a Phase-3 measurement into a baseline re-run (incident: first rerank bench run)
  const { rerankEnabled, rerankProbe } = await import("../src/search/rerank");
  let rerankActive = false;
  if (rerankEnabled()) {
    rerankActive = await rerankProbe();
    if (!rerankActive) {
      console.error(
        "ERROR: RERANK_URL is set but the probe call failed — fix the server or unset.",
      );
      process.exit(2);
    }
  }
  console.error(
    `LongMemEval-s: db=${db} rerank=${rerankActive ? `on (${process.env.RERANK_MODEL ?? "bge-reranker-v2-m3"})` : "off"}`,
  );
}

async function ingest(questions: Question[]): Promise<void> {
  const { upsertPage, replaceChunks, chunksMissingEmbedding, setChunkEmbedding } = await import(
    "../src/db/repo"
  );
  const { chunkMarkdown } = await import("../src/search/chunker");
  const { embedTexts } = await import("../src/search/embed");
  const { embedModelName } = await import("../src/llm");

  // dedupe sessions globally; first-seen date wins (dates are stable per session)
  const seen = new Set<string>();
  let pages = 0;
  let chunks = 0;
  for (const q of questions) {
    for (let i = 0; i < q.haystack_session_ids.length; i++) {
      const sid = q.haystack_session_ids[i]!;
      if (seen.has(sid)) continue;
      seen.add(sid);
      const date = q.haystack_dates[i] ?? "";
      const md = sessionMd(q.haystack_sessions[i]!, date);
      const title = `Chat session ${date}`;
      // direct replaceChunks (not indexParent): no entity extraction on benchmark chat logs
      const { id, changed } = await upsertPage({
        path: pathFor(sid),
        title,
        bodyMd: md,
        contentHash: Bun.hash(md).toString(16),
        tier: 1,
        source: "lme1",
      });
      if (changed) {
        const cs = chunkMarkdown(md, title);
        await replaceChunks("page", id, cs, 1);
        chunks += cs.length;
      }
      pages++;
      if (pages % 1000 === 0) console.error(`  ingested ${pages} sessions (${chunks} chunks)`);
    }
  }
  console.error(`sessions: ${pages}; embedding backlog...`);

  const model = embedModelName();
  let embedded = 0;
  for (;;) {
    const missing = await chunksMissingEmbedding(128, 2);
    if (missing.length === 0) break;
    const slices: (typeof missing)[] = [];
    for (let i = 0; i < missing.length; i += 32) slices.push(missing.slice(i, i + 32));
    await Promise.all(
      slices.map(async (slice) => {
        const vecs = await embedTexts(slice.map((m) => m.text));
        for (let i = 0; i < slice.length; i++)
          await setChunkEmbedding(slice[i]!.id, vecs[i]!, model);
      }),
    );
    embedded += missing.length;
    if (embedded % 5120 < 128) console.error(`  embedded ${embedded}`);
  }
  console.error(`embedding done: ${embedded} new vectors`);
}

interface Row {
  id: string;
  type: string;
  rank: number; // 1-based rank of the FIRST evidence session in the scoped results; 0 = miss
}

async function run(questions: Question[]): Promise<Row[]> {
  const { pagesByPaths } = await import("../src/db/repo");
  const { hybridSearch } = await import("../src/search/hybrid");

  // one global path -> page-id map (≈20k rows), then per-question scoping is in-memory
  const allPaths = new Set<string>();
  for (const q of questions) for (const sid of q.haystack_session_ids) allPaths.add(pathFor(sid));
  const idByPath = new Map<string, string>();
  const paths = [...allPaths];
  for (let i = 0; i < paths.length; i += 5000) {
    for (const r of await pagesByPaths(paths.slice(i, i + 5000))) idByPath.set(r.path, r.id);
  }
  console.error(`page map: ${idByPath.size}/${allPaths.size}`);

  const rows: Row[] = [];
  let done = 0;
  const queue = [...questions];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (;;) {
        const q = queue.shift();
        if (!q) return;
        const scope = q.haystack_session_ids
          .map((sid) => idByPath.get(pathFor(sid)))
          .filter((x): x is string => Boolean(x));
        const evidence = new Set(
          q.answer_session_ids.map((sid) => idByPath.get(pathFor(sid))).filter(Boolean),
        );
        const hits = await hybridSearch({ query: q.question, scopeParentIds: scope, limit: 10 });
        const rank = hits.findIndex((h) => evidence.has(h.id));
        rows.push({ id: q.question_id, type: q.question_type, rank: rank >= 0 ? rank + 1 : 0 });
        done++;
        if (done % 50 === 0) console.error(`  ${done}/${questions.length}`);
      }
    }),
  );
  return rows;
}

function report(rows: Row[]): string {
  const tally = (rs: Row[]) => ({
    n: rs.length,
    r1: rs.filter((r) => r.rank === 1).length,
    r5: rs.filter((r) => r.rank >= 1 && r.rank <= 5).length,
    r10: rs.filter((r) => r.rank >= 1 && r.rank <= 10).length,
    mrr: rs.reduce((s, r) => s + (r.rank > 0 ? 1 / r.rank : 0), 0),
  });
  const pct = (x: number, n: number) => `${((100 * x) / n).toFixed(1)}%`;
  const line = (label: string, t: ReturnType<typeof tally>) =>
    `| ${label} | ${t.n} | ${pct(t.r1, t.n)} | ${pct(t.r5, t.n)} | ${pct(t.r10, t.n)} | ${(t.mrr / t.n).toFixed(3)} |`;

  const types = [...new Set(rows.map((r) => r.type))].sort();
  const out = [
    "| type | n | recall@1 | recall@5 | recall@10 | MRR@10 |",
    "|---|---:|---:|---:|---:|---:|",
    ...types.map((t) => line(t, tally(rows.filter((r) => r.type === t)))),
    line("**TOTAL**", tally(rows)),
  ];
  return out.join("\n");
}

async function main(): Promise<number> {
  await guard();
  const phase = flag("phase", "all");
  const limit = Number(flag("limit", "0"));
  // round-stamped filename: a --limit smoke run must never clobber the committed full
  // scorecard (incident 2026-06-12: a 10-q smoke overwrote the 500-q record)
  const round = flag("round", limit > 0 ? `smoke${limit}` : "full");
  const questions: Question[] = JSON.parse(readFileSync(DATASET, "utf8"));
  const qs = limit > 0 ? questions.slice(0, limit) : questions;
  console.error(`questions: ${qs.length}, phase: ${phase}`);

  if (phase === "ingest" || phase === "all") await ingest(qs);
  if (phase === "run" || phase === "all") {
    const rows = await run(qs);
    const table = report(rows);
    console.log(`\n${table}\n`);
    mkdirSync(RESULTS_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const path = join(RESULTS_DIR, `${date}-${round}-longmemeval-s.md`);
    writeFileSync(
      path,
      `# LongMemEval-s — Minime hybrid retrieval (session-level recall)\n\n` +
        `Engine: RRF hybrid (qwen3-embedding-8b live), per-question haystack scoping, ` +
        `top-10 parents.\nReference: gbrain reports 97.6% recall@5 on this dataset.\n\n${table}\n`,
    );
    console.error(`scorecard: ${path}`);
  }
  const { closeDb } = await import("../src/db/client");
  await closeDb();
  return 0;
}

process.exit(await main());
