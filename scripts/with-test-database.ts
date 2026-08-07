#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import {
  type TestAppRoleLease,
  disableTestAppRole,
  dropTestAppRole,
  mintTestAppRole,
} from "../test/support/app-role";
import {
  type ProvisionedTestDatabase,
  type TestDatabasePlan,
  disposeTestDatabase,
  planTestDatabase,
  provisionTestDatabase,
} from "../test/support/test-database";

export const OWNED_DATABASE_ENV_NAMES = [
  "EVAL_DATABASE_URL",
  "EVAL_PMB_DATABASE_URL",
  "EVAL_SKILLS_DATABASE_URL",
] as const;
export type OwnedDatabaseEnv = (typeof OWNED_DATABASE_ENV_NAMES)[number];

export interface OwnedCommand {
  readonly label:
    | "verify_m0"
    | "eval_search"
    | "eval_search_live"
    | "eval_snapshot"
    | "eval_graph_hygiene"
    | "eval_pmb"
    | "eval_pmb_official"
    | "eval_skills"
    | "eval_skill_optimize";
  readonly databaseEnv?: OwnedDatabaseEnv;
  readonly argv: readonly [string, ...string[]];
}

export interface OwnedCommandDeps {
  readonly provision: typeof provisionTestDatabase;
  readonly dispose: typeof disposeTestDatabase;
  // Test harnesses may keep the historical void return; production bootstrap returns a lease.
  // biome-ignore lint/suspicious/noConfusingVoidType: compatibility with injected test deps.
  bootstrapOwnedDatabase(appOnly?: boolean): Promise<TestAppRoleLease | void>;
  spawn(argv: readonly string[], env: Readonly<Record<string, string>>): Promise<number>;
}

const DEFAULT_DATABASE_URL = "postgres://minime:minime@localhost:5432/minime";
const LABELS = new Set<OwnedCommand["label"]>([
  "verify_m0",
  "eval_search",
  "eval_search_live",
  "eval_snapshot",
  "eval_graph_hygiene",
  "eval_pmb",
  "eval_pmb_official",
  "eval_skills",
  "eval_skill_optimize",
]);
const EXPECTED_DATABASE_ENV: Partial<Record<OwnedCommand["label"], OwnedDatabaseEnv>> = {
  eval_search: "EVAL_DATABASE_URL",
  eval_search_live: "EVAL_DATABASE_URL",
  eval_snapshot: "EVAL_DATABASE_URL",
  eval_graph_hygiene: "EVAL_DATABASE_URL",
  eval_pmb: "EVAL_PMB_DATABASE_URL",
  eval_pmb_official: "EVAL_PMB_DATABASE_URL",
  eval_skills: "EVAL_SKILLS_DATABASE_URL",
  eval_skill_optimize: "EVAL_SKILLS_DATABASE_URL",
};

// The coordinator worker is deliberately app-only: it must prove that corpus ingestion and
// retrieval work through a per-scratch login role's RLS/least-privilege boundary. Legacy scratch evaluators
// intentionally own their parent-created database and still perform reset/DDL there.
export const APP_ONLY_LABELS = new Set<OwnedCommand["label"]>([
  "eval_search",
  "eval_search_live",
  "eval_snapshot",
]);
export const OWNER_SCRATCH_LABELS = new Set<OwnedCommand["label"]>([
  "verify_m0",
  "eval_graph_hygiene",
  "eval_pmb",
  "eval_pmb_official",
  "eval_skills",
  "eval_skill_optimize",
]);

function invalidArgs(): never {
  throw new Error("owned_database_args_invalid");
}

function inheritedExternalDatabase(): never {
  throw new Error("owned_database_external_forbidden");
}

