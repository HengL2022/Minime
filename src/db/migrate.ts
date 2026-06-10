import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "./client";

const MIGRATIONS_DIR = join(import.meta.dir, "../../db/migrations");

// Plain numbered .sql files, applied once each, tracked in schema_migrations.
// Re-running is a no-op (M1 AC: runner is idempotent).
export async function migrate(): Promise<string[]> {
  await sql`create table if not exists schema_migrations (
    name text primary key, applied_at timestamptz not null default now()
  )`;
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set(
    (await sql`select name from schema_migrations`).map((r) => r.name as string),
  );
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const body = await Bun.file(join(MIGRATIONS_DIR, file)).text();
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${file})`;
    });
    ran.push(file);
  }
  return ran;
}
