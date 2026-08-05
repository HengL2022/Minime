-- Runtime/app boundary.  The owner role runs migrations; the resident application may use
-- minime_app only after the installer publishes MINIME_APP_DATABASE_URL.
do $$ begin
  if current_database() = 'minime' and not exists (select 1 from pg_roles where rolname = 'minime_app') then
    create role minime_app nologin nosuperuser nocreatedb nocreaterole nobypassrls noinherit noreplication;
  end if;
end $$;

-- Existing installations may have provisioned this role before the least-privilege boundary
-- was complete. Reassert every posture the migration owner can safely change. SUPERUSER is
-- superuser-only in PostgreSQL; reject an already-superuser app role rather than pretending a
-- non-superuser migration repaired it.
do $$
declare r record;
begin
  if current_database() = 'minime' then
    select rolsuper into r from pg_roles where rolname = 'minime_app';
    if r.rolsuper then raise exception 'runtime_app_role_posture_invalid'; end if;
    execute 'alter role minime_app nocreatedb nocreaterole noinherit';
    if exists (
      select 1 from pg_roles
      where rolname = 'minime_app' and (rolreplication or rolbypassrls)
    ) then
      raise exception 'runtime_app_role_posture_invalid';
    end if;
  end if;
end $$;

-- 014 granted the app role to the owner for its old policy model.  The owner now uses the
-- dedicated control-plane pool, so remove that inherited/settable path during cutover.
do $$ begin
  if current_database() = 'minime' then revoke minime_app from minime; end if;
end $$;

-- A NOINHERIT role can still SET ROLE into a membership. Remove every pre-existing membership
-- granted to the app role so no control-plane or owner role can be reached from runtime SQL.
do $$
declare member_role text;
begin
  if current_database() = 'minime' then
    for member_role in
      select granted.rolname
      from pg_auth_members m
      join pg_roles granted on granted.oid = m.roleid
      join pg_roles member on member.oid = m.member
      where member.rolname = 'minime_app'
    loop
      execute format('revoke %I from minime_app', member_role);
    end loop;
    if exists (
      select 1
      from pg_auth_members m
      join pg_roles member on member.oid = m.member
      where member.rolname = 'minime_app'
    ) then
      raise exception 'runtime_app_role_posture_invalid';
    end if;
  end if;
end $$;

do $$ begin
  execute format('grant connect on database %I to minime_app', current_database());
end $$;
grant usage on schema public to minime_app;

-- This is the only tier decision available to the app role.  Actor identity is transaction-local
-- and therefore cannot leak across pooled connections.  A missing actor is deliberately locked.
create or replace function app_allowed_tier() returns smallint
language sql security definer stable set search_path = public as $$
  select case when exists (
    select 1 from session_unlocks u
    where u.scope = 'tier2' and u.expires_at > now()
      and (nullif(current_setting('minime.actor', true), '') is not null
           and u.granted_via = current_setting('minime.actor', true))
  ) then 2 else 1 end::smallint
$$;

-- Trigger-side source lookup must bypass invoker RLS: otherwise a locked app inserting an edge
-- from its own tier-2 write would not see the source row and the edge would silently downgrade
-- to tier 1. This fixed allow-list runs as the migration owner and never accepts an identifier.
create or replace function edge_source_tier(table_name text, row_id uuid)
returns smallint
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare out_tier smallint;
begin
  if table_name is null or row_id is null then return 1; end if;
  case table_name
    when 'values_items' then select tier into out_tier from values_items where id = row_id;
    when 'goals' then select tier into out_tier from goals where id = row_id;
    when 'principles' then select tier into out_tier from principles where id = row_id;
    when 'tasks' then select tier into out_tier from tasks where id = row_id;
    when 'commitments' then select tier into out_tier from commitments where id = row_id;
    when 'decisions' then select tier into out_tier from decisions where id = row_id;
    when 'decision_branches' then select tier into out_tier from decision_branches where id = row_id;
    when 'journal_entries' then select tier into out_tier from journal_entries where id = row_id;
    when 'people' then select tier into out_tier from people where id = row_id;
    when 'orgs' then select tier into out_tier from orgs where id = row_id;
    when 'interactions' then select tier into out_tier from interactions where id = row_id;
    when 'pages' then select tier into out_tier from pages where id = row_id;
    when 'calendar_events' then select tier into out_tier from calendar_events where id = row_id;
    when 'email_meta' then select tier into out_tier from email_meta where id = row_id;
    when 'inbox_items' then select tier into out_tier from inbox_items where id = row_id;
    when 'chunks' then select tier into out_tier from chunks where id = row_id;
    else out_tier := null;
  end case;
  return coalesce(out_tier, 1);
end;
$$;

revoke all privileges on all tables in schema public from minime_app;
revoke all privileges on all sequences in schema public from minime_app;
revoke all privileges on all functions in schema public from minime_app;

