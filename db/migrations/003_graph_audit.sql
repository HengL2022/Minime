create table edges (
  id uuid primary key default gen_random_uuid(),
  src_type text not null, src_id uuid not null, rel text not null,
  dst_type text not null, dst_id uuid not null,
  valid_from date, valid_to date,
  source_table text, source_id uuid,            -- the row this edge was extracted from
  extracted_by text not null default 'human',
  confidence real not null default 1.0,
  created_at timestamptz not null default now()
);
create index on edges (src_type, src_id, rel);
create index on edges (dst_type, dst_id, rel);

create table events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text not null,                  -- 'human' | 'agent:<client>' | 'system:<job>'
  verb text not null,                   -- 'tool:minime_search', 'write:journal', …
  entity_type text,
  entity_id uuid,
  payload jsonb not null default '{}'
);

-- Append-only (I8): block UPDATE/DELETE regardless of role; M6 RLS revokes privileges as well.
create or replace function events_append_only() returns trigger as $$
begin
  raise exception 'events is append-only (invariant I8)';
end;
$$ language plpgsql;

create trigger events_no_update before update or delete on events
  for each row execute function events_append_only();
create trigger events_no_truncate before truncate on events
  for each statement execute function events_append_only();

create table review_queue (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('contradiction','stale','duplicate','decision_review','inbox_unfiled')),
  payload jsonb not null,
  status text not null default 'open' check (status in ('open','resolved','dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table session_unlocks (
  id uuid primary key default gen_random_uuid(),
  scope text not null default 'tier2',
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  granted_via text not null
);
