import { describe, expect, test } from "bun:test";
import { extractOrgNames, extractPersonNames, planCaptureEntities } from "../src/pipeline/segment";

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
