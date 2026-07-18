// W1 extractor re-validation (improve-w1-extract-validate.md). Offline; mock verdicts.
import { beforeAll, describe, expect, test } from "bun:test";
import { plantGraphHygieneCorpus } from "../fixtures/graph-hygiene";
import {
  edgeAnchorTexts,
  edgeUnsureCount,
  edgesForValidation,
  insertEdgeValidation,
  insertReviewItem,
} from "../src/db/repo";
import { validateEdges } from "../src/pipeline/validate-edges";
import { expectSqlReject, resetDb, testSql } from "./helpers";

describe("migration 017", () => {
  beforeAll(async () => {
    await resetDb();
  });

  test("edge_validations exists with verdict CHECK; review kind extract_suspect accepted", async () => {
    const [e] =
      await testSql`insert into edges (src_type, src_id, rel, dst_type, dst_id, extracted_by)
      values ('page', gen_random_uuid(), 'mentions', 'person', gen_random_uuid(), 'system:extract') returning id`;
    await testSql`insert into edge_validations (edge_id, verdict, model, rule_key)
      values (${e!.id}, 'confirm', 'mock', 'mentions@0.8')`;
    await expectSqlReject(
      testSql`insert into edge_validations (edge_id, verdict, model, rule_key)
        values (${e!.id}, 'maybe', 'mock', 'mentions@0.8')`,
      /verdict/,
    );
    const { id } = await insertReviewItem("extract_suspect", { edge_id: e!.id });
    expect(id).toBeTruthy();
    await expectSqlReject(
      testSql`insert into review_queue (kind, payload) values ('bogus_kind', '{}')`,
      /review_queue_kind_check/,
    );
  });
});

describe("validation repo helpers", () => {
  test("edgesForValidation: recent-first, then oldest backlog; excludes validated (non-unsure); resolves names", async () => {
    await resetDb();
    const [person] =
      await testSql`insert into people (canonical_name, tier) values ('Mia Chen', 1) returning id`;
    const [org] =
      await testSql`insert into orgs (canonical_name, tier) values ('Acme Corp', 1) returning id`;
    const [pg] = await testSql`insert into pages (path, title, body_md, content_hash, tier)
      values ('w/a.md', 'Work note', 'Mia Chen works at Acme Corp on filters.', 'h1', 1) returning id`;
    // A second, unrelated page: hosts a decoy chunk for the edgeAnchorTexts test below, so that
    // test can prove the join is parent-anchored (scoped to `pg`) rather than a needle-only
    // search across all chunks. Fixtures for that test live here (not in the test itself) since
    // it reuses this test's DB state via edgesForValidation rather than calling resetDb again.
    const [otherPg] = await testSql`insert into pages (path, title, body_md, content_hash, tier)
      values ('w/other.md', 'Other note', 'Unrelated content only.', 'h2', 1) returning id`;
    await testSql`insert into chunks (parent_type, parent_id, ord, text, tier) values
      ('page', ${pg!.id}, 0, 'Intro paragraph unrelated to anything.', 1),
      ('page', ${pg!.id}, 1, 'Mia Chen works at Acme Corp on filters.', 1),
      ('page', ${pg!.id}, 2, 'Acme Corp also sponsors the filters team offsite.', 1),
      ('page', ${pg!.id}, 3, 'Acme Corp published a new filters roadmap.', 1),
      ('page', ${pg!.id}, 4, 'The filters team celebrated Acme Corp anniversary.', 1),
      ('page', ${otherPg!.id}, 0, 'A different page also mentions Acme Corp here.', 1)`;
    const mkEdge = async (createdAt: string) =>
      (
        await testSql`
      insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by, confidence, created_at)
      values ('person', ${person!.id}, 'works_at', 'org', ${org!.id}, 'pages', ${pg!.id}, 'system:extract', 0.85, ${createdAt})
      returning id`
      )[0]!.id as string;
    const oldEdge = await mkEdge("2026-06-01T00:00:00Z");
    const newEdge = await mkEdge(new Date().toISOString());
    const confirmed = await mkEdge("2026-05-01T00:00:00Z");
    await insertEdgeValidation({
      edgeId: confirmed,
      verdict: "confirm",
      model: "mock",
      ruleKey: "works_at@0.85",
    });
    const unsureOnce = await mkEdge("2026-04-01T00:00:00Z");
    await insertEdgeValidation({
      edgeId: unsureOnce,
      verdict: "unsure",
      model: "mock",
      ruleKey: "works_at@0.85",
    });

    const batch = await edgesForValidation(24, 10);
    const ids = batch.map((b) => b.id);
    expect(ids[0]).toBe(newEdge); // recent window first
    expect(ids).toContain(oldEdge); // backlog swept
    expect(ids).toContain(unsureOnce); // unsure gets resampled
    expect(ids).not.toContain(confirmed); // settled verdicts excluded
    expect(batch[0]!.src_name).toBe("Mia Chen");
    expect(batch[0]!.dst_name).toBe("Acme Corp");
    expect(await edgeUnsureCount(unsureOnce)).toBe(1);
  });

  test("edgeAnchorTexts: parent-anchored join, ilike-narrowed, ord-limited, first-chunk fallback", async () => {
    // Reuses the DB state left by the previous test (no resetDb here) — same pattern the
    // brief specifies, since the chunk fixtures now live in that test's setup.
    const [batch] = await edgesForValidation(24, 1);
    expect(batch!.source_table).toBe("pages");
    expect(batch!.source_id).toBeTruthy();

    const anchors = await edgeAnchorTexts(batch!, "Acme Corp");
    expect(anchors.length).toBe(3); // ord-limited: 4 matches on this page, capped at 3
    expect(anchors.map((a) => a.text)).not.toContain(
      "A different page also mentions Acme Corp here.", // parent-anchored: other page's match excluded
    );
    expect(anchors[0]!.text).toContain("Mia Chen"); // ord asc: ord=1 first
    expect(anchors[2]!.text).toContain("roadmap"); // ord=3 third; ord=4 dropped by the cap

    const fallback = await edgeAnchorTexts(batch!, "no such needle anywhere");
    expect(fallback.length).toBe(1); // first-chunk fallback: needle absent
    expect(fallback[0]!.text).toBe("Intro paragraph unrelated to anything.");
  });
});

