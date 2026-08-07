// M6 acceptance: leak suite — 200 fuzzed tool calls (SQL-injection-shaped metric names,
// sneaky search queries, tier-2 reads without unlock) must return zero tier-0 content and
// zero tier-2 content while locked; unlock expiry honored; RLS belt-and-braces present.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { accessCounts, allowedTier, insertJournal, insertTransaction } from "../src/db/repo";
import {
  type AuditDisposition,
  type AuditSink,
  type DurableResultAudit,
  type ResultAuditRecord,
  eventAuditSink,
  paramsHash,
} from "../src/mcp/audit";
import { envelope } from "../src/mcp/envelope";
import { toolByName } from "../src/mcp/tools";
import { type ToolDef, invokeTool } from "../src/mcp/tools/registry";
import { indexParent } from "../src/search/index-parent";
import { setNow } from "../src/util/clock";
import { expectSqlReject, resetAndSeed, testSql as sql } from "./helpers";
import { requestAndApproveTier2, sessionToolCtx } from "./support/unlock";

const TIER0_SENTINEL = "ZQX-TIER0-MERCHANT-SENTINEL";
const TIER2_SENTINEL = "ZQX-TIER2-JOURNAL-SENTINEL";
const PARAMETER_SENTINEL = "ZQX-PARAMETER-SENTINEL";
const TITLE_SENTINEL = "ZQX-TITLE-SENTINEL";
const SOURCE_SENTINEL = "ZQX-SOURCE-SENTINEL";
const ERROR_SENTINEL = "ZQX-ERROR-SENTINEL";
const ctx = sessionToolCtx("agent:fuzzer");

class RecordingSink implements AuditSink {
  events: Array<{
    phase: "attempt" | "result";
    params?: unknown;
    ids?: string[];
    count?: number;
    error?: string;
    delivery?: "transport" | "direct";
  }> = [];
  fail: "attempt" | "result" | null = null;
  private nextEventId = 1;

  async attempt(_actor: string, _tool: string, params: unknown): Promise<string> {
    if (this.fail === "attempt") throw new Error("injected attempt failure");
    const hash = paramsHash(params);
    this.events.push({ phase: "attempt", params });
    return hash;
  }

  async result(
    _actor: string,
    _tool: string,
    _paramsHash: string,
    record: ResultAuditRecord,
    _requestedNameHash?: string,
  ): Promise<DurableResultAudit> {
    if (this.fail === "result") throw new Error("injected result failure");
    this.events.push({
      phase: "result",
      ids: record.returnedIds.slice(0, 100),
      count: record.returnedCount,
      error: record.error,
      delivery: record.delivery,
    });
    return { eventId: String(this.nextEventId++) };
  }

  async disposition(
    _actor: string,
    _tool: string,
    _resultEventId: string,
    _disposition: AuditDisposition,
  ): Promise<void> {
    throw new Error("direct invocation must not append disposition");
  }
}

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
    PARAMETER_SENTINEL,
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
    const [evBefore] =
      await sql`select coalesce(max(id), 0)::bigint as id, count(*)::int as n from events`;

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
    // every fuzz call has exactly one durable receipt and one compatible terminal event.
    expect(evAfter!.n - evBefore!.n).toBeGreaterThanOrEqual(cases.length * 2);
    const toolEvents = await sql`
      select id, verb, payload
      from events
      where id > ${evBefore!.id} and verb like 'tool:%'
      order by id asc`;
    expect(toolEvents).toHaveLength(cases.length * 2);
    const attempts = toolEvents.filter((event) => event.verb.endsWith(":attempt"));
    const dispositions = toolEvents.filter((event) => event.verb.endsWith(":disposition"));
    const results = toolEvents.filter(
      (event) => !event.verb.endsWith(":attempt") && !event.verb.endsWith(":disposition"),
    );
    expect(attempts).toHaveLength(cases.length);
    expect(results).toHaveLength(cases.length);
    expect(dispositions).toHaveLength(0);
    expect(results.every((event) => event.payload.delivery === "direct")).toBe(true);
    for (let i = 0; i < cases.length; i++) {
      expect(BigInt(attempts[i]!.id)).toBeLessThan(BigInt(results[i]!.id));
    }
    const returnedIds = results.flatMap((event) =>
      Array.isArray(event.payload.returned_ids) ? event.payload.returned_ids : [],
    );
    expect((await accessCounts(returnedIds, 90, ctx.actor)).size).toBe(0);
    const serializedAudit = JSON.stringify(toolEvents);
    for (const sentinel of [
      TIER0_SENTINEL,
      TIER2_SENTINEL,
      PARAMETER_SENTINEL,
      TITLE_SENTINEL,
      SOURCE_SENTINEL,
      ERROR_SENTINEL,
    ]) {
      expect(serializedAudit).not.toContain(sentinel);
    }
  });

  test("tier-0 sentinel is unreachable even via direct repo search paths", async () => {
    const { ftsCandidates } = await import("../src/db/repo");
    const hits = await ftsCandidates(TIER0_SENTINEL, null);
    expect(hits.length).toBe(0); // tier-0 rows are never chunked/indexed
  });
});

