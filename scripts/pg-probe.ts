// Ops probe (no psql client needed): exit 0 iff PROBE_URL is a reachable Postgres
// with the vector extension installed. Used by install.sh/up.sh detection.
import postgres from "postgres";

const url = process.env.PROBE_URL;
if (!url) {
  console.error("PROBE_URL not set");
  process.exit(2);
}
const sql = postgres(url, { max: 1, connect_timeout: 4, onnotice: () => {} });
try {
  const r = await sql`select count(*)::int as n from pg_extension where extname = 'vector'`;
  process.exit(r[0]!.n > 0 ? 0 : 1);
} catch {
  process.exit(1);
} finally {
  await sql.end({ timeout: 1 }).catch(() => {});
}
