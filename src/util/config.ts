// All configuration comes from env with spec §6 defaults.
//
// Bun auto-loads .env, but only from the *process cwd*. When `serve` is launched from a
// directory other than the repo root (e.g. an MCP host runs `bun run /path/Minime/src/cli.ts`
// with its own cwd), that .env is never read — so RESTIC_*, BACKUP_CRON, provider keys, etc.
// silently fall back to defaults and features like the 15-min db snapshot quietly disable.
// loadRepoDotenv() closes that gap by reading the repo-root .env as a *fallback*: it never
// overrides a var the caller already set, and is skipped under tests so the suite stays
// hermetic (the dev repo has its own .env we must not leak into bun test).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

// Parse a minimal KEY=VALUE .env (comments, blank lines, `export ` prefix, surrounding
// quotes). Intentionally simple — not a full dotenv: no interpolation or multiline values,
// none of which Minime's .env uses. Pure (no side effects) so it is unit-testable.
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// Fill only keys absent from `target` — a caller-provided var always wins. Pure given its
// args (mutates `target` in place); unit-testable against a plain object.
export function fillMissingEnv(parsed: Record<string, string>, target: NodeJS.ProcessEnv): void {
  for (const [k, v] of Object.entries(parsed)) {
    if (!(k in target)) target[k] = v;
  }
}

function loadRepoDotenv(): void {
  if (process.env.NODE_ENV === "test" || process.env.MINIME_SKIP_REPO_DOTENV === "1") return;
  try {
    // src/util/config.ts → repo root is two directories up.
    const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");
    if (!existsSync(envPath)) return;
    fillMissingEnv(parseDotenv(readFileSync(envPath, "utf8")), process.env);
  } catch {
    // best-effort: a missing/unreadable/malformed .env must never block startup.
  }
}

// Must run before the config object below reads process.env.
loadRepoDotenv();

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
  // verified live: OpenRouter /embeddings honors dimensions=768 for this model (MRL)
  openrouterEmbedModel: env("OPENROUTER_EMBED_MODEL", "qwen/qwen3-embedding-8b"),
  bedrockModel: process.env.BEDROCK_MODEL, // required for bedrock; ids aren't guessable
  tz: env("TZ", "Asia/Singapore"),
  tier2UnlockMaxMinutes: Number(env("TIER2_UNLOCK_MAX_MINUTES", "60")),
  resticRepository: process.env.RESTIC_REPOSITORY,
  resticPasswordFile: process.env.RESTIC_PASSWORD_FILE,
  dreamCron: env("DREAM_CRON", "0 3 * * *"),
  // frequent logical DB snapshots (db-snap tag); empty string disables the cron
  backupCron: env("BACKUP_CRON", "*/15 * * * *"),
  dataDir: env("MINIME_DATA_DIR", `${process.cwd()}/data`),
  // Optional LOCAL cross-encoder reranker (llama-server --rerank). Unset = stage disabled.
  // Localhost-only by construction (I1): src/search/rerank.ts refuses non-local hosts.
  rerankUrl: process.env.RERANK_URL, // e.g. http://localhost:8114
  rerankModel: env("RERANK_MODEL", "bge-reranker-v2-m3"),
  rerankTopIn: ((n) => (Number.isInteger(n) && n > 0 ? n : 20))(Number(env("RERANK_TOP_IN", "20"))),
  // CI/tests run fully offline (I1): deterministic embeddings + heuristic classifier.
  mockOllama: process.env.MINIME_MOCK_OLLAMA === "1",
};
