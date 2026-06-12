// SkillOpt — gbrain-style optimizer loop for agents/skills/*.md (DECISIONS.md
// 2026-06-12). An optimizer model (the configured CLASSIFY provider — both roles run on
// the standing Bedrock config) reads TRAIN-set transcripts/failures and proposes a full
// skill rewrite. Acceptance is validation-gated, in order:
//   1. contamination check (mechanical, judge-free): the rewrite may not contain gold
//      tokens from ANY task's answer asserts that weren't already in the original skill
//      — a keyword-stuffed cheat is rejected before it is ever scored;
//   2. the TRAIN pass count must strictly improve;
//   3. only then is the HELD-OUT set run, and it must not regress.
// The optimizer never sees held-out tasks (fixtures/skill-tasks/*.json); it trains on
// fixtures/skill-tasks/train/*.json. Accepted candidates are written to
// agents/skills/candidates/ for human review — live skills are never modified.
//
// Usage (via make optimize-skill SUITE=query):
//   DATABASE_URL=$EVAL_SKILLS_DATABASE_URL EVAL_SKILLS_DATABASE_URL=... \
//     bun run scripts/optimize-skill.ts --suite query [--rounds 3] [--max-steps 8]
//     [--start-from <path>]   # optional deficient-skill start (loop validation, gbrain cat30)

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SKILLS_DIR,
  type SkillTask,
  TASKS_DIR,
  type TaskResult,
  flag,
  guardScratchDb,
  runEpisode,
  runSuite,
  scoreTask,
  seedCorpus,
} from "./skill-eval-lib";

const RESULTS_DIR = join(process.cwd(), "docs", "benchmarks");
const CANDIDATES_DIR = join(SKILLS_DIR, "candidates");

// generic absence-wording tokens that legally belong in any honest skill text
const GENERIC = new Set([
  "record",
  "cannot",
  "unable",
  "nothing",
  "couldn",
  "didn",
  "find",
  "grade",
]);

function goldTokens(tasks: SkillTask[]): Set<string> {
  const out = new Set<string>();
  for (const t of tasks) {
    for (const pat of [...(t.assert.answerMatch ?? []), ...(t.assert.answerAnyOf ?? [])]) {
      for (const tok of pat.split(/[^a-zA-Z]+/)) {
        const w = tok.toLowerCase();
        if (w.length >= 4 && !GENERIC.has(w)) out.add(w);
      }
    }
  }
  return out;
}

function contamination(candidate: string, forbidden: Set<string>, original: string): string[] {
  const had = new Set(
    original
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(Boolean),
  );
  const hits: string[] = [];
  for (const w of forbidden) {
    if (had.has(w)) continue; // was already in the live skill — not introduced by the rewrite
    if (new RegExp(`\\b${w}\\b`, "i").test(candidate)) hits.push(w);
  }
  return hits;
}

const passCount = (rs: TaskResult[]) => rs.filter((r) => r.passed).length;

function transcriptDigest(results: TaskResult[], episodes: Map<string, string[]>): string {
  return results
    .map((r) => {
      const t = (episodes.get(r.id) ?? []).join("\n").slice(0, 2500);
      return [
        `### Task ${r.id} — ${r.passed ? "PASS" : `FAIL: ${r.failures.join("; ")}`}`,
        "Transcript (truncated):",
        t,
      ].join("\n");
    })
    .join("\n\n");
}

async function proposeRewrite(
  skillFile: string,
  current: string,
  digest: string,
): Promise<string | null> {
  const { classifyProvider } = await import("../src/llm");
  const prompt = [
    "You are improving an agent skill file (markdown instructions an agent follows to do",
    "a job against a personal-memory tool API). Below: the current skill, then training",
    "episodes showing how an agent following it actually behaved, including failures.",
    "",
    "Rewrite the skill to fix the failure PATTERNS. Hard rules:",
    "- Generalize. NEVER mention specific people, places, topics, or answers from the",
    "  episodes — a rewrite that hardcodes test content will be rejected automatically.",
    "- Keep the original intent, format (markdown), and roughly the original length.",
    "- The agent must still: cite source IDs, disclose gaps/staleness, route numbers",
    "  through minime_query_metric, and never call minime_unlock unprompted.",
    "",
    `=== CURRENT SKILL (${skillFile}) ===`,
    current,
    "",
    "=== TRAINING EPISODES ===",
    digest,
    "",
    'Respond with ONE JSON object: {"skill_md": "<the complete rewritten skill file>"}',
  ].join("\n");
  const raw = await classifyProvider().completeJson(prompt);
  try {
    const obj = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""));
    return typeof obj.skill_md === "string" && obj.skill_md.length > 100 ? obj.skill_md : null;
  } catch {
    return null;
  }
}

async function runWithTranscripts(
  tasks: SkillTask[],
  suite: string,
  maxSteps: number,
  skillText: string,
): Promise<{ results: TaskResult[]; episodes: Map<string, string[]> }> {
  const results: TaskResult[] = [];
  const episodes = new Map<string, string[]>();
  for (const task of tasks) {
    const since = new Date();
    const ep = await runEpisode(task, maxSteps, skillText);
    episodes.set(task.id, ep.transcript);
    const r = await scoreTask(task, suite, ep, since);
    results.push(r);
    console.error(`  ${r.passed ? "ok  " : "FAIL"} ${task.id} (${r.steps} steps)`);
  }
  return { results, episodes };
}

