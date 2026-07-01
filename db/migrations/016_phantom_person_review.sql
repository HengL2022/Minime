-- 016_phantom_person_review.sql
-- Adds a 'phantom_person' review-queue kind for the nightly phantom-person watchdog.
--
-- CONTEXT: 015_interactions_org.sql fixed the ROOT cause of phantom-person creation on
-- the write path (interactions can now attach to an org, and the classifier emits
-- subject_type so a vendor/company routes to an org instead of minting a person row).
-- This migration adds the SAFETY NET: a nightly scan (dream step 3b) that flags any
-- person row that actually looks like an organisation — same name as an existing org,
-- or a company cue in the name with zero human interaction/relation signal. It FLAGS
-- only (queue payload carries the person_id + reason); it never auto-retypes, matching
-- the flag-only contract of every other review_queue kind (contradiction/stale/…).
--
-- Idempotent: drop-then-add the CHECK so re-running migrate() is safe.

alter table review_queue
  drop constraint if exists review_queue_kind_check;
alter table review_queue
  add constraint review_queue_kind_check
  check (kind in ('contradiction','stale','duplicate','decision_review','inbox_unfiled','phantom_person'));
