// PrecisionMemBench (github.com/tenurehq/precisionmembench) external-provider wrapper.
// The benchmark scores retrieval PRECISION: it punishes returning extra results and
// letting the model sort them out — exactly what Phase-3 rerank+autocut is for. Their
// ava harness drives this server over the /add /search /reset contract; everything
// behind the HTTP surface is Minime's real engine (upsertPage → chunk → embed →
// hybridSearch) on a scratch eval DB.
//
// Mapping decisions (see DECISIONS.md):
// - one belief = one page at pmb/<user_id>/<beliefId>.md (user isolation by path scope)
// - scope filter is STRICT equality on the single scope the harness forwards; the one
//   multi-scope case is structurally unwinnable for every external provider
// - superseded/resolved status is NOT in the external /add metadata — those cases are
//   taken honestly as the shared external-provider handicap
//
// Usage (via make eval-pmb): DATABASE_URL=$EVAL_PMB_DATABASE_URL EVAL_PMB_DATABASE_URL=...
//   bun run scripts/pmb-server.ts

interface BeliefRec {
  userId: string;
  scope: string | null;
  text: string;
  // present only when the session adapter seeds (its metadata carries type/superseded_by);
  // the retrieval suite sends neither, so no filtering happens there — the shared handicap
  type?: string;
  supersededBy?: string | null;
}

const PORT = Number(process.env.PMB_PORT ?? 8077);
const beliefs = new Map<string, BeliefRec>(); // beliefId -> record (wrapper-local, like every wrapper in their repo)

const pathFor = (userId: string, beliefId: string) => `pmb/${userId}/${beliefId}.md`;
// derived from the id only — gives the title channel something lexical without inventing content
const titleFor = (beliefId: string) => beliefId.replace(/^b-/, "").replace(/-/g, " ");

async function guard(): Promise<void> {
  if (
    !process.env.EVAL_PMB_DATABASE_URL ||
    process.env.DATABASE_URL !== process.env.EVAL_PMB_DATABASE_URL
  ) {
    console.error(
      "ERROR: refusing to run — start with DATABASE_URL=EVAL_PMB_DATABASE_URL (scratch DB; the pool binds at module load).",
    );
    process.exit(2);
  }
  const { sql } = await import("../src/db/client");
  const [{ db }] = (await sql`select current_database() as db`) as unknown as [{ db: string }];
  if (!/eval/i.test(db)) {
    console.error(`ERROR: refusing to run — connected database "${db}" is not a scratch eval DB.`);
    process.exit(2);
  }
  // precision is the whole benchmark: a silently degraded reranker turns autocut into a
  // no-op and the run measures fixed top-K instead (same loud-failure rule as the other runners)
  const { rerankEnabled, rerankProbe } = await import("../src/search/rerank");
  let rerankActive = false;
  if (rerankEnabled()) {
    rerankActive = await rerankProbe();
    if (!rerankActive) {
      console.error(
        "ERROR: RERANK_URL is set but the probe call failed — fix the server or unset.",
      );
      process.exit(2);
    }
  }
  console.error(
    `pmb-server: db=${db} port=${PORT} rerank=${rerankActive ? `on (${process.env.RERANK_MODEL ?? "bge-reranker-v2-m3"}) + autocut` : "OFF — fixed top-K baseline"}`,
  );
}

