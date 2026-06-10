-- Seed metric_defs (spec §7). Convention for agg_sql (see repo.queryMetric):
--   * parameterized with $1 = from-date (inclusive), $2 = to-date (inclusive); never interpolated
--   * returns exactly (period_start date, value numeric, label text) at day granularity;
--     label is null for dimensionless metrics
-- This whitelisted SQL is the ONLY path to tier-0 content (I3).

insert into metric_defs (name, unit, description, agg_sql) values
('spend_total', 'dollars', 'Total spend (outflows) per day',
$$select occurred_at as period_start,
         (sum(case when amount_cents < 0 then -amount_cents else 0 end) / 100.0)::numeric as value,
         null::text as label
  from transactions where occurred_at between $1 and $2
  group by 1 order by 1$$),

('spend_by_category', 'dollars', 'Spend (outflows) per day broken down by category',
$$select occurred_at as period_start,
         (sum(case when amount_cents < 0 then -amount_cents else 0 end) / 100.0)::numeric as value,
         coalesce(category, 'uncategorized') as label
  from transactions where occurred_at between $1 and $2
  group by 1, 3 order by 1, 3$$),

('sleep_minutes', 'minutes', 'Sleep minutes per day',
$$select at::date as period_start, sum(value)::numeric as value, null::text as label
  from health_samples where kind = 'sleep_minutes' and at::date between $1 and $2
  group by 1 order by 1$$),

('steps', 'steps', 'Steps per day',
$$select at::date as period_start, sum(value)::numeric as value, null::text as label
  from health_samples where kind = 'steps' and at::date between $1 and $2
  group by 1 order by 1$$),

('deep_work_minutes', 'minutes', 'Minutes in calendar blocks titled deep work / focus per day',
$$select starts_at::date as period_start,
         sum(extract(epoch from (coalesce(ends_at, starts_at + interval '1 hour') - starts_at)) / 60)::numeric as value,
         null::text as label
  from calendar_events
  where (title ~* 'deep work|focus') and starts_at::date between $1 and $2
  group by 1 order by 1$$),

('journal_streak', 'days', 'Consecutive-day journal streak length as of each day with an entry',
$$with days as (
    select distinct at::date as d from journal_entries where at::date between $1 and $2
  ), grp as (
    select d, d - (row_number() over (order by d))::int as g from days
  )
  select d as period_start,
         (count(*) over (partition by g order by d))::numeric as value,
         null::text as label
  from grp order by d$$)
on conflict (name) do nothing;
