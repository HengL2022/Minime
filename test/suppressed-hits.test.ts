// W4-4: minime_search discloses a bare COUNT of tier-2 matches a locked session cannot read,
// the same "aggregate is fine, raw content is not" shape minime_timeline's own per-kind locked
// count already established (032_timeline_locked_count.sql, W3-3). suppressed_candidate_count()
// (039_suppressed_hit_count.sql) is a SECURITY DEFINER function that mirrors ftsCandidates'/
// vectorCandidates' own candidate SQL (repo.ts) without their upper tier ceiling, so it can see
// tier-2 rows a locked session's own RLS would hide — and returns ONLY a bare integer, never a
// title, id, or snippet.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { insertJournal, upsertPage } from "../src/db/repo";
import type { Envelope } from "../src/mcp/envelope";
import { toolByName } from "../src/mcp/tools";
import { type ToolResult, invokeTool } from "../src/mcp/tools/registry";
import { indexParent } from "../src/search/index-parent";
import { resetDb, testSql } from "./helpers";
import { type TrackedTestSqlPoolHandle, trackTestSqlPool } from "./setup";
import { type TestAppRoleLease, dropTestAppRole, mintTestAppRole } from "./support/app-role";
import { requestAndApproveTier2, sessionToolCtx } from "./support/unlock";

function expectOk(result: ToolResult): Envelope<Record<string, any>> {
  if (!result.ok)
    throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result.envelope as Envelope<Record<string, any>>;
}

// Each test below uses its own thematically distinct fictional vocabulary (never shared
// boilerplate) rather than a generic template. The mock embedding (MINIME_MOCK_OLLAMA=1,
// src/llm/mock.ts) is a bag-of-words sum over the literal tokens present, so two documents built
// from the SAME filler phrasing (differing only by their sentinel prefix) cosine-cluster tightly
// regardless of sentinel — an earlier version of this file's "unlocked" search also pulled back
// the "locked"/"opaque" tests' fixtures as spurious vector-arm hits because of that. Distinct
// fictional nouns per test keep unrelated fixtures' cosine similarity near zero, the same way
// superseded-search.test.ts's narwhal/orca/wombat/ptarmigan tests stay isolated from each other.
async function fictionalNote(path: string, title: string, body: string): Promise<{ id: string }> {
  const note = await upsertPage({
    path,
    title,
    bodyMd: body,
    contentHash: `${path}-h1`,
    tier: 1,
    createdBy: "human",
    source: "manual",
  });
  await indexParent("page", note.id, body, title, 1);
  return note;
}

async function fictionalJournal(entryMd: string): Promise<{ id: string }> {
  const journal = await insertJournal({ entryMd, tier: 2, createdBy: "human", source: "test" });
  await indexParent("journal", journal.id, entryMd, undefined, 2);
  return journal;
}

