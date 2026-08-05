// All configuration comes from env with spec §6 defaults.
//
// Bun auto-loads .env, but only from the *process cwd*. When `serve` is launched from a
// directory other than the repo root (e.g. an MCP host runs `bun run /path/Minime/src/cli.ts`
// with its own cwd), that .env is never read — so RESTIC_*, BACKUP_CRON, provider keys, etc.
// silently fall back to defaults and features like the 15-min db snapshot quietly disable.
// loadRepoDotenv() closes that gap by reading the repo-root .env as a *fallback*: it never
// overrides a var the caller already set, and is skipped under tests so the suite stays
// hermetic (the dev repo has its own .env we must not leak into bun test).

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."));
export const DB_DUMP_DIR = resolve(REPO_ROOT, "db-dump");

export function resolveDataDir(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return resolve(REPO_ROOT, "data");
  return isAbsolute(trimmed) ? normalize(trimmed) : resolve(REPO_ROOT, trimmed);
}

export type PrivateDumpDirRule =
  | "symlink"
  | "not_directory"
  | "not_canonical"
  | "mode"
  | "filesystem";

export class PrivateDumpDirError extends Error {
  constructor(readonly rule: PrivateDumpDirRule) {
    super(`private dump root rejected (${rule})`);
  }
}

export async function ensurePrivateDumpDir(path: string): Promise<void> {
  const intended = resolve(path);
  const parent = dirname(intended);
  let component = parent;
  while (true) {
    let parentStat: Awaited<ReturnType<typeof lstat>>;
    try {
      parentStat = await lstat(component);
    } catch {
      throw new PrivateDumpDirError("filesystem");
    }
    if (parentStat.isSymbolicLink()) throw new PrivateDumpDirError("symlink");
    if (!parentStat.isDirectory()) throw new PrivateDumpDirError("not_directory");
    const next = dirname(component);
    if (next === component) break;
    component = next;
  }
  try {
    if ((await realpath(parent)) !== parent) throw new PrivateDumpDirError("not_canonical");
  } catch (error) {
    throw error instanceof PrivateDumpDirError ? error : new PrivateDumpDirError("filesystem");
  }

  let initial: Awaited<ReturnType<typeof lstat>>;
  try {
    initial = await lstat(intended);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new PrivateDumpDirError("filesystem");
    try {
      await mkdir(intended, { mode: 0o700 });
    } catch {
      throw new PrivateDumpDirError("filesystem");
    }
    try {
      initial = await lstat(intended);
    } catch {
      throw new PrivateDumpDirError("filesystem");
    }
  }
  if (initial.isSymbolicLink()) throw new PrivateDumpDirError("symlink");
  if (!initial.isDirectory()) throw new PrivateDumpDirError("not_directory");
  if ((initial.mode & 0o777) !== 0o700) throw new PrivateDumpDirError("mode");

  let finalCheck: Awaited<ReturnType<typeof lstat>>;
  try {
    finalCheck = await lstat(intended);
  } catch {
    throw new PrivateDumpDirError("filesystem");
  }
  if (finalCheck.isSymbolicLink() || !finalCheck.isDirectory())
    throw new PrivateDumpDirError(finalCheck.isSymbolicLink() ? "symlink" : "not_directory");
  try {
    if ((await realpath(intended)) !== intended) throw new PrivateDumpDirError("not_canonical");
  } catch (error) {
    throw error instanceof PrivateDumpDirError ? error : new PrivateDumpDirError("filesystem");
  }
  let lastCheck: Awaited<ReturnType<typeof lstat>>;
  try {
    lastCheck = await lstat(intended);
  } catch {
    throw new PrivateDumpDirError("filesystem");
  }
  if (lastCheck.isSymbolicLink() || !lastCheck.isDirectory())
    throw new PrivateDumpDirError(lastCheck.isSymbolicLink() ? "symlink" : "not_directory");
  if ((lastCheck.mode & 0o777) !== 0o700) throw new PrivateDumpDirError("mode");
}

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

// Parse a minimal KEY=VALUE .env (full-line comments, unquoted-inline ` #` comments, blank
// lines, `export ` prefix, surrounding quotes). Intentionally simple — not a full dotenv: no
// interpolation or multiline values, none of which Minime's .env uses. Pure (no side effects)
// so it is unit-testable.
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
    } else {
      // Bun's own .env loader drops a ` # comment` tail on unquoted values; this fallback
      // must agree or the same .env means different things depending on launch cwd. It
      // didn't until 2026-07-18: `CLOUD_MAX_TIER=2  # note` kept the tail here, Number()
      // made it NaN, and `tier > NaN` being false silently opened the egress ceiling
      // (invariant review B1). Hash without preceding whitespace stays part of the value.
      const hash = val.search(/\s#/);
      if (hash >= 0) val = val.slice(0, hash).trimEnd();
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
    const envPath = resolve(REPO_ROOT, ".env");
    if (!existsSync(envPath)) return;
    fillMissingEnv(parseDotenv(readFileSync(envPath, "utf8")), process.env);
  } catch {
    // best-effort: a missing/unreadable/malformed .env must never block startup.
  }
}

// Must run before the config object below reads process.env.
loadRepoDotenv();

const databaseUrl = env("DATABASE_URL", "postgres://minime:minime@localhost:5432/minime");
// DATABASE_URL remains the owner/control-plane DSN for migrations and maintenance.  The
// restricted runtime role is cut over independently by the installer. One-shot owner commands
// may use this fallback; resident `serve` refuses to start until the app endpoint is provisioned.
const runtimeDatabaseUrl = env("MINIME_APP_DATABASE_URL", databaseUrl);

export type ProviderName = "ollama" | "anthropic" | "openai" | "openrouter" | "bedrock";

// "" and unset both mean "no route". Name validation happens in src/llm/index.ts so a typo
// fails loudly at first resolution, not silently at parse time.
function routeEnv(name: string): ProviderName | undefined {
  const v = process.env[name]?.trim();
  return v ? (v as ProviderName) : undefined;
}

export const config = {
  databaseUrl,
  runtimeDatabaseUrl,
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
  // Per-tier classify routing (W3, DECISIONS.md 2026-07): optional stricter-only overrides of
  // CLASSIFY_PROVIDER per content tier. Tier 0 is never classified and has no route.
  providerRouteTier1: routeEnv("PROVIDER_ROUTE_TIER1"),
  providerRouteTier2: routeEnv("PROVIDER_ROUTE_TIER2"),
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
  dataDir: resolveDataDir(process.env.MINIME_DATA_DIR),
  // Optional LOCAL cross-encoder reranker (llama-server --rerank). Unset = stage disabled.
  // Localhost-only by construction (I1): src/search/rerank.ts refuses non-local hosts.
  rerankUrl: process.env.RERANK_URL, // e.g. http://localhost:8114
  rerankModel: env("RERANK_MODEL", "bge-reranker-v2-m3"),
  rerankTopIn: ((n) => (Number.isInteger(n) && n > 0 ? n : 20))(Number(env("RERANK_TOP_IN", "20"))),
  // CI/tests run fully offline (I1): deterministic embeddings + heuristic classifier.
  mockOllama: process.env.MINIME_MOCK_OLLAMA === "1",
};
