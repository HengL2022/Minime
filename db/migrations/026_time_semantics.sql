-- Metric day buckets are caller-zone calendar dates. Persisted rollups use the configured
-- owner zone, and every metric declares how daily values combine into weeks/months.
alter table metric_defs
  add column rollup text not null default 'sum'
  constraint metric_defs_rollup_check check (rollup in ('sum', 'last'));

update metric_defs set rollup = 'last' where name = 'journal_streak';

-- $1/$2 are inclusive local dates and $3 is the explicitly requested IANA time zone.
-- Date-backed transactions need no conversion; timestamp-backed metrics do.
update metric_defs set agg_sql =
$$select (at at time zone $3)::date as period_start,
         sum(value)::numeric as value,
         null::text as label
  from health_samples
  where kind = 'sleep_minutes'
    and (at at time zone $3)::date between $1 and $2
  group by 1 order by 1$$
where name = 'sleep_minutes';

update metric_defs set agg_sql =
$$select (at at time zone $3)::date as period_start,
         sum(value)::numeric as value,
         null::text as label
  from health_samples
  where kind = 'steps'
    and (at at time zone $3)::date between $1 and $2
  group by 1 order by 1$$
where name = 'steps';

update metric_defs set agg_sql =
$$select (starts_at at time zone $3)::date as period_start,
         sum(extract(epoch from (coalesce(ends_at, starts_at + interval '1 hour') - starts_at)) / 60)::numeric as value,
         null::text as label
  from calendar_events
  where title ~* 'deep work|focus'
    and (starts_at at time zone $3)::date between $1 and $2
  group by 1 order by 1$$
where name = 'deep_work_minutes';

-- Build streak groups from all history through the requested end date, then filter the output.
-- Filtering `days` at the lower bound first would reset a continuing streak to one.
update metric_defs set agg_sql =
$$with days as (
    select distinct (at at time zone $3)::date as d
    from journal_entries
    where (at at time zone $3)::date <= $2
  ), grouped as (
    select d, d - (row_number() over (order by d))::int as streak_group
    from days
  ), streaks as (
    select d,
           (count(*) over (partition by streak_group order by d))::numeric as value
    from grouped
  )
  select d as period_start, value, null::text as label
  from streaks
  where d between $1 and $2
  order by d$$
where name = 'journal_streak';

-- Cached Dream values predate both the owner-zone contract and the streak `last` rollup rule.
-- Preserve them until the first post-upgrade Dream run: the cache has no valid timezone identity
-- yet, so state anomalies ignore it, and Dream atomically replaces all rebuildable Dream rows
-- across full history. Legacy `query` rows are also derived and reconciled by that first run;
-- custom/manual and stored-only rows are never discarded by this migration.
create table metric_cache_state (
  singleton boolean primary key default true check (singleton),
  time_zone text not null,
  updated_at timestamptz not null default now()
);

revoke all on metric_cache_state from public;
grant select on metric_cache_state to minime_app, minime_engineer_ro;

revoke execute on function metric_agg(text, date, date) from public, minime_app, minime_engineer_ro;
drop function metric_agg(text, date, date);

create function metric_agg(
  metric_name text,
  from_date date,
  to_date date,
  requested_time_zone text
)
returns table (period_start date, value numeric, label text)
language plpgsql
security definer
stable
set search_path = pg_catalog, public, pg_temp
as $$
declare q text;
declare resolved_time_zone text;
begin
  select name into resolved_time_zone
  from pg_catalog.pg_timezone_names
  where lower(name) = lower(requested_time_zone)
  limit 1;
  if resolved_time_zone is null then
    raise exception 'INVALID_TIME_ZONE';
  end if;

  select d.agg_sql into q
  from public.metric_defs d
  where d.name = metric_name;
  if q is null then
    raise exception 'UNKNOWN_METRIC: %', metric_name;
  end if;
  return query execute q using from_date, to_date, resolved_time_zone;
end;
$$;

revoke execute on function metric_agg(text, date, date, text)
  from public, minime_app, minime_engineer_ro;
grant execute on function metric_agg(text, date, date, text)
  to minime_app, minime_engineer_ro;

-- Caller-zone metric queries are read-only. Only owner/control-plane dream maintenance writes
-- the canonical config.tz cache used by state anomalies.
revoke insert, update, delete on metric_values from minime_app;
