// W4 role separation (improve-w4-roles.md). Probes run through a second postgres.js pool
// connected as minime_engineer_ro against the same minime_test database.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import {
  __safeRepairSummaryForTest,
  __setAfterPreImageRegisterForTest,
  __setRepairModuleForTest,
  runRepair,
} from "../scripts/repair";
import { config } from "../src/util/config";
import { expectSqlReject, resetDb, testSql } from "./helpers";
import {
  type TrackedTestSqlPoolHandle,
  registerTestDatabaseCloser,
  trackTestSqlPool,
} from "./setup";
import { type TestAppRoleLease, dropTestAppRole, mintTestAppRole } from "./support/app-role";

const roUrl = config.databaseUrl.replace(/\/\/[^@]+@/, "//minime_engineer_ro:minime@");
let ro: ReturnType<typeof postgres>;
let app: ReturnType<typeof postgres>;
let appRole: TestAppRoleLease;
let roClosePromise: Promise<void> | undefined;
let unregisterRo: (() => void) | undefined;
let appHeld: TrackedTestSqlPoolHandle | undefined;

function fixedCleanupError(): Error {
  return new Error("test_database_cleanup_failed");
}

function closeRoOnce(): Promise<void> {
  if (!roClosePromise) {
    const pool = ro;
    roClosePromise = Promise.resolve()
      .then(() => {
        return pool.end({ timeout: 5 });
      })
      .catch(() => {
        throw fixedCleanupError();
      });
  }
  return roClosePromise;
}

function openRoPool(): void {
  ro = postgres(roUrl, { max: 1, onnotice: () => {} });
  roClosePromise = undefined;
  unregisterRo = registerTestDatabaseCloser(closeRoOnce);
}

beforeAll(async () => {
  await resetDb();
  openRoPool();
  appRole = await mintTestAppRole(config.databaseUrl);
  app = postgres(appRole.databaseUrl, { max: 1, onnotice: () => {} });
  appHeld = trackTestSqlPool(app);
});

afterAll(async () => {
  if (!roClosePromise && !unregisterRo && !appHeld) return;
  try {
    await closeRoOnce();
    unregisterRo?.();
    unregisterRo = undefined;
    await appHeld?.close();
    appHeld?.unregister();
    appHeld = undefined;
    await dropTestAppRole(appRole);
  } catch {
    throw fixedCleanupError();
  }
});