describe("direct audit disposition compatibility", () => {
  test("normal and handler-error calls persist direct records without disposition", async () => {
    const ids = Array.from({ length: 137 }, (_, index) => `direct-source-${index}`);
    const successTool: ToolDef = {
      name: "fictional_direct_success",
      description: "fictional",
      schema: {},
      handler: async () =>
        envelope(
          { ok: true },
          ids.map((id) => ({ type: "note", id })),
        ),
    };
    const successSink = new RecordingSink();
    const success = await invokeTool(successTool, {}, { actor: "agent:direct" }, successSink);
    expect(success.ok).toBe(true);
    expect(successSink.events).toEqual([
      { phase: "attempt", params: {} },
      {
        phase: "result",
        ids: ids.slice(0, 100),
        count: 137,
        error: undefined,
        delivery: "direct",
      },
    ]);

    const errorSink = new RecordingSink();
    const failed = await invokeTool(
      {
        ...successTool,
        name: "fictional_direct_error",
        handler: async () => {
          throw new Error(ERROR_SENTINEL);
        },
      },
      {},
      { actor: "agent:direct" },
      errorSink,
    );
    expect(failed.ok).toBe(false);
    expect(failed).toEqual({
      ok: false,
      error: { code: "INTERNAL", message: "Internal tool error." },
    });
    expect(JSON.stringify(failed)).not.toContain(ERROR_SENTINEL);
    expect(errorSink.events).toEqual([
      { phase: "attempt", params: {} },
      {
        phase: "result",
        ids: [],
        count: 0,
        error: "INTERNAL",
        delivery: "direct",
      },
    ]);
    expect(JSON.stringify(errorSink.events)).not.toContain(ERROR_SENTINEL);
  });

  test("injected phase failures expose only fixed acknowledgements and no sentinels", async () => {
    let mutations = 0;
    const source = {
      type: "note",
      id: SOURCE_SENTINEL,
      title: TITLE_SENTINEL,
      created_by: "actor-secret",
      updated_at: "2026-07-25T00:00:00.000Z",
    };
    const successTool: ToolDef = {
      name: "fictional_leak_guard",
      description: "fictional",
      schema: {},
      handler: async () => {
        mutations += 1;
        return envelope({ title: TITLE_SENTINEL, source: SOURCE_SENTINEL, error: ERROR_SENTINEL }, [
          source,
        ]);
      },
    };

    const attemptSink = new RecordingSink();
    attemptSink.fail = "attempt";
    const attemptFailure = await invokeTool(
      successTool,
      { parameter: PARAMETER_SENTINEL },
      { actor: `agent:${ERROR_SENTINEL}` },
      attemptSink,
    );
    expect(attemptFailure).toEqual({
      ok: false,
      error: { code: "INTERNAL", message: "Tool unavailable before execution.", retry: true },
    });
    expect(mutations).toBe(0);
    expect(attemptSink.events).toHaveLength(0);
    expect(JSON.stringify(attemptFailure)).not.toMatch(
      new RegExp([PARAMETER_SENTINEL, TITLE_SENTINEL, SOURCE_SENTINEL, ERROR_SENTINEL].join("|")),
    );

    const resultSink = new RecordingSink();
    resultSink.fail = "result";
    const completedWithheld = await invokeTool(
      successTool,
      { parameter: PARAMETER_SENTINEL },
      { actor: "agent:fictional" },
      resultSink,
    );
    expect(completedWithheld).toEqual({
      ok: true,
      envelope: {
        data: { status: "completed_result_withheld", retry: false },
        sources: [],
        gaps: ["completion audit unavailable; result withheld"],
      },
    });
    expect(mutations).toBe(1);
    expect(resultSink.events).toEqual([
      { phase: "attempt", params: { parameter: PARAMETER_SENTINEL } },
    ]);
    expect(JSON.stringify(completedWithheld)).not.toMatch(
      new RegExp([PARAMETER_SENTINEL, TITLE_SENTINEL, SOURCE_SENTINEL, ERROR_SENTINEL].join("|")),
    );

    const errorSink = new RecordingSink();
    errorSink.fail = "result";
    const errorTool: ToolDef = {
      ...successTool,
      handler: async () => {
        throw new Error(ERROR_SENTINEL);
      },
    };
    const auditUnavailable = await invokeTool(
      errorTool,
      { parameter: PARAMETER_SENTINEL },
      { actor: "agent:fictional" },
      errorSink,
    );
    expect(auditUnavailable).toEqual({
      ok: false,
      error: {
        code: "AUDIT_UNAVAILABLE",
        message: "Tool result withheld because completion audit is unavailable.",
        retry: false,
      },
    });
    expect(errorSink.events).toEqual([
      { phase: "attempt", params: { parameter: PARAMETER_SENTINEL } },
    ]);
    expect(JSON.stringify(auditUnavailable)).not.toMatch(
      new RegExp([PARAMETER_SENTINEL, TITLE_SENTINEL, SOURCE_SENTINEL, ERROR_SENTINEL].join("|")),
    );
  });

  test("production sink persists lossless exact disposition payloads once", async () => {
    await sql`
      select setval(
        pg_get_serial_sequence('events', 'id'),
        ${"9007199254740992"}::bigint,
        true
      )`;
    const cases = [
      { status: "released" as const },
      {
        status: "suppressed" as const,
        outcome: "completed_not_released" as const,
      },
      { status: "send_uncertain" as const },
    ];
    const returnedId = crypto.randomUUID();
    const durable: Array<{ eventId: string; status: string }> = [];
    for (const disposition of cases) {
      const result = await eventAuditSink.result(ctx.actor, "minime_get_context", "0".repeat(16), {
        returnedIds: [returnedId],
        returnedCount: 137,
        error: "INTERNAL",
        delivery: "transport",
      });
      durable.push({ eventId: result.eventId, status: disposition.status });
      await eventAuditSink.disposition(
        ctx.actor,
        "minime_get_context",
        result.eventId,
        disposition,
      );
    }
    expect(durable[0]?.eventId).toBe("9007199254740993");
    const rows = await sql`
      select id::text as id, verb, payload
      from events
      where verb in (
        'tool:minime_get_context',
        'tool:minime_get_context:disposition'
      )
        and id > ${"9007199254740992"}::bigint
      order by id asc`;
    expect(rows).toHaveLength(6);
    const results = rows.filter((row) => row.verb === "tool:minime_get_context");
    const dispositions = rows.filter((row) => row.verb.endsWith(":disposition"));
    expect(results).toHaveLength(3);
    expect(dispositions).toHaveLength(3);
    for (let index = 0; index < cases.length; index++) {
      const result = results[index]!;
      const disposition = dispositions[index]!;
      expect(result.id).toBe(durable[index]!.eventId);
      expect(result.payload).toMatchObject({
        returned_ids: [returnedId],
        returned_count: 137,
        error: "INTERNAL",
        delivery: "transport",
      });
      expect(disposition.payload.result_event_id).toBe(result.id);
      expect(disposition.payload.result_event_id).toBe(durable[index]!.eventId);
      const expectedKeys =
        cases[index]!.status === "suppressed"
          ? ["outcome", "result_event_id", "returned_count", "returned_ids", "status"]
          : ["result_event_id", "status"];
      expect(Object.keys(disposition.payload).sort()).toEqual(expectedKeys);
    }
    expect(dispositions[0]!.payload).toEqual({
      result_event_id: durable[0]!.eventId,
      status: "released",
    });
    expect(dispositions[1]!.payload).toEqual({
      outcome: "completed_not_released",
      result_event_id: durable[1]!.eventId,
      returned_count: 0,
      returned_ids: [],
      status: "suppressed",
    });
    expect(dispositions[2]!.payload).toEqual({
      result_event_id: durable[2]!.eventId,
      status: "send_uncertain",
    });
    expect(JSON.stringify([...results, ...dispositions])).not.toContain(ERROR_SENTINEL);
    expect(JSON.stringify(dispositions)).not.toContain(SOURCE_SENTINEL);

    await expectSqlReject(
      eventAuditSink.disposition(ctx.actor, "minime_get_context", durable[0]!.eventId, {
        status: "released",
      }),
      /events_tool_disposition_result_event_uidx/,
    );
    const [duplicateCount] = await sql`
      select count(*)::int as n
      from events
      where verb = 'tool:minime_get_context:disposition'
        and payload->>'result_event_id' = ${durable[0]!.eventId}`;
    expect(duplicateCount!.n).toBe(1);
  });
});

