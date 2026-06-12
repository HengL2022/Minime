// Hybrid search fusion (spec §9, Phase-1a amendment — DECISIONS.md). Candidates from repo
// (tier-filtered) are fused here by reciprocal-rank fusion (RRF) rather than a weighted sum
// of max-normalized scores:
//   rrf(c) = Σ_arm weight_arm / (RRF_K + rank_arm(c))           over {vector, fts}
//   base   = 0.7·rrf_norm + 0.3·cosine                          (re-score blend)
//   score  = base · recencyMult · graphMult · accessMult · titleBoost · (derived ? 0.85 : 1)
// Recency, graph adjacency and access frequency are small post-fusion MULTIPLIERS
// (≤~×1.05 band each), not weighted terms — they nudge near-ties without swamping relevance. A zero-LLM intent classifier
// nudges the FTS arm weight, the recency band, and the title boost. Constants are starting
// values; tune only against the eval harness. // eval-calibration pending

import {
  type Candidate,
  type ParentMeta,
  type ParentType,
  accessCounts,
  entitiesNamedIn,
  ftsCandidates,
  oneHopNeighbors,
  parentMeta,
  vectorCandidates,
} from "../db/repo";
import { now } from "../util/clock";
import { config } from "../util/config";
import { autocut } from "./autocut";
import { embedQuery } from "./embed";
import { intentNudge } from "./intent";
import { rerank, rerankEnabled } from "./rerank";
import { titleBoost } from "./title-match";

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

// RRF dampening constant (Cormack et al. 2009 use 60): large enough that the top several
// ranks of each arm contribute comparably, so neither arm's raw score scale leaks in.
const RRF_K = 60;
const W_RRF_VEC = 1.0; // vector arm RRF weight (FTS arm weight comes from the intent nudge)
const W_RRF_FTS = 1.0;
// Re-score blend: cross-arm rank agreement vs raw cosine (rewards a strong lone semantic
// match). Calibration note (MinimeBench live-r1/r2, 2026-06-12): 0.8/0.2 was tried to fix
// topically-named distractors out-cosining answer pages (en-99, p-3); the live re-run showed
// it fixed NEITHER while costing a graph question — those misses are an RRF-vs-weighted-sum
// margin effect, not blend-calibratable. 0.7/0.3 is the better-measured setting; the
// structural fix for the remaining two misses is the Phase-3 reranker.
const BLEND_RRF = 0.7;
const BLEND_COS = 0.3;
const REC_BAND = 0.05; // recency multiplier spans [1, 1+REC_BAND]
const GRAPH_BAND = 0.05; // graph-adjacency multiplier ∈ {1, 1+GRAPH_BAND}
// Access-frequency nudge (agentmemory-inspired, DECISIONS.md 2026-06-12): parents the
// owner's agents deliberately drilled into (minime_get_context returns, NOT search hits —
// that would self-reinforce) get up to ×(1+ACCESS_BAND), saturating at ACCESS_CAP
// drill-ins inside the window. // eval-calibration pending
const ACCESS_BAND = 0.05;
const ACCESS_CAP = 5;
const ACCESS_WINDOW_DAYS = 90;
const DERIVED_PENALTY = 0.85;
// Compiled notes (dream-distilled summaries, source='dream:notes') are high-signal derived
// content — boosted like GBrain's compiled-truth layer instead of penalized. ×1.5 starting
// value. // eval-calibration pending
const NOTES_BOOST = 1.5;

// 1-based rank per candidate id, ordered by `key` descending. Each arm is already sorted in
// repo (limit 50); we re-derive ranks here so the fusion math is self-contained and testable.
function armRanks(arm: Candidate[], key: (c: Candidate) => number): Map<string, number> {
  const ordered = [...arm].sort((a, b) => key(b) - key(a));
  const m = new Map<string, number>();
  ordered.forEach((c, i) => {
    if (!m.has(c.id)) m.set(c.id, i + 1); // first occurrence = best rank
  });
  return m;
}

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

// Phase-3 rerank stage: cross-encode (query, best chunk) for the top RERANK_TOP_IN
// parents and reorder them by relevance; the un-reranked tail keeps RRF order so recall
// never drops. Fail-open: a null score set leaves the order untouched. Autocut sizes the
// result on the rerank-score cliff only (never RRF gaps — they carry no correctness
// signal); without rerank scores it is a no-op.
async function rerankStage<T extends { c: { text: string } }>(
  query: string,
  ranked: T[],
  limit: number,
  wantAutocut: boolean,
): Promise<{ ordered: T[]; cut: number }> {
  if (!rerankEnabled() || ranked.length < 2) return { ordered: ranked, cut: limit };
  const head = ranked.slice(0, config.rerankTopIn);
  const scores = await rerank(
    query,
    head.map((s) => s.c.text),
  );
  if (!scores) return { ordered: ranked, cut: limit };
  const order = head.map((s, i) => ({ s, score: scores[i]! })).sort((a, b) => b.score - a.score);
  const ordered = [...order.map((o) => o.s), ...ranked.slice(config.rerankTopIn)];
  const cut = wantAutocut ? Math.min(limit, autocut(order.map((o) => o.score))) : limit;
  // calibration observability: raw cross-encoder scores per query, opt-in via env.
  // Offline analysis only — never consulted by the retrieval path.
  if (process.env.RERANK_DEBUG) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      process.env.RERANK_DEBUG,
      `${JSON.stringify({
        query,
        cut,
        scored: order.map((o) => ({
          id: (o.s.c as { parent_id?: string }).parent_id,
          title: (o.s as unknown as { m?: { title?: string } }).m?.title,
          score: o.score,
        })),
      })}\n`,
    );
  }
  return { ordered, cut };
}

