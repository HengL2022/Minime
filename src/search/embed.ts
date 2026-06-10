// Embeddings via local Ollama (I1). In tests/CI (MINIME_MOCK_OLLAMA=1) we generate
// deterministic pseudo-embeddings so the suite runs fully offline.

import { config } from "../util/config";

export const EMBED_DIMS = 768;

// FNV-1a hash → seed for a tiny PRNG; same text always yields the same vector.
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic mock: bag-of-words vector so that texts sharing words are cosine-close.
// This keeps the M3 retrieval eval meaningful offline.
export function mockEmbed(text: string): number[] {
  const v = new Array<number>(EMBED_DIMS).fill(0);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  for (const tok of tokens) {
    const rand = mulberry32(fnv1a(tok));
    for (let k = 0; k < 8; k++) {
      const dim = Math.floor(rand() * EMBED_DIMS);
      v[dim]! += rand() * 2 - 0.5;
    }
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (config.mockOllama) return texts.map(mockEmbed);

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32);
    const res = await fetch(`${config.ollamaUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: config.embedModel, input: batch }),
    });
    if (!res.ok) throw new Error(`ollama embed failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { embeddings: number[][] };
    out.push(...json.embeddings);
  }
  return out;
}

export async function embedQuery(text: string): Promise<number[]> {
  const [v] = await embedTexts([text]);
  return v!;
}
