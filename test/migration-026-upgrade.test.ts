import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import {
  applyCheckedOutMigration,
  ensureSchemaMigrationLedger,
  schemaMigrationNames,
} from "../src/db/repo";
import { registerTestDatabaseCloser, testDatabaseUrl } from "./setup";
import {
  disposeTestDatabase,
  planTestDatabase,
  provisionTestDatabase,
} from "./support/test-database";

const MIGRATIONS_DIR = join(import.meta.dir, "../db/migrations");
const BEFORE = "025_inbox_capture_identity.sql";
const TARGET = "026_time_semantics.sql";

test("026 upgrades a populated 025 database transactionally without losing stored rows", async () => {
  const token = `m026_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
    // The installer template may already carry the current schema. Keep its extensions, but
    // remove application relations/functions so this secondary scratch authentically replays
    // the checked-out history only through 025.
    const applicationFunctions = await isolated`
      select pg_catalog.format('%I.%I(%s)', ns.nspname, p.proname,
               pg_catalog.pg_get_function_identity_arguments(p.oid)) as signature
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public'
        and not exists (
          select 1 from pg_catalog.pg_depend dep
          join pg_catalog.pg_extension ext on ext.oid = dep.refobjid
          where dep.classid = 'pg_catalog.pg_proc'::regclass
            and dep.objid = p.oid and dep.deptype = 'e'
        )`;
    const applicationTables = await isolated`
      select tablename from pg_catalog.pg_tables where schemaname = 'public'`;
    for (const row of applicationTables) {
      await isolated`drop table if exists ${isolated(String(row.tablename))} cascade`;
    }
    for (const row of applicationFunctions) {
      await isolated.unsafe(`drop function if exists ${String(row.signature)} cascade`);
    }

    const names = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort();
    const beforeIndex = names.indexOf(BEFORE);
    expect(beforeIndex).toBeGreaterThanOrEqual(0);
    expect(names[beforeIndex + 1]).toBe(TARGET);

    await ensureSchemaMigrationLedger(isolated);
    for (const name of names.slice(0, beforeIndex + 1)) {
      await applyCheckedOutMigration(
        isolated,
        name,
        await Bun.file(join(MIGRATIONS_DIR, name)).text(),
      );
    }
    expect(await schemaMigrationNames(isolated)).toEqual(names.slice(0, beforeIndex + 1));

    await isolated`
      insert into tasks (title, status, source, created_by, tier)
      values ('Fictional 026 upgrade task', 'active', 'test:m026-upgrade', 'fixture', 1)`;
    await isolated`
      insert into inbox_items (raw_path, mime, status, content_hash)
      values ('inbox/fictional-026.md', 'text/markdown', 'pending', ${"a".repeat(64)})`;
    await isolated`
      insert into health_samples (kind, at, value, unit, source, created_by, tier)
      values ('steps', '2026-01-01T16:30:00Z', 12, 'steps',
              'test:m026-upgrade', 'fixture', 0)`;
    const customAgg =
      "select $1::date as period_start, 7::numeric as value, null::text as label where $1 <= $2";
    await isolated`
      insert into metric_defs (name, unit, description, agg_sql)
      values ('fictional_custom_metric', 'points', 'Fictional custom metric', ${customAgg}),
             ('fictional_stored_only', 'points', 'Fictional stored-only metric', null)`;
    await isolated`
      insert into metric_values (metric, period_start, granularity, value, source)
      values ('steps', '2025-01-01', 'day', 9, 'query'),
             ('steps', '2025-01-02', 'day', 10, 'manual'),
             ('fictional_stored_only', '2025-01-01', 'day', 42, 'manual')`;

    const [beforeRows] = await isolated`
      select
        (select row_to_json(t)::text from (
          select title, status, source, created_by, tier from tasks
          where title = 'Fictional 026 upgrade task') t) as task,
        (select row_to_json(i)::text from (
          select raw_path, mime, status, content_hash, archive_path, claim_token, claimed_at
          from inbox_items where raw_path = 'inbox/fictional-026.md') i) as inbox,
        (select row_to_json(h)::text from (
          select kind, at, value, unit, source, created_by, tier from health_samples
          where source = 'test:m026-upgrade') h) as health`;
    const beforeValues = (
      await isolated`
        select metric, period_start::text, granularity, value::float, source
        from metric_values order by metric, granularity, period_start`
    ).map((row) => ({ ...row }));
    const [preAcl] = await isolated`
      select
        to_regprocedure('public.metric_agg(text,date,date)') is not null as old_exists,
        has_function_privilege('public', 'public.metric_agg(text,date,date)', 'EXECUTE') as public_execute,
        has_function_privilege('minime_app', 'public.metric_agg(text,date,date)', 'EXECUTE') as app_execute,
        has_function_privilege('minime_engineer_ro', 'public.metric_agg(text,date,date)', 'EXECUTE') as engineer_execute,
        has_table_privilege('minime_app', 'public.metric_values', 'SELECT') as app_select,
        has_table_privilege('minime_app', 'public.metric_values', 'INSERT') as app_insert,
        has_table_privilege('minime_app', 'public.metric_values', 'UPDATE') as app_update`;
    expect(preAcl).toEqual({
      old_exists: true,
      public_execute: false,
      app_execute: true,
      engineer_execute: true,
      app_select: true,
      app_insert: true,
      app_update: true,
    });

    const body = await Bun.file(join(MIGRATIONS_DIR, TARGET)).text();
    try {
      await applyCheckedOutMigration(isolated, TARGET, `${body}\nselect 1 / 0;`);
      throw new Error("expected injected migration failure");
    } catch (error) {
      expect(String(error)).toMatch(/division by zero/);
    }

    const [rolledBack] = await isolated`
      select
        to_regclass('public.metric_cache_state') is null as cache_state_absent,
        to_regprocedure('public.metric_agg(text,date,date)') is not null as old_function_present,
        to_regprocedure('public.metric_agg(text,date,date,text)') is null as new_function_absent,
        not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'metric_defs'
                      and column_name = 'rollup') as rollup_absent`;
    expect(rolledBack).toEqual({
      cache_state_absent: true,
      old_function_present: true,
      new_function_absent: true,
      rollup_absent: true,
    });
    expect(await schemaMigrationNames(isolated)).toEqual(names.slice(0, beforeIndex + 1));
    expect(
      (
        await isolated`
        select metric, period_start::text, granularity, value::float, source
        from metric_values order by metric, granularity, period_start`
      ).map((row) => ({ ...row })),
    ).toEqual(beforeValues);

    await applyCheckedOutMigration(isolated, TARGET, body);
    expect(await schemaMigrationNames(isolated)).toEqual(names.slice(0, beforeIndex + 2));

    const [afterRows] = await isolated`
      select
        (select row_to_json(t)::text from (
          select title, status, source, created_by, tier from tasks
          where title = 'Fictional 026 upgrade task') t) as task,
        (select row_to_json(i)::text from (
          select raw_path, mime, status, content_hash, archive_path, claim_token, claimed_at
          from inbox_items where raw_path = 'inbox/fictional-026.md') i) as inbox,
        (select row_to_json(h)::text from (
          select kind, at, value, unit, source, created_by, tier from health_samples
          where source = 'test:m026-upgrade') h) as health`;
    expect(afterRows).toEqual(beforeRows);
    expect(
      (
        await isolated`
        select metric, period_start::text, granularity, value::float, source
        from metric_values order by metric, granularity, period_start`
      ).map((row) => ({ ...row })),
    ).toEqual(beforeValues);

    const [custom] = await isolated`
      select agg_sql, rollup from metric_defs where name = 'fictional_custom_metric'`;
    const [storedOnly] = await isolated`
      select agg_sql, rollup from metric_defs where name = 'fictional_stored_only'`;
    const [cacheState] = await isolated`select count(*)::int as n from metric_cache_state`;
    expect(custom).toEqual({ agg_sql: customAgg, rollup: "sum" });
    expect(storedOnly).toEqual({ agg_sql: null, rollup: "sum" });
    expect(cacheState!.n).toBe(0);

    const aggregate = (
      await isolated`
        select period_start::text, value::float, label
        from metric_agg('steps', '2026-01-01', '2026-01-03', 'Asia/Singapore')`
    ).map((row) => ({ ...row }));
    expect(aggregate).toEqual([{ period_start: "2026-01-02", value: 12, label: null }]);

    const [posture] = await isolated`
      select p.prosecdef, p.provolatile, p.proconfig,
        to_regprocedure('public.metric_agg(text,date,date)') is null as old_removed,
        has_function_privilege('public', 'public.metric_agg(text,date,date,text)', 'EXECUTE') as public_execute,
        has_function_privilege('minime_app', 'public.metric_agg(text,date,date,text)', 'EXECUTE') as app_execute,
        has_function_privilege('minime_engineer_ro', 'public.metric_agg(text,date,date,text)', 'EXECUTE') as engineer_execute,
        has_table_privilege('minime_app', 'public.metric_values', 'SELECT') as app_select,
        has_table_privilege('minime_app', 'public.metric_values', 'INSERT') as app_insert,
        has_table_privilege('minime_app', 'public.metric_values', 'UPDATE') as app_update,
        has_table_privilege('minime_app', 'public.metric_cache_state', 'SELECT') as app_state_select,
        has_table_privilege('minime_engineer_ro', 'public.metric_cache_state', 'SELECT') as engineer_state_select
      from pg_proc p
      where p.oid = 'public.metric_agg(text,date,date,text)'::regprocedure`;
    expect(posture).toEqual({
      prosecdef: true,
      provolatile: "s",
      proconfig: ["search_path=pg_catalog, public, pg_temp"],
      old_removed: true,
      public_execute: false,
      app_execute: true,
      engineer_execute: true,
      app_select: true,
      app_insert: false,
      app_update: false,
      app_state_select: true,
      engineer_state_select: true,
    });
  } finally {
    unregister();
    await cleanup();
  }
});
