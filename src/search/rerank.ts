// Local cross-encoder reranker stage (Phase 3, DECISIONS.md 2026-06-12). Calls a
// llama-server `--rerank` endpoint (/v1/rerank, bge-reranker-v2-m3) with (query, text)
// pairs and returns relevance scores. Two hard rules:
//   1. LOCALHOST ONLY (I1): chunk text never leaves the box for ranking. A non-local
//      RERANK_URL disables the stage rather than being honored.
//   2. FAIL-OPEN: any error (server down, timeout, bad payload) returns null and the
//      caller keeps the RRF order — a flaky reranker must never break search.

import type { FetchFn } from "../llm/types";
import { config } from "../util/config";

const TIMEOUT_MS = 10_000;

export function rerankEnabled(): boolean {
  if (!config.rerankUrl) return false;
  try {
    const host = new URL(config.rerankUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

let warnedOnce = false;
function warnOnce(reason: string): void {
  if (warnedOnce) return;
  warnedOnce = true;
  // fail-open must not be silent forever: one loud line per process (no content logged)
  console.error(`[rerank] stage degraded, keeping RRF order (${reason})`);
}

/** Relevance scores aligned to `texts` (higher = more relevant), or null on any failure. */
export async function rerank(
  query: string,
  texts: string[],
  fetchFn: FetchFn = fetch,
): Promise<number[] | null> {
  if (!rerankEnabled() || texts.length === 0) return null;
  try {
    const res = await fetchFn(`${config.rerankUrl}/v1/rerank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // defensive cap well under the server's batch budget; chunks are ≤~450 tokens anyway
      body: JSON.stringify({
        model: config.rerankModel,
        query: query.slice(0, 2000),
        documents: texts.map((t) => t.slice(0, 6000)),
      }),
      // localhost-only must hold for EVERY hop: a redirect from the local port could
      // re-POST chunk text to a remote host, so redirects are a hard error (I1)
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      warnOnce(`HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as {
      results?: { index: number; relevance_score: number }[];
    };
    if (!json.results || json.results.length !== texts.length) {
      warnOnce("malformed response");
      return null;
    }
    const scores = new Array<number>(texts.length).fill(Number.NEGATIVE_INFINITY);
    for (const r of json.results) {
      if (
        !Number.isFinite(r.relevance_score) ||
        r.index < 0 ||
        r.index >= texts.length ||
        scores[r.index] !== Number.NEGATIVE_INFINITY // duplicate index
      ) {
        warnOnce("malformed response");
        return null;
      }
      scores[r.index] = r.relevance_score;
    }
    return scores;
  } catch (e) {
    warnOnce(e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** One round-trip health probe — benchmark runners abort instead of silently degrading. */
export async function rerankProbe(fetchFn: FetchFn = fetch): Promise<boolean> {
  if (!rerankEnabled()) return false;
  const scores = await rerank("probe", ["alpha", "beta"], fetchFn);
  return scores !== null;
}
