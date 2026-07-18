// W3 per-tier provider routing (improve-w3-provider-routing.md). Offline: resolution logic
// is pure config; provider-level tests inject fakeFetch; pipeline tests patch globalThis.fetch.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { classifyIsCloudForTier, classifyProviderForTier, classifyRouteForTier } from "../src/llm";
import { contradictionScan } from "../src/pipeline/dream";
import { compileNotes } from "../src/pipeline/notes";
import { config } from "../src/util/config";
import { resetDb, testSql } from "./helpers";

const saved = {
  classifyProvider: config.classifyProvider,
  cloudMaxTier: config.cloudMaxTier,
  r1: config.providerRouteTier1,
  r2: config.providerRouteTier2,
  openrouterApiKey: config.openrouterApiKey,
  mockOllama: config.mockOllama,
};
afterEach(() => {
  config.classifyProvider = saved.classifyProvider;
  config.cloudMaxTier = saved.cloudMaxTier;
  config.providerRouteTier1 = saved.r1;
  config.providerRouteTier2 = saved.r2;
  config.openrouterApiKey = saved.openrouterApiKey;
  config.mockOllama = saved.mockOllama;
  Reflect.deleteProperty(process.env, "PROVIDER_ROUTE_TIER0");
});

describe("classifyRouteForTier resolution", () => {
  test("no routes set → CLASSIFY_PROVIDER for both tiers (legacy)", () => {
    config.classifyProvider = "bedrock";
    config.providerRouteTier1 = undefined;
    config.providerRouteTier2 = undefined;
    expect(classifyRouteForTier(1)).toBe("bedrock");
    expect(classifyRouteForTier(2)).toBe("bedrock");
  });

  test("tier-2 route overrides only tier 2", () => {
    config.classifyProvider = "bedrock";
    config.providerRouteTier2 = "ollama";
    expect(classifyRouteForTier(2)).toBe("ollama");
    expect(classifyRouteForTier(1)).toBe("bedrock");
    expect(classifyIsCloudForTier(2)).toBe(false);
    expect(classifyIsCloudForTier(1)).toBe(true);
  });

  test("cloud route above CLOUD_MAX_TIER is a loud config error, not a silent send", () => {
    config.cloudMaxTier = 1;
    config.providerRouteTier2 = "bedrock";
    expect(() => classifyRouteForTier(2)).toThrow(/stricter/);
  });

  test("local route above the ceiling is fine (stricter is allowed)", () => {
    config.cloudMaxTier = 1;
    config.providerRouteTier2 = "ollama";
    expect(classifyRouteForTier(2)).toBe("ollama");
  });

  test("PROVIDER_ROUTE_TIER0 rejected unless the literal 'none'", () => {
    process.env.PROVIDER_ROUTE_TIER0 = "ollama";
    expect(() => classifyRouteForTier(1)).toThrow(/tier-0/);
    process.env.PROVIDER_ROUTE_TIER0 = "none";
    expect(classifyRouteForTier(1)).toBe(config.classifyProvider);
  });

  test("unknown provider name in a route throws with the valid list", () => {
    config.providerRouteTier1 = "gpt5" as never;
    expect(() => classifyRouteForTier(1)).toThrow(/ollama\|anthropic\|openai\|openrouter\|bedrock/);
  });
});

