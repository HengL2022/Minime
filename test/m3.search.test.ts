// M3 acceptance: retrieval eval ≥80% top-5 over the seed corpus; derived-penalty and
// tier-filter unit tests; chunker behavior.

import { beforeAll, describe, expect, test } from "bun:test";
import evalQueries from "../fixtures/eval-queries.json";
import { insertUnlock, upsertPage } from "../src/db/repo";
import { chunkMarkdown } from "../src/search/chunker";
import { hybridSearch } from "../src/search/hybrid";
import { indexParent } from "../src/search/index-parent";
import { setNow } from "../src/util/clock";
import { resetAndSeed, testSql as sql } from "./helpers";

beforeAll(async () => {
  await resetAndSeed();
});

describe("retrieval eval", () => {
  test("expected hit in top-5 for >= 80% of eval queries", async () => {
    let hits = 0;
    const misses: string[] = [];
    for (const q of evalQueries.queries) {
      let expectedId: string | undefined;
      if (q.type === "page") {
        const [row] = await sql`select id from pages where title ilike ${`%${q.title_contains}%`}`;
        expectedId = row?.id;
      } else {
        const [row] =
          await sql`select id from decisions where question ilike ${`%${q.title_contains}%`}`;
        expectedId = row?.id;
      }
      expect(expectedId, `seed should contain '${q.title_contains}'`).toBeDefined();
      const results = await hybridSearch({ query: q.query, limit: 5 });
      if (results.some((r) => r.id === expectedId)) hits++;
      else misses.push(q.query);
    }
    const rate = hits / evalQueries.queries.length;
    if (rate < 0.8) console.error("eval misses:", misses);
    expect(rate).toBeGreaterThanOrEqual(0.8);
  });
});

describe("derived penalty", () => {
  test("derived content ranks below its primary unless include_derived", async () => {
    const body =
      "# Quokka habitat field notes\n\nQuokkas live on Rottnest Island and smile for photographs. Field notes on quokka habitat and diet.";
    const primary = await upsertPage({
      path: "test/quokka-primary.md",
      title: "Quokka habitat field notes",
      bodyMd: body,
      contentHash: "h1",
    });
    await indexParent("page", primary.id, body, "Quokka habitat field notes", 1);
    const derived = await upsertPage({
      path: "test/quokka-derived.md",
      title: "Quokka habitat summary",
      bodyMd: body,
      contentHash: "h2",
    });
    await sql`update pages set derived_from = ${primary.id} where id = ${derived.id}`;
    await indexParent("page", derived.id, body, "Quokka habitat summary", 1);

    const withoutDerived = await hybridSearch({ query: "quokka habitat notes", limit: 10 });
    const pIdx = withoutDerived.findIndex((h) => h.id === primary.id);
    const dIdx = withoutDerived.findIndex((h) => h.id === derived.id);
    expect(pIdx).toBeGreaterThanOrEqual(0);
    expect(dIdx).toBeGreaterThanOrEqual(0);
    expect(pIdx).toBeLessThan(dIdx);
    expect(withoutDerived[dIdx]!.derived).toBe(true);

    const withDerived = await hybridSearch({
      query: "quokka habitat notes",
      limit: 10,
      includeDerived: true,
    });
    const dScore = withDerived.find((h) => h.id === derived.id)!.score;
    const dScorePenalized = withoutDerived[dIdx]!.score;
    expect(dScore).toBeGreaterThan(dScorePenalized);
  });
});

describe("tier filter (I3)", () => {
  test("tier-2 journal content is invisible while locked, visible after unlock", async () => {
    const locked = await hybridSearch({
      query: "gratitude unprompted health work people",
      limit: 20,
    });
    expect(locked.every((h) => h.type !== "journal" && h.type !== "interaction")).toBe(true);

    await insertUnlock(5, "test");
    const unlocked = await hybridSearch({
      query: "gratitude unprompted health work people",
      limit: 20,
    });
    expect(unlocked.some((h) => h.type === "journal")).toBe(true);

    // expire the unlock by moving the clock forward; tier 2 locks again
    setNow(new Date(Date.now() + 10 * 60_000));
    const relocked = await hybridSearch({
      query: "gratitude unprompted health work people",
      limit: 20,
    });
    expect(relocked.every((h) => h.type !== "journal")).toBe(true);
    setNow(null);
  });

  test("tier-0 content is never in the chunk index at all", async () => {
    const [r] = await sql`select count(*)::int as n from chunks where tier = 0`;
    expect(r!.n).toBe(0);
  });
});

describe("chunker", () => {
  test("prepends heading breadcrumbs and respects size bounds", () => {
    const para = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const md = `# Title A\n\n${para}\n\n${para}\n\n## Sub B\n\n${para}\n\n${para}\n\n${para}`;
    const chunks = chunkMarkdown(md, "Doc");
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!).toStartWith("Doc > Title A");
    expect(chunks.some((c) => c.includes("Title A > Sub B"))).toBe(true);
    for (const c of chunks) {
      const words = c.split(/\s+/).length;
      expect(words).toBeLessThanOrEqual(450); // 400 + heading prefix slack
    }
  });

  test("consecutive chunks overlap", () => {
    const para = Array.from({ length: 500 }, (_, i) => `tok${i}`).join(" ");
    const chunks = chunkMarkdown(`# H\n\n${para}`);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const first = new Set(chunks[0]!.split(/\s+/));
    const secondWords = chunks[1]!.split(/\s+/).filter((w) => w.startsWith("tok"));
    const shared = secondWords.filter((w) => first.has(w));
    expect(shared.length).toBeGreaterThanOrEqual(20);
  });

  test("embeds are deterministic and word-sensitive in mock mode", async () => {
    const { mockEmbed } = await import("../src/search/embed");
    const a = mockEmbed("quokka habitat field notes");
    const b = mockEmbed("quokka habitat field notes");
    const c = mockEmbed("completely different text about chess");
    expect(a).toEqual(b);
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(dot(a, b)).toBeGreaterThan(dot(a, c));
  });
});
