import { describe, expect, test } from "bun:test";
import { heuristicClassify } from "../src/pipeline/classify";
import {
  classifyStrongIntentLine,
  heuristicNarrativeIntents,
  llmIntentCue,
  parseLlmIntentPlan,
  planMixedIntents,
} from "../src/pipeline/intents";

const SUPPLIER = `I emailed three fictional suppliers about calibration gel for Project SILDRE:
Northstar Reagents AS (Bergen), Bluefin Labs AS (Oslo), and Aster Bio AS (Trondheim).
Nadia Rossi, the sales lead at Corvid Biotech, was asked to help.`;

describe("classifyStrongIntentLine", () => {
  test("recognizes line-start prefixes and interaction verbs", () => {
    expect(classifyStrongIntentLine("todo: send the SILDRE contract")?.type).toBe("task");
    expect(classifyStrongIntentLine("org: Fjordsonics AS")?.type).toBe("org");
    expect(classifyStrongIntentLine("person: Nadia Rossi")?.type).toBe("person");
    expect(classifyStrongIntentLine("note: they want the Q3 quote")?.type).toBe("note");
    expect(classifyStrongIntentLine("journal: today felt long")?.type).toBe("journal");
    expect(classifyStrongIntentLine("decision: keep the spare nodes")?.type).toBe("decision_note");
    expect(classifyStrongIntentLine("met Nadia Rossi about pricing")?.type).toBe("interaction");
    expect(classifyStrongIntentLine("called Tomasz about the hydrophone")?.type).toBe(
      "interaction",
    );
  });

  test("ignores mid-sentence mentions and empty identity names", () => {
    expect(classifyStrongIntentLine("please remind me after the todo list")).toBeNull();
    expect(classifyStrongIntentLine("we met last year at the choir")).toBeNull();
    expect(classifyStrongIntentLine("a long note about Fjordsonics AS")).toBeNull();
    expect(classifyStrongIntentLine("org: !!")).toBeNull();
  });
});

describe("heuristic note/journal prefixes", () => {
  test("note: and journal: classify even when the line is short", () => {
    expect(heuristicClassify("note: they want Q3")).toMatchObject({
      type: "note",
      fields: { title: "they want Q3" },
    });
    expect(heuristicClassify("journal: today felt long").type).toBe("journal");
  });

  test("Notes without a colon prefix stay on the ordinary path", () => {
    expect(
      heuristicClassify(
        "Notes on the fictional calibration-gel market around Trondheim, including why Fjordsonics AS quotes differently.",
      ).type,
    ).toBe("note");
  });
});

describe("planMixedIntents", () => {
  test("a prefixed task + meeting + note dump yields three items", () => {
    const plan = planMixedIntents(`todo: send the SILDRE contract
met Nadia Rossi about the Q3 quote
note: they want a written redline`);
    expect(plan.kind).toBe("items");
    if (plan.kind !== "items") return;
    expect(plan.items.map((item) => item.classification.type)).toEqual([
      "task",
      "interaction",
      "note",
    ]);
    expect(plan.items[0]!.text).toBe("todo: send the SILDRE contract");
  });

  test("same-type lines do not split", () => {
    expect(
      planMixedIntents(`todo: send the SILDRE contract
todo: book the wet-lab bench`).kind,
    ).toBe("none");
  });

  test("a narrative dump without prefixes plans task + meeting + note", () => {
    const narrative = `Need to send the SILDRE contract by Friday.

Had coffee with Nadia Rossi about the Q3 quote.

They want a written redline before the wet-lab booking.`;
    expect(llmIntentCue(narrative)).toBe(true);
    const plan = heuristicNarrativeIntents(narrative);
    expect(plan.kind).toBe("items");
    if (plan.kind !== "items") return;
    expect(plan.items.map((item) => item.classification.type)).toEqual([
      "task",
      "interaction",
      "note",
    ]);
  });

  test("the supplier repro and suffix-less meetings stay unsplit", () => {
    expect(planMixedIntents(SUPPLIER).kind).toBe("none");
    expect(llmIntentCue(SUPPLIER)).toBe(false);
    expect(heuristicNarrativeIntents(SUPPLIER).kind).toBe("none");
    expect(planMixedIntents("met Alice and Bob about the calibration rig").kind).toBe("none");
    expect(planMixedIntents("todo: renew passport by 2026-08-01").kind).toBe("none");
  });

  test("more than four mixed strong lines stay unsplit", () => {
    expect(
      planMixedIntents(`todo: a
met Nadia Rossi
note: b
decision: c
journal: d`).kind,
    ).toBe("none");
  });

  test("leading prose without a prefix dump stays unsplit", () => {
    expect(
      planMixedIntents(`some leftover context about the quote
todo: send the SILDRE contract
met Nadia Rossi about pricing`).kind,
    ).toBe("none");
  });

  test("a leading hint comment is stripped before planning", () => {
    const plan = planMixedIntents(`<!-- hint: task -->
todo: send the SILDRE contract
met Nadia Rossi about pricing`);
    expect(plan.kind).toBe("items");
    if (plan.kind !== "items") return;
    expect(plan.items).toHaveLength(2);
    expect(plan.items[0]!.classification.type).toBe("task");
  });

  test("continuation lines attach to the previous strong item", () => {
    const plan = planMixedIntents(`todo: send the SILDRE contract
include the redline comments from last week

met Nadia Rossi at Fjordsonics AS
she wants the Q3 quote in writing`);
    expect(plan.kind).toBe("items");
    if (plan.kind !== "items") return;
    expect(plan.items).toHaveLength(2);
    expect(plan.items[0]!.text).toContain("redline comments");
    expect(plan.items[1]!.text).toContain("Q3 quote");
    expect(plan.items[1]!.classification.type).toBe("interaction");
  });

  test("blank-line blocks with strong first lines also split", () => {
    const plan = planMixedIntents(`todo: send the SILDRE contract
include the redlines

called Tomasz about the hydrophone order`);
    expect(plan.kind).toBe("items");
    if (plan.kind !== "items") return;
    expect(plan.items.map((item) => item.classification.type)).toEqual(["task", "interaction"]);
  });
});

