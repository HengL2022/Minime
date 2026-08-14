-- Task recurrence primitive (livability program, W3-1): a recurring task materializes its own
-- next instance when the current one is marked done, instead of the owner re-creating "water
-- the plants" by hand every week. Recurrence lives on the tasks row itself (columns, not a
-- separate task_templates table) -- the reversible minimal design: dropping recur_freq back to
-- null is enough to stop a task recurring, and every materialized instance is an ordinary task
-- row with full I5 provenance back to the one it replaced (repo.ts materializeRecurrence).
--
-- Numbered 030: the spec text for this task said 027, already taken by
-- 027_life_metrics_seed.sql; 029 (the program's own correction) was ALSO taken in the interim by
-- 029_scope_entity_conflicts_by_tier.sql (W2-6 review fix, landed on this branch first). 030 is
-- the true next free number as of this migration.
--
--   recur_freq: null means "does not recur". One of daily/weekly/monthly/yearly otherwise.
--   recur_interval: every N units of recur_freq (default 1 == every day/week/month/year).
--     Meaningless without recur_freq but always has a valid value (>0) so nextDue() never has
--     to special-case an unset interval.
--   recur_anchor: the calendar date recurrence is phase-locked to -- the weekday for weekly,
--     the day-of-month (end-of-month clamped) for monthly/yearly. repo.upsertTask defaults it
--     to the task's own due date at creation time, so a biweekly task keeps landing on the same
--     weekday, and a monthly-on-the-31st task recovers the 31st after a short month, even
--     though each successor's OWN due may itself be end-of-month clamped.

alter table tasks
  add column recur_freq text
    check (recur_freq in ('daily', 'weekly', 'monthly', 'yearly')),
  add column recur_interval int not null default 1
    check (recur_interval > 0),
  add column recur_anchor date;

-- habit_streak: consecutive-day completion streak per recurring task, labeled by title -- the
-- same distinct-day/streak-group technique as journal_streak (026_time_semantics.sql), grouped
-- per title instead of computed over the whole table. Follows the 026 agg_sql contract: $1/$2
-- are inclusive local dates, $3 is the explicitly requested IANA zone, and the query returns
-- (period_start date, value numeric, label text). rollup='last' matches journal_streak/body_mass
-- -- a streak is a current-value-as-of-period-end count, not additive.
--
-- SAFETY (I3): unlike journal_streak/mood/energy (numbers only, no label), this metric's LABEL
-- is the task's own title text -- free-form content, not a count. minime_query_metric has no
-- unlock gate at all (metric_defs.agg_sql IS the whitelist boundary, spec Sec7), so this query
-- must do its own tier screening rather than relying on the caller's session. Restricted to
-- `tier = 1`: tier-0 rows must never surface as content under any circumstances ("never log,
-- print, or snapshot the contents of tier-0 rows", CLAUDE.md), and a tier-2 recurring task's
-- title must stay behind its normal time-boxed unlock rather than leaking through an
-- always-available metric label. In practice this excludes nothing real: minime_upsert_task
-- never exposes a tier parameter, so every agent-created task is already tier 1 (DECISIONS.md
-- entry accompanying this migration). `superseded_at is null` mirrors
-- 028_correction_supersede.sql's mood/energy fix -- ordinary future-proofing, since tasks are
-- explicitly out of scope for minime_correct today (src/mcp/tools/correct.ts) and so cannot
-- actually be superseded yet.
insert into metric_defs (name, unit, description, agg_sql, rollup) values
('habit_streak', 'days', 'Consecutive-day completion streak per recurring task, labeled by title',
$$with days as (
    select distinct title, (completed_at at time zone $3)::date as d
    from tasks
    where recur_freq is not null
      and status = 'done'
      and completed_at is not null
      and tier = 1
      and superseded_at is null
      and (completed_at at time zone $3)::date <= $2
  ), grouped as (
    select title, d,
           d - (row_number() over (partition by title order by d))::int as streak_group
    from days
  ), streaks as (
    select title, d,
           (count(*) over (partition by title, streak_group order by d))::numeric as value
    from grouped
  )
  select d as period_start, value, title as label
  from streaks
  where d between $1 and $2
  order by d, title$$, 'last')
on conflict (name) do nothing;
