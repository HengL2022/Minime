// M1 acceptance: migrations idempotent, seed loads, updated_at triggers fire,
// events append-only enforced, one round-trip per table.

import { beforeAll, describe, expect, test } from "bun:test";
import { migrate } from "../src/db/migrate";
import { expectSqlReject, resetDb, testSql as sql } from "./helpers";

beforeAll(async () => {
  await resetDb();
});

describe("migrations", () => {
  test("runner is idempotent: second run applies nothing", async () => {
    const second = await migrate();
    expect(second).toEqual([]);
  });

  test("all spec tables exist", async () => {
    const tables = (await sql`select tablename from pg_tables where schemaname = 'public'`).map(
      (r: any) => r.tablename,
    );
    for (const t of [
      "values_items",
      "goals",
      "principles",
      "tasks",
      "commitments",
      "decisions",
      "journal_entries",
      "people",
      "person_aliases",
      "interactions",
      "pages",
      "metric_defs",
      "metric_values",
      "edges",
      "events",
      "review_queue",
      "session_unlocks",
      "chunks",
      "calendar_events",
      "transactions",
      "health_samples",
      "email_meta",
      "inbox_items",
      "schema_migrations",
    ]) {
      expect(tables).toContain(t);
    }
  });
});

describe("events append-only (I8)", () => {
  test("insert works; update and delete are blocked", async () => {
    await sql`insert into events (actor, verb) values ('human', 'test:probe')`;
    const [row] = await sql`select id from events where verb = 'test:probe'`;
    expect(row).toBeDefined();
    await expectSqlReject(
      sql`update events set verb = 'tampered' where id = ${row!.id}`,
      /append-only/,
    );
    await expectSqlReject(sql`delete from events where id = ${row!.id}`, /append-only/);
    await expectSqlReject(sql`truncate events`, /append-only/);
  });
});

describe("standard columns & triggers", () => {
  test("updated_at trigger fires on update", async () => {
    const [t] =
      await sql`insert into tasks (title) values ('trigger probe') returning id, updated_at`;
    await Bun.sleep(10);
    await sql`update tasks set title = 'trigger probe 2' where id = ${t!.id}`;
    const [after] = await sql`select updated_at from tasks where id = ${t!.id}`;
    expect(new Date(after!.updated_at).getTime()).toBeGreaterThan(
      new Date(t!.updated_at).getTime(),
    );
  });

  test("tier constraints: journal defaults tier 2, transactions tier 0", async () => {
    const [j] = await sql`insert into journal_entries (entry_md) values ('probe') returning tier`;
    expect(j!.tier).toBe(2);
    const [tx] =
      await sql`insert into transactions (occurred_at, amount_cents, currency, account_label, external_ref)
      values ('2026-01-01', -100, 'SGD', 'probe-acct', 'probe-1') returning tier`;
    expect(tx!.tier).toBe(0);
  });
});

describe("seed + round-trips", () => {
  test("seed loads the demo dataset", async () => {
    const { seed } = await import("../fixtures/seed");
    const counts = await seed();
    expect(counts.pages).toBe(30);
    expect(counts.journal).toBe(20);
    expect(counts.people).toBe(10);
    expect(counts.decisions).toBe(8);
    expect(counts.transactions).toBe(200);
    expect(counts.health_samples).toBeGreaterThanOrEqual(500);
  });

  test("round-trip per table: every substantive table has rows with provenance", async () => {
    for (const t of [
      "values_items",
      "goals",
      "principles",
      "tasks",
      "commitments",
      "decisions",
      "journal_entries",
      "people",
      "interactions",
      "pages",
      "calendar_events",
      "transactions",
      "health_samples",
      "chunks",
      "edges",
    ]) {
      const [r] = await sql.unsafe(`select count(*)::int as n from "${t}"`);
      expect(r!.n, `table ${t} should have seeded rows`).toBeGreaterThan(0);
    }
    // provenance stamped (I5)
    const [bad] =
      await sql`select count(*)::int as n from pages where source is null or created_by is null`;
    expect(bad!.n).toBe(0);
  });

  test("metric_defs seeded with whitelisted agg_sql", async () => {
    const defs = (await sql`select name from metric_defs`).map((r: any) => r.name);
    for (const m of [
      "spend_total",
      "spend_by_category",
      "sleep_minutes",
      "steps",
      "deep_work_minutes",
      "journal_streak",
    ]) {
      expect(defs).toContain(m);
    }
  });
});
