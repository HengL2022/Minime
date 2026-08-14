-- W3-3 review remediation (high-severity finding, 2026-08-08): minime_timeline's per-kind LOCKED
-- tier-2 count (journal/interaction) was computed as a plain
-- `select count(*) ... where tier = 2 ...` through the ordinary db() connection (repo.ts's
-- runtime pool). In the real resident deployment that connection is always the restricted
-- minime_app role -- src/serve.ts's restrictedAppUrl()/runtimeChildEnvironment() pin both
-- DATABASE_URL and MINIME_APP_DATABASE_URL to it -- and journal_entries/interactions carry the
-- standard tier_read RLS policy `USING (tier >= 1 and tier <= app_allowed_tier())`
-- (021_runtime_app_role.sql). Postgres intersects that policy with the query's own WHERE clause,
-- so a genuinely LOCKED session (app_allowed_tier() = 1) can never satisfy both `tier <= 1` and
-- `tier = 2` at once -- the count is unconditionally 0 no matter how many tier-2 rows actually
-- exist in range, defeating the exact purpose repo.ts's own comment describes: telling a locked
-- caller "there is more here you cannot see" instead of silently reading an empty range as
-- nothing happened.
--
-- Fix: count through a narrowly-scoped SECURITY DEFINER function, the same shape as metric_agg()
-- (007_rls.sql / 026_time_semantics.sql) -- it runs as the migration owner, so it is not subject
-- to the invoking role's RLS, and it returns only a bare integer, never a title/id/row. The
-- source table is dispatched through a fixed two-branch CASE (never a dynamic identifier or
-- format()), the same allow-list style as edge_source_tier/readable_source_tier
-- (021/022_entity_derivation_tiers.sql) -- an unrecognized kind raises rather than silently
-- counting the wrong table. The requested time zone is re-validated against pg_timezone_names
-- exactly like metric_agg, since this function is directly callable by minime_app and must not
-- trust a caller-supplied string on its own.
create function timeline_locked_count(
  source_kind text,
  from_date date,
  to_date date,
  requested_time_zone text
) returns integer
language plpgsql
security definer
stable
set search_path = pg_catalog, public, pg_temp
as $$
declare n integer;
declare resolved_time_zone text;
begin
  select name into resolved_time_zone
  from pg_catalog.pg_timezone_names
  where lower(name) = lower(requested_time_zone)
  limit 1;
  if resolved_time_zone is null then
    raise exception 'INVALID_TIME_ZONE';
  end if;

  case source_kind
    when 'journal' then
      select count(*) into n
      from journal_entries
      where tier = 2
        and (at at time zone resolved_time_zone)::date between from_date and to_date
        and superseded_at is null;
    when 'interaction' then
      select count(*) into n
      from interactions
      where tier = 2
        and (occurred_at at time zone resolved_time_zone)::date between from_date and to_date
        and superseded_at is null;
    else
      raise exception 'UNKNOWN_TIMELINE_LOCKED_SOURCE: %', source_kind;
  end case;

  return n;
end;
$$;

-- minime_engineer_ro deliberately does NOT get this grant: migration 018/024 keep its function
-- surface to exactly app_allowed_tier() + metric_agg() (test/m15.roles.test.ts asserts that exact
-- list), and engineering sessions never run repo.ts's compiled timelineRows() -- they use the
-- SELECT-only DSN directly (CLAUDE.md), where the existing RLS-locked count is the intended,
-- unchanged behavior.
revoke execute on function timeline_locked_count(text, date, date, text) from public;
grant execute on function timeline_locked_count(text, date, date, text) to minime_app;