export async function hybridSearch(opts: {
  query: string;
  types?: string[] | null;
  limit?: number;
  includeDerived?: boolean;
  /** optional scope: restrict candidates to these parent row ids (e.g. a benchmark haystack) */
  scopeParentIds?: string[] | null;
  /** cut the result list at the rerank-score cliff (only meaningful with the reranker on) */
  autocut?: boolean;
}): Promise<Hit[]> {
  const { query } = opts;
  const types = opts.types?.length ? opts.types : null;
  const limit = opts.limit ?? 10;
  const includeDerived = opts.includeDerived ?? false;
  const scope = opts.scopeParentIds?.length ? opts.scopeParentIds : null;
  const nudge = intentNudge(query); // zero-LLM; never overrides explicit filters

  // candidates = top-50 cosine ∪ top-50 fts (each already tier-filtered in repo)
  let vec: Candidate[] = [];
  try {
    vec = await vectorCandidates(await embedQuery(query), types, scope);
  } catch {
    // embeddings unavailable (e.g. Ollama down): degrade to FTS-only
  }
  const fts = await ftsCandidates(query, types, scope);

  // RRF ranks come from each arm's OWN ordering (before the union erases per-arm position).
  const vecRank = armRanks(vec, (c) => c.cosine);
  const ftsRank = armRanks(fts, (c) => c.fts);

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

  // access boost: parents the owner's agents drilled into recently (audit log, ids only)
  const access = await accessCounts(
    [...new Set(candidates.map((c) => c.parent_id))],
    ACCESS_WINDOW_DAYS,
  );

  // RRF score per candidate, then max-normalize so the blend lives on a [0,1] scale.
  const rrfRaw = new Map<string, number>();
  for (const c of candidates) {
    const vr = vecRank.get(c.id);
    const fr = ftsRank.get(c.id);
    const r =
      (vr ? W_RRF_VEC / (RRF_K + vr) : 0) +
      (fr ? (W_RRF_FTS * nudge.ftsRrfWeight) / (RRF_K + fr) : 0);
    rrfRaw.set(c.id, r);
  }
  const normRrf = normalize([...rrfRaw.values()]);
  const t = now().getTime();

  const scored = candidates.flatMap((c) => {
    const m = meta.get(`${c.parent_type}:${c.parent_id}`);
    if (!m) return []; // parent invisible at current tier (or deleted)

    // re-score blend: rank-fusion agreement, lifted by raw cosine for strong semantic hits.
    const base = BLEND_RRF * normRrf(rrfRaw.get(c.id)!) + BLEND_COS * c.cosine;

    // post-fusion multipliers (recency/graph in a narrow band; intent nudges recency width).
    const ageDays = Math.max(0, (t - new Date(m.updated_at).getTime()) / 86_400_000);
    const recencyMult = 1 + REC_BAND * nudge.recencyScale * Math.exp(-ageDays / 180);
    const graphMult = boosted.has(`${c.parent_type}:${c.parent_id}`) ? 1 + GRAPH_BAND : 1;
    const drills = access.get(c.parent_id) ?? 0;
    const accessMult = 1 + ACCESS_BAND * (Math.min(drills, ACCESS_CAP) / ACCESS_CAP);
    const title = titleBoost(query, m.title, nudge.titleBoostScale);

    let score = base * recencyMult * graphMult * accessMult * title;
    const derived = m.derived_from !== null;
    // both stamps required: an imported/agent-written page can't claim the boost by source alone
    if (m.source === "dream:notes" && m.created_by === "system:dream") score *= NOTES_BOOST;
    else if (derived && !includeDerived) score *= DERIVED_PENALTY;
    return [{ c, m, score, derived }];
  });

  // dedupe to best chunk per parent
  const bestByParent = new Map<string, (typeof scored)[number]>();
  for (const s of scored) {
    const key = `${s.c.parent_type}:${s.c.parent_id}`;
    const prev = bestByParent.get(key);
    if (!prev || s.score > prev.score) bestByParent.set(key, s);
  }

  const ranked = [...bestByParent.values()].sort((a, b) => b.score - a.score);
  const { ordered, cut } = await rerankStage(query, ranked, limit, opts.autocut ?? false);

  return ordered.slice(0, cut).map((s) => ({
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
