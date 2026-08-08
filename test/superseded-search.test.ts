// W2-5: search/read integrity for corrected content. A superseded row (a live successor exists
// — 028_correction_supersede.sql; minime_correct, W2-4) stays in hybridSearch results but is
// half-weighted (SUPERSEDED_PENALTY, hybrid.ts) and flagged `superseded: true` so its successor
// wins ties and agents cite the current version instead. A retracted row (superseded_at set, no
// successor) is excluded entirely — parentMeta (repo.ts) drops it, which hits hybridSearch's
// existing meta-miss filter. Both states stay readable by id via minime_get_context (I5: the
// owner/agent can always inspect a row), which surfaces them as gaps plus a provenance pointer.
//
// Uses supersedeRow/retractRow (repo.ts) directly as test fixtures rather than the full
// minime_correct tool — that tool's own amend/retract behavior is covered by
// test/correct-tool.test.ts; this file is scoped to the read/search side.

import { beforeAll, describe, expect, test } from "bun:test";
import { insertJournal, retractRow, supersedeRow, upsertPage } from "../src/db/repo";
import type { Envelope } from "../src/mcp/envelope";
import { toolByName } from "../src/mcp/tools";
import { type ToolResult, invokeTool } from "../src/mcp/tools/registry";
import { hybridSearch } from "../src/search/hybrid";
import { indexParent } from "../src/search/index-parent";
import { localDateStr } from "../src/util/clock";
import { resetDb, testSql } from "./helpers";
import { sessionToolCtx } from "./support/unlock";

beforeAll(async () => {
  await resetDb();
});

function expectOk(result: ToolResult): Envelope<Record<string, any>> {
  if (!result.ok)
    throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result.envelope as Envelope<Record<string, any>>;
}

describe("superseded rows: labeled and down-weighted in search", () => {
  test("a live successor outranks its superseded original for the same query, and the original's hit is flagged", async () => {
    const title = "Fictional narwhal migration field notes";
    const body =
      "# Fictional narwhal migration field notes\n\nFictional narwhals ZQXNARWHAL pass the fjord " +
      "every spring. Field notes on narwhal migration timing and pod size.";

    const original = await upsertPage({
      path: "test/superseded-search-original.md",
      title,
      bodyMd: body,
      contentHash: "superseded-search-original-h1",
      createdBy: "human",
      source: "manual",
    });
    await indexParent("page", original.id, body, title, 1);

    // Same title/body as the original (an amend that changes some other field) so the ONLY
    // structural difference feeding the ranker is the supersede penalty itself — recency, title
    // match, and cosine/fts strength are otherwise symmetric between the two rows.
    const successor = await upsertPage({
      path: "test/superseded-search-successor.md",
      title,
      bodyMd: body,
      contentHash: "superseded-search-successor-h1",
      createdBy: "human",
      source: "correction",
      derivedFrom: original.id,
      supersedesId: original.id,
    });
    await indexParent("page", successor.id, body, title, 1);
    await supersedeRow("page", original.id, successor.id);

    const hits = await hybridSearch({ query: "ZQXNARWHAL migration field notes", limit: 20 });
    const originalIdx = hits.findIndex((h) => h.id === original.id);
    const successorIdx = hits.findIndex((h) => h.id === successor.id);
    expect(originalIdx).toBeGreaterThanOrEqual(0);
    expect(successorIdx).toBeGreaterThanOrEqual(0);
    expect(successorIdx).toBeLessThan(originalIdx);

    const originalHit = hits[originalIdx]!;
    const successorHit = hits[successorIdx]!;
    expect(originalHit.score).toBeLessThan(successorHit.score);
    expect(originalHit.superseded).toBe(true);
    expect(originalHit.superseded_by).toBe(successor.id);
    expect(successorHit.superseded).toBe(false);
    expect(successorHit.superseded_by).toBeUndefined();
  });

  test("get_context on a superseded row includes the pointer gap and provenance.superseded_by", async () => {
    const ctx = sessionToolCtx("agent:superseded-search-context");
    const title = "Fictional superseded context original";
    const original = await upsertPage({
      path: "test/superseded-search-context-original.md",
      title,
      bodyMd: "Fictional original body for the context pointer-gap test.",
      contentHash: "superseded-search-context-original-h1",
      createdBy: "human",
      source: "manual",
    });
    const successor = await upsertPage({
      path: "test/superseded-search-context-successor.md",
      title,
      bodyMd: "Fictional corrected body for the context pointer-gap test.",
      contentHash: "superseded-search-context-successor-h1",
      createdBy: "human",
      source: "correction",
      derivedFrom: original.id,
      supersedesId: original.id,
    });
    await supersedeRow("page", original.id, successor.id);
    const [row] = await testSql`select superseded_at from pages where id = ${original.id}::uuid`;
    const on = localDateStr(new Date(row!.superseded_at));

    const envelope = expectOk(
      await invokeTool(toolByName("minime_get_context"), { type: "page", id: original.id }, ctx),
    );
    expect(envelope.data.row.id).toBe(original.id); // getRow stays unfiltered: readable by id
    expect(envelope.data.provenance.superseded_by).toBe(successor.id);
    expect(envelope.gaps).toContain(
      `this row was superseded on ${on} — read page ${successor.id} for the current version`,
    );
  });
});

