// W4-8: `metric:add` CLI + vetted template registry (src/util/metric-templates.ts,
// src/db/repo.ts's insertMetricDef/metricDefExists, src/cli.ts's `metric:add`). Covers, per the
// task spec: (1) each template runs via metric_agg on scratch data with correct sums/avgs/
// counts; (2) injection attempts are rejected by validation before any SQL is generated; (3) a
// duplicate name is rejected; (4) a broken dry-run rolls back the whole insert; (5) the
// already-seeded body_mass/hr_resting defs (027_life_metrics_seed.sql) answer
// minime_query_metric, closing the review's original UNKNOWN_METRIC repro.
//
// This task's spec also named a migration 036 seeding body_mass/hr_resting — dropped from scope
// by the program's cross-check dedup: 027_life_metrics_seed.sql already seeds both, matching the
// exact 026 agg_sql contract, before this task began. Test (5) below confirms that directly.

import { beforeAll, describe, expect, test } from "bun:test";
import { withAdminDbTransaction } from "../src/db/client";
import { insertMetricDef } from "../src/db/repo";
import { queryMetric } from "../src/mcp/tools/metric";
import type { MetricRollup } from "../src/util/metric-rollup";
import {
  METRIC_TEMPLATE_IDS,
  type MetricTemplateParams,
  generateMetricTemplate,
  isMetricTemplateId,
  isSafeTemplateValue,
} from "../src/util/metric-templates";
import { resetDb, testSql } from "./helpers";

beforeAll(async () => {
  await resetDb();
});

const TRIVIAL_VALID_AGG_SQL =
  "select $1::date as period_start, 1::numeric as value, null::text as label";

describe("metric-templates: agg_sql generation (pure, no DB)", () => {
  test("METRIC_TEMPLATE_IDS / isMetricTemplateId expose exactly the five vetted templates", () => {
    expect(METRIC_TEMPLATE_IDS).toEqual([
      "health-sum",
      "health-avg",
      "health-count",
      "spend-by-category",
      "spend-by-merchant",
    ]);
    for (const id of METRIC_TEMPLATE_IDS) expect(isMetricTemplateId(id)).toBe(true);
    expect(isMetricTemplateId("free-form-sql")).toBe(false);
    expect(isMetricTemplateId("")).toBe(false);
  });

  test("every template returns the fixed (period_start, value, label) shape, the right rollup, and never a row-returning or mutating statement", () => {
    const cases: { params: MetricTemplateParams; rollup: MetricRollup; table: string }[] = [
      {
        params: { template: "health-sum", kind: "steps_v2" },
        rollup: "sum",
        table: "health_samples",
      },
      {
        params: { template: "health-avg", kind: "steps_v2" },
        rollup: "avg",
        table: "health_samples",
      },
      {
        params: { template: "health-count", kind: "steps_v2" },
        rollup: "sum",
        table: "health_samples",
      },
      {
        params: { template: "spend-by-category", category: "Dining" },
        rollup: "sum",
        table: "transactions",
      },
      {
        params: { template: "spend-by-merchant", merchantPattern: "Coffee" },
        rollup: "sum",
        table: "transactions",
      },
    ];
    for (const { params, rollup, table } of cases) {
      const generated = generateMetricTemplate(params);
      expect(generated.rollup).toBe(rollup);
      expect(generated.aggSql).toContain(`from ${table}`);
      expect(generated.aggSql).toContain("period_start");
      expect(generated.aggSql).toContain("as value");
      expect(generated.aggSql).toContain("null::text as label");
      expect(generated.aggSql).toContain("group by 1 order by 1");
      expect(generated.aggSql).toContain("$1");
      expect(generated.aggSql).toContain("$2");
      const lower = generated.aggSql.toLowerCase();
      expect(lower).not.toContain("select *");
      expect(lower).not.toMatch(/\binsert\b|\bupdate\b|\bdelete\b|\bdrop\b|\btruncate\b|;/);
    }
    // health_samples.at is a timestamptz, so its templates bucket via the 026/027 "(at at time
    // zone $3)::date" contract; transactions.occurred_at is already a plain date (005_mirrors.sql)
    // so its templates reference no $3 at all — 026_time_semantics.sql's own documented split,
    // "date-backed transactions need no conversion; timestamp-backed metrics do".
    expect(generateMetricTemplate({ template: "health-sum", kind: "steps_v2" }).aggSql).toContain(
      "at time zone $3",
    );
    expect(
      generateMetricTemplate({ template: "spend-by-category", category: "Dining" }).aggSql,
    ).not.toContain("$3");
    expect(
      generateMetricTemplate({ template: "spend-by-merchant", merchantPattern: "Coffee" }).aggSql,
    ).not.toContain("$3");
  });

  test("(2) injection attempts — quotes, backslashes, percent, semicolons — are rejected by validation before any SQL is generated", () => {
    const malicious = [
      "steps'; drop table health_samples; --",
      "Robert'); DROP TABLE metric_defs;--",
      "foo%bar",
      "back\\slash",
      'has"doublequote',
      "",
      "a".repeat(65),
      "line\nbreak",
      "semi;colon",
    ];
    for (const value of malicious) {
      expect(isSafeTemplateValue(value)).toBe(false);
      expect(() => generateMetricTemplate({ template: "health-sum", kind: value })).toThrow(
        "metric_template_value_invalid",
      );
      expect(() =>
        generateMetricTemplate({ template: "spend-by-category", category: value }),
      ).toThrow("metric_template_value_invalid");
      expect(() =>
        generateMetricTemplate({ template: "spend-by-merchant", merchantPattern: value }),
      ).toThrow("metric_template_value_invalid");
    }
    // The class accepts ordinary letters/digits/space/'_.-', not just rejects the dangerous set.
    expect(isSafeTemplateValue("Coffee & Tea")).toBe(false); // '&' outside the class
    expect(isSafeTemplateValue("Coffee Tea - 2nd St._Shop")).toBe(true);
  });
});

