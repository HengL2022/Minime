import { expect, test } from "bun:test";
import postgres from "postgres";

test("reports the checked-out migration ledger for the process database", async () => {
  const url = process.env.DATABASE_URL;
  expect(url).toBeTruthy();
  const sql = postgres(url!, { max: 1 });
  try {
    const [{ name }] = await sql<[{ name: string }]>`select current_database() as name`;
    const [{ n }] = await sql<[{ n: number }]>`select count(*)::int as n from schema_migrations`;
    expect(name).toMatch(/^minime_test_[a-z0-9_]+$/);
    expect(Number(n)).toBeGreaterThan(0);
    console.log(JSON.stringify({ name, migrations: Number(n) }));
  } finally {
    await sql.end({ timeout: 5 });
  }
});
