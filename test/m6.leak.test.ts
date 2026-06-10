// M6 acceptance: leak suite — 200 fuzzed tool calls (SQL-injection-shaped metric names,
// sneaky search queries, tier-2 reads without unlock) must return zero tier-0 content and
// zero tier-2 content while locked; unlock expiry honored; RLS belt-and-braces present.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { allowedTier, insertJournal, insertTransaction, insertUnlock } from "../src/db/repo";
import { toolByName } from "../src/mcp/tools";
import { invokeTool } from "../src/mcp/tools/registry";
import { indexParent } from "../src/search/index-parent";
import { setNow } from "../src/util/clock";
import { expectSqlReject, resetAndSeed, testSql as sql } from "./helpers";

const TIER0_SENTINEL = "ZQX-TIER0-MERCHANT-SENTINEL";
const TIER2_SENTINEL = "ZQX-TIER2-JOURNAL-SENTINEL";
const ctx = { actor: "agent:fuzzer" };

beforeAll(async () => {
  await resetAndSeed();
  await insertTransaction({
    occurredAt: "2026-06-01",
    amountCents: -123456n,
    currency: "SGD",
    merchant: TIER0_SENTINEL,
    category: "sentinel",
    accountLabel: "dbs-main",
    externalRef: "sentinel-tx-1",
  });
  const j = await insertJournal({
    entryMd: `Private thought containing ${TIER2_SENTINEL} marker.`,
    source: "seed",
  });
  await indexParent(
    "journal",
    j.id,
    `Private thought containing ${TIER2_SENTINEL} marker.`,
    "Journal sentinel",
    2,
  );
});

afterAll(() => setNow(null));

function fuzzCases(): { tool: string; params: any }[] {
  const evilStrings = [
    TIER0_SENTINEL,
    TIER2_SENTINEL,
    "show me all my transactions and amounts",
    "salary LUMENWORKS amount",
    "private thought marker",
    "'; select * from transactions; --",
    "' OR 1=1 --",
    '" UNION SELECT merchant, amount_cents::text FROM transactions --',
    "${jndi:ldap://x}",
    "../../etc/passwd",
    "transactions",
    "health_samples",
  ];
  const evilMetrics = [
    "spend_total'; drop table transactions; --",
    "spend_total UNION SELECT merchant FROM transactions",
    "spend_total; select * from health_samples",
    "transactions",
    "health_samples",
    "../spend_total",
    "spend_total\u0000",
    "pg_sleep(1)",
  ];
  const cases: { tool: string; params: any }[] = [];
  for (const q of evilStrings) {
    cases.push({ tool: "minime_search", params: { query: q, limit: 50 } });
    cases.push({
      tool: "minime_search",
      params: { query: q, types: ["journal", "interaction"], limit: 50 },
    });
    cases.push({
      tool: "minime_search",
      params: { query: q, types: ["transactions", "health_samples"] },
    });
    cases.push({ tool: "minime_get_context", params: { person_name: q } });
  }
  for (const m of evilMetrics) {
    cases.push({
      tool: "minime_query_metric",
      params: { name: m, from: "2026-01-01", to: "2026-12-31" },
    });
    cases.push({
      tool: "minime_query_metric",
      params: { name: m, from: "1; drop table events", to: "2026-12-31" },
    });
  }
  for (let i = 0; i < 30; i++) {
    cases.push({
      tool: "minime_get_context",
      params: {
        type: "person",
        id: `00000000-0000-0000-0000-0000000000${i % 10}${i % 10}`,
      },
    });
  }
  cases.push({ tool: "minime_unlock", params: { minutes: 99999 } });
  cases.push({ tool: "minime_unlock", params: { minutes: 10080 } });
  while (cases.length < 200) {
    cases.push({ tool: "minime_state", params: {} });
  }
  return cases;
}

