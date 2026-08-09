-- Livability program task W4-4: tier-locked match COUNT in the minime_search envelope.
--
-- ftsCandidates/vectorCandidates (repo.ts) both filter `c.tier >= 1 and c.tier <= allowed` in
-- their own SQL, so a locked session's search silently drops any chunk above its current tier —
-- there is no signal that a real match exists at tier 2, only a shorter (or empty) hit list.
-- Every other bounded, rankable tier-2-locked read in this codebase already discloses existence
-- as a bare count once it went looking (032_timeline_locked_count.sql, W3-3's minime_timeline);
-- search was the one W1-8's own honesty pass explicitly could NOT make that promise for
-- (agents/skills/query.md, pre-this-migration: "never state or imply a count of what's hidden —
-- the envelope carries none"), because no such count existed yet. This migration builds it.
--
-- suppressed_candidate_count(q, q_vec, k) mirrors ftsCandidates'/vectorCandidates' own candidate
-- SQL as closely as a single function can: the same `chunks` table, the same `tier >= 1` floor
-- (tier 0 is never touched here or anywhere in search — I3), the same websearch_to_tsquery/
-- ts_rank_cd ordering for the fts arm and the same cosine-distance ordering for the vector arm,
-- each independently topped at `k` (clamped to 50 — the same top-50 cap ftsCandidates/
-- vectorCandidates themselves use — so this cannot be used to force unbounded work regardless of
-- what `k` a caller passes). The one deliberate difference from those two functions is the upper
-- tier ceiling: they stop at `tier <= allowed`; this counts distinct (parent_type, parent_id)
-- pairs among the SAME top-k pool whose tier is ABOVE app_allowed_tier() — read inside the
-- function itself, the same GUC-scoped call every tier check in this codebase makes (023's own
-- app_allowed_tier(), not a caller-supplied tier), so an already-unlocked caller structurally
-- gets 0 back (no content tier exceeds 2) even if repo.ts's own gating is ever bypassed by a
-- future bug. It returns ONLY that bare integer — never an id, title, or snippet, which would let
-- a caller enumerate what is locked rather than merely know something is (the same "aggregate is
-- fine, raw content is not" boundary I3 already draws for tier-0 metrics via metric_agg()).
--
-- `q` must be the exact already-cjk_fold-ed, OR-joined term string ftsCandidates itself builds
-- (repo.ts's shared ftsOrQuery helper, used by both ftsCandidates and suppressedCandidateCount) —
-- passing raw, unfolded query text here would silently answer a different search than the one
-- the caller actually ran, which is exactly the "drift = misleading counts" risk this task's own
-- spec flagged up front.
--
-- Retracted parents (superseded_at set, superseded_by null — 028_correction_supersede.sql) are
-- excluded via the same twelve-PARENTS-table union repo.ts's parentMeta itself filters against
-- (W2-5, superseded-search.test.ts): a retracted row will never reappear after an unlock, so
-- counting it as "locked" would overstate what an unlock actually buys the caller. A superseded
-- row WITH a live successor (superseded_by set, not excluded here) still counts — it stays
-- rankable once unlocked, same as parentMeta treats it (down-weighted, not hidden).
--
-- SECURITY DEFINER, the same shape as metric_agg() (007_rls.sql) and timeline_locked_count()
-- (032_timeline_locked_count.sql): runs as the migration owner so it can see tier-2 rows a locked
-- minime_app session's own RLS would hide, pinned search_path, revoked from public, granted only
-- to minime_app. minime_engineer_ro deliberately does NOT get this grant, matching
-- timeline_locked_count's own precedent: engineering sessions read through the SELECT-only DSN
-- directly (CLAUDE.md) and never run repo.ts's compiled search path, so there is no caller on
-- that connection that could ever need it.
create function suppressed_candidate_count(q text, q_vec vector(768), k int)
returns integer
language plpgsql
security definer
stable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  n integer;
  allowed smallint := app_allowed_tier();
  cap integer := least(greatest(coalesce(k, 0), 0), 50);
begin
  with tsq as (
    select websearch_to_tsquery('english', coalesce(q, '')) as query
  ),
  fts_top as (
    select c.parent_type, c.parent_id, c.tier
    from chunks c, tsq
    where c.tier >= 1
      and c.tsv @@ tsq.query
    order by ts_rank_cd(c.tsv, tsq.query) desc
    limit cap
  ),
  vec_top as (
    select c.parent_type, c.parent_id, c.tier
    from chunks c
    where c.tier >= 1 and c.embedding is not null and q_vec is not null
    order by c.embedding <=> q_vec
    limit cap
  ),
  locked as (
    select distinct parent_type, parent_id
    from (select * from fts_top union all select * from vec_top) candidates
    where tier > allowed
  ),
  -- Same twelve tables, same retraction predicate, as repo.ts's parentMeta (W2-5). Static and
  -- fixed rather than a dynamic per-type loop — the type list is closed and never caller input.
  live_parent as (
    select 'page'::text as parent_type, id from pages
      where not (superseded_at is not null and superseded_by is null)
    union all
    select 'journal', id from journal_entries
      where not (superseded_at is not null and superseded_by is null)
    union all
    select 'interaction', id from interactions
      where not (superseded_at is not null and superseded_by is null)
    union all
    select 'decision', id from decisions
      where not (superseded_at is not null and superseded_by is null)
    union all
    select 'decision_branch', id from decision_branches
      where not (superseded_at is not null and superseded_by is null)
    union all
    select 'task', id from tasks
      where not (superseded_at is not null and superseded_by is null)
    union all
    select 'goal', id from goals
      where not (superseded_at is not null and superseded_by is null)
    union all
    select 'value', id from values_items
      where not (superseded_at is not null and superseded_by is null)
    union all
    select 'principle', id from principles
      where not (superseded_at is not null and superseded_by is null)
    union all
    select 'person', id from people
      where not (superseded_at is not null and superseded_by is null)
    union all
    select 'org', id from orgs
      where not (superseded_at is not null and superseded_by is null)
    union all
    select 'commitment', id from commitments
      where not (superseded_at is not null and superseded_by is null)
  )
  select count(*) into n
  from locked l
  join live_parent p on p.parent_type = l.parent_type and p.id = l.parent_id;

  return coalesce(n, 0);
end;
$$;

revoke execute on function suppressed_candidate_count(text, vector, int) from public;
grant execute on function suppressed_candidate_count(text, vector, int) to minime_app;
