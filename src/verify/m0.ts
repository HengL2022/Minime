// make verify-m0: DB reachable, extensions present, and the configured LLM providers
// are usable — Ollama models listed for ollama-routed jobs (or mocked in CI), credentials
// present for cloud-routed jobs (no cloud network calls during verify).

import { closeDb, sql } from "../db/client";
import { classifyRouteForTier, validateProviderRoutes } from "../llm";
import { hasAwsCredentials } from "../llm/bedrock";
import { config } from "../util/config";

let failed = false;
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};

try {
  const [r] = await sql`select 1 as ok`;
  check("postgres reachable", r?.ok === 1, config.databaseUrl.replace(/:[^:@/]+@/, ":***@"));
  const exts = (await sql`select extname from pg_extension`).map((e: any) => e.extname);
  check("extension: vector", exts.includes("vector"));
  check("extension: pgcrypto", exts.includes("pgcrypto"));
} catch (e) {
  check("postgres reachable", false, e instanceof Error ? e.message : String(e));
}

// which provider does each job use, and is it locally checkable?
function cloudCredsOk(provider: string): [boolean, string] {
  switch (provider) {
    case "anthropic":
      return [Boolean(config.anthropicApiKey), `${config.anthropicModel} (ANTHROPIC_API_KEY)`];
    case "openai":
      return [Boolean(config.openaiApiKey), `${config.openaiModel} (OPENAI_API_KEY)`];
    case "openrouter":
      return [Boolean(config.openrouterApiKey), `${config.openrouterModel} (OPENROUTER_API_KEY)`];
    case "bedrock":
      return [
        Boolean(config.bedrockModel && hasAwsCredentials()),
        `${config.bedrockModel ?? "BEDROCK_MODEL unset"} (IAM via env or ~/.aws)`,
      ];
    default:
      return [false, `unknown provider '${provider}'`];
  }
}

const embedOk = ["ollama", "openai", "openrouter"].includes(config.embedProvider);
check(
  `embed provider: ${config.embedProvider}`,
  embedOk,
  embedOk ? undefined : "must be ollama, openai, or openrouter (768-dim capable)",
);

if (config.mockOllama) {
  check("llm providers", true, "mocked (MINIME_MOCK_OLLAMA=1)");
} else {
  let routesOk = true;
  try {
    validateProviderRoutes();
  } catch (e) {
    routesOk = false;
    check("provider routes valid", false, e instanceof Error ? e.message : String(e));
  }
  const jobs: [string, string][] = [["embed", config.embedProvider]];
  if (routesOk) {
    jobs.push(
      ["classify tier1", classifyRouteForTier(1)],
      ["classify tier2", classifyRouteForTier(2)],
    );
  }
  const needsOllama = new Set<string>();
  if (config.embedProvider === "ollama") needsOllama.add(config.embedModel);
  for (const [job, provider] of jobs)
    if (job.startsWith("classify") && provider === "ollama") needsOllama.add(config.classifyModel);

  if (needsOllama.size > 0) {
    try {
      const res = await fetch(`${config.ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      const tags = (await res.json()) as { models: { name: string }[] };
      const names = tags.models.map((m) => m.name);
      const has = (model: string) => names.some((n) => n === model || n.startsWith(`${model}:`));
      for (const model of needsOllama) check(`ollama model: ${model}`, has(model));
    } catch (e) {
      check("ollama reachable", false, e instanceof Error ? e.message : String(e));
    }
  }
  const embedModelFor: Record<string, string> = {
    openai: config.openaiEmbedModel,
    openrouter: config.openrouterEmbedModel,
  };
  for (const [job, provider] of jobs) {
    if (provider === "ollama") continue;
    const [ok, detail] = cloudCredsOk(provider);
    const shown =
      job === "embed" && embedModelFor[provider]
        ? detail.replace(/^[^ ]+/, embedModelFor[provider]!)
        : detail;
    check(`${job} provider: ${provider}`, ok, shown);
  }
}

await closeDb();
process.exit(failed ? 1 : 0);
