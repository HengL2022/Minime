import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { testDatabaseUrl } from "./setup";

const REPO_ROOT = resolve(import.meta.dir, "..");
const GATE_SCRIPT = resolve(REPO_ROOT, "scripts", "restore-schema-gate.ts");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "db", "migrations");
const SCRATCH_DATABASE = "minime_restore";
const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();

const sourceUrl = new URL(testDatabaseUrl());
const adminUrl = new URL(sourceUrl);
adminUrl.pathname = "/postgres";
const scratchUrl = new URL(sourceUrl);
scratchUrl.pathname = `/${SCRATCH_DATABASE}`;

let adminSql: Sql;
let ownsScratch = false;

async function waitForScratchConnectionsToClose(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const active = await adminSql`select 1 from pg_stat_activity
      where datname = ${SCRATCH_DATABASE} and pid <> pg_backend_pid()`;
    if (active.length === 0) return;
    await Bun.sleep(25);
  }
  throw new Error("restore_schema_gate_scratch_busy");
}

async function dropOwnedScratch(): Promise<void> {
  if (!ownsScratch) return;
  await adminSql`alter database ${adminSql(SCRATCH_DATABASE)} with allow_connections false`;
  await waitForScratchConnectionsToClose();
  await adminSql`drop database if exists ${adminSql(SCRATCH_DATABASE)}`;
  ownsScratch = false;
}