describe("minime_engineer_ro", () => {
  test("can SELECT tier-1 content", async () => {
    await testSql`insert into tasks (title, tier) values ('visible task', 1)`;
    const rows = await ro`select title from tasks`;
    expect(rows.map((r) => r.title)).toContain("visible task");
  });

  test("runtime app keeps the audited pgvector write and distance-query surface", async () => {
    const vector = `[1,${Array.from({ length: 767 }, () => "0").join(",")}]`;
    const chunkId = crypto.randomUUID();
    await app`insert into chunks (id, parent_type, parent_id, ord, text, tier, embedding)
      values (${chunkId}, 'page', ${crypto.randomUUID()}, 0, 'vector boundary probe', 1,
              ${vector}::vector)`;
    const [row] = await app`
      select (embedding <=> ${vector}::vector)::float as distance
      from chunks where id = ${chunkId}`;
    expect(row!.distance).toBe(0);
  });

  test("RLS permanently hides tier-2 content from the engineering role", async () => {
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

  test("shared agent policies hide tier-zero generic prose from both app and engineering roles", async () => {
    await testSql`
      insert into pages (path, title, body_md, content_hash, tier)
      values
        ('roles/tier-zero.md', 'tier zero', 'TIER0-ROLE-SENTINEL', 'tier-zero-role', 0),
        ('roles/tier-one.md', 'tier one', 'TIER1-ROLE-SENTINEL', 'tier-one-role', 1)`;
    await testSql`
      insert into chunks (parent_type, parent_id, ord, text, tier)
      select 'page', id, 0, body_md, tier from pages
      where path in ('roles/tier-zero.md', 'roles/tier-one.md')`;

    const engineerPages = await ro`
      select body_md from pages where path like 'roles/tier-%' order by path`;
    const engineerChunks = await ro`
      select text from chunks where text like 'TIER%-ROLE-SENTINEL' order by text`;
    expect(engineerPages.map((row) => row.body_md)).toEqual(["TIER1-ROLE-SENTINEL"]);
    expect(engineerChunks.map((row) => row.text)).toEqual(["TIER1-ROLE-SENTINEL"]);

    const appRows = await app`
      select body_md from pages where path like 'roles/tier-%' order by path`;
    expect(appRows.map((row) => row.body_md)).toEqual(["TIER1-ROLE-SENTINEL"]);
  });

  test("tier-0 tables are not selectable at all (I3)", async () => {
    await expectSqlReject(ro`select * from transactions`, /permission denied/);
    await expectSqlReject(ro`select * from health_samples`, /permission denied/);
  });

  test("cannot inspect or replay an MCP session unlock", async () => {
    const actor = "agent:engineer-replay-fixture";
    const sessionId = crypto.randomUUID();
    const [request] = await app.begin(async (tx) => {
      await tx`select set_config('minime.actor', ${actor}, true)`;
      await tx`select set_config('minime.session_id', ${sessionId}, true)`;
      return tx`select app_request_tier2_unlock(5::smallint)::text as id`;
    });
    await testSql`
      update session_unlocks
      set approved_at = clock_timestamp(), approved_by = 'owner:test',
          expires_at = clock_timestamp() + interval '5 minutes'
      where id = ${request!.id}::uuid`;

    await expectSqlReject(ro`select * from session_unlocks`, /permission denied/);
    const [tier] = await ro.begin(async (tx) => {
      await tx`select set_config('minime.actor', ${actor}, true)`;
      await tx`select set_config('minime.session_id', ${sessionId}, true)`;
      return tx`select app_allowed_tier()::int as tier`;
    });
    expect(tier!.tier).toBe(1);
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

  test("future tables are private until a migration explicitly reviews and grants them", async () => {
    await testSql`create table zz_probe (id int, tier smallint not null default 1)`;
    try {
      await testSql`insert into zz_probe (id) values (1)`;
      await expectSqlReject(ro`select id from zz_probe`, /permission denied/);
      await expectSqlReject(ro`insert into zz_probe (id) values (2)`, /permission denied/);
    } finally {
      await testSql`drop table zz_probe`;
    }
  });

  test("chunk_spans is default-deny for engineer-ro even though app can write it", async () => {
    await expectSqlReject(ro`select text from chunk_spans`, /permission denied/);
    await expectSqlReject(
      ro`insert into chunk_spans (parent_type, parent_id, ord, text, tier)
         values ('page', gen_random_uuid(), 0, 'nope', 1)`,
      /permission denied/,
    );
  });

  test("un-tiered content carriers stay outside the engineering read boundary", async () => {
    await expectSqlReject(ro`select payload from review_queue`, /permission denied/);
    await expectSqlReject(ro`select reason from edge_validations`, /permission denied/);
    await expectSqlReject(ro`select payload from events`, /permission denied/);
    await expectSqlReject(ro`select * from session_unlocks`, /permission denied/);
    await expectSqlReject(ro`select * from inbox_items`, /permission denied/);
  });

  test("engineer SELECT privileges are an explicit reviewed allow-list", async () => {
    const rows = await testSql`
      select table_name
      from information_schema.role_table_grants
      where grantee = 'minime_engineer_ro' and privilege_type = 'SELECT'
        and table_schema = 'public'
      order by table_name`;
    expect(rows.map((row) => row.table_name)).toEqual([
      "calendar_events",
      "chunks",
      "commitments",
      "decision_branches",
      "decision_transcripts",
      "decisions",
      "edges",
      "email_meta",
      "goals",
      "interactions",
      "journal_entries",
      "metric_cache_state",
      "metric_defs",
      "metric_values",
      "org_aliases",
      "orgs",
      "pages",
      "people",
      "person_aliases",
      "person_dates",
      "principles",
      "schema_migrations",
      "tasks",
      "values_items",
    ]);
  });

  test("role, database, schema, sequence, and function authority is exact", async () => {
    const [posture] = await testSql`
      select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
             rolreplication, rolbypassrls
      from pg_roles where rolname = 'minime_engineer_ro'`;
    expect(posture).toEqual({
      rolcanlogin: true,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolreplication: false,
      rolbypassrls: false,
    });
    const memberships = await testSql`
      select granted.rolname
      from pg_auth_members membership
      join pg_roles granted on granted.oid = membership.roleid
      join pg_roles member on member.oid = membership.member
      where member.rolname = 'minime_engineer_ro'`;
    expect(memberships.length).toBe(0);

    const nonSelect = await testSql`
      select table_name, privilege_type
      from information_schema.role_table_grants
      where grantee = 'minime_engineer_ro' and table_schema = 'public'
        and privilege_type <> 'SELECT'`;
    expect(nonSelect.length).toBe(0);
    const sequences = await testSql`
      select object_name, privilege_type
      from information_schema.role_usage_grants
      where grantee = 'minime_engineer_ro' and object_schema = 'public'`;
    expect(sequences.length).toBe(0);
    const routines = await testSql`
      select routine_name, privilege_type
      from information_schema.role_routine_grants
      where grantee = 'minime_engineer_ro' and routine_schema = 'public'
      order by routine_name, privilege_type`;
    expect(routines.map((row) => ({ ...row }))).toEqual([
      { routine_name: "app_allowed_tier", privilege_type: "EXECUTE" },
      { routine_name: "metric_agg", privilege_type: "EXECUTE" },
    ]);

    const [authority] = await testSql`
      select
        has_database_privilege('minime_engineer_ro', current_database(), 'CONNECT') as connect,
        has_database_privilege('minime_engineer_ro', current_database(), 'CREATE') as db_create,
        has_database_privilege('minime_engineer_ro', current_database(), 'TEMPORARY') as db_temp,
        has_schema_privilege('minime_engineer_ro', 'public', 'USAGE') as schema_usage,
        has_schema_privilege('minime_engineer_ro', 'public', 'CREATE') as schema_create`;
    expect(authority).toEqual({
      connect: true,
      db_create: false,
      db_temp: false,
      schema_usage: true,
      schema_create: false,
    });
    await expectSqlReject(ro`select cjk_fold('not allowlisted')`, /permission denied/);
    await expectSqlReject(
      ro`create temporary table no_engineer_temp (id int)`,
      /permission denied/,
    );
    await expectSqlReject(ro`create schema no_engineer_schema`, /permission denied/);
  });

  test("live role repair fails closed on ownership and removes contaminated residual authority", async () => {
    const suffix = `${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const engineerRole = `minime_engineer_fixture_${suffix}`;
    const carrierRole = `minime_engineer_carrier_${suffix}`;
    const quoteIdentifier = (value: string): string => {
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("invalid_fixture_role");
      return `"${value}"`;
    };
    const engineer = quoteIdentifier(engineerRole);
    const carrier = quoteIdentifier(carrierRole);
    const migration = readFileSync(
      join(process.cwd(), "db/migrations/024_engineer_content_boundary.sql"),
      "utf8",
    );
    expect(migration.match(/current_database\(\) = 'minime'/g)).toHaveLength(1);
    const fixtureMigration = migration
      .replaceAll("minime_engineer_ro", engineerRole)
      // 026 replaced the three-argument function; this fixture replays 024's role repair
      // posture against the current catalog rather than recreating the retired overload.
      .replaceAll("metric_agg(text, date, date)", "metric_agg(text, date, date, text)")
      .replaceAll("metric_agg(text,date,date)", "metric_agg(text,date,date,text)")
      .replace("current_database() = 'minime'", "current_database() = current_database()");
    const runFixtureMigration = () =>
      testSql.begin(async (tx) => {
        await tx.unsafe(fixtureMigration);
      });

    try {
      await testSql.unsafe(`create role ${engineer} login noinherit`);
      await testSql.unsafe(`create role ${carrier} noinherit`);
      await testSql.unsafe(`grant ${engineer} to minime`);
      await testSql.unsafe(`grant create on schema public to ${engineer}`);
      await testSql.begin(async (tx) => {
        await tx.unsafe(`set local role ${engineer}`);
        await tx`create table zz_engineer_fixture_owned (id int)`;
      });
      await expect(runFixtureMigration()).rejects.toThrow("engineer_role_posture_invalid");
      await testSql`drop table zz_engineer_fixture_owned`;

      // Leave the inbound membership planted; the replay must remove it as well as the
      // outbound membership and every database-local authority below.
      await testSql.unsafe(`alter role ${engineer} createdb createrole inherit`);
      await testSql.unsafe(`grant ${carrier} to ${engineer}`);
      await testSql.unsafe(`grant ${carrier} to minime`);
      await testSql.unsafe(`grant select on transactions to ${carrier} with grant option`);
      await testSql.begin(async (tx) => {
        await tx.unsafe(`set local role ${carrier}`);
        await tx.unsafe(`grant select on transactions to ${engineer}`);
      });
      await testSql.unsafe(`grant all privileges on tasks to ${engineer}`);
      await testSql.unsafe(`grant all privileges on sequence events_id_seq to ${engineer}`);
      await testSql.unsafe(`grant execute on function cjk_fold(text) to ${engineer}`);
      await testSql.unsafe(`grant create on schema public to ${engineer}`);
      const [database] = await testSql`select current_database() as name`;
      const databaseName = quoteIdentifier(String(database!.name));
      await testSql.unsafe(`grant create, temporary on database ${databaseName} to ${engineer}`);
      await testSql.unsafe(
        `alter default privileges in schema public grant all on tables to ${engineer}`,
      );
      await testSql.unsafe(
        `alter default privileges in schema public grant all on sequences to ${engineer}`,
      );
      await testSql.unsafe(
        `alter default privileges in schema public grant all on functions to ${engineer}`,
      );

      // A grant issued while acting as another grantor cannot be silently repaired by the
      // migration owner. The catalog postcondition must stop the replay until that grantor
      // explicitly removes its ACL; after that, the same migration closes the remaining
      // owner-repairable posture.
      await expect(runFixtureMigration()).rejects.toThrow("engineer_role_posture_invalid");
      await testSql.begin(async (tx) => {
        await tx.unsafe(`set local role ${carrier}`);
        await tx.unsafe(`revoke select on transactions from ${engineer}`);
      });
      await runFixtureMigration();

      const [closed] = await testSql`
        select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
               rolreplication, rolbypassrls
        from pg_roles where rolname = ${engineerRole}`;
      expect({
        rolcanlogin: closed!.rolcanlogin,
        rolsuper: closed!.rolsuper,
        rolcreatedb: closed!.rolcreatedb,
        rolcreaterole: closed!.rolcreaterole,
        rolinherit: closed!.rolinherit,
        rolreplication: closed!.rolreplication,
        rolbypassrls: closed!.rolbypassrls,
      }).toEqual({
        rolcanlogin: true,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
      });
      const residual = await testSql`
        select 1 from pg_auth_members membership
        where membership.member = (select oid from pg_roles where rolname = ${engineerRole})
           or (
             membership.roleid = (select oid from pg_roles where rolname = ${engineerRole})
             and (
               membership.member <> (select oid from pg_roles where rolname = current_user)
               or membership.inherit_option or membership.set_option
             )
           )
        union all
        select 1 from pg_default_acl defaults
        cross join lateral aclexplode(defaults.defaclacl) acl
        where defaults.defaclobjtype in ('r', 'S', 'f')
          and acl.grantee in (0, (select oid from pg_roles where rolname = ${engineerRole}))`;
      expect(residual.length).toBe(0);
      const direct = await testSql`
        select privilege_type from information_schema.role_table_grants
        where grantee = ${engineerRole} and table_schema = 'public'
          and privilege_type <> 'SELECT'
        union all
        select privilege_type from information_schema.role_usage_grants
        where grantee = ${engineerRole} and object_schema = 'public'`;
      expect(direct.length).toBe(0);
    } finally {
      await testSql`drop table if exists zz_engineer_fixture_owned`.catch(() => {});
      await testSql.unsafe(`revoke ${carrier} from ${engineer}`).catch(() => {});
      await testSql.unsafe(`revoke ${engineer} from minime`).catch(() => {});
      await testSql.unsafe(`revoke ${carrier} from minime`).catch(() => {});
      await testSql
        .unsafe(`revoke all privileges on transactions from ${carrier} cascade`)
        .catch(() => {});
      await testSql.unsafe(`drop owned by ${engineer}`).catch(() => {});
      await testSql.unsafe(`drop owned by ${carrier}`).catch(() => {});
      await testSql.unsafe(`drop role if exists ${engineer}`).catch(() => {});
      await testSql.unsafe(`drop role if exists ${carrier}`).catch(() => {});
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

  test("tier_read lower bounds preserve the exact shared roles and tier-zero table revokes", async () => {
    const expectedTables = [
      "calendar_events",
      "chunk_spans",
      "chunks",
      "commitments",
      "decision_branches",
      "decision_transcripts",
      "decisions",
      "edges",
      "email_meta",
      "goals",
      "inbox_items",
      "interactions",
      "journal_entries",
      "org_aliases",
      "orgs",
      "pages",
      "people",
      "person_aliases",
      "person_dates",
      "principles",
      "tasks",
      "values_items",
    ];
    const policies = await testSql`
      select tablename, roles, qual
      from pg_policies
      where schemaname = 'public' and policyname = 'tier_read'
      order by tablename`;
    expect(policies.map((row) => row.tablename)).toEqual(expectedTables);
    for (const policy of policies) {
      expect([...policy.roles].sort()).toEqual(["minime_app", "minime_engineer_ro"]);
      expect(policy.qual.replaceAll(/[()]/g, "")).toContain("tier >= 1");
      expect(policy.qual.replaceAll(/[()]/g, "")).toContain("tier <= app_allowed_tier");
    }
    const engineerPrivileges = await testSql`
      select table_name, privilege_type
      from information_schema.role_table_grants
      where grantee = 'minime_engineer_ro'
        and table_name in ('pages', 'transactions', 'health_samples')
      order by table_name, privilege_type`;
    expect(
      engineerPrivileges.map((row) => ({
        table_name: row.table_name,
        privilege_type: row.privilege_type,
      })),
    ).toEqual([{ table_name: "pages", privilege_type: "SELECT" }]);
  });
});

describe("repair runner", () => {
  let dumpScratch: string;
  let dumpDir: string;

  beforeAll(() => {
    dumpScratch = realpathSync(mkdtempSync(join(tmpdir(), "minime-m15-repairs-")));
    dumpDir = join(dumpScratch, "db-dump");
  });
  afterAll(() => {
    rmSync(dumpScratch, { recursive: true, force: true });
  });

  test("refuses an unknown/uncommitted script name", async () => {
    expect(await runRepair("no-such-repair", [], { dumpDir })).toBe(1);
  });

  test("repair module override is reset after every exit", async () => {
    __setRepairModuleForTest({
      name: "fixture",
      description: "fixture",
      run: async () => ({ counts: {}, ids: [] }),
    });
    expect(await runRepair("no-such-repair", [], { dumpDir })).toBe(1);
    // A subsequent committed run must import the real module rather than retaining the seam.
    expect(await runRepair("retype-org-to-person", [], { dumpDir })).toBe(1);
  });

  test.each([Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "legacy repair summary rejects invalid edge count %p",
    (count) => {
      expect(
        __safeRepairSummaryForTest({ person_id: "person", edges_repointed: count }),
      ).toBeUndefined();
    },
  );

  test("repair revalidates the private root after pre-image registration", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-m15-revalidate-")));
    const privateRoot = join(root, "db-dump");
    __setAfterPreImageRegisterForTest(() => chmodSync(privateRoot, 0o755));
    try {
      expect(await runRepair("retype-org-to-person", [], { dumpDir: privateRoot })).toBe(1);
    } finally {
      __setAfterPreImageRegisterForTest(undefined);
      chmodSync(privateRoot, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a committed script whose working-tree file differs from HEAD", async () => {
    const path = `${process.cwd()}/scripts/repairs/retype-org-to-person.ts`;
    const saved = readFileSync(path); // restored via fs below, never via git commands
    const [prev] = await testSql`select coalesce(max(id), 0)::int as max_id from events`;
    try {
      writeFileSync(path, Buffer.concat([saved, Buffer.from("\n// dirty")]));
      expect(await runRepair("retype-org-to-person", [], { dumpDir })).toBe(1);
      const events = await testSql`
        select id from events where verb like 'repair:%' and id > ${prev!.max_id}`;
      expect(events.length).toBe(1);
    } finally {
      writeFileSync(path, saved);
    }
    expect(readFileSync(path).equals(saved)).toBe(true); // original bytes back in place
  });

  test("refuses when the backup cannot be written (no backup ⇒ no repair)", async () => {
    if (!Bun.which("pg_dump")) return; // environment without client tools
    const orgId = (
      await testSql`insert into orgs (canonical_name, tier) values ('Retypable Ltd', 1) returning id`
    )[0]!.id;
    const code = await runRepair("retype-org-to-person", [`--org-id=${orgId}`], {
      dumpDir: "/nonexistent-dir/deny",
    });
    expect(code).toBe(1);
    const [org] = await testSql`select retired_at from orgs where id = ${orgId}`;
    expect(org!.retired_at).toBeNull(); // nothing ran
  });

  test("happy path: backup taken, repair applied, repair:* events logged, payload ids/counts only", async () => {
    if (!Bun.which("pg_dump")) return; // environment without client tools
    const orgId = (
      await testSql`insert into orgs (canonical_name, tier) values ('Quill Marbury', 1) returning id`
    )[0]!.id;
    const [prev] = await testSql`select coalesce(max(id), 0)::int as max_id from events`;
    const code = await runRepair(
      "retype-org-to-person",
      [`--org-id=${orgId}`, "--relation=friend"],
      { dumpDir },
    );
    expect(code).toBe(0);
    const [org] = await testSql`select retired_at from orgs where id = ${orgId}`;
    expect(org!.retired_at).not.toBeNull(); // retired, not deleted (reversible-repair contract)
    const [person] = await testSql`select id from people where canonical_name = 'Quill Marbury'`;
    expect(person).toBeTruthy();
    const events = await testSql`select verb, payload from events
      where verb like 'repair:%' and id > ${prev!.max_id} order by id`;
    expect(events.map((e) => e.verb)).toEqual(["repair:retype-org-to-person"]);
    expect(events[0]!.payload).toMatchObject({ phase: "complete", code: "repair_complete" });
    expect(events[0]!.payload).not.toHaveProperty("backup");
    expect(JSON.stringify(events)).not.toContain("Quill Marbury"); // counts/ids only, never contents
    const backups = [...new Bun.Glob("repair-retype-org-to-person-*.sql").scanSync(dumpDir)];
    expect(backups.length).toBeGreaterThan(0);
  });

  test("completion-audit failure rolls back the repair mutation", async () => {
    if (!Bun.which("pg_dump")) return; // environment without client tools
    const name = "Audit Rollback Fixture";
    const orgId = (
      await testSql`insert into orgs (canonical_name, tier) values (${name}, 1) returning id`
    )[0]!.id;
    const [marker] = await testSql`select coalesce(max(id), 0)::bigint as id from events`;
    await testSql.unsafe(`
      create or replace function zz_reject_repair_complete() returns trigger language plpgsql as $$
      begin
        if new.actor = 'system:repair' and new.payload ->> 'phase' = 'complete' then
          raise exception 'injected repair completion audit failure';
        end if;
        return new;
      end;
      $$;
      create trigger zz_reject_repair_complete
        before insert on events for each row execute function zz_reject_repair_complete();
    `);
    try {
      expect(await runRepair("retype-org-to-person", [`--org-id=${orgId}`], { dumpDir })).toBe(1);
      const [org] = await testSql`select retired_at from orgs where id = ${orgId}`;
      expect(org!.retired_at).toBeNull();
      const [people] =
        await testSql`select count(*)::int as n from people where canonical_name = ${name}`;
      expect(people!.n).toBe(0);
      const events = await testSql`
        select payload from events
        where id > ${marker!.id}::bigint and verb = 'repair:retype-org-to-person'
        order by id`;
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({
        phase: "failed",
        code: "repair_audit_failed",
      });
    } finally {
      await testSql`drop trigger if exists zz_reject_repair_complete on events`;
      await testSql`drop function if exists zz_reject_repair_complete()`;
    }
  });

  test("failure path: backup precedes run, failed event content-free, exit 1", async () => {
    if (!Bun.which("pg_dump")) return; // environment without client tools
    const fakeId = crypto.randomUUID(); // well-formed, matches no org
    // events accumulate across this file — scope to this invocation via the identity pk
    const [prev] = await testSql`select coalesce(max(id), 0)::int as max_id from events`;
    const glob = new Bun.Glob("repair-retype-org-to-person-*.sql");
    const backupsBefore = [...glob.scanSync(dumpDir)].length;
    const code = await runRepair("retype-org-to-person", [`--org-id=${fakeId}`], { dumpDir });
    expect(code).toBe(1); // repair threw AFTER the backup gate — not a refusal (2)
    const events = await testSql`select verb, payload from events
      where verb like 'repair:%' and id > ${prev!.max_id} order by id`;
    expect(events.length).toBe(1);
    expect(events[0]!.payload.phase).toBe("failed");
    const dump = JSON.stringify(events);
    expect(dump).not.toContain(fakeId);
    expect(dump).not.toContain("Quill Marbury"); // …never row contents
    expect(dump).not.toContain("Retypable");
    const backupsAfter = [...glob.scanSync(dumpDir)].length;
    expect(backupsAfter).toBe(backupsBefore + 1); // backup precedes run by design
  });

  test.each(["symlink", "directory", "regular"] as const)(
    "repair rejects a post-pg_dump %s pre-image replacement and retains it",
    async (replacement) => {
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), `minime-m15-replacement-${replacement}-`)),
      );
      const privateRoot = join(root, "db-dump");
      const foreign = join(root, "foreign-target.sql");
      mkdirSync(privateRoot, { mode: 0o700 });
      writeFileSync(foreign, "-- foreign target --\n", { mode: 0o600 });
      const fakeBin = join(root, "bin");
      mkdirSync(fakeBin, { mode: 0o700 });
      const fakePgDump = join(fakeBin, "pg_dump");
      writeFileSync(
        fakePgDump,
        `#!/bin/sh
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = -f ]; then out="$2"; shift 2; else shift; fi
done
printf '%s\\n' '-- initial dump --' > "$out"
/bin/rm -f -- "$out"
if [ "${replacement}" = symlink ]; then
  /bin/ln -s "${foreign}" "$out"
elif [ "${replacement}" = directory ]; then
  /bin/mkdir "$out"
else
  printf '%s\\n' '-- replacement dump --' > "$out"
fi
exit 0
`,
        { mode: 0o700 },
      );
      chmodSync(fakePgDump, 0o700);
      const oldPath = process.env.PATH;
      process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;
      __setRepairModuleForTest({
        name: "fixture",
        description: "fixture",
        run: async () => ({ counts: {}, ids: [] }),
      });
      try {
        expect(await runRepair("retype-org-to-person", [], { dumpDir: privateRoot })).toBe(1);
      } finally {
        process.env.PATH = oldPath;
        __setRepairModuleForTest(undefined);
      }
      expect(readFileSync(foreign, "utf8")).toBe("-- foreign target --\n");
      const replacementName = readdirSync(privateRoot).find((name) => name.startsWith("repair-"));
      expect(replacementName).toBeTruthy();
      const replacementStat = lstatSync(join(privateRoot, replacementName!));
      if (replacement === "symlink") expect(replacementStat.isSymbolicLink()).toBe(true);
      if (replacement === "directory") expect(replacementStat.isDirectory()).toBe(true);
      if (replacement === "regular") expect(replacementStat.isFile()).toBe(true);
      rmSync(root, { recursive: true, force: true });
    },
  );
});
