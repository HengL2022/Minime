-- 015_interactions_org.sql
-- Root-cause fix for phantom-org creation via minime_log_interaction.
--
-- PROBLEM: the `interactions` table was keyed on person_id only (no org_id).
-- log_interaction therefore had to mint a PERSON row for every counterparty — so
-- logging a vendor ("Vazyme") created a phantom PERSON, which the weekly phantom-org
-- audit then flagged. The workaround was a person+org pair linked by `vendor_record_of`.
--
-- FIX: let an interaction attach to a person OR an org.
--   - person_id was ALREADY nullable in 002_core.sql (no change needed)
--   - org_id added (nullable, FK -> orgs)
--   - CHECK forbids the genuinely-invalid state (BOTH person_id and org_id set):
--     num_nonnulls(person_id, org_id) <= 1.
--
-- Why <= 1 and not = 1 (exactly one)?
--   The live DB already contains historical interactions with NEITHER subject set
--   (6 'note'-kind rows captured 2026-06-13, when person_id was nullable and the
--   classifier filed standalone notes as interactions). A strict "= 1" check would
--   reject the migration on those legacy rows. The application write path
--   (repo.insertInteraction) DOES enforce exactly-one for every NEW interaction, so
--   no new subjectless rows can appear; the DB constraint only needs to guarantee we
--   never get the ambiguous BOTH-set state.
--
-- RLS: the tier_read/tier_write/tier_update policies in 007_rls.sql key off `tier`,
-- NOT person_id, so org-keyed / subjectless rows do not weaken row-level security.

alter table interactions
  add column if not exists org_id uuid references orgs(id);

-- Never both subjects at once (ambiguous). Subjectless legacy rows are tolerated.
alter table interactions
  drop constraint if exists interactions_subject_xor;
alter table interactions
  add constraint interactions_subject_xor
  check (num_nonnulls(person_id, org_id) <= 1);

-- Helpful index for org-keyed reads (mirrors the implicit person_id lookups).
create index if not exists interactions_org_id_idx on interactions (org_id) where org_id is not null;
