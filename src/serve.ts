import { join } from "node:path";
import { Cron } from "croner";
import { withAdminDbScope } from "./db/client";
import {
  type MaintenanceLockHandle,
  lastEventAt,
  releaseMaintenanceLock,
  tryAcquireMaintenanceLock,
} from "./db/repo";
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

// Every resident `serve` runs this scheduler; only the process holding the maintenance advisory
// lock (repo.tryAcquireMaintenanceLock) actually runs dream/backup. A process that loses the
// lock retries takeover on this cadence, so a killed owner hands off within one interval with
// zero configuration (docs/DEVELOPMENT.md's "coordinate multiple MCP processes" backlog item).
const MAINTENANCE_RETRY_CRON = "*/5 * * * *";
// A catch-up dream run fires after a short random delay so that if several processes were all
// waiting on a takeover (e.g. after a shared outage), they do not all hit the database at once.
const DREAM_CATCH_UP_MIN_DELAY_MS = 30_000;
const DREAM_CATCH_UP_MAX_DELAY_MS = 90_000;

// The remaining scheduler pieces below take their state as explicit parameters (crons to append
// to, runDream/run to invoke) instead of closing over startOwnerMaintenanceSchedule's locals --
// everything here is read-only with respect to that state except appending to `crons`. Only
// attemptTakeover (which must mutate `lock` and stop `retry`) stays a closure inside it.

// Catch-up (W3-5): immediately after winning the lock, ask when dream last finished. If the
// schedule's next fire after that instant has already passed -- or dream has never once run on a
// database that otherwise has history -- run it once, shortly, instead of waiting for tonight's
// cron. dream() always writes its dream:summary event as the last step even when individual
// steps fail (pipeline/dream.ts), so this can never loop.
//
// Deliberately NOT withAdminDbScope: adminSql is a single-connection pool that dream() itself
// holds exclusively for its whole run, and the lock holds one runtime connection for the
// scheduler's entire lifetime. events SELECT is already granted to the restricted runtime role
// (db/migrations/007_rls.sql), so the plain runtime pool (5 connections) is both sufficient and
// starvation-free here.
async function scheduleDreamCatchUp(
  createCron: MaintenanceCronFactory,
  crons: MaintenanceCron[],
  runDream: () => void,
): Promise<void> {
  const lastDreamAt = await lastEventAt("dream:summary");
  let needsCatchUp: boolean;
  if (lastDreamAt) {
    const scheduledAfterLastDream = new Cron(config.dreamCron, {
      timezone: config.tz,
    }).nextRun(lastDreamAt);
    needsCatchUp =
      scheduledAfterLastDream !== null && scheduledAfterLastDream.getTime() <= Date.now();
  } else {
    // No dream has ever run. On a brand-new install that is simply tonight's first-ever
    // schedule, not a miss. On a database with other history, dream was never scheduled or kept
    // failing to start, so catch up now rather than waiting for tonight.
    needsCatchUp = (await lastEventAt()) !== null;
  }
  if (!needsCatchUp) return;
  const delayMs =
    DREAM_CATCH_UP_MIN_DELAY_MS +
    Math.floor(Math.random() * (DREAM_CATCH_UP_MAX_DELAY_MS - DREAM_CATCH_UP_MIN_DELAY_MS));
  const fireAt = new Date(Date.now() + delayMs);
  const catchUp = createCron(fireAt.toISOString(), { timezone: config.tz }, runDream);
  crons.push(catchUp);
  console.error(
    `[minime] dream catch-up scheduled: ${fireAt.toISOString()} (last run: ${
      lastDreamAt ? lastDreamAt.toISOString() : "never"
    })`,
  );
}

async function beginOwnedMaintenance(
  createCron: MaintenanceCronFactory,
  crons: MaintenanceCron[],
  run: (label: string, work: () => Promise<unknown>) => void,
  runDream: () => void,
): Promise<void> {
  const nightly = createCron(config.dreamCron, { timezone: config.tz }, runDream);
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

  await scheduleDreamCatchUp(createCron, crons, runDream);
}

/** Trusted maintenance scheduler. The MCP child never receives restic or owner DB credentials. */
export async function startOwnerMaintenanceSchedule(
  createCron: MaintenanceCronFactory = createMaintenanceCron,
): Promise<OwnerMaintenanceSchedule> {
  const crons: MaintenanceCron[] = [];
  const active = new Set<Promise<unknown>>();
  let lock: MaintenanceLockHandle | null = null;
  let retry: MaintenanceCron | undefined;

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

  const runDream = () => run("dream", () => withAdminDbScope(() => dream()));

  const attemptTakeover = async (): Promise<void> => {
    // Also the runtime pool, not admin scope -- see scheduleDreamCatchUp above.
    const handle = await tryAcquireMaintenanceLock();
    if (!handle) return;
    lock = handle;
    retry?.stop();
    await beginOwnedMaintenance(createCron, crons, run, runDream);
  };

  const initialLock = await tryAcquireMaintenanceLock();
  if (initialLock) {
    lock = initialLock;
    await beginOwnedMaintenance(createCron, crons, run, runDream);
  } else {
    console.error("[minime] maintenance owned by another process");
    retry = createCron(MAINTENANCE_RETRY_CRON, { timezone: config.tz }, () =>
      run("maintenance takeover", attemptTakeover),
    );
    crons.push(retry);
  }

  let closing: Promise<void> | undefined;
  return {
    close() {
      closing ??= (async () => {
        retry?.stop();
        // Let any in-flight takeover finish first -- it may still be about to register the
        // dream/backup/catch-up crons a successful takeover creates, and those must be stopped
        // too, not leaked past close().
        await Promise.allSettled([...active]);
        for (const cron of crons) cron.stop();
        await Promise.allSettled([...active]);
        if (lock) {
          const handle = lock;
          lock = null;
          await releaseMaintenanceLock(handle);
        }
      })();
      return closing;
    },
  };
}
