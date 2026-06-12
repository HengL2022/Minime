-- Access-frequency ranking (DECISIONS.md 2026-06-12) reads drill-in counts off events on
-- every search; this partial index keeps that scan O(drill-ins) as the audit log grows.
create index events_get_context_at_idx on events (at)
  where verb = 'tool:minime_get_context';
