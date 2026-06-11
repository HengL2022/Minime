// All configuration comes from env with spec §6 defaults; .env loading is Bun-native.

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export type ProviderName = "ollama" | "anthropic" | "openai" | "openrouter" | "bedrock";

export const config = {
  databaseUrl: env("DATABASE_URL", "postgres://minime:minime@localhost:5432/minime"),
  ollamaUrl: env("OLLAMA_URL", "http://localhost:11434"),
  embedModel: env("EMBED_MODEL", "nomic-embed-text"),
  classifyModel: env("CLASSIFY_MODEL", "llama3.1:8b"),
  // LLM provider routing (I1 amendment, owner-approved — see DECISIONS.md 2026-06-11):
  // embeddings: ollama | openai (768-dim constraint); classify/scan: any provider below.
  embedProvider: env("EMBED_PROVIDER", "ollama") as ProviderName,
  classifyProvider: env("CLASSIFY_PROVIDER", "ollama") as ProviderName,
  // tier ceiling for content sent to CLOUD providers (tier 0 content is never sent
  // anywhere by construction — it is never chunked, classified, or scanned)
  cloudMaxTier: Number(env("CLOUD_MAX_TIER", "2")),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  anthropicModel: env("ANTHROPIC_MODEL", "claude-opus-4-8"),
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiBaseUrl: env("OPENAI_BASE_URL", "https://api.openai.com/v1"),
  openaiModel: env("OPENAI_MODEL", "gpt-4o-mini"),
  openaiEmbedModel: env("OPENAI_EMBED_MODEL", "text-embedding-3-small"),
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
  openrouterBaseUrl: env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
  openrouterModel: env("OPENROUTER_MODEL", "openai/gpt-4o-mini"),
  bedrockModel: process.env.BEDROCK_MODEL, // required for bedrock; ids aren't guessable
  tz: env("TZ", "Asia/Singapore"),
  tier2UnlockMaxMinutes: Number(env("TIER2_UNLOCK_MAX_MINUTES", "60")),
  resticRepository: process.env.RESTIC_REPOSITORY,
  resticPasswordFile: process.env.RESTIC_PASSWORD_FILE,
  dreamCron: env("DREAM_CRON", "0 3 * * *"),
  dataDir: env("MINIME_DATA_DIR", `${process.cwd()}/data`),
  // CI/tests run fully offline (I1): deterministic embeddings + heuristic classifier.
  mockOllama: process.env.MINIME_MOCK_OLLAMA === "1",
};
