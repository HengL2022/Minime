-- W4-1 (owner-ratified 2026-08-07, program's highest-risk change): identity/content tier split.
-- Since 022, resolving an EXISTING person/org/alias through resolve_or_promote_entity,
-- resolve_or_promote_extracted_person/org, or upsert_derived_alias silently promoted that row's
-- tier to greatest(current, requested) -- so a single tier-2 journal mention of a tier-1 friend
-- swallowed their whole identity card (canonical name, relation, last_contact_at) into tier 2
-- forever, and minime_log_interaction (interactions.ts) minted every new interaction subject
-- straight at tier 2. Ratified split: a person/org row's own IDENTITY (canonical_name, relation,
-- last_contact_at) lives at that row's OWN tier and is never raised merely because the entity is
-- mentioned in tier-2 content -- this discloses at tier 1 that contact happened and roughly when,
-- but never what. Content genuinely DERIVED from tier-2 prose (a brand-new alias spelling, a
-- graph edge) still mints at tier 2, same as before. minime_log_interaction's subject identity is
-- now minted at tier 1 (an owner-initiated contact is identity-tier, not content); the interaction
-- row itself, its indexed chunks, and its promise/commitment stay tier 2, unchanged.
--
-- Every function below is copied from its 022 (upsert_derived_alias: 029) body with ONLY the
-- tier-promotion arms edited -- no restructuring. Tier-0 is an absorbing quarantine namespace and
-- is untouched everywhere: "when tier = 0 then 0" stays verbatim in every CASE. No existing row is
-- rewritten by this migration -- rows already promoted under the old rule stay exactly as they
-- are; a review/backfill pass over that history is W4-2, deliberately out of scope here.

-- ---------------------------------------------------------------------------------------------
-- 1. Replace the monotonic-only trigger with a guarded one. Raises (tier N -> higher) are always
-- allowed, same as before. A demotion (tier N -> lower, N and the target both nonzero) is allowed
-- ONLY inside a transaction that has explicitly set minime.allow_tier_demotion = '1' AND is not
-- running as the app role -- the sanctioned owner-CLI review/backfill path W4-2 adds, never
-- reachable from minime_app's own SQL surface (none of the functions below touch the tier column
-- on an existing row at all anymore, so this is a backstop against a future bug or a raw/bypassing
-- write, not a path anything here currently takes). A tier-0 transition (into OR out of
-- quarantine, in either direction) still absorbs unconditionally for the owner connection -- the
-- existing, un-gated quarantine mechanism every quarantine/namespace test already depends on -- but
-- is flatly refused (exception, not a silent no-op) if attempted as the app role, closing the same
-- non-owner gap on the tier-0 boundary that the demotion gate closes on the 1<->2 boundary.
create or replace function keep_entity_tier_guarded()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare is_app_role boolean;
begin
  if tg_op = 'UPDATE' then
    is_app_role := current_user = 'minime_app' or current_user like 'minime_test_app_%';
    if old.tier = 0 or new.tier = 0 then
      if is_app_role then
        raise exception 'entity_tier_zero_transition_forbidden';
      end if;
      new.tier := 0;
    elsif new.tier < old.tier then
      if is_app_role or current_setting('minime.allow_tier_demotion', true) is distinct from '1' then
        raise exception 'entity_tier_demotion_forbidden';
      end if;
      -- allowed: the sanctioned owner-CLI demotion path (W4-2); new.tier stays as requested.
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists people_keep_tier_monotonic on people;
drop trigger if exists orgs_keep_tier_monotonic on orgs;
drop function if exists keep_entity_tier_monotonic();

create trigger people_keep_tier_guarded
  before update of tier on people for each row execute function keep_entity_tier_guarded();
create trigger orgs_keep_tier_guarded
  before update of tier on orgs for each row execute function keep_entity_tier_guarded();

-- cascade_entity_tier_to_aliases (022) is unchanged: it only fires when people.tier/orgs.tier
-- actually changes via an UPDATE that names the tier column, which the resolution functions below
-- no longer do for an existing row -- so in practice it now fires only for the tier-0 absorb path
-- (still exercised directly above) and any future deliberate raise issued outside this file. Its
-- own greatest()-based cascade to aliases is the correct behavior for both of those, so it is not
-- touched here.

-- ---------------------------------------------------------------------------------------------
-- 2. resolve_or_promote_entity: resolving an EXISTING person/org row (found_id branch) no longer
-- raises that row's tier or bulk-bumps its existing aliases -- only derived_from is backfilled
-- when absent. A brand-new alias spelling not already on file is still inserted at the tier this
-- specific call was made with (requested_tier), same as before: a new derivation still carries its
-- own tier, it just no longer also promotes anything it merely resolved.
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
      set derived_from = coalesce(derived_from, requested_derived_from)
      where id = found_id;
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
      set derived_from = coalesce(derived_from, requested_derived_from)
      where id = found_id;
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

