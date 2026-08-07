-- Tier-2 unlocks are pending owner-approved requests bound to one MCP connection session.
-- Legacy actor-only grants cannot be safely associated with a live connection, so invalidate
-- them during the forward migration.

delete from session_unlocks;

alter table session_unlocks rename column granted_at to requested_at;
alter table session_unlocks rename column granted_via to requested_by;
alter table session_unlocks alter column expires_at drop not null;
alter table session_unlocks add column session_id uuid;
alter table session_unlocks add column requested_minutes smallint;
alter table session_unlocks add column approved_at timestamptz;
alter table session_unlocks add column approved_by text;

alter table session_unlocks alter column session_id set not null;
alter table session_unlocks alter column requested_minutes set not null;
alter table session_unlocks drop constraint if exists session_unlocks_scope_check;
alter table session_unlocks add constraint session_unlocks_scope_check check (scope = 'tier2');
alter table session_unlocks drop constraint if exists session_unlocks_requested_minutes_check;
alter table session_unlocks add constraint session_unlocks_requested_minutes_check
  check (requested_minutes between 1 and 1440);
alter table session_unlocks drop constraint if exists session_unlocks_approval_consistency_check;
alter table session_unlocks add constraint session_unlocks_approval_consistency_check check (
  (approved_at is null and approved_by is null and expires_at is null)
  or
  (approved_at is not null and nullif(btrim(approved_by), '') is not null
    and expires_at is not null and expires_at > approved_at)
);

drop index if exists session_unlocks_scope_expires_idx;
drop index if exists session_unlocks_actor_scope_expires_idx;
create index session_unlocks_active_session_idx
  on session_unlocks (session_id, requested_by, expires_at)
  where approved_at is not null and expires_at is not null;

-- The runtime role can create a request without learning or mutating the backing row. Both
-- identity settings are transaction-local; fixed errors avoid reflecting either value.
create or replace function app_request_tier2_unlock(unlock_minutes smallint)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare actor_name text := nullif(current_setting('minime.actor', true), '');
declare session_text text := nullif(current_setting('minime.session_id', true), '');
declare session_value uuid;
declare request_id uuid;
begin
  if unlock_minutes is null or unlock_minutes not between 1 and 1440 then
    raise exception 'unlock_minutes_invalid';
  end if;
  if actor_name is null then raise exception 'unlock_actor_required'; end if;
  if session_text is null then raise exception 'unlock_session_required'; end if;
  begin
    session_value := session_text::uuid;
  exception when invalid_text_representation then
    raise exception 'unlock_session_required';
  end;

  insert into session_unlocks
    (scope, requested_at, requested_by, session_id, requested_minutes)
  values
    ('tier2', clock_timestamp(), actor_name, session_value, unlock_minutes)
  returning id into request_id;
  return request_id;
end;
$$;

-- A malformed or absent session setting must lock, not raise. Comparing UUID text avoids casting
-- the untrusted setting while retaining an exact session match.
create or replace function app_allowed_tier() returns smallint
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select case when exists (
    select 1
    from session_unlocks u
    where u.scope = 'tier2'
      and u.approved_at is not null
      and u.approved_by is not null
      -- statement_timestamp(), unlike now(), advances between statements in one long MCP
      -- handler transaction, so an approval cannot remain usable after wall-clock expiry.
      and u.expires_at > statement_timestamp()
      -- Engineering sessions are permanently locked at tier 1. Even an actor/session pair
      -- copied out of band must not turn the SELECT-only role into an MCP session.
      and session_user <> 'minime_engineer_ro'
      and nullif(current_setting('minime.actor', true), '') is not null
      and u.requested_by = current_setting('minime.actor', true)
      and nullif(current_setting('minime.session_id', true), '') is not null
      and u.session_id::text = current_setting('minime.session_id', true)
  ) then 2 else 1 end::smallint
$$;

revoke all privileges on session_unlocks from minime_app;
revoke all privileges on session_unlocks from minime_engineer_ro;
revoke execute on function app_request_tier2_unlock(smallint) from public;
revoke execute on function app_allowed_tier() from public;
grant execute on function app_request_tier2_unlock(smallint) to minime_app;
grant execute on function app_allowed_tier() to minime_app;
