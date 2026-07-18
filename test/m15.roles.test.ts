// W4 role separation (improve-w4-roles.md). Probes run through a second postgres.js pool
// connected as minime_engineer_ro against the same minime_test database.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { runRepair } from "../scripts/repair";
import { config } from "../src/util/config";
import { expectSqlReject, resetDb, testSql } from "./helpers";

const roUrl = config.databaseUrl.replace(/\/\/[^@]+@/, "//minime_engineer_ro:minime@");
let ro: ReturnType<typeof postgres>;

beforeAll(async () => {
  await resetDb();
  ro = postgres(roUrl, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  await ro.end({ timeout: 5 });
});

describe("minime_engineer_ro", () => {
  test("can SELECT tier-1 content", async () => {
    await testSql`insert into tasks (title, tier) values ('visible task', 1)`;
    const rows = await ro`select title from tasks`;
    expect(rows.map((r) => r.title)).toContain("visible task");
  });

  test("RLS hides tier-2 content without an unlock (engineering sessions are agent sessions)", async () => {
    await testSql`insert into journal_entries (entry_md, tier) values ('secret diary', 2)`;
    const rows = await ro`select entry_md from journal_entries`;
    expect(rows.length).toBe(0);
  });

  // Highest-value probe in the file: chunk text is where tier-2 content actually lives
  // (chunks feed search/context assembly). Proves RLS does real tier filtering here, not
  // just a blanket allow/deny.
  test("RLS scopes chunks by tier (chunk text is where tier-2 content actually lives)", async () => {
    await testSql`insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('journal', gen_random_uuid(), 0, 'visible chunk', 1)`;
    await testSql`insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('journal', gen_random_uuid(), 0, 'secret chunk', 2)`;
    const rows = await ro`select text from chunks`;
    expect(rows.map((r) => r.text)).toContain("visible chunk");
    expect(rows.map((r) => r.text)).not.toContain("secret chunk");
  });

  test("tier-0 tables are not selectable at all (I3)", async () => {
    await expectSqlReject(ro`select * from transactions`, /permission denied/);
    await expectSqlReject(ro`select * from health_samples`, /permission denied/);
  });

  test("every write verb is denied: INSERT / UPDATE / DELETE / TRUNCATE", async () => {
    await expectSqlReject(ro`insert into tasks (title) values ('nope')`, /permission denied/);
    await expectSqlReject(ro`update tasks set title = 'nope'`, /permission denied/);
    await expectSqlReject(ro`delete from tasks`, /permission denied/);
    await expectSqlReject(ro`truncate tasks`, /permission denied/);
    await expectSqlReject(
      ro`insert into events (actor, verb) values ('x', 'y')`,
      /permission denied/,
    );
  });

  test("future tables are covered by default privileges (SELECT only)", async () => {
    await testSql`create table zz_probe (id int, tier smallint not null default 1)`;
    try {
      await testSql`insert into zz_probe (id) values (1)`;
      const rows = await ro`select id from zz_probe`;
      expect(rows.length).toBe(1);
      await expectSqlReject(ro`insert into zz_probe (id) values (2)`, /permission denied/);
    } finally {
      await testSql`drop table zz_probe`;
    }
  });

  // Guard against the exact gap found while building 018: Postgres RLS policy TO-lists are
  // role-scoped, so `grant select` alone is NOT sufficient for a role that isn't named in an
  // applicable policy — it silently gets zero rows at every tier, not just tier-2 (verified
  // against a live instance before writing the fix). If a future migration adds a tier_read
  // policy "to minime_app" on a new table and forgets to also extend it to
  // minime_engineer_ro, this test fails immediately instead of quietly over-hiding tier-1
  // content from engineering sessions.
  test("every tier_read policy scoped to minime_app also covers minime_engineer_ro", async () => {
    const gaps = await testSql`
      select tablename from pg_policies
      where schemaname = 'public' and policyname = 'tier_read'
        and 'minime_app' = any(roles) and not ('minime_engineer_ro' = any(roles))`;
    expect(gaps.map((g) => g.tablename)).toEqual([]);
  });
});

describe("repair runner", () => {
  const dumpDir = `${process.cwd()}/db-dump/test-repairs`;

  test("refuses an unknown/uncommitted script name", async () => {
    expect(await runRepair("no-such-repair", [], { dumpDir })).toBe(2);
  });

  test("refuses when the backup cannot be written (no backup ⇒ no repair)", async () => {
    const orgId = (
      await testSql`insert into orgs (canonical_name, tier) values ('Retypable Ltd', 1) returning id`
    )[0]!.id;
    const code = await runRepair("retype-org-to-person", [`--org-id=${orgId}`], {
      dumpDir: "/nonexistent-dir/deny",
    });
    expect(code).toBe(2);
    const [org] = await testSql`select retired_at from orgs where id = ${orgId}`;
    expect(org!.retired_at).toBeNull(); // nothing ran
  });

  test("happy path: backup taken, repair applied, repair:* events logged, summary counts only", async () => {
    if (!Bun.which("pg_dump")) return; // environment without client tools
    const orgId = (
      await testSql`insert into orgs (canonical_name, tier) values ('Hai Yan', 1) returning id`
    )[0]!.id;
    const code = await runRepair(
      "retype-org-to-person",
      [`--org-id=${orgId}`, "--relation=friend"],
      { dumpDir },
    );
    expect(code).toBe(0);
    const [org] = await testSql`select retired_at from orgs where id = ${orgId}`;
    expect(org!.retired_at).not.toBeNull(); // retired, not deleted (reversible-repair contract)
    const [person] = await testSql`select id from people where canonical_name = 'Hai Yan'`;
    expect(person).toBeTruthy();
    const events =
      await testSql`select verb, payload from events where verb like 'repair:%' order by id`;
    expect(events.map((e) => e.verb)).toEqual([
      "repair:retype-org-to-person",
      "repair:retype-org-to-person",
    ]);
    expect(events[0]!.payload.backup).toContain("repair-retype-org-to-person");
    expect(JSON.stringify(events)).not.toContain("Hai Yan"); // counts/ids only, never contents
    const backups = [...new Bun.Glob("repair-retype-org-to-person-*.sql").scanSync(dumpDir)];
    expect(backups.length).toBeGreaterThan(0);
  });
});
