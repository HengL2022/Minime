-- Decision interview + branch graph extension (DECISIONS.md 2026-06-17).
-- Raw decision transcripts are append-only source records; decisions and branches are
-- queryable projections.

alter table decisions add column if not exists falsifier text;
alter table decisions add column if not exists stakes text;
alter table decisions add column if not exists reversibility text
  check (reversibility is null or reversibility in ('reversible','costly','irreversible'));
alter table decisions add column if not exists confidence smallint
  check (confidence is null or confidence between 0 and 100);
alter table decisions add column if not exists outcome_score smallint
  check (outcome_score is null or outcome_score between 0 and 100);
update decisions set tier = 1 where tier < 1;
alter table decisions drop constraint if exists decisions_tier_check;
alter table decisions add constraint decisions_tier_check check (tier in (1,2));

do $$
begin
  execute format('grant minime_app to %I', current_user);
end $$;

create table decision_transcripts (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references decisions(id) on delete cascade,
  ord smallint not null check (ord > 0),
  question_key text not null
    check (question_key in ('fork','falsifier','tension','prediction','stakes','review','freeform')),
  prompt text not null,
  answer text not null,
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by text not null default 'human',
  source text not null default 'manual',
  derived_from uuid,
  tier smallint not null default 1 check (tier in (1,2)),
  unique (decision_id, ord)
);

create table decision_branches (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references decisions(id) on delete cascade,
  label text not null,
  status text not null check (status in ('chosen','rejected','considered')),
  note text,
  would_be_right_if text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text not null default 'human',
  source text not null default 'manual',
  derived_from uuid,
  supersedes_id uuid,
  tier smallint not null default 1 check (tier in (1,2))
);

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

create or replace function decision_transcripts_append_only() returns trigger as $$
begin
  raise exception 'decision_transcripts is append-only (decision interview source of truth)';
end;
$$ language plpgsql;

create trigger decision_transcripts_no_update before update or delete on decision_transcripts
  for each row execute function decision_transcripts_append_only();
create trigger decision_transcripts_no_truncate before truncate on decision_transcripts
  for each statement execute function decision_transcripts_append_only();

create trigger decision_branches_updated_at before update on decision_branches
  for each row execute function set_updated_at();

create or replace function touch_decision_from_transcript() returns trigger as $$
begin
  update decisions set updated_at = now() where id = new.decision_id;
  return new;
end;
$$ language plpgsql;

create trigger decision_transcripts_touch_decision after insert on decision_transcripts
  for each row execute function touch_decision_from_transcript();

create or replace function sync_decision_branch_update() returns trigger as $$
begin
  update edges
  set rel = case new.status
    when 'chosen' then 'chose'
    when 'rejected' then 'rejected'
    else 'considered'
  end,
  source_table = 'decision_branches',
  source_id = new.id,
  tier = edge_source_tier('decision_branches', new.id)
  where src_type = 'decision'
    and src_id = new.decision_id
    and dst_type = 'decision_branch'
    and dst_id = new.id;
  update decisions set updated_at = now() where id = new.decision_id;
  return new;
end;
$$ language plpgsql;

create trigger decision_branches_sync_update after update on decision_branches
  for each row execute function sync_decision_branch_update();

create index decision_transcripts_decision_ord_idx on decision_transcripts (decision_id, ord);
create index decision_branches_decision_idx on decision_branches (decision_id);
create index decision_branches_status_idx on decision_branches (status);

grant select, insert on decision_transcripts to minime_app;
revoke update, delete on decision_transcripts from minime_app;
grant select, insert, update on decision_branches to minime_app;
revoke delete on decision_branches from minime_app;

alter table decision_transcripts enable row level security;
drop policy if exists tier_read on decision_transcripts;
create policy tier_read on decision_transcripts
  for select to minime_app using (tier <= app_allowed_tier());
drop policy if exists tier_write on decision_transcripts;
create policy tier_write on decision_transcripts
  for insert to minime_app with check (true);

alter table decision_branches enable row level security;
drop policy if exists tier_read on decision_branches;
create policy tier_read on decision_branches
  for select to minime_app using (tier <= app_allowed_tier());
drop policy if exists tier_write on decision_branches;
create policy tier_write on decision_branches
  for insert to minime_app with check (true);
drop policy if exists tier_update on decision_branches;
create policy tier_update on decision_branches
  for update to minime_app using (tier <= app_allowed_tier());
