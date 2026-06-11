// make verify-m0: DB reachable, extensions present, and the configured LLM providers
// are usable — Ollama models listed for ollama-routed jobs (or mocked in CI), credentials
// present for cloud-routed jobs (no cloud network calls during verify).

import { closeDb, sql } from "../db/client";
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
        Boolean(config.bedrockModel && (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE)),
        `${config.bedrockModel ?? "BEDROCK_MODEL unset"} (AWS credentials)`,
      ];
    default:
      return [false, `unknown provider '${provider}'`];
  }
}

const embedOk = ["ollama", "openai"].includes(config.embedProvider);
check(
  `embed provider: ${config.embedProvider}`,
  embedOk,
  embedOk ? undefined : "must be ollama or openai (768-dim)",
);

if (config.mockOllama) {
  check("llm providers", true, "mocked (MINIME_MOCK_OLLAMA=1)");
} else {
  const needsOllama: string[] = [];
  if (config.embedProvider === "ollama") needsOllama.push(config.embedModel);
  if (config.classifyProvider === "ollama") needsOllama.push(config.classifyModel);

  if (needsOllama.length > 0) {
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
  for (const [job, provider] of [
    ["embed", config.embedProvider],
    ["classify", config.classifyProvider],
  ] as const) {
    if (provider === "ollama") continue;
    const [ok, detail] = cloudCredsOk(provider);
    check(`${job} provider: ${provider}`, ok, detail);
  }
}

await closeDb();
process.exit(failed ? 1 : 0);