async function upsertBelief(
  beliefId: string,
  userId: string,
  text: string,
  scope: string | null,
  meta?: { type?: string; superseded_by?: string | null },
) {
  const { upsertPage, replaceChunks, chunksMissingEmbedding, setChunkEmbedding } = await import(
    "../src/db/repo"
  );
  const { chunkMarkdown } = await import("../src/search/chunker");
  const { embedTexts } = await import("../src/search/embed");
  const { embedModelName } = await import("../src/llm");

  beliefs.set(beliefId, {
    userId,
    scope,
    text,
    type: meta?.type,
    supersededBy: meta?.superseded_by ?? null,
  });
  const title = titleFor(beliefId);
  // direct replaceChunks (not indexParent): no entity extraction on benchmark fixtures
  const { id, changed } = await upsertPage({
    path: pathFor(userId, beliefId),
    title,
    bodyMd: text,
    contentHash: Bun.hash(text).toString(16),
    tier: 1,
    source: "pmb",
  });
  if (changed) {
    await replaceChunks("page", id, chunkMarkdown(text, title), 1);
    // embed synchronously — the harness queries immediately after seeding
    for (;;) {
      const missing = await chunksMissingEmbedding(64, 2);
      if (missing.length === 0) break;
      const vecs = await embedTexts(missing.map((m) => m.text));
      for (let i = 0; i < missing.length; i++)
        await setChunkEmbedding(missing[i]!.id, vecs[i]!, embedModelName());
    }
  }
}

async function search(
  userId: string,
  query: string,
  limit: number,
  scope: string | null,
): Promise<{ id: string; memory: string; score: number }[]> {
  if (!query.trim()) return [];
  const { pagesByPaths } = await import("../src/db/repo");
  const { hybridSearch } = await import("../src/search/hybrid");

  const allowed = [...beliefs.entries()].filter(
    ([, b]) =>
      b.userId === userId &&
      (!scope || b.scope === scope) &&
      b.type !== "open_question" &&
      !b.supersededBy,
  );
  if (allowed.length === 0) return [];

  const beliefByPath = new Map(allowed.map(([bid, b]) => [pathFor(b.userId, bid), bid]));
  const pages = await pagesByPaths([...beliefByPath.keys()]);
  const beliefByPageId = new Map(pages.map((p) => [p.id, beliefByPath.get(p.path)!]));

  const hits = await hybridSearch({
    query,
    scopeParentIds: pages.map((p) => p.id),
    limit,
    autocut: true,
  });
  return hits
    .filter((h) => beliefByPageId.has(h.id))
    .map((h) => ({
      id: beliefByPageId.get(h.id)!,
      memory: beliefs.get(beliefByPageId.get(h.id)!)?.text ?? "",
      score: h.score,
    }));
}

await guard();

Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    try {
      if (url.pathname === "/health") return json({ ok: true });
      if (url.pathname === "/wait" && req.method === "POST") return json({ ok: true });

      if (url.pathname === "/add" && req.method === "POST") {
        const b = (await req.json()) as {
          text: string;
          user_id: string;
          metadata?: {
            beliefId?: string;
            scope?: string;
            type?: string;
            superseded_by?: string | null;
          };
        };
        const beliefId = b.metadata?.beliefId;
        if (!beliefId) return json({ error: "metadata.beliefId required" }, 400);
        await upsertBelief(beliefId, b.user_id, b.text, b.metadata?.scope ?? null, b.metadata);
        return json({ ok: true });
      }

      if (url.pathname === "/update" && req.method === "PUT") {
        const b = (await req.json()) as {
          beliefId: string;
          text: string;
          user_id: string;
          metadata?: { scope?: string; type?: string; superseded_by?: string | null };
        };
        const prior = beliefs.get(b.beliefId);
        await upsertBelief(
          b.beliefId,
          b.user_id,
          b.text,
          b.metadata?.scope ?? prior?.scope ?? null,
          b.metadata,
        );
        return json({ ok: true });
      }

      if (url.pathname === "/search" && req.method === "POST") {
        const b = (await req.json()) as {
          query: string;
          user_id: string;
          limit?: number;
          scope?: string;
        };
        const results = await search(b.user_id, b.query, b.limit ?? 20, b.scope ?? null);
        return json({ results });
      }

      if (url.pathname === "/reset" && req.method === "DELETE") {
        const { resetDb } = await import("../test/helpers"); // drop + migrate, sanctioned reset path
        await resetDb();
        beliefs.clear();
        return json({ ok: true });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      console.error(`pmb-server: ${req.method} ${url.pathname} failed:`, e);
      return json({ error: String(e) }, 500);
    }
  },
});