type Captured = { url: string; body: any };
function fakeFetch(responder: (c: Captured) => unknown): { calls: Captured[]; fn: typeof fetch } {
  const calls: Captured[] = [];
  const fn = (async (url: any, init?: any) => {
    const captured: Captured = {
      url: String(url),
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

describe("egress audit route_tier", () => {
  beforeAll(async () => {
    await resetDb();
  });

  test("cloud classify via a tier route stamps route_tier; payload never contains the prompt", async () => {
    config.openrouterApiKey = "test-key";
    config.providerRouteTier1 = "openrouter";
    const { fn } = fakeFetch(() => ({ choices: [{ message: { content: '{"ok":true}' } }] }));
    await classifyProviderForTier(1, fn).completeJson("TIER1 SECRET PROMPT");
    const rows = await testSql`select payload from events where verb = 'egress:classify'`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.payload.route_tier).toBe(1);
    expect(rows[0]!.payload.provider).toBe("openrouter");
    expect(JSON.stringify(rows[0]!.payload)).not.toContain("SECRET");
  });

  test("local route writes zero egress rows", async () => {
    config.providerRouteTier2 = "ollama";
    const { fn } = fakeFetch(() => ({ response: '{"ok":true}' }));
    const before = await testSql`select count(*)::int as n from events where verb like 'egress:%'`;
    await classifyProviderForTier(2, fn).completeJson("journal text");
    const after = await testSql`select count(*)::int as n from events where verb like 'egress:%'`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});

/** Patch fetch: localhost Ollama gets a canned answer; ANY other host trips the leak wire. */
function patchFetch(ollamaResponder: () => unknown) {
  const real = globalThis.fetch;
  const cloudCalls: string[] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.startsWith(config.ollamaUrl))
      return new Response(JSON.stringify(ollamaResponder()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    cloudCalls.push(u);
    throw new Error(`LEAK: unexpected non-local egress to ${u}`);
  }) as typeof fetch;
  return {
    cloudCalls,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

describe("notes distillation per-tier routing", () => {
  test("tier-2 sources + PROVIDER_ROUTE_TIER2=ollama → distilled locally, all chunks in prompt, zero egress", async () => {
    await resetDb();
    // Seed a person with 3 mentioning chunks, one of them tier 2 (same shape as m9.notes tests):
    const [p] =
      await testSql`insert into people (canonical_name, tier) values ('Nadia Rossi', 1) returning id`;
    for (const [i, tier] of [1, 1, 2].entries()) {
      const [pg] = await testSql`insert into pages (path, title, body_md, content_hash, tier)
        values (${`t/${i}.md`}, ${`T${i}`}, 'Nadia Rossi built the koi pond filter.', ${`h${i}`}, ${tier}) returning id`;
      await testSql`insert into chunks (parent_type, parent_id, ord, text, tier)
        values ('page', ${pg!.id}, 0, ${`Nadia Rossi built the koi pond filter. Sentence ${i}`}, ${tier})`;
      await testSql`insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
        values ('page', ${pg!.id}, 'mentions', 'person', ${p!.id}, 'pages', ${pg!.id}, 'system:extract')`;
    }
    config.mockOllama = false; // exercise the real modelDistill path
    // Cloud default that must NOT be reached. openrouter (not bedrock): it constructs with
    // any truthy key, so un-routed code genuinely reaches the patched fetch and trips the
    // leak wire — bedrock would throw at construction (no BEDROCK_MODEL offline) and the
    // heuristic fallback would mask the leak, making the tripwire inert.
    config.classifyProvider = "openrouter";
    config.openrouterApiKey = "test-key";
    config.providerRouteTier2 = "ollama";
    const patched = patchFetch(() => ({
      response: JSON.stringify({ note: "Nadia Rossi: koi pond filter builder." }),
    }));
    try {
      const res = await compileNotes();
      expect(res.compiled).toBeGreaterThanOrEqual(1);
      expect(patched.cloudCalls).toEqual([]);
      const egress =
        await testSql`select count(*)::int as n from events where verb like 'egress:%'`;
      expect(egress[0]!.n).toBe(0);
      const [note] = await testSql`select tier, body_md from pages where source = 'dream:notes'`;
      expect(note!.tier).toBe(2); // tier = max(sources), unchanged by routing
    } finally {
      patched.restore();
      config.mockOllama = true;
    }
  });
});

describe("contradiction scan per-tier routing", () => {
  test("tier-2 pair + local tier-2 route is scanned locally (was: skipped when cloud+ceiling)", async () => {
    await resetDb();
    const [p] =
      await testSql`insert into people (canonical_name, tier) values ('Old Cat', 1) returning id`;
    const mk = async (i: number, text: string) => {
      const [pg] = await testSql`insert into pages (path, title, body_md, content_hash, tier)
        values (${`c/${i}.md`}, ${`C${i}`}, ${text}, ${`ch${i}`}, 2) returning id`;
      const [ch] = await testSql`insert into chunks (parent_type, parent_id, ord, text, tier)
        values ('page', ${pg!.id}, 0, ${text}, 2) returning id`;
      // pair query joins mentions edges anchored at chunks (see repo.chunkPairsSharingPerson)
      await testSql`insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
        values ('page', ${pg!.id}, 'mentions', 'person', ${p!.id}, 'chunks', ${ch!.id}, 'system:extract')`;
    };
    await mk(1, "Old Cat always eats at dawn.");
    await mk(2, "Old Cat never eats at dawn.");
    config.mockOllama = false;
    config.classifyProvider = "bedrock";
    config.cloudMaxTier = 1; // legacy behavior: tier-2 pair would be SKIPPED
    config.providerRouteTier2 = "ollama"; // W3: now scanned locally instead
    const patched = patchFetch(() => ({ response: '{"conflict": true}' }));
    try {
      const flagged = await contradictionScan();
      expect(flagged).toBe(1);
      expect(patched.cloudCalls).toEqual([]);
      const q =
        await testSql`select count(*)::int as n from review_queue where kind = 'contradiction'`;
      expect(q[0]!.n).toBe(1);
    } finally {
      patched.restore();
      config.mockOllama = true;
      config.cloudMaxTier = saved.cloudMaxTier;
    }
  });
});
