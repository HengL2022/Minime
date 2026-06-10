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
  await drainEmbedBacklog(64).catch(() => {});
  return chunks.length;
}

export async function drainEmbedBacklog(batch = 256): Promise<number> {
  let total = 0;
  for (;;) {
    const missing = await chunksMissingEmbedding(batch);
    if (missing.length === 0) return total;
    const vectors = await embedTexts(missing.map((m) => m.text));
    for (let i = 0; i < missing.length; i++) {
      await setChunkEmbedding(
        missing[i]!.id,
        vectors[i]!,
        config.mockOllama ? "mock" : config.embedModel,
      );
    }
    total += missing.length;
    if (missing.length < batch) return total;
  }
}
