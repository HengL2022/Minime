import { z } from "zod";
import { getDecision, insertDecision, reviewDecision } from "../../db/repo";
import { indexParent } from "../../search/index-parent";
import { localDateStr, now } from "../../util/clock";
import { ToolError, envelope } from "../envelope";
import type { ToolDef } from "./registry";

function decisionMd(d: {
  question: string;
  options: unknown;
  choice?: string | null;
  reasoning?: string | null;
  expected_outcome?: string | null;
  actual_outcome?: string | null;
}): string {
  return [
    `# Decision: ${d.question}`,
    `Options: ${JSON.stringify(d.options)}`,
    d.choice ? `Choice: ${d.choice}` : "Status: open (no choice yet)",
    d.reasoning ? `Reasoning: ${d.reasoning}` : "",
    d.expected_outcome ? `Expected outcome: ${d.expected_outcome}` : "",
    d.actual_outcome ? `Actual outcome: ${d.actual_outcome}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const logDecisionTool: ToolDef = {
  name: "minime_log_decision",
  description:
    "Record a decision (question, options, criteria, choice, reasoning, expected outcome). Sets a review date; open decisions (no choice) surface in minime_state.",
  schema: {
    question: z.string().min(1),
    options: z.array(z.string()).min(1),
    criteria: z.array(z.string()).optional(),
    choice: z.string().optional(),
    reasoning: z.string().optional(),
    expected_outcome: z.string().optional(),
    review_in_days: z.number().int().min(1).max(3650).optional(),
  },
  handler: async (params, ctx) => {
    const days = params.review_in_days ?? 90;
    // Local calendar date N days out. Slicing a UTC instant (toISOString) would
    // land on the previous day when queried in the pre-dawn local window (local
    // past midnight, UTC not yet rolled over) — review dates must be the owner's
    // calendar day, not UTC's. See DECISIONS.md (state/journal/decision TZ fixes).
    const reviewAt = localDateStr(new Date(now().getTime() + days * 86_400_000));
    const { id } = await insertDecision({
      question: params.question,
      options: params.options,
      criteria: params.criteria,
      choice: params.choice ?? null,
      reasoning: params.reasoning ?? null,
      expectedOutcome: params.expected_outcome ?? null,
      reviewAt,
      createdBy: ctx.actor,
      source: "capture",
    });
    await indexParent(
      "decision",
      id,
      decisionMd({ ...params, options: params.options }),
      undefined,
      1,
    );
    return envelope({ decision_id: id, review_at: reviewAt, open: !params.choice }, [
      { type: "decision", id },
    ]);
  },
};

export const reviewDecisionTool: ToolDef = {
  name: "minime_review_decision",
  description:
    "Close the loop on a past decision: record what actually happened; optionally distill a lesson into a new principle linked back to the decision.",
  schema: {
    decision_id: z.string().uuid(),
    actual_outcome: z.string().min(1),
    lesson: z.string().optional(),
  },
  handler: async (params, ctx) => {
    const existing = await getDecision(params.decision_id, ctx.actor);
    if (!existing) throw new ToolError("NOT_FOUND", `decision ${params.decision_id} not found`);
    const { principleId } = await reviewDecision(
      params.decision_id,
      params.actual_outcome,
      params.lesson ?? null,
      ctx.actor,
    );
    await indexParent(
      "decision",
      params.decision_id,
      decisionMd({ ...existing, actual_outcome: params.actual_outcome }),
      undefined,
      existing.tier,
    );
    if (principleId && params.lesson) {
      await indexParent("principle", principleId, `# Principle\n\n${params.lesson}`, undefined, 1);
    }
    return envelope({ decision_id: params.decision_id, principle_id: principleId }, [
      { type: "decision", id: params.decision_id },
      ...(principleId ? [{ type: "principle", id: principleId }] : []),
    ]);
  },
};
