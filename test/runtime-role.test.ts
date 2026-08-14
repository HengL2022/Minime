import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { ensureRuntimeDsn } from "../scripts/eval-search-worker";
import { expectSqlReject, resetDb, testSql } from "./helpers";
import { type TrackedTestSqlPoolHandle, trackTestSqlPool } from "./setup";
import { dropTestAppRole, mintTestAppRole, resolveTestAppPassword } from "./support/app-role";

describe("stable runtime app credential", () => {
  test("preserves an explicitly configured password", () => {
    expect(
      resolveTestAppPassword({
        env: { MINIME_APP_PASSWORD: "configured_test_password_20260805" },
        allowRepoDotenv: false,
      }),
    ).toBe("configured_test_password_20260805");
  });

  test("preserves the endpoint password without generating a replacement", () => {
    expect(
      resolveTestAppPassword({
        env: {
          MINIME_APP_DATABASE_URL:
            "postgres://minime_app:endpoint_test_password_20260805@127.0.0.1:5432/minime",
        },
        allowRepoDotenv: false,
      }),
    ).toBe("endpoint_test_password_20260805");
  });

  test("fails closed when explicit and endpoint credentials disagree", () => {
    expect(() =>
      resolveTestAppPassword({
        env: {
          MINIME_APP_PASSWORD: "explicit_test_password_20260805",
          MINIME_APP_DATABASE_URL:
            "postgres://minime_app:endpoint_test_password_20260805@127.0.0.1:5432/minime",
        },
        allowRepoDotenv: false,
      }),
    ).toThrow("test_app_role_credentials_mismatch");
  });

  test("uses only the deterministic fallback when no runtime credential is configured", () => {
    const first = resolveTestAppPassword({ env: {}, allowRepoDotenv: false });
    const second = resolveTestAppPassword({ env: {}, allowRepoDotenv: false });
    expect(first).toMatch(/^[A-Za-z0-9_-]{24,128}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{24,128}$/);
  });

  test("never reads the repository dotenv when resolving test credentials", () => {
    const source = readFileSync(resolve(import.meta.dir, "support/app-role.ts"), "utf8");
    expect(source).not.toMatch(/readFileSync|resolve\([^)]*["']\.env["']/);
  });
});

describe("eval worker runtime boundary", () => {
  const saved = new Map<string, string | undefined>();
  const envNames = ["DATABASE_URL", "EVAL_DATABASE_URL", "MINIME_APP_DATABASE_URL"];

  function setEnv(values: Record<string, string>): void {
    for (const name of envNames) {
      saved.set(name, process.env[name]);
      if (values[name] === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = values[name];
    }
  }

  function restoreEnv(): void {
    for (const name of envNames) {
      const value = saved.get(name);
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    saved.clear();
  }

  test("accepts only equal loopback guarded app DSNs", () => {
    const dsn =
      "postgres://minime_test_app_eval:test_password_20260805@127.0.0.1:5432/minime_test_eval";
    setEnv({ DATABASE_URL: dsn, EVAL_DATABASE_URL: dsn, MINIME_APP_DATABASE_URL: dsn });
    try {
      expect(() => ensureRuntimeDsn()).not.toThrow();
      expect(process.env.DATABASE_URL).toBe(dsn);
    } finally {
      restoreEnv();
    }
  });

  test("rejects a non-loopback, unguarded, or owner-role eval DSN", () => {
    const cases = [
      "postgres://minime_test_app_eval:test_password_20260805@example.test:5432/minime_test_eval",
      "postgres://minime_test_app_eval:test_password_20260805@127.0.0.1:5432/minime",
      "postgres://minime:test_password_20260805@127.0.0.1:5432/minime_test_eval",
    ];
    for (const dsn of cases) {
      setEnv({ DATABASE_URL: dsn, EVAL_DATABASE_URL: dsn, MINIME_APP_DATABASE_URL: dsn });
      try {
        expect(() => ensureRuntimeDsn()).toThrow();
      } finally {
        restoreEnv();
      }
    }
  });

  test("rejects mismatched runtime and eval DSNs before corpus loading", () => {
    const runtime =
      "postgres://minime_test_app_eval:test_password_20260805@127.0.0.1:5432/minime_test_eval";
    const evalUrl =
      "postgres://minime_test_app_eval:test_password_20260805@127.0.0.1:5432/minime_test_other";
    setEnv({ DATABASE_URL: runtime, EVAL_DATABASE_URL: evalUrl, MINIME_APP_DATABASE_URL: runtime });
    try {
      expect(() => ensureRuntimeDsn()).toThrow("eval_worker_runtime_dsn_invalid");
    } finally {
      restoreEnv();
    }
  });
});

let app: ReturnType<typeof postgres>;
let appRole: Awaited<ReturnType<typeof mintTestAppRole>>;
let appHeld: TrackedTestSqlPoolHandle | undefined;

beforeAll(async () => {
  await resetDb();
  appRole = await mintTestAppRole(process.env.DATABASE_URL!);
  app = postgres(appRole.databaseUrl, { max: 1, onnotice: () => {} });
  appHeld = trackTestSqlPool(app);
});

afterAll(async () => {
  await appHeld?.close();
  appHeld?.unregister();
  if (appRole) await dropTestAppRole(appRole);
});

describe("unique scratch app runtime boundary", () => {
  test("uses the restricted role and cannot read tier-0 tables", async () => {
    const [identity] = await app`select current_user as role`;
    expect(identity?.role).toBe(appRole.roleName);
    const [functions] = await app`
      select
        has_function_privilege(current_user, 'public.app_allowed_tier()', 'EXECUTE') as app_allowed,
        has_function_privilege(current_user, 'public.app_request_tier2_unlock(smallint)', 'EXECUTE') as unlock_request,
        has_function_privilege(current_user, 'public.metric_agg(text,date,date,text)', 'EXECUTE') as metric_agg,
        has_function_privilege(current_user, 'public.cjk_fold(text)', 'EXECUTE') as cjk_fold,
        has_function_privilege(current_user, 'public.edge_source_tier(text,uuid)', 'EXECUTE') as raw_edge_source,
        has_function_privilege(current_user, 'public.readable_source_tier(text,uuid)', 'EXECUTE') as readable_source,
        has_schema_privilege(current_user, 'public', 'CREATE') as schema_create`;
    expect(functions?.app_allowed).toBe(true);
    expect(functions?.unlock_request).toBe(true);
    expect(functions?.metric_agg).toBe(true);
    expect(functions?.cjk_fold).toBe(true);
    expect(functions?.raw_edge_source).toBe(false);
    expect(functions?.readable_source).toBe(true);
    expect(functions?.schema_create).toBe(false);
    const [publicFunctions] = await testSql`
      select
        has_function_privilege('public', 'public.app_allowed_tier()', 'EXECUTE') as app_allowed,
        has_function_privilege('public', 'public.app_request_tier2_unlock(smallint)', 'EXECUTE') as unlock_request,
        has_function_privilege('public', 'public.metric_agg(text,date,date,text)', 'EXECUTE') as metric_agg`;
    expect(publicFunctions).toEqual({
      app_allowed: false,
      unlock_request: false,
      metric_agg: false,
    });
    const [metricFunction] = await testSql`
      select to_regprocedure('public.metric_agg(text,date,date)') is null as old_removed,
             routine.prosecdef as security_definer,
             routine.proconfig as settings
      from pg_proc routine
      where routine.oid = 'public.metric_agg(text,date,date,text)'::regprocedure`;
    expect(metricFunction).toEqual({
      old_removed: true,
      security_definer: true,
      settings: ["search_path=pg_catalog, public, pg_temp"],
    });
    const [membership] = await testSql`
      select count(*)::int as n
      from pg_auth_members m
      join pg_roles member on member.oid = m.member
      where member.rolname = ${appRole.roleName}`;
    expect(Number(membership?.n)).toBe(0);
    const [catalogAcl] = await app`
      select coalesce(bool_or(grantee::text = ${appRole.roleName}), false) as explicit_grant
      from aclexplode((select proacl from pg_catalog.pg_proc
                       where oid = 'pg_catalog.pg_control_system()'::regprocedure))`;
    expect(catalogAcl?.explicit_grant).toBe(false);
    await expectSqlReject(app`select * from transactions`, /permission denied/);
    await expectSqlReject(app`select * from health_samples`, /permission denied/);
    const [metricCache] = await app`
      select
        has_table_privilege(current_user, 'public.metric_values', 'SELECT') as can_select,
        has_table_privilege(current_user, 'public.metric_values', 'INSERT') as can_insert,
        has_table_privilege(current_user, 'public.metric_values', 'UPDATE') as can_update`;
    expect(metricCache).toEqual({ can_select: true, can_insert: false, can_update: false });
    const aggregateOnly =
      await app`select * from metric_agg('steps', '2026-01-01', '2026-01-02', 'UTC')`;
    expect(aggregateOnly).toHaveLength(0);
    await expectSqlReject(
      app`insert into metric_values (metric, period_start, granularity, value, source)
          values ('steps', '2026-01-01', 'day', 1, 'runtime-caller')`,
      /permission denied/,
    );
  });

  test("scratch role has no memberships or unsafe attributes", async () => {
    const [posture] = await testSql`
      select rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit, rolreplication,
             rolcanlogin
      from pg_roles where rolname = ${appRole.roleName}`;
    expect(posture).toEqual({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
      rolinherit: false,
      rolreplication: false,
      rolcanlogin: true,
    });
    const [membership] = await testSql`
      select count(*)::int as n
      from pg_auth_members m
      join pg_roles member on member.oid = m.member
      where member.rolname = ${appRole.roleName}`;
    expect(Number(membership?.n)).toBe(0);
  });

  test("session unlock rows are private and the app can only create pending requests", async () => {
    const [privileges] = await app`
      select has_table_privilege(current_user, 'public.session_unlocks', 'SELECT') as can_select,
             has_table_privilege(current_user, 'public.session_unlocks', 'INSERT') as can_insert,
             has_table_privilege(current_user, 'public.session_unlocks', 'UPDATE') as can_update`;
    expect(privileges?.can_select).toBe(false);
    expect(privileges?.can_insert).toBe(false);
    expect(privileges?.can_update).toBe(false);
    await expectSqlReject(app`select id from session_unlocks`, /permission denied/);
    await expectSqlReject(
      app`insert into session_unlocks
          (scope, requested_by, session_id, requested_minutes)
          values ('tier2', 'agent:self-grant', ${crypto.randomUUID()}::uuid, 5)`,
      /permission denied/,
    );
    await expectSqlReject(
      app`update session_unlocks set approved_by = 'agent:self-grant'`,
      /permission denied/,
    );
    await expectSqlReject(
      app`select app_request_tier2_unlock(5::smallint)`,
      /unlock_actor_required/,
    );

    const sessionId = crypto.randomUUID();
    const [request] = await app.begin(async (tx) => {
      await tx`select set_config('minime.actor', 'agent:request-only', true)`;
      await tx`select set_config('minime.session_id', ${sessionId}, true)`;
      return tx`select app_request_tier2_unlock(5::smallint)::text as id`;
    });
    try {
      const [tier] = await app.begin(async (tx) => {
        await tx`select set_config('minime.actor', 'agent:request-only', true)`;
        await tx`select set_config('minime.session_id', ${sessionId}, true)`;
        return tx`select app_allowed_tier()::int as tier`;
      });
      expect(Number(tier?.tier)).toBe(1);
      const [stored] = await testSql`
        select approved_at, approved_by, expires_at
        from session_unlocks where id = ${request!.id}::uuid`;
      expect(stored).toEqual({ approved_at: null, approved_by: null, expires_at: null });
    } finally {
      await testSql`delete from session_unlocks where id = ${request!.id}::uuid`;
    }
  });

  test("RLS exposes tier-1 but omits locked tier-2 content", async () => {
    const [tierOne] = await testSql`
      insert into pages (path, title, body_md, content_hash, tier, created_by, source)
      values ('role/tier-one.md', 'role tier one', 'ROLE-TIER1', 'role-tier-one', 1, 'fixture', 'test')
      returning id`;
    await testSql`
      insert into pages (path, title, body_md, content_hash, tier, created_by, source)
      values ('role/tier-two.md', 'role tier two', 'ROLE-TIER2', 'role-tier-two', 2, 'fixture', 'test')`;
    const rows = await app`select body_md from pages where id = ${tierOne!.id}`;
    expect(rows.map((row) => row.body_md)).toEqual(["ROLE-TIER1"]);
    const locked =
      await app`select body_md from pages where body_md like 'ROLE-TIER%' order by body_md`;
    expect(locked.map((row) => row.body_md)).toEqual(["ROLE-TIER1"]);
  });

  test("an approved unlock requires the exact actor and connection session", async () => {
    const sessionId = crypto.randomUUID();
    const [request] = await app.begin(async (tx) => {
      await tx`select set_config('minime.actor', 'agent:phase-a', true)`;
      await tx`select set_config('minime.session_id', ${sessionId}, true)`;
      return tx`select app_request_tier2_unlock(5::smallint)::text as id`;
    });
    await testSql`
      update session_unlocks
      set approved_at = clock_timestamp(), approved_by = 'owner:test',
          expires_at = clock_timestamp() + interval '5 minutes'
      where id = ${request!.id}::uuid`;
    try {
      const locked = await app.begin(async (tx) => {
        await tx`select set_config('minime.actor', 'agent:phase-a', true)`;
        await tx`select set_config('minime.session_id', ${crypto.randomUUID()}, true)`;
        return tx`select app_allowed_tier()::int as tier`;
      });
      expect(Number(locked[0]?.tier)).toBe(1);
      const unlocked = await app.begin(async (tx) => {
        await tx`select set_config('minime.actor', 'agent:phase-a', true)`;
        await tx`select set_config('minime.session_id', ${sessionId}, true)`;
        return tx`select app_allowed_tier()::int as tier`;
      });
      expect(Number(unlocked[0]?.tier)).toBe(2);
      const malformed = await app.begin(async (tx) => {
        await tx`select set_config('minime.actor', 'agent:phase-a', true)`;
        await tx`select set_config('minime.session_id', 'not-a-uuid', true)`;
        return tx`select app_allowed_tier()::int as tier`;
      });
      expect(Number(malformed[0]?.tier)).toBe(1);
    } finally {
      await testSql`delete from session_unlocks where id = ${request!.id}::uuid`;
    }
  });

  test("locked app edge writes retain the tier of their hidden source", async () => {
    const [source] = await testSql`
      insert into pages (path, title, body_md, content_hash, tier, created_by, source)
      values ('role/edge-source.md', 'edge source', 'EDGE-TIER2', 'edge-tier2', 2, 'fixture', 'test')
      returning id`;
    const edgeId = crypto.randomUUID();
    try {
      await app.begin(async (tx) => {
        await tx`select set_config('minime.actor', 'agent:edge-writer', true)`;
        await tx`
          insert into edges (id, src_type, src_id, rel, dst_type, dst_id, source_table, source_id,
                             extracted_by)
          values (${edgeId}, 'page', ${source!.id}, 'contains-private-fact', 'page', ${source!.id},
                  'pages', ${source!.id}, 'agent:edge-writer')`;
      });
      const [stored] = await testSql`select tier from edges where id = ${edgeId}`;
      expect(Number(stored?.tier)).toBe(2);
      const hidden = await app.begin(async (tx) => {
        await tx`select set_config('minime.actor', 'agent:edge-writer', true)`;
        return tx`select id from edges where id = ${edgeId}`;
      });
      expect(hidden).toHaveLength(0);
    } finally {
      await testSql`delete from edges where id = ${edgeId}`;
      await testSql`delete from pages where id = ${source!.id}`;
    }
  });

  test("decision-branch trigger uses only the readable source-tier boundary", async () => {
    const [decision] = await testSql`
      insert into decisions (question, options, tier, source, created_by)
      values ('Runtime branch fixture?', '["ship"]'::jsonb, 1, 'test', 'owner:test')
      returning id`;
    const [branch] = await testSql`
      insert into decision_branches
        (decision_id, label, status, tier, source, created_by)
      values (${decision!.id}, 'ship', 'considered', 1, 'test', 'owner:test')
      returning id`;
    await testSql`
      insert into edges
        (src_type, src_id, rel, dst_type, dst_id, source_table, source_id,
         extracted_by, tier, source, created_by, derived_from)
      values
        ('decision', ${decision!.id}, 'considered', 'decision_branch', ${branch!.id},
         'decision_branches', ${branch!.id}, 'owner:test', 1, 'test', 'owner:test', ${branch!.id})`;

    await app`update decision_branches set status = 'chosen' where id = ${branch!.id}`;
    const [edge] = await testSql`
      select rel, tier from edges
      where src_id = ${decision!.id} and dst_id = ${branch!.id}`;
    expect(edge).toEqual({ rel: "chose", tier: 1 });
  });

  test("app writes return client identifiers while locked, but reads stay omitted", async () => {
    const id = crypto.randomUUID();
    await app.begin(async (tx) => {
      await tx`select set_config('minime.actor', 'agent:writer', true)`;
      await tx`
        insert into journal_entries (id, entry_md, tier, created_by, source)
        values (${id}, 'ROLE-WRITE-TIER2', 2, 'agent:writer', 'test')`;
    });
    const locked = await app.begin(async (tx) => {
      await tx`select set_config('minime.actor', 'agent:writer', true)`;
      return tx`select id from journal_entries where id = ${id}`;
    });
    expect(locked).toHaveLength(0);
    await testSql`delete from journal_entries where id = ${id}`;
  });
});
