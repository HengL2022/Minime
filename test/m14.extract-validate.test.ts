// W1 extractor re-validation (improve-w1-extract-validate.md). Offline; mock verdicts.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { plantGraphHygieneCorpus } from "../fixtures/graph-hygiene";
import {
  edgeAnchorTexts,
  edgeUnsureCount,
  edgesForValidation,
  insertEdgeValidation,
  insertReviewItem,
} from "../src/db/repo";
import { toolByName } from "../src/mcp/tools"; // match m7.graph.test.ts's actual import
import { invokeTool } from "../src/mcp/tools/registry";
import { validateEdges } from "../src/pipeline/validate-edges";
import { config } from "../src/util/config";
import { expectSqlReject, resetDb, testSql } from "./helpers";

// W3 provider-routing test seam (copied locally from test/m13.provider-routing.test.ts — test
// files stay self-contained, no cross-file imports).
const saved = {
  classifyProvider: config.classifyProvider,
  cloudMaxTier: config.cloudMaxTier,
  r1: config.providerRouteTier1,
  r2: config.providerRouteTier2,
  openrouterApiKey: config.openrouterApiKey,
  mockOllama: config.mockOllama,
};
afterEach(() => {
  config.classifyProvider = saved.classifyProvider;
  config.cloudMaxTier = saved.cloudMaxTier;
  config.providerRouteTier1 = saved.r1;
  config.providerRouteTier2 = saved.r2;
  config.openrouterApiKey = saved.openrouterApiKey;
  config.mockOllama = saved.mockOllama;
  Reflect.deleteProperty(process.env, "PROVIDER_ROUTE_TIER0");
});

