// SkillEval — the skills-layer eval (agents/skills/*.md), previously the least-measured
// surface. Each task hands a real model (CLASSIFY_PROVIDER/CLASSIFY_MODEL — local
// llama/qwen by default) the resolver + one skill file and a user prompt, then drives a
// ReAct-style JSON tool loop through invokeTool — the exact door agents use (I2), so
// every call lands in the events audit log (I8). Scoring is judge-free and reads the
// AUDIT LOG, not the loop's own bookkeeping:
//   - mustCall / mustNotCall — `tool:<name>` events rows for this episode's actor
//   - answerMatch / answerAnyOf — regexes over the final answer
//   - mustCite — the answer references an id prefix the tools actually returned
// First runs are baselines; committed pass bars come after the numbers stabilize
// (MinimeBench discipline).
//
// Usage (via make eval-skills):
//   DATABASE_URL=$EVAL_SKILLS_DATABASE_URL EVAL_SKILLS_DATABASE_URL=... \
//     bun run scripts/eval-skills.ts [--round r1] [--suite query] [--max-steps 8]

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SKILLS_DIR = join(ROOT, "agents", "skills");
const TASKS_DIR = join(ROOT, "fixtures", "skill-tasks");
const RESULTS_DIR = join(ROOT, "docs", "benchmarks");
const ACTOR = "agent:skill-eval";

interface SkillTask {
  id: string;
  skill: string;
  prompt: string;
  assert: {
    mustCall?: string[];
    mustNotCall?: string[];
    answerMatch?: string[];
    answerAnyOf?: string[];
    mustCite?: boolean;
  };
}

interface TaskResult {
  id: string;
  suite: string;
  skill: string;
  passed: boolean;
  failures: string[];
  steps: number;
  answer: string;
}

function flag(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? dflt) : dflt;
}

async function guard(): Promise<void> {
  if (
    !process.env.EVAL_SKILLS_DATABASE_URL ||
    process.env.DATABASE_URL !== process.env.EVAL_SKILLS_DATABASE_URL
  ) {
    console.error(
      "ERROR: refusing to run — start with DATABASE_URL=EVAL_SKILLS_DATABASE_URL (scratch DB; the pool binds at module load).",
    );
    process.exit(2);
  }
  const { sql } = await import("../src/db/client");
  const [{ db }] = (await sql`select current_database() as db`) as unknown as [{ db: string }];
  if (!/eval/i.test(db)) {
    console.error(`ERROR: refusing to run — connected database "${db}" is not a scratch eval DB.`);
    process.exit(2);
  }
}

// system prompt: the dispatcher + the one skill under test + a strict JSON protocol.
// Tool catalog comes from the registry so the doc never drifts from the implementation.
async function systemPrompt(skillFile: string): Promise<string> {
  const { ALL_TOOLS } = await import("../src/mcp/tools");
  const resolver = readFileSync(join(SKILLS_DIR, "RESOLVER.md"), "utf8");
  const skill = readFileSync(join(SKILLS_DIR, skillFile), "utf8");
  const tools = ALL_TOOLS.map(
    (t) => `- ${t.name}(${Object.keys(t.schema).join(", ")}): ${t.description.split("\n")[0]}`,
  ).join("\n");
  return [
    "You are the owner's personal memory agent. Follow the skill instructions exactly.",
    "",
    "=== RESOLVER ===",
    resolver,
    `=== SKILL: ${skillFile} ===`,
    skill,
    "=== TOOLS ===",
    tools,
    "",
    "=== PROTOCOL ===",
    "Respond with exactly ONE JSON object per turn, nothing else. Either:",
    '  {"tool": "<tool name>", "args": { ... }}   to call a tool, or',
    '  {"answer": "<your final reply to the owner>"}   when you are done.',
    "Tool results arrive as JSON in the transcript. Never invent tool output.",
  ].join("\n");
}

function parseStep(raw: string): { tool?: string; args?: unknown; answer?: string } | null {
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    const obj = JSON.parse(stripped);
    if (obj && typeof obj === "object") return obj;
  } catch {
    // fall through — caller feeds a correction back to the model
  }
  return null;
}

