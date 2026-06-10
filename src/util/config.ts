// All configuration comes from env with spec §6 defaults; .env loading is Bun-native.

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  databaseUrl: env("DATABASE_URL", "postgres://minime:minime@localhost:5432/minime"),
  ollamaUrl: env("OLLAMA_URL", "http://localhost:11434"),
  embedModel: env("EMBED_MODEL", "nomic-embed-text"),
  classifyModel: env("CLASSIFY_MODEL", "llama3.1:8b"),
  tz: env("TZ", "Asia/Singapore"),
  tier2UnlockMaxMinutes: Number(env("TIER2_UNLOCK_MAX_MINUTES", "60")),
  resticRepository: process.env.RESTIC_REPOSITORY,
  resticPasswordFile: process.env.RESTIC_PASSWORD_FILE,
  dreamCron: env("DREAM_CRON", "0 3 * * *"),
  dataDir: env("MINIME_DATA_DIR", `${process.cwd()}/data`),
  // CI/tests run fully offline (I1): deterministic embeddings + heuristic classifier.
  mockOllama: process.env.MINIME_MOCK_OLLAMA === "1",
};
