-- The engineering login is a deliberately small, tier-gated inspection role. Older
-- installations may have accumulated authority while migrations 018-023 evolved, so rebuild
-- the role from a closed posture instead of assuming its flags, memberships, or ACLs are clean.

-- A non-superuser migration owner cannot safely repair a SUPERUSER/REPLICATION/BYPASSRLS role,
-- and object ownership carries implicit authority that REVOKE cannot remove. Stop before adding
-- any grants if either condition exists; the owner must repair that cluster posture explicitly.
do $$
declare engineer_oid oid;
begin
  select oid into engineer_oid from pg_roles where rolname = 'minime_engineer_ro';
  if engineer_oid is null or exists (
    select 1 from pg_roles
    where oid = engineer_oid and (rolsuper or rolreplication or rolbypassrls)
  ) then
    raise exception 'engineer_role_posture_invalid';
  end if;
  if exists (select 1 from pg_class where relowner = engineer_oid)
    or exists (select 1 from pg_proc where proowner = engineer_oid)
    or exists (select 1 from pg_namespace where nspowner = engineer_oid)
    or exists (select 1 from pg_type where typowner = engineer_oid)
    or exists (select 1 from pg_database where datname = current_database() and datdba = engineer_oid)
  then
    raise exception 'engineer_role_posture_invalid';
  end if;
end $$;

-- NOINHERIT alone is insufficient because a login may still SET ROLE into an outbound
-- membership. Inbound SET/INHERIT memberships also spread engineering authority to another
-- login. Remove every executable option in both directions. PostgreSQL 16+ may retain the
-- migration creator's bootstrap-granted ADMIN-only ownership row; with SET/INHERIT false it
-- cannot exercise engineer privileges and adds nothing beyond the creator's existing CREATEROLE.
-- Role flags and memberships are cluster-global, even though this migration is also replayed in
-- test and restore databases. Only the canonical live database may rewrite that shared tuple;
-- scratch replays apply the database-local ACLs below and verify the already-closed posture.
do $$
declare granted_role text;
declare member_role text;
begin
  if current_database() = 'minime' then
    execute 'alter role minime_engineer_ro login nocreatedb nocreaterole noinherit';
    for granted_role in
      select granted.rolname
      from pg_auth_members membership
      join pg_roles granted on granted.oid = membership.roleid
      join pg_roles member on member.oid = membership.member
      where member.rolname = 'minime_engineer_ro'
    loop
      execute format('revoke set option for %I from minime_engineer_ro', granted_role);
      execute format('revoke inherit option for %I from minime_engineer_ro', granted_role);
      execute format('revoke admin option for %I from minime_engineer_ro', granted_role);
      execute format('revoke %I from minime_engineer_ro', granted_role);
    end loop;
    for member_role in
      select member.rolname
      from pg_auth_members membership
      join pg_roles member on member.oid = membership.member
      join pg_roles granted on granted.oid = membership.roleid
      where granted.rolname = 'minime_engineer_ro'
    loop
      execute format('revoke set option for minime_engineer_ro from %I', member_role);
      execute format('revoke inherit option for minime_engineer_ro from %I', member_role);
      execute format('revoke admin option for minime_engineer_ro from %I', member_role);
      execute format('revoke minime_engineer_ro from %I', member_role);
    end loop;
    if exists (
      select 1 from pg_auth_members membership
      where membership.member = (select oid from pg_roles where rolname = 'minime_engineer_ro')
         or (
           membership.roleid = (select oid from pg_roles where rolname = 'minime_engineer_ro')
           and (
             membership.member <> (select oid from pg_roles where rolname = current_user)
             or membership.inherit_option or membership.set_option
           )
         )
    ) then
      raise exception 'engineer_role_posture_invalid';
    end if;
  end if;
end $$;

-- Remove current direct and PUBLIC object authority first. PUBLIC function EXECUTE would
-- otherwise bypass an exact per-role function allow-list; PUBLIC table/sequence ACLs would do
-- the same for data. Runtime roles retain their explicit grants from migrations 021-023.
revoke all privileges on all tables in schema public from public, minime_engineer_ro;
revoke all privileges on all sequences in schema public from public, minime_engineer_ro;
revoke all privileges on all functions in schema public from public, minime_engineer_ro;
revoke create on schema public from public, minime_engineer_ro;

