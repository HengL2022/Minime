-- Tier-aware graph edges + hot-path indexes. Edges can reveal sensitive existence
-- facts ("this person is mentioned in a journal"), so each edge inherits the tier of
-- the row that produced it and agent-facing reads must filter by that tier.

alter table edges add column if not exists tier smallint not null default 1;

create or replace function edge_source_tier(table_name text, row_id uuid)
returns smallint
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare out_tier smallint;
begin
  if table_name is null or row_id is null then
    return 1;
  end if;

  case table_name
    when 'values_items' then select tier into out_tier from values_items where id = row_id;
    when 'goals' then select tier into out_tier from goals where id = row_id;
    when 'principles' then select tier into out_tier from principles where id = row_id;
    when 'tasks' then select tier into out_tier from tasks where id = row_id;
    when 'commitments' then select tier into out_tier from commitments where id = row_id;
    when 'decisions' then select tier into out_tier from decisions where id = row_id;
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

create or replace function set_edge_tier()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.tier := edge_source_tier(new.source_table, new.source_id);
  return new;
end;
$$;

update edges
set tier = edge_source_tier(source_table, source_id)
where source_table is not null and source_id is not null;

drop trigger if exists edges_set_tier on edges;
create trigger edges_set_tier
  before insert or update of source_table, source_id on edges
  for each row execute function set_edge_tier();

alter table edges enable row level security;
drop policy if exists tier_read on edges;
create policy tier_read on edges for select to minime_app using (tier <= app_allowed_tier());
drop policy if exists tier_write on edges;
create policy tier_write on edges for insert to minime_app with check (true);
drop policy if exists tier_update on edges;
create policy tier_update on edges for update to minime_app using (tier <= app_allowed_tier());

create index if not exists tasks_open_due_tier_idx
  on tasks (due, title) where status in ('inbox','active','waiting');
create index if not exists commitments_open_due_tier_idx
  on commitments (due) where status = 'open';
create index if not exists decisions_review_due_tier_idx
  on decisions (review_at) where reviewed_at is null;
create index if not exists session_unlocks_scope_expires_idx
  on session_unlocks (scope, expires_at);
create index if not exists session_unlocks_actor_scope_expires_idx
  on session_unlocks (granted_via, scope, expires_at);
create index if not exists review_queue_open_kind_created_idx
  on review_queue (kind, created_at) where status = 'open';
create index if not exists interactions_person_occurred_idx
  on interactions (person_id, occurred_at desc);
create index if not exists tasks_goal_id_idx on tasks (goal_id);
create index if not exists goals_parent_id_idx on goals (parent_id);
create index if not exists decisions_principle_id_idx on decisions (principle_id);

-- Access ranking filters on the primary returned id inside the JSON payload.
create index if not exists events_get_context_primary_id_at_idx
  on events ((payload->'returned_ids'->>0), at)
  where verb = 'tool:minime_get_context';

create or replace function app_allowed_tier() returns smallint
language sql security definer stable
set search_path = public, pg_temp
as $$
  with actor as (
    select nullif(current_setting('minime.actor', true), '') as name
  )
  select case when exists (
    select 1
    from session_unlocks, actor
    where scope = 'tier2'
      and expires_at > now()
      and (actor.name is null or granted_via = actor.name)
  ) then 2 else 1 end::smallint
$$;

create or replace function metric_agg(metric_name text, from_date date, to_date date)
returns table (period_start date, value numeric, label text)
language plpgsql security definer stable
set search_path = public, pg_temp
as $$
declare q text;
begin
  select agg_sql into q from metric_defs where name = metric_name;
  if q is null then
    raise exception 'UNKNOWN_METRIC: %', metric_name;
  end if;
  return query execute q using from_date, to_date;
end;
$$;
