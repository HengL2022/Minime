-- W2-6 review fix: upsert_derived_alias's conflict check and orgs' canonical-name uniqueness
-- both spanned tier 1+2 unconditionally, with no bound against the calling session's own
-- app_allowed_tier(). A locked (tier-1) session that already controls a visible tier-1 person or
-- org could therefore probe minime_upsert_person with candidate alias/rename strings and read the
-- ok-vs-BAD_INPUT split as a tier-2 existence oracle -- exactly the signal minime_get_context's
-- own NOT_FOUND path (W1-5) deliberately collapses. Both fixes below make the caller's own tier
-- the boundary of what can even look like a conflict, matching every other content read in this
-- codebase (repo.ts's `tier <= app_allowed_tier()` predicate).

-- Alias conflicts: only a conflicting alias/entity pair the calling session could itself already
-- see through an ordinary read (resolvePerson/resolveOrg's own `tier <= app_allowed_tier()`
-- bound) may block the write. A conflict that exists only at a tier above the caller's own is now
-- invisible to this check too, so the call proceeds exactly like the "nothing conflicts" case --
-- including actually writing the alias, so a later resolve by the SAME caller behaves identically
-- whether or not a hidden entity happened to already own the string (no follow-up probe reopens
-- the oracle a second way). app_allowed_tier() is itself security definer and reads only
-- session-local GUCs (minime.actor/minime.session_id), so calling it here still reflects the
-- REAL calling session, not this function's owner.
--
-- Accepted cost: if this session is LATER owner-approved-unlocked to tier 2, the alias string now
-- legitimately points at two different entities, and exact-name resolution (no ORDER BY,
-- pre-existing) may pick either -- a resolution-ambiguity nuisance for an already-privileged,
-- audited unlock, never a new disclosure to a locked caller. People already tolerate the
-- analogous ambiguity for canonical_name (person.ts's own header comment: no auto-merge until
-- W2-7); this is the same trade extended to the alias table.
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
      and o.tier <= caller_tier and a.tier <= caller_tier
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

-- Org canonical-name uniqueness: scope it PER TIER (mirroring the tier-0 quarantine namespace
-- 022 already carved out for this same index) instead of across tier 1+2 combined, so renaming a
-- visible org can never collide with a name that only exists on a hidden tier-2 row. A same-tier
-- collision -- the only kind this index can still raise -- is, by construction, always a row the
-- caller could already see: minime_upsert_person only ever resolves a rename target within the
-- caller's own allowed tier (getRow/resolveOrg), so the OTHER row sharing that exact tier value
-- is equally within reach. resolve_or_promote_entity's own org lookup already searches tier 1+2 as
-- one candidate pool before ever deciding to insert (022), so it never relied on this index
-- spanning both tiers -- it always finds and reuses an existing row of either tier first.
drop index if exists orgs_canonical_name_idx;
create unique index orgs_canonical_name_idx on orgs (tier, lower(canonical_name))
  where tier in (1,2);
