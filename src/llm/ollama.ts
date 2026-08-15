// Local Ollama provider — the default; the only provider that keeps inference on-box.

import { config } from "../util/config";
import { ollamaApiUrl, validateOllamaUrl } from "../util/ollama-url";
import { type OllamaRequestOptions, ollamaRequest } from "./ollama-http";
import type { FetchFn, LlmProvider } from "./types";

// Local CPU VLMs regularly exceed the 30s embed/classify deadline.
export const DESCRIBE_TIMEOUT_MS = 600_000;

export function ollamaProvider(fetchFn?: FetchFn): LlmProvider {
  const endpoint = validateOllamaUrl(config.ollamaUrl);
  const request = async (
    apiPath: `/${string}`,
    init?: RequestInit,
    options?: OllamaRequestOptions,
  ): Promise<Response> => {
    if (fetchFn) return fetchFn(ollamaApiUrl(endpoint, apiPath), init);
    return ollamaRequest(endpoint, apiPath, init, options);
  };
  return {
    name: "ollama",
    model: `${config.embedModel}+${config.classifyModel}`,
    vlmModel: config.vlmModel || undefined,
    isCloud: false,

    async embed(texts: string[]): Promise<number[][]> {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 32) {
        const batch = texts.slice(i, i + 32);
        const res = await request("/api/embed", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: config.embedModel, input: batch }),
        });
        if (!res.ok) throw new Error(`ollama embed failed: ${res.status}`);
        const json = (await res.json()) as { embeddings: number[][] };
        out.push(...json.embeddings);
      }
      return out;
    },

    async completeJson(prompt: string): Promise<string> {
      const res = await request("/api/generate", {
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

    describe: config.vlmModel
      ? async (image, prompt) => {
          const res = await request(
            "/api/generate",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                model: config.vlmModel,
                prompt,
                images: [image.base64],
                stream: false,
                options: { temperature: 0 },
              }),
            },
            { timeoutMs: DESCRIBE_TIMEOUT_MS },
          );
          if (!res.ok) throw new Error(`ollama describe failed: ${res.status}`);
          const json = (await res.json()) as { response: string };
          return json.response;
        }
      : undefined,
  };
}
