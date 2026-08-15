// W6 image parse + optional VLM describe. No retrieval-img floors — owner bake-off first.
import { describe, expect, test } from "bun:test";
import { PHOTO_CAPTION, PHOTO_PNG, RECEIPT_CAPTION, RECEIPT_PNG } from "../fixtures/parse/images";
import { describeRouteForTier } from "../src/llm";
import { describeImage } from "../src/llm/describe";
import { mockDescribe } from "../src/llm/mock-describe";
import { ollamaProvider } from "../src/llm/ollama";
import { parseInboxSource, parseInboxSourceAsync } from "../src/pipeline/parse";
import { inferImageKind, looksLikeImage, suggestedImageTier } from "../src/pipeline/parse/image";
import { noteHintTier, receiptCandidateHint } from "../src/pipeline/watcher";
import { config } from "../src/util/config";
import { sha256Hex } from "../src/util/hash";

describe("image sniff and tier", () => {
  test("PNG magic is an image; unknown binary is not", () => {
    expect(looksLikeImage("shot.png", PHOTO_PNG)).toBe(true);
    expect(looksLikeImage("photo.bin", Buffer.from([0x00, 0x01, 0x02, 0xff]))).toBe(false);
  });

  test("filename and caption infer kind; photo and receipt suggest tier 2", () => {
    expect(inferImageKind("harbor.png")).toBe("photo");
    expect(inferImageKind("cafe-receipt.png")).toBe("receipt");
    expect(inferImageKind("board.png", "whiteboard sketch of the array")).toBe("whiteboard");
    expect(suggestedImageTier("photo", "harbor.png")).toBe(2);
    expect(suggestedImageTier("receipt", "cafe-receipt.png")).toBe(2);
    expect(suggestedImageTier("document", "spec-scan.png")).toBe(1);
    expect(suggestedImageTier("document", "passport-scan.png")).toBe(2);
  });
});

describe("parseInboxSource image stub", () => {
  test("sync path returns filename stub without a caption", () => {
    const parsed = parseInboxSource("harbor.png", PHOTO_PNG);
    expect(parsed.mime).toBe("image/png");
    expect(parsed.meta?.parser).toBe("image");
    expect(parsed.meta?.described).toBe(false);
    expect(parsed.markdown).toContain("filename: harbor.png");
    expect(parsed.markdown).not.toContain(PHOTO_CAPTION);
    expect(noteHintTier(parsed.markdown)).toBe(2);
  });

  test("async mock path captions by file hash", async () => {
    const parsed = await parseInboxSourceAsync("harbor.png", PHOTO_PNG);
    expect(parsed.meta?.described).toBe(true);
    expect(parsed.markdown).toContain(PHOTO_CAPTION);
    expect(mockDescribe(sha256Hex(PHOTO_PNG))).toBe(PHOTO_CAPTION);
  });

  test("receipt filename plus caption sets the review hint", async () => {
    const parsed = await parseInboxSourceAsync("cafe-receipt.png", RECEIPT_PNG);
    expect(parsed.markdown).toContain(RECEIPT_CAPTION);
    expect(parsed.meta?.kind).toBe("receipt");
    expect(receiptCandidateHint(parsed.markdown)).toBe(true);
    expect(noteHintTier(parsed.markdown)).toBe(2);
  });
});

describe("VLM routing", () => {
  test("default describe route is local ollama", () => {
    expect(describeRouteForTier(1)).toBe("ollama");
    expect(describeRouteForTier(2)).toBe("ollama");
  });

  test("explicit cloud VLM route fails closed", () => {
    const prev = config.vlmRouteTier2;
    config.vlmRouteTier2 = "openai";
    try {
      expect(() => describeRouteForTier(2)).toThrow(/local-only/);
    } finally {
      config.vlmRouteTier2 = prev;
    }
  });

  test("ollama describe posts images:[base64] when VLM_MODEL is set", async () => {
    const prev = config.vlmModel;
    config.vlmModel = "llava";
    const calls: { url: string; body: string }[] = [];
    try {
      const provider = ollamaProvider((async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), body: String(init?.body ?? "") });
        return new Response(JSON.stringify({ response: "a fictional pier" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch);
      expect(provider.describe).toBeDefined();
      const caption = await provider.describe!(
        { mime: "image/png", base64: PHOTO_PNG.toString("base64"), sha256: sha256Hex(PHOTO_PNG) },
        "describe",
      );
      expect(caption).toBe("a fictional pier");
      expect(calls[0]!.url).toContain("/api/generate");
      const body = JSON.parse(calls[0]!.body) as { model: string; images: string[] };
      expect(body.model).toBe("llava");
      expect(body.images).toEqual([PHOTO_PNG.toString("base64")]);
    } finally {
      config.vlmModel = prev;
    }
  });

  test("describeImage uses the mock when MINIME_MOCK_OLLAMA=1", async () => {
    expect(config.mockOllama).toBe(true);
    const caption = await describeImage({
      mime: "image/png",
      base64: "ignored",
      sha256: sha256Hex(PHOTO_PNG),
      tier: 2,
    });
    expect(caption).toBe(PHOTO_CAPTION);
  });
});