async function prepareScratch(appliedMigrations: readonly string[]): Promise<void> {
  await dropOwnedScratch();
  await adminSql`create database ${adminSql(SCRATCH_DATABASE)}
    with owner = ${adminSql("minime")} template = ${adminSql("minime_test")}`;
  ownsScratch = true;

  const scratchSql = postgres(scratchUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    await scratchSql.unsafe("drop owned by minime cascade");
    await scratchSql`create table schema_migrations (
      name text primary key, applied_at timestamptz not null default now()
    )`;
    for (const migration of appliedMigrations) {
      const body = readFileSync(resolve(MIGRATIONS_DIR, migration), "utf8");
      await scratchSql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into schema_migrations (name) values (${migration})`;
      });
    }
  } finally {
    await scratchSql.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  adminSql = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  const existing = await adminSql`select 1 from pg_database where datname = ${SCRATCH_DATABASE}`;
  if (existing.length !== 0) throw new Error("restore_schema_gate_scratch_collision");
});

afterAll(async () => {
  try {
    await dropOwnedScratch();
  } finally {
    await adminSql?.end({ timeout: 5 });
  }
});

function runGate(databaseUrl: string): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([process.execPath, "--no-env-file", "run", GATE_SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? "",
    },
    stdin: Buffer.from(databaseUrl),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

test("restore schema gate refuses a live target before attempting a database connection", () => {
  const result = runGate("postgres://minime:fictional-live-password@127.0.0.1:1/minime");

  expect(result).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "restore schema gate failed (target_boundary)\n",
  });
});

test("restore schema gate rejects trailing stdin bytes before attempting a connection", () => {
  const result = runGate(
    "postgres://minime:fictional-scratch-password@127.0.0.1:1/minime_restore\n",
  );

  expect(result).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "restore schema gate failed (target_boundary)\n",
  });
});

test("restore schema gate migrates a penultimate scratch schema to the exact checked-out ledger", async () => {
  const penultimateMigrations = migrationFiles.slice(0, -1);
  await prepareScratch(penultimateMigrations);

  const result = runGate(scratchUrl.toString());

  expect(result).toEqual({
    exitCode: 0,
    stdout: "restore schema gate passed\n",
    stderr: "",
  });
  const scratchSql = postgres(scratchUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    const ledger = await scratchSql`select name from schema_migrations order by name`;
    expect(ledger.map((row) => String(row.name))).toEqual(migrationFiles);
  } finally {
    await scratchSql.end({ timeout: 5 });
  }
});

test("restore schema gate rejects an unexpected ledger entry before applying a missing migration", async () => {
  const penultimateMigrations = migrationFiles.slice(0, -1);
  await prepareScratch(penultimateMigrations);
  const scratchSql = postgres(scratchUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    await scratchSql`insert into schema_migrations (name) values ('999_unexpected.sql')`;
  } finally {
    await scratchSql.end({ timeout: 5 });
  }

  const result = runGate(scratchUrl.toString());

  expect(result).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "restore schema gate failed (ledger)\n",
  });
  const inspectedSql = postgres(scratchUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    const ledger = await inspectedSql`select name from schema_migrations order by name`;
    expect(ledger.map((row) => String(row.name))).toEqual([
      ...penultimateMigrations,
      "999_unexpected.sql",
    ]);
  } finally {
    await inspectedSql.end({ timeout: 5 });
  }
});

test("restore schema gate rejects duplicate migration names", async () => {
  await prepareScratch(migrationFiles);
  const scratchSql = postgres(scratchUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    await scratchSql.unsafe("alter table schema_migrations drop constraint schema_migrations_pkey");
    await scratchSql`insert into schema_migrations (name) values ('001_extensions.sql')`;
  } finally {
    await scratchSql.end({ timeout: 5 });
  }

  const result = runGate(scratchUrl.toString());

  expect(result).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "restore schema gate failed (ledger)\n",
  });
});

test("restore schema gate rejects a structurally unsafe schema even when its ledger is current", async () => {
  await prepareScratch(migrationFiles);
  const scratchSql = postgres(scratchUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    await scratchSql.unsafe("drop trigger events_no_truncate on events");
  } finally {
    await scratchSql.end({ timeout: 5 });
  }

  const result = runGate(scratchUrl.toString());

  expect(result).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "restore schema gate failed (structure)\n",
  });
});

test("restore schema gate rejects a same-name audit trigger with weaker operations and function", async () => {
  await prepareScratch(migrationFiles);
  const scratchSql = postgres(scratchUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    await scratchSql.unsafe("drop trigger events_no_update on events");
    await scratchSql.unsafe(`create trigger events_no_update before update on events
      for each row execute function set_updated_at()`);
  } finally {
    await scratchSql.end({ timeout: 5 });
  }

  const result = runGate(scratchUrl.toString());

  expect(result).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "restore schema gate failed (structure)\n",
  });
});

test("restore schema gate rejects a same-name audit trigger disabled by a WHEN clause", async () => {
  await prepareScratch(migrationFiles);
  const scratchSql = postgres(scratchUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    await scratchSql.unsafe("drop trigger events_no_update on events");
    await scratchSql.unsafe(`create trigger events_no_update before update or delete on events
      for each row when (old.id is distinct from old.id)
      execute function events_append_only()`);
  } finally {
    await scratchSql.end({ timeout: 5 });
  }

  const result = runGate(scratchUrl.toString());

  expect(result).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "restore schema gate failed (structure)\n",
  });
});

test("restore schema gate rejects a same-name non-unique inbox identity index", async () => {
  await prepareScratch(migrationFiles);
  const scratchSql = postgres(scratchUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    await scratchSql.unsafe("drop index inbox_items_raw_path_content_hash_uidx");
    await scratchSql.unsafe(
      "create index inbox_items_raw_path_content_hash_uidx on inbox_items (raw_path)",
    );
  } finally {
    await scratchSql.end({ timeout: 5 });
  }

  const result = runGate(scratchUrl.toString());

  expect(result).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "restore schema gate failed (structure)\n",
  });
});

test("restore schema gate rejects a same-name inbox identity index with the wrong predicate", async () => {
  await prepareScratch(migrationFiles);
  const scratchSql = postgres(scratchUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    await scratchSql.unsafe("drop index inbox_items_raw_path_content_hash_uidx");
    await scratchSql.unsafe(`create unique index inbox_items_raw_path_content_hash_uidx
      on inbox_items (raw_path, content_hash) where content_hash is null`);
  } finally {
    await scratchSql.end({ timeout: 5 });
  }

  const result = runGate(scratchUrl.toString());

  expect(result).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "restore schema gate failed (structure)\n",
  });
});

test("restore schema gate rejects a same-name inbox immutability trigger with a WHEN clause", async () => {
  await prepareScratch(migrationFiles);
  const scratchSql = postgres(scratchUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    await scratchSql.unsafe("drop trigger inbox_capture_identity_immutable on inbox_items");
    await scratchSql.unsafe(`create trigger inbox_capture_identity_immutable
      before update on inbox_items for each row
      when (old.raw_path is distinct from old.raw_path)
      execute function enforce_inbox_capture_identity_immutable()`);
  } finally {
    await scratchSql.end({ timeout: 5 });
  }

  const result = runGate(scratchUrl.toString());

  expect(result).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "restore schema gate failed (structure)\n",
  });
});

test("restore schema gate rejects a same-name non-unique archive path index", async () => {
  await prepareScratch(migrationFiles);
  const scratchSql = postgres(scratchUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    await scratchSql.unsafe("alter table inbox_items drop constraint inbox_items_archive_path_key");
    await scratchSql.unsafe(
      "create index inbox_items_archive_path_key on inbox_items (archive_path)",
    );
  } finally {
    await scratchSql.end({ timeout: 5 });
  }

  const result = runGate(scratchUrl.toString());

  expect(result).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "restore schema gate failed (structure)\n",
  });
});
