// W1 graph-hygiene LIVE bake (owner-run). verify-m14 already enforces the CI bar offline
// with mock heuristic verdicts (fully deterministic, no model calls); this script re-runs
// the exact same planted corpus through the REAL routed classify model
// (config.mockOllama = false) and proves the live model agrees with the heuristic's bar:
// 100% of the 3 planted-bad edges flagged, 0 false flags on the 2 planted-good edges.
//
//   make eval-graph-hygiene
//
// EVAL_DATABASE_URL must point at a throwaway database — this runner drops all tables in it.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RESULTS_DIR = join(ROOT, "docs", "benchmarks");

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Drop-all + migrate on the scratch DB — the same reset contract test/helpers.ts's resetDb()
// gives tests, replicated inline. Scripts may not import test/helpers (test-only scaffolding);
// this keeps the drop list in lockstep by hand instead.
async function resetScratchDb(): Promise<void> {
  const { sql } = await import("../src/db/client");
  const { migrate } = await import("../src/db/migrate");
  const tables = await sql`select tablename from pg_tables where schemaname = 'public'`;
  for (const t of tables) {
    await sql.unsafe(`drop table if exists "${t.tablename}" cascade`);
  }
  const fns = [
    "set_updated_at",
    "events_append_only",
    "decision_transcripts_append_only",
    "touch_decision_from_transcript",
    "sync_decision_branch_update",
    "edge_source_tier",
    "set_edge_tier",
    "app_allowed_tier",
    "metric_agg",
  ];
  for (const f of fns) {
    await sql.unsafe(`drop function if exists ${f} cascade`);
  }
  await migrate();
}

async function main(): Promise<number> {
  if (!process.env.EVAL_DATABASE_URL) {
    console.error("ERROR: EVAL_DATABASE_URL must point at a throwaway scratch database.");
    return 2;
  }
  // HARD GUARD (incident 2026-06-12, copied verbatim from scripts/eval-search.ts:179-201): the
  // pool binds to DATABASE_URL at module load, so an in-process swap cannot retarget it. The
  // runner must be STARTED with DATABASE_URL=EVAL_DATABASE_URL (the make target does this), and
  // the connected database's own name must say it is a scratch eval DB. Refuse otherwise — this
  // runner drops tables.
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
  const { config } = await import("../src/util/config");
  (config as { databaseUrl: string }).databaseUrl = process.env.EVAL_DATABASE_URL;

  console.error(`graph-hygiene live bake: db=${db}`);
  await resetScratchDb();

  const { plantGraphHygieneCorpus } = await import("../fixtures/graph-hygiene");
  const { badEdgeIds, goodEdgeIds } = await plantGraphHygieneCorpus();

  // Force the LIVE model path. CI (verify-m14) already covers the deterministic offline
  // heuristic; this bake is the only gate proving the real routed model agrees with it.
  (config as { mockOllama: boolean }).mockOllama = false;

  const { validateEdges } = await import("../src/pipeline/validate-edges");
  const result = await validateEdges();

  const flaggedRows =
    await sql`select payload->>'edge_id' as id from review_queue where kind = 'extract_suspect'`;
  const flaggedIds = new Set(flaggedRows.map((r: any) => r.id as string));
  const badFlagged = badEdgeIds.filter((id) => flaggedIds.has(id)).length;
  const falseFlags = goodEdgeIds.filter((id) => flaggedIds.has(id)).length;

  const modelRows = await sql`select distinct model from edge_validations order by model`;
  const models = modelRows.map((r: any) => r.model as string).join(", ") || "(none)";

  const ruleLines = Object.entries(result.byRule)
    .map(([rule, r]) => `| ${rule} | ${r.checked} | ${r.denied} |`)
    .join("\n");

  const scorecard = `# Graph-hygiene live bake — ${todayStr()}

Owner-run live bake of the W1 extractor-re-validation gate (dream step 3c_validate_edges)
against the planted graph-hygiene corpus (fixtures/graph-hygiene.ts), using the real
tier-routed classify model instead of the CI mock heuristic (verify-m14 covers that path
offline and deterministically).

Model(s) used: ${models}

Planted-bad flagged: ${badFlagged}/${badEdgeIds.length}
False flags (planted-good): ${falseFlags}/${goodEdgeIds.length}

checked=${result.checked} confirmed=${result.confirmed} denied=${result.denied} unsure=${result.unsure} flagged=${result.flagged}

| rule_key | checked | denied |
|---|---:|---:|
${ruleLines || "| (none) | 0 | 0 |"}
`;

  mkdirSync(RESULTS_DIR, { recursive: true });
  const scorecardPath = join(RESULTS_DIR, `${todayStr()}-graph-hygiene.md`);
  writeFileSync(scorecardPath, scorecard);
  console.log(scorecard);
  console.error(`scorecard: ${scorecardPath}`);

  if (badFlagged < badEdgeIds.length || falseFlags > 0) {
    console.error(
      `FAIL: planted-bad flagged ${badFlagged}/${badEdgeIds.length}, false flags ${falseFlags}`,
    );
    return 1;
  }
  console.error("OK: live model matches the planted-corpus bar.");
  return 0;
}

const code = await main();
const { closeDb } = await import("../src/db/client");
await closeDb();
process.exit(code);