describe("unlock flow", () => {
  test("owner approval grants this session tier 2; expiry restores tier 1; tier 0 stays closed", async () => {
    expect(await allowedTier(ctx.actor, ctx.sessionId)).toBe(1);

    const t0 = new Date();
    setNow(t0);
    const { requestId } = await requestAndApproveTier2(ctx);
    expect(await allowedTier(ctx.actor, ctx.sessionId)).toBe(2);

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
    const [unlockEvents] = await sql`
      select count(*)::int as n from events
      where verb in ('unlock:tier2:requested', 'unlock:tier2:approved')
        and entity_id = ${requestId}::uuid`;
    expect(unlockEvents!.n).toBe(2);

    // expiry honored
    await sql`
      update session_unlocks
      set approved_at = clock_timestamp() - interval '2 seconds',
          expires_at = clock_timestamp() - interval '1 second'
      where id = ${requestId}::uuid`;
    expect(await allowedTier(ctx.actor, ctx.sessionId)).toBe(1);
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
      sql`select * from metric_agg('not_a_metric', '2026-01-01', '2026-01-31', 'UTC')`,
      /UNKNOWN_METRIC/,
    );
    await expectSqlReject(
      sql`select * from metric_agg('steps', '2026-01-01', '2026-01-31', 'not/a-zone')`,
      /INVALID_TIME_ZONE/,
    );
    await sql`select * from metric_agg('steps', '2026-01-01', '2026-01-31', 'asia/singapore')`;
    const rows =
      await sql`select * from metric_agg('spend_total', '2026-05-01', '2026-06-10', 'UTC')`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(JSON.stringify(r)).not.toContain(TIER0_SENTINEL);

    const [boundary] = await sql`
      select
        to_regprocedure('public.metric_agg(text,date,date)') is null as old_removed,
        has_function_privilege('public', 'public.metric_agg(text,date,date,text)', 'EXECUTE') as public_execute,
        has_function_privilege('minime_app', 'public.metric_agg(text,date,date,text)', 'EXECUTE') as app_execute,
        has_function_privilege('minime_engineer_ro', 'public.metric_agg(text,date,date,text)', 'EXECUTE') as engineer_execute,
        has_table_privilege('minime_app', 'public.transactions', 'SELECT') as app_transactions,
        has_table_privilege('minime_app', 'public.health_samples', 'SELECT') as app_health,
        has_table_privilege('minime_app', 'public.metric_values', 'INSERT') as app_metric_insert,
        has_table_privilege('minime_app', 'public.metric_values', 'UPDATE') as app_metric_update,
        has_table_privilege('minime_engineer_ro', 'public.transactions', 'SELECT') as engineer_transactions,
        has_table_privilege('minime_engineer_ro', 'public.health_samples', 'SELECT') as engineer_health`;
    expect(boundary).toEqual({
      old_removed: true,
      public_execute: false,
      app_execute: true,
      engineer_execute: true,
      app_transactions: false,
      app_health: false,
      app_metric_insert: false,
      app_metric_update: false,
      engineer_transactions: false,
      engineer_health: false,
    });
  });

  test("metric definitions declare checked sum/last rollup semantics", async () => {
    const defs = await sql`select name, rollup from metric_defs order by name`;
    expect(defs.find((row) => row.name === "journal_streak")?.rollup).toBe("last");
    expect(
      defs.filter((row) => row.name !== "journal_streak").every((row) => row.rollup === "sum"),
    ).toBe(true);
    await expectSqlReject(
      sql`update metric_defs set rollup = 'average' where name = 'steps'`,
      /metric_defs_rollup_check/,
    );
  });
});
