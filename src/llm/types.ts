// One interface for the internal model jobs (embed, classify, contradiction scan, describe).
// Providers that cannot embed (anthropic/openrouter/bedrock) simply omit embed().
// describe is optional and currently implemented only by local Ollama (+ the hash-keyed mock).

/** Pinned by the chunks.embedding vector(768) column; changing it is a re-embed migration. */
export const EMBED_DIMS = 768;

export interface DescribeImage {
  mime: string;
  base64: string;
  sha256: string;
}

export interface LlmProvider {
  name: string;
  model: string;
  /** the embeddings model, when the provider can embed (differs from the chat model) */
  embedModel?: string;
  /** vision model id when the provider can describe images */
  vlmModel?: string;
  /** true when calls leave the machine — gates tiers and triggers the egress audit */
  isCloud: boolean;
  embed?(texts: string[]): Promise<number[][]>;
  /** Returns the raw model text for a prompt that demands a single JSON object. */
  completeJson(prompt: string): Promise<string>;
  /** Optional VLM caption. Never log or audit the image bytes or returned text. */
  describe?(image: DescribeImage, prompt: string): Promise<string>;
}

/** Test seam: providers do HTTP through this, so suites can capture/fake requests. */
export type FetchFn = typeof fetch;
