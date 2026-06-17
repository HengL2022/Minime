// Test-only DB helpers. Raw SQL here is test scaffolding (reset + direct assertions),
// not an application read/write path — app code goes through src/db/repo.ts only.

import { sql } from "../src/db/client";
import { migrate } from "../src/db/migrate";

export { sql as testSql };

export async function resetDb(): Promise<void> {
  // Drop tables/functions but keep extensions (pgvector needs superuser to recreate).
  const tables = await sql`select tablename from pg_tables where schemaname = 'public'`;
  for (const t of tables) {
    await sql.unsafe(`drop table if exists "${t.tablename}" cascade`);
  }
  const fns = [
    "set_updated_at",
    "events_append_only",
    "edge_source_tier",
    "set_edge_tier",
    "app_allowed_tier",
    "metric_agg",
  ];
  for (const f of fns) {
    await sql.unsafe(`drop function if exists ${f} cascade`);
  }
  await migrate();
}

export async function resetAndSeed(): Promise<void> {
  await resetDb();
  const { seed } = await import("../fixtures/seed");
  await seed();
}

// bun's expect().rejects peeks at promise state without calling .then(), which never
// triggers postgres.js's lazy queries — so they hang. Await explicitly instead.
export async function expectSqlReject(q: PromiseLike<unknown>, re: RegExp): Promise<void> {
  try {
    await q;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!re.test(msg)) throw new Error(`rejected with wrong message: ${msg}`);
    return;
  }
  throw new Error(`query did not reject (expected ${re})`);
}

export async function countEvents(verbLike?: string): Promise<number> {
  if (verbLike) {
    const [r] = await sql`select count(*)::int as n from events where verb like ${verbLike}`;
    return r!.n;
  }
  const [r] = await sql`select count(*)::int as n from events`;
  return r!.n;
}
