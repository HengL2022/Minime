-- Self-model, state, memory (spec §7). Standard columns on every substantive table.

create table values_items (
  id uuid primary key default gen_random_uuid(),
  statement text not null,
  priority int not null default 100,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text not null default 'human',
  source text not null default 'manual',
  derived_from uuid,
  supersedes_id uuid,
  tier smallint not null default 1
);

create table goals (
  id uuid primary key default gen_random_uuid(),
  horizon text not null check (horizon in ('life','year','quarter')),
  statement text not null,
  why text,
  status text not null default 'active' check (status in ('active','achieved','dropped')),
  parent_id uuid references goals(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text not null default 'human',
  source text not null default 'manual',
  derived_from uuid,
  supersedes_id uuid,
  tier smallint not null default 1
);

create table principles (
  id uuid primary key default gen_random_uuid(),
  rule text not null,
  domain text,
  learned_from_decision uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text not null default 'human',
  source text not null default 'manual',
  derived_from uuid,
  supersedes_id uuid,
  tier smallint not null default 1
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid references goals(id),
  title text not null,
  body text,
  status text not null default 'inbox'
    check (status in ('inbox','active','waiting','done','dropped')),
  due date,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text not null default 'human',
  source text not null default 'manual',
  derived_from uuid,
  supersedes_id uuid,
  tier smallint not null default 1
);

create table commitments (
  id uuid primary key default gen_random_uuid(),
  what text not null,
  to_whom text not null,
  due date,
  status text not null default 'open'
    check (status in ('open','kept','renegotiated','broken')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text not null default 'human',
  source text not null default 'manual',
  derived_from uuid,
  supersedes_id uuid,
  tier smallint not null default 1
);

create table decisions (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  options jsonb not null,
  criteria jsonb,
  choice text,
  reasoning text,
  expected_outcome text,
  decided_at timestamptz,
  review_at date,
  actual_outcome text,
  reviewed_at timestamptz,
  principle_id uuid references principles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text not null default 'human',
  source text not null default 'manual',
  derived_from uuid,
  supersedes_id uuid,
  tier smallint not null default 1
);

create table journal_entries (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  entry_md text not null,
  mood smallint check (mood between 1 and 5),
  energy smallint check (energy between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text not null default 'human',
  source text not null default 'manual',
  derived_from uuid,
  supersedes_id uuid,
  tier smallint not null default 2
);

create table people (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null,
  relation text,
  context text,
  last_contact_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text not null default 'human',
  source text not null default 'manual',
  derived_from uuid,
  supersedes_id uuid,
  tier smallint not null default 1
);

create table person_aliases (
  person_id uuid not null references people(id),
  alias text not null,
  primary key (person_id, alias)
);

create table interactions (
  id uuid primary key default gen_random_uuid(),
  person_id uuid references people(id),
  kind text not null check (kind in ('meeting','call','message','email','note')),
  summary text not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text not null default 'human',
  source text not null default 'manual',
  derived_from uuid,
  supersedes_id uuid,
  tier smallint not null default 2
);

create table pages (
  id uuid primary key default gen_random_uuid(),
  path text not null unique,
  title text not null,
  body_md text not null,
  content_hash text not null,
  status text not null default 'active' check (status in ('active','deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text not null default 'human',
  source text not null default 'manual',
  derived_from uuid,
  supersedes_id uuid,
  tier smallint not null default 1
);

create table metric_defs (
  name text primary key,
  unit text,
  description text,
  agg_sql text  -- whitelisted SQL template; ONLY path to tier-0 data
);

create table metric_values (
  metric text not null references metric_defs(name),
  period_start date not null,
  granularity text not null check (granularity in ('day','week','month')),
  value numeric not null,
  source text not null,
  computed_at timestamptz not null default now(),
  primary key (metric, granularity, period_start)
);

-- updated_at triggers
do $$
declare t text;
begin
  foreach t in array array['values_items','goals','principles','tasks','commitments','decisions',
                           'journal_entries','people','interactions','pages']
  loop
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()',
                   t || '_updated_at', t);
  end loop;
end $$;
