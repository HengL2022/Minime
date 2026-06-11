-- Organizations as first-class graph nodes (DECISIONS.md 2026-06-11): the typed-edge
-- extraction layer needs a dst for works_at edges. Mirrors people/person_aliases.

create table orgs ( id uuid primary key default gen_random_uuid(),
  canonical_name text not null,
  kind text,                      -- optional free text: 'company', 'clinic', 'school', …
  context text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text not null default 'human',
  source text not null default 'manual',
  derived_from uuid,
  supersedes_id uuid,
  tier smallint not null default 1 );
create unique index orgs_canonical_name_idx on orgs (lower(canonical_name));

create table org_aliases ( org_id uuid not null references orgs(id),
  alias text not null, primary key (org_id, alias) );

create trigger orgs_updated_at before update on orgs
  for each row execute function set_updated_at();

-- M6 parity (007_rls.sql): same grants + tier policies as people/person_aliases.
grant select, insert, update on orgs, org_aliases to minime_app;
alter table orgs enable row level security;
create policy tier_read on orgs for select to minime_app using (tier <= app_allowed_tier());
create policy tier_write on orgs for insert to minime_app with check (true);
create policy tier_update on orgs for update to minime_app using (tier <= app_allowed_tier());
