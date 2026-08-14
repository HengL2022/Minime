-- 035_goal_review_kind.sql
-- W3-12 (goals live: minime_upsert_goal, indexing at write, goals in state, goal_review dream
-- kind): adds a 'goal_review' review-queue kind for goals gone stale -- active, untouched, and
-- with no linked task touched either, for 90+ days (dream.ts enqueueGoalReviews) -- and grants
-- minime_app ordinary table-wide UPDATE on goals so minime_upsert_goal can change
-- statement/why/status/parent_id (028_correction_supersede.sql only ever granted UPDATE on the
-- two supersede columns there).
--
-- Numbered 035: the task's own spec text targeted migration 031 (provisional); 031-034 were
-- already taken by other W3 tasks landing on this branch first (031_calendar_occurrences.sql,
-- 032_timeline_locked_count.sql, 033_ops_failure_kind.sql, 034_person_dates.sql). 035 is the
-- true next free number as of this migration -- same numbering-deviation note as 030/031/034's
-- own precedent, not a contract decision in itself.
--
-- Recreates the constraint with the STRICT SUPERSET of every kind 033_ops_failure_kind.sql
-- listed (the latest prior recreation; nothing between 033 and this migration touched the
-- constraint) plus 'goal_review'. Idempotent: drop-then-add is safe to re-run.

alter table review_queue
  drop constraint if exists review_queue_kind_check;
alter table review_queue
  add constraint review_queue_kind_check
  check (kind in ('contradiction','stale','duplicate','decision_review','inbox_unfiled',
                  'phantom_person','extract_suspect','ops_failure','goal_review'));

-- Least-privilege expansion (risk note, W3-12 spec): 021_runtime_app_role.sql revoked the
-- table-wide UPDATE on goals that 007_rls.sql originally granted, narrowing minime_app down to
-- SELECT/INSERT only; 028_correction_supersede.sql later re-opened exactly the two supersede
-- columns. Neither grant lets an agent change a goal's own statement/why/status/parent_id, which
-- minime_upsert_goal needs. This grants ordinary table-wide UPDATE, matching the six PARENTS
-- tables that already carried it before 028 (tasks, decisions, people, pages, orgs,
-- decision_branches -- see 021_runtime_app_role.sql). No RLS policy change is needed: goals'
-- existing tier_update policy (007_rls.sql, tightened to `tier >= 1 and tier <= app_allowed_tier()`
-- by 021/028) is already scoped to minime_app and already bounds every UPDATE regardless of which
-- columns are touched -- only the missing table-level grant was blocking it. Recorded in the
-- reviewable allow-list, src/ops/runtime-role-privileges.ts.
grant update on goals to minime_app;
