-- 017_edge_validation.sql
-- W1 (improve-w1-extract-validate.md): nightly re-validation of system:extract edges.
-- Verdict LEDGER (insert-only by convention; system-internal, not MCP-exposed) — makes sweep
-- idempotency, unsure-resampling, and per-rule miss-rates plain SQL instead of event archaeology.
create table edge_validations (
  id uuid primary key default gen_random_uuid(),
  edge_id uuid not null references edges(id) on delete cascade,
  verdict text not null check (verdict in ('confirm','deny','unsure')),
  entity_type text check (entity_type in ('person','org','neither')),
  reason text,                                  -- model's one-line justification (<=140 chars)
  model text not null,                          -- provider/model or 'mock'
  rule_key text not null,                       -- '<rel>@<confidence>' e.g. 'works_at@0.85'
  checked_at timestamptz not null default now()
);
create index edge_validations_edge_idx on edge_validations (edge_id, checked_at desc);
create index edge_validations_rule_idx on edge_validations (rule_key, verdict);

-- New flag-only review kind for disagreements (same pattern as 016_phantom_person_review).
alter table review_queue drop constraint if exists review_queue_kind_check;
alter table review_queue add constraint review_queue_kind_check
  check (kind in ('contradiction','stale','duplicate','decision_review','inbox_unfiled',
                  'phantom_person','extract_suspect'));
