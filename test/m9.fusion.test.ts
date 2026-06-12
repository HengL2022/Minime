// M9 Phase-1a unit tests for the pure fusion-support modules: title-phrase boost and the
// zero-LLM intent classifier. Both are pure (no DB, no network); the DB-backed RRF path is
// exercised by the existing m3.search retrieval/derived/tier tests plus MinimeBench.

import { describe, expect, test } from "bun:test";
import { classifyIntent, intentNudge } from "../src/search/intent";
import { TITLE_BOOST, TITLE_BOOST_EXACT, titleBoost, tokenize } from "../src/search/title-match";

describe("title-phrase boost", () => {
  test("contiguous multi-token run in title boosts", () => {
    expect(titleBoost("Rivian R1T", "Rivian R1T deep-dive")).toBeCloseTo(TITLE_BOOST, 5);
  });

  test("exact full-title match gets the stronger exact boost", () => {
    expect(titleBoost("Rivian R1T deep-dive", "Rivian R1T deep-dive")).toBeCloseTo(
      TITLE_BOOST_EXACT,
      5,
    );
  });

  test("single non-stopword token does NOT boost (needs >=2 or exact)", () => {
    expect(titleBoost("habitat", "Quokka habitat field notes")).toBe(1);
  });

  test("single-word query that IS the whole title boosts (exact)", () => {
    expect(titleBoost("Quokkas", "Quokkas")).toBeCloseTo(TITLE_BOOST_EXACT, 5);
  });

  test("never a raw substring match: partial-word run does not fire", () => {
    // "art" is a substring of "Bartholomew" but not a whole token → no boost.
    expect(titleBoost("art", "Bartholomew art history")).toBe(1);
  });

  test("non-contiguous token overlap does not boost", () => {
    // query tokens present but not as a contiguous run (field sits between).
    expect(titleBoost("quokka habitat notes", "Quokka habitat field notes")).toBe(1);
  });

  test("stopword-only multi-token query does not boost", () => {
    expect(titleBoost("about the", "about the weather report")).toBe(1);
  });

  test("entity-intent scale widens the boost's lift above 1", () => {
    const plain = titleBoost("Rivian R1T", "Rivian R1T deep-dive", 1);
    const scaled = titleBoost("Rivian R1T", "Rivian R1T deep-dive", 1.4);
    expect(scaled).toBeGreaterThan(plain);
    expect(scaled - 1).toBeCloseTo((plain - 1) * 1.4, 5);
  });

  test("CJK title matches on bigram token boundaries, not raw chars", () => {
    // 招商银行 folds to bigrams [招商, 商银, 银行] on both sides → contiguous run, >=2 tokens.
    expect(titleBoost("招商银行", "招商银行 年度报告")).toBeGreaterThan(1);
    // a different Han run sharing no bigram must not match.
    expect(titleBoost("中国银行", "招商银行 年度报告")).toBe(1);
  });

  test("tokenize folds Han runs to overlapping hex bigram lexemes", () => {
    expect(tokenize("招商银行")).toEqual(["zh62db5546", "zh554694f6", "zh94f6884c"]);
    expect(tokenize("Rivian R1T")).toEqual(["rivian", "r1t"]);
  });

  test("empty query or title is a no-op", () => {
    expect(titleBoost("", "anything")).toBe(1);
    expect(titleBoost("anything", "")).toBe(1);
  });
});

describe("intent classifier", () => {
  test("temporal cues and month names classify temporal", () => {
    expect(classifyIntent("budget as of March")).toBe("temporal");
    expect(classifyIntent("latest health metrics")).toBe("temporal");
    expect(classifyIntent("what did I do last week")).toBe("temporal");
  });

  test("event cues classify event", () => {
    expect(classifyIntent("what happened at the offsite")).toBe("event");
    expect(classifyIntent("meeting with the design team")).toBe("event");
  });

  test("short capitalized / CJK-only queries classify entity", () => {
    expect(classifyIntent("Tomasz Wójcik")).toBe("entity");
    expect(classifyIntent("who is Tomasz")).toBe("entity");
    expect(classifyIntent("招商银行")).toBe("entity");
  });

  test("plain topical query classifies general", () => {
    expect(classifyIntent("notes on quokka habitat and diet")).toBe("general");
  });

  test("temporal wins over event when both cues present", () => {
    expect(classifyIntent("what happened in the meeting last week")).toBe("temporal");
  });

  test("nudges: only the matching lever moves; general is all-1.0", () => {
    const g = intentNudge("notes on quokka habitat and diet");
    expect(g).toMatchObject({
      intent: "general",
      titleBoostScale: 1,
      recencyScale: 1,
      ftsRrfWeight: 1,
    });

    const entity = intentNudge("Tomasz Wójcik");
    expect(entity.titleBoostScale).toBeGreaterThan(1);
    expect(entity.recencyScale).toBe(1);
    expect(entity.ftsRrfWeight).toBe(1);

    const temporal = intentNudge("latest metrics");
    expect(temporal.recencyScale).toBeGreaterThan(1);
    expect(temporal.titleBoostScale).toBe(1);

    const event = intentNudge("what happened at standup");
    expect(event.ftsRrfWeight).toBeGreaterThan(1);
    expect(event.titleBoostScale).toBe(1);
  });
});

describe("scoped search (scopeParentIds)", () => {
  test("results are restricted to the given parent ids", async () => {
    const { upsertPage } = await import("../src/db/repo");
    const { indexParent } = await import("../src/search/index-parent");
    const { hybridSearch } = await import("../src/search/hybrid");
    const a = await upsertPage({
      path: "scope/a.md",
      title: "Skiff maintenance",
      bodyMd: "The skiff needs antifouling paint every spring season.",
      contentHash: "scope-a",
      source: "test",
    });
    const b = await upsertPage({
      path: "scope/b.md",
      title: "Skiff log",
      bodyMd: "Took the skiff out past the breakwater; antifouling held up well.",
      contentHash: "scope-b",
      source: "test",
    });
    await indexParent(
      "page",
      a.id,
      "The skiff needs antifouling paint every spring season.",
      "Skiff maintenance",
      1,
    );
    await indexParent(
      "page",
      b.id,
      "Took the skiff out past the breakwater; antifouling held up well.",
      "Skiff log",
      1,
    );

    const all = await hybridSearch({ query: "skiff antifouling" });
    expect(all.length).toBeGreaterThanOrEqual(2);
    const scoped = await hybridSearch({ query: "skiff antifouling", scopeParentIds: [a.id] });
    expect(scoped.length).toBe(1);
    expect(scoped[0]!.id).toBe(a.id);
  });
});