describe("validateEdges (mock verdicts — the CI graph-hygiene bar)", () => {
  test("flags 100% of planted bad edges, 0 false flags, ledger written, idempotent", async () => {
    await resetDb();
    const { badEdgeIds, goodEdgeIds } = await plantGraphHygieneCorpus();
    const r1 = await validateEdges();
    expect(r1.checked).toBe(badEdgeIds.length + goodEdgeIds.length);
    expect(r1.flagged).toBe(badEdgeIds.length); // 100% bad flagged
    const flagged =
      await testSql`select payload->>'edge_id' as id from review_queue where kind = 'extract_suspect'`;
    expect(new Set(flagged.map((f: any) => f.id))).toEqual(new Set(badEdgeIds)); // 0 false flags
    expect(r1.byRule["works_at@0.7"]?.denied).toBe(1);
    const r2 = await validateEdges(); // settled → nothing to do
    expect(r2.checked).toBe(0);
    const q =
      await testSql`select count(*)::int as n from review_queue where kind = 'extract_suspect'`;
    expect(q[0]!.n).toBe(badEdgeIds.length); // no duplicate flags
  });

  test("budget bounds a night's work; recent edges beat backlog", async () => {
    await resetDb();
    await plantGraphHygieneCorpus();
    const r = await validateEdges(2);
    expect(r.checked).toBe(2);
  });

  test("unsure resamples once, flags on the second unsure", async () => {
    await resetDb();
    // an edge whose anchor never mentions the dst → heuristic returns 'unsure'
    const [ghost] =
      await testSql`insert into orgs (canonical_name, tier) values ('Quiet Harbor Ltd', 1) returning id`;
    const [pg] = await testSql`insert into pages (path, title, body_md, content_hash, tier)
      values ('gh/u.md', 'gh/u', 'A page about something else entirely.', 'hu', 1) returning id`;
    await testSql`insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('page', ${pg!.id}, 0, 'A page about something else entirely.', 1)`;
    await testSql`insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by, confidence)
      values ('page', ${pg!.id}, 'mentions', 'org', ${ghost!.id}, 'pages', ${pg!.id}, 'system:extract', 0.8)`;
    const r1 = await validateEdges();
    expect(r1.unsure).toBe(1);
    expect(r1.flagged).toBe(0);
    const r2 = await validateEdges(); // resample night
    expect(r2.flagged).toBe(1);
    const [item] = await testSql`select payload from review_queue where kind = 'extract_suspect'`;
    expect(item!.payload.reason).toMatch(/unsure/i);
  });
});