describe("metric-templates + insertMetricDef: end-to-end execution via metric_agg (1)", () => {
  test("health-sum sums a fictional health_samples kind per day", async () => {
    await testSql`
      insert into health_samples (kind, at, value, unit, source, created_by, tier)
      values
        ('workout_minutes', '2026-01-05T12:00:00Z', 30, 'minutes', 'test:metric-templates', 'fixture', 0),
        ('workout_minutes', '2026-01-05T15:00:00Z', 45, 'minutes', 'test:metric-templates', 'fixture', 0),
        ('workout_minutes', '2026-01-06T12:00:00Z', 20, 'minutes', 'test:metric-templates', 'fixture', 0)`;

    const generated = generateMetricTemplate({ template: "health-sum", kind: "workout_minutes" });
    expect(generated.rollup).toBe("sum");
    await withAdminDbTransaction(() =>
      insertMetricDef({
        name: "zz_workout_minutes_sum",
        unit: "minutes",
        description: "Fictional daily workout minutes",
        aggSql: generated.aggSql,
        rollup: generated.rollup,
      }),
    );

    const series = await queryMetric(
      "zz_workout_minutes_sum",
      "2026-01-05",
      "2026-01-06",
      "day",
      "UTC",
    );
    expect(series.data.unit).toBe("minutes");
    expect(series.data.series).toEqual([
      { period_start: "2026-01-05", value: 75 },
      { period_start: "2026-01-06", value: 20 },
    ]);
  });

  test("health-avg averages a fictional health_samples kind per day", async () => {
    await testSql`
      insert into health_samples (kind, at, value, unit, source, created_by, tier)
      values
        ('hr_variability', '2026-02-10T12:00:00Z', 40, 'ms', 'test:metric-templates', 'fixture', 0),
        ('hr_variability', '2026-02-10T15:00:00Z', 60, 'ms', 'test:metric-templates', 'fixture', 0),
        ('hr_variability', '2026-02-11T12:00:00Z', 45, 'ms', 'test:metric-templates', 'fixture', 0)`;

    const generated = generateMetricTemplate({ template: "health-avg", kind: "hr_variability" });
    expect(generated.rollup).toBe("avg");
    await withAdminDbTransaction(() =>
      insertMetricDef({
        name: "zz_hr_variability_avg",
        unit: "ms",
        description: "Fictional daily HRV average",
        aggSql: generated.aggSql,
        rollup: generated.rollup,
      }),
    );

    const series = await queryMetric(
      "zz_hr_variability_avg",
      "2026-02-10",
      "2026-02-11",
      "day",
      "UTC",
    );
    expect(series.data.series).toEqual([
      { period_start: "2026-02-10", value: 50 },
      { period_start: "2026-02-11", value: 45 },
    ]);
  });

  test("health-count counts fictional health_samples rows of one kind per day", async () => {
    await testSql`
      insert into health_samples (kind, at, value, unit, source, created_by, tier)
      values
        ('meditation_session', '2026-03-01T08:00:00Z', 10, 'minutes', 'test:metric-templates', 'fixture', 0),
        ('meditation_session', '2026-03-01T18:00:00Z', 15, 'minutes', 'test:metric-templates', 'fixture', 0),
        ('meditation_session', '2026-03-01T20:00:00Z', 20, 'minutes', 'test:metric-templates', 'fixture', 0),
        ('meditation_session', '2026-03-02T08:00:00Z', 5, 'minutes', 'test:metric-templates', 'fixture', 0)`;

    const generated = generateMetricTemplate({
      template: "health-count",
      kind: "meditation_session",
    });
    expect(generated.rollup).toBe("sum");
    await withAdminDbTransaction(() =>
      insertMetricDef({
        name: "zz_meditation_session_count",
        unit: "sessions",
        description: "Fictional daily meditation session count",
        aggSql: generated.aggSql,
        rollup: generated.rollup,
      }),
    );

    const series = await queryMetric(
      "zz_meditation_session_count",
      "2026-03-01",
      "2026-03-02",
      "day",
      "UTC",
    );
    expect(series.data.series).toEqual([
      { period_start: "2026-03-01", value: 3 },
      { period_start: "2026-03-02", value: 1 },
    ]);
  });

  test("spend-by-category sums only matching-category outflows, excluding other categories and inflows", async () => {
    await testSql`
      insert into transactions
        (occurred_at, amount_cents, currency, merchant, category, account_label, external_ref, created_by, source, tier)
      values
        ('2026-04-01', -1200, 'USD', 'Fictional Bistro', 'Dining', 'Checking', 'metric-tmpl-cat-1', 'test', 'test', 0),
        ('2026-04-01', -800,  'USD', 'Fictional Diner', 'Dining', 'Checking', 'metric-tmpl-cat-2', 'test', 'test', 0),
        ('2026-04-01', -500,  'USD', 'Fictional Grocer', 'Groceries', 'Checking', 'metric-tmpl-cat-3', 'test', 'test', 0),
        ('2026-04-01', 300,   'USD', 'Fictional Refund', 'Dining', 'Checking', 'metric-tmpl-cat-4', 'test', 'test', 0)`;

    const generated = generateMetricTemplate({ template: "spend-by-category", category: "Dining" });
    expect(generated.rollup).toBe("sum");
    await withAdminDbTransaction(() =>
      insertMetricDef({
        name: "zz_dining_spend_category",
        unit: "dollars",
        description: "Fictional daily dining spend",
        aggSql: generated.aggSql,
        rollup: generated.rollup,
      }),
    );

    const series = await queryMetric(
      "zz_dining_spend_category",
      "2026-04-01",
      "2026-04-01",
      "day",
      "UTC",
    );
    expect(series.data.series).toEqual([{ period_start: "2026-04-01", value: 20 }]);
  });

  test("spend-by-merchant substring-matches merchant text, case-insensitively, with a literal underscore escaped (not a LIKE wildcard)", async () => {
    await testSql`
      insert into transactions
        (occurred_at, amount_cents, currency, merchant, category, account_label, external_ref, created_by, source, tier)
      values
        ('2026-05-01', -450, 'USD', 'Fictional Coffee_Roast House', 'Dining', 'Checking', 'metric-tmpl-merch-1', 'test', 'test', 0),
        ('2026-05-01', -900, 'USD', 'Fictional CoffeeXRoast Express', 'Dining', 'Checking', 'metric-tmpl-merch-2', 'test', 'test', 0),
        ('2026-05-01', -300, 'USD', 'Fictional Unrelated Store', 'Shopping', 'Checking', 'metric-tmpl-merch-3', 'test', 'test', 0)`;

    // "Coffee_Roast": if the literal '_' were left as a live LIKE wildcard, it would ALSO match
    // "CoffeeXRoast" (any-one-char), inflating the sum to 13.50. Escaped, it matches only the
    // first, literal row: 450 / 100 = 4.50.
    const generated = generateMetricTemplate({
      template: "spend-by-merchant",
      merchantPattern: "Coffee_Roast",
    });
    expect(generated.rollup).toBe("sum");
    await withAdminDbTransaction(() =>
      insertMetricDef({
        name: "zz_coffee_roast_merchant",
        unit: "dollars",
        description: "Fictional daily coffee roaster spend",
        aggSql: generated.aggSql,
        rollup: generated.rollup,
      }),
    );

    const series = await queryMetric(
      "zz_coffee_roast_merchant",
      "2026-05-01",
      "2026-05-01",
      "day",
      "UTC",
    );
    expect(series.data.series).toEqual([{ period_start: "2026-05-01", value: 4.5 }]);
  });
});

