// Chunk + index a parent row for hybrid search; embeddings are best-effort here
// (the dream job and `make embed` drain any backlog).

import {
  type ParentType,
  chunksMissingEmbedding,
  replaceChunks,
  setChunkEmbedding,
} from "../db/repo";
import { config } from "../util/config";
import { chunkMarkdown } from "./chunker";
import { embedTexts } from "./embed";

export async function indexParent(
  parentType: ParentType,
  parentId: string,
  md: string,
  title: string | undefined,
  tier: number,
): Promise<number> {
  const chunks = chunkMarkdown(md, title);
  await replaceChunks(parentType, parentId, chunks, tier);
  // typed-edge extraction is per-write (self-wiring graph); best-effort like embeddings —
  // the dream backlog pass catches anything missed here
  const { extractAndLink } = await import("../pipeline/extract-edges");
  await extractAndLink(parentType, parentId, [title, md].filter(Boolean).join("\n\n")).catch(
    () => {},
  );
  await drainEmbedBacklog(64).catch(() => {});
  return chunks.length;
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
