// Owner-only installer step.  The application password arrives through the environment and is
// never printed; DATABASE_URL remains the owner/control-plane connection for migrations.
import postgres from "postgres";

const password = process.env.MINIME_APP_PASSWORD;
const databaseUrl = process.env.DATABASE_URL;
if (!password || !/^[A-Za-z0-9_-]{24,128}$/.test(password) || !databaseUrl) {
  console.error("runtime_role_configuration_invalid");
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
try {
  const [ledger] = await sql<{ present: boolean }[]>`
    select to_regclass('public.schema_migrations') is not null as present`;
  if (!ledger?.present) throw new Error("runtime_role_schema_not_current");
  const [schema] = await sql<{ ready: boolean }[]>`
    select exists (
      select 1 from schema_migrations where name = '021_runtime_app_role.sql'
    ) as ready`;
  if (!schema?.ready) throw new Error("runtime_role_schema_not_current");
  const [ownership] = await sql<{ n: number }[]>`
    select (
      (select count(*) from pg_class c join pg_roles r on r.oid = c.relowner
       where r.rolname = 'minime_app') +
      (select count(*) from pg_proc p join pg_roles r on r.oid = p.proowner
       where r.rolname = 'minime_app') +
      (select count(*) from pg_namespace n join pg_roles r on r.oid = n.nspowner
       where r.rolname = 'minime_app') +
      (select count(*) from pg_database d join pg_roles r on r.oid = d.datdba
       where r.rolname = 'minime_app')
    )::int as n`;
  if (Number(ownership?.n) !== 0) throw new Error("runtime_role_posture_invalid");
  await sql.begin(async (tx) => {
    await tx.unsafe(
      "do $$ begin if not exists (select 1 from pg_roles where rolname = 'minime_app') then create role minime_app; end if; end $$",
    );
    // Reassert the posture that a non-superuser owner can change. If the existing role carries
    // a superuser-only unsafe flag, ALTER/verification fails closed below instead of cutting
    // over the resident app to an elevated role.
    await tx.unsafe("alter role minime_app login nocreatedb nocreaterole noinherit");
    await tx`select set_config('minime.app_password', ${password}, true)`;
    await tx.unsafe(
      "do $$ begin execute format('alter role minime_app password %L', current_setting('minime.app_password')); end $$",
    );
    const [posture] = await tx<
      {
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolbypassrls: boolean;
        rolinherit: boolean;
        rolreplication: boolean;
      }[]
    >`select rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit, rolreplication
         from pg_roles where rolname = 'minime_app'`;
    const [membership] = await tx<{ n: number }[]>`
      select count(*)::int as n
      from pg_auth_members m
      join pg_roles member on member.oid = m.member
      where member.rolname = 'minime_app'`;
    if (
      !posture ||
      posture.rolsuper ||
      posture.rolcreatedb ||
      posture.rolcreaterole ||
      posture.rolbypassrls ||
      posture.rolinherit ||
      posture.rolreplication ||
      Number(membership?.n) !== 0
    ) {
      throw new Error("runtime_role_posture_invalid");
    }
  });
} catch (error) {
  console.error(
    error instanceof Error &&
      (error.message === "runtime_role_schema_not_current" ||
        error.message === "runtime_role_posture_invalid")
      ? error.message
      : "runtime_role_provision_failed",
  );
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