describe("minime_search: tier-2 locked match count", () => {
  // Full reset PER TEST, not once for the file: suppressed_candidate_count()'s vector arm (like
  // vectorCandidates itself) has no similarity floor, just `order by ... limit cap` — with a
  // corpus smaller than `cap` (RERANK_TOP_IN, 20), that "top-k" is a no-op and every tier>=1
  // chunk in the WHOLE test database becomes a candidate regardless of relevance. Sharing one
  // corpus across this file's tests would let an earlier test's tier-2 fixtures inflate a later
  // test's locked count (and its tier-1 fixtures leak into a later test's ranked hits as
  // RRF-normalization noise) — both purely a small-fixture-DB artifact, not a production
  // concern, but real enough to break exact-count assertions here. beforeEach(resetDb) is the
  // same per-test isolation goals-tool.test.ts/decision-digest.test.ts already use.
  beforeEach(async () => {
    await resetDb();
  });

  test("locked session: matching tier-1 hit stays visible, matching tier-2 rows are counted (never returned)", async () => {
    const ctx = sessionToolCtx("agent:suppressed-hits-locked");
    const sentinel = "ZQXSUPHITLOCKED";

    const note = await fictionalNote(
      "test/suppressed-hits-locked-note.md",
      `${sentinel} aardvark note`,
      `${sentinel} Fictional aardvarks excavate sprawling burrow networks across the savanna at dusk.`,
    );
    await fictionalJournal(
      `${sentinel} Fictional aardvark burrow depth measurements from last night's survey.`,
    );
    await fictionalJournal(
      `${sentinel} Fictional aardvark den entrance count doubled after the spring rains.`,
    );

    const envelope = expectOk(
      await invokeTool(toolByName("minime_search"), { query: sentinel, limit: 20 }, ctx),
    );
    const hits = envelope.data.hits as any[];
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe(note.id);
    expect(envelope.gaps).toEqual([
      "2 matching results are tier-2 locked — an owner-approved unlock (minime_unlock) would include them",
    ]);
  });

  test("unlocked session sees every match directly and gets no suppressed-count gap", async () => {
    const ctx = sessionToolCtx("agent:suppressed-hits-unlocked");
    await requestAndApproveTier2(ctx);
    const sentinel = "ZQXSUPHITUNLOCKED";

    const note = await fictionalNote(
      "test/suppressed-hits-unlocked-note.md",
      `${sentinel} beluga note`,
      `${sentinel} Fictional beluga whales gather near the river mouth every June.`,
    );
    const journalOne = await fictionalJournal(
      `${sentinel} Fictional beluga pod size estimate from yesterday's aerial survey.`,
    );
    const journalTwo = await fictionalJournal(
      `${sentinel} Fictional beluga calving season observations logged this morning.`,
    );

    const envelope = expectOk(
      await invokeTool(toolByName("minime_search"), { query: sentinel, limit: 20 }, ctx),
    );
    const hits = envelope.data.hits as any[];
    expect(hits).toHaveLength(3);
    expect(new Set(hits.map((h) => h.id))).toEqual(
      new Set([note.id, journalOne.id, journalTwo.id]),
    );
    expect(envelope.gaps).toBeUndefined();
  });

  test("the locked count never leaks the suppressed rows' ids, titles, or text", async () => {
    const ctx = sessionToolCtx("agent:suppressed-hits-oracle-check");
    const sentinel = "ZQXSUPHITOPAQUE";
    const secretText = `${sentinel} Fictional cormorant nesting colony coordinates, extremely secret, never disclosed.`;
    const journal = await fictionalJournal(secretText);
    const note = await fictionalNote(
      "test/suppressed-hits-opaque-note.md",
      `${sentinel} cormorant note`,
      `${sentinel} Fictional cormorant sighting count published in this week's newsletter.`,
    );

    const envelope = expectOk(
      await invokeTool(toolByName("minime_search"), { query: sentinel, limit: 20 }, ctx),
    );
    expect((envelope.data.hits as any[]).map((h) => h.id)).toEqual([note.id]);
    expect(envelope.gaps).toEqual([
      "1 matching result is tier-2 locked — an owner-approved unlock (minime_unlock) would include it",
    ]);

    // Whichever way this assertion fails, content must never leak alongside the bare count.
    const dump = JSON.stringify(envelope);
    expect(dump).not.toContain(journal.id);
    expect(dump).not.toContain("extremely secret");
    expect(dump).not.toContain("never disclosed");
  });

  test("zero-match locked query still discloses the tier-2 locked count alongside the no-match gap", async () => {
    const ctx = sessionToolCtx("agent:suppressed-hits-zero-match");
    const sentinel = "ZQXSUPHITZEROMATCH";
    await fictionalJournal(
      `${sentinel} Fictional dugong seagrass grazing patch survey, the only fixture in this test.`,
    );

    const envelope = expectOk(
      await invokeTool(toolByName("minime_search"), { query: sentinel, limit: 20 }, ctx),
    );
    expect(envelope.data.hits).toEqual([]);
    expect(envelope.gaps).toEqual([
      "no indexed content matches the query at the current access tier",
      "1 matching result is tier-2 locked — an owner-approved unlock (minime_unlock) would include it",
    ]);
  });

  // Review finding, 2026-08-09: suppressed_candidate_count() originally took no `types` argument
  // at all, so a type-scoped locked search disclosed a count that included matches of types the
  // caller had explicitly excluded — a type-scoped search could never have returned those matches
  // even unlocked, so the gap was a false claim, not merely an imprecise one. This test's only
  // fixture is a tier-2 JOURNAL entry and no task fixture exists anywhere in the corpus, so a
  // types:["task"] search must see zero suppressed matches, not the journal's locked count.
  test("type-scoped locked search never discloses a locked count for types outside the request", async () => {
    const ctx = sessionToolCtx("agent:suppressed-hits-type-scoped-excluded");
    const sentinel = "ZQXSUPHITTYPESCOPEDEXCLUDED";
    await fictionalJournal(
      `${sentinel} Fictional fennec fox burrow ventilation shaft survey, journal-only fixture.`,
    );

    const envelope = expectOk(
      await invokeTool(
        toolByName("minime_search"),
        { query: sentinel, types: ["task"], limit: 20 },
        ctx,
      ),
    );
    expect(envelope.data.hits).toEqual([]);
    expect(envelope.gaps).toEqual([
      "no indexed content matches the query at the current access tier",
    ]);
  });

  // Complement to the exclusion case above: types filtering must narrow the count, not just
  // always report zero — a locked match whose own type IS in the requested `types` list must
  // still be disclosed.
  test("type-scoped locked search still discloses the count when the locked match's own type is in scope", async () => {
    const ctx = sessionToolCtx("agent:suppressed-hits-type-scoped-included");
    const sentinel = "ZQXSUPHITTYPESCOPEDINCLUDED";
    await fictionalJournal(
      `${sentinel} Fictional gharial nesting bank temperature log, journal-only fixture.`,
    );

    const envelope = expectOk(
      await invokeTool(
        toolByName("minime_search"),
        { query: sentinel, types: ["journal"], limit: 20 },
        ctx,
      ),
    );
    expect(envelope.data.hits).toEqual([]);
    expect(envelope.gaps).toEqual([
      "no indexed content matches the query at the current access tier",
      "1 matching result is tier-2 locked — an owner-approved unlock (minime_unlock) would include it",
    ]);
  });

  // Parent-id scope must narrow the locked count exactly like it narrows the real candidate
  // pool (review finding, 2026-08-10): a scoped search whose scope excludes the tier-2 match
  // reports 0 locked; the same query scoped TO that match reports 1. Drives
  // hybridSearchDetailed directly since scopeParentIds is not exposed on the MCP tool.
  test("parent-id-scoped locked count mirrors the candidates' scope restriction", async () => {
    const { hybridSearchDetailed } = await import("../src/search/hybrid");
    const sentinel = "ZQXSUPHITPARENTSCOPED";
    const inScope = await fictionalJournal(
      `${sentinel} Fictional axolotl tank chemistry notes, journal-only fixture.`,
    );
    const outOfScope = await fictionalJournal(
      `${sentinel} Fictional axolotl feeding schedule, second journal fixture.`,
    );

    const actor = "agent:suppressed-hits-parent-scoped";
    const scopedToOther = await hybridSearchDetailed({
      query: sentinel,
      limit: 20,
      actor,
      scopeParentIds: [outOfScope.id],
    });
    expect(scopedToOther.suppressedTier2Count).toBe(1);

    const scopedToBoth = await hybridSearchDetailed({
      query: sentinel,
      limit: 20,
      actor,
      scopeParentIds: [inScope.id, outOfScope.id],
    });
    expect(scopedToBoth.suppressedTier2Count).toBe(2);

    const unscoped = await hybridSearchDetailed({ query: sentinel, limit: 20, actor });
    expect(unscoped.suppressedTier2Count).toBe(2);
  });
});

