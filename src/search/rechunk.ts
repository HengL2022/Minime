// Rebuild spans + children for every already-chunked parent. Wipes embeddings
// (chunks are replaced) and drains the backlog. Owner-scheduled on live data.

import { listChunkParents, parentRechunkSource } from "../db/repo";
import { drainEmbedBacklog, indexParent } from "./index-parent";

export async function rechunkAll(): Promise<{ parents: number; chunks: number; skipped: number }> {
  const parents = await listChunkParents();
  let chunks = 0;
  let skipped = 0;
  for (const parent of parents) {
    const source = await parentRechunkSource(parent.parentType, parent.parentId);
    if (!source) {
      skipped += 1;
      continue;
    }
    chunks += await indexParent(
      parent.parentType,
      parent.parentId,
      source.text,
      source.title,
      source.tier,
      { deferEmbeddings: true },
    );
  }
  await drainEmbedBacklog().catch(() => {});
  return { parents: parents.length, chunks, skipped };
}
