-- 036_commitment_update_grant.sql
-- W3-13 (commitments live: optional `promise` param on minime_log_interaction opens a commitment
-- tied to the logged person/org, minime_upsert_commitment closes or reschedules one) grants
-- minime_app ordinary table-wide UPDATE on commitments so minime_upsert_commitment can change
-- status/due (028_correction_supersede.sql only ever granted UPDATE on the two supersede columns
-- there; 021_runtime_app_role.sql's curated re-grant after its own blanket revoke left commitments
-- SELECT+INSERT only -- the exact gap goals had before 035_goal_review_kind.sql's identical fix).
--
-- Numbered 036: the task's own spec text targeted migration 032 (provisional); 032-035 were
-- already taken by other W3 tasks landing on this branch first (032_timeline_locked_count.sql,
-- 033_ops_failure_kind.sql, 034_person_dates.sql, 035_goal_review_kind.sql). 036 is the true next
-- free number as of this migration -- same numbering-deviation note as 030/031/034/035's own
-- precedent, not a contract decision in itself.
--
-- No RLS policy change needed: commitments' existing tier_update policy (007_rls.sql, tightened
-- to `tier >= 1 and tier <= app_allowed_tier()` by 028_correction_supersede.sql) is already scoped
-- to minime_app and already bounds every UPDATE regardless of which columns are touched -- only
-- the missing table-level grant was blocking it. Recorded in the reviewable allow-list,
-- src/ops/runtime-role-privileges.ts.
grant update on commitments to minime_app;

-- minime_log_interaction's promise capture needs the SUBJECT's real canonical name for
-- commitments.to_whom (not the caller's possibly-aliased raw input), read back right after
-- ensurePerson/ensureOrg (resolve_or_promote_entity) resolves or mints it in the SAME call. An
-- ordinary `select canonical_name from people/orgs where id = ...` is subject to the caller's own
-- tier_read RLS policy, which would return zero rows for a LOCKED caller reading back a tier-2
-- subject it just legitimately touched (proven by test/entity-tier-provenance.test.ts's
-- restricted-role subprocess harness). security definer, mirroring person_has_nonworking_relation/
-- touch_person_last_contact/edge_source_tier's own style: a fixed two-branch CASE over exactly
-- 'person'/'org', never an identifier built from caller input, and still floored to `tier in
-- (1,2)` so it can never read a tier-0 quarantined row even from inside the definer's own bypass.
create or replace function entity_canonical_name(entity_kind text, target_id uuid)
returns text
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select case entity_kind
    when 'person' then (select canonical_name from people where id = target_id and tier in (1,2))
    when 'org' then (select canonical_name from orgs where id = target_id and tier in (1,2))
    else null
  end
$$;

revoke execute on function entity_canonical_name(text, uuid) from public;
grant execute on function entity_canonical_name(text, uuid) to minime_app;
