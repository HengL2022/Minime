#!/usr/bin/env bun

// Application-side MinimeBench worker. It receives one parent-provisioned scratch DB and one
// fictional corpus, performs no migration/reset/DDL, and returns one structured JSON result.

import { mkdtempSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AreaReport, loadQrels, runQrels } from "../src/search/eval";

const ROOT = join(import.meta.dir, "..");
const QRELS_DIR = join(ROOT, "fixtures/qrels");
const CORPORA_DIR = join(ROOT, "fixtures/eval-corpora");
const CORPORA = new Set(["persona-en", "bilingual-zh", "decisions-en"]);
const QRELS_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const GUARDED_DATABASE = /^minime_test_[a-z0-9_]+$/;
const GUARDED_APP_ROLE = /^minime_test_app_[a-z0-9_]+$/;

interface WorkerArgs {
  mode: "mock" | "live";
  round: string;
  repeat: number;
  seed: number;
  corpus: string;
  qrels: string[];
}

function value(argv: readonly string[], name: string): string {
  const index = argv.indexOf(`--${name}`);
  const candidate = argv[index + 1];
  if (index < 0 || !candidate || candidate.startsWith("--"))
    throw new Error("eval_worker_args_invalid");
  return candidate;
}

function parseArgs(argv: readonly string[]): WorkerArgs {
  const expected = new Set(["--mode", "--round", "--repeat", "--seed", "--corpus", "--qrels"]);
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    if (!expected.has(argv[i]!)) throw new Error("eval_worker_args_invalid");
    if (seen.has(argv[i]!)) throw new Error("eval_worker_args_invalid");
    seen.add(argv[i]!);
    i++;
  }
  const mode = value(argv, "mode");
  if (mode !== "mock" && mode !== "live") throw new Error("eval_worker_args_invalid");
  const round = value(argv, "round");
  const repeat = Number(value(argv, "repeat"));
  const seed = Number(value(argv, "seed"));
  const corpus = value(argv, "corpus");
  const qrels = value(argv, "qrels").split(",").filter(Boolean);
  if (
    !round ||
    !Number.isInteger(repeat) ||
    repeat < 0 ||
    !Number.isInteger(seed) ||
    seed < 0 ||
    !corpus ||
    !CORPORA.has(corpus) ||
    qrels.length === 0 ||
    qrels.some((file) => !QRELS_FILE.test(file))
  ) {
    throw new Error("eval_worker_args_invalid");
  }
  return { mode, round, repeat, seed, corpus, qrels };
}

export function ensureRuntimeDsn(): void {
  const evalUrl = process.env.EVAL_DATABASE_URL;
  const runtimeUrl = process.env.MINIME_APP_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!evalUrl || !runtimeUrl || evalUrl !== runtimeUrl)
    throw new Error("eval_worker_runtime_dsn_invalid");
  let parsed: URL;
  try {
    parsed = new URL(runtimeUrl);
  } catch {
    throw new Error("eval_worker_runtime_dsn_invalid");
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()))
    throw new Error("eval_worker_runtime_host_invalid");
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    throw new Error("eval_worker_runtime_database_invalid");
  }
  if (!GUARDED_DATABASE.test(databaseName)) throw new Error("eval_worker_runtime_database_invalid");
  if (!GUARDED_APP_ROLE.test(parsed.username)) throw new Error("eval_worker_runtime_role_invalid");
  if (!parsed.password) throw new Error("eval_worker_runtime_credentials_invalid");
  // Config and postgres use DATABASE_URL as the application runtime DSN. The wrapper may expose
  // only MINIME_APP_DATABASE_URL, so normalize that alias before importing application modules.
  process.env.DATABASE_URL = runtimeUrl;
}

