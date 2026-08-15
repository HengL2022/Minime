// Chunk + index a parent row for hybrid search; embeddings are best-effort here
// (the dream job and `make embed` drain any backlog).

import {
  type ParentType,
  chunksMissingEmbedding,
  parentHasChunks,
  replaceChunks,
  replacePageChunksMonotonic,
  setChunkEmbedding,
} from "../db/repo";
import { config } from "../util/config";
import { chunkMarkdownSpans } from "./chunker";
import { embedTexts } from "./embed";

export interface IndexParentOptions {
  extractEdges?: boolean;
  strictEdgeExtraction?: boolean;
  deferEmbeddings?: boolean;
  tierMode?: "replace" | "promote-page-floor";
}

export async function indexParent(
  parentType: ParentType,
  parentId: string,
  md: string,
  title: string | undefined,
  tier: number,
  options: IndexParentOptions = {},
): Promise<number> {
  if (tier === 0) throw new Error("TIER0_PROSE_BLOCKED");
  if (tier !== 1 && tier !== 2) throw new Error("INVALID_CONTENT_TIER");
  const spans = chunkMarkdownSpans(md, title);
  if (options.tierMode === "promote-page-floor") {
    if (parentType !== "page") throw new Error("promote-page-floor requires page parent");
    await replacePageChunksMonotonic(parentId, spans, tier);
  } else {
    await replaceChunks(parentType, parentId, spans, tier);
  }
  // typed-edge extraction is per-write (self-wiring graph); best-effort like embeddings —
  // the dream backlog pass catches anything missed here
  if (options.extractEdges !== false) {
    const { extractAndLink } = await import("../pipeline/extract-edges");
    const extraction = extractAndLink(
      parentType,
      parentId,
      [title, md].filter(Boolean).join("\n\n"),
      {
        replaceSourceEdges: true,
        tier,
        derivedFrom: parentId,
      },
    );
    if (options.strictEdgeExtraction) await extraction;
    else await extraction.catch(() => {});
  }
  // Inbox finalization keeps its database transaction short and deterministic: chunks and
  // graph edges commit with the parent, while network-backed embeddings drain after commit.
  if (!options.deferEmbeddings) await drainEmbedBacklog(64).catch(() => {});
  return spans.reduce((n, span) => n + span.children.length, 0);
}

// Companion identities minted after extract-edges may already exist (created=false)
// but still have no chunks. Index only the empty ones so a pre-existing org's
// richer chunks are never replaced with a name-only stub.
export async function indexParentIfEmpty(
  parentType: ParentType,
  parentId: string,
  md: string,
  title: string | undefined,
  tier: number,
  options: IndexParentOptions = {},
): Promise<number> {
  if (await parentHasChunks(parentType, parentId)) return 0;
  return indexParent(parentType, parentId, md, title, tier, options);
}

export async function drainEmbedBacklog(batch = 256): Promise<number> {
  // tier gate (CLOUD_MAX_TIER): with a cloud embed provider, higher-tier chunks are left
  // un-embedded (still FTS-searchable) rather than sent off-box
  const { embedIsCloud, embedModelName } = await import("../llm");
  const maxTier = !config.mockOllama && embedIsCloud() ? config.cloudMaxTier : 2;
  const modelName = config.mockOllama ? "mock" : embedModelName();
  let total = 0;
  for (;;) {
    const missing = await chunksMissingEmbedding(batch, maxTier);
    if (missing.length === 0) return total;
    const vectors = await embedTexts(missing.map((m) => m.text));
    for (let i = 0; i < missing.length; i++) {
      await setChunkEmbedding(missing[i]!.id, vectors[i]!, modelName);
    }
    total += missing.length;
    if (missing.length < batch) return total;
  }
}
