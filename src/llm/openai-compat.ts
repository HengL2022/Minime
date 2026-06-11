// OpenAI-compatible provider: serves both OpenAI and OpenRouter (baseURL/key/model differ).
// Both support /embeddings with a `dimensions` parameter, so we request the schema-pinned
// 768 directly (OpenAI text-embedding-3-*; OpenRouter e.g. qwen3-embedding-8b via MRL —
// verified live 2026-06-11: returns unit-normalized 768-dim vectors).

import { config } from "../util/config";
import { EMBED_DIMS, type FetchFn, type LlmProvider } from "./types";

interface Compat {
  name: "openai" | "openrouter";
  baseUrl: string;
  apiKey: string;
  model: string;
  embedModel: string;
}

function settings(name: "openai" | "openrouter"): Compat {
  if (name === "openai") {
    if (!config.openaiApiKey) throw new Error("provider openai requires OPENAI_API_KEY in .env");
    return {
      name,
      baseUrl: config.openaiBaseUrl,
      apiKey: config.openaiApiKey,
      model: config.openaiModel,
      embedModel: config.openaiEmbedModel,
    };
  }
  if (!config.openrouterApiKey) {
    throw new Error("provider openrouter requires OPENROUTER_API_KEY in .env");
  }
  return {
    name,
    baseUrl: config.openrouterBaseUrl,
    apiKey: config.openrouterApiKey,
    model: config.openrouterModel,
    embedModel: config.openrouterEmbedModel,
  };
}

export function openaiCompatProvider(
  name: "openai" | "openrouter",
  fetchFn: FetchFn = fetch,
): LlmProvider {
  const s = settings(name);
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${s.apiKey}`,
  };

  const provider: LlmProvider = {
    name: s.name,
    model: s.model,
    embedModel: s.embedModel,
    isCloud: true,
    async completeJson(prompt: string): Promise<string> {
      const res = await fetchFn(`${s.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: s.model,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          temperature: 0,
        }),
      });
      if (!res.ok) throw new Error(`${s.name} chat failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { choices: { message: { content: string } }[] };
      return json.choices[0]?.message.content ?? "";
    },
  };

  provider.embed = async (texts: string[]): Promise<number[][]> => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 256) {
      const batch = texts.slice(i, i + 256);
      const res = await fetchFn(`${s.baseUrl}/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: s.embedModel, input: batch, dimensions: EMBED_DIMS }),
      });
      if (!res.ok) throw new Error(`${s.name} embed failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      const sorted = [...json.data].sort((a, b) => a.index - b.index);
      const vectors = sorted.map((d) => d.embedding);
      const bad = vectors.find((v) => v.length !== EMBED_DIMS);
      if (bad) {
        throw new Error(
          `${s.name} embed model ${s.embedModel} returned ${bad.length} dims (need ${EMBED_DIMS}); pick a model that honors the dimensions parameter`,
        );
      }
      out.push(...vectors);
    }
    return out;
  };
  return provider;
}
