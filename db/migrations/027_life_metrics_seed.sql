-- Seed mood/energy/body_mass/hr_resting metric defs and widen the rollup vocabulary to 'avg'.
-- Follows the 026 agg_sql contract exactly: $1/$2 are inclusive local dates, $3 is the
-- explicitly requested IANA zone, the query returns (period_start date, value numeric,
-- label text), and timestamp sources bucket with `(col at time zone $3)::date`.
--
-- mood/energy read tier-2 journal_entries, but only their already-aggregated daily average —
-- never entry_md prose. Ratified as agent-readable without a tier-2 unlock (DECISIONS.md
-- 2026-08-07), extending the existing journal_streak precedent (a dates-only aggregate over the
-- same table) to a numeric self-report aggregate. body_mass/hr_resting are ordinary tier-0
-- health_samples aggregates, kinds/units matching src/importers/health.ts KIND_WHITELIST.

alter table metric_defs drop constraint metric_defs_rollup_check;
alter table metric_defs
  add constraint metric_defs_rollup_check check (rollup in ('sum', 'last', 'avg'));

insert into metric_defs (name, unit, description, agg_sql, rollup) values

('mood', 'score', 'Average daily self-reported mood (1-5) from journal entries',
$$select (at at time zone $3)::date as period_start,
         round(avg(mood)::numeric, 2) as value,
         null::text as label
  from journal_entries
  where mood is not null
    and (at at time zone $3)::date between $1 and $2
  group by 1 order by 1$$, 'avg'),

('energy', 'score', 'Average daily self-reported energy (1-5) from journal entries',
$$select (at at time zone $3)::date as period_start,
         round(avg(energy)::numeric, 2) as value,
         null::text as label
  from journal_entries
  where energy is not null
    and (at at time zone $3)::date between $1 and $2
  group by 1 order by 1$$, 'avg'),

('body_mass', 'kg', 'Average daily body mass reading',
$$select (at at time zone $3)::date as period_start,
         avg(value)::numeric as value,
         null::text as label
  from health_samples
  where kind = 'body_mass'
    and (at at time zone $3)::date between $1 and $2
  group by 1 order by 1$$, 'last'),

('hr_resting', 'bpm', 'Average daily resting heart rate',
$$select (at at time zone $3)::date as period_start,
         avg(value)::numeric as value,
         null::text as label
  from health_samples
  where kind = 'hr_resting'
    and (at at time zone $3)::date between $1 and $2
  group by 1 order by 1$$, 'avg')

on conflict (name) do nothing;
