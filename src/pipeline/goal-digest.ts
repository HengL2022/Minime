// Goal digest pages are retrieval read-models for goals, parallel to decision
// digests. Progress is counts only — never task titles or bodies — so a
// linked tier-2 task cannot leak prose onto the digest.

import { join } from "node:path";
import {
  type GoalDigestInput,
  goalDigestCandidates,
  goalDigestInput,
  goalDigestPath,
  upsertPage,
} from "../db/repo";
import { indexParent } from "../search/index-parent";
import { atomicWritePrivate } from "../util/atomic-file";
import { config } from "../util/config";

const ACTOR = "system:dream";
const SOURCE = "dream:goal-digest";
const MAX_WORDS = 80;

export interface GoalDigestResult {
  path: string;
  goal_id: string;
  tier: number;
  status: "updated" | "unchanged" | "skipped";
}

function capWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return `${words.slice(0, maxWords).join(" ")} ...`;
}

function renderDigest(g: GoalDigestInput, compiler: "inline-draft" | "dream"): string {
  const why = g.why?.trim() ? capWords(g.why, MAX_WORDS) : "No why recorded yet.";
  return `# ${capWords(g.statement, 18)}

compiler: ${compiler}

## Horizon
${g.horizon}

## Why
${why}

## Progress
${g.open_task_count} open / ${g.done_task_count} done linked tasks.

## Source
- goal:${g.id}
`;
}

async function writeArchive(
  path: string,
  title: string,
  tier: number,
  body: string,
): Promise<void> {
  const abs = join(config.dataDir, "brain", path);
  await atomicWritePrivate(
    abs,
    `---\ntitle: "${title.replace(/"/g, '\\"')}"\ntier: ${tier}\n---\n${body}`,
  );
}

async function compileOne(
  g: GoalDigestInput,
  compiler: "inline-draft" | "dream",
): Promise<GoalDigestResult> {
  const path = goalDigestPath(g.id);
  const body = renderDigest(g, compiler);
  const contentHash = new Bun.CryptoHasher("sha256").update(body).digest("hex");
  const { id, changed } = await upsertPage({
    path,
    title: capWords(g.statement, 18),
    bodyMd: body,
    contentHash,
    tier: g.tier === 2 ? 2 : 1,
    source: SOURCE,
    createdBy: ACTOR,
    derivedFrom: g.id,
  });
  if (!changed) return { path, goal_id: g.id, tier: g.tier, status: "unchanged" };
  await writeArchive(path, capWords(g.statement, 18), g.tier === 2 ? 2 : 1, body);
  await indexParent("page", id, body, capWords(g.statement, 18), g.tier === 2 ? 2 : 1);
  return { path, goal_id: g.id, tier: g.tier === 2 ? 2 : 1, status: "updated" };
}

export async function compileGoalDigests(): Promise<{
  candidates: number;
  compiled: number;
  skipped: number;
  results: GoalDigestResult[];
}> {
  const candidates = await goalDigestCandidates();
  const results: GoalDigestResult[] = [];
  for (const g of candidates) {
    const r = await compileOne(g, "dream").catch(
      (): GoalDigestResult => ({
        path: goalDigestPath(g.id),
        goal_id: g.id,
        tier: g.tier === 2 ? 2 : 1,
        status: "skipped",
      }),
    );
    results.push(r);
  }
  const compiled = results.filter((r) => r.status === "updated").length;
  return {
    candidates: candidates.length,
    compiled,
    skipped: results.length - compiled,
    results,
  };
}
