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
});

describe("suppressed_candidate_count() under real RLS (restricted minime_app-shaped role)", () => {
  let appRole: TestAppRoleLease;
  let app: ReturnType<typeof postgres>;
  const sentinel = "ZQXSUPHITROLE";

  beforeAll(async () => {
    // Own reset (not shared with the describe block above): same small-corpus reasoning as its
    // beforeEach comment — this block's exact-count assertions need a corpus containing only
    // its own fixtures.
    await resetDb();
    appRole = await mintTestAppRole(process.env.DATABASE_URL!);
    app = postgres(appRole.databaseUrl, { max: 1, onnotice: () => {} });

    await fictionalNote(
      "test/suppressed-hits-role-note.md",
      `${sentinel} elk note`,
      `${sentinel} Fictional elk herds were sighted near the tree line this week.`,
    );
    await fictionalJournal(`${sentinel} Fictional elk antler shedding site marker one.`);
    await fictionalJournal(`${sentinel} Fictional elk antler shedding site marker two.`);
  });

  afterAll(async () => {
    await app?.end({ timeout: 2 });
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
        has_function_privilege('public', 'public.suppressed_candidate_count(text,vector,int)', 'EXECUTE') as public_execute,
        has_function_privilege('minime_engineer_ro', 'public.suppressed_candidate_count(text,vector,int)', 'EXECUTE') as engineer_execute,
        has_function_privilege(${appRole.roleName}, 'public.suppressed_candidate_count(text,vector,int)', 'EXECUTE') as app_execute`;
    expect(privileges).toEqual({
      public_execute: false,
      engineer_execute: false,
      app_execute: true,
    });
    const [posture] = await testSql`
      select prosecdef as security_definer, provolatile
      from pg_proc where oid = 'public.suppressed_candidate_count(text,vector,int)'::regprocedure`;
    expect(posture).toEqual({ security_definer: true, provolatile: "s" });
  });
});
