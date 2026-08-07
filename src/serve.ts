import { join } from "node:path";
import { Cron } from "croner";
import { withAdminDbScope } from "./db/client";
import { dbSnapshot } from "./pipeline/backup";
import { dream } from "./pipeline/dream";
import { REPO_ROOT, config, parseProviderEnvironment } from "./util/config";
import { parseLocalPostgresUrl } from "./util/postgres-url";

const RUNTIME_SETTING_ENV = new Set([
  "ANTHROPIC_MODEL",
  "BEDROCK_MODEL",
  "CLASSIFY_MODEL",
  "CLASSIFY_PROVIDER",
  "CLOUD_MAX_TIER",
  "DATABASE_URL",
  "EMBED_MODEL",
  "EMBED_PROVIDER",
  "MINIME_APP_DATABASE_URL",
  "MINIME_DATA_DIR",
  "MINIME_RUNTIME_CHILD",
  "MINIME_SKIP_REPO_DOTENV",
  "OLLAMA_URL",
  "OPENAI_BASE_URL",
  "OPENAI_EMBED_MODEL",
  "OPENAI_MODEL",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_EMBED_MODEL",
  "OPENROUTER_MODEL",
  "PROVIDER_ROUTE_TIER1",
  "PROVIDER_ROUTE_TIER2",
  "RERANK_MODEL",
  "RERANK_TOP_IN",
  "RERANK_URL",
  "TIER2_UNLOCK_MAX_MINUTES",
]);
const RUNTIME_OS_ENV = new Set(["LANG", "LC_ALL", "PATH", "TMPDIR", "TZ"]);
const PROVIDER_CREDENTIAL_ENV: Record<string, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  bedrock: ["BEDROCK_AWS_ACCESS_KEY_ID", "BEDROCK_AWS_SECRET_ACCESS_KEY", "BEDROCK_AWS_REGION"],
};
const OPTIONAL_PROVIDER_CREDENTIAL_ENV: Record<string, readonly string[]> = {
  bedrock: ["BEDROCK_AWS_SESSION_TOKEN"],
};

function cloudMaxTier(source: NodeJS.ProcessEnv): number {
  const tier = Number(source.CLOUD_MAX_TIER ?? "2");
  if (!Number.isInteger(tier) || tier < 0 || tier > 2) {
    throw new Error("runtime_child_boundary_invalid");
  }
  return tier;
}

function selectedProviders(source: NodeJS.ProcessEnv): Set<string> {
  let providers: ReturnType<typeof parseProviderEnvironment>;
  try {
    providers = parseProviderEnvironment(source);
  } catch {
    throw new Error("runtime_child_boundary_invalid");
  }
  if (source.NODE_ENV === "test" && source.MINIME_MOCK_OLLAMA === "1") {
    return new Set(["ollama"]);
  }
  const selected = new Set<string>([providers.embedProvider]);
  const ceiling = cloudMaxTier(source);
  // The MCP child classifies only raw inbox captures, which are routed as tier 2. Tier-1
  // classification belongs to the owner-side dream scheduler and keeps its credentials there.
  const explicitRoute = providers.providerRouteTier2;
  const provider = explicitRoute ?? providers.classifyProvider;
  if (provider !== "ollama" && 2 > ceiling) {
    // Explicit routes above the ceiling are invalid. An implicit cloud fallback is a
    // supported degraded route: jobs reject before provider construction or network use.
    if (explicitRoute) throw new Error("runtime_child_boundary_invalid");
    return selected;
  }
  selected.add(provider);
  return selected;
}

function restrictedAppUrl(raw: string): URL {
  try {
    const parsed = parseLocalPostgresUrl(raw, "minime");
    if (decodeURIComponent(parsed.url.username) !== "minime_app" || !parsed.url.password) {
      throw new Error("runtime_child_boundary_invalid");
    }
    return parsed.url;
  } catch {
    throw new Error("runtime_child_boundary_invalid");
  }
}

function copyProviderCredentials(
  source: NodeJS.ProcessEnv,
  target: Record<string, string>,
  selected: ReadonlySet<string>,
): void {
  for (const provider of selected) {
    for (const name of PROVIDER_CREDENTIAL_ENV[provider] ?? []) {
      const value = source[name];
      if (!value) throw new Error("runtime_provider_credentials_required");
      target[name] = value;
    }
    for (const name of OPTIONAL_PROVIDER_CREDENTIAL_ENV[provider] ?? []) {
      const value = source[name];
      if (value) target[name] = value;
    }
  }
}

function allowedRuntimeEnvironment(source: NodeJS.ProcessEnv): Set<string> {
  const allowed = new Set([...RUNTIME_SETTING_ENV, ...RUNTIME_OS_ENV]);
  if (source.NODE_ENV === "test") {
    allowed.add("NODE_ENV");
    if (source.MINIME_MOCK_OLLAMA === "1") allowed.add("MINIME_MOCK_OLLAMA");
  }
  for (const provider of selectedProviders(source)) {
    for (const name of PROVIDER_CREDENTIAL_ENV[provider] ?? []) allowed.add(name);
    for (const name of OPTIONAL_PROVIDER_CREDENTIAL_ENV[provider] ?? []) allowed.add(name);
  }
  return allowed;
}

