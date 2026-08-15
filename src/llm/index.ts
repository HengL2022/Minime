// Provider factories + the egress audit. Cloud calls write an events row (provider,
// model, item count — never contents) so `minime audit` shows exactly what left the box.

import { logEgressIntent, logEgressOutcome } from "../db/repo";
import { type ProviderName, config } from "../util/config";
import { anthropicProvider } from "./anthropic";
import { bedrockProvider } from "./bedrock";
import { ollamaProvider } from "./ollama";
import { openaiCompatProvider } from "./openai-compat";
import type { FetchFn, LlmProvider } from "./types";

const EMBED_CAPABLE =
  "embeddings require a 768-dim model: EMBED_PROVIDER must be 'ollama' (nomic-embed-text), 'openai' (text-embedding-3-*), or 'openrouter' (a dimensions-capable model, e.g. qwen/qwen3-embedding-8b); anthropic has no embeddings API and Bedrock Titan cannot emit 768 dims";

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

const PROVIDER_NAMES: readonly ProviderName[] = [
  "ollama",
  "anthropic",
  "openai",
  "openrouter",
  "bedrock",
];

function providerIsCloud(name: ProviderName): boolean {
  return name !== "ollama";
}

export type ClassifyTier = 1 | 2;

/** W3 routing: which provider classifies content of this tier. Fallback chain:
 * PROVIDER_ROUTE_TIER<t> → CLASSIFY_PROVIDER. Routes may only be STRICTER than
 * CLOUD_MAX_TIER — an explicit cloud route above the ceiling throws (fail loud, never send).
 * Tier-0 content is never classified (I3), so a tier-0 route is rejected outright. */
export function classifyRouteForTier(tier: ClassifyTier): ProviderName {
  // Fail closed on a malformed ceiling: `tier > NaN` is false, so a NaN CLOUD_MAX_TIER
  // (e.g. a mistyped .env value) would otherwise wave every cloud route straight past the
  // stricter-only check, validateProviderRoutes, m0, and the dream gate (review B1).
  if (!Number.isInteger(config.cloudMaxTier) || config.cloudMaxTier < 0 || config.cloudMaxTier > 2)
    throw new Error(
      `CLOUD_MAX_TIER must be an integer 0, 1, or 2 — parsed '${config.cloudMaxTier}' from the environment`,
    );
  const t0 = process.env.PROVIDER_ROUTE_TIER0;
  if (t0 && t0 !== "none")
    throw new Error(
      "PROVIDER_ROUTE_TIER0 is not configurable: tier-0 content is never classified (I3)",
    );
  const route = tier === 2 ? config.providerRouteTier2 : config.providerRouteTier1;
  if (route && !PROVIDER_NAMES.includes(route))
    throw new Error(
      `PROVIDER_ROUTE_TIER${tier}='${route}' unknown (ollama|anthropic|openai|openrouter|bedrock)`,
    );
  if (route && providerIsCloud(route) && tier > config.cloudMaxTier)
    throw new Error(
      `PROVIDER_ROUTE_TIER${tier}=${route} is a cloud provider but CLOUD_MAX_TIER=` +
        `${config.cloudMaxTier} forbids tier-${tier} egress — routes may only be stricter than the ceiling`,
    );
  return route ?? config.classifyProvider;
}

export function classifyProviderForTier(tier: ClassifyTier, fetchFn?: FetchFn): LlmProvider {
  const providerName = classifyRouteForTier(tier);
  if (providerIsCloud(providerName) && tier > config.cloudMaxTier)
    throw new Error(
      `effective classify provider '${providerName}' is a cloud provider but CLOUD_MAX_TIER=` +
        `${config.cloudMaxTier} forbids tier-${tier} egress`,
    );
  return withEgressAudit(build(providerName, fetchFn), tier);
}

export function classifyIsCloudForTier(tier: ClassifyTier): boolean {
  return providerIsCloud(classifyRouteForTier(tier));
}

/** Startup validation resolves explicit routes and their constraints. An implicit cloud
 * fallback above the ceiling remains a supported degraded configuration: each effective
 * job is rejected by classifyProviderForTier before provider construction, audit, or fetch. */
