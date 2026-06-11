// Provider factories + the egress audit. Cloud calls write an events row (provider,
// model, item count — never contents) so `minime audit` shows exactly what left the box.

import { logEvent } from "../db/repo";
import { type ProviderName, config } from "../util/config";
import { anthropicProvider } from "./anthropic";
import { bedrockProvider } from "./bedrock";
import { ollamaProvider } from "./ollama";
import { openaiCompatProvider } from "./openai-compat";
import type { FetchFn, LlmProvider } from "./types";

const EMBED_CAPABLE =
  "embeddings require a 768-dim model: EMBED_PROVIDER must be 'ollama' (nomic-embed-text) or 'openai' (text-embedding-3-* with dimensions=768); anthropic/openrouter have no embeddings API and Bedrock Titan cannot emit 768 dims";

function build(name: ProviderName, fetchFn?: FetchFn): LlmProvider {
  switch (name) {
    case "ollama":
      return ollamaProvider(fetchFn);
    case "anthropic":
      return anthropicProvider(fetchFn);
    case "openai":
    case "openrouter":
      return openaiCompatProvider(name, fetchFn);
    case "bedrock":
      return bedrockProvider(fetchFn);
    default:
      throw new Error(`unknown provider '${name}' (ollama|anthropic|openai|openrouter|bedrock)`);
  }
}

function withEgressAudit(p: LlmProvider): LlmProvider {
  if (!p.isCloud) return p;
  return {
    ...p,
    embed: p.embed
      ? async (texts) => {
          await logEvent({
            actor: "system:llm",
            verb: "egress:embed",
            payload: { provider: p.name, model: p.model, items: texts.length },
          });
          return p.embed!(texts);
        }
      : undefined,
    completeJson: async (prompt) => {
      await logEvent({
        actor: "system:llm",
        verb: "egress:classify",
        payload: { provider: p.name, model: p.model, items: 1 },
      });
      return p.completeJson(prompt);
    },
  };
}

export function embedProvider(fetchFn?: FetchFn): LlmProvider {
  const p = withEgressAudit(build(config.embedProvider, fetchFn));
  if (!p.embed)
    throw new Error(`EMBED_PROVIDER=${config.embedProvider} cannot embed — ${EMBED_CAPABLE}`);
  return p;
}

export function classifyProvider(fetchFn?: FetchFn): LlmProvider {
  return withEgressAudit(build(config.classifyProvider, fetchFn));
}

export function embedIsCloud(): boolean {
  return config.embedProvider !== "ollama";
}

/** The model name stamped on chunks.embed_model (changing it implies a re-embed). */
export function embedModelName(): string {
  return config.embedProvider === "openai" ? config.openaiEmbedModel : config.embedModel;
}

export function classifyIsCloud(): boolean {
  return config.classifyProvider !== "ollama";
}
