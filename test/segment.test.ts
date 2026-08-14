import { afterEach, describe, expect, test } from "bun:test";
import {
  extractOrgNames,
  extractPersonNames,
  heuristicSegmentEntities,
  llmSegmentCue,
  parseLlmEntityPlan,
  planCaptureEntities,
  resolveEntityPlan,
} from "../src/pipeline/segment";
import { config } from "../src/util/config";
import { resetDb, testSql } from "./helpers";

const REPRO = `I emailed three fictional suppliers about calibration gel for Project SILDRE:
Northstar Reagents AS (Bergen), Bluefin Labs AS (Oslo), and Aster Bio AS (Trondheim).
Nadia Rossi, the sales lead at Corvid Biotech, was asked to help.`;

describe("planCaptureEntities", () => {
  test("the multi-supplier repro yields three AS orgs, Corvid, and Nadia Rossi", () => {
    const orgs = extractOrgNames(REPRO);
    expect(orgs).toEqual(
      expect.arrayContaining([
        "Northstar Reagents AS",
        "Bluefin Labs AS",
        "Aster Bio AS",
        "Corvid Biotech",
      ]),
    );
    expect(extractPersonNames(REPRO, orgs)).toEqual(["Nadia Rossi"]);

    const plan = planCaptureEntities(REPRO);
    expect(plan.kind).toBe("entities");
    if (plan.kind !== "entities") return;
    expect(plan.entities.filter((e) => e.kind === "org")).toHaveLength(4);
    expect(plan.entities.filter((e) => e.kind === "person")).toEqual([
      { kind: "person", name: "Nadia Rossi" },
    ]);
  });

  test("a single-org or single-person capture is left alone", () => {
    expect(planCaptureEntities("emailed Fjordsonics AS about the hydrophone order").kind).toBe(
      "none",
    );
    expect(planCaptureEntities("met Tomasz about the calibration rig").kind).toBe("none");
    expect(planCaptureEntities("todo: renew passport by 2026-08-01").kind).toBe("none");
  });

  test("an enumeration without parseable names is uncertain, not a guess", () => {
    const plan = planCaptureEntities(
      "I emailed three suppliers about calibration gel but I forgot their names.",
    );
    expect(plan).toEqual({
      kind: "uncertain",
      reason: "enumerated companies or people could not be parsed into named items",
    });
  });

  test("English lowercase 'as' is not a second legal suffix", () => {
    expect(planCaptureEntities("emailed Fjordsonics AS as well as the hydrophone order").kind).toBe(
      "none",
    );
  });

  test("more than eight named entities is uncertain rather than a bulk mint", () => {
    const names = ["Alba", "Bore", "Cirrus", "Drift", "Eddy", "Fjord", "Gale", "Haze", "Islet"];
    const text = names.map((n) => `${n} Reagents AS`).join(", ");
    const plan = planCaptureEntities(text);
    expect(plan.kind).toBe("uncertain");
    if (plan.kind !== "uncertain") return;
    expect(plan.reason).toContain("too many");
  });
});

const AT_FROM =
  "I talked to Sigrid Halvorsen at Havlyd and Tomasz Berg at Fjordsonics about the hydrophone quote.";
const TWO_PEOPLE = "Coffee with Sigrid Halvorsen and Tomasz Berg about the quote.";
const TWO_ORGS = "I emailed Northstar Reagents and Aster Bio about calibration gel.";

describe("LLM segment cue and heuristic fallback", () => {
  test("two person-at-org clauses fire and extract both sides", () => {
    expect(llmSegmentCue(AT_FROM)).toBe(true);
    expect(heuristicSegmentEntities(AT_FROM)).toEqual({
      kind: "entities",
      entities: [
        { kind: "person", name: "Sigrid Halvorsen" },
        { kind: "org", name: "Havlyd" },
        { kind: "person", name: "Tomasz Berg" },
        { kind: "org", name: "Fjordsonics" },
      ],
    });
  });

  test("two First Last names after a meet verb fire; Alice and Bob do not", () => {
    expect(llmSegmentCue(TWO_PEOPLE)).toBe(true);
    expect(heuristicSegmentEntities(TWO_PEOPLE)).toEqual({
      kind: "entities",
      entities: [
        { kind: "person", name: "Sigrid Halvorsen" },
        { kind: "person", name: "Tomasz Berg" },
      ],
    });
    expect(llmSegmentCue("met Alice and Bob about the calibration rig")).toBe(false);
    expect(heuristicSegmentEntities("met Alice and Bob about the calibration rig").kind).toBe(
      "none",
    );
  });

  test("emailed multi-word names become orgs; a city pair without a contact verb does not", () => {
    expect(llmSegmentCue(TWO_ORGS)).toBe(true);
    expect(heuristicSegmentEntities(TWO_ORGS)).toEqual({
      kind: "entities",
      entities: [
        { kind: "org", name: "Northstar Reagents" },
        { kind: "org", name: "Aster Bio" },
      ],
    });
    expect(llmSegmentCue("Notes on New York and Los Angeles weather this week.")).toBe(false);
  });

  test("a single emailed name does not fire just because the body mentions a city", () => {
    expect(llmSegmentCue("I emailed Nadia Rossi about New York weather")).toBe(false);
  });
});

