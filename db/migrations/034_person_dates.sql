-- Important dates (livability program, W3-10): birthdays, anniversaries, and free-form recurring
-- dates (a pet's gotcha day, a memorial) attached to a person, so minime_state and the morning
-- brief can surface "Alice's birthday is in 6 days" without the owner re-remembering it every
-- year. A separate table rather than columns on people: supports multiple/custom dates per
-- person and never touches the promotion-sensitive people row (repo.retypeOrgToPerson,
-- mergePersonIntoPerson).
--
-- Numbered 034: the task's own spec text targeted migration 030 (provisional); 030-033 were all
-- already taken by W3-1/W3-2/W3-3/W3-7 landing on this branch first
-- (030_task_recurrence.sql, 031_calendar_occurrences.sql, 032_timeline_locked_count.sql,
-- 033_ops_failure_kind.sql). 034 is the true next free number as of this migration -- noted here
-- since it is a numbering deviation from the task's own spec, not because renumbering itself is a
-- contract decision (same convention as 030/031's own migration-comment precedent).

create table person_dates (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id),
  kind text not null check (kind in ('birthday', 'anniversary', 'custom')),
  -- label is nullable: birthday/anniversary are one-per-person (label stays null); 'custom'
  -- requires one, to tell multiple custom dates for the same person apart (e.g. "mom's memorial"
  -- vs "house purchase"). The check below ties label presence exactly to kind='custom' in both
  -- directions -- this also keeps the unique index below airtight (see its comment).
  label text check (
    (kind = 'custom' and label is not null and btrim(label) <> '')
    or (kind <> 'custom' and label is null)
  ),
  month int not null check (month between 1 and 12),
  day int not null check (day between 1 and 31),
  year int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text not null default 'human',
  source text not null default 'manual',
  derived_from uuid,
  supersedes_id uuid,
  tier smallint not null default 1
);

-- coalesce(label, '') rather than a bare unique(person_id, kind, label): Postgres never treats
-- two NULLs as equal for uniqueness purposes, so a plain unique constraint would let repeated
-- "set my birthday" calls silently mint a new row every time instead of updating the one row
-- (label is null for both, so nothing would ever collide). repo.upsertPersonDate's own ON
-- CONFLICT target must name this exact expression to match this index for conflict inference.
create unique index person_dates_person_kind_label_idx
  on person_dates (person_id, kind, (coalesce(label, '')));

create trigger person_dates_updated_at before update on person_dates
  for each row execute function set_updated_at();

-- M6 parity (007_rls.sql / 008_orgs.sql): same grant + tier policy shape as every other tier-1
-- content table, using the post-021 predicate form (021_runtime_app_role.sql hardened every
-- pre-existing tier_read/tier_update policy to add this same `tier >= 1` lower bound; a table
-- created after 021 writes it directly rather than needing a later ALTER POLICY). Insert-only,
-- update-only -- no delete grant: this is an insert/update-only agent write path (risk note,
-- W3-10 spec) with no owner-facing delete tool.
grant select, insert, update on person_dates to minime_app;
alter table person_dates enable row level security;
-- tier_read also names minime_engineer_ro directly (not layered on with a later ALTER POLICY,
-- since this policy is brand new): 018_engineer_role.sql's own comment is explicit that "a NEW
-- RLS table must add itself" alongside minime_app, and test/m15.roles.test.ts's "every tier_read
-- policy scoped to minime_app also covers minime_engineer_ro" is a live regression test over
-- pg_policies, not a historical snapshot -- a person_dates tier_read policy missing
-- minime_engineer_ro fails that test immediately. (W3-10 spec text said not to touch 024's own
-- frozen grant statement/postcondition array -- honored literally: 024_engineer_content_boundary
-- .sql itself is untouched; this table's engineer access is granted fresh, here, in its own
-- migration, the same way 026_time_semantics.sql granted metric_cache_state.) person_dates is
-- ordinary tier-1 content, the same engineer-readable default every other tier-1 table already
-- has -- not a more sensitive category that would justify a new exception.
grant select on person_dates to minime_engineer_ro;
create policy tier_read on person_dates for select to minime_app, minime_engineer_ro
  using (tier >= 1 and tier <= app_allowed_tier());
create policy tier_write on person_dates for insert to minime_app with check (true);
create policy tier_update on person_dates for update to minime_app
  using (tier >= 1 and tier <= app_allowed_tier());