-- Re-apply the small, reviewable function allow-list after the blanket revoke above.
revoke execute on function app_allowed_tier() from public;
revoke execute on function metric_agg(text, date, date) from public;
revoke execute on function cjk_fold(text) from public;
revoke execute on function edge_source_tier(text, uuid) from public;
grant execute on function app_allowed_tier() to minime_app;
grant execute on function metric_agg(text, date, date) to minime_app;
grant execute on function cjk_fold(text) to minime_app;
grant execute on function edge_source_tier(text, uuid) to minime_app;

grant select on schema_migrations, values_items, goals, principles, commitments, journal_entries,
  person_aliases, interactions, calendar_events, email_meta, org_aliases,
  decision_transcripts, decision_branches, edge_validations, tasks, decisions, people, pages,
  metric_values, review_queue, inbox_items, orgs, events, chunks, edges,
  metric_defs to minime_app;
grant insert on values_items, goals, principles, commitments, journal_entries, person_aliases,
  interactions, calendar_events, email_meta, org_aliases, decision_transcripts, decision_branches,
  edge_validations, tasks, decisions, people, pages, metric_values, review_queue, inbox_items,
  orgs, events, chunks, edges, session_unlocks, transactions, health_samples to minime_app;
grant update on tasks, decisions, people, pages, metric_values, review_queue, inbox_items, orgs,
  chunks, edges, decision_branches, calendar_events to minime_app;
grant delete on chunks, edges to minime_app;
grant usage, select on sequence events_id_seq to minime_app;

drop policy if exists tier_delete on chunks;
create policy tier_delete on chunks for delete to minime_app
  using (tier >= 1 and tier <= app_allowed_tier());
drop policy if exists tier_delete on edges;
create policy tier_delete on edges for delete to minime_app
  using (tier >= 1 and tier <= app_allowed_tier());

-- Keep the app's object surface explicit. Tier-0 tables have no SELECT grant. The catalog
-- pg_control_system() revoke is best-effort: PostgreSQL clusters whose owner is not a
-- superuser may retain that built-in's implicit PUBLIC EXECUTE ACL; no direct minime_app grant
-- is added here, and deployments needing zero catalog metadata exposure must harden it as a
-- separate superuser control-plane step.
do $$
begin
  -- Built-ins normally have a NULL ACL (implicit PUBLIC EXECUTE), for which REVOKE only
  -- emits a warning as the non-superuser owner. Attempt the hardening only when an explicit
  -- ACL exists; superuser-controlled clusters can still remove the implicit grant separately.
  if exists (
    select 1 from pg_proc
    where oid = 'pg_catalog.pg_control_system()'::regprocedure
      and proacl is not null
      and (
        proowner = (select oid from pg_roles where rolname = current_user)
        or (select rolsuper from pg_roles where rolname = current_user)
      )
  ) then
    execute 'revoke execute on function pg_catalog.pg_control_system() from public, minime_app';
  end if;
end $$;
revoke create on schema public from public, minime_app;

-- Existing tier predicates are extended/replaced in place so new actor sessions receive the
-- lower bound as well as the unlock ceiling.  There is deliberately no created_by exception:
-- a locked actor must not read its own tier-2 write. Tables without a tier_read policy are
-- intentionally left alone (events/audit and tier-0 imports are not content readers).
do $$
declare t text;
begin
  foreach t in array array[
    'journal_entries','interactions','email_meta','pages','chunks','tasks','goals','values_items',
    'principles','decisions','commitments','people','calendar_events','inbox_items','edges','orgs',
    'decision_transcripts','decision_branches'
  ] loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
      and policyname = 'tier_read') then
      if exists (select 1 from pg_roles where rolname = 'minime_engineer_ro') then
        execute format(
          'alter policy tier_read on %I to minime_app, minime_engineer_ro using (tier >= 1 and tier <= app_allowed_tier())', t);
      else
        execute format(
          'alter policy tier_read on %I to minime_app using (tier >= 1 and tier <= app_allowed_tier())', t);
      end if;
    end if;
  end loop;
end $$;

do $$ begin
  if current_database() = 'minime' then
    alter default privileges for role minime in schema public revoke all on tables from minime_app;
    alter default privileges for role minime in schema public revoke all on sequences from minime_app;
    alter default privileges for role minime in schema public revoke all on functions from minime_app;
    execute format('revoke connect, temporary on database %I from public', current_database());
    execute format('grant connect on database %I to %I', current_database(), current_user);
    if exists (select 1 from pg_roles where rolname = 'minime_app') then
      execute format('grant connect on database %I to minime_app', current_database());
    end if;
    if exists (select 1 from pg_roles where rolname = 'minime_engineer_ro') then
      execute format('grant connect on database %I to minime_engineer_ro', current_database());
    end if;
  end if;
end $$;
