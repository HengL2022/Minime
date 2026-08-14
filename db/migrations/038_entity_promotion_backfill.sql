-- W4-2 (owner-ratified 2026-08-09): demotion path for entities the pre-037 monotonic-tier rule
-- promoted and can never come back down on its own. 037_identity_content_tier_split.sql stopped
-- NEW resolves from raising an existing person/org's stored tier, but deliberately left every
-- row already sitting at tier 2 under the old rule untouched -- this migration is the promised
-- backfill pass over that history (037's own header comment: "a review/backfill pass over
-- history is W4-2, deliberately out of scope here").
--
-- Two independent pieces:
--   1. Recreate review_queue's kind check constraint as a strict superset of 035's list (the
--      latest prior recreation; nothing between 035 and this migration touched it) plus the new
--      'entity_promotion' kind -- same drop-then-add idempotent style as 016/033/035.
--   2. Backfill one deduped review_queue row per "previously swallowed" tier-2 person/org.
--
-- Heuristic (owner-ratified, DECISIONS.md 2026-08-09) for "previously swallowed": a tier-2
-- person/org is worth a review item when it is EITHER owner-created (created_by = 'human', or
-- source in ('onboard','manual') -- the owner typed this identity in directly at some point, so
-- its own tier-2 resting place is very likely an artifact of the old promotion bug, not an
-- intentional privacy choice) OR tier-1-evidenced (at least one tier-1 edge touches it, or it
-- carries at least one tier-1 alias -- some other, already-tier-1 write already treats this
-- identity as readable, so its own card being stuck at tier 2 is an inconsistency worth a human
-- look). This is a conservative "flag for review", not an automatic demotion: nothing here
-- changes any row's tier. The owner decides per item via `entity:restore-tier` (src/cli.ts),
-- which is the only place a 2->1 demotion can actually happen (037's guarded trigger).
--
-- Payload carries entity_type + entity_id ONLY. Row ids are safe to hold in a tier-1-readable
-- queue; names are not -- review-queue.ts resolves and masks the name fresh at the caller's own
-- tier, the same pattern goal_review/decision_review/phantom_person already use. Idempotent: a
-- second run of this migration (or a database that already has one of these items open) inserts
-- nothing new for an entity_id that already has an open entity_promotion item.

alter table review_queue
  drop constraint if exists review_queue_kind_check;
alter table review_queue
  add constraint review_queue_kind_check
  check (kind in ('contradiction','stale','duplicate','decision_review','inbox_unfiled',
                  'phantom_person','extract_suspect','ops_failure','goal_review',
                  'entity_promotion'));

insert into review_queue (kind, payload)
select 'entity_promotion',
       jsonb_build_object('entity_type', candidate.entity_type, 'entity_id', candidate.entity_id)
from (
  select 'person'::text as entity_type, p.id as entity_id
  from people p
  where p.tier = 2
    and p.superseded_at is null
    and (
      p.created_by = 'human'
      or p.source in ('onboard', 'manual')
      or exists (
        select 1 from edges e
        where e.tier = 1
          and ((e.src_type = 'person' and e.src_id = p.id)
            or (e.dst_type = 'person' and e.dst_id = p.id))
      )
      or exists (
        select 1 from person_aliases a
        where a.person_id = p.id and a.tier = 1
      )
    )
  union all
  select 'org'::text as entity_type, o.id as entity_id
  from orgs o
  where o.tier = 2
    and o.superseded_at is null
    and o.retired_at is null
    and (
      o.created_by = 'human'
      or o.source in ('onboard', 'manual')
      or exists (
        select 1 from edges e
        where e.tier = 1
          and ((e.src_type = 'org' and e.src_id = o.id)
            or (e.dst_type = 'org' and e.dst_id = o.id))
      )
      or exists (
        select 1 from org_aliases a
        where a.org_id = o.id and a.tier = 1
      )
    )
) candidate
where not exists (
  select 1 from review_queue rq
  where rq.kind = 'entity_promotion' and rq.status = 'open'
    and rq.payload ->> 'entity_id' = candidate.entity_id::text
);
