// Stale detection (W1-7): staleItems' untouched-AND-referenced conjunction, and the
// suppression window that keeps a dismissed stale item quiet instead of re-flagging it the
// very next night (review-triage.md: "dismissed means dismissed"). Reference signals mirror
// accessCounts' released-drill-in join shape (repo.ts) and edges.created_at
// (003_graph_audit.sql) — ids only, read off the append-only audit log (I8).

import { beforeEach, describe, expect, test } from "bun:test";
import {
  insertReviewItem,
  resolveReviewItem,
  staleItems,
  staleRecentlyFlagged,
} from "../src/db/repo";
import { eventAuditSink } from "../src/mcp/audit";
import { staleScan } from "../src/pipeline/dream";
import { resetDb, testSql as sql } from "./helpers";

const ACTOR = "agent:test";

beforeEach(async () => {
  await resetDb();
});

// A released minime_get_context drill-in naming `id` as the primary result — the same shape
// accessCounts (repo.ts) reads, created "now" so it always lands inside a 7-day window.
async function drillInto(id: string): Promise<void> {
  const result = await eventAuditSink.result(ACTOR, "minime_get_context", "0".repeat(16), {
    returnedIds: [id],
    returnedCount: 1,
    delivery: "transport",
  });
  await eventAuditSink.disposition(ACTOR, "minime_get_context", result.eventId, {
    status: "released",
  });
}

async function insertPage(path: string, daysOld: number): Promise<string> {
  const [row] = await sql`
    insert into pages (path, title, body_md, content_hash, tier, source, updated_at)
    values (${path}, 'Stale fixture', 'stale fixture body', ${path}, 1, 'test:stale',
            now() - make_interval(days => ${daysOld}))
    returning id::text as id`;
  return row!.id;
}

async function insertPerson(name: string, daysOld: number, tier = 1): Promise<string> {
  const [row] = await sql`
    insert into people (canonical_name, tier, source, created_by, updated_at)
    values (${name}, ${tier}, 'test:stale', 'test:stale', now() - make_interval(days => ${daysOld}))
    returning id::text as id`;
  return row!.id;
}

// Parent-anchored 'mentions' edge shape (src = the mentioning row, dst = the entity mentioned),
// matching the extractor's production shape documented near noteCandidates in repo.ts.
async function freshMentionEdge(dstType: string, dstId: string): Promise<void> {
  await sql`
    insert into edges (src_type, src_id, rel, dst_type, dst_id, extracted_by)
    values ('page', ${crypto.randomUUID()}, 'mentions', ${dstType}, ${dstId}, 'system:extract')`;
}

function ids(items: any[]): string[] {
  return items.map((i) => i.id);
}

describe("staleItems: untouched-AND-referenced conjunction", () => {
  test("(a) old page + a released get_context drill-in within 7d is flagged", async () => {
    const id = await insertPage("stale/a.md", 200);
    await drillInto(id);
    const items = await staleItems(7, 180);
    expect(ids(items)).toContain(id);
    expect(items.find((i) => i.id === id)?.type).toBe("page");
  });

  test("(b) same old page with no reference is NOT flagged", async () => {
    const id = await insertPage("stale/b.md", 200);
    const items = await staleItems(7, 180);
    expect(ids(items)).not.toContain(id);
  });

  test("(c) fresh page referenced is NOT flagged (untouched predicate fails)", async () => {
    const id = await insertPage("stale/c.md", 0);
    await drillInto(id);
    const items = await staleItems(7, 180);
    expect(ids(items)).not.toContain(id);
  });

  test("(d) old person with a fresh mentions edge is flagged", async () => {
    const id = await insertPerson("Stale Person D", 200);
    await freshMentionEdge("person", id);
    const items = await staleItems(7, 180);
    expect(ids(items)).toContain(id);
    expect(items.find((i) => i.id === id)?.type).toBe("person");
  });

  test("(f) tier predicate unchanged: a tier-0 old+referenced page is never returned", async () => {
    const [row] = await sql`
      insert into pages (path, title, body_md, content_hash, tier, source, updated_at)
      values ('stale/f-page.md', 'Tier0 fixture', 'body', 'stale-f-page', 0, 'test:stale',
              now() - interval '200 days')
      returning id::text as id`;
    const pageId = row!.id;
    await drillInto(pageId);

    const personId = await insertPerson("Tier0 Person F", 200, 0);
    await freshMentionEdge("person", personId);

    const items = await staleItems(7, 180);
    expect(ids(items)).not.toContain(pageId);
    expect(ids(items)).not.toContain(personId);
  });
});

describe("staleScan (dream step 4): re-flag suppression", () => {
  test("(e) a dismissed stale item is not re-flagged on the next run", async () => {
    const id = await insertPage("stale/e.md", 200);
    await drillInto(id);

    expect(await staleScan()).toBe(1);
    const opened = await sql`
      select id::text as id, status from review_queue
      where kind = 'stale' and payload ->> 'id' = ${id}`;
    expect(opened).toHaveLength(1);
    expect(opened[0]!.status).toBe("open");

    await resolveReviewItem(opened[0]!.id, "dismissed");

    // Second run: the item is still stale by every predicate, but the dismissal must hold.
    expect(await staleScan()).toBe(0);
    const rows = await sql`
      select status from review_queue where kind = 'stale' and payload ->> 'id' = ${id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("dismissed");
  });
});

// Direct unit coverage of the suppression window itself (repo.ts). staleScan's dismiss/re-run
// test above only proves suppression holds immediately after a dismissal; these characterize
// the bounded window that makes it "quiet for now", not "quiet forever".
describe("staleRecentlyFlagged: suppression window boundary", () => {
  test("no stale item for this id at all returns false", async () => {
    expect(await staleRecentlyFlagged(crypto.randomUUID())).toBe(false);
  });

  test("an open item outside the window still suppresses (never duplicate an open flag)", async () => {
    const id = crypto.randomUUID();
    await sql`
      insert into review_queue (kind, payload, status, created_at)
      values ('stale', ${sql.json({ id })}, 'open', now() - interval '365 days')`;
    expect(await staleRecentlyFlagged(id)).toBe(true);
  });

  test("a dismissed item created inside the 90-day window suppresses", async () => {
    const id = crypto.randomUUID();
    await sql`
      insert into review_queue (kind, payload, status, created_at)
      values ('stale', ${sql.json({ id })}, 'dismissed', now() - interval '89 days')`;
    expect(await staleRecentlyFlagged(id)).toBe(true);
  });

  test("a dismissed item created beyond the 90-day window no longer suppresses", async () => {
    const id = crypto.randomUUID();
    await sql`
      insert into review_queue (kind, payload, status, created_at)
      values ('stale', ${sql.json({ id })}, 'dismissed', now() - interval '91 days')`;
    expect(await staleRecentlyFlagged(id)).toBe(false);
  });

  test("uses insertReviewItem's own payload shape ({id, type, label})", async () => {
    const id = crypto.randomUUID();
    await insertReviewItem("stale", { id, type: "page", label: "Direct insert fixture" });
    expect(await staleRecentlyFlagged(id)).toBe(true);
  });
});