describe("insertMetricDef: safety net (3)(4)", () => {
  test("(3) a duplicate name is rejected and never overwrites the original row", async () => {
    await withAdminDbTransaction(() =>
      insertMetricDef({
        name: "zz_dup_metric",
        unit: "points",
        description: "first",
        aggSql: TRIVIAL_VALID_AGG_SQL,
        rollup: "sum",
      }),
    );
    await expect(
      withAdminDbTransaction(() =>
        insertMetricDef({
          name: "zz_dup_metric",
          unit: "points",
          description: "second",
          aggSql: TRIVIAL_VALID_AGG_SQL,
          rollup: "sum",
        }),
      ),
    ).rejects.toThrow("metric_name_exists");

    const rows = await testSql`
      select description from metric_defs where name = 'zz_dup_metric'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.description).toBe("first");
  });

  test("an invalid --name shape is rejected before any row is written", async () => {
    for (const badName of [
      "Not Valid Name",
      "1starts_with_digit",
      "a",
      "UPPERCASE",
      "with space",
    ]) {
      await expect(
        withAdminDbTransaction(() =>
          insertMetricDef({
            name: badName,
            unit: "points",
            description: "test",
            aggSql: TRIVIAL_VALID_AGG_SQL,
            rollup: "sum",
          }),
        ),
      ).rejects.toThrow("metric_name_invalid");
    }
    const [row] = await testSql`
      select count(*)::int as n from metric_defs
      where name in ('Not Valid Name', '1starts_with_digit', 'a', 'UPPERCASE', 'with space')`;
    expect(row!.n).toBe(0);
  });

  test("(4) a broken agg_sql (test double standing in for a hypothetical bad template) fails its dry run and rolls back the whole insert", async () => {
    const brokenAggSql =
      "select $1::date as period_start, 1::numeric as value, null::text as label " +
      "from no_such_table_at_all_zz";

    await expect(
      withAdminDbTransaction(() =>
        insertMetricDef({
          name: "zz_broken_dry_run",
          unit: "points",
          description: "Fictional broken template test double",
          aggSql: brokenAggSql,
          rollup: "sum",
        }),
      ),
    ).rejects.toThrow();

    const [row] = await testSql`select 1 from metric_defs where name = 'zz_broken_dry_run'`;
    expect(row).toBeUndefined();
  });

  test("insertMetricDef refuses to run outside its owner transaction", async () => {
    await expect(
      insertMetricDef({
        name: "zz_no_transaction",
        unit: "points",
        description: "test",
        aggSql: TRIVIAL_VALID_AGG_SQL,
        rollup: "sum",
      }),
    ).rejects.toThrow("metric_def_transaction_required");
    const [row] = await testSql`select 1 from metric_defs where name = 'zz_no_transaction'`;
    expect(row).toBeUndefined();
  });
});

describe("(5) seeded body_mass/hr_resting already answer minime_query_metric", () => {
  test("027_life_metrics_seed.sql's body_mass/hr_resting defs return a series over fixture health_samples — the review's UNKNOWN_METRIC repro is closed without any migration in this task", async () => {
    await testSql`
      insert into health_samples (kind, at, value, unit, source, created_by, tier)
      values
        ('body_mass', '2026-06-01T07:00:00Z', 70.4, 'kg', 'test:metric-templates', 'fixture', 0),
        ('hr_resting', '2026-06-01T07:00:00Z', 55, 'bpm', 'test:metric-templates', 'fixture', 0)`;

    const bodyMass = await queryMetric("body_mass", "2026-06-01", "2026-06-01", "day", "UTC");
    expect(bodyMass.data.unit).toBe("kg");
    expect(bodyMass.data.series).toEqual([{ period_start: "2026-06-01", value: 70.4 }]);

    const hrResting = await queryMetric("hr_resting", "2026-06-01", "2026-06-01", "day", "UTC");
    expect(hrResting.data.unit).toBe("bpm");
    expect(hrResting.data.series).toEqual([{ period_start: "2026-06-01", value: 55 }]);
  });
});

describe("metric:add CLI subprocess end to end", () => {
  test("creates a working spend-by-merchant metric, queryable through minime_query_metric with no unlock, and audits only {metric, template}", async () => {
    await testSql`
      insert into transactions
        (occurred_at, amount_cents, currency, merchant, category, account_label, external_ref, created_by, source, tier)
      values
        ('2026-07-10', -450, 'USD', 'Fictional Blue Bottle Coffee', 'Dining', 'Checking', 'metric-add-cli-1', 'test', 'test', 0),
        ('2026-07-10', -350, 'USD', 'Fictional COFFEE HOUSE #12', 'Dining', 'Checking', 'metric-add-cli-2', 'test', 'test', 0),
        ('2026-07-10', -900, 'USD', 'Fictional Groceries Mart', 'Groceries', 'Checking', 'metric-add-cli-3', 'test', 'test', 0)`;

    const result = await spawnMetricAddCli([
      "--name",
      "coffee_spend_cli_test",
      "--template",
      "spend-by-merchant",
      "--merchant-pattern",
      "Coffee",
      "--unit",
      "dollars",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("created metric 'coffee_spend_cli_test'");
    expect(result.stdout).toContain("template=spend-by-merchant");

    // Exactly the MCP tool's own function (src/mcp/tools/metric.ts), no unlock involved —
    // aggregates only, matching the acceptance criterion this test proves end to end.
    const series = await queryMetric(
      "coffee_spend_cli_test",
      "2026-07-10",
      "2026-07-10",
      "day",
      "UTC",
    );
    expect(series.data.unit).toBe("dollars");
    expect(series.data.series).toEqual([{ period_start: "2026-07-10", value: 8 }]);

    const [event] = await testSql`
      select payload from events where verb = 'cli:metric:add'
      and payload ->> 'metric' = 'coffee_spend_cli_test' order by at desc limit 1`;
    expect(event!.payload).toEqual({
      metric: "coffee_spend_cli_test",
      template: "spend-by-merchant",
    });
  });

  test("rejects an injection attempt at --kind with exit code 2 and persists nothing", async () => {
    const result = await spawnMetricAddCli([
      "--name",
      "zz_cli_injection_test",
      "--template",
      "health-sum",
      "--kind",
      "steps'; drop table health_samples; --",
      "--unit",
      "steps",
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("outside the allowed set");

    const [row] = await testSql`select 1 from metric_defs where name = 'zz_cli_injection_test'`;
    expect(row).toBeUndefined();
    const [stillThere] = await testSql`select to_regclass('public.health_samples') as t`;
    expect(stillThere!.t).toBe("health_samples");
  });

  test("defensive argument validation never needs a DB fixture", async () => {
    const missingAll = await spawnMetricAddCli([]);
    expect(missingAll.code).toBe(2);
    expect(missingAll.stderr).toContain("--name, --template, and --unit are required");

    const badTemplate = await spawnMetricAddCli([
      "--name",
      "zz_bad_template",
      "--template",
      "not-a-template",
      "--unit",
      "points",
    ]);
    expect(badTemplate.code).toBe(2);
    expect(badTemplate.stderr).toContain("--template must be one of");
    expect(badTemplate.stderr).toContain("no --sql flag");

    const missingKind = await spawnMetricAddCli([
      "--name",
      "zz_missing_kind",
      "--template",
      "health-sum",
      "--unit",
      "points",
    ]);
    expect(missingKind.code).toBe(2);
    expect(missingKind.stderr).toContain("--kind is required for --template health-sum");

    const missingCategory = await spawnMetricAddCli([
      "--name",
      "zz_missing_category",
      "--template",
      "spend-by-category",
      "--unit",
      "dollars",
    ]);
    expect(missingCategory.code).toBe(2);
    expect(missingCategory.stderr).toContain(
      "--category is required for --template spend-by-category",
    );
  });

  test("rejects a duplicate name (second call fails, only the first success is audited)", async () => {
    await testSql`
      insert into health_samples (kind, at, value, unit, source, created_by, tier)
      values ('fictional_dup_kind', '2026-07-01T00:00:00Z', 5, 'count', 'test', 'test', 0)`;

    const first = await spawnMetricAddCli([
      "--name",
      "zz_cli_dup_test",
      "--template",
      "health-count",
      "--kind",
      "fictional_dup_kind",
      "--unit",
      "count",
    ]);
    expect(first.code).toBe(0);

    const second = await spawnMetricAddCli([
      "--name",
      "zz_cli_dup_test",
      "--template",
      "health-count",
      "--kind",
      "fictional_dup_kind",
      "--unit",
      "count",
    ]);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("already exists");

    const events = await testSql`
      select 1 from events where verb = 'cli:metric:add' and payload ->> 'metric' = 'zz_cli_dup_test'`;
    expect(events).toHaveLength(1);
  });
});

async function spawnMetricAddCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  // metric:add sits ahead of the ollamaPreflight gate (src/cli.ts), same as tx/health list, so
  // the non-loopback OLLAMA_URL below is never actually reached for any case exercised here.
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "run", "src/cli.ts", "metric:add", ...args],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, OLLAMA_URL: "http://example.test:11434" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
