-- Read-only mirrors of exported data (spec §7). transactions/health_samples are tier 0:
-- contents never readable by agents; aggregates only via metric_defs.agg_sql.

create table calendar_events (
  id uuid primary key default gen_random_uuid(),
  uid text not null unique,
  starts_at timestamptz not null,
  ends_at timestamptz,
  title text not null,
  location text,
  attendees jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text not null default 'human',
  source text not null default 'manual',
  derived_from uuid,
  supersedes_id uuid,
  tier smallint not null default 1
);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  occurred_at date not null,
  amount_cents bigint not null,
  currency char(3) not null,
  merchant text,
  category text,
  account_label text not null,
  external_ref text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text not null default 'human',
  source text not null default 'manual',
  derived_from uuid,
  supersedes_id uuid,
  tier smallint not null default 0,
  unique (account_label, external_ref)
);

create table health_samples (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                  -- 'sleep_minutes','steps','hr_resting',…
  at timestamptz not null,
  value numeric not null,
  unit text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text not null default 'human',
  source text not null default 'manual',
  derived_from uuid,
  supersedes_id uuid,
  tier smallint not null default 0,
  unique (kind, at, source)
);

create table email_meta (
  id uuid primary key default gen_random_uuid(),
  message_id text not null unique,
  at timestamptz not null,
  from_addr text not null,
  subject text,
  thread_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text not null default 'human',
  source text not null default 'manual',
  derived_from uuid,
  supersedes_id uuid,
  tier smallint not null default 2
);

create table inbox_items (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  raw_path text not null,
  mime text,
  status text not null default 'pending' check (status in ('pending','filed','rejected')),
  filed_table text,
  filed_id uuid,
  classifier_output jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text not null default 'human',
  source text not null default 'manual',
  derived_from uuid,
  supersedes_id uuid,
  tier smallint not null default 1
);

do $$
declare t text;
begin
  foreach t in array array['calendar_events','transactions','health_samples','email_meta','inbox_items']
  loop
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()',
                   t || '_updated_at', t);
  end loop;
end $$;