describe("suppressed_candidate_count() under real RLS (restricted minime_app-shaped role)", () => {
  let appRole: TestAppRoleLease;
  let app: ReturnType<typeof postgres>;
  let appHeld: TrackedTestSqlPoolHandle | undefined;
  const sentinel = "ZQXSUPHITROLE";

  beforeAll(async () => {
    // Own reset (not shared with the describe block above): same small-corpus reasoning as its
    // beforeEach comment — this block's exact-count assertions need a corpus containing only
    // its own fixtures.
    await resetDb();
    appRole = await mintTestAppRole(process.env.DATABASE_URL!);
    app = postgres(appRole.databaseUrl, { max: 1, onnotice: () => {} });
    appHeld = trackTestSqlPool(app);

    await fictionalNote(
      "test/suppressed-hits-role-note.md",
      `${sentinel} elk note`,
      `${sentinel} Fictional elk herds were sighted near the tree line this week.`,
    );
    await fictionalJournal(`${sentinel} Fictional elk antler shedding site marker one.`);
    await fictionalJournal(`${sentinel} Fictional elk antler shedding site marker two.`);
  });

  afterAll(async () => {
    await appHeld?.close();
    appHeld?.unregister();
    if (appRole) await dropTestAppRole(appRole);
  });

  test("a raw candidate query without the tier ceiling is still silently filtered by RLS", async () => {
    // No minime.actor/minime.session_id GUC is set on this connection, so app_allowed_tier()
    // resolves to 1 (locked) exactly like a fresh, never-unlocked MCP session — the same trap
    // timeline_locked_count's own regression test documents (test/timeline-restricted-role.test.ts):
    // dropping the `tier <= allowed` ceiling from the query text does not actually surface tier-2
    // rows, because RLS's own tier_read policy on chunks intersects `tier >= 1` with its own
    // `tier <= app_allowed_tier()` underneath the query regardless of what the query itself asks.
    const rows = await app`
      select count(*)::int as n from chunks
      where tier >= 1 and tsv @@ websearch_to_tsquery('english', ${sentinel})`;
    expect(Number(rows[0]!.n)).toBe(1); // only the tier-1 note's chunk, never the two tier-2 ones
  });

  test("suppressed_candidate_count() returns the real locked count despite RLS", async () => {
    const rows = await app`select suppressed_candidate_count(${sentinel}, null::vector, 50) as n`;
    expect(Number(rows[0]!.n)).toBe(2);
    // A bare integer only — no other key ever rides along on this row.
    expect(Object.keys(rows[0]!)).toEqual(["n"]);
  });

  test("suppressed_candidate_count() is minime_app-only, security definer, and stable", async () => {
    const [privileges] = await testSql`
      select
        has_function_privilege('public', 'public.suppressed_candidate_count(text,vector,int,text[],uuid[])', 'EXECUTE') as public_execute,
        has_function_privilege('minime_engineer_ro', 'public.suppressed_candidate_count(text,vector,int,text[],uuid[])', 'EXECUTE') as engineer_execute,
        has_function_privilege(${appRole.roleName}, 'public.suppressed_candidate_count(text,vector,int,text[],uuid[])', 'EXECUTE') as app_execute`;
    expect(privileges).toEqual({
      public_execute: false,
      engineer_execute: false,
      app_execute: true,
    });
    const [posture] = await testSql`
      select prosecdef as security_definer, provolatile
      from pg_proc where oid = 'public.suppressed_candidate_count(text,vector,int,text[],uuid[])'::regprocedure`;
    expect(posture).toEqual({ security_definer: true, provolatile: "s" });
  });
});
