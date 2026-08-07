-- Correction/supersession columns for the W2 correction loop (livability program, W2-1).
--
-- Adds `superseded_by uuid` and `superseded_at timestamptz` to every PARENTS-map content table
-- (src/db/repo.ts) so an owner/agent correction can be recorded without ever deleting or
-- overwriting the original row (I5 provenance). Semantics (DECISIONS.md 2026-08-07, ratified):
--   * both null                          -> live (current, authoritative row)
--   * superseded_by set, superseded_at set   -> superseded by that successor row. The successor
--     row's own `supersedes_id` (002_core.sql) is the forward pointer stamped at write time;
--     this pair of columns is the matching backward pointer stamped on the OLD row once the
--     successor exists -- the same write-order precedent as retypeOrgToPerson (repo.ts), which
--     stamps `supersedes_id` on its successor row after creating it.
--   * superseded_at set, superseded_by null -> retracted (soft-deleted; no successor)
-- The check constraint below rejects the fourth, meaningless combination (a successor recorded
-- with no timestamp), which cannot arise from either write pattern above.
--
-- Columns are plain `uuid`/`timestamptz` with no foreign key, matching the existing sibling
-- provenance columns `derived_from`/`supersedes_id` (002_core.sql), which are also untyped
-- pointers rather than same-table FKs.
--
-- I8 note: this is a product-visible correction feature on ordinary content rows. It does not
-- touch the `events` table, which remains insert-only and unmodified by this migration --
-- content supersession is an audited product feature, not an I8 violation (review 2026-08-07).
--
-- This migration does NOT build the correction tool itself (minime_correct is a later W2 task)
-- and does not change any tier_read/tier_update RLS policy -- the existing tier_update policies
-- (007_rls.sql, decision_branches in 014_decision_interview.sql, orgs in 008_orgs.sql, all
-- extended in 021_runtime_app_role.sql) already gate every UPDATE on these tables by
-- app_allowed_tier(), including the new column-limited grant below.
--
-- journal_entries is also the one PARENTS table whose content already feeds a numeric aggregate:
-- the 'mood'/'energy' metric_defs seeded in 027_life_metrics_seed.sql average every row with a
-- non-null mood/energy value. Once a later correction stamps superseded_at on an amended or
-- retracted journal row (minime_correct, W2-4), the superseded original would otherwise keep
-- contributing its old value alongside its successor's -- silently double-counting a corrected
-- self-report in a user-facing daily average (I6 numeric trustworthiness). This migration updates
-- both agg_sql bodies, adding `and superseded_at is null`, in the same migration that defines
-- superseded_at's meaning, rather than leaving the metric silently wrong until the correction
-- tool ships.
--
-- Idempotent: add-column-if-not-exists and drop-then-add constraint, matching the
-- 016_phantom_person_review.sql / 022_entity_derivation_tiers.sql style. The agg_sql updates
-- below are plain UPDATEs keyed on `name`, idempotent the same way 026_time_semantics.sql's are.

do $$
declare t text;
begin
  foreach t in array array[
    'pages', 'journal_entries', 'interactions', 'decisions', 'decision_branches', 'tasks',
    'goals', 'values_items', 'principles', 'people', 'orgs', 'commitments'
  ] loop
    execute format('alter table %I add column if not exists superseded_by uuid', t);
    execute format('alter table %I add column if not exists superseded_at timestamptz', t);
    execute format('alter table %I drop constraint if exists %I', t, t || '_supersede_check');
    execute format(
      'alter table %I add constraint %I check (superseded_by is null or superseded_at is not null)',
      t, t || '_supersede_check');
  end loop;
end $$;

-- Keep the mood/energy day-averages honest once corrections exist: exclude superseded rows so
-- amending a journal entry never double-counts both the original and its successor for the same
-- self-report. Same $1/$2/$3 contract as 026_time_semantics.sql/027_life_metrics_seed.sql; only
-- the added `superseded_at is null` predicate differs from the 027 seed.
update metric_defs set agg_sql =
$$select (at at time zone $3)::date as period_start,
         round(avg(mood)::numeric, 2) as value,
         null::text as label
  from journal_entries
  where mood is not null
    and superseded_at is null
    and (at at time zone $3)::date between $1 and $2
  group by 1 order by 1$$
where name = 'mood';

update metric_defs set agg_sql =
$$select (at at time zone $3)::date as period_start,
         round(avg(energy)::numeric, 2) as value,
         null::text as label
  from journal_entries
  where energy is not null
    and superseded_at is null
    and (at at time zone $3)::date between $1 and $2
  group by 1 order by 1$$
where name = 'energy';

-- Least-privilege grants. Six of the twelve tables above already carry full table-level UPDATE
-- for minime_app (021_runtime_app_role.sql: tasks, decisions, people, pages, orgs,
-- decision_branches) -- that existing grant already covers these two new columns, so nothing
-- more is needed for them. The remaining six tables have never had any UPDATE grant for
-- minime_app (021 only re-granted SELECT + INSERT on them). Grant UPDATE on exactly the two new
-- columns -- never the whole row -- so a future correction tool can stamp a supersession without
-- gaining general write access to journal/interaction/commitment/goal/value/principle content
-- (entry_md, summary, what, statement, rule stay unwritable by minime_app).
grant update (superseded_by, superseded_at) on
  journal_entries, interactions, commitments, goals, values_items, principles
to minime_app;
