// Shared core for the skills-layer eval and the skill optimizer: episode runner
// (ReAct JSON loop over completeJson through invokeTool — the agent door, I2) and the
// judge-free scorer that reads the events audit log (I8). scripts/eval-skills.ts and
// scripts/optimize-skill.ts both import this so the measured contract never forks.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SKILLS_DIR = join(process.cwd(), "agents", "skills");
export const TASKS_DIR = join(process.cwd(), "fixtures", "skill-tasks");
export const ACTOR = "agent:skill-eval";

export interface SkillTask {
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

export interface TaskResult {
  id: string;
  suite: string;
  skill: string;
  passed: boolean;
  failures: string[];
  steps: number;
  answer: string;
}

export interface Episode {
  answer: string;
  steps: number;
  returnedIds: string[];
  transcript: string[];
}

export function flag(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? dflt) : dflt;
}

export async function guardScratchDb(): Promise<void> {
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

export async function seedCorpus(): Promise<void> {
  const { resetAndSeed } = await import("../test/helpers");
  const { drainEmbedBacklog } = await import("../src/search/index-parent");
  console.error("seeding fixtures + embedding...");
  await resetAndSeed();
  const embedded = await drainEmbedBacklog();
  console.error(`embedded ${embedded} chunks`);
}

// system prompt: the dispatcher + the one skill under test + a strict JSON protocol.
// Tool catalog comes from the registry so the doc never drifts from the implementation.
// `skillOverride` lets the optimizer evaluate a CANDIDATE skill text without touching disk.
async function systemPrompt(skillFile: string, skillOverride?: string): Promise<string> {
  const { ALL_TOOLS } = await import("../src/mcp/tools");
  const resolver = readFileSync(join(SKILLS_DIR, "RESOLVER.md"), "utf8");
  const skill = skillOverride ?? readFileSync(join(SKILLS_DIR, skillFile), "utf8");
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

export async function runEpisode(
  task: SkillTask,
  maxSteps: number,
  skillOverride?: string,
): Promise<Episode> {
  const { classifyProvider } = await import("../src/llm");
  const { toolByName } = await import("../src/mcp/tools");
  const { invokeTool } = await import("../src/mcp/tools/registry");
  const llm = classifyProvider();

  const system = await systemPrompt(task.skill, skillOverride);
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
    if (typeof obj.answer === "string")
      return { answer: obj.answer, steps: step, returnedIds, transcript };
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
  return { answer: "", steps: maxSteps, returnedIds, transcript };
}

export async function scoreTask(
  task: SkillTask,
  suite: string,
  ep: Episode,
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

/** Run a whole task list against an optional candidate skill text; logs per task. */
export async function runSuite(
  tasks: SkillTask[],
  suite: string,
  maxSteps: number,
  skillOverride?: string,
): Promise<TaskResult[]> {
  const results: TaskResult[] = [];
  for (const task of tasks) {
    const since = new Date();
    const ep = await runEpisode(task, maxSteps, skillOverride);
    const r = await scoreTask(task, suite, ep, since);
    results.push(r);
    console.error(
      `  ${r.passed ? "ok  " : "FAIL"} ${task.id} (${r.steps} steps)${r.passed ? "" : ` — ${r.failures.join("; ")}`}`,
    );
  }
  return results;
}
