-- Derived graph identities must be at least as private as the prose row that produced them.
-- Exact-name resolution runs behind narrow SECURITY DEFINER functions so the locked runtime
-- role can reuse/promote an existing tier-2 identity without gaining a general table read.

alter table person_aliases add column if not exists tier smallint;
alter table person_aliases add column if not exists source text;
alter table person_aliases add column if not exists created_by text;
alter table person_aliases add column if not exists derived_from uuid;

update person_aliases a
set tier = p.tier,
    source = p.source,
    created_by = p.created_by,
    derived_from = coalesce(a.derived_from, p.derived_from)
from people p
where p.id = a.person_id
  and (a.tier is null or a.source is null or a.created_by is null or a.derived_from is null);

alter table person_aliases alter column tier set default 1;
alter table person_aliases alter column tier set not null;
alter table person_aliases alter column source set default 'manual';
alter table person_aliases alter column source set not null;
alter table person_aliases alter column created_by set default 'human';
alter table person_aliases alter column created_by set not null;
alter table person_aliases drop constraint if exists person_aliases_tier_check;
alter table person_aliases add constraint person_aliases_tier_check check (tier in (0,1,2));
alter table person_aliases add column if not exists privacy_namespace smallint;
alter table person_aliases alter column privacy_namespace drop expression if exists;
update person_aliases set privacy_namespace = case when tier = 0 then 0 else 1 end
where privacy_namespace is null;
alter table person_aliases alter column privacy_namespace set default 1;
alter table person_aliases alter column privacy_namespace set not null;
alter table person_aliases drop constraint if exists person_aliases_privacy_namespace_check;
alter table person_aliases add constraint person_aliases_privacy_namespace_check
  check (privacy_namespace in (0,1));
alter table person_aliases drop constraint if exists person_aliases_pkey;
alter table person_aliases add constraint person_aliases_pkey
  primary key (person_id, alias, privacy_namespace);

alter table org_aliases add column if not exists tier smallint;
alter table org_aliases add column if not exists source text;
alter table org_aliases add column if not exists created_by text;
alter table org_aliases add column if not exists derived_from uuid;

update org_aliases a
set tier = o.tier,
    source = o.source,
    created_by = o.created_by,
    derived_from = coalesce(a.derived_from, o.derived_from)
from orgs o
where o.id = a.org_id
  and (a.tier is null or a.source is null or a.created_by is null or a.derived_from is null);

alter table org_aliases alter column tier set default 1;
alter table org_aliases alter column tier set not null;
alter table org_aliases alter column source set default 'manual';
alter table org_aliases alter column source set not null;
alter table org_aliases alter column created_by set default 'human';
alter table org_aliases alter column created_by set not null;
alter table org_aliases drop constraint if exists org_aliases_tier_check;
alter table org_aliases add constraint org_aliases_tier_check check (tier in (0,1,2));
alter table org_aliases add column if not exists privacy_namespace smallint;
alter table org_aliases alter column privacy_namespace drop expression if exists;
update org_aliases set privacy_namespace = case when tier = 0 then 0 else 1 end
where privacy_namespace is null;
alter table org_aliases alter column privacy_namespace set default 1;
alter table org_aliases alter column privacy_namespace set not null;
alter table org_aliases drop constraint if exists org_aliases_privacy_namespace_check;
alter table org_aliases add constraint org_aliases_privacy_namespace_check
  check (privacy_namespace in (0,1));
alter table org_aliases drop constraint if exists org_aliases_pkey;
alter table org_aliases add constraint org_aliases_pkey
  primary key (org_id, alias, privacy_namespace);

-- Tier-0 identities occupy a separate quarantine namespace. A readable capture with the same
-- spelling must create/reuse a readable identity without linking it to the quarantined row.
drop index if exists orgs_canonical_name_idx;
create unique index orgs_canonical_name_idx on orgs (lower(canonical_name))
  where tier in (1,2);

alter table edges add column if not exists source text not null default 'manual';
alter table edges add column if not exists created_by text not null default 'human';
alter table edges add column if not exists derived_from uuid;

update edges
set source = case
      when extracted_by = 'system:extract' then 'extract'
      when rel = 'learned_from' then 'review'
      else source
    end,
    created_by = coalesce(nullif(extracted_by, ''), created_by),
    derived_from = coalesce(derived_from, source_id);

create or replace function keep_entity_tier_monotonic()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if old.tier = 0 or new.tier = 0 then new.tier := 0;
    else new.tier := greatest(old.tier, new.tier);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists people_keep_tier_monotonic on people;
create trigger people_keep_tier_monotonic
  before update of tier on people for each row execute function keep_entity_tier_monotonic();
drop trigger if exists orgs_keep_tier_monotonic on orgs;
create trigger orgs_keep_tier_monotonic
  before update of tier on orgs for each row execute function keep_entity_tier_monotonic();

create or replace function cascade_entity_tier_to_aliases()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.tier = old.tier then return new; end if;
  if tg_table_name = 'people' then
    update person_aliases
      set tier = case when new.tier = 0 or tier = 0 then 0
                      else greatest(tier, new.tier) end,
          derived_from = coalesce(derived_from, new.derived_from, new.id)
      where person_id = new.id;
  elsif tg_table_name = 'orgs' then
    update org_aliases
      set tier = case when new.tier = 0 or tier = 0 then 0
                      else greatest(tier, new.tier) end,
          derived_from = coalesce(derived_from, new.derived_from, new.id)
      where org_id = new.id;
  else
    raise exception 'entity_alias_table_invalid';
  end if;
  return new;
