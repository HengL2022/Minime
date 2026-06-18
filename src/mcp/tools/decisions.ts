import { z } from "zod";
import {
  decisionBranchesForIndex,
  getDecision,
  insertDecision,
  reviewDecision,
} from "../../db/repo";
import { indexParent } from "../../search/index-parent";
import { localDateStr, localDateTimeToUtc, now } from "../../util/clock";
import { config } from "../../util/config";
import { ToolError, envelope } from "../envelope";
import type { ToolDef } from "./registry";

const QUESTION_KEYS = [
  "fork",
  "falsifier",
  "tension",
  "prediction",
  "stakes",
  "review",
  "freeform",
] as const;
const REVERSIBILITY = ["reversible", "costly", "irreversible"] as const;
const BRANCH_STATUS = ["chosen", "rejected", "considered"] as const;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?$/;
const ISO_DATETIME_PARTS =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?$/;

function validDateOnly(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const d = new Date(Date.UTC(year!, month! - 1, day!));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month! - 1 && d.getUTCDate() === day;
}

function decisionMd(d: {
  question: string;
  options: unknown;
  choice?: string | null;
  reasoning?: string | null;
  falsifier?: string | null;
  stakes?: string | null;
  reversibility?: string | null;
  confidence?: number | null;
  expected_outcome?: string | null;
  actual_outcome?: string | null;
  outcome_score?: number | null;
}): string {
  return [
    `# Decision: ${d.question}`,
    `Options: ${JSON.stringify(d.options)}`,
    d.choice ? `Choice: ${d.choice}` : "Status: open (no choice yet)",
    d.reasoning ? `Reasoning: ${d.reasoning}` : "",
    d.falsifier ? `Falsifier: ${d.falsifier}` : "",
    d.stakes ? `Stakes: ${d.stakes}` : "",
    d.reversibility ? `Reversibility: ${d.reversibility}` : "",
    d.confidence !== undefined && d.confidence !== null ? `Confidence: ${d.confidence}/100` : "",
    d.expected_outcome ? `Expected outcome: ${d.expected_outcome}` : "",
    d.actual_outcome ? `Actual outcome: ${d.actual_outcome}` : "",
    d.outcome_score !== undefined && d.outcome_score !== null
      ? `Outcome score: ${d.outcome_score}/100`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function branchMd(question: string, b: any): string {
  return [
    `# Decision branch: ${b.label}`,
    `Decision: ${question}`,
    `Status: ${b.status}`,
    b.note ? `Note: ${b.note}` : "",
    b.would_be_right_if ? `Would be right if: ${b.would_be_right_if}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseDecisionDate(value?: string, timeZone = config.tz): Date | null {
  if (!value) return null;
  if (!DATE_ONLY.test(value) && !ISO_DATETIME.test(value)) {
    throw new ToolError("BAD_INPUT", "invalid decided_at");
  }
  if (!validDateOnly(value.slice(0, 10))) throw new ToolError("BAD_INPUT", "invalid decided_at");
  if (DATE_ONLY.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return localDateTimeToUtc(year!, month!, day!, 12, 0, 0, 0, timeZone);
  }
  const m = ISO_DATETIME_PARTS.exec(value);
  if (!m) throw new ToolError("BAD_INPUT", "invalid decided_at");
  const [, year, month, day, hour, minute, second, fraction, offset] = m;
  const d = offset
    ? new Date(value)
    : localDateTimeToUtc(
        Number(year),
        Number(month),
        Number(day),
        Number(hour),
        Number(minute),
        Number(second ?? 0),
        Number((fraction ?? "0").padEnd(3, "0").slice(0, 3)),
        timeZone,
      );
  if (Number.isNaN(d.getTime())) throw new ToolError("BAD_INPUT", "invalid decided_at");
  return d;
}

function validDecisionDate(value: string): boolean {
  try {
    return parseDecisionDate(value) !== null;
  } catch {
    return false;
  }
}

async function indexDecisionBranches(decisionId: string, question: string): Promise<void> {
  for (const b of await decisionBranchesForIndex(decisionId)) {
    await indexParent("decision_branch", b.id, branchMd(question, b), b.label, b.tier);
  }
}

export const logDecisionTool: ToolDef = {
  name: "minime_log_decision",
  description:
    "Record a decision or six-question decision interview with options, choice/reasoning, falsifier, stakes, reversibility, confidence, transcript turns, branch rows, tier, and review date. Open decisions surface in minime_state.",
  schema: {
    question: z.string().min(1),
    options: z.array(z.string()).min(1),
    criteria: z.array(z.string()).optional(),
    choice: z.string().optional(),
    reasoning: z.string().optional(),
    expected_outcome: z.string().optional(),
    falsifier: z.string().optional(),
    stakes: z.string().optional(),
    reversibility: z.enum(REVERSIBILITY).optional(),
    confidence: z.number().int().min(0).max(100).optional(),
    decided_at: z.string().refine(validDecisionDate).optional(),
    review_at: z.string().refine(validDateOnly).optional(),
    tier: z.union([z.literal(1), z.literal(2)]).optional(),
    transcript: z
      .array(
        z.object({
          question_key: z.enum(QUESTION_KEYS),
          prompt: z.string().min(1),
          answer: z.string().min(1),
        }),
      )
      .optional(),
    branches: z
      .array(
        z.object({
          label: z.string().min(1),
          status: z.enum(BRANCH_STATUS).optional(),
          note: z.string().optional(),
          would_be_right_if: z.string().optional(),
        }),
      )
      .optional(),
    review_in_days: z.number().int().min(1).max(3650).optional(),
  },
  handler: async (params, ctx) => {
    const days = params.review_in_days ?? 90;
    // Local calendar date N days out. Slicing a UTC instant (toISOString) would
    // land on the previous day when queried in the pre-dawn local window (local
    // past midnight, UTC not yet rolled over) — review dates must be the owner's
    // calendar day, not UTC's. See DECISIONS.md (state/journal/decision TZ fixes).
    const reviewAt =
      params.review_at ?? localDateStr(new Date(now().getTime() + days * 86_400_000), ctx.timeZone);
    const { id } = await insertDecision({
      question: params.question,
      options: params.options,
      criteria: params.criteria,
      choice: params.choice ?? null,
      reasoning: params.reasoning ?? null,
      expectedOutcome: params.expected_outcome ?? null,
      falsifier: params.falsifier ?? null,
      stakes: params.stakes ?? null,
      reversibility: params.reversibility ?? null,
      confidence: params.confidence ?? null,
      decidedAt: parseDecisionDate(params.decided_at, ctx.timeZone),
      reviewAt,
      tier: params.tier ?? 1,
      transcript: params.transcript?.map((t: any) => ({
        questionKey: t.question_key,
        prompt: t.prompt,
        answer: t.answer,
      })),
      branches: params.branches?.map((b: any) => ({
        label: b.label,
        status: b.status,
        note: b.note ?? null,
        wouldBeRightIf: b.would_be_right_if ?? null,
      })),
      createdBy: ctx.actor,
      source: "capture",
    });
    await indexParent(
      "decision",
      id,
      decisionMd({ ...params, options: params.options }),
      undefined,
      params.tier ?? 1,
    );
    await indexDecisionBranches(id, params.question);
    await import("../../pipeline/decision-digest")
      .then((m) => m.draftDecisionDigest(id))
      .catch(() => {});
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
    outcome_score: z.number().int().min(0).max(100).optional(),
  },
  handler: async (params, ctx) => {
    const existing = await getDecision(params.decision_id, ctx.actor);
    if (!existing) throw new ToolError("NOT_FOUND", `decision ${params.decision_id} not found`);
    const { principleId } = await reviewDecision(
      params.decision_id,
      params.actual_outcome,
      params.lesson ?? null,
      ctx.actor,
      params.outcome_score ?? null,
    );
    await indexParent(
      "decision",
      params.decision_id,
      decisionMd({
        ...existing,
        actual_outcome: params.actual_outcome,
        outcome_score: params.outcome_score ?? existing.outcome_score,
      }),
      undefined,
      existing.tier,
    );
    if (principleId && params.lesson) {
      await indexParent("principle", principleId, `# Principle\n\n${params.lesson}`, undefined, 1);
    }
    await import("../../pipeline/decision-digest")
      .then((m) => m.draftDecisionDigest(params.decision_id))
      .catch(() => {});
    return envelope({ decision_id: params.decision_id, principle_id: principleId }, [
      { type: "decision", id: params.decision_id },
      ...(principleId ? [{ type: "principle", id: principleId }] : []),
    ]);
  },
};
