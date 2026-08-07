import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { prepareMetricCache, stateSnapshot } from "../src/db/repo";
import { queryMetric } from "../src/mcp/tools/metric";
import { enqueueDecisionReviews, rollupMetrics } from "../src/pipeline/dream";
import { setNow, todayStr } from "../src/util/clock";
import { config } from "../src/util/config";
import {
  isMetricDate,
  metricDateString,
  metricPeriodStart,
  reduceMetricSeries,
} from "../src/util/metric-rollup";
import { resetDb, testSql as sql } from "./helpers";

beforeAll(async () => {
  await resetDb();
});

afterAll(() => {
  setNow(null);
});

describe("metric time semantics", () => {
  test("shared reducer sums additive metrics and takes the last chronological streak value", () => {
    const daily = [
      { period_start: "2026-01-03", value: 4, label: null },
      { period_start: "2026-01-02", value: 3, label: null },
    ];
    expect(reduceMetricSeries(daily, "month", "sum")).toEqual([
      { period_start: "2026-01-01", value: 7 },
    ]);
    expect(reduceMetricSeries(daily, "month", "last")).toEqual([
      { period_start: "2026-01-01", value: 4 },
    ]);
  });

  test("date-only rendering is independent of the process timezone", () => {
    // This instant is already January 2 in the test process's Asia/Singapore zone.
    expect(metricDateString(new Date("2026-01-01T16:30:00Z"))).toBe("2026-01-01");
  });

  test("metric dates reject impossible values and reversed ranges", async () => {
    expect(isMetricDate("2028-02-29")).toBe(true);
    expect(isMetricDate("2026-02-29")).toBe(false);
    expect(metricPeriodStart("2026-02-18", "week")).toBe("2026-02-16");

    for (const [from, to] of [
      ["2026-02-30", "2026-03-01"],
      ["2026-03-02", "2026-03-01"],
    ] as const) {
      try {
        await queryMetric("steps", from, to, "day", "UTC");
        throw new Error("expected metric input rejection");
      } catch (error) {
        expect(error).toMatchObject({ code: "BAD_INPUT" });
      }
    }
  });

  test("cache preparation refuses to run outside its owner transaction", async () => {
    await expect(prepareMetricCache("UTC")).rejects.toThrow("metric_cache_transaction_required");
  });

  test("dream persists configured-zone days with sum and streak-last week/month rollups", async () => {
    await sql`
      insert into health_samples (kind, at, value, unit, source, created_by, tier)
      values
        ('steps', '2026-01-05T12:00:00Z', 10, 'steps', 'test:dream-rollup', 'fixture', 0),
        ('steps', '2026-01-05T16:30:00Z', 20, 'steps', 'test:dream-rollup', 'fixture', 0)`;
    await sql`
      insert into journal_entries (at, entry_md, source, created_by, tier)
      values
        ('2025-12-31T12:00:00Z', 'Fictional dream streak one.', 'test:dream-rollup', 'fixture', 2),
        ('2026-01-01T12:00:00Z', 'Fictional dream streak two.', 'test:dream-rollup', 'fixture', 2),
        ('2026-01-02T12:00:00Z', 'Fictional dream streak three.', 'test:dream-rollup', 'fixture', 2),
        ('2026-01-03T12:00:00Z', 'Fictional dream streak four.', 'test:dream-rollup', 'fixture', 2)`;

    setNow(new Date("2026-01-05T16:45:00Z")); // 2026-01-06 00:45 Asia/Singapore
    try {
      expect(await rollupMetrics(10)).toBe(6);
    } finally {
      setNow(null);
    }

    const values = await sql`
      select metric, period_start::text, granularity, value::float
      from metric_values
      where metric in ('steps', 'journal_streak')
      order by metric, granularity, period_start`;
    expect(values).toContainEqual({
      metric: "steps",
      period_start: "2026-01-06",
      granularity: "day",
      value: 20,
    });
    expect(values).toContainEqual({
      metric: "steps",
      period_start: "2026-01-05",
      granularity: "week",
      value: 30,
    });
    expect(values).toContainEqual({
      metric: "steps",
      period_start: "2026-01-01",
      granularity: "month",
      value: 30,
    });
    expect(values).toContainEqual({
      metric: "journal_streak",
      period_start: "2025-12-29",
      granularity: "week",
      value: 4,
    });
    expect(values).toContainEqual({
      metric: "journal_streak",
      period_start: "2026-01-01",
      granularity: "month",
      value: 4,
    });
  });

  test("early owner-local review date is enqueued even while UTC is on the previous day", async () => {
    const [decision] = await sql`
      insert into decisions (question, options, review_at, source, created_by, tier)
      values ('Review the fictional launch?', '["continue"]'::jsonb, '2026-01-02',
              'test:review-date', 'fixture', 1)
      returning id`;

    setNow(new Date("2026-01-01T16:30:00Z")); // 2026-01-02 00:30 Asia/Singapore
    try {
      const ownerDate = todayStr(config.tz);
      expect(ownerDate).toBe("2026-01-02");
      expect(await enqueueDecisionReviews(ownerDate)).toBe(1);
    } finally {
      setNow(null);
    }

    const [queued] = await sql`
      select count(*)::int as n from review_queue
      where kind = 'decision_review' and payload->>'decision_id' = ${decision!.id}::text`;
    expect(queued!.n).toBe(1);
  });

  test("state anomaly window stays on the owner cache date for a different caller zone", async () => {
    await sql`insert into metric_cache_state (singleton, time_zone)
      values (true, ${config.tz})
      on conflict (singleton) do update set time_zone = excluded.time_zone`;
    await sql`
      insert into metric_values (metric, period_start, granularity, value, source)
      select 'steps', '2026-01-02'::date - day_offset, 'day',
             10 + (day_offset % 2), 'dream'
      from generate_series(1, 28) as offsets(day_offset)
      on conflict (metric, granularity, period_start) do update
        set value = excluded.value, source = excluded.source`;
    await sql`
      insert into metric_values (metric, period_start, granularity, value, source)
      values ('steps', '2026-01-02', 'day', 100, 'dream')
      on conflict (metric, granularity, period_start) do update
        set value = excluded.value, source = excluded.source`;

    setNow(new Date("2026-01-01T16:30:00Z")); // January 2 owner-local, January 1 in Los Angeles
    try {
      const state = await stateSnapshot(undefined, "America/Los_Angeles");
      expect(state.metric_anomalies).toContainEqual({
        metric: "steps",
        period_start: "2026-01-02",
        value: 100,
        mean: 10.5,
        sd: expect.any(Number),
      });
    } finally {
      setNow(null);
    }

    await sql`update metric_cache_state set time_zone = 'UTC' where singleton`;
    setNow(new Date("2026-01-01T16:30:00Z"));
    try {
      const mismatched = await stateSnapshot(undefined, config.tz);
      expect(
        mismatched.metric_anomalies.some((row: { metric: string }) => row.metric === "steps"),
      ).toBe(false);
    } finally {
      setNow(null);
      await sql`update metric_cache_state set time_zone = ${config.tz} where singleton`;
    }
  });

  test("default moved_today uses the same owner zone as its local date", async () => {
    const [task] = await sql`
      insert into tasks (title, status, updated_at, source, created_by, tier)
      values ('Close the fictional local-midnight task', 'done', '2026-01-01T16:20:00Z',
              'test:moved-owner-day', 'fixture', 1)
      returning id`;

    setNow(new Date("2026-01-01T16:30:00Z")); // January 2 in Singapore, January 1 UTC
    try {
      const state = await stateSnapshot();
      expect(state.moved_today.map((row: { id: string }) => row.id)).toContain(task!.id);
    } finally {
      setNow(null);
    }
  });

  test("incremental rollups include the full leading week/month source window", async () => {
    await sql`delete from metric_values where metric = 'steps'`;
    await sql`insert into metric_cache_state (singleton, time_zone)
      values (true, ${config.tz})
      on conflict (singleton) do update set time_zone = excluded.time_zone`;
    await sql`
      insert into health_samples (kind, at, value, unit, source, created_by, tier)
      values
        ('steps', '2026-02-01T04:00:00Z', 5, 'steps', 'test:leading-rollup', 'fixture', 0),
        ('steps', '2026-02-02T04:00:00Z', 7, 'steps', 'test:leading-rollup', 'fixture', 0),
        ('steps', '2026-02-18T04:00:00Z', 11, 'steps', 'test:leading-rollup', 'fixture', 0)`;
    await sql`
      insert into metric_values (metric, period_start, granularity, value, source)
      values ('steps', '2026-01-26', 'week', 999, 'dream')`;

    setNow(new Date("2026-02-20T04:00:00Z"));
    try {
      await rollupMetrics(5); // requested lower bound is February 15
    } finally {
      setNow(null);
    }

    const values = await sql`
      select period_start::text, granularity, value::float
      from metric_values where metric = 'steps' order by granularity, period_start`;
    expect(values).toContainEqual({
      period_start: "2026-02-01",
      granularity: "month",
      value: 23,
    });
    expect(values).toContainEqual({
      period_start: "2026-01-26",
      granularity: "week",
      value: 999,
    });
    expect(values).not.toContainEqual({
      period_start: "2026-02-02",
      granularity: "day",
      value: 7,
    });
  });

  test("incremental rollups remove vanished Dream buckets without touching protected values", async () => {
    const labeledAgg =
      "select $2::date as period_start, 1::numeric as value, 'segment'::text as label";
    await sql`
      insert into metric_defs (name, unit, description, agg_sql)
      values ('zz_fictional_labeled_cache', 'points', 'Fictional live-only metric', ${labeledAgg})`;
    await sql`insert into metric_cache_state (singleton, time_zone)
      values (true, ${config.tz})
      on conflict (singleton) do update set time_zone = excluded.time_zone`;
    await sql`
      insert into metric_values (metric, period_start, granularity, value, source)
      values
        ('deep_work_minutes', '2099-03-18', 'day', 10, 'dream'),
        ('deep_work_minutes', '2099-03-16', 'week', 20, 'dream'),
        ('deep_work_minutes', '2099-03-01', 'month', 30, 'dream'),
        ('deep_work_minutes', '2099-03-17', 'day', 40, 'manual'),
        ('deep_work_minutes', '2099-03-14', 'day', 50, 'dream'),
        ('deep_work_minutes', '2099-03-02', 'week', 60, 'dream'),
        ('deep_work_minutes', '2099-02-01', 'month', 70, 'dream'),
        ('zz_fictional_labeled_cache', '2099-03-18', 'day', 80, 'dream')
      on conflict (metric, granularity, period_start) do update
        set value = excluded.value, source = excluded.source`;

    setNow(new Date("2099-03-20T04:00:00Z"));
    try {
      await rollupMetrics(5);
    } finally {
      setNow(null);
    }

    const values = (
      await sql`
        select period_start::text, granularity, value::float, source
        from metric_values
        where metric = 'deep_work_minutes'
          and period_start between '2099-02-01' and '2099-03-20'
        order by granularity, period_start`
    ).map((row) => ({ ...row }));
    expect(values).toEqual([
      { period_start: "2099-03-14", granularity: "day", value: 50, source: "dream" },
      { period_start: "2099-03-17", granularity: "day", value: 40, source: "manual" },
      { period_start: "2099-02-01", granularity: "month", value: 70, source: "dream" },
      { period_start: "2099-03-02", granularity: "week", value: 60, source: "dream" },
    ]);
    const [labeledCached] = await sql`
      select count(*)::int as n from metric_values where metric = 'zz_fictional_labeled_cache'`;
    expect(labeledCached!.n).toBe(0);
    await sql`delete from metric_defs where name = 'zz_fictional_labeled_cache'`;
  });

  test("timezone cache switches rebuild atomically and preserve stored-only rows", async () => {
    await sql`
      insert into metric_defs (name, unit, description, agg_sql)
      values ('fictional_stored_only', 'points', 'Fictional stored-only metric', null)
      on conflict (name) do nothing`;
    await sql`
      insert into metric_values (metric, period_start, granularity, value, source)
      values
        ('fictional_stored_only', '1900-01-01', 'day', 42, 'manual'),
        ('steps', '1900-01-01', 'day', 99, 'query'),
        ('steps', '1901-01-01', 'day', 77, 'manual')
      on conflict (metric, granularity, period_start) do update
        set value = excluded.value, source = excluded.source`;
    await sql`insert into metric_cache_state (singleton, time_zone)
      values (true, 'UTC')
      on conflict (singleton) do update set time_zone = excluded.time_zone`;
    await sql`
      insert into metric_defs (name, unit, description, agg_sql)
      values ('zz_fictional_broken_cache', 'points', 'Forces rollback',
              'select $1::date as period_start, 1::numeric as value, null::text as label from missing_metric_cache_relation')`;

    setNow(new Date("2026-02-20T04:00:00Z"));
    try {
      await expect(rollupMetrics(1)).rejects.toThrow();
    } finally {
      setNow(null);
      await sql`delete from metric_defs where name = 'zz_fictional_broken_cache'`;
    }

    const [rolledBackState] = await sql`select time_zone from metric_cache_state where singleton`;
    const [rolledBackValue] = await sql`
      select value::float, source from metric_values
      where metric = 'steps' and period_start = '1900-01-01' and granularity = 'day'`;
    expect(rolledBackState!.time_zone).toBe("UTC");
    expect(rolledBackValue).toEqual({ value: 99, source: "query" });

    setNow(new Date("2026-02-20T04:00:00Z"));
    try {
      await rollupMetrics(1);
    } finally {
      setNow(null);
    }

    const [rebuiltState] = await sql`select time_zone from metric_cache_state where singleton`;
    const [staleDream] = await sql`
      select count(*)::int as n from metric_values
      where metric = 'steps' and period_start = '1900-01-01' and source in ('dream', 'query')`;
    const [storedOnly] = await sql`
      select value::float, source from metric_values
      where metric = 'fictional_stored_only' and period_start = '1900-01-01'`;
    const [manualSourceBacked] = await sql`
      select value::float, source from metric_values
      where metric = 'steps' and period_start = '1901-01-01'`;
    expect(rebuiltState!.time_zone).toBe(config.tz);
    expect(staleDream!.n).toBe(0);
    expect(storedOnly).toEqual({ value: 42, source: "manual" });
    expect(manualSourceBacked).toEqual({ value: 77, source: "manual" });
  });
});