-- ---------------------------------------------------------------------------------------------
-- 3. upsert_derived_alias (base: 029, which added the caller-tier-scoped conflict check -- kept
-- verbatim below). Same edit as resolve_or_promote_entity: resolving the existing parent no longer
-- raises its tier or bulk-bumps its other aliases; a genuinely new alias spelling is inserted at
-- requested_tier directly (effective_tier is no longer reassigned, only used for the
-- parent-missing/tier-0 guard read at the top).
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
declare caller_tier smallint := app_allowed_tier();
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
      and p.tier <= caller_tier and a.tier <= caller_tier
      and lower(btrim(a.alias)) = normalized_alias and a.person_id <> target_id
    order by a.person_id limit 1;
    if conflicting_id is not null then raise exception 'entity_alias_conflict'; end if;
    update people
      set derived_from = coalesce(derived_from, requested_derived_from)
      where id = target_id;
    if not exists (
      select 1 from person_aliases
      where person_id = target_id and tier in (1,2)
        and lower(btrim(alias)) = normalized_alias
    ) then
      insert into person_aliases
        (person_id, alias, tier, created_by, source, derived_from)
      values
        (target_id, btrim(entity_alias), requested_tier, requested_created_by,
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
      and o.tier <= caller_tier and a.tier <= caller_tier
      and lower(btrim(a.alias)) = normalized_alias and a.org_id <> target_id
    order by a.org_id limit 1;
    if conflicting_id is not null then raise exception 'entity_alias_conflict'; end if;
    update orgs
      set derived_from = coalesce(derived_from, requested_derived_from)
      where id = target_id;
    if not exists (
      select 1 from org_aliases
      where org_id = target_id and tier in (1,2)
        and lower(btrim(alias)) = normalized_alias
    ) then
      insert into org_aliases
        (org_id, alias, tier, created_by, source, derived_from)
      values
        (target_id, btrim(entity_alias), requested_tier, requested_created_by,
         requested_source, requested_derived_from);
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. resolve_or_promote_extracted_person: the exact-match branch already delegates entirely to
-- resolve_or_promote_entity above (no direct tier touch here regardless). The fuzzy short/full
-- name reconciliation branch keeps upgrading canonical_name exactly as before -- canonical_name is
-- one of the three identity fields this split deliberately keeps at the row's own tier even when
-- the fuller form was only ever seen in tier-2 prose (ratified trade-off: discloses that a fuller
-- name exists, never the surrounding private text) -- it just no longer raises the row's tier or
-- bulk-bumps its other aliases to do so. Both alias inserts (the preserved short form and the new
-- full form) stay at requested_tier, unchanged.
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
      derived_from = coalesce(derived_from, requested_derived_from)
  where id = found_id;
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

-- ---------------------------------------------------------------------------------------------
-- 5. resolve_or_promote_extracted_org: same edit as the person version above -- canonical_name
-- reconciliation (base name -> fuller legal form) stays exactly as before; only the tier raise and
-- the blanket org_aliases bump are removed. The alias-conflict check and the alias inserts below
-- (unchanged from 022) already only ever add NEW alias rows at requested_tier.
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
        derived_from = coalesce(derived_from, requested_derived_from)
    where id = found_id;
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

-- ---------------------------------------------------------------------------------------------
-- 6. Re-pin search_path and re-issue the 022-pattern revoke/grant statements for every replaced
-- function, even though CREATE OR REPLACE on an unchanged signature does not itself reset prior
-- GRANT state -- this keeps the migration self-documenting about the intended privilege set rather
-- than relying on 022/029 history. keep_entity_tier_guarded is a trigger function, invoked
-- implicitly by the trigger mechanism, not by direct call -- same as its predecessor, it is
-- revoked from public and granted to no one.
revoke execute on function keep_entity_tier_guarded() from public;
revoke execute on function resolve_or_promote_entity(text,text,smallint,text,text,uuid) from public;
revoke execute on function resolve_or_promote_extracted_person(text,smallint,text,text,uuid) from public;
revoke execute on function resolve_or_promote_extracted_org(text,text,smallint,text,text,uuid) from public;
revoke execute on function upsert_derived_alias(text,uuid,text,smallint,text,text,uuid) from public;

grant execute on function resolve_or_promote_entity(text,text,smallint,text,text,uuid) to minime_app;
grant execute on function resolve_or_promote_extracted_person(text,smallint,text,text,uuid) to minime_app;
grant execute on function resolve_or_promote_extracted_org(text,text,smallint,text,text,uuid) to minime_app;
grant execute on function upsert_derived_alias(text,uuid,text,smallint,text,text,uuid) to minime_app;
