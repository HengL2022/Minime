// Access-frequency ranking nudge (DECISIONS.md 2026-06-12): accessCounts reads drill-in
// frequency off the append-only audit log, and hybridSearch applies it as a narrow-band
// post-fusion multiplier. Only minime_get_context returns count — search returns must not,
// or results would boost their own rank.

import { beforeAll, describe, expect, test } from "bun:test";
import { accessCounts, logEvent, upsertPage } from "../src/db/repo";
import { eventAuditSink } from "../src/mcp/audit";
import { hybridSearch } from "../src/search/hybrid";
import { indexParent } from "../src/search/index-parent";
import { resetDb, testSql as sql } from "./helpers";
import { activeTestDatabaseName } from "./setup";

const ACTOR = "agent:test";

async function drillInto(id: string, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    const result = await eventAuditSink.result(ACTOR, "minime_get_context", "0".repeat(16), {
      returnedIds: [id],
      returnedCount: 1,
      delivery: "transport",
    });
    await eventAuditSink.disposition(ACTOR, "minime_get_context", result.eventId, {
      status: "released",
    });
  }
}

beforeAll(async () => {
  const [current] = await sql`select current_database() as name`;
  expect(current!.name).toMatch(/^minime_test_[a-z0-9_]+$/);
  expect(current!.name).not.toBe("minime_test");
  expect(current!.name).toBe(activeTestDatabaseName());
  await resetDb();
});

describe("accessCounts", () => {
  test("historical exact results lacking delivery do not count", async () => {
    const id = crypto.randomUUID();
    await logEvent({
      actor: ACTOR,
      verb: "tool:minime_get_context",
      payload: { returned_ids: [id], returned_count: 1 },
    });
    expect((await accessCounts([id], 90)).size).toBe(0);
  });

  test("direct exact results do not count as transport access", async () => {
    const id = crypto.randomUUID();
    await logEvent({
      actor: ACTOR,
      verb: "tool:minime_get_context",
      payload: { delivery: "direct", returned_ids: [id], returned_count: 1 },
    });
    expect((await accessCounts([id], 90)).size).toBe(0);
  });

  test("transport results without a disposition do not count", async () => {
    const id = crypto.randomUUID();
    await logEvent({
      actor: ACTOR,
      verb: "tool:minime_get_context",
      payload: { delivery: "transport", returned_ids: [id], returned_count: 1 },
    });
    expect((await accessCounts([id], 90)).size).toBe(0);
  });

  test("only the primary returned id of a released result counts", async () => {
    const primary = crypto.randomUUID();
    const related = crypto.randomUUID();
    const result = await eventAuditSink.result(ACTOR, "minime_get_context", "1".repeat(16), {
      returnedIds: [primary, related],
      returnedCount: 2,
      delivery: "transport",
    });
    await eventAuditSink.disposition(ACTOR, "minime_get_context", result.eventId, {
      status: "released",
    });
    const counts = await accessCounts([primary, related], 90);
    expect(counts.get(primary)).toBe(1);
    expect(counts.has(related)).toBe(false);
  });

  test("ignores other verbs — search returns must not feed back into ranking", async () => {
    const id = crypto.randomUUID();
    await logEvent({
      actor: ACTOR,
      verb: "tool:minime_search",
      payload: { returned_ids: [id], returned_count: 1 },
    });
    expect((await accessCounts([id], 90)).size).toBe(0);
  });

  test("attempt and disposition verbs never contribute their own IDs", async () => {
    const attemptId = crypto.randomUUID();
    const dispositionId = crypto.randomUUID();
    await logEvent({
      actor: ACTOR,
      verb: "tool:minime_get_context:attempt",
      payload: { returned_ids: [attemptId], returned_count: 1 },
    });
    await logEvent({
      actor: ACTOR,
      verb: "tool:minime_get_context:disposition",
      payload: { result_event_id: dispositionId, returned_ids: [dispositionId], returned_count: 1 },
    });
    const counts = await accessCounts([attemptId, dispositionId], 90);
    expect(counts.size).toBe(0);
  });

  test("suppressed and send-uncertain transport results do not count", async () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [id, status] of ids.map(
      (id, index) => [id, index === 0 ? "suppressed" : "send_uncertain"] as const,
    )) {
      const result = await eventAuditSink.result(ACTOR, "minime_get_context", "2".repeat(16), {
        returnedIds: [id],
        returnedCount: 1,
        delivery: "transport",
      });
      await eventAuditSink.disposition(ACTOR, "minime_get_context", result.eventId, {
        status,
      });
    }
    expect((await accessCounts(ids, 90)).size).toBe(0);
  });

  test("released transport results count once and actor filters remain unchanged", async () => {
    const released = crypto.randomUUID();
    await drillInto(released, 1);
    await logEvent({
      actor: "agent:other",
      verb: "tool:minime_get_context",
      payload: { delivery: "transport", returned_ids: [released], returned_count: 1 },
    });
    const counts = await accessCounts([released], 90, ACTOR);
    expect(counts.get(released)).toBe(1);
    expect((await accessCounts([released], 90, "agent:other")).size).toBe(0);
  });

  test("events outside the window are excluded", async () => {
    const id = crypto.randomUUID();
    // raw insert (test scaffolding) so the event can sit beyond the 90-day window
    const [historical] = await sql`insert into events (at, actor, verb, payload)
              values (now() - interval '120 days', ${ACTOR}, 'tool:minime_get_context',
                      ${sql.json({ delivery: "transport", returned_ids: [id] })})
              returning id::text as id`;
    await eventAuditSink.disposition(ACTOR, "minime_get_context", historical!.id, {
      status: "released",
    });
    expect((await accessCounts([id], 90)).size).toBe(0);
    expect((await accessCounts([id], 365)).get(id)).toBe(1);
  });

  test("empty id list short-circuits", async () => {
    expect((await accessCounts([], 90)).size).toBe(0);
  });
});

describe("hybridSearch access boost", () => {
  test("repeated drill-ins lift an otherwise-tied parent past its twin", async () => {
    // identical body text → identical mock embedding, cosine and fts scores; only the
    // arbitrary per-arm rank order separates the twins, a gap well inside ACCESS_BAND.
    const body = "The tide gauge at Wreckers Cove logged a record spring tide on Tuesday.";
    const mk = async (path: string, title: string) => {
      const { id } = await upsertPage({
        path,
        title,
        bodyMd: body,
        contentHash: path,
        source: "test",
      });
      await indexParent("page", id, body, title, 1);
      return id;
    };
    const x = await mk("access/x.md", "Tide log X");
    const y = await mk("access/y.md", "Tide log Y");

    const before = await hybridSearch({ query: "tide gauge wreckers cove", limit: 5 });
    const ids = before.map((h) => h.id).filter((i) => i === x || i === y);
    expect(ids.length).toBe(2);
    const loser = ids[1]!;

    await drillInto(loser, 5); // saturates the boost (ACCESS_CAP)
    const after = await hybridSearch({ query: "tide gauge wreckers cove", limit: 5 });
    const afterIds = after.map((h) => h.id).filter((i) => i === x || i === y);
    expect(afterIds[0]).toBe(loser);
  });
});