describe("retracted rows: dropped from search, still readable by id", () => {
  test("a retracted journal entry is absent from hybridSearch but get_context returns it with the retracted gap", async () => {
    const ctx = sessionToolCtx("agent:superseded-search-retract");
    const entryMd =
      "Fictional retracted entry about the ZQXWOMBAT spreadsheet reconciliation mishap.";
    const { id } = await insertJournal({
      entryMd,
      mood: 3,
      tier: 1, // avoids the tier-2 unlock ceremony; irrelevant to what this test checks
      createdBy: "human",
      source: "test:superseded-search",
    });
    await indexParent("journal", id, entryMd, undefined, 1);

    const before = await hybridSearch({ query: "ZQXWOMBAT spreadsheet reconciliation", limit: 10 });
    expect(before.some((h) => h.id === id)).toBe(true);

    await retractRow("journal", id);
    const [row] = await testSql`select superseded_at from journal_entries where id = ${id}::uuid`;
    const on = localDateStr(new Date(row!.superseded_at));

    const after = await hybridSearch({ query: "ZQXWOMBAT spreadsheet reconciliation", limit: 10 });
    expect(after.some((h) => h.id === id)).toBe(false);

    const envelope = expectOk(
      await invokeTool(toolByName("minime_get_context"), { type: "journal", id }, ctx),
    );
    expect(envelope.data.row.id).toBe(id); // getRow stays unfiltered: still readable by id
    expect(envelope.data.row.entry_md).toBe(entryMd); // row itself never edited/deleted (I5)
    expect(envelope.data.provenance.superseded_by).toBeNull();
    expect(envelope.gaps).toContain(`this row was retracted on ${on}`);
  });

  test("a retracted row with a chunk somehow still present is still excluded via parentMeta (defense in depth)", async () => {
    // retractRow already deletes chunks (W2-4), which alone would remove a retracted row from
    // search. This test isolates THIS task's own mechanism — parentMeta excluding retracted rows
    // — by inserting a chunk directly (bypassing retractRow) after retracting, proving the
    // meta-miss drop (hybrid.ts) removes it even if a chunk somehow still pointed at it.
    const { id } = await insertJournal({
      entryMd: "Fictional entry about the ZQXPTARMIGAN weather station calibration.",
      mood: 3,
      tier: 1,
      createdBy: "human",
      source: "test:superseded-search",
    });
    await retractRow("journal", id);
    await testSql`
      insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('journal', ${id}, 0,
              'Fictional entry about the ZQXPTARMIGAN weather station calibration.', 1)`;

    const hits = await hybridSearch({
      query: "ZQXPTARMIGAN weather station calibration",
      limit: 10,
    });
    expect(hits.some((h) => h.id === id)).toBe(false);
  });
});