export function parseOwnedCommandArgs(argv: readonly string[]): OwnedCommand {
  let label: OwnedCommand["label"] | undefined;
  let databaseEnv: OwnedDatabaseEnv | undefined;
  let separator = -1;
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === "--") {
      separator = index;
      break;
    }
    if (token === "--label") {
      if (label !== undefined || index + 1 >= argv.length) invalidArgs();
      const candidate = argv[index + 1] as OwnedCommand["label"];
      if (!LABELS.has(candidate)) invalidArgs();
      label = candidate;
      index += 2;
      continue;
    }
    if (token === "--database-env") {
      if (databaseEnv !== undefined || index + 1 >= argv.length) invalidArgs();
      const candidate = argv[index + 1];
      if (candidate === undefined) invalidArgs();
      if (!(OWNED_DATABASE_ENV_NAMES as readonly string[]).includes(candidate)) invalidArgs();
      databaseEnv = candidate as OwnedDatabaseEnv;
      index += 2;
      continue;
    }
    invalidArgs();
  }
  if (separator < 0 || label === undefined || separator !== index || argv.length <= separator + 1) {
    invalidArgs();
  }
  const expected = EXPECTED_DATABASE_ENV[label];
  if (databaseEnv !== undefined && databaseEnv !== expected) invalidArgs();
  const child = argv.slice(separator + 1);
  if (child.length === 0 || child.some((part) => part.length === 0)) invalidArgs();
  return {
    label,
    ...(databaseEnv ? { databaseEnv } : {}),
    argv: child as [string, ...string[]],
  };
}

function generatedSourceUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

