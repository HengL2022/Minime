-- 033_ops_failure_kind.sql
-- W3-7 (minime doctor CLI + ops_health + ops_failure review kind): adds an 'ops_failure'
-- review-queue kind for persistent nightly-maintenance breakage.
--
-- CONTEXT: serve.ts's maintenance scheduler now inspects the last 3 dream:summary events after
-- every dream run. When all 3 consecutive runs failed at least one step AND no ops_failure item
-- is already open, it flags one (payload: failed_steps — fixed dream-step identifiers, see
-- util/audit-payload.ts's DREAM_STEPS — and since, the oldest failing run's timestamp). Same
-- flag-only contract as every other review_queue kind: this never auto-resolves, retries, or
-- touches maintenance state itself — the owner (or their agent, pointed at `minime doctor`)
-- decides what to do.
--
-- Recreates the constraint with the STRICT SUPERSET of every kind 017_edge_validation.sql listed
-- (the latest prior recreation; nothing between 017 and this migration touched the constraint)
-- plus 'ops_failure'. Idempotent: drop-then-add is safe to re-run.

alter table review_queue
  drop constraint if exists review_queue_kind_check;
alter table review_queue
  add constraint review_queue_kind_check
  check (kind in ('contradiction','stale','duplicate','decision_review','inbox_unfiled',
                  'phantom_person','extract_suspect','ops_failure'));
