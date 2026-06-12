// Phase-3 rerank + autocut (DECISIONS.md 2026-06-12). Fully offline: the rerank client
// takes an injected FetchFn; no test touches a real server.

import { afterEach, describe, expect, test } from "bun:test";
import { autocut } from "../src/search/autocut";
import { rerank, rerankEnabled } from "../src/search/rerank";
import { config } from "../src/util/config";

const cfg = config as { rerankUrl?: string };
const ORIGINAL = cfg.rerankUrl;
afterEach(() => {
  cfg.rerankUrl = ORIGINAL;
});

function fakeFetch(payload: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status })) as unknown as typeof fetch;
}

describe("rerankEnabled (I1: localhost only)", () => {
  test("disabled when unset; enabled for localhost; refused for remote hosts", () => {
    cfg.rerankUrl = undefined;
    expect(rerankEnabled()).toBe(false);
    cfg.rerankUrl = "http://localhost:8114";
    expect(rerankEnabled()).toBe(true);
    cfg.rerankUrl = "http://127.0.0.1:8114";
    expect(rerankEnabled()).toBe(true);
    cfg.rerankUrl = "https://api.example.com";
    expect(rerankEnabled()).toBe(false);
    cfg.rerankUrl = "not a url";
    expect(rerankEnabled()).toBe(false);
  });
});

describe("rerank client (fail-open)", () => {
  test("returns scores aligned to input order", async () => {
    cfg.rerankUrl = "http://localhost:8114";
    const scores = await rerank(
      "q",
      ["a", "b", "c"],
      fakeFetch({
        results: [
          { index: 2, relevance_score: 9 },
          { index: 0, relevance_score: 1 },
          { index: 1, relevance_score: 5 },
        ],
      }),
    );
    expect(scores).toEqual([1, 5, 9]);
  });

  test("null on HTTP error, malformed payload, or thrown fetch", async () => {
    cfg.rerankUrl = "http://localhost:8114";
    expect(await rerank("q", ["a"], fakeFetch({}, 500))).toBeNull();
    expect(await rerank("q", ["a"], fakeFetch({ results: [] }))).toBeNull();
    expect(
      await rerank("q", ["a"], fakeFetch({ results: [{ index: 5, relevance_score: 1 }] })),
    ).toBeNull();
    const throwing = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    expect(await rerank("q", ["a"], throwing)).toBeNull();
  });

  test("disabled (unset url) returns null without calling fetch", async () => {
    cfg.rerankUrl = undefined;
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    expect(await rerank("q", ["a"], spy)).toBeNull();
    expect(called).toBe(false);
  });
});

describe("autocut (rerank-score cliffs only)", () => {
  test("cuts at an obvious cliff, keeps clusters, never cuts to zero", () => {
    expect(autocut([9.0, -5.0, -5.2, -6.0])).toBe(1); // one obvious answer
    expect(autocut([8.0, 7.8, 7.5, -4.0, -4.4])).toBe(3); // a genuine cluster of 3
    expect(autocut([1.0, 0.9, 0.8, 0.7])).toBe(4); // smooth decay: no cut
    expect(autocut([5])).toBe(1);
    expect(autocut([])).toBe(0);
  });

  test("flat scores: no cut", () => {
    expect(autocut([2, 2, 2])).toBe(3);
  });
});

describe("redirects are refused (I1: every hop)", () => {
  test("a redirect response fails open to null", async () => {
    (config as { rerankUrl?: string }).rerankUrl = "http://localhost:8114";
    // Bun's fetch with redirect:"error" throws on 3xx — simulate by throwing like fetch does
    const redirecting = (async () => {
      throw new Error("UnexpectedRedirect");
    }) as unknown as typeof fetch;
    expect(await rerank("q", ["a"], redirecting)).toBeNull();
  });

  test("duplicate result indices are rejected", async () => {
    (config as { rerankUrl?: string }).rerankUrl = "http://localhost:8114";
    const dup = fakeFetch({
      results: [
        { index: 0, relevance_score: 1 },
        { index: 0, relevance_score: 2 },
      ],
    });
    expect(await rerank("q", ["a", "b"], dup)).toBeNull();
  });
});