export function validateProviderRoutes(): void {
  classifyRouteForTier(1);
  classifyRouteForTier(2);
  describeRouteForTier(1);
  describeRouteForTier(2);
}

/** W6: images default to the content tier of the capture (photo/receipt→2).
 * VLM_ROUTE_TIER* may only name ollama — cloud vision is not implemented. */
export function describeRouteForTier(tier: ClassifyTier): ProviderName {
  if (!Number.isInteger(config.cloudMaxTier) || config.cloudMaxTier < 0 || config.cloudMaxTier > 2)
    throw new Error(
      `CLOUD_MAX_TIER must be an integer 0, 1, or 2 — parsed '${config.cloudMaxTier}' from the environment`,
    );
  const route = tier === 2 ? config.vlmRouteTier2 : config.vlmRouteTier1;
  if (route && !PROVIDER_NAMES.includes(route))
    throw new Error(
      `VLM_ROUTE_TIER${tier}='${route}' unknown (ollama|anthropic|openai|openrouter|bedrock)`,
    );
  if (route && providerIsCloud(route))
    throw new Error(
      `VLM_ROUTE_TIER${tier}=${route} is not supported: describe is local-only (ollama)`,
    );
  return route ?? "ollama";
}

export function describeProviderForTier(tier: ClassifyTier, fetchFn?: FetchFn): LlmProvider {
  const providerName = describeRouteForTier(tier);
  return withEgressAudit(build(providerName, fetchFn), tier);
}

function withEgressAudit(p: LlmProvider, routeTier?: number): LlmProvider {
  if (!p.isCloud) return p;
  const auditedCall = async <T>(
    kind: "embed" | "classify" | "describe",
    model: string,
    items: number,
    work: () => Promise<T>,
  ): Promise<T> => {
    const intentEventId = await logEgressIntent({
      kind,
      provider: p.name as ProviderName,
      model,
      items,
      ...(routeTier === 1 || routeTier === 2 ? { routeTier } : {}),
    });
    let result: T;
    try {
      result = await work();
    } catch (error) {
      try {
        await logEgressOutcome({ kind, intentEventId, status: "failed" });
      } catch {
        throw new Error("egress_outcome_audit_failed");
      }
      throw error;
    }
    try {
      await logEgressOutcome({ kind, intentEventId, status: "succeeded" });
    } catch {
      throw new Error("egress_outcome_audit_failed");
    }
    return result;
  };
  return {
    ...p,
    embed: p.embed
      ? async (texts) =>
          auditedCall("embed", p.embedModel ?? p.model, texts.length, () => p.embed!(texts))
      : undefined,
    completeJson: async (prompt) =>
      auditedCall("classify", p.model, 1, () => p.completeJson(prompt)),
    describe: p.describe
      ? async (image, prompt) =>
          auditedCall("describe", p.vlmModel ?? p.model, 1, () => p.describe!(image, prompt))
      : undefined,
  };
}

export function embedProvider(fetchFn?: FetchFn): LlmProvider {
  const p = withEgressAudit(build(config.embedProvider, fetchFn));
  if (!p.embed)
    throw new Error(`EMBED_PROVIDER=${config.embedProvider} cannot embed — ${EMBED_CAPABLE}`);
  return p;
}

/** scripts/eval-only entry point — pipeline code must use classifyProviderForTier
 * (tier routing bypassed here). */
export function classifyProvider(fetchFn?: FetchFn): LlmProvider {
  return withEgressAudit(build(config.classifyProvider, fetchFn));
}

export function embedIsCloud(): boolean {
  return config.embedProvider !== "ollama";
}

/** The model name stamped on chunks.embed_model (changing it implies a re-embed). */
export function embedModelName(): string {
  switch (config.embedProvider) {
    case "openai":
      return config.openaiEmbedModel;
    case "openrouter":
      return config.openrouterEmbedModel;
    default:
      return config.embedModel;
  }
}

/** scripts/eval-only entry point — pipeline code must use classifyIsCloudForTier
 * (tier routing bypassed here). */
export function classifyIsCloud(): boolean {
  return config.classifyProvider !== "ollama";
}
