// W3 per-tier provider routing (improve-w3-provider-routing.md). Offline: resolution logic
// is pure config; provider-level tests inject fakeFetch; pipeline tests patch globalThis.fetch.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { classifyIsCloudForTier, classifyProviderForTier, classifyRouteForTier } from "../src/llm";
import { config } from "../src/util/config";
import { resetDb, testSql } from "./helpers";

const saved = {
  classifyProvider: config.classifyProvider,
  cloudMaxTier: config.cloudMaxTier,
  r1: config.providerRouteTier1,
  r2: config.providerRouteTier2,
  openrouterApiKey: config.openrouterApiKey,
};
afterEach(() => {
  config.classifyProvider = saved.classifyProvider;
  config.cloudMaxTier = saved.cloudMaxTier;
  config.providerRouteTier1 = saved.r1;
  config.providerRouteTier2 = saved.r2;
  config.openrouterApiKey = saved.openrouterApiKey;
  delete process.env.PROVIDER_ROUTE_TIER0;
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