end;
$$;

drop trigger if exists people_cascade_tier_to_aliases on people;
create trigger people_cascade_tier_to_aliases
  after update of tier on people for each row execute function cascade_entity_tier_to_aliases();
drop trigger if exists orgs_cascade_tier_to_aliases on orgs;
create trigger orgs_cascade_tier_to_aliases
  after update of tier on orgs for each row execute function cascade_entity_tier_to_aliases();

create or replace function set_entity_alias_tier()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare parent_tier smallint;
declare parent_source text;
declare parent_created_by text;
declare parent_derived_from uuid;
declare parent_id uuid;
begin
  if tg_table_name = 'person_aliases' then
    parent_id := new.person_id;
    select tier, source, created_by, derived_from
      into parent_tier, parent_source, parent_created_by, parent_derived_from
    from people where id = parent_id
    for update;
  elsif tg_table_name = 'org_aliases' then
    parent_id := new.org_id;
    select tier, source, created_by, derived_from
      into parent_tier, parent_source, parent_created_by, parent_derived_from
    from orgs where id = parent_id
    for update;
  else
    raise exception 'entity_alias_table_invalid';
  end if;
  if parent_tier is null then raise exception 'entity_alias_parent_missing'; end if;
  if parent_tier = 0 or new.tier = 0 or (tg_op = 'UPDATE' and old.tier = 0) then
    new.tier := 0;
  else
    new.tier := greatest(coalesce(new.tier, 1), parent_tier,
                         case when tg_op = 'UPDATE' then old.tier else 1 end);
  end if;
  -- Namespace records identity provenance, not the current tier. Keeping it stable on update
  -- lets a readable alias be quarantined without colliding with a pre-existing tier-0 twin;
  -- the after-trigger below then merges that pair into the original tier-0 row.
  if tg_op = 'INSERT' then
    new.privacy_namespace := case when new.tier = 0 then 0 else 1 end;
  else
    new.privacy_namespace := old.privacy_namespace;
  end if;
  new.source := coalesce(nullif(new.source, ''), parent_source, 'manual');
  new.created_by := coalesce(nullif(new.created_by, ''), parent_created_by, 'human');
  new.derived_from := coalesce(new.derived_from, parent_derived_from, parent_id);
  return new;
end;
$$;

drop trigger if exists person_aliases_set_tier on person_aliases;
create trigger person_aliases_set_tier before insert or update on person_aliases
  for each row execute function set_entity_alias_tier();
drop trigger if exists org_aliases_set_tier on org_aliases;
create trigger org_aliases_set_tier before insert or update on org_aliases
  for each row execute function set_entity_alias_tier();

create or replace function merge_quarantined_alias_namespace()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.tier <> 0 or new.privacy_namespace = 0 then return new; end if;
  if tg_table_name = 'person_aliases' then
    if exists (
      select 1 from person_aliases a
      where a.person_id = new.person_id and a.alias = new.alias
        and a.tier = 0 and a.privacy_namespace = 0
    ) then
      delete from person_aliases a
      where a.person_id = new.person_id and a.alias = new.alias
        and a.tier = 0 and a.privacy_namespace <> 0;
    else
      delete from person_aliases a
      where a.person_id = new.person_id and a.alias = new.alias
        and a.tier = 0 and a.privacy_namespace <> 0;
      insert into person_aliases
        (person_id, alias, tier, source, created_by, derived_from, privacy_namespace)
      values
        (new.person_id, new.alias, 0, new.source, new.created_by, new.derived_from, 0);
    end if;
  elsif tg_table_name = 'org_aliases' then
    if exists (
      select 1 from org_aliases a
      where a.org_id = new.org_id and a.alias = new.alias
        and a.tier = 0 and a.privacy_namespace = 0
    ) then
      delete from org_aliases a
      where a.org_id = new.org_id and a.alias = new.alias
        and a.tier = 0 and a.privacy_namespace <> 0;
    else
      delete from org_aliases a
      where a.org_id = new.org_id and a.alias = new.alias
        and a.tier = 0 and a.privacy_namespace <> 0;
      insert into org_aliases
        (org_id, alias, tier, source, created_by, derived_from, privacy_namespace)
      values
        (new.org_id, new.alias, 0, new.source, new.created_by, new.derived_from, 0);
    end if;
  else
    raise exception 'entity_alias_table_invalid';
  end if;
  return new;
end;
$$;

drop trigger if exists person_aliases_merge_quarantine on person_aliases;
create trigger person_aliases_merge_quarantine
  after insert or update of tier, derived_from on person_aliases
  for each row execute function merge_quarantined_alias_namespace();
drop trigger if exists org_aliases_merge_quarantine on org_aliases;
create trigger org_aliases_merge_quarantine
  after insert or update of tier, derived_from on org_aliases
  for each row execute function merge_quarantined_alias_namespace();

alter table person_aliases enable row level security;
drop policy if exists tier_read on person_aliases;
create policy tier_read on person_aliases for select
  to minime_app, minime_engineer_ro
  using (
    tier >= 1 and tier <= app_allowed_tier()
    and exists (
      select 1 from people p
      where p.id = person_aliases.person_id
        and p.tier >= 1 and p.tier <= app_allowed_tier()
    )
  );
