import { describe, expect, test } from "bun:test";
import { BAKEOFF_IMAGES } from "../fixtures/parse/images";
import {
  parseBakeoffArgs,
  renderBakeoffScorecard,
  scoreBakeoff,
  tokenJaccard,
} from "../scripts/eval-vlm-bakeoff";

describe("VLM bake-off harness", () => {
  test("token Jaccard is 1 for identical gold and 0 for disjoint tokens", () => {
    expect(tokenJaccard("Harbor pier at dusk", "Harbor pier at dusk")).toBe(1);
    expect(tokenJaccard("harbor pier", "cafe receipt")).toBe(0);
    expect(tokenJaccard("harbor pier dusk", "pier at dusk")).toBeCloseTo(0.5, 10);
  });

  test("args require a live model and reject unknown flags", () => {
    const prev = process.env.VLM_MODEL;
    process.env.VLM_MODEL = undefined;
    try {
      expect(parseBakeoffArgs([])).toEqual({ mode: "mock", publish: false, models: ["mock-hash"] });
      expect(() => parseBakeoffArgs(["--mode", "live"])).toThrow(/vlm_bakeoff_model_required/);
      expect(parseBakeoffArgs(["--mode", "live", "--models", "moondream"])).toEqual({
        mode: "live",
        publish: false,
        models: ["moondream"],
      });
      expect(() => parseBakeoffArgs(["--unknown"])).toThrow(/vlm_bakeoff_args_invalid/);
    } finally {
      if (prev === undefined) process.env.VLM_MODEL = undefined;
      else process.env.VLM_MODEL = prev;
    }
  });

  test("mock path scores 1.0 on every sealed gold caption", async () => {
    const scores = await scoreBakeoff({ mode: "mock", publish: false, models: ["mock-hash"] });
    expect(scores).toHaveLength(BAKEOFF_IMAGES.length);
    expect(scores.every((row) => row.jaccard === 1)).toBe(true);
    expect(scores.map((row) => row.id)).toEqual(BAKEOFF_IMAGES.map((image) => image.id));
  });

  test("scorecard names the mock model and mean Jaccard", async () => {
    const scores = await scoreBakeoff({ mode: "mock", publish: false, models: ["mock-hash"] });
    const markdown = renderBakeoffScorecard({
      date: "2026-08-15",
      mode: "mock",
      models: ["mock-hash"],
      scores,
    });
    expect(markdown).toContain("# VLM bake-off — 2026-08-15");
    expect(markdown).toContain("fictional labeled PNG cards");
    expect(markdown).toContain("Mean Jaccard: **1.000**");
    expect(markdown).toContain("harbor-pier");
    expect(markdown).toContain("Cloud VLM routes stay rejected");
  });
});
