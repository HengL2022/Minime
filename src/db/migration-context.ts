import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DbPool } from "./client";

export type MigrationContext =
  | { kind: "install" }
  | { kind: "direct" }
  | { kind: "test" }
  | { kind: "restore" }
  | { kind: "update"; snapshot: "taken" | "unconfigured" };

export interface SchemaPosture {
  expected: readonly string[];
  applied: readonly string[];
  missing: readonly string[];
  unexpected: readonly string[];
}

const MIGRATIONS_DIR = join(import.meta.dir, "../../db/migrations");
const TEST_DATABASE = /^minime_test_[a-z0-9_]+$/;
const RESTORE_DATABASE = new Set(["minime_drill", "minime_restore"]);

function isTestDatabaseName(name: string): boolean {
  return TEST_DATABASE.test(name) && !/[\r\n]/.test(name);
}

function migrationContextError(kind: "required" | "invalid" | "target"): Error {
  return new Error(`migration_context_${kind}`);
}

function databaseNameFromUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
    return name || undefined;
  } catch {
    return undefined;
  }
}

function isMigrationContext(context: MigrationContext | undefined): context is MigrationContext {
  if (!context || typeof context !== "object") return false;
  switch (context.kind) {
    case "install":
    case "direct":
    case "test":
    case "restore":
      return Object.keys(context).length === 1;
    case "update":
      return (
        Object.keys(context).length === 2 &&
        (context.snapshot === "taken" || context.snapshot === "unconfigured")
      );
    default:
      return false;
  }
}

export function assertMigrationContextForDatabase(
  context: MigrationContext | undefined,
  databaseName: string,
): asserts context is MigrationContext {
  if (context === undefined) throw migrationContextError("required");
  if (!isMigrationContext(context)) throw migrationContextError("invalid");

  const validTarget = (() => {
    switch (context.kind) {
      case "install":
      case "direct":
      case "update":
        return databaseName === "minime";
      case "test":
        return isTestDatabaseName(databaseName);
      case "restore":
        return RESTORE_DATABASE.has(databaseName);
      default: {
        const exhaustive: never = context;
        return exhaustive;
      }
    }
  })();
  if (!validTarget) throw migrationContextError("target");
}

export function parseMigrationCliContext(argv: readonly string[]): MigrationContext {
  if (argv.length === 0) throw migrationContextError("required");
  let context: string | undefined;
  let snapshot: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--context") {
      if (context !== undefined || i + 1 >= argv.length) throw migrationContextError("invalid");
      context = argv[++i];
      continue;
    }
    if (flag === "--snapshot-outcome") {
      if (snapshot !== undefined || i + 1 >= argv.length) throw migrationContextError("invalid");
      snapshot = argv[++i];
      continue;
    }
    throw migrationContextError("invalid");
  }
  if (!context) throw migrationContextError("required");
  switch (context) {
    case "direct":
    case "install":
    case "restore":
      if (snapshot !== undefined) throw migrationContextError("invalid");
      return { kind: context };
    case "update":
      if (snapshot !== "taken" && snapshot !== "unconfigured") {
        throw migrationContextError("invalid");
      }
      return { kind: "update", snapshot };
    default:
      throw migrationContextError("invalid");
  }
}

function sorted(names: readonly string[]): string[] {
  return [...names].sort();
}

export function compareMigrationLedger(
  expected: readonly string[],
  applied: readonly string[],
): SchemaPosture {
  const sortedExpected = sorted(expected);
  const sortedApplied = sorted(applied);
  const expectedCounts = new Map<string, number>();
  for (const name of sortedExpected) {
    expectedCounts.set(name, (expectedCounts.get(name) ?? 0) + 1);
  }
  const appliedCounts = new Map<string, number>();
  for (const name of sortedApplied) {
    appliedCounts.set(name, (appliedCounts.get(name) ?? 0) + 1);
  }
  const missing: string[] = [];
  for (const name of sortedExpected) {
    const expectedCount = expectedCounts.get(name) ?? 0;
    const appliedCount = appliedCounts.get(name) ?? 0;
    if (expectedCount > appliedCount) missing.push(name);
  }
  const unexpected: string[] = [];
  for (const name of sortedApplied) {
    const expectedCount = expectedCounts.get(name) ?? 0;
    const appliedCount = appliedCounts.get(name) ?? 0;
    if (appliedCount > expectedCount) unexpected.push(name);
  }
  return { expected: sortedExpected, applied: sortedApplied, missing, unexpected };
}

export async function checkedOutMigrationNames(): Promise<readonly string[]> {
  return sorted((await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")));
}

export function assertSchemaPostureCurrent(posture: SchemaPosture): void {
  if (posture.missing.length || posture.unexpected.length) {
    throw new Error("schema_not_current");
  }
}

async function databaseName(): Promise<string> {
  const { config } = await import("../util/config");
  const name = databaseNameFromUrl(config.databaseUrl);
  if (!name) throw migrationContextError("target");
  return name;
}

export async function inspectSchemaPosture(): Promise<SchemaPosture> {
  const { adminSql } = await import("./client");
  return inspectSchemaPostureWithExecutor(adminSql);
}

export async function inspectSchemaPostureWithExecutor(executor: DbPool): Promise<SchemaPosture> {
  const expected = await checkedOutMigrationNames();
  const { schemaMigrationNames } = await import("./repo");
  let applied: string[] = [];
  try {
    applied = await schemaMigrationNames(executor);
  } catch (error) {
    if ((error as { code?: string }).code !== "42P01") throw error;
  }
  return compareMigrationLedger(expected, applied);
}

export async function assertSchemaCurrent(): Promise<void> {
  const name = await databaseName();
  if (name !== "minime" && !isTestDatabaseName(name) && !RESTORE_DATABASE.has(name)) {
    throw migrationContextError("target");
  }
  assertSchemaPostureCurrent(await inspectSchemaPosture());
}

export async function migrate(context: MigrationContext): Promise<string[]> {
  const name = await databaseName();
  assertMigrationContextForDatabase(context, name);
  const { adminSql } = await import("./client");
  return migrateWithExecutor(context, adminSql);
}

export async function migrateWithExecutor(
  context: MigrationContext,
  executor: DbPool,
): Promise<string[]> {
  const { connectedAdminDatabaseName } = await import("./repo");
  const connectedName = await connectedAdminDatabaseName(executor);
  assertMigrationContextForDatabase(context, connectedName);
  return applyMigrations(executor);
}

async function applyMigrations(executor: DbPool): Promise<string[]> {
  const expected = await checkedOutMigrationNames();
  const { applyCheckedOutMigration, ensureSchemaMigrationLedger, schemaMigrationNames } =
    await import("./repo");
  await ensureSchemaMigrationLedger(executor);
  const applied = new Set(await schemaMigrationNames(executor));
  const ran: string[] = [];
  for (const file of expected) {
    if (applied.has(file)) continue;
    const body = await Bun.file(join(MIGRATIONS_DIR, file)).text();
    await applyCheckedOutMigration(executor, file, body);
    ran.push(file);
  }
  return ran;
}