drop policy if exists tier_write on person_aliases;
create policy tier_write on person_aliases for insert
  to minime_app
  with check (
    tier >= 1 and tier <= app_allowed_tier()
    and exists (
      select 1 from people p
      where p.id = person_aliases.person_id
        and p.tier >= 1 and p.tier <= app_allowed_tier()
    )
  );
drop policy if exists tier_update on person_aliases;
create policy tier_update on person_aliases for update
  to minime_app
  using (
    tier >= 1 and tier <= app_allowed_tier()
    and exists (
      select 1 from people p
      where p.id = person_aliases.person_id
        and p.tier >= 1 and p.tier <= app_allowed_tier()
    )
  )
  with check (
    tier >= 1 and tier <= app_allowed_tier()
    and exists (
      select 1 from people p
      where p.id = person_aliases.person_id
        and p.tier >= 1 and p.tier <= app_allowed_tier()
    )
  );

alter table org_aliases enable row level security;
drop policy if exists tier_read on org_aliases;
create policy tier_read on org_aliases for select
  to minime_app, minime_engineer_ro
  using (
    tier >= 1 and tier <= app_allowed_tier()
    and exists (
      select 1 from orgs o
      where o.id = org_aliases.org_id
        and o.tier >= 1 and o.tier <= app_allowed_tier()
    )
  );
drop policy if exists tier_write on org_aliases;
create policy tier_write on org_aliases for insert
  to minime_app
  with check (
    tier >= 1 and tier <= app_allowed_tier()
    and exists (
      select 1 from orgs o
      where o.id = org_aliases.org_id
        and o.tier >= 1 and o.tier <= app_allowed_tier()
    )
  );
drop policy if exists tier_update on org_aliases;
create policy tier_update on org_aliases for update
  to minime_app
  using (
    tier >= 1 and tier <= app_allowed_tier()
    and exists (
      select 1 from orgs o
      where o.id = org_aliases.org_id
        and o.tier >= 1 and o.tier <= app_allowed_tier()
    )
  )
  with check (
    tier >= 1 and tier <= app_allowed_tier()
    and exists (
      select 1 from orgs o
      where o.id = org_aliases.org_id
        and o.tier >= 1 and o.tier <= app_allowed_tier()
    )
  );