async function main(): Promise<number> {
  await guardScratchDb();
  const suite = flag("suite", "");
  if (!suite) {
    console.error("usage: optimize-skill.ts --suite <name> [--rounds 3] [--start-from <path>]");
    return 2;
  }
  const rounds = Number(flag("rounds", "3"));
  const maxSteps = Number(flag("max-steps", "8"));
  const startFrom = flag("start-from", "");
  const roundLabel = flag("round", "r1");

  const train = JSON.parse(
    readFileSync(join(TASKS_DIR, "train", `${suite}.json`), "utf8"),
  ) as SkillTask[];
  const heldout = JSON.parse(readFileSync(join(TASKS_DIR, `${suite}.json`), "utf8")) as SkillTask[];
  const skillFile = train[0]!.skill;
  const liveSkill = readFileSync(join(SKILLS_DIR, skillFile), "utf8");
  const startSkill = startFrom ? readFileSync(startFrom, "utf8") : liveSkill;
  // contamination scope: gold from BOTH splits; baseline vocabulary is the LIVE skill
  // (a deficient start must not excuse fixture words the real skill never had)
  const forbidden = goldTokens([...train, ...heldout]);

  await seedCorpus();
  const { classifyProvider } = await import("../src/llm");
  const driver = classifyProvider();
  console.error(`optimizer+target: ${driver.name}:${driver.model} — suite ${suite}`);

  console.error(`baseline train (${train.length} tasks)...`);
  let cur = await runWithTranscripts(train, suite, maxSteps, startSkill);
  console.error(`baseline held-out (${heldout.length} tasks)...`);
  let curHeldout = await runSuite(heldout, suite, maxSteps, startSkill);
  let curSkill = startSkill;

  const log: string[] = [
    "| round | event | train | held-out |",
    "|---|---|---:|---:|",
    `| 0 | baseline (${startFrom ? "deficient start" : "live skill"}) | ${passCount(cur.results)}/${train.length} | ${passCount(curHeldout)}/${heldout.length} |`,
  ];

  for (let round = 1; round <= rounds; round++) {
    if (passCount(cur.results) === train.length) {
      log.push(`| ${round} | converged — train is perfect, nothing to learn from | — | — |`);
      console.error("converged: all train tasks pass.");
      break;
    }
    console.error(`round ${round}: proposing rewrite...`);
    const candidate = await proposeRewrite(
      skillFile,
      curSkill,
      transcriptDigest(cur.results, cur.episodes),
    );
    if (!candidate) {
      log.push(`| ${round} | optimizer returned no usable rewrite | — | — |`);
      continue;
    }
    const dirty = contamination(candidate, forbidden, liveSkill);
    if (dirty.length > 0) {
      log.push(`| ${round} | REJECTED: contamination (${dirty.join(", ")}) | — | — |`);
      console.error(`  rejected: gold tokens leaked into rewrite: ${dirty.join(", ")}`);
      continue;
    }
    console.error("  candidate clean; re-running train...");
    const candTrain = await runWithTranscripts(train, suite, maxSteps, candidate);
    if (passCount(candTrain.results) <= passCount(cur.results)) {
      log.push(
        `| ${round} | rejected: train did not improve | ${passCount(candTrain.results)}/${train.length} | — |`,
      );
      continue;
    }
    console.error("  train improved; validating held-out...");
    const candHeldout = await runSuite(heldout, suite, maxSteps, candidate);
    if (passCount(candHeldout) < passCount(curHeldout)) {
      log.push(
        `| ${round} | REJECTED: held-out regressed (overfit) | ${passCount(candTrain.results)}/${train.length} | ${passCount(candHeldout)}/${heldout.length} |`,
      );
      continue;
    }
    cur = candTrain;
    curHeldout = candHeldout;
    curSkill = candidate;
    log.push(
      `| ${round} | ACCEPTED | ${passCount(cur.results)}/${train.length} | ${passCount(curHeldout)}/${heldout.length} |`,
    );
  }

  const date = new Date().toISOString().slice(0, 10);
  const changed = curSkill !== startSkill;
  let candidatePath = "";
  if (changed) {
    mkdirSync(CANDIDATES_DIR, { recursive: true });
    candidatePath = join(CANDIDATES_DIR, `${suite}-${date}-${roundLabel}.md`);
    writeFileSync(candidatePath, curSkill);
  }

  const md = [
    `# SkillOpt — ${skillFile} (round ${roundLabel})`,
    "",
    `Optimizer+target: ${driver.name}:${driver.model}. Train: ${train.length} tasks; held-out:`,
    `${heldout.length} tasks (never shown to the optimizer). Gates: mechanical contamination`,
    "check → train must strictly improve → held-out must not regress.",
    startFrom
      ? `Start: DEFICIENT skill from ${startFrom} (loop-validation run, gbrain cat30 analog).`
      : "Start: live skill.",
    "",
    ...log,
    "",
    changed
      ? `Accepted candidate written to ${candidatePath} — review and apply manually; live skills are never auto-modified.`
      : "No candidate accepted — live skill unchanged.",
  ].join("\n");
  console.log(`\n${md}\n`);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const out = join(RESULTS_DIR, `${date}-${roundLabel}-skillopt-${suite}.md`);
  writeFileSync(out, `${md}\n`);
  console.error(`scorecard: ${out}`);

  const { closeDb } = await import("../src/db/client");
  await closeDb();
  return 0;
}

process.exit(await main());