/** Patch fetch: localhost Ollama gets a canned answer; ANY other host trips the leak wire. */
function patchFetch(ollamaResponder: () => unknown) {
  const real = globalThis.fetch;
  const cloudCalls: string[] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.startsWith(config.ollamaUrl))
      return new Response(JSON.stringify(ollamaResponder()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    cloudCalls.push(u);
    throw new Error(`LEAK: unexpected non-local egress to ${u}`);
  }) as typeof fetch;
  return {
    cloudCalls,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

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
    // One backdated backlog edge + one fresh edge, same dst so only recency differs. Budget=1
    // must NOT just cap `checked` at 1 — it must actually pick the fresh edge first (the
    // dedicated recent-first ordering assertion; edgesForValidation's own ORDER BY is covered
    // above, this proves validateEdges's budget slicing preserves it end to end).
    const [org] =
      await testSql`insert into orgs (canonical_name, tier) values ('Beta Org', 1) returning id`;
    const [pg] = await testSql`insert into pages (path, title, body_md, content_hash, tier)
      values ('gh/budget.md', 'gh/budget', 'Beta Org appears here for budget testing.', 'hbud', 1) returning id`;
    await testSql`insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('page', ${pg!.id}, 0, 'Beta Org appears here for budget testing.', 1)`;
    const mkEdge = async (createdAt: string) =>
      (
        await testSql`
      insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by, confidence, created_at)
      values ('page', ${pg!.id}, 'mentions', 'org', ${org!.id}, 'pages', ${pg!.id}, 'system:extract', 0.8, ${createdAt})
      returning id`
      )[0]!.id as string;
    const backlogEdge = await mkEdge("2020-01-01T00:00:00Z");
    const freshEdge = await mkEdge(new Date().toISOString());

    const r = await validateEdges(1);
    expect(r.checked).toBe(1); // budget bounds the run to exactly one edge
    const [row] = await testSql`select edge_id from edge_validations`;
    expect(row!.edge_id).toBe(freshEdge); // recent-first: the fresh edge wins the single slot
    expect(row!.edge_id).not.toBe(backlogEdge); // …not the backdated backlog edge
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

describe("validateEdges provider routing", () => {
  test("tier-2 edge: cloud+no-route skips; local tier-2 route validates on-box with zero egress", async () => {
    await resetDb();
    const [org] =
      await testSql`insert into orgs (canonical_name, tier) values ('Verity', 1) returning id`;
    const [pg] = await testSql`insert into pages (path, title, body_md, content_hash, tier)
      values ('gh/t2.md', 'gh/t2', 'Talked with Verity about the school run.', 'ht2', 2) returning id`;
    await testSql`insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('page', ${pg!.id}, 0, 'Talked with Verity about the school run.', 2)`;
    await testSql`insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by, confidence)
      values ('page', ${pg!.id}, 'mentions', 'org', ${org!.id}, 'pages', ${pg!.id}, 'system:extract', 0.8)`;
    config.mockOllama = false;
    config.classifyProvider = "bedrock";
    config.cloudMaxTier = 1;
    const patched = patchFetch(() => ({
      response: '{"verdict":"deny","entity_type":"person","reason":"bare first name"}',
    }));
    try {
      const skip = await validateEdges();
      expect(skip.checked).toBe(0); // legacy: skipped, never sent
      config.providerRouteTier2 = "ollama";
      const run = await validateEdges();
      expect(run.checked).toBe(1);
      expect(run.flagged).toBe(1);
      expect(patched.cloudCalls).toEqual([]);
      const egress =
        await testSql`select count(*)::int as n from events where verb like 'egress:%'`;
      expect(egress[0]!.n).toBe(0);
    } finally {
      patched.restore();
      config.mockOllama = true;
      config.cloudMaxTier = saved.cloudMaxTier;
      config.providerRouteTier2 = undefined;
      config.classifyProvider = saved.classifyProvider;
    }
  });
});

describe("dream wiring + review tool", () => {
  test("dream() runs 3c_validate_edges and reports counts", async () => {
    await resetDb();
    await plantGraphHygieneCorpus();
    const { dream } = await import("../src/pipeline/dream");
    const summary = await dream();
    // dream() runs 2_entity_link first, which may extract ADDITIONAL edges over the planted
    // pages — so assert the step ran and caught at least the planted bad ones; the exact
    // 3-flags/0-false bar lives in the direct tests above.
    const step = summary["3c_validate_edges"] as { flagged: number };
    expect(step.flagged).toBeGreaterThanOrEqual(3);
  });

  test("minime_review_queue lists extract_suspect with names visible and reason masked at tier 1", async () => {
    const tool = toolByName("minime_review_queue");
    const res = await invokeTool(
      tool,
      { action: "list", kind: "extract_suspect" },
      { actor: "agent:test" },
    );
    expect(res.ok).toBe(true);
    const items = (res as any).envelope.data.items;
    expect(items.length).toBe(3);
    expect(JSON.stringify(items)).toContain("Verity"); // entity names are the label
    expect(JSON.stringify(items)).not.toContain("school run"); // anchor text never surfaces
    // the model's one-line reason may quote tier-2 anchor text — always masked at the tool
    for (const it of items) expect(it.payload.reason).toBe("[above current tier]");
    const resolved = await invokeTool(
      tool,
      { action: "resolve", id: items[0].id, status: "dismissed" },
      { actor: "agent:test" },
    );
    expect(resolved.ok).toBe(true);
  });

  test("tier-2-anchored suspect edge: rel + names masked at tier 1, ids stay for triage", async () => {
    await resetDb();
    // Bare-first-name org on a TIER-2 page → the edge inherits tier 2; the heuristic denies it.
    const [org] =
      await testSql`insert into orgs (canonical_name, tier) values ('Verity', 1) returning id`;
    const [pg] = await testSql`insert into pages (path, title, body_md, content_hash, tier)
      values ('gh/mask.md', 'gh/mask', 'Talked with Verity about the school run.', 'hmask', 2) returning id`;
    await testSql`insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('page', ${pg!.id}, 0, 'Talked with Verity about the school run.', 2)`;
    const [edge] = await testSql`
      insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by, confidence)
      values ('page', ${pg!.id}, 'mentions', 'org', ${org!.id}, 'pages', ${pg!.id}, 'system:extract', 0.8)
      returning id`;
    const r = await validateEdges();
    expect(r.flagged).toBe(1);

    const tool = toolByName("minime_review_queue");
    const res = await invokeTool(
      tool,
      { action: "list", kind: "extract_suspect" },
      { actor: "agent:test" },
    );
    expect(res.ok).toBe(true);
    const [item] = (res as any).envelope.data.items;
    expect(item.payload.edge_id).toBe(edge!.id); // ids stay for post-unlock triage
    expect(item.payload.rule_key).toBe("mentions@0.8");
    expect(item.payload.verdict).toBe("deny");
    expect(item.payload.rel).toBe("[above current tier]"); // the triple is tier-2-anchored
    expect(item.payload.dst.name).toBe("[above current tier]");
    expect(JSON.stringify(item)).not.toContain("Verity"); // the name never rides a tier-1 read
  });
});
