// Local Ollama provider — the default; the only provider that keeps inference on-box.

import { config } from "../util/config";
import type { FetchFn, LlmProvider } from "./types";

export function ollamaProvider(fetchFn: FetchFn = fetch): LlmProvider {
  return {
    name: "ollama",
    model: `${config.embedModel}+${config.classifyModel}`,
    isCloud: false,

    async embed(texts: string[]): Promise<number[][]> {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 32) {
        const batch = texts.slice(i, i + 32);
        const res = await fetchFn(`${config.ollamaUrl}/api/embed`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: config.embedModel, input: batch }),
        });
        if (!res.ok) throw new Error(`ollama embed failed: ${res.status} ${await res.text()}`);
        const json = (await res.json()) as { embeddings: number[][] };
        out.push(...json.embeddings);
      }
      return out;
    },

    async completeJson(prompt: string): Promise<string> {
      const res = await fetchFn(`${config.ollamaUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: config.classifyModel,
          prompt,
          format: "json",
          stream: false,
          options: { temperature: 0 },
        }),
      });
      if (!res.ok) throw new Error(`ollama generate failed: ${res.status}`);
      const json = (await res.json()) as { response: string };
      return json.response;
    },
  };
}
