// W3 per-tier provider routing (improve-w3-provider-routing.md). Offline: resolution logic
// is pure config; provider-level tests inject fakeFetch; pipeline tests patch globalThis.fetch.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { classifyIsCloudForTier, classifyRouteForTier } from "../src/llm";
import { config } from "../src/util/config";

const saved = {
  classifyProvider: config.classifyProvider,
  cloudMaxTier: config.cloudMaxTier,
  r1: config.providerRouteTier1,
  r2: config.providerRouteTier2,
};
afterEach(() => {
  config.classifyProvider = saved.classifyProvider;
  config.cloudMaxTier = saved.cloudMaxTier;
  config.providerRouteTier1 = saved.r1;
  config.providerRouteTier2 = saved.r2;
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