-- pgvector operators and UUID defaults are implemented by trusted extension functions, and
-- native installs create those extensions as the local PostgreSQL superuser. The Minime owner
-- cannot revoke that grantor's PUBLIC ACL, so bound the inherited surface to exactly vector and
-- pgcrypto. No Minime-owned function is public; the engineer's direct grants below remain the
-- two sanctioned SECURITY DEFINER entry points.
do $$
declare routine regprocedure;
begin
  for routine in
    select procedure.oid::regprocedure
    from pg_proc procedure
    join pg_depend dependency
      on dependency.classid = 'pg_proc'::regclass
     and dependency.objid = procedure.oid
     and dependency.refclassid = 'pg_extension'::regclass
     and dependency.deptype = 'e'
    join pg_extension extension on extension.oid = dependency.refobjid
    where extension.extname in ('vector', 'pgcrypto')
  loop
    execute format('grant execute on function %s to public', routine);
  end loop;
end $$;

do $$
begin
  execute format(
    'revoke create, temporary on database %I from public, minime_engineer_ro',
    current_database()
  );
  execute format('grant connect on database %I to minime_engineer_ro', current_database());
end $$;

grant usage on schema public to minime_engineer_ro;

grant select on
  schema_migrations,
  values_items,
  goals,
  principles,
  commitments,
  journal_entries,
  person_aliases,
  interactions,
  calendar_events,
  email_meta,
  org_aliases,
  decision_transcripts,
  decision_branches,
  tasks,
  decisions,
  people,
  pages,
  metric_values,
  orgs,
  chunks,
  edges,
  metric_defs
to minime_engineer_ro;

grant execute on function app_allowed_tier() to minime_engineer_ro;
grant execute on function metric_agg(text, date, date) to minime_engineer_ro;

-- Future objects are private until a migration explicitly reviews and grants them. Clear both
-- PUBLIC and engineer defaults for every object class that can carry data or executable power.
alter default privileges in schema public revoke all on tables from public, minime_engineer_ro;
alter default privileges in schema public revoke all on sequences from public, minime_engineer_ro;
alter default privileges in schema public revoke all on functions from public, minime_engineer_ro;