async function runEpisode(
  task: SkillTask,
  maxSteps: number,
): Promise<{ answer: string; steps: number; returnedIds: string[] }> {
  const { classifyProvider } = await import("../src/llm");
  const { toolByName } = await import("../src/mcp/tools");
  const { invokeTool } = await import("../src/mcp/tools/registry");
  const llm = classifyProvider();

  const system = await systemPrompt(task.skill);
  const transcript: string[] = [`OWNER: ${task.prompt}`];
  const returnedIds: string[] = [];

  for (let step = 1; step <= maxSteps; step++) {
    const raw = await llm.completeJson(
      `${system}\n\n=== TRANSCRIPT ===\n${transcript.join("\n")}\n\nYour ONE JSON object:`,
    );
    const obj = parseStep(raw);
    if (!obj) {
      transcript.push("SYSTEM: response was not a single valid JSON object — try again.");
      continue;
    }
    if (typeof obj.answer === "string") return { answer: obj.answer, steps: step, returnedIds };
    if (typeof obj.tool === "string") {
      transcript.push(`AGENT: ${JSON.stringify({ tool: obj.tool, args: obj.args ?? {} })}`);
      let resultText: string;
      try {
        const tool = toolByName(obj.tool);
        const res = await invokeTool(tool, obj.args ?? {}, { actor: ACTOR });
        if (res.ok) {
          returnedIds.push(...res.envelope.sources.map((s: { id: string }) => s.id));
          resultText = JSON.stringify(res.envelope);
        } else {
          resultText = JSON.stringify(res.error);
        }
      } catch (e) {
        resultText = JSON.stringify({ error: String(e) });
      }
      // truncate defensively; the model only needs the head of large envelopes
      transcript.push(`TOOL ${obj.tool}: ${resultText.slice(0, 3500)}`);
      continue;
    }
    transcript.push('SYSTEM: JSON must contain either "tool" or "answer" — try again.');
  }
  return { answer: "", steps: maxSteps, returnedIds };
}

async function scoreTask(
  task: SkillTask,
  suite: string,
  ep: { answer: string; steps: number; returnedIds: string[] },
  since: Date,
): Promise<TaskResult> {
  const { eventsSince } = await import("../src/db/repo");
  const failures: string[] = [];

  // the audit log is the ground truth for what was called (I8)
  const events = (await eventsSince(since)) as { actor: string; verb: string }[];
  const called = new Set(
    events.filter((e) => e.actor === ACTOR).map((e) => e.verb.replace(/^tool:/, "")),
  );

  for (const t of task.assert.mustCall ?? [])
    if (!called.has(t)) failures.push(`never called ${t} (audit log)`);
  for (const t of task.assert.mustNotCall ?? [])
    if (called.has(t)) failures.push(`called forbidden tool ${t} (audit log)`);
  if (!ep.answer) failures.push("no final answer within step budget");
  for (const re of task.assert.answerMatch ?? [])
    if (!new RegExp(re, "i").test(ep.answer)) failures.push(`answer !~ /${re}/`);
  const anyOf = task.assert.answerAnyOf ?? [];
  if (anyOf.length > 0 && !anyOf.some((re) => new RegExp(re, "i").test(ep.answer)))
    failures.push(`answer matched none of [${anyOf.join(", ")}]`);
  if (task.assert.mustCite) {
    const cited = ep.returnedIds.some((id) => id.length >= 4 && ep.answer.includes(id.slice(0, 4)));
    if (!cited) failures.push("no returned source id cited in the answer");
  }

  return {
    id: task.id,
    suite,
    skill: task.skill,
    passed: failures.length === 0,
    failures,
    steps: ep.steps,
    answer: ep.answer.slice(0, 400),
  };
}

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
    "regex + citation-of-returned-id. Tasks: fixtures/skill-tasks/. Baseline round —",
    "committed pass bars follow once numbers stabilize.",
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
  await guard();
  const round = flag("round", "r1");
  const suiteFilter = flag("suite", "");
  const maxSteps = Number(flag("max-steps", "8"));

  const { resetAndSeed } = await import("../test/helpers");
  const { drainEmbedBacklog } = await import("../src/search/index-parent");
  console.error("seeding fixtures + embedding...");
  await resetAndSeed();
  const embedded = await drainEmbedBacklog();
  console.error(`embedded ${embedded} chunks`);

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
    for (const task of tasks) {
      const since = new Date();
      const ep = await runEpisode(task, maxSteps);
      const r = await scoreTask(task, suite, ep, since);
      results.push(r);
      console.error(
        `  ${r.passed ? "ok  " : "FAIL"} ${task.id} (${r.steps} steps)${r.passed ? "" : ` — ${r.failures.join("; ")}`}`,
      );
    }
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
