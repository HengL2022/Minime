-- W8 parent-child chunking: heading sections become envelope spans; children stay
-- the embed/FTS/rerank unit. chunks.parent_type/parent_id already mean the parent
-- row, so this level is named span. Child sizing stays at the current 350/400/40
-- defaults (eval-calibration pending) — tightening to 120–200 is a later constant
-- change after a live battery, not this migration.
--
-- W6 Phase B: receipt_candidate is flag-only. Payload is inbox_item_id + image_kind;
-- nothing here inserts a transaction. chunk_spans is not granted to engineer-ro
-- (default deny).

create table if not exists chunk_spans (
  id uuid primary key default gen_random_uuid(),
  parent_type text not null,
  parent_id uuid not null,
  ord int not null,
  text text not null,
  unique (parent_type, parent_id, ord)
);

alter table chunks add column if not exists span_id uuid references chunk_spans(id) on delete set null;
create index if not exists chunks_span_id_idx on chunks (span_id);

alter table review_queue
  drop constraint if exists review_queue_kind_check;
alter table review_queue
  add constraint review_queue_kind_check
  check (kind in ('contradiction','stale','duplicate','decision_review','inbox_unfiled',
                  'phantom_person','extract_suspect','ops_failure','goal_review',
                  'entity_promotion','receipt_candidate'));
