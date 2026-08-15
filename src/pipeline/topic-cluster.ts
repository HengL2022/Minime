// Topic hub pages cluster compiled notes around a decision or goal seed.
// They are digest-shaped read-models — not a CompiledNoteKind — so they stay
// off the H1 recovery machine. Related list is [[path]] wikilinks only;
// never task titles or member bodies.

import { join } from "node:path";
import {
  type TopicClusterInput,
  topicClusterCandidates,
  topicClusterPath,
  upsertPage,
} from "../db/repo";
import { indexParent } from "../search/index-parent";
import { atomicWritePrivate } from "../util/atomic-file";
import { config } from "../util/config";
import { parseWikilinks, resolveWikilinkTargets } from "./wikilinks";

const ACTOR = "system:dream";
const SOURCE = "dream:topic-cluster";
const MAX_WORDS = 80;

export interface TopicClusterResult {
  path: string;
  seed_kind: "decision" | "goal";
  seed_id: string;
  tier: number;
  status: "updated" | "unchanged" | "skipped";
}

function capWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return `${words.slice(0, maxWords).join(" ")} ...`;
}

export function renderTopicCluster(
  input: TopicClusterInput,
  compiler: "inline-draft" | "dream",
): string {
  const title = capWords(input.title, 18);
  const related = input.members.map((member) => `- [[${member.path}]]`).join("\n");
  return `# ${title}

compiler: ${compiler}

## Seed
${capWords(input.blurb, MAX_WORDS) || "No seed prose recorded yet."}

## Related
${related}

## Source
- ${input.kind}:${input.id}
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
  input: TopicClusterInput,
  compiler: "inline-draft" | "dream",
): Promise<TopicClusterResult> {
  const path = topicClusterPath(input.kind, input.id);
  const resolved = await resolveWikilinkTargets(input.members.map((member) => member.path));
  const resolvedPaths = new Set(resolved.map((row) => row.path));
  const members = input.members.filter((member) => resolvedPaths.has(member.path));
  if (members.length < 2) {
    return { path, seed_kind: input.kind, seed_id: input.id, tier: input.tier, status: "skipped" };
  }
  const body = renderTopicCluster({ ...input, members }, compiler);
  const title = capWords(input.title, 18);
  const contentHash = new Bun.CryptoHasher("sha256").update(body).digest("hex");
  const { id, changed } = await upsertPage({
    path,
    title,
    bodyMd: body,
    contentHash,
    tier: input.tier,
    source: SOURCE,
    createdBy: ACTOR,
    derivedFrom: input.id,
  });
  if (!changed)
    return {
      path,
      seed_kind: input.kind,
      seed_id: input.id,
      tier: input.tier,
      status: "unchanged",
    };
  await writeArchive(path, title, input.tier, body);
  await indexParent("page", id, body, title, input.tier);
  return { path, seed_kind: input.kind, seed_id: input.id, tier: input.tier, status: "updated" };
}

export async function compileTopicClusters(): Promise<{
  candidates: number;
  compiled: number;
  skipped: number;
  results: TopicClusterResult[];
}> {
  const candidates = await topicClusterCandidates();
  const results: TopicClusterResult[] = [];
  for (const input of candidates) {
    const result = await compileOne(input, "dream").catch(
      (): TopicClusterResult => ({
        path: topicClusterPath(input.kind, input.id),
        seed_kind: input.kind,
        seed_id: input.id,
        tier: input.tier,
        status: "skipped",
      }),
    );
    results.push(result);
  }
  const compiled = results.filter((row) => row.status === "updated").length;
  return {
    candidates: candidates.length,
    compiled,
    skipped: results.length - compiled,
    results,
  };
}

export function topicClusterWikilinks(body: string): string[] {
  return parseWikilinks(body);
}
