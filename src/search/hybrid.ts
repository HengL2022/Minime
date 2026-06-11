// Hybrid search fusion (spec §9). Candidates from repo (tier-filtered), scored here:
//   score = 0.55·cosine_norm + 0.30·fts_norm + 0.10·recency + 0.05·graph_boost
//   recency = exp(-age_days/180); derived penalty ×0.85 unless include_derived.
// Weights are starting values; tune only against the M3 eval (DECISIONS.md).

import {
  type Candidate,
  type ParentMeta,
  type ParentType,
  entitiesNamedIn,
  ftsCandidates,
  oneHopNeighbors,
  parentMeta,
  vectorCandidates,
} from "../db/repo";
import { now } from "../util/clock";
import { embedQuery } from "./embed";

export interface Hit {
  type: ParentType;
  id: string;
  title: string;
  snippet: string;
  score: number;
  updated_at: Date;
  derived: boolean;
  created_by: string;
}

const W_COS = 0.55;
const W_FTS = 0.3;
const W_REC = 0.1;
const W_GRAPH = 0.05;

function normalize(values: number[]): (v: number) => number {
  const max = Math.max(...values, 0);
  return max > 0 ? (v) => v / max : () => 0;
}

// ±1 sentence around the best query-term match.
export function snippet(text: string, query: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const terms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2);
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < sentences.length; i++) {
    const lower = sentences[i]!.toLowerCase();
    const s = terms.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  const out = sentences.slice(Math.max(0, best - 1), best + 2).join(" ");
  return out.length > 400 ? `${out.slice(0, 400)}…` : out;
}

export async function hybridSearch(opts: {
  query: string;
  types?: string[] | null;
  limit?: number;
  includeDerived?: boolean;
}): Promise<Hit[]> {
  const { query } = opts;
  const types = opts.types?.length ? opts.types : null;
  const limit = opts.limit ?? 10;
  const includeDerived = opts.includeDerived ?? false;

  // candidates = top-50 cosine ∪ top-50 fts (each already tier-filtered in repo)
  let vec: Candidate[] = [];
  try {
    vec = await vectorCandidates(await embedQuery(query), types);
  } catch {
    // embeddings unavailable (e.g. Ollama down): degrade to FTS-only
  }
  const fts = await ftsCandidates(query, types);

  const byId = new Map<string, Candidate>();
  for (const c of [...vec, ...fts]) {
    const prev = byId.get(c.id);
    if (prev) {
      prev.cosine = Math.max(prev.cosine, c.cosine);
      prev.fts = Math.max(prev.fts, c.fts);
    } else {
      byId.set(c.id, { ...c });
    }
  }
  const candidates = [...byId.values()];
  if (candidates.length === 0) return [];

  // parent metadata (recency, derived, title) — batch per type, tier-filtered again
  const idsByType = new Map<ParentType, string[]>();
  for (const c of candidates) {
    const list = idsByType.get(c.parent_type) ?? [];
    list.push(c.parent_id);
    idsByType.set(c.parent_type, list);
  }
  const meta = new Map<string, ParentMeta>();
  for (const [type, ids] of idsByType) {
    for (const [id, m] of await parentMeta(type, [...new Set(ids)])) {
      meta.set(`${type}:${id}`, m);
    }
  }

  // graph boost: parent within 1 edge hop of an entity literally named in the query
  const boosted = await oneHopNeighbors(await entitiesNamedIn(query));

  const normCos = normalize(candidates.map((c) => c.cosine));
  const normFts = normalize(candidates.map((c) => c.fts));
  const t = now().getTime();

  const scored = candidates.flatMap((c) => {
    const m = meta.get(`${c.parent_type}:${c.parent_id}`);
    if (!m) return []; // parent invisible at current tier (or deleted)
    const ageDays = Math.max(0, (t - new Date(m.updated_at).getTime()) / 86_400_000);
    const recency = Math.exp(-ageDays / 180);
    const graph = boosted.has(`${c.parent_type}:${c.parent_id}`) ? 1 : 0;
    let score =
      W_COS * normCos(c.cosine) + W_FTS * normFts(c.fts) + W_REC * recency + W_GRAPH * graph;
    const derived = m.derived_from !== null;
    if (derived && !includeDerived) score *= 0.85;
    return [{ c, m, score, derived }];
  });

  // dedupe to best chunk per parent
  const bestByParent = new Map<string, (typeof scored)[number]>();
  for (const s of scored) {
    const key = `${s.c.parent_type}:${s.c.parent_id}`;
    const prev = bestByParent.get(key);
    if (!prev || s.score > prev.score) bestByParent.set(key, s);
  }

  return [...bestByParent.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => ({
      type: s.c.parent_type,
      id: s.c.parent_id,
      title: s.m.title,
      snippet: snippet(s.c.text, query),
      score: Number(s.score.toFixed(4)),
      updated_at: s.m.updated_at,
      derived: s.derived,
      created_by: s.m.created_by,
    }));
}
