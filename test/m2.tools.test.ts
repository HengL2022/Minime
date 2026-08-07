// M2 acceptance: a scripted MCP client exercises every tool over a real MCP transport;
// every call writes an events row; redaction works; envelope shape is honored.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { withAdminDbTransaction } from "../src/db/client";
import { approveTier2UnlockRequest } from "../src/db/repo";
import { buildServer } from "../src/mcp/server";
import { ALL_TOOLS } from "../src/mcp/tools";
import { config } from "../src/util/config";
import { resetAndSeed, testSql as sql } from "./helpers";

let client: Client;

beforeAll(async () => {
  await resetAndSeed();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  await server.connect(serverTransport);
  client = new Client({ name: "test-harness", version: "1.0.0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close().catch(() => {});
});

async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<{ raw: string; parsed: any; isError: boolean }> {
  const res: any = await client.callTool({ name, arguments: args });
  const raw = res.content?.[0]?.text ?? "";
  return { raw, parsed: JSON.parse(raw), isError: Boolean(res.isError) };
}

async function toolEventsAfter(marker: string, expected: number): Promise<any[]> {
  const deadline = Date.now() + 500;
  let events: any[] = [];
  do {
    events = await sql`
      select id::text as id, actor, verb, payload
      from events
      where id > ${marker}::bigint and verb like 'tool:%'
      order by id asc`;
    if (events.length >= expected) return events;
    await Bun.sleep(5);
  } while (Date.now() < deadline);
  return events;
}

describe("MCP server", () => {
  test("exposes all tools", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS.map((t) => t.name).sort());
  });

  test("every tool call produces an events row with the client actor", async () => {
    const [marker] = await sql`select coalesce(max(id), 0)::bigint as id from events`;
    const state = await call("minime_state", {});
    await toolEventsAfter(marker!.id, 3);
    const search = await call("minime_search", { query: "climbing" });
    expect(state.isError).toBe(false);
    expect(state.parsed.data).toHaveProperty("calendar");
    expect(search.isError).toBe(false);
    expect(Array.isArray(search.parsed.data.hits)).toBe(true);
    const events = await toolEventsAfter(marker!.id, 6);
    expect(events).toHaveLength(6);
    expect(events.map((event) => [event.verb, event.actor])).toEqual([
      ["tool:minime_state:attempt", "agent:test-harness"],
      ["tool:minime_state", "agent:test-harness"],
      ["tool:minime_state:disposition", "agent:test-harness"],
      ["tool:minime_search:attempt", "agent:test-harness"],
      ["tool:minime_search", "agent:test-harness"],
      ["tool:minime_search:disposition", "agent:test-harness"],
    ]);
    expect(Object.keys(events[0]!.payload).sort()).toEqual(["params_hash"]);
    expect(Object.keys(events[3]!.payload).sort()).toEqual(["params_hash"]);
    expect(events[1]!.payload.params_hash).toBeString();
    expect(Array.isArray(events[1]!.payload.returned_ids)).toBe(true);
    expect(events[1]!.payload.returned_count).toBeNumber();
    expect(events[1]!.payload.delivery).toBe("transport");
    expect(events[4]!.payload.params_hash).toBeString();
    expect(Array.isArray(events[4]!.payload.returned_ids)).toBe(true);
    expect(events[4]!.payload.returned_count).toBeNumber();
    expect(events[4]!.payload.delivery).toBe("transport");
    for (const [resultIndex, dispositionIndex] of [
      [1, 2],
      [4, 5],
    ] as const) {
      const result = events[resultIndex]!;
      const disposition = events[dispositionIndex]!;
      expect(result.id).toMatch(/^\d+$/);
      expect(disposition.payload).toEqual({
        result_event_id: result.id,
        status: "released",
      });
      expect(disposition.payload.returned_ids).toBeUndefined();
      expect(disposition.payload.returned_count).toBeUndefined();
    }
  });

  test("minime_search returns envelope with hits + sources", async () => {
    const { parsed } = await call("minime_search", { query: "sourdough starter feeding" });
    expect(parsed.data.hits.length).toBeGreaterThan(0);
    expect(parsed.data.hits[0].title).toContain("Sourdough");
    expect(parsed.sources.length).toBeGreaterThan(0);
    expect(parsed.sources[0]).toHaveProperty("id");
    expect(parsed.sources[0]).toHaveProperty("updated_at");
  });

  test("get_context transport audit covers every visible related row", async () => {
    const personName = "Context Audit Person";
    const [person] = await sql`
      insert into people (canonical_name, tier, created_by, source)
      values (${personName}, 1, 'fixture', 'test')
      returning id`;
    const [org] = await sql`
      insert into orgs (canonical_name, kind, tier, created_by, source)
      values ('Context Audit Org', 'company', 1, 'fixture', 'test')
      returning id`;
    const [edge] = await sql`
      insert into edges
        (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
      values
        ('person', ${person!.id}, 'works_at', 'org', ${org!.id},
         'people', ${person!.id}, 'system:test')
      returning id`;
    const [task] = await sql`
      insert into tasks (title, status, due, tier, created_by, source)
      values (${`Follow up with ${personName}`}, 'active', '2026-12-20', 1, 'fixture', 'test')
      returning id`;
    const [commitment] = await sql`
      insert into commitments (what, to_whom, status, due, tier, created_by, source)
      values ('Send context audit notes', ${personName}, 'open', '2026-12-21', 1, 'fixture', 'test')
      returning id`;
    const [marker] = await sql`select coalesce(max(id), 0)::bigint as id from events`;

    const { parsed, isError } = await call("minime_get_context", { person_name: personName });
    expect(isError).toBe(false);
    expect(parsed.sources[0]).toMatchObject({ type: "person", id: person!.id });
    expect(parsed.sources.map((source: any) => source.id)).toEqual(
      expect.arrayContaining([edge!.id, task!.id, commitment!.id]),
    );
    expect(parsed.data.related).toContainEqual(
      expect.objectContaining({
        id: edge!.id,
        source_table: "people",
        source_id: person!.id,
      }),
    );

    const events = await toolEventsAfter(marker!.id, 3);
    const resultEvent = events.find((event) => event.verb === "tool:minime_get_context");
    expect(resultEvent).toBeDefined();
    expect(resultEvent!.payload.returned_ids).toEqual(
      parsed.sources.map((source: any) => source.id),
    );
    expect(resultEvent!.payload.returned_count).toBe(parsed.sources.length);
  });

  test("MCP tier-0 content is denied at the transport boundary", async () => {
    const [page] = await sql`
      insert into pages (path, title, body_md, content_hash, tier, created_by, source)
      values ('transport/tier-zero.md', 'transport tier zero', 'MCP-TIER0-SENTINEL', 'transport-tier-zero', 0,
              'fixture', 'test') returning id`;
    await sql`
      insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('page', ${page!.id}, 0, 'MCP-TIER0-SENTINEL', 0)`;

    const search = await call("minime_search", { query: "MCP-TIER0-SENTINEL" });
    expect(search.raw).not.toContain("MCP-TIER0-SENTINEL");
    const context = await call("minime_get_context", { type: "page", id: page!.id });
    expect(context.isError).toBe(true);
    expect(context.parsed.error.code).toBe("NOT_FOUND");
  });

  test("MCP locked tier-2 content is omitted until the actor unlocks it", async () => {
    const [journal] = await sql`
      insert into journal_entries (entry_md, tier, created_by, source)
      values ('MCP-TIER2-SENTINEL', 2, 'fixture', 'test') returning id`;
    await sql`
      insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('journal', ${journal!.id}, 0, 'MCP-TIER2-SENTINEL', 2)`;

    const locked = await call("minime_search", { query: "MCP-TIER2-SENTINEL" });
    expect(locked.raw).not.toContain("MCP-TIER2-SENTINEL");
    const unlock = await call("minime_unlock", { minutes: 5 });
    expect(unlock.isError).toBe(false);
    expect(unlock.parsed.data.status).toBe("pending");
    await withAdminDbTransaction(() => approveTier2UnlockRequest(unlock.parsed.data.request_id));
    const unlocked = await call("minime_search", { query: "MCP-TIER2-SENTINEL" });
    expect(unlocked.raw).toContain("MCP-TIER2-SENTINEL");
  });

  test("minime_state snapshot has all sections", async () => {
    const { parsed } = await call("minime_state", {});
    for (const k of [
      "calendar",
      "tasks_due",
      "commitments_open",
      "decision_reviews_due",
      "review_queue_open",
      "metric_anomalies",
    ]) {
      expect(parsed.data).toHaveProperty(k);
    }
    expect(parsed.data.calendar.length).toBeGreaterThan(0); // seeded upcoming events
    expect(parsed.data.decision_reviews_due.length).toBeGreaterThan(0); // open decision seeded
  });

  test("minime_list_metrics lists the full catalog and never exposes agg_sql", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("minime_list_metrics");

    const { raw, parsed, isError } = await call("minime_list_metrics", {});
    expect(isError).toBe(false);
    expect(parsed.data.metrics).toHaveLength(10); // 6 from 006 + mood/energy/body_mass/hr_resting from 027
    expect(parsed.data.metrics.map((m: any) => m.name).sort()).toEqual(
      [
        "body_mass",
        "deep_work_minutes",
        "energy",
        "hr_resting",
        "journal_streak",
        "mood",
        "sleep_minutes",
        "spend_by_category",
        "spend_total",
        "steps",
      ].sort(),
    );
    for (const m of parsed.data.metrics) {
      expect(Object.keys(m).sort()).toEqual(["description", "name", "rollup", "unit"]);
    }
    expect(parsed.sources).toHaveLength(10);
    expect(raw).not.toContain("agg_sql");
    expect(raw).not.toContain("select ");
  });

  test("minime_query_metric returns a series; unknown metric refuses with structured error", async () => {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const { parsed } = await call("minime_query_metric", { name: "steps", from, to });
    expect(parsed.data.series.length).toBeGreaterThan(20);
    expect(parsed.data.unit).toBe("steps");

    const bad = await call("minime_query_metric", { name: "no_such_metric", from, to });
    expect(bad.isError).toBe(true);
    expect(bad.parsed.error.code).toBe("UNKNOWN_METRIC");
    expect(bad.parsed.error.message).toContain("minime_list_metrics");
  });

  test("metric days honor caller timezone and rollups use declared sum/last semantics", async () => {
    await sql`
      insert into health_samples (kind, at, value, unit, source, created_by, tier)
      values
        ('steps', '2026-01-01T16:30:00Z', 321, 'steps', 'test:metric-tz', 'fixture', 0),
        ('steps', '2026-01-05T12:00:00Z', 10, 'steps', 'test:metric-rollup', 'fixture', 0),
        ('steps', '2026-01-06T12:00:00Z', 20, 'steps', 'test:metric-rollup', 'fixture', 0)`;

    const singapore = await call("minime_query_metric", {
      name: "steps",
      from: "2026-01-02",
      to: "2026-01-02",
      time_zone: "Asia/Singapore",
    });
    expect(singapore.parsed.data.series).toEqual([{ period_start: "2026-01-02", value: 321 }]);
    const utc = await call("minime_query_metric", {
      name: "steps",
      from: "2026-01-01",
      to: "2026-01-01",
      time_zone: "UTC",
    });
    expect(utc.parsed.data.series).toEqual([{ period_start: "2026-01-01", value: 321 }]);

    for (const granularity of ["week", "month"] as const) {
      const additive = await call("minime_query_metric", {
        name: "steps",
        from: "2026-01-05",
        to: "2026-01-06",
        granularity,
        time_zone: "UTC",
      });
      expect(additive.parsed.data.series).toEqual([
        { period_start: granularity === "week" ? "2026-01-05" : "2026-01-01", value: 30 },
      ]);
    }

    await sql`
      insert into journal_entries (at, entry_md, source, created_by, tier)
      values
        ('2025-12-31T12:00:00Z', 'Fictional streak day one.', 'test:metric-streak', 'fixture', 2),
        ('2026-01-01T12:00:00Z', 'Fictional streak day two.', 'test:metric-streak', 'fixture', 2),
        ('2026-01-02T12:00:00Z', 'Fictional streak day three.', 'test:metric-streak', 'fixture', 2),
        ('2026-01-03T12:00:00Z', 'Fictional streak day four.', 'test:metric-streak', 'fixture', 2)`;
    const streakDays = await call("minime_query_metric", {
      name: "journal_streak",
      from: "2026-01-02",
      to: "2026-01-03",
      time_zone: "UTC",
    });
    expect(streakDays.parsed.data.series).toEqual([
      { period_start: "2026-01-02", value: 3 },
      { period_start: "2026-01-03", value: 4 },
    ]);
    for (const granularity of ["week", "month"] as const) {
      const streakRollup = await call("minime_query_metric", {
        name: "journal_streak",
        from: "2026-01-02",
        to: "2026-01-03",
        granularity,
        time_zone: "UTC",
      });
      expect(streakRollup.parsed.data.series).toEqual([
        { period_start: granularity === "week" ? "2025-12-29" : "2026-01-01", value: 4 },
      ]);
    }

    const [callerZoneCache] =
      await sql`select count(*)::int as n from metric_values where source = 'query'`;
    expect(callerZoneCache!.n).toBe(0);
  });

  test("minime_capture returns an opaque receipt and writes a private inbox file + row", async () => {
    const { raw, parsed } = await call("minime_capture", {
      text: "todo: test the capture path by 2026-12-01",
    });
    expect(parsed.data.inbox_item_id).toBeString();
    expect(Object.keys(parsed.data)).toEqual(["inbox_item_id"]);
    expect(raw).not.toContain(config.dataDir);
    const [row] = await sql`
      select status, created_by, raw_path, content_hash
      from inbox_items where id = ${parsed.data.inbox_item_id}`;
    expect(row!.status).toBe("pending");
    expect(row!.created_by).toBe("agent:test-harness");
    expect(await Bun.file(row!.raw_path).exists()).toBe(true);
    expect(row!.content_hash).toBe(
      new Bun.CryptoHasher("sha256")
        .update(await Bun.file(row!.raw_path).arrayBuffer())
        .digest("hex"),
    );
    expect((await stat(config.dataDir)).mode & 0o777).toBe(0o700);
    expect((await stat(dirname(row!.raw_path))).mode & 0o777).toBe(0o700);
    expect((await stat(row!.raw_path)).mode & 0o777).toBe(0o600);

    const seededPage = join(config.dataDir, "brain", "travel", "tokyo-trip-plan.md");
    expect((await stat(dirname(seededPage))).mode & 0o777).toBe(0o700);
    expect((await stat(seededPage)).mode & 0o777).toBe(0o600);
  });

  test("minime_journal / minime_upsert_task / minime_log_interaction write rows stamped agent:<client>", async () => {
    const j = await call("minime_journal", {
      entry_md: "Test entry about the build going well.",
      mood: 4,
    });
    const [jr] =
      await sql`select created_by, tier from journal_entries where id = ${j.parsed.data.journal_entry_id}`;
    expect(jr!.created_by).toBe("agent:test-harness");
    expect(jr!.tier).toBe(2);

    const t = await call("minime_upsert_task", { title: "Harness task", due: "2026-12-31" });
    const t2 = await call("minime_upsert_task", {
      id: t.parsed.data.task_id,
      title: "Harness task",
      status: "done",
    });
    const [tr] =
      await sql`select status, completed_at from tasks where id = ${t2.parsed.data.task_id}`;
    expect(tr!.status).toBe("done");
    expect(tr!.completed_at).not.toBeNull();

    const i = await call("minime_log_interaction", {
      person_name: "Sammy",
      kind: "message",
      summary: "Harness ping",
    });
    const [sam] = await sql`
      select p.id from people p join person_aliases a on a.person_id = p.id
      where lower(a.alias) = 'sammy'`;
    expect(Object.keys(i.parsed.data)).toEqual(["interaction_id"]);
    expect(i.parsed.sources).toEqual([{ type: "interaction", id: i.parsed.data.interaction_id }]);
    const [interaction] = await sql`
      select person_id from interactions where id = ${i.parsed.data.interaction_id}`;
    expect(interaction!.person_id).toBe(sam!.id); // alias resolved to Sam Chen
    const [p] = await sql`select last_contact_at from people where id = ${interaction!.person_id}`;
    expect(p!.last_contact_at).not.toBeNull();
  });

  test("minime_upsert_task keeps unexpected database errors off the wire", async () => {
    const sentinel = "PRIVATE-TASK-TITLE-SENTINEL";
    const result = await call("minime_upsert_task", {
      title: sentinel,
      goal_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(result.isError).toBe(true);
    expect(result.parsed).toEqual({
      error: { code: "INTERNAL", message: "Internal tool error." },
    });
    expect(result.raw).not.toContain(sentinel);
  });

  test("minime_log_interaction with subject_type='org' attaches to an org, not a phantom person", async () => {
    const before =
      await sql`select count(*)::int n from people where lower(canonical_name) = 'fjordsonics'`;
    const r = await call("minime_log_interaction", {
      person_name: "Fjordsonics",
      kind: "email",
      summary: "Quote request for a sensor order.",
      subject_type: "org",
    });
    // The receipt is subject-invariant, and NO phantom person was minted.
    expect(Object.keys(r.parsed.data)).toEqual(["interaction_id"]);
    expect(r.parsed.sources).toEqual([{ type: "interaction", id: r.parsed.data.interaction_id }]);
    const after =
      await sql`select count(*)::int n from people where lower(canonical_name) = 'fjordsonics'`;
    expect(after[0]!.n).toBe(before[0]!.n); // no phantom person created
    // interaction row is org-keyed and satisfies the XOR
    const [row] =
      await sql`select person_id, org_id from interactions where id = ${r.parsed.data.interaction_id}`;
    expect(row!.person_id).toBeNull();
    expect(row!.org_id).not.toBeNull();
    // 'auto' mode now resolves the existing org rather than minting a person
    const r2 = await call("minime_log_interaction", {
      person_name: "Fjordsonics",
      kind: "call",
      summary: "Follow-up on lead time.",
    });
    expect(Object.keys(r2.parsed.data)).toEqual(["interaction_id"]);
    expect(r2.parsed.sources).toEqual([{ type: "interaction", id: r2.parsed.data.interaction_id }]);
    const [row2] = await sql`
      select person_id, org_id from interactions where id = ${r2.parsed.data.interaction_id}`;
    expect(row2!.person_id).toBeNull();
    expect(row2!.org_id).toBe(row!.org_id);
  });

  test("minime_log_decision + minime_review_decision close the loop", async () => {
    const d = await call("minime_log_decision", {
      question: "Harness: ship the test suite now?",
      options: ["ship", "wait"],
      choice: "ship",
      review_in_days: 30,
    });
    const r = await call("minime_review_decision", {
      decision_id: d.parsed.data.decision_id,
      actual_outcome: "Shipped fine",
      lesson: "Always write the harness test first",
    });
    expect(r.parsed.data.principle_id).toBeString();
    const edgeRows = await sql`
      select rel, source, created_by, derived_from, source_id
      from edges
      where (src_type = 'decision' and src_id = ${d.parsed.data.decision_id})
         or (src_type = 'principle' and src_id = ${r.parsed.data.principle_id})
      order by rel, id`;
    expect(edgeRows.length).toBeGreaterThan(0);
    for (const edge of edgeRows) {
      expect(edge.created_by).toBe("agent:test-harness");
      expect(edge.derived_from).toBe(edge.source_id);
      expect(edge.source).toBe(edge.rel === "learned_from" ? "review" : "capture");
    }
  });

  test("redaction: card numbers, IBANs, long account numbers never leave the server", async () => {
    await call("minime_upsert_task", {
      title:
        "Call bank about card 4111 1111 1111 1111 and IBAN DE89370400440532013000 re account 123456789012",
    });
    const { raw } = await call("minime_search", { query: "call bank about card" });
    expect(raw).not.toContain("4111 1111 1111 1111");
    expect(raw).not.toContain("DE89370400440532013000");
    expect(raw).not.toContain("123456789012");
    expect(raw).toContain("[REDACTED:card]");
    expect(raw).toContain("[REDACTED:iban]");
  });

  test("structured refusal for bad input", async () => {
    const res = await call("minime_get_context", {});
    expect(res.isError).toBe(true);
    expect(res.parsed.error.code).toBe("BAD_INPUT");
  });

  test("MCP responses render timestamps in the caller timezone", async () => {
    const res = await call("minime_search", {
      query: "sourdough starter feeding",
      time_zone: "America/Los_Angeles",
    });
    expect(res.parsed.sources[0].updated_at).toMatch(/-0[78]:00$/);
  });
});
