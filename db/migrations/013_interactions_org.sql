-- 013_interactions_org.sql
-- Root-cause fix for phantom-org creation via minime_log_interaction.
--
-- PROBLEM: the `interactions` table was PERSON-KEYED only (person_id, no org_id).
-- log_interaction therefore had to mint a PERSON row for every counterparty — so
-- logging a vendor ("Vazyme") created a phantom PERSON, which the weekly phantom-org
-- audit then flagged. The workaround was a person+org pair linked by `vendor_record_of`.
--
-- FIX: let an interaction attach to EITHER a person OR an org.
--   - person_id becomes nullable
--   - org_id added (nullable, FK -> orgs)
--   - CHECK enforces exactly one of (person_id, org_id) is set (XOR), so we never
--     regress to an interaction with no subject or an ambiguous double-subject.
--
-- RLS: the tier_read/tier_write/tier_update policies in 007_rls.sql key off `tier`,
-- NOT person_id, so making person_id nullable does not weaken row-level security.
-- Existing rows all have person_id set and org_id null — they satisfy the XOR.

alter table interactions
  alter column person_id drop not null;

alter table interactions
  add column if not exists org_id uuid references orgs(id);

-- Exactly one subject: person XOR org. (NULL-safe: num_nonnulls counts non-null args.)
alter table interactions
  drop constraint if exists interactions_subject_xor;
alter table interactions
  add constraint interactions_subject_xor
  check (num_nonnulls(person_id, org_id) = 1);

-- Helpful index for org-keyed reads (mirrors the implicit person_id lookups).
create index if not exists interactions_org_id_idx on interactions (org_id) where org_id is not null;
