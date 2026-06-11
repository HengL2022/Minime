// Provider layer tests — fully offline. HTTP is captured via the FetchFn seam; no test
// ever reaches a real provider. Covers: factory validation, request shapes, the egress
// audit (I8 extension), and the CLOUD_MAX_TIER gate.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { replaceChunks } from "../src/db/repo";
import { anthropicProvider } from "../src/llm/anthropic";
import { bedrockProvider } from "../src/llm/bedrock";
import { mockEmbed } from "../src/llm/mock";
import { ollamaProvider } from "../src/llm/ollama";
import { openaiCompatProvider } from "../src/llm/openai-compat";
import { EMBED_DIMS } from "../src/llm/types";
import { resetDb, testSql as sql } from "./helpers";

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function fakeFetch(responder: (c: Captured) => unknown): { calls: Captured[]; fn: typeof fetch } {
  const calls: Captured[] = [];
  const fn = (async (url: any, init?: any) => {
    const captured: Captured = {
      url: String(url),
      headers: Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
      ),
      body: init?.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(captured);
    return new Response(JSON.stringify(responder(captured)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fn };
}

const ENV_KEYS = [
  "EMBED_PROVIDER",
  "CLASSIFY_PROVIDER",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "BEDROCK_MODEL",
  "AWS_ACCESS_KEY_ID",
  "CLOUD_MAX_TIER",
];
const saved = new Map<string, string | undefined>();
beforeAll(() => {
  for (const k of ENV_KEYS) saved.set(k, process.env[k]);
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// config.ts reads env at import; providers read from the config object. For validation
// tests we need fresh config values, so we test the provider constructors directly with
// patched config via env + module re-import where needed. The constructors read `config`
// (already imported), so for key-presence tests we patch the config object itself.
import { config } from "../src/util/config";

describe("factory validation", () => {
  test("anthropic without key refuses with the env var named", () => {
    const prev = config.anthropicApiKey;
    (config as any).anthropicApiKey = undefined;
    expect(() => anthropicProvider()).toThrow(/ANTHROPIC_API_KEY/);
    (config as any).anthropicApiKey = prev;
  });

  test("bedrock without model refuses and explains ids are not guessable", () => {
    const prev = config.bedrockModel;
    (config as any).bedrockModel = undefined;
    expect(() => bedrockProvider()).toThrow(/BEDROCK_MODEL/);
    (config as any).bedrockModel = prev;
  });

  test("anthropic cannot embed (no embeddings API)", () => {
    const prev = config.anthropicApiKey;
    (config as any).anthropicApiKey = "sk-ant-test";
    const p = anthropicProvider(fakeFetch(() => ({})).fn);
    expect(p.embed).toBeUndefined();
    (config as any).anthropicApiKey = prev;
  });

  test("openrouter embed requests dimensions=768 and rejects wrong-dim responses", async () => {
    const prev = config.openrouterApiKey;
    (config as any).openrouterApiKey = "or-test";
    const { calls, fn } = fakeFetch((c) => ({
      data: c.body.input.map((_: string, index: number) => ({
        index,
        embedding: new Array(EMBED_DIMS).fill(0.1),
      })),
    }));
    const p = openaiCompatProvider("openrouter", fn);
    const vecs = await p.embed!(["hello"]);
    expect(vecs[0]!.length).toBe(EMBED_DIMS);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(calls[0]!.body.model).toBe(config.openrouterEmbedModel);
    expect(calls[0]!.body.dimensions).toBe(768);

    // a model that ignores `dimensions` must fail loudly, never store wrong-dim vectors
    const bad = fakeFetch((c) => ({
      data: c.body.input.map((_: string, index: number) => ({
        index,
        embedding: new Array(4096).fill(0.1),
      })),
    }));
    const pBad = openaiCompatProvider("openrouter", bad.fn);
    await expect(pBad.embed!(["hello"])).rejects.toThrow(/4096 dims/);
    (config as any).openrouterApiKey = prev;
  });
});

describe("request shapes", () => {
  test("ollama embed batches via /api/embed", async () => {
    const { calls, fn } = fakeFetch((c) => ({
      embeddings: c.body.input.map(() => new Array(EMBED_DIMS).fill(0.1)),
    }));
    const p = ollamaProvider(fn);
    const texts = Array.from({ length: 40 }, (_, i) => `text ${i}`);
    const vecs = await p.embed!(texts);
    expect(vecs.length).toBe(40);
    expect(calls.length).toBe(2); // 32 + 8
    expect(calls[0]!.url).toContain("/api/embed");
    expect(calls[0]!.body.model).toBe(config.embedModel);
  });

  test("openai embed requests dimensions=768 with bearer auth", async () => {
    const prev = config.openaiApiKey;
    (config as any).openaiApiKey = "sk-test";
    const { calls, fn } = fakeFetch((c) => ({
      data: c.body.input.map((_: string, index: number) => ({
        index,
        embedding: new Array(EMBED_DIMS).fill(0.2),
      })),
    }));
    const p = openaiCompatProvider("openai", fn);
    const vecs = await p.embed!(["a", "b"]);
    expect(vecs.length).toBe(2);
    expect(vecs[0]!.length).toBe(EMBED_DIMS);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/embeddings");
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-test");
    expect(calls[0]!.body.dimensions).toBe(768);
    expect(calls[0]!.body.model).toBe(config.openaiEmbedModel);
    (config as any).openaiApiKey = prev;
  });

  test("openai/openrouter completeJson uses chat/completions with json_object format", async () => {
    const prev = config.openrouterApiKey;
    (config as any).openrouterApiKey = "or-test";
    const { calls, fn } = fakeFetch(() => ({
      choices: [{ message: { content: '{"type":"task","confidence":0.9,"fields":{}}' } }],
    }));
    const p = openaiCompatProvider("openrouter", fn);
    const raw = await p.completeJson("classify this");
    expect(JSON.parse(raw).type).toBe("task");
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]!.body.response_format.type).toBe("json_object");
    expect(calls[0]!.body.model).toBe(config.openrouterModel);
    expect(calls[0]!.body.temperature).toBe(0);
    (config as any).openrouterApiKey = prev;
  });

  test("anthropic completeJson posts to /v1/messages with the configured model", async () => {
    const prev = config.anthropicApiKey;
    (config as any).anthropicApiKey = "sk-ant-test";
    const { calls, fn } = fakeFetch(() => ({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: config.anthropicModel,
      content: [{ type: "text", text: '{"conflict": false}' }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const p = anthropicProvider(fn);
    const raw = await p.completeJson("do these conflict?");
    expect(JSON.parse(raw).conflict).toBe(false);
    expect(calls[0]!.url).toContain("/v1/messages");
    expect(calls[0]!.body.model).toBe(config.anthropicModel);
    expect(calls[0]!.body.max_tokens).toBe(512);
    (config as any).anthropicApiKey = prev;
  });
});

describe("egress audit + tier gate", () => {
  beforeAll(async () => {
    await resetDb();
  });

  test("cloud calls write egress events (counts, never contents)", async () => {
    const prevKey = config.openaiApiKey;
    const prevProv = config.embedProvider;
    (config as any).openaiApiKey = "sk-test";
    (config as any).embedProvider = "openai";
    const { fn } = fakeFetch((c) => ({
      data: c.body.input.map((_: string, index: number) => ({
        index,
        embedding: new Array(EMBED_DIMS).fill(0.3),
      })),
    }));
    const { embedProvider } = await import("../src/llm");
    const before = await sql`select count(*)::int as n from events where verb = 'egress:embed'`;
    await embedProvider(fn).embed!(["SECRET CONTENT must not appear in audit"]);
    const rows =
      await sql`select payload from events where verb = 'egress:embed' order by at desc limit 1`;
    const after = await sql`select count(*)::int as n from events where verb = 'egress:embed'`;
    expect(after[0]!.n).toBe(before[0]!.n + 1);
    expect(rows[0]!.payload.provider).toBe("openai");
    expect(rows[0]!.payload.items).toBe(1);
    expect(JSON.stringify(rows[0]!.payload)).not.toContain("SECRET CONTENT");
    (config as any).openaiApiKey = prevKey;
    (config as any).embedProvider = prevProv;
  });

  test("local ollama calls do not write egress events", async () => {
    const { fn } = fakeFetch((c) => ({
      embeddings: c.body.input.map(() => new Array(EMBED_DIMS).fill(0.1)),
    }));
    const { embedProvider } = await import("../src/llm");
    const before = await sql`select count(*)::int as n from events where verb like 'egress:%'`;
    await embedProvider(fn).embed!(["local text"]);
    const after = await sql`select count(*)::int as n from events where verb like 'egress:%'`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  test("CLOUD_MAX_TIER=1 keeps tier-2 chunks out of a cloud embed backlog", async () => {
    const { chunksMissingEmbedding } = await import("../src/db/repo");
    // two journal-ish chunks: tier 1 and tier 2, both unembedded
    const j1 =
      await sql`insert into journal_entries (entry_md, tier) values ('t1 probe', 1) returning id`;
    const j2 =
      await sql`insert into journal_entries (entry_md, tier) values ('t2 probe', 2) returning id`;
    await replaceChunks("journal", j1[0]!.id, ["tier one text"], 1);
    await replaceChunks("journal", j2[0]!.id, ["tier two text"], 2);

    const gated = await chunksMissingEmbedding(100, 1);
    const all = await chunksMissingEmbedding(100, 2);
    const gatedTexts = gated.map((c) => c.text);
    expect(gatedTexts).toContain("tier one text");
    expect(gatedTexts).not.toContain("tier two text");
    expect(all.map((c) => c.text)).toContain("tier two text");
  });
});

describe("mock embedding still deterministic after the move", () => {
  test("same text, same vector; dims pinned", () => {
    const a = mockEmbed("quokka");
    expect(a).toEqual(mockEmbed("quokka"));
    expect(a.length).toBe(EMBED_DIMS);
  });
});