describe("parseLlmEntityPlan", () => {
  test("keeps two valid names and drops junk", () => {
    expect(
      parseLlmEntityPlan(
        JSON.stringify({
          entities: [
            { kind: "org", name: "Havlyd" },
            { kind: "person", name: "Sigrid Halvorsen" },
            { kind: "ship", name: "No" },
            { kind: "org", name: "!!" },
          ],
        }),
      ),
    ).toEqual({
      kind: "entities",
      entities: [
        { kind: "org", name: "Havlyd" },
        { kind: "person", name: "Sigrid Halvorsen" },
      ],
    });
  });

  test("junk, a single name, or more than eight names is none — never a guess", () => {
    expect(parseLlmEntityPlan("not-json")).toEqual({ kind: "none" });
    expect(
      parseLlmEntityPlan(JSON.stringify({ entities: [{ kind: "org", name: "Havlyd" }] })),
    ).toEqual({ kind: "none" });
    const many = Array.from({ length: 9 }, (_, i) => ({
      kind: "org" as const,
      name: `Vendor ${i} Labs`,
    }));
    expect(parseLlmEntityPlan(JSON.stringify({ entities: many }))).toEqual({ kind: "none" });
  });
});

describe("resolveEntityPlan", () => {
  const saved = {
    mockOllama: config.mockOllama,
    classifyProvider: config.classifyProvider,
    cloudMaxTier: config.cloudMaxTier,
    r1: config.providerRouteTier1,
    r2: config.providerRouteTier2,
    openrouterApiKey: config.openrouterApiKey,
  };
  afterEach(() => {
    config.mockOllama = saved.mockOllama;
    config.classifyProvider = saved.classifyProvider;
    config.cloudMaxTier = saved.cloudMaxTier;
    config.providerRouteTier1 = saved.r1;
    config.providerRouteTier2 = saved.r2;
    config.openrouterApiKey = saved.openrouterApiKey;
  });

  test("deterministic legal-suffix plans win and do not call the model", async () => {
    const repro = `I emailed three fictional suppliers about calibration gel:
Northstar Reagents AS, Bluefin Labs AS, and Aster Bio AS.`;
    let called = 0;
    const fetchFn = (async () => {
      called += 1;
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    config.mockOllama = false;
    const plan = await resolveEntityPlan(repro, fetchFn);
    expect(plan.kind).toBe("entities");
    expect(called).toBe(0);
  });

  test("mock mode uses the heuristic and does not fetch", async () => {
    let called = 0;
    const fetchFn = (async () => {
      called += 1;
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    const plan = await resolveEntityPlan(AT_FROM, fetchFn);
    expect(plan.kind).toBe("entities");
    expect(called).toBe(0);
  });

  test("live fallback is assumed-tier-2 classify and ignores a junk model body", async () => {
    await resetDb();
    config.mockOllama = false;
    config.classifyProvider = "ollama";
    const prompts: string[] = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
      prompts.push(body.prompt ?? "");
      return new Response(JSON.stringify({ response: "not-json" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const plan = await resolveEntityPlan(AT_FROM, fetchFn);
    expect(plan).toEqual({ kind: "none" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Sigrid Halvorsen");
    expect(prompts[0]).not.toMatch(/dear diary|journal/);
  });

  test("cloud fallback above the ceiling is none without fetch or egress", async () => {
    await resetDb();
    config.mockOllama = false;
    config.classifyProvider = "openrouter";
    config.openrouterApiKey = "test-key";
    config.cloudMaxTier = 1;
    config.providerRouteTier1 = undefined;
    config.providerRouteTier2 = undefined;
    let called = 0;
    const fetchFn = (async () => {
      called += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const [before] =
      await testSql`select count(*)::int as n from events where verb = 'egress:classify'`;
    const plan = await resolveEntityPlan(AT_FROM, fetchFn);
    const [after] =
      await testSql`select count(*)::int as n from events where verb = 'egress:classify'`;
    expect(plan).toEqual({ kind: "none" });
    expect(called).toBe(0);
    expect(after!.n - before!.n).toBe(0);
  });
});