create or replace function resolve_or_promote_entity(
  entity_kind text,
  entity_name text,
  requested_tier smallint,
  requested_created_by text,
  requested_source text,
  requested_derived_from uuid
)
returns table (entity_id uuid, was_created boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare normalized_name text := lower(btrim(entity_name));
declare found_id uuid;
begin
  if entity_kind not in ('person', 'org') then raise exception 'entity_kind_invalid'; end if;
  if normalized_name = '' then raise exception 'entity_name_invalid'; end if;
  if requested_tier not in (1,2) then raise exception 'entity_tier_invalid'; end if;
  if coalesce(btrim(requested_created_by), '') = '' then raise exception 'entity_creator_invalid'; end if;
  if coalesce(btrim(requested_source), '') = '' then raise exception 'entity_source_invalid'; end if;

  perform pg_advisory_xact_lock(hashtextextended(entity_kind || ':' || normalized_name, 0));

  if entity_kind = 'person' then
    select candidate.id into found_id
    from (
      select p.id, 0 as rank from people p
      where p.tier in (1,2) and lower(btrim(p.canonical_name)) = normalized_name
      union
      select a.person_id, 1 as rank from person_aliases a
      join people p on p.id = a.person_id
      where p.tier in (1,2) and a.tier in (1,2)
        and lower(btrim(a.alias)) = normalized_name
    ) candidate
    order by candidate.rank, candidate.id
    limit 1;
    if found_id is null then
      found_id := gen_random_uuid();
      insert into people
        (id, canonical_name, tier, created_by, source, derived_from)
      values
        (found_id, btrim(entity_name), requested_tier, requested_created_by,
         requested_source, requested_derived_from);
      insert into person_aliases
        (person_id, alias, tier, created_by, source, derived_from)
      values
        (found_id, btrim(entity_name), requested_tier, requested_created_by,
         requested_source, requested_derived_from);
      return query select found_id, true;
      return;
    end if;
    update people
      set tier = case when tier = 0 then 0 else greatest(tier, requested_tier) end,
          derived_from = coalesce(derived_from, requested_derived_from)
      where id = found_id;
    update person_aliases
      set tier = case when tier = 0 then 0 else greatest(tier, requested_tier) end,
          derived_from = coalesce(derived_from, requested_derived_from)
      where person_id = found_id;
    if not exists (
      select 1 from person_aliases
      where person_id = found_id and tier in (1,2)
        and lower(btrim(alias)) = normalized_name
    ) then
      insert into person_aliases
        (person_id, alias, tier, created_by, source, derived_from)
      values
        (found_id, btrim(entity_name), requested_tier, requested_created_by,
         requested_source, requested_derived_from);
    end if;
  else
    select candidate.id into found_id
    from (
      select o.id, 0 as rank from orgs o
      where o.tier in (1,2)
        and lower(btrim(o.canonical_name)) = normalized_name and o.retired_at is null
      union
      select a.org_id, 1 as rank from org_aliases a
      join orgs o on o.id = a.org_id
      where o.tier in (1,2) and a.tier in (1,2)
        and lower(btrim(a.alias)) = normalized_name and o.retired_at is null
    ) candidate
    order by candidate.rank, candidate.id
    limit 1;
    if found_id is null then
      found_id := gen_random_uuid();
      insert into orgs
        (id, canonical_name, tier, created_by, source, derived_from)
      values
        (found_id, btrim(entity_name), requested_tier, requested_created_by,
         requested_source, requested_derived_from);
      insert into org_aliases
        (org_id, alias, tier, created_by, source, derived_from)
      values
        (found_id, btrim(entity_name), requested_tier, requested_created_by,
         requested_source, requested_derived_from);
      return query select found_id, true;
      return;
    end if;
    update orgs
      set tier = case when tier = 0 then 0 else greatest(tier, requested_tier) end,
          derived_from = coalesce(derived_from, requested_derived_from)
      where id = found_id;
    update org_aliases
      set tier = case when tier = 0 then 0 else greatest(tier, requested_tier) end,
          derived_from = coalesce(derived_from, requested_derived_from)
      where org_id = found_id;
    if not exists (
      select 1 from org_aliases
      where org_id = found_id and tier in (1,2)
        and lower(btrim(alias)) = normalized_name
    ) then
      insert into org_aliases
        (org_id, alias, tier, created_by, source, derived_from)
      values
        (found_id, btrim(entity_name), requested_tier, requested_created_by,
         requested_source, requested_derived_from);
    end if;
  end if;
  return query select found_id, false;
end;
$$;

create or replace function upsert_derived_alias(
  entity_kind text,
  target_id uuid,
  entity_alias text,
  requested_tier smallint,
  requested_created_by text,
  requested_source text,
  requested_derived_from uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare normalized_alias text := lower(btrim(entity_alias));
declare conflicting_id uuid;
declare effective_tier smallint;
begin
  if entity_kind not in ('person', 'org') then raise exception 'entity_kind_invalid'; end if;
  if normalized_alias = '' then raise exception 'entity_alias_invalid'; end if;
  if requested_tier not in (1,2) then raise exception 'entity_tier_invalid'; end if;
  perform pg_advisory_xact_lock(hashtextextended(entity_kind || ':' || normalized_alias, 0));

  if entity_kind = 'person' then
    select tier into effective_tier from people where id = target_id;
    if effective_tier is null or effective_tier = 0 then
      raise exception 'entity_alias_parent_missing';
    end if;
    select a.person_id into conflicting_id
    from person_aliases a
    join people p on p.id = a.person_id
    where p.tier in (1,2) and a.tier in (1,2)
      and lower(btrim(a.alias)) = normalized_alias and a.person_id <> target_id
    order by a.person_id limit 1;
    if conflicting_id is not null then raise exception 'entity_alias_conflict'; end if;
    update people
      set tier = case when tier = 0 then 0 else greatest(tier, requested_tier) end,
          derived_from = coalesce(derived_from, requested_derived_from)
      where id = target_id;
    effective_tier := case when effective_tier = 0 then 0
                           else greatest(effective_tier, requested_tier) end;
    update person_aliases
      set tier = case when tier = 0 or effective_tier = 0 then 0
                      else greatest(tier, effective_tier) end,
          derived_from = coalesce(derived_from, requested_derived_from)
      where person_id = target_id;
    if not exists (
      select 1 from person_aliases
      where person_id = target_id and tier in (1,2)
        and lower(btrim(alias)) = normalized_alias
    ) then
      insert into person_aliases
        (person_id, alias, tier, created_by, source, derived_from)
      values
        (target_id, btrim(entity_alias), effective_tier, requested_created_by,
         requested_source, requested_derived_from);
    end if;
  else
    select tier into effective_tier from orgs where id = target_id and retired_at is null;
    if effective_tier is null or effective_tier = 0 then
      raise exception 'entity_alias_parent_missing';
    end if;
    select a.org_id into conflicting_id
    from org_aliases a
    join orgs o on o.id = a.org_id
    where o.tier in (1,2) and a.tier in (1,2) and o.retired_at is null
      and lower(btrim(a.alias)) = normalized_alias and a.org_id <> target_id
    order by a.org_id limit 1;
    if conflicting_id is not null then raise exception 'entity_alias_conflict'; end if;
    update orgs
      set tier = case when tier = 0 then 0 else greatest(tier, requested_tier) end,
          derived_from = coalesce(derived_from, requested_derived_from)
      where id = target_id;
    effective_tier := case when effective_tier = 0 then 0
                           else greatest(effective_tier, requested_tier) end;
    update org_aliases
      set tier = case when tier = 0 or effective_tier = 0 then 0
                      else greatest(tier, effective_tier) end,
          derived_from = coalesce(derived_from, requested_derived_from)
      where org_id = target_id;
    if not exists (
      select 1 from org_aliases
      where org_id = target_id and tier in (1,2)
        and lower(btrim(alias)) = normalized_alias
    ) then
      insert into org_aliases
        (org_id, alias, tier, created_by, source, derived_from)
      values
        (target_id, btrim(entity_alias), effective_tier, requested_created_by,
         requested_source, requested_derived_from);
    end if;
  end if;
end;
$$;

-- Extractor-only name reconciliation keeps short/full person names and legal-suffix org
-- variants atomic even after a tier-2 promotion hides the row from ordinary app-role reads.
create or replace function resolve_or_promote_extracted_person(
  entity_name text,
  requested_tier smallint,
  requested_created_by text,
  requested_source text,
  requested_derived_from uuid
)
returns table (entity_id uuid, was_created boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare normalized_name text := lower(btrim(entity_name));
declare first_name text := split_part(normalized_name, ' ', 1);
declare token_count integer;
declare found_id uuid;
declare found_count integer;
declare found_canonical text;
begin
  if normalized_name = '' then raise exception 'entity_name_invalid'; end if;
  if requested_tier not in (1,2) then raise exception 'entity_tier_invalid'; end if;
  if coalesce(btrim(requested_created_by), '') = '' then raise exception 'entity_creator_invalid'; end if;
  if coalesce(btrim(requested_source), '') = '' then raise exception 'entity_source_invalid'; end if;
  token_count := cardinality(regexp_split_to_array(normalized_name, '\s+'));

  perform pg_advisory_xact_lock(hashtextextended('person-first:' || first_name, 0));
  perform pg_advisory_xact_lock(hashtextextended('person:' || normalized_name, 0));

  select candidate.id into found_id
  from (
    select p.id, 0 as rank from people p
    where p.tier in (1,2) and lower(btrim(p.canonical_name)) = normalized_name
    union
    select a.person_id, 1 as rank from person_aliases a
    join people p on p.id = a.person_id
    where p.tier in (1,2) and a.tier in (1,2)
      and lower(btrim(a.alias)) = normalized_name
  ) candidate
  order by candidate.rank, candidate.id
  limit 1;
  if found_id is not null then
    return query
      select r.entity_id, r.was_created
      from resolve_or_promote_entity(
        'person', entity_name, requested_tier, requested_created_by,
        requested_source, requested_derived_from
      ) r;
    return;
  end if;

  if token_count = 1 then
    select count(*)::int into found_count
    from people p
    where p.tier in (1,2)
      and lower(split_part(btrim(p.canonical_name), ' ', 1)) = first_name;
    if found_count = 1 then
      select p.id, p.canonical_name into found_id, found_canonical
      from people p
      where p.tier in (1,2)
        and lower(split_part(btrim(p.canonical_name), ' ', 1)) = first_name;
    end if;
  else
    select count(*)::int into found_count
    from people p
    where p.tier in (1,2) and lower(btrim(p.canonical_name)) = first_name;
    if found_count = 1 then
      select p.id, p.canonical_name into found_id, found_canonical
      from people p
      where p.tier in (1,2) and lower(btrim(p.canonical_name)) = first_name;
    end if;
  end if;

  if found_id is null then
    return query
      select r.entity_id, r.was_created
      from resolve_or_promote_entity(
        'person', entity_name, requested_tier, requested_created_by,
        requested_source, requested_derived_from
      ) r;
    return;
  end if;

  update people
  set canonical_name = case when token_count > 1 then btrim(entity_name) else canonical_name end,
      tier = greatest(tier, requested_tier),
      derived_from = coalesce(derived_from, requested_derived_from)
  where id = found_id;
  update person_aliases
  set tier = case when tier = 0 then 0 else greatest(tier, requested_tier) end,
      derived_from = coalesce(derived_from, requested_derived_from)
  where person_id = found_id;
  if found_canonical is not null then
    insert into person_aliases
      (person_id, alias, tier, created_by, source, derived_from)
    values
      (found_id, found_canonical, requested_tier, requested_created_by,
       requested_source, requested_derived_from)
    on conflict do nothing;
  end if;
  insert into person_aliases
    (person_id, alias, tier, created_by, source, derived_from)
  values
    (found_id, btrim(entity_name), requested_tier, requested_created_by,
     requested_source, requested_derived_from)
  on conflict do nothing;
  return query select found_id, false;
end;
$$;

create or replace function resolve_or_promote_extracted_org(
  entity_name text,
  entity_base text,
  requested_tier smallint,
  requested_created_by text,
  requested_source text,
  requested_derived_from uuid
)
returns table (entity_id uuid, was_created boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare normalized_name text := lower(btrim(entity_name));
declare normalized_base text := lower(btrim(entity_base));
declare found_id uuid;
declare created_flag boolean := false;
begin
  if normalized_name = '' or normalized_base = '' then raise exception 'entity_name_invalid'; end if;
  if requested_tier not in (1,2) then raise exception 'entity_tier_invalid'; end if;
  if coalesce(btrim(requested_created_by), '') = '' then raise exception 'entity_creator_invalid'; end if;
  if coalesce(btrim(requested_source), '') = '' then raise exception 'entity_source_invalid'; end if;

  perform pg_advisory_xact_lock(hashtextextended('org-base:' || normalized_base, 0));
  perform pg_advisory_xact_lock(hashtextextended('org:' || normalized_name, 0));

  select candidate.id into found_id
  from (
    select o.id, 0 as rank from orgs o
    where o.tier in (1,2) and o.retired_at is null
      and lower(btrim(o.canonical_name)) = normalized_name
    union
    select a.org_id, 1 as rank from org_aliases a
    join orgs o on o.id = a.org_id
    where o.tier in (1,2) and a.tier in (1,2) and o.retired_at is null
      and lower(btrim(a.alias)) = normalized_name
  ) candidate
  order by candidate.rank, candidate.id
  limit 1;
  if found_id is null and normalized_base <> normalized_name then
    select candidate.id into found_id
    from (
      select o.id, 0 as rank from orgs o
      where o.tier in (1,2) and o.retired_at is null
        and lower(btrim(o.canonical_name)) = normalized_base
      union
      select a.org_id, 1 as rank from org_aliases a
      join orgs o on o.id = a.org_id
      where o.tier in (1,2) and a.tier in (1,2) and o.retired_at is null
        and lower(btrim(a.alias)) = normalized_base
    ) candidate
    order by candidate.rank, candidate.id
    limit 1;
  end if;

  if found_id is null then
    select r.entity_id, r.was_created into found_id, created_flag
    from resolve_or_promote_entity(
      'org', entity_name, requested_tier, requested_created_by,
      requested_source, requested_derived_from
    ) r;
  else
    update orgs
    set canonical_name = case when normalized_base <> normalized_name
                              then btrim(entity_name) else canonical_name end,
        tier = greatest(tier, requested_tier),
        derived_from = coalesce(derived_from, requested_derived_from)
    where id = found_id;
    update org_aliases
    set tier = case when tier = 0 then 0 else greatest(tier, requested_tier) end,
        derived_from = coalesce(derived_from, requested_derived_from)
    where org_id = found_id;
  end if;

  if exists (
    select 1 from org_aliases a
    join orgs o on o.id = a.org_id
    where o.tier in (1,2) and a.tier in (1,2)
      and o.retired_at is null and a.org_id <> found_id
      and lower(btrim(a.alias)) in (normalized_name, normalized_base)
  ) then
    raise exception 'entity_alias_conflict';
  end if;
  insert into org_aliases
    (org_id, alias, tier, created_by, source, derived_from)
  select found_id, desired.alias, requested_tier, requested_created_by,
         requested_source, requested_derived_from
  from (
    select distinct unnest(array[btrim(entity_name), btrim(entity_base)]) as alias
  ) desired
  on conflict do nothing;
  return query select found_id, created_flag;
end;
$$;

-- Unknown provenance is represented as NULL. The edge trigger below fails closed only for
-- runtime system:extract writes; trusted owner fixtures may still construct legacy-invalid
-- rows for validator tests.
create or replace function edge_source_tier(table_name text, row_id uuid)
returns smallint
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare out_tier smallint;
begin
  if table_name is null or row_id is null then return null; end if;
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
  return out_tier;
end;
$$;

-- Runtime extraction needs to validate a source that may already be hidden by tier-2 RLS.
-- Tier 0 and a missing/invalid source intentionally collapse to the same NULL result.
create or replace function readable_source_tier(table_name text, row_id uuid)
returns smallint
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare source_tier smallint;
begin
  source_tier := edge_source_tier(table_name, row_id);
  if source_tier in (1,2) then return source_tier; end if;
  return null;
end;
$$;

-- Migration 014's branch-sync trigger called the raw resolver as the app role. Keep the
-- trigger on the non-oracular readable helper before revoking raw resolver access below.
create or replace function sync_decision_branch_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  update edges
  set rel = case new.status
    when 'chosen' then 'chose'
    when 'rejected' then 'rejected'
    else 'considered'
  end,
  source_table = 'decision_branches',
  source_id = new.id,
  tier = readable_source_tier('decision_branches', new.id)
  where src_type = 'decision'
    and src_id = new.decision_id
    and dst_type = 'decision_branch'
    and dst_id = new.id;
  update decisions set updated_at = now() where id = new.decision_id;
  return new;
end;
$$;

-- Recover semantic provenance for historical non-extractor edges from their referenced row.
with source_rows(table_name, id, source) as (
  select 'values_items', id, source from values_items union all
  select 'goals', id, source from goals union all
  select 'principles', id, source from principles union all
  select 'tasks', id, source from tasks union all
  select 'commitments', id, source from commitments union all
  select 'decisions', id, source from decisions union all
  select 'decision_branches', id, source from decision_branches union all
  select 'journal_entries', id, source from journal_entries union all
  select 'people', id, source from people union all
  select 'orgs', id, source from orgs union all
  select 'interactions', id, source from interactions union all
  select 'pages', id, source from pages union all
  select 'calendar_events', id, source from calendar_events union all
  select 'email_meta', id, source from email_meta union all
  select 'inbox_items', id, source from inbox_items
)
update edges e
set source = coalesce(nullif(s.source, ''), e.source)
from source_rows s
where e.source_table = s.table_name and e.source_id = s.id
  and e.extracted_by <> 'system:extract' and e.rel <> 'learned_from';

-- Repair existing derivations before installing the new write triggers. Pre-022 identities
-- defaulted to tier 1 even when their source edge came from tier-2 prose, and the nightly
-- backlog intentionally skips sources which already have extracted edges.
with edge_evidence as (
  select id, edge_source_tier(source_table, source_id) as source_tier
  from edges
)
update edges e
set tier = case
      when e.tier = 0 or evidence.source_tier = 0 then 0
      when evidence.source_tier in (1,2) then greatest(e.tier, evidence.source_tier)
      else e.tier
    end,
    derived_from = case when evidence.source_tier = 0 then e.source_id
                        else coalesce(e.derived_from, e.source_id) end
from edge_evidence evidence
where evidence.id = e.id;

with evidence as (
  select e.src_id as entity_id, e.source_id, e.created_at, e.id,
         edge_source_tier(e.source_table, e.source_id) as source_tier
  from edges e where e.src_type = 'person'
  union all
  select e.dst_id, e.source_id, e.created_at, e.id,
         edge_source_tier(e.source_table, e.source_id)
  from edges e where e.dst_type = 'person'
), strongest as (
  select distinct on (entity_id) entity_id, source_id, source_tier
  from evidence
  where source_id is not null and source_tier in (0,1,2)
  order by entity_id,
           case source_tier when 0 then 3 else source_tier end desc,
           created_at, id
)
update people p
set tier = case when p.tier = 0 or strongest.source_tier = 0 then 0
                else greatest(p.tier, strongest.source_tier) end,
    derived_from = case when p.tier <> 0 and strongest.source_tier = 0
                        then strongest.source_id
                        else coalesce(p.derived_from, strongest.source_id) end
from strongest
where p.id = strongest.entity_id;

with evidence as (
  select e.src_id as entity_id, e.source_id, e.created_at, e.id,
         edge_source_tier(e.source_table, e.source_id) as source_tier
  from edges e where e.src_type = 'org'
  union all
  select e.dst_id, e.source_id, e.created_at, e.id,
         edge_source_tier(e.source_table, e.source_id)
  from edges e where e.dst_type = 'org'
), strongest as (
  select distinct on (entity_id) entity_id, source_id, source_tier
  from evidence
  where source_id is not null and source_tier in (0,1,2)
  order by entity_id,
           case source_tier when 0 then 3 else source_tier end desc,
           created_at, id
)
update orgs o
set tier = case when o.tier = 0 or strongest.source_tier = 0 then 0
                else greatest(o.tier, strongest.source_tier) end,
    derived_from = case when o.tier <> 0 and strongest.source_tier = 0
                        then strongest.source_id
                        else coalesce(o.derived_from, strongest.source_id) end
from strongest
where o.id = strongest.entity_id;

update person_aliases a
set tier = case when p.tier = 0 or a.tier = 0 then 0 else greatest(a.tier, p.tier) end,
    derived_from = case when p.tier = 0 then coalesce(p.derived_from, a.derived_from, p.id)
                        else coalesce(a.derived_from, p.derived_from, p.id) end
from people p
where p.id = a.person_id;

update org_aliases a
set tier = case when o.tier = 0 or a.tier = 0 then 0 else greatest(a.tier, o.tier) end,
    derived_from = case when o.tier = 0 then coalesce(o.derived_from, a.derived_from, o.id)
                        else coalesce(a.derived_from, o.derived_from, o.id) end
from orgs o
where o.id = a.org_id;

-- The restricted extractor needs one structural yes/no guard after a person is promoted out
-- of its readable tier. It never returns the relation or any other hidden row content.
create or replace function person_has_nonworking_relation(target_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select coalesce((
    select lower(btrim(p.relation)) = any(array[
      'son','daughter','child','grandson','granddaughter',
      'domestic_helper','nanny','babysitter'
    ]::text[])
    from people p where p.id = target_id and p.tier in (1,2)
  ), false)
$$;

-- These helpers perform only the structural operations needed after an app-role write has
-- promoted a person/org to tier 2 and ordinary RLS can no longer see that row. They never
-- expose hidden row content, and tier-0 identities remain completely out of scope.
create or replace function touch_person_last_contact(target_id uuid, contacted_at timestamptz)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if target_id is null or contacted_at is null then
    raise exception 'person_contact_input_invalid';
  end if;
  update people
  set last_contact_at = greatest(coalesce(last_contact_at, contacted_at), contacted_at)
  where id = target_id and tier in (1,2);
end;
$$;

create or replace function set_person_relation_if_null(target_id uuid, requested_relation text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if target_id is null or coalesce(btrim(requested_relation), '') = '' then
    raise exception 'person_relation_input_invalid';
  end if;
  update people
  set relation = btrim(requested_relation)
  where id = target_id and tier in (1,2) and relation is null;
end;
$$;

create or replace function exact_active_org_exists(entity_name text)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select case
    when coalesce(btrim(entity_name), '') = '' then false
    else exists (
      select 1
      from orgs o
      where o.tier in (1,2)
        and o.retired_at is null
        and (
          lower(btrim(o.canonical_name)) = lower(btrim(entity_name))
          or exists (
            select 1 from org_aliases a
            where a.org_id = o.id
              and a.tier in (1,2)
              and lower(btrim(a.alias)) = lower(btrim(entity_name))
          )
        )
    )
  end
$$;

create or replace function set_edge_tier()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare source_tier smallint;
begin
  source_tier := edge_source_tier(new.source_table, new.source_id);
  if new.extracted_by = 'system:extract' and source_tier is null
     and (session_user = 'minime_app' or session_user like 'minime_test_app_%') then
    raise exception 'extracted_edge_source_invalid';
  end if;
  -- Tier 0 is the absorbing, least-readable quarantine. Within readable prose tiers,
  -- promotion is monotonic (1 -> 2); no update may lift an existing/source tier 0 edge.
  if source_tier = 0 or new.tier = 0 or (tg_op = 'UPDATE' and old.tier = 0) then
    new.tier := 0;
  else
    new.tier := greatest(coalesce(source_tier, 1),
                         coalesce(new.tier, 1),
                         case when tg_op = 'UPDATE' then old.tier else 1 end);
  end if;
  new.derived_from := coalesce(new.derived_from, new.source_id,
                               case when tg_op = 'UPDATE' then old.derived_from else null end);
  if new.extracted_by = 'system:extract' then
    new.source := 'extract';
    new.created_by := 'system:extract';
  end if;
  return new;
end;
$$;

drop trigger if exists edges_set_tier on edges;
create trigger edges_set_tier
  before insert or update of source_table, source_id, tier, derived_from on edges
  for each row execute function set_edge_tier();

create or replace function upsert_extracted_edge(
  edge_src_type text,
  edge_src_id uuid,
  edge_rel text,
  edge_dst_type text,
  edge_dst_id uuid,
  edge_source_table text,
  edge_source_id uuid,
  edge_confidence real
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare source_tier smallint;
declare found_edge edges%rowtype;
declare merged_confidence real;
begin
  source_tier := edge_source_tier(edge_source_table, edge_source_id);
  if source_tier is null or source_tier not in (1,2) then
    raise exception 'extracted_edge_source_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    edge_src_type || ':' || edge_src_id::text || ':' || edge_rel || ':' ||
    edge_dst_type || ':' || edge_dst_id::text, 0));
  select * into found_edge from edges
  where src_type = edge_src_type and src_id = edge_src_id and rel = edge_rel
    and dst_type = edge_dst_type and dst_id = edge_dst_id
    and extracted_by = 'system:extract'
  order by case tier when 0 then 3 else tier end desc, created_at, id
  limit 1 for update;
  if found_edge.id is null then
    insert into edges
      (src_type, src_id, rel, dst_type, dst_id, source_table, source_id,
       extracted_by, confidence, tier, source, created_by, derived_from)
    values
      (edge_src_type, edge_src_id, edge_rel, edge_dst_type, edge_dst_id,
       edge_source_table, edge_source_id, 'system:extract', edge_confidence,
       source_tier, 'extract', 'system:extract', edge_source_id);
    return true;
  end if;
  select greatest(edge_confidence, coalesce(max(confidence), edge_confidence))
    into merged_confidence
  from edges
  where src_type = edge_src_type and src_id = edge_src_id and rel = edge_rel
    and dst_type = edge_dst_type and dst_id = edge_dst_id
    and extracted_by = 'system:extract';
  update edges
  set tier = case when tier = 0 or source_tier = 0 then 0
                  else greatest(tier, source_tier) end,
      confidence = merged_confidence,
      source_table = case
        when (case source_tier when 0 then 3 else source_tier end) >
             (case tier when 0 then 3 else tier end)
        then edge_source_table else source_table end,
      source_id = case
        when (case source_tier when 0 then 3 else source_tier end) >
             (case tier when 0 then 3 else tier end)
        then edge_source_id else source_id end,
      derived_from = case
        when (case source_tier when 0 then 3 else source_tier end) >
             (case tier when 0 then 3 else tier end)
        then edge_source_id
                          else coalesce(derived_from, edge_source_id) end,
      source = 'extract',
      created_by = 'system:extract'
  where id = found_edge.id;
  delete from edges
  where src_type = edge_src_type and src_id = edge_src_id and rel = edge_rel
    and dst_type = edge_dst_type and dst_id = edge_dst_id
    and extracted_by = 'system:extract' and id <> found_edge.id;
  return false;
end;
$$;

revoke execute on function keep_entity_tier_monotonic() from public;
revoke execute on function cascade_entity_tier_to_aliases() from public;
revoke execute on function set_entity_alias_tier() from public;
revoke execute on function merge_quarantined_alias_namespace() from public;
revoke execute on function set_edge_tier() from public;
revoke execute on function edge_source_tier(text,uuid) from public;
revoke execute on function edge_source_tier(text,uuid) from minime_app;
revoke execute on function edge_source_tier(text,uuid) from minime_engineer_ro;
revoke execute on function readable_source_tier(text,uuid) from public;
revoke execute on function person_has_nonworking_relation(uuid) from public;
revoke execute on function touch_person_last_contact(uuid,timestamptz) from public;
revoke execute on function set_person_relation_if_null(uuid,text) from public;
revoke execute on function exact_active_org_exists(text) from public;
revoke execute on function resolve_or_promote_entity(text,text,smallint,text,text,uuid) from public;
revoke execute on function resolve_or_promote_extracted_person(text,smallint,text,text,uuid) from public;
revoke execute on function resolve_or_promote_extracted_org(text,text,smallint,text,text,uuid) from public;
revoke execute on function upsert_derived_alias(text,uuid,text,smallint,text,text,uuid) from public;
revoke execute on function upsert_extracted_edge(text,uuid,text,text,uuid,text,uuid,real) from public;

grant execute on function person_has_nonworking_relation(uuid) to minime_app;
grant execute on function readable_source_tier(text,uuid) to minime_app;
grant execute on function touch_person_last_contact(uuid,timestamptz) to minime_app;
grant execute on function set_person_relation_if_null(uuid,text) to minime_app;
grant execute on function exact_active_org_exists(text) to minime_app;
grant execute on function resolve_or_promote_entity(text,text,smallint,text,text,uuid) to minime_app;
grant execute on function resolve_or_promote_extracted_person(text,smallint,text,text,uuid) to minime_app;
grant execute on function resolve_or_promote_extracted_org(text,text,smallint,text,text,uuid) to minime_app;
grant execute on function upsert_derived_alias(text,uuid,text,smallint,text,text,uuid) to minime_app;
grant execute on function upsert_extracted_edge(text,uuid,text,text,uuid,text,uuid,real) to minime_app;
