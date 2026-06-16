-- Sanctioned entity retype/supersede support (DECISIONS.md 2026-06-16).
-- The relation extractor can mint an `org` row for what is really a person (e.g. a boss
-- first seen only inside a task title). retypeOrgToPerson() converts such a row into a
-- person and *retires* the org rather than hard-deleting it, so the action is auditable
-- and reversible. `retired_at` marks a superseded org; resolveOrg() ignores retired rows.

alter table orgs add column if not exists retired_at timestamptz;
alter table orgs add column if not exists retired_reason text;
