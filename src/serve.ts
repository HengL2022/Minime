import { join } from "node:path";
import { Cron } from "croner";
import { withAdminDbScope } from "./db/client";
import { dbSnapshot } from "./pipeline/backup";
import { dream } from "./pipeline/dream";
import { REPO_ROOT, config } from "./util/config";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const PRIVATE_RUNTIME_ENV = new Set([
  "B2_ACCOUNT_ID",
  "B2_ACCOUNT_KEY",
  "B2_APPLICATION_KEY",
  "B2_APPLICATION_KEY_ID",
  "DATABASE_URL",
  "EVAL_DATABASE_URL",
  "EVAL_PMB_DATABASE_URL",
  "EVAL_SKILLS_DATABASE_URL",
  "MINIME_APP_DATABASE_URL",
  "MINIME_APP_PASSWORD",
  "MINIME_RUNTIME_CHILD",
  "MINIME_TEST_DATABASE_URL",
  "RESTIC_PASSWORD",
  "RESTIC_PASSWORD_COMMAND",
  "RESTIC_PASSWORD_FILE",
  "RESTIC_REPOSITORY",
]);
const AWS_CREDENTIAL_ENV = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
]);

function usesBedrock(source: NodeJS.ProcessEnv): boolean {
  return [source.CLASSIFY_PROVIDER, source.PROVIDER_ROUTE_TIER1, source.PROVIDER_ROUTE_TIER2].some(
    (provider) => provider?.trim().toLowerCase() === "bedrock",
  );
}

function restrictedAppUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("runtime_child_boundary_invalid");
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    url.username !== "minime_app" ||
    !url.password ||
    decodeURIComponent(url.pathname.replace(/^\//, "")) !== "minime" ||
    !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new Error("runtime_child_boundary_invalid");
  }
  return url;
}

/** Build the complete environment for the MCP-reachable child, excluding owner/backup authority. */
export function runtimeChildEnvironment(
  source: NodeJS.ProcessEnv,
  appDatabaseUrl: string,
): Record<string, string> {
  const app = restrictedAppUrl(appDatabaseUrl).toString();
  const child: Record<string, string> = {};
  const bedrock = usesBedrock(source);
  if (
    bedrock &&
    (!source.BEDROCK_AWS_ACCESS_KEY_ID ||
      !source.BEDROCK_AWS_SECRET_ACCESS_KEY ||
      !source.BEDROCK_AWS_REGION)
  ) {
    throw new Error("runtime_bedrock_credentials_required");
  }
  for (const [name, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      !PRIVATE_RUNTIME_ENV.has(name) &&
      !name.startsWith("PG") &&
      !AWS_CREDENTIAL_ENV.has(name)
    ) {
      child[name] = value;
    }
  }
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
  if (Object.keys(env).some((name) => name.startsWith("PG") && env[name] !== undefined)) {
    throw new Error("runtime_child_boundary_invalid");
  }
  if ([...AWS_CREDENTIAL_ENV].some((name) => env[name] !== undefined)) {
    throw new Error("runtime_child_boundary_invalid");
  }
  if (
    usesBedrock(env) &&
    (!env.BEDROCK_AWS_ACCESS_KEY_ID ||
      !env.BEDROCK_AWS_SECRET_ACCESS_KEY ||
      !env.BEDROCK_AWS_REGION)
  ) {
    throw new Error("runtime_child_boundary_invalid");
  }
  for (const name of PRIVATE_RUNTIME_ENV) {
    if (
      name !== "DATABASE_URL" &&
      name !== "MINIME_APP_DATABASE_URL" &&
      name !== "MINIME_RUNTIME_CHILD" &&
      env[name] !== undefined
    ) {
      throw new Error("runtime_child_boundary_invalid");
    }
  }
}

export function spawnRuntimeChild(appDatabaseUrl: string) {
  return Bun.spawn([process.execPath, join(REPO_ROOT, "src", "cli.ts"), "serve:runtime"], {
    cwd: REPO_ROOT,
    env: runtimeChildEnvironment(process.env, appDatabaseUrl),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
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

/** Trusted maintenance scheduler. The MCP child never receives restic or owner DB credentials. */
export function startOwnerMaintenanceSchedule(): OwnerMaintenanceSchedule {
  const crons: Cron[] = [];
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

  const nightly = new Cron(config.dreamCron, () =>
    run("dream", () => withAdminDbScope(() => dream())),
  );
  crons.push(nightly);
  console.error(
    `[minime] dream scheduled: ${config.dreamCron} (next: ${nightly.nextRun()?.toISOString()})`,
  );

  if (config.backupCron && config.resticRepository && config.resticPasswordFile) {
    const snapshot = new Cron(config.backupCron, () => run("db snapshot", dbSnapshot));
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
