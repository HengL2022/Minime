// M2 acceptance: a scripted MCP client exercises every tool over a real MCP transport;
// every call writes an events row; redaction works; envelope shape is honored.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp/server";
import { ALL_TOOLS } from "../src/mcp/tools";
import { setNow } from "../src/util/clock";
import { countEvents, resetAndSeed, testSql as sql } from "./helpers";

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

describe("MCP server", () => {
  test("exposes all tools", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS.map((t) => t.name).sort());
  });

  test("every tool call produces an events row with the client actor", async () => {
    const before = await countEvents("tool:%");
    await call("minime_state", {});
    await call("minime_search", { query: "climbing" });
    const after = await countEvents("tool:%");
    expect(after - before).toBe(2);
    const [latest] =
      await sql`select actor, payload from events where verb = 'tool:minime_search' order by at desc limit 1`;
    expect(latest!.actor).toBe("agent:test-harness");
    expect(latest!.payload.params_hash).toBeString();
    expect(Array.isArray(latest!.payload.returned_ids)).toBe(true);
  });

  test("minime_search returns envelope with hits + sources", async () => {
    const { parsed } = await call("minime_search", { query: "sourdough starter feeding" });
    expect(parsed.data.hits.length).toBeGreaterThan(0);
    expect(parsed.data.hits[0].title).toContain("Sourdough");
    expect(parsed.sources.length).toBeGreaterThan(0);
    expect(parsed.sources[0]).toHaveProperty("id");
    expect(parsed.sources[0]).toHaveProperty("updated_at");
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

  test("minime_query_metric returns a series; unknown metric refuses with structured error", async () => {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const { parsed } = await call("minime_query_metric", { name: "steps", from, to });
    expect(parsed.data.series.length).toBeGreaterThan(20);
    expect(parsed.data.unit).toBe("steps");

    const bad = await call("minime_query_metric", { name: "no_such_metric", from, to });
    expect(bad.isError).toBe(true);
    expect(bad.parsed.error.code).toBe("UNKNOWN_METRIC");
  });

  test("minime_capture writes an inbox file + row", async () => {
    const { parsed } = await call("minime_capture", {
      text: "todo: test the capture path by 2026-12-01",
    });
    expect(parsed.data.inbox_item_id).toBeString();
    const [row] =
      await sql`select status, created_by from inbox_items where id = ${parsed.data.inbox_item_id}`;
    expect(row!.status).toBe("pending");
    expect(row!.created_by).toBe("agent:test-harness");
    expect(await Bun.file(parsed.data.path).exists()).toBe(true);
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
    expect(i.parsed.data.person_created).toBe(false); // alias resolved to Sam Chen
    const [p] = await sql`select last_contact_at from people where id = ${i.parsed.data.person_id}`;
    expect(p!.last_contact_at).not.toBeNull();
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
  });

  test("redaction: card numbers, IBANs, long account numbers never leave the server", async () => {
    await call("minime_upsert_task", {
      title:
        "Call bank about card 4111 1111 1111 1111 and IBAN DE89370400440532013000 re account 123456789012",
    });
    const { raw } = await call("minime_search", { query: "call bank about card" });
    expect(raw).not.toContain("4111");
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
    setNow(new Date("2026-06-17T01:00:00.000Z"));
    try {
      const res = await call("minime_unlock", {
        minutes: 5,
        time_zone: "America/Los_Angeles",
      });
      expect(res.parsed.data.expires_at).toBe("2026-06-16T18:05:00.000-07:00");
    } finally {
      setNow(null);
    }
  });
});
