// SkillEval — the skills-layer eval (agents/skills/*.md), previously the least-measured
// surface. Each task hands the configured model (CLASSIFY_PROVIDER/CLASSIFY_MODEL — the
// standing config is Bedrock Opus 4.8) the resolver + one skill file and a user prompt,
// then drives a ReAct-style JSON tool loop through invokeTool — the exact door agents
// use (I2), so every call lands in the events audit log (I8). Scoring is judge-free and
// reads the AUDIT LOG, not the loop's own bookkeeping:
//   - mustCall / mustNotCall — `tool:<name>` events rows for this episode's actor
//   - answerMatch / answerAnyOf — regexes over the final answer
//   - mustCite — the answer references an id prefix the tools actually returned
// Core lives in scripts/skill-eval-lib.ts (shared with the optimizer). First runs are
// baselines; committed pass bars come after the numbers stabilize (MinimeBench
// discipline). fixtures/skill-tasks/*.json are the HELD-OUT sets — the optimizer never
// sees them; its training sets live in fixtures/skill-tasks/train/.
//
// Usage (via make eval-skills):
//   DATABASE_URL=$EVAL_SKILLS_DATABASE_URL EVAL_SKILLS_DATABASE_URL=... \
//     bun run scripts/eval-skills.ts [--round r1] [--suite query] [--max-steps 8]

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type SkillTask,
  TASKS_DIR,
  type TaskResult,
  flag,
  guardScratchDb,
  runSuite,
  seedCorpus,
} from "./skill-eval-lib";

const RESULTS_DIR = join(process.cwd(), "docs", "benchmarks");

function report(results: TaskResult[], round: string, model: string): string {
  const suites = [...new Set(results.map((r) => r.suite))];
  const line = (label: string, rs: TaskResult[]) =>
    `| ${label} | ${rs.length} | ${rs.filter((r) => r.passed).length}/${rs.length} | ${(
      rs.reduce((s, r) => s + r.steps, 0) / rs.length
    ).toFixed(1)} |`;
  const out = [
    `# SkillEval — agents/skills behavioral contracts (round ${round})`,
    "",
    `Driver model: ${model}. Judge-free: tool-call assertions are read from the events`,
    "audit log (I8) through the same invokeTool door agents use (I2); answer checks are",
    "regex + citation-of-returned-id. Tasks: fixtures/skill-tasks/ (held-out from the",
    "optimizer). Baseline round — committed pass bars follow once numbers stabilize.",
    "",
    "| suite | n | passed | mean steps |",
    "|---|---:|---:|---:|",
    ...suites.map((s) =>
      line(
        s,
        results.filter((r) => r.suite === s),
      ),
    ),
    line("**TOTAL**", results),
    "",
    "## Failures (published)",
    "",
    ...results
      .filter((r) => !r.passed)
      .map((r) => `- \`${r.id}\` (${r.skill}): ${r.failures.join("; ")}`),
  ];
  return out.join("\n");
}

async function main(): Promise<number> {
  await guardScratchDb();
  const round = flag("round", "r1");
  const suiteFilter = flag("suite", "");
  const maxSteps = Number(flag("max-steps", "8"));

  await seedCorpus();

  const { classifyProvider } = await import("../src/llm");
  const driver = classifyProvider();
  const model = `${driver.name}:${driver.model}`;
  console.error(`driver: ${model}`);

  const suiteFiles = readdirSync(TASKS_DIR)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => !suiteFilter || f === `${suiteFilter}.json`);

  const results: TaskResult[] = [];
  for (const file of suiteFiles) {
    const suite = file.replace(/\.json$/, "");
    const tasks = JSON.parse(readFileSync(join(TASKS_DIR, file), "utf8")) as SkillTask[];
    results.push(...(await runSuite(tasks, suite, maxSteps)));
  }

  const md = report(results, round, model);
  console.log(`\n${md}\n`);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const path = join(RESULTS_DIR, `${date}-${round}-skilleval.md`);
  writeFileSync(path, `${md}\n`);
  console.error(`scorecard: ${path}`);

  const { closeDb } = await import("../src/db/client");
  await closeDb();
  return 0;
}

process.exit(await main());
