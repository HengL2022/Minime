-- 018_engineer_role.sql
-- W4 (improve-w4-roles.md): SELECT-only login role for engineering sessions. Deliberately
-- NOT BYPASSRLS (engineering sessions are agent sessions — RLS tier-gates them exactly like
-- the MCP door; the owner's raw path stays `psql` as minime). Tier-0 content tables are
-- revoked outright, mirroring minime_app (I3: tier-0 never enters agent context).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'minime_engineer_ro') then
    create role minime_engineer_ro login password 'minime';   -- localhost box; same posture as scripts/lib.sh
  end if;
end $$;

-- grant connect is per-database; format() so test/scratch DBs applying this migration work too
do $$ begin
  execute format('grant connect on database %I to minime_engineer_ro', current_database());
end $$;

grant usage on schema public to minime_engineer_ro;
grant select on all tables in schema public to minime_engineer_ro;
-- I3: tier-0 content is never agent-readable; aggregates only via metric_agg().
revoke select on transactions, health_samples from minime_engineer_ro;
grant execute on function app_allowed_tier() to minime_engineer_ro;
grant execute on function metric_agg(text, date, date) to minime_engineer_ro;

-- Every existing tier_read SELECT policy (007, 008, 013, 014) is scoped `to minime_app`
-- only. Postgres RLS policy TO-lists are role-scoped: a plain `grant select` above is NOT
-- enough on its own for a role that isn't named in an applicable policy — RLS falls back to
-- a hard default-deny, meaning minime_engineer_ro would see ZERO rows at every tier (not
-- just tier-2) on any table already covered by 007/008/013/014, defeating the point of a
-- read-only engineering role (verified against a live instance while building this
-- migration). Extend the TO-list in place rather than adding parallel policies, so each
-- table keeps exactly one tier_read predicate shared by both agent-ish roles. Write
-- policies (tier_write/tier_update) stay minime_app-only: minime_engineer_ro has no
-- INSERT/UPDATE grant on anything above, so they never apply to it regardless — leaving
-- them alone documents that intent. List kept explicit (not discovered via pg_policies) for
-- auditability; test/m15.roles.test.ts asserts it stays exhaustive as future migrations add
-- RLS tables.
do $$
declare t text;
begin
  foreach t in array array[
    'journal_entries','interactions','email_meta','pages','chunks',
    'tasks','goals','values_items','principles','decisions','commitments',
    'people','calendar_events','inbox_items','edges','orgs',
    'decision_transcripts','decision_branches'
  ]
  loop
    execute format('alter policy tier_read on %I to minime_app, minime_engineer_ro', t);
  end loop;
end $$;

-- Future tables created by the migration role get SELECT automatically. NOTE for future
-- migrations: a NEW tier-0 table must add its own explicit revoke (checklist in CLAUDE.md).
-- A NEW RLS table must add itself to the array above (or the m15 completeness test fails).
alter default privileges in schema public grant select on tables to minime_engineer_ro;
