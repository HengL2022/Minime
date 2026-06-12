// Access-frequency ranking nudge (DECISIONS.md 2026-06-12): accessCounts reads drill-in
// frequency off the append-only audit log, and hybridSearch applies it as a narrow-band
// post-fusion multiplier. Only minime_get_context returns count — search returns must not,
// or results would boost their own rank.

import { beforeAll, describe, expect, test } from "bun:test";
import { accessCounts, logEvent, upsertPage } from "../src/db/repo";
import { hybridSearch } from "../src/search/hybrid";
import { indexParent } from "../src/search/index-parent";
import { resetDb, testSql as sql } from "./helpers";

const ACTOR = "agent:test";

async function drillInto(id: string, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await logEvent({
      actor: ACTOR,
      verb: "tool:minime_get_context",
      payload: { params_hash: "0".repeat(16), returned_ids: [id], returned_count: 1 },
    });
  }
}

beforeAll(async () => {
  await resetDb();
});

describe("accessCounts", () => {
  test("counts get_context returns per id inside the window", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await drillInto(a, 3);
    await drillInto(b, 1);
    const counts = await accessCounts([a, b, crypto.randomUUID()], 90);
    expect(counts.get(a)).toBe(3);
    expect(counts.get(b)).toBe(1);
    expect(counts.size).toBe(2); // never-drilled id is simply absent
  });

  test("only the primary returned id counts — dossier fan-out rows do not", async () => {
    const primary = crypto.randomUUID();
    const related = crypto.randomUUID();
    await logEvent({
      actor: ACTOR,
      verb: "tool:minime_get_context",
      payload: { returned_ids: [primary, related], returned_count: 2 },
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

  test("events outside the window are excluded", async () => {
    const id = crypto.randomUUID();
    // raw insert (test scaffolding) so the event can sit beyond the 90-day window
    await sql`insert into events (at, actor, verb, payload)
              values (now() - interval '120 days', ${ACTOR}, 'tool:minime_get_context',
                      ${sql.json({ returned_ids: [id] })})`;
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