/** Build the complete environment for the MCP-reachable child, excluding owner/backup authority. */
export function runtimeChildEnvironment(
  source: NodeJS.ProcessEnv,
  appDatabaseUrl: string,
): Record<string, string> {
  const app = restrictedAppUrl(appDatabaseUrl).toString();
  const child: Record<string, string> = {};
  const selected = selectedProviders(source);
  for (const name of [...RUNTIME_SETTING_ENV, ...RUNTIME_OS_ENV]) {
    const value = source[name];
    if (value !== undefined) child[name] = value;
  }
  if (source.NODE_ENV === "test") {
    child.NODE_ENV = "test";
    if (source.MINIME_MOCK_OLLAMA === "1") child.MINIME_MOCK_OLLAMA = "1";
  }
  copyProviderCredentials(source, child, selected);
  child.DATABASE_URL = app;
  child.MINIME_APP_DATABASE_URL = app;
  child.MINIME_RUNTIME_CHILD = "1";
  child.MINIME_SKIP_REPO_DOTENV = "1";
  return child;
}

/** Fail closed if the private subcommand was started without the supervisor's scrubbed env. */
export function assertRuntimeChildBoundary(env: NodeJS.ProcessEnv = process.env): void {
  const database = env.DATABASE_URL?.trim();
  const runtime = env.MINIME_APP_DATABASE_URL?.trim();
  if (
    env.MINIME_RUNTIME_CHILD !== "1" ||
    env.MINIME_SKIP_REPO_DOTENV !== "1" ||
    !database ||
    !runtime ||
    database !== runtime
  ) {
    throw new Error("runtime_child_boundary_invalid");
  }
  restrictedAppUrl(runtime);
  const allowed = allowedRuntimeEnvironment(env);
  if (Object.keys(env).some((name) => env[name] !== undefined && !allowed.has(name))) {
    throw new Error("runtime_child_boundary_invalid");
  }
  try {
    copyProviderCredentials(env, {}, selectedProviders(env));
  } catch {
    throw new Error("runtime_child_boundary_invalid");
  }
}

export function spawnRuntimeChild(appDatabaseUrl: string) {
  return Bun.spawn(
    [process.execPath, "--no-env-file", "run", join(REPO_ROOT, "src", "cli.ts"), "serve:runtime"],
    {
      cwd: REPO_ROOT,
      env: runtimeChildEnvironment(process.env, appDatabaseUrl),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
}

export async function superviseRuntimeChild(
  child: ReturnType<typeof spawnRuntimeChild>,
): Promise<number> {
  const forward = (signal: "SIGINT" | "SIGTERM") => child.kill(signal);
  const onSigint = () => forward("SIGINT");
  const onSigterm = () => forward("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    return await child.exited;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

export interface OwnerMaintenanceSchedule {
  close(): Promise<void>;
}

interface MaintenanceCron {
  nextRun(): Date | null;
  stop(): void;
}

type MaintenanceCronFactory = (
  pattern: string,
  options: { timezone: string },
  callback: () => void,
) => MaintenanceCron;

const createMaintenanceCron: MaintenanceCronFactory = (pattern, options, callback) =>
  new Cron(pattern, options, callback);

/** Trusted maintenance scheduler. The MCP child never receives restic or owner DB credentials. */
export function startOwnerMaintenanceSchedule(
  createCron: MaintenanceCronFactory = createMaintenanceCron,
): OwnerMaintenanceSchedule {
  const crons: MaintenanceCron[] = [];
  const active = new Set<Promise<unknown>>();
  const run = (label: string, work: () => Promise<unknown>) => {
    const task = work()
      .then((result) => {
        if (
          typeof result === "object" &&
          result !== null &&
          "ran" in result &&
          result.ran === false &&
          "detail" in result
        ) {
          console.error(`[minime] ${label} skipped: ${String(result.detail)}`);
        }
      })
      .catch((error) => {
        console.error(
          `[minime] ${label} failed: ${error instanceof Error ? error.message : error}`,
        );
      });
    active.add(task);
    void task.finally(() => active.delete(task));
  };

  const nightly = createCron(config.dreamCron, { timezone: config.tz }, () =>
    run("dream", () => withAdminDbScope(() => dream())),
  );
  crons.push(nightly);
  console.error(
    `[minime] dream scheduled: ${config.dreamCron} (next: ${nightly.nextRun()?.toISOString()})`,
  );

  if (config.backupCron && config.resticRepository && config.resticPasswordFile) {
    const snapshot = createCron(config.backupCron, { timezone: config.tz }, () =>
      run("db snapshot", dbSnapshot),
    );
    crons.push(snapshot);
    console.error(
      `[minime] db snapshot scheduled: ${config.backupCron} (next: ${snapshot.nextRun()?.toISOString()})`,
    );
  } else {
    console.error(
      "[minime] db snapshot disabled (set BACKUP_CRON, RESTIC_REPOSITORY, and RESTIC_PASSWORD_FILE to enable)",
    );
  }

  let closing: Promise<void> | undefined;
  return {
    close() {
      closing ??= (async () => {
        for (const cron of crons) cron.stop();
        await Promise.allSettled([...active]);
      })();
      return closing;
    },
  };
}