describe("parseLlmIntentPlan", () => {
  const source = `Need to send the SILDRE contract by Friday.

Had coffee with Nadia Rossi about the Q3 quote.

They want a written redline before the wet-lab booking.`;

  test("accepts two verbatim mixed excerpts", () => {
    const plan = parseLlmIntentPlan(
      JSON.stringify({
        items: [
          { type: "task", text: "Need to send the SILDRE contract by Friday." },
          { type: "interaction", text: "Had coffee with Nadia Rossi about the Q3 quote." },
        ],
      }),
      source,
    );
    expect(plan.kind).toBe("items");
    if (plan.kind !== "items") return;
    expect(plan.items.map((item) => item.classification.type)).toEqual(["task", "interaction"]);
  });

  test("junk, oversize, wrong type, and one type fail open", () => {
    expect(parseLlmIntentPlan("not-json", source).kind).toBe("none");
    expect(parseLlmIntentPlan(JSON.stringify({ items: "nope" }), source).kind).toBe("none");
    expect(
      parseLlmIntentPlan(
        JSON.stringify({
          items: [
            { type: "task", text: "Need to send the SILDRE contract by Friday." },
            { type: "interaction", text: "Had coffee with Nadia Rossi about the Q3 quote." },
            { type: "note", text: "They want a written redline before the wet-lab booking." },
            { type: "journal", text: "Need to send the SILDRE contract by Friday." },
            { type: "decision_note", text: "Had coffee with Nadia Rossi about the Q3 quote." },
          ],
        }),
        source,
      ).kind,
    ).toBe("none");
    expect(
      parseLlmIntentPlan(
        JSON.stringify({
          items: [
            { type: "spaceship", text: "Need to send the SILDRE contract by Friday." },
            { type: "interaction", text: "Had coffee with Nadia Rossi about the Q3 quote." },
          ],
        }),
        source,
      ).kind,
    ).toBe("none");
    expect(
      parseLlmIntentPlan(
        JSON.stringify({
          items: [
            { type: "task", text: "Need to send the SILDRE contract by Friday." },
            { type: "task", text: "They want a written redline before the wet-lab booking." },
          ],
        }),
        source,
      ).kind,
    ).toBe("none");
  });

  test("invented excerpts are dropped so a hallucinated pair cannot file", () => {
    expect(
      parseLlmIntentPlan(
        JSON.stringify({
          items: [
            { type: "task", text: "Need to send the SILDRE contract by Friday." },
            { type: "note", text: "Invented wet-lab booking that was never captured." },
          ],
        }),
        source,
      ).kind,
    ).toBe("none");
  });
});