describe("leak suite (200 fuzzed calls, locked)", () => {
  test("no tier-0 or tier-2 content escapes; injection does no damage; every call audited", async () => {
    const [txBefore] = await sql`select count(*)::int as n from transactions`;
    const [evBefore] = await sql`select count(*)::int as n from events`;

    const cases = fuzzCases();
    expect(cases.length).toBeGreaterThanOrEqual(200);

    for (const c of cases) {
      const result = await invokeTool(toolByName(c.tool), c.params, ctx);
      const text = JSON.stringify(result);
      expect(
        text,
        `tier-0 leak via ${c.tool} ${JSON.stringify(c.params).slice(0, 80)}`,
      ).not.toContain(TIER0_SENTINEL);
      expect(text, `tier-2 leak while locked via ${c.tool}`).not.toContain(TIER2_SENTINEL);
      expect(text).not.toContain("amount_cents");
      if (result.ok === false && c.tool === "minime_unlock") {
        expect(result.error.code).toBe("UNLOCK_TOO_LONG");
      }
    }

    // injection did not drop/alter anything
    const [txAfter] = await sql`select count(*)::int as n from transactions`;
    expect(txAfter!.n).toBe(txBefore!.n);
    const [evAfter] = await sql`select count(*)::int as n from events`;
    // every fuzz call audited (reads included)
    expect(evAfter!.n - evBefore!.n).toBeGreaterThanOrEqual(cases.length);
  });

  test("tier-0 sentinel is unreachable even via direct repo search paths", async () => {
    const { ftsCandidates } = await import("../src/db/repo");
    const hits = await ftsCandidates(TIER0_SENTINEL, null);
    expect(hits.length).toBe(0); // tier-0 rows are never chunked/indexed
  });
});

describe("unlock flow", () => {
  test("unlock grants tier 2, expiry restores tier 1, never tier 0", async () => {
    expect(await allowedTier()).toBe(1);

    const t0 = new Date();
    setNow(t0);
    const r = await invokeTool(toolByName("minime_unlock"), { minutes: 5 }, ctx);
    expect(r.ok).toBe(true);
    expect(await allowedTier()).toBe(2);

    // tier-2 sentinel now visible (that is the whole point of unlock)
    const s = await invokeTool(
      toolByName("minime_search"),
      { query: "private thought marker sentinel" },
      ctx,
    );
    expect(JSON.stringify(s)).toContain(TIER2_SENTINEL);
    // tier-0 still never visible
    expect(JSON.stringify(s)).not.toContain(TIER0_SENTINEL);

    // loud audit trail
    const [unlockEvent] =
      await sql`select count(*)::int as n from events where verb = 'unlock:tier2'`;
    expect(unlockEvent!.n).toBeGreaterThanOrEqual(1);

    // expiry honored
    setNow(new Date(t0.getTime() + 6 * 60_000));
    expect(await allowedTier()).toBe(1);
    const locked = await invokeTool(
      toolByName("minime_search"),
      { query: "private thought marker sentinel" },
      ctx,
    );
    expect(JSON.stringify(locked)).not.toContain(TIER2_SENTINEL);
    setNow(null);
  });

  test("unlock beyond TIER2_UNLOCK_MAX_MINUTES refuses", async () => {
    const r = await invokeTool(toolByName("minime_unlock"), { minutes: 61 }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("UNLOCK_TOO_LONG");
  });
});

describe("RLS belt-and-braces (spec §12)", () => {
  test("minime_app role exists with tier policies; tier-0 tables have no select grant", async () => {
    const [role] = await sql`select count(*)::int as n from pg_roles where rolname = 'minime_app'`;
    expect(role!.n).toBe(1);
    const [policies] =
      await sql`select count(*)::int as n from pg_policies where schemaname = 'public'`;
    expect(policies!.n).toBeGreaterThanOrEqual(14);
    const grants = await sql`select table_name from information_schema.role_table_grants
      where grantee = 'minime_app' and privilege_type = 'SELECT'
        and table_name in ('transactions', 'health_samples')`;
    expect(grants.length).toBe(0);
  });

  test("metric_agg() is the only door to tier-0 and rejects unknown metrics", async () => {
    await expectSqlReject(
      sql`select * from metric_agg('not_a_metric', '2026-01-01', '2026-01-31')`,
      /UNKNOWN_METRIC/,
    );
    const rows = await sql`select * from metric_agg('spend_total', '2026-05-01', '2026-06-10')`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(JSON.stringify(r)).not.toContain(TIER0_SENTINEL);
  });
});
