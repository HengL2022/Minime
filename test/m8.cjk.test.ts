// M8 CJK support (DECISIONS.md 2026-06-11): bigram-folded FTS for Han text and
// CJK-aware chunk sizing. Fully offline; fixtures fictional.

import { beforeAll, describe, expect, test } from "bun:test";
import { ftsCandidates, upsertPage } from "../src/db/repo";
import { chunkMarkdown } from "../src/search/chunker";
import { indexParent } from "../src/search/index-parent";
import { cjkFold, tokenCount } from "../src/util/cjk";
import { resetDb, testSql } from "./helpers";

describe("cjkFold parity (TS twin vs SQL cjk_fold)", () => {
  beforeAll(async () => {
    await resetDb();
  });

  const SAMPLES = [
    "招商银行",
    "猫",
    "我在哪里买腊肠？",
    "Q3 的 OKR：把 transaction success rate 提到 99.2%",
    "plain english only, no folding at all",
    "钢琴老师说 left hand 太重了。",
    "",
  ];

  test("TS and SQL produce identical folds", async () => {
    for (const s of SAMPLES) {
      const [row] = await testSql`select cjk_fold(${s}) as f`;
      expect(cjkFold(s)).toBe(row!.f ?? "");
    }
  });

  test("bigrams overlap as hex lexemes; single char stays unigram; English untouched", () => {
    // ASCII hex lexemes: the ts parser's libc-based classification drops Han chars on
    // some platforms (macOS 14 CI), so lexemes must never contain them (010 migration)
    expect(cjkFold("招商银行").trim()).toBe("zh62db5546 zh554694f6 zh94f6884c");
    expect(cjkFold("猫").trim()).toBe("zh732b");
    expect(cjkFold("hello world")).toBe("hello world");
  });
});

describe("Chinese FTS retrieval", () => {
  let recipesId: string;

  beforeAll(async () => {
    const recipes = await upsertPage({
      path: "m8/recipes.md",
      title: "食谱笔记",
      bodyMd: "腊肠只买牛车水那家老铺的，每年冬至前买够一年的量。老火汤要煲三个小时。",
      contentHash: "m8-zh-1",
      source: "test",
    });
    recipesId = recipes.id;
    await indexParent(
      "page",
      recipesId,
      "腊肠只买牛车水那家老铺的，每年冬至前买够一年的量。老火汤要煲三个小时。",
      "食谱笔记",
      1,
    );
    const other = await upsertPage({
      path: "m8/piano.md",
      title: "钢琴笔记",
      bodyMd: "周六上午十点上钢琴课，在练肖邦夜曲，老师说左手太重。",
      contentHash: "m8-zh-2",
      source: "test",
    });
    await indexParent(
      "page",
      other.id,
      "周六上午十点上钢琴课，在练肖邦夜曲，老师说左手太重。",
      "钢琴笔记",
      1,
    );
  });

  test("a Chinese question now yields fts candidates, best match first", async () => {
    const hits = await ftsCandidates("我在哪里买腊肠？", null);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.parent_id).toBe(recipesId);
  });

  test("mixed-language query matches both legs", async () => {
    const hits = await ftsCandidates("钢琴 lesson 是什么时候", null);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.text).toContain("钢琴");
  });
});

describe("CJK-aware chunker", () => {
  test("a long unspaced Chinese document actually splits", () => {
    const sentence = "外婆教我的老火汤要先把猪骨飞水然后转小火慢慢煲足三个小时中途绝对不能加水。";
    const doc = sentence.repeat(40); // ~1500 Han chars, zero whitespace
    const chunks = chunkMarkdown(doc, "长文档");
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(tokenCount(c)).toBeLessThanOrEqual(450); // MAX + overlap slack
    }
  });

  test("consecutive Chinese chunks share an overlap tail", () => {
    const sentence = "今天练琴一个小时左手还是太重老师说伴奏要像月光不要像打桩我觉得有道理。";
    const chunks = chunkMarkdown(sentence.repeat(40));
    expect(chunks.length).toBeGreaterThan(1);
    const tail = Array.from(chunks[0]!.replace(/\s/g, "")).slice(-20).join("");
    expect(chunks[1]!.replace(/\s/g, "")).toContain(tail);
  });

  test("English chunking still splits long docs and respects MAX", () => {
    const para = "the quick brown fox jumps over the lazy dog again and again. ";
    const chunks = chunkMarkdown(para.repeat(100), "Long English");
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(tokenCount(c)).toBeLessThanOrEqual(450);
  });

  test("short documents stay single-chunk in both languages", () => {
    expect(chunkMarkdown("白切鸡的姜葱蓉：姜要剁不要磨。", "小笔记").length).toBe(1);
    expect(chunkMarkdown("Just a short note about coffee.", "Note").length).toBe(1);
  });
});

describe("CJK query stop-token filter", () => {
  test("function-word bigrams are dropped, content bigrams kept", async () => {
    const { isCjkStopToken } = await import("../src/util/cjk");
    expect(isCjkStopToken("我的")).toBe(true);
    expect(isCjkStopToken("什么")).toBe(true);
    expect(isCjkStopToken("时候")).toBe(true);
    expect(isCjkStopToken("腊肠")).toBe(false);
    expect(isCjkStopToken("招商")).toBe(false);
    expect(isCjkStopToken("coffee")).toBe(false);
  });

  test("an all-function-word Chinese query yields no fts candidates", async () => {
    const { ftsCandidates } = await import("../src/db/repo");
    const hits = await ftsCandidates("我的是什么时候", null);
    expect(hits.length).toBe(0);
  });
});