function makePlan(command: OwnedCommand): TestDatabasePlan {
  const runToken = `${command.label}_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  return planTestDatabase(generatedSourceUrl(), runToken);
}

function childEnvironment(
  plan: TestDatabasePlan,
  label: OwnedCommand["label"],
  databaseEnv?: OwnedDatabaseEnv,
  appLease?: TestAppRoleLease,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      key !== "MINIME_APP_DATABASE_URL" &&
      key !== "MINIME_APP_PASSWORD" &&
      !OWNED_DATABASE_ENV_NAMES.includes(key as OwnedDatabaseEnv)
    ) {
      env[key] = value;
    }
  }
  if (APP_ONLY_LABELS.has(label)) {
    if (!appLease) throw new Error("test_app_role_lease_missing");
    const appUrl = new URL(appLease.databaseUrl);
    // App-only children receive only the restricted runtime DSN. The parent retains the owner
    // DSN for clone/bootstrap/cleanup and never forwards it as an environment variable.
    env.DATABASE_URL = appUrl.toString();
    env.MINIME_APP_DATABASE_URL = appUrl.toString();
    if (databaseEnv) env[databaseEnv] = appUrl.toString();
  } else if (OWNER_SCRATCH_LABELS.has(label)) {
    // Legacy evaluators are scratch-only and need reset/DDL. Their owner DSN is still the
    // parent-created guarded target, never the source/live database.
    env.DATABASE_URL = plan.databaseUrl;
    if (databaseEnv) env[databaseEnv] = plan.databaseUrl;
  } else {
    throw new Error("owned_database_label_policy_invalid");
  }
  return env;
}

async function spawnOwned(
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<number> {
  const child = Bun.spawn([...argv], {
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  let interrupted = 0;
  const onSignal = (signal: "SIGINT" | "SIGTERM") => {
    interrupted = signal === "SIGINT" ? 130 : 143;
    child.kill(signal);
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    const exitCode = await child.exited;
    return interrupted || exitCode;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

const defaultDeps: OwnedCommandDeps = {
  provision: provisionTestDatabase,
  dispose: disposeTestDatabase,
  bootstrapOwnedDatabase,
  spawn: spawnOwned,
};

export async function runWithOwnedTestDatabase(
  command: OwnedCommand,
  deps: OwnedCommandDeps = defaultDeps,
): Promise<number> {
  const environmentNames = [
    "DATABASE_URL",
    "MINIME_APP_DATABASE_URL",
    ...OWNED_DATABASE_ENV_NAMES,
    "MINIME_TEST_DATABASE_URL",
  ] as const;
  const originalEnvironment = new Map(
    environmentNames.map((name) => [name, process.env[name]] as const),
  );
  if (process.env.MINIME_TEST_DATABASE_URL !== undefined) inheritedExternalDatabase();
  const plan = makePlan(command);
  let signalCode: number | undefined;
  const onSigint = () => {
    signalCode ??= 130;
  };
  const onSigterm = () => {
    signalCode ??= 143;
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  let handle: ProvisionedTestDatabase | undefined;
  let appLease: TestAppRoleLease | undefined;
  let disposed = false;
  let cleanupPromise: Promise<void> | undefined;
  try {
    handle = await deps.provision(plan);
    const disposeOnce = async (): Promise<void> => {
      if (disposed) return cleanupPromise;
      if (
        !handle ||
        !handle.createdByThisProcess ||
        process.env.MINIME_KEEP_TEST_DATABASE === "1"
      ) {
        if (handle?.createdByThisProcess && process.env.MINIME_KEEP_TEST_DATABASE === "1") {
          if (appLease && deps === defaultDeps) await disableTestAppRole(appLease);
          console.log(handle.plan.databaseName);
        }
        disposed = true;
        return;
      }
      cleanupPromise ??= (async () => {
        await deps.dispose(handle!);
        if (appLease && deps === defaultDeps) {
          const previous = process.env.DATABASE_URL;
          process.env.DATABASE_URL = handle!.plan.adminUrl;
          try {
            await dropTestAppRole(appLease);
          } finally {
            if (previous === undefined) Reflect.deleteProperty(process.env, "DATABASE_URL");
            else process.env.DATABASE_URL = previous;
          }
        }
      })().catch(() => {
        throw new Error("test_database_cleanup_failed");
      });
      disposed = true;
      return cleanupPromise;
    };

    process.env.DATABASE_URL = handle.plan.databaseUrl;
    // A completed install exports the live runtime-role endpoint. The bootstrap below imports
    // production config after DATABASE_URL has moved to this scratch database, so retaining that
    // live alias would correctly fail owner/app endpoint validation. Bootstrap is owner-only; let
    // config fall back to the scratch owner DSN, then childEnvironment installs the minted scratch
    // app endpoint for app-only workers.
    Reflect.deleteProperty(process.env, "MINIME_APP_DATABASE_URL");
    if (command.databaseEnv) process.env[command.databaseEnv] = handle.plan.databaseUrl;
    let result = signalCode ?? 1;
    let primaryError: unknown;
    try {
      if (signalCode === undefined) {
        appLease =
          (await deps.bootstrapOwnedDatabase(APP_ONLY_LABELS.has(command.label))) ?? undefined;
        if (signalCode === undefined) {
          result = await deps.spawn(
            command.argv,
            childEnvironment(handle.plan, command.label, command.databaseEnv, appLease),
          );
        }
      }
    } catch (error) {
      primaryError = error;
    }
    let cleanupError: unknown;
    try {
      await disposeOnce();
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError) throw cleanupError;
    if (primaryError) throw primaryError;
    return signalCode ?? result;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    for (const name of environmentNames) {
      const value = originalEnvironment.get(name);
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
}

async function bootstrapOwnedDatabase(appOnly = false): Promise<TestAppRoleLease | undefined> {
  const { migrate } = await import("../src/db/migrate");
  const { closeDb } = await import("../src/db/client");
  try {
    await migrate({ kind: "test" });
    if (!appOnly) return undefined;
    const ownerUrl = process.env.DATABASE_URL;
    if (!ownerUrl) throw new Error("test_app_role_owner_url_missing");
    return await mintTestAppRole(ownerUrl);
  } finally {
    await closeDb();
  }
}

async function main(): Promise<void> {
  try {
    const command = parseOwnedCommandArgs(process.argv.slice(2));
    const code = await runWithOwnedTestDatabase(command);
    process.exitCode = code;
  } catch (error) {
    const message = error instanceof Error ? error.message : "owned_database_failed";
    if (
      message === "test_database_cleanup_failed" ||
      message === "owned_database_external_forbidden" ||
      message === "owned_database_args_invalid"
    ) {
      console.error(message);
    } else {
      console.error(message);
    }
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
