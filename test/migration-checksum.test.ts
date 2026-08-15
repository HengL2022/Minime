import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { migrateWithExecutor } from "../src/db/migration-context";
import { ensureSchemaMigrationLedger, schemaMigrationNames } from "../src/db/repo";
import { sha256Hex } from "../src/util/hash";
import { registerTestDatabaseCloser, testDatabaseUrl } from "./setup";
import {
  disposeTestDatabase,
  planTestDatabase,
  provisionTestDatabase,
} from "./support/test-database";

const MIGRATIONS_DIR = join(import.meta.dir, "../db/migrations");

test("migrate backfills a null checksum and refuses an edited applied body", async () => {
  const token = `mchk_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const plan = planTestDatabase(testDatabaseUrl(), token);
  const handle = await provisionTestDatabase(plan);
  const isolated = postgres(plan.databaseUrl, { max: 1, onnotice: () => {} });
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    let failed = false;
    try {
      await isolated.end({ timeout: 5 });
    } catch {
      failed = true;
    }
    try {
      await disposeTestDatabase(handle);
    } catch {
      failed = true;
    }
    if (failed) throw new Error("test_database_cleanup_failed");
  };
  const unregister = registerTestDatabaseCloser(cleanup);

  try {
    await migrateWithExecutor({ kind: "test" }, isolated);
    const names = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort();
    expect(await schemaMigrationNames(isolated)).toEqual(names);

    const first = names[0]!;
    await isolated`update schema_migrations set checksum = null where name = ${first}`;
    expect(await migrateWithExecutor({ kind: "test" }, isolated)).toEqual([]);
    const [backfilled] = await isolated<{ checksum: string }[]>`
      select checksum from schema_migrations where name = ${first}`;
    const body = await Bun.file(join(MIGRATIONS_DIR, first)).text();
    expect(backfilled!.checksum).toBe(sha256Hex(body));

    await isolated`
      update schema_migrations
      set checksum = ${"a".repeat(64)}
      where name = ${first}`;
    await expect(migrateWithExecutor({ kind: "test" }, isolated)).rejects.toThrow(
      "migration_checksum_mismatch",
    );
  } finally {
    unregister();
    await cleanup();
  }
});

test("ensureSchemaMigrationLedger adds checksum to a name-only ledger", async () => {
  const token = `mchk2_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const plan = planTestDatabase(testDatabaseUrl(), token);
  const handle = await provisionTestDatabase(plan);
  const isolated = postgres(plan.databaseUrl, { max: 1, onnotice: () => {} });
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    let failed = false;
    try {
      await isolated.end({ timeout: 5 });
    } catch {
      failed = true;
    }
    try {
      await disposeTestDatabase(handle);
    } catch {
      failed = true;
    }
    if (failed) throw new Error("test_database_cleanup_failed");
  };
  const unregister = registerTestDatabaseCloser(cleanup);

  try {
    await isolated`drop table if exists schema_migrations`;
    await isolated`create table schema_migrations (
      name text primary key, applied_at timestamptz not null default now()
    )`;
    await isolated`insert into schema_migrations (name) values ('001_extensions.sql')`;
    await ensureSchemaMigrationLedger(isolated);
    const [col] = await isolated<{ n: number }[]>`
      select count(*)::int as n
      from information_schema.columns
      where table_schema = 'public' and table_name = 'schema_migrations' and column_name = 'checksum'`;
    expect(col!.n).toBe(1);
  } finally {
    unregister();
    await cleanup();
  }
});
