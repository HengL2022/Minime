import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("owned_child_database_url_missing");
const sourceSentinel = process.env.SOURCE_URL_SENTINEL;
const abrupt = process.argv[2] === "abrupt";
const applicationName = "minime-test-abrupt-owned-child";
const sql = postgres(url, {
  max: 1,
  ...(abrupt ? { connection: { application_name: applicationName } } : {}),
});
try {
  const [{ name }] = await sql<[{ name: string }]>`select current_database() as name`;
  const [identity] = await sql<
    [{ pid: number; role: string; backend_type: string }]
  >`select pid, usename as role, backend_type from pg_stat_activity where pid = pg_backend_pid()`;
  let ddlDenied = false;
  try {
    await sql.unsafe("create table owned_child_ddl_probe (id integer)");
  } catch {
    ddlDenied = true;
  }
  const [{ n }] = await sql<[{ n: number }]>`select count(*)::int as n from schema_migrations`;
  const extensions = await sql<{ extname: string }[]>`
    select extname from pg_extension where extname in ('vector', 'pgcrypto') order by extname`;
  if (!/^minime_test_[a-z0-9_]+$/.test(name)) throw new Error("owned_child_database_guard");
  if (extensions.map((row) => row.extname).join(",") !== "pgcrypto,vector") {
    throw new Error("owned_child_extensions_guard");
  }
  if (abrupt) {
    console.log(
      JSON.stringify({
        pid: Number(identity?.pid),
        role: identity?.role,
        backendType: identity?.backend_type,
        applicationName,
        name,
        ddlDenied,
        migrations: Number(n),
        extensions: extensions.map((row) => row.extname),
      }),
    );
    process.exit(0);
  }
  const inheritedValues = [
    process.env.DATABASE_URL,
    process.env.EVAL_DATABASE_URL,
    process.env.EVAL_PMB_DATABASE_URL,
    process.env.EVAL_SKILLS_DATABASE_URL,
  ];
  const sourceAbsent =
    sourceSentinel === undefined ||
    !inheritedValues.some((value) => value?.includes(sourceSentinel));
  const argvSourceAbsent =
    sourceSentinel === undefined || !process.argv.some((value) => value.includes(sourceSentinel));
  console.log(
    JSON.stringify({
      name,
      migrations: Number(n),
      extensions: extensions.map((row) => row.extname),
      role: identity?.role,
      ddlDenied,
      sourceAbsent,
      argvSourceAbsent,
      aliasRole: process.env.EVAL_DATABASE_URL
        ? new URL(process.env.EVAL_DATABASE_URL).username
        : null,
      aliasDatabase: process.env.EVAL_DATABASE_URL
        ? new URL(process.env.EVAL_DATABASE_URL).pathname.slice(1)
        : null,
      argv: process.argv.slice(2),
    }),
  );
} finally {
  if (!abrupt) await sql.end({ timeout: 5 });
}
