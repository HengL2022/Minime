// Embedding entry point: routes through the configured provider (ollama|openai — see
// src/llm/). In tests/CI (MINIME_MOCK_OLLAMA=1) deterministic pseudo-embeddings keep the
// suite fully offline.

import { embedProvider } from "../llm";
import { mockEmbed } from "../llm/mock";
import { config } from "../util/config";

export { EMBED_DIMS } from "../llm/types";
export { mockEmbed };

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (config.mockOllama) return texts.map(mockEmbed);
  return embedProvider().embed!(texts);
}

export async function embedQuery(text: string): Promise<number[]> {
  const [v] = await embedTexts([text]);
  return v!;
}
