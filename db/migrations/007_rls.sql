-- M6 hardening (spec §12): belt-and-braces on top of the repo.ts tier predicate.
-- App role `minime_app` (nologin by default; owner may grant login and point DATABASE_URL at it).
-- Tier-0 tables have no SELECT grant; the only aggregate path is the security definer fn below.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'minime_app') then
    create role minime_app nologin;
  end if;
end $$;

-- allowed_tier(): 2 while a non-expired tier2 unlock exists, else 1. Security definer so it
-- works even when session_unlocks itself is not granted.
create or replace function app_allowed_tier() returns smallint
language sql security definer stable as $$
  select case when exists (
    select 1 from session_unlocks where scope = 'tier2' and expires_at > now()
  ) then 2 else 1 end::smallint
$$;

-- metric_agg(): the single audited door to whitelisted aggregate SQL (incl. tier-0 sources).
-- agg_sql is owner-curated; minime_app has no write access to metric_defs.
create or replace function metric_agg(metric_name text, from_date date, to_date date)
returns table (period_start date, value numeric, label text)
language plpgsql security definer stable as $$
declare q text;
begin
  select agg_sql into q from metric_defs where name = metric_name;
  if q is null then
    raise exception 'UNKNOWN_METRIC: %', metric_name;
  end if;
  return query execute q using from_date, to_date;
end;
$$;

-- Grants: content tables readable per tier; tier-0 tables get nothing.
grant usage on schema public to minime_app;
grant select, insert, update on
  values_items, goals, principles, tasks, commitments, decisions, journal_entries,
  people, person_aliases, interactions, pages, calendar_events, email_meta, inbox_items,
  chunks, edges, review_queue, session_unlocks, metric_values
to minime_app;
grant select on metric_defs to minime_app;
grant select, insert on events to minime_app;
revoke update, delete on events from minime_app;
grant execute on function app_allowed_tier(), metric_agg(text, date, date) to minime_app;
-- deliberately NO grants on transactions / health_samples (tier 0)

-- RLS mirroring the tier rules for the app role (owner connections bypass; repo.ts enforces there).
do $$
declare t text;
begin
  foreach t in array array['journal_entries','interactions','email_meta','pages','chunks',
                           'tasks','goals','values_items','principles','decisions',
                           'commitments','people','calendar_events','inbox_items']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tier_read on %I', t);
    execute format('create policy tier_read on %I for select to minime_app using (tier <= app_allowed_tier())', t);
    execute format('drop policy if exists tier_write on %I', t);
    execute format('create policy tier_write on %I for insert to minime_app with check (true)', t);
    execute format('drop policy if exists tier_update on %I', t);
    execute format('create policy tier_update on %I for update to minime_app using (tier <= app_allowed_tier())', t);
  end loop;
end $$;
