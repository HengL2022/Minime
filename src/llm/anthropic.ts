// Anthropic API provider (classification + contradiction scan; no embeddings API).

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../util/config";
import type { FetchFn, LlmProvider } from "./types";

export function anthropicProvider(fetchFn?: FetchFn): LlmProvider {
  if (!config.anthropicApiKey) {
    throw new Error("CLASSIFY_PROVIDER=anthropic requires ANTHROPIC_API_KEY in .env");
  }
  const client = new Anthropic({
    apiKey: config.anthropicApiKey,
    ...(fetchFn ? { fetch: fetchFn } : {}),
  });
  return {
    name: "anthropic",
    model: config.anthropicModel,
    isCloud: true,
    async completeJson(prompt: string): Promise<string> {
      const msg = await client.messages.create({
        model: config.anthropicModel,
        // see bedrock.ts: completeJson consumers include the skill optimizer's full-file rewrites
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      });
      const block = msg.content.find((b) => b.type === "text");
      return block && block.type === "text" ? block.text : "";
    },
  };
}
