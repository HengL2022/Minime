// One interface for the three internal model jobs (embed, classify, contradiction scan).
// Providers that cannot embed (anthropic/openrouter/bedrock) simply omit embed().

/** Pinned by the chunks.embedding vector(768) column; changing it is a re-embed migration. */
export const EMBED_DIMS = 768;

export interface LlmProvider {
  name: string;
  model: string;
  /** true when calls leave the machine — gates tiers and triggers the egress audit */
  isCloud: boolean;
  embed?(texts: string[]): Promise<number[][]>;
  /** Returns the raw model text for a prompt that demands a single JSON object. */
  completeJson(prompt: string): Promise<string>;
}

/** Test seam: providers do HTTP through this, so suites can capture/fake requests. */
export type FetchFn = typeof fetch;