async function loadDecisionCorpus(path: string): Promise<void> {
  const rows = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>[];
  const { getDecisionBranches, insertDecision } = await import("../src/db/repo");
  const { compileDecisionDigests } = await import("../src/pipeline/decision-digest");
  const { indexParent } = await import("../src/search/index-parent");
  for (const decision of rows) {
    const { id } = await insertDecision({
      question: decision.question,
      options: decision.options,
      choice: decision.choice ?? null,
      reasoning: decision.reasoning ?? null,
      expectedOutcome: decision.expected_outcome ?? null,
      falsifier: decision.falsifier ?? null,
      stakes: decision.stakes ?? null,
      reversibility: decision.reversibility ?? null,
      confidence: decision.confidence ?? null,
      branches: decision.branches?.map((branch: Record<string, any>) => ({
        label: branch.label,
        status: branch.status,
        note: branch.note ?? null,
        wouldBeRightIf: branch.would_be_right_if ?? null,
      })),
      source: "eval:decision-digest",
      createdBy: "system:eval",
    });
    const markdown = [
      `# Decision: ${decision.question}`,
      `Options: ${JSON.stringify(decision.options)}`,
      decision.choice ? `Choice: ${decision.choice}` : "",
      decision.reasoning ? `Reasoning: ${decision.reasoning}` : "",
      decision.expected_outcome ? `Expected outcome: ${decision.expected_outcome}` : "",
      decision.falsifier ? `Falsifier: ${decision.falsifier}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    await indexParent("decision", id, markdown, undefined, 1);
    for (const branch of await getDecisionBranches(id)) {
      await indexParent(
        "decision_branch",
        branch.id,
        [
          `# Decision branch: ${branch.label}`,
          `Decision: ${decision.question}`,
          `Status: ${branch.status}`,
          branch.note ? `Note: ${branch.note}` : "",
          branch.would_be_right_if ? `Would be right if: ${branch.would_be_right_if}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        branch.label,
        1,
      );
    }
  }
  await compileDecisionDigests();
}

async function loadCorpus(corpus: string): Promise<void> {
  const corpusDir = join(CORPORA_DIR, corpus);
  const { config } = await import("../src/util/config");
  if (corpus === "decisions-en") {
    const scratchDir = mkdtempSync(join(tmpdir(), "minime-decisions-eval-"));
    process.env.MINIME_DATA_DIR = scratchDir;
    (config as { dataDir: string }).dataDir = scratchDir;
    await loadDecisionCorpus(join(corpusDir, "decisions.json"));
    return;
  }
  process.env.MINIME_DATA_DIR = corpusDir;
  (config as { dataDir: string }).dataDir = corpusDir;
  const { brainSync } = await import("../src/pipeline/brain-sync");
  const { drainEmbedBacklog } = await import("../src/search/index-parent");
  await brainSync();
  await drainEmbedBacklog();
}

async function main(): Promise<number> {
  let closeDb: (() => Promise<void>) | undefined;
  try {
    const args = parseArgs(process.argv.slice(2));
    ensureRuntimeDsn();
    const reports: AreaReport[] = [];
    for (const file of args.qrels) {
      const qrelsPath = join(QRELS_DIR, file);
      const qrels = loadQrels(qrelsPath);
      if (qrels.corpus !== args.corpus) throw new Error("eval_worker_corpus_mismatch");
    }
    await loadCorpus(args.corpus);
    for (const file of args.qrels) {
      reports.push(await runQrels({ qrelsPath: join(QRELS_DIR, file), seed: args.seed }));
    }
    const result = {
      protocol: 1 as const,
      kind: "minime-eval-result" as const,
      mode: args.mode,
      round: args.round,
      repeat: args.repeat,
      corpus: args.corpus,
      seed: args.seed,
      reports,
    };
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "eval_worker_failed");
    return 1;
  } finally {
    try {
      const client = await import("../src/db/client");
      closeDb = client.closeDb;
    } catch {
      // Application modules may not have loaded after an argument/DSN failure.
    }
    if (closeDb) await closeDb().catch(() => {});
  }
}

if (import.meta.main) process.exit(await main());