-- Catalog postcondition: migrations must not silently continue with residual flags, membership,
-- ownership, defaults, or direct privileges outside the exact grants above.
do $$
declare engineer_oid oid;
declare readable_tables text[] := array[
  'schema_migrations','values_items','goals','principles','commitments','journal_entries',
  'person_aliases','interactions','calendar_events','email_meta','org_aliases',
  'decision_transcripts','decision_branches','tasks','decisions','people','pages',
  'metric_values','orgs','chunks','edges','metric_defs'
];
begin
  select oid into engineer_oid from pg_roles where rolname = 'minime_engineer_ro';
  if engineer_oid is null or exists (
    select 1 from pg_roles
    where oid = engineer_oid and (
      rolsuper or rolcreatedb or rolcreaterole or rolinherit or rolreplication or rolbypassrls
      or not rolcanlogin
    )
  ) then
    raise exception 'engineer_role_posture_invalid';
  end if;
  if exists (
    select 1 from pg_auth_members membership
    where membership.member = engineer_oid
       or (
         membership.roleid = engineer_oid
         and (
           membership.member <> (select oid from pg_roles where rolname = current_user)
           or membership.inherit_option or membership.set_option
         )
       )
  )
    or exists (
      select 1
      from pg_default_acl defaults
      cross join lateral aclexplode(defaults.defaclacl) acl
      where defaults.defaclobjtype in ('r', 'S', 'f')
        and acl.grantee in (0, engineer_oid)
    )
  then
    raise exception 'engineer_role_posture_invalid';
  end if;

  if exists (
    select 1
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public' and relation.relkind in ('r','p','v','m','f')
      and (
        has_table_privilege('minime_engineer_ro', relation.oid, 'INSERT')
        or has_table_privilege('minime_engineer_ro', relation.oid, 'UPDATE')
        or has_table_privilege('minime_engineer_ro', relation.oid, 'DELETE')
        or has_table_privilege('minime_engineer_ro', relation.oid, 'TRUNCATE')
        or has_table_privilege('minime_engineer_ro', relation.oid, 'REFERENCES')
        or has_table_privilege('minime_engineer_ro', relation.oid, 'TRIGGER')
        or has_table_privilege(
          'minime_engineer_ro', relation.oid, 'SELECT WITH GRANT OPTION'
        )
        or (
          relation.relname = any(readable_tables)
          and not has_table_privilege('minime_engineer_ro', relation.oid, 'SELECT')
        )
        or (
          not (relation.relname = any(readable_tables))
          and has_table_privilege('minime_engineer_ro', relation.oid, 'SELECT')
        )
      )
  ) then
    raise exception 'engineer_role_posture_invalid';
  end if;

  if exists (
    select 1
    from pg_attribute attribute
    join pg_class relation on relation.oid = attribute.attrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and attribute.attnum > 0 and not attribute.attisdropped
      and (
        has_column_privilege('minime_engineer_ro', relation.oid, attribute.attnum, 'INSERT')
        or has_column_privilege('minime_engineer_ro', relation.oid, attribute.attnum, 'UPDATE')
        or has_column_privilege('minime_engineer_ro', relation.oid, attribute.attnum, 'REFERENCES')
        or has_column_privilege(
          'minime_engineer_ro', relation.oid, attribute.attnum, 'SELECT WITH GRANT OPTION'
        )
        or (
          not (relation.relname = any(readable_tables))
          and has_column_privilege('minime_engineer_ro', relation.oid, attribute.attnum, 'SELECT')
        )
      )
  ) then
    raise exception 'engineer_role_posture_invalid';
  end if;

  if exists (
    select 1
    from pg_class sequence
    join pg_namespace namespace on namespace.oid = sequence.relnamespace
    where namespace.nspname = 'public' and sequence.relkind = 'S'
      and (
        has_sequence_privilege('minime_engineer_ro', sequence.oid, 'USAGE')
        or has_sequence_privilege('minime_engineer_ro', sequence.oid, 'SELECT')
        or has_sequence_privilege('minime_engineer_ro', sequence.oid, 'UPDATE')
      )
  ) then
    raise exception 'engineer_role_posture_invalid';
  end if;

  if exists (
    select 1
    from pg_proc routine
    join pg_namespace namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'public'
      and has_function_privilege('minime_engineer_ro', routine.oid, 'EXECUTE')
      and routine.oid not in (
        'app_allowed_tier()'::regprocedure,
        'metric_agg(text,date,date)'::regprocedure
      )
      and not exists (
        select 1
        from pg_depend dependency
        join pg_extension extension on extension.oid = dependency.refobjid
        where dependency.classid = 'pg_proc'::regclass
          and dependency.objid = routine.oid
          and dependency.refclassid = 'pg_extension'::regclass
          and dependency.deptype = 'e'
          and extension.extname in ('vector', 'pgcrypto')
      )
  ) then
    raise exception 'engineer_role_posture_invalid';
  end if;

  if exists (
    select 1
    from pg_proc routine
    join pg_namespace namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'public'
      and has_function_privilege(
        'minime_engineer_ro', routine.oid, 'EXECUTE WITH GRANT OPTION'
      )
  ) then
    raise exception 'engineer_role_posture_invalid';
  end if;

  if not has_function_privilege(
    'minime_engineer_ro', 'app_allowed_tier()'::regprocedure, 'EXECUTE'
  ) or not has_function_privilege(
    'minime_engineer_ro', 'metric_agg(text,date,date)'::regprocedure, 'EXECUTE'
  ) or has_function_privilege(
    'minime_engineer_ro', 'app_allowed_tier()'::regprocedure, 'EXECUTE WITH GRANT OPTION'
  ) or has_function_privilege(
    'minime_engineer_ro', 'metric_agg(text,date,date)'::regprocedure,
    'EXECUTE WITH GRANT OPTION'
  ) then
    raise exception 'engineer_role_posture_invalid';
  end if;

  if not has_schema_privilege('minime_engineer_ro', 'public', 'USAGE')
    or has_schema_privilege('minime_engineer_ro', 'public', 'USAGE WITH GRANT OPTION')
    or has_schema_privilege('minime_engineer_ro', 'public', 'CREATE')
    or not has_database_privilege('minime_engineer_ro', current_database(), 'CONNECT')
    or has_database_privilege(
      'minime_engineer_ro', current_database(), 'CONNECT WITH GRANT OPTION'
    )
    or has_database_privilege('minime_engineer_ro', current_database(), 'CREATE')
    or has_database_privilege('minime_engineer_ro', current_database(), 'TEMPORARY')
  then
    raise exception 'engineer_role_posture_invalid';
  end if;
  if current_setting('server_version_num')::integer >= 170000 then
    if exists (
      select 1
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public' and relation.relkind in ('r','p','v','m','f')
        and has_table_privilege('minime_engineer_ro', relation.oid, 'MAINTAIN')
    ) then
      raise exception 'engineer_role_posture_invalid';
    end if;
  end if;
end $$;
