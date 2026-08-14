// W2-4: minime_correct is the "that's wrong, fix it" tool — the first content-mutation tool
// beyond tasks. One tool, three actions:
//   - amend:   insert a successor row with the patched fields, stamp the original superseded_by/
//              superseded_at (migration 028). The original is never edited or deleted (I5) —
//              both rows stay readable by id and both are cited as sources.
//   - retract: stamp superseded_at with no successor (soft withdrawal) and drop the row's chunks
//              so it stops matching search. The row itself stays readable by id.
//   - retier:  promote a note (page) — and its chunks/edges — from tier 1 to tier 2. Up-only;
//              any other type or direction is refused.
//
// Tier boundary (the risk this tool exists to get right): getRow already applies the tier
// predicate, so a locked session's attempt to touch a tier-2 row 404s before any write is even
// attempted; supersedeRow/retractRow (repo.ts) independently re-check the same bound at the SQL
// layer via 028's tier_update RLS policy, so a locked session gets the identical NOT_FOUND even
// if it somehow reached the write. No session, locked or not, can ever reach a tier-0 row —
// getRow's predicate has a `tier >= 1` floor with no exception.
//
// task rows are explicitly out of scope: minime_upsert_task already edits or drops a task, so
// this tool's type enum only has journal/interaction/decision/note.

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CorrectionTargetNotFoundError,
  type ParentType,
  allowedTier,
  getRow,
  insertDecision,
  insertInteraction,
  insertJournal,
  logEvent,
  retierPageEdges,
  retractRow,
  setPageChunkTiers,
  setPageTier,
  supersedeRow,
  upsertPage,
} from "../../db/repo";
import { indexParent } from "../../search/index-parent";
import { auditPayload } from "../../util/audit-payload";
import { localDateStr } from "../../util/clock";
import { type Envelope, ToolError, envelope } from "../envelope";
import type { ToolCtx, ToolDef } from "./registry";

const CORRECT_TYPE = ["journal", "interaction", "decision", "note"] as const;
type CorrectType = (typeof CORRECT_TYPE)[number];
const ACTIONS = ["amend", "retract", "retier"] as const;

// Owner-facing type -> the ParentType (repo.ts PARENTS map) it reads/writes through. "note" is
// the only one that differs from its own name (it is a `pages` row).
const PARENT_TYPE: Record<CorrectType, ParentType> = {
  journal: "journal",
  interaction: "interaction",
  decision: "decision",
  note: "page",
};

function assertBadInput(condition: boolean, message: string): void {
  if (!condition) throw new ToolError("BAD_INPUT", message);
}

function notFound(type: CorrectType, id: string): ToolError {
  return new ToolError("NOT_FOUND", `${type} ${id} not found or above current access tier`);
}

// Deliberately smaller than logDecisionTool's decisionMd (decisions.ts, not in this task's file
// list): only the four fields minime_correct can actually patch. The rest (options, criteria,
// falsifier, stakes, reversibility, confidence, decided_at, review_at) carry over unchanged and
// don't need re-stating in the indexed text.
function decisionCorrectionMd(
  question: string,
  choice: string | null,
  reasoning: string | null,
  expectedOutcome: string | null,
): string {
  return [
    `# Decision: ${question}`,
    choice ? `Choice: ${choice}` : "Status: open (no choice yet)",
    reasoning ? `Reasoning: ${reasoning}` : "",
    expectedOutcome ? `Expected outcome: ${expectedOutcome}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function handleAmend(
  type: CorrectType,
  parentType: ParentType,
  old: Record<string, any>,
  params: Record<string, any>,
  ctx: ToolCtx,
): Promise<Envelope> {
  const tier = Number(old.tier) as 1 | 2;
  const std = {
    createdBy: ctx.actor,
    source: "correction",
    derivedFrom: old.id as string,
    supersedesId: old.id as string,
    tier,
  };

  let newId: string;
  if (type === "journal") {
    assertBadInput(
      params.entry_md !== undefined ||
        params.mood !== undefined ||
        params.energy !== undefined ||
        params.at !== undefined,
      "provide at least one field to amend (entry_md, mood, energy, at)",
    );
    const entryMd = params.entry_md ?? old.entry_md;
    const mood = params.mood !== undefined ? params.mood : old.mood;
    const energy = params.energy !== undefined ? params.energy : old.energy;
    const at = params.at ? new Date(params.at) : new Date(old.at);
    const inserted = await insertJournal({ entryMd, mood, energy, at, ...std });
    newId = inserted.id;
    await indexParent("journal", newId, entryMd, `Journal ${localDateStr(at, ctx.timeZone)}`, tier);
  } else if (type === "interaction") {
    assertBadInput(
      params.summary !== undefined || params.kind !== undefined || params.occurred_at !== undefined,
      "provide at least one field to amend (summary, kind, occurred_at)",
    );
    const summary = params.summary ?? old.summary;
    const kind = params.kind ?? old.kind;
    const occurredAt = params.occurred_at
      ? new Date(params.occurred_at)
      : new Date(old.occurred_at);
    const inserted = await insertInteraction({
      personId: old.person_id ?? undefined,
      orgId: old.org_id ?? undefined,
      kind,
      summary,
      occurredAt,
      ...std,
    });
    newId = inserted.id;
    // Mirrors logInteractionTool's own indexed text shape (interactions.ts): kind + summary,
    // no title. The old row's person/org NAME isn't in `old` (only its id), and re-resolving it
    // here would be an extra read for marginal search-recall gain — not worth it for a first cut.
    await indexParent("interaction", newId, `${kind}\n\n${summary}`, undefined, tier);
  } else if (type === "decision") {
    assertBadInput(
      params.question !== undefined ||
        params.choice !== undefined ||
        params.reasoning !== undefined ||
        params.expected_outcome !== undefined,
      "provide at least one field to amend (question, choice, reasoning, expected_outcome)",
    );
    const question = params.question ?? old.question;
    const choice = params.choice !== undefined ? params.choice : old.choice;
    const reasoning = params.reasoning !== undefined ? params.reasoning : old.reasoning;
    const expectedOutcome =
      params.expected_outcome !== undefined ? params.expected_outcome : old.expected_outcome;
    const inserted = await insertDecision({
      question,
      options: old.options,
      criteria: old.criteria ?? undefined,
      choice,
      reasoning,
      expectedOutcome,
      falsifier: old.falsifier,
      stakes: old.stakes,
      reversibility: old.reversibility,
      confidence: old.confidence,
      decidedAt: old.decided_at,
      reviewAt: old.review_at,
      ...std,
    });
    newId = inserted.id;
    // No transcript/branch rows are copied — those are separate child tables, not fields of the
    // `decisions` row itself, and out of this tool's patch-field scope (spec: question/choice/
    // reasoning/expected_outcome only).
    await indexParent(
      "decision",
      newId,
      decisionCorrectionMd(question, choice, reasoning, expectedOutcome),
      undefined,
      tier,
    );
  } else {
    assertBadInput(
      params.title !== undefined || params.body_md !== undefined,
      "provide at least one field to amend (title, body_md)",
    );
    const title = params.title ?? old.title;
    const bodyMd = params.body_md ?? old.body_md;
    // pages.path is unique, so a successor page can never reuse the original's path — mint a
    // fresh one in a namespace reserved for corrections (distinct from brain-sync's real file
    // paths and from derived/notes/... compiled-note paths). This row is DB-only: no markdown
    // file is written for it, unlike a fileRow "note" (watcher.ts). A future brainSync() pass
    // would not recognize this path as a live file and could soft-delete it (status='deleted')
    // the same way any other file-less page would — it stays readable by id either way (I5), but
    // this is a known limitation of a first cut, not something this task's file scope covers.
    const path = `derived/corrections/${crypto.randomUUID()}.md`;
    const contentHash = createHash("sha256").update(bodyMd).digest("hex");
    const result = await upsertPage({ path, title, bodyMd, contentHash, ...std });
    newId = result.id;
    await indexParent("page", newId, bodyMd, title, tier);
  }

  try {
    await supersedeRow(parentType, old.id, newId);
  } catch (e) {
    if (e instanceof CorrectionTargetNotFoundError) throw notFound(type, old.id);
    throw e;
  }

  await logEvent({
    actor: ctx.actor,
    verb: "correct:amend",
    payload: auditPayload.correctAmend({
      type,
      oldId: old.id,
      newId,
      tier,
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
    }),
  });

  return envelope({ action: "amend" as const, new_id: newId, superseded_id: old.id as string }, [
    { type: parentType, id: old.id },
    { type: parentType, id: newId },
  ]);
}

async function handleRetract(
  type: CorrectType,
  parentType: ParentType,
  old: Record<string, any>,
  params: Record<string, any>,
  ctx: ToolCtx,
): Promise<Envelope> {
  const tier = Number(old.tier) as 1 | 2;
  try {
    await retractRow(parentType, old.id);
  } catch (e) {
    if (e instanceof CorrectionTargetNotFoundError) throw notFound(type, old.id);
    throw e;
  }

  await logEvent({
    actor: ctx.actor,
    verb: "correct:retract",
    payload: auditPayload.correctRetract({
      type,
      id: old.id,
      tier,
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
    }),
  });

  return envelope({ action: "retract" as const, superseded_id: old.id as string }, [
    { type: parentType, id: old.id },
  ]);
}

async function handleRetier(params: Record<string, any>, ctx: ToolCtx): Promise<Envelope> {
  const old = await getRow("page", params.id, ctx.actor);
  if (!old) throw notFound("note", params.id);
  if (params.to_tier !== 2) {
    throw new ToolError("BAD_INPUT", "retier is up-only: to_tier must be 2 (tier 1 to tier 2)");
  }
  // setPageTier/setPageChunkTiers/retierPageEdges are idempotent/monotonic (repo.ts), but their
  // RLS tier_update WITH CHECK would reject a locked session's UPDATE to tier 2 outright (a raw
  // Postgres RLS error, not a clean ToolError) — check up front for a clear refusal instead.
  if ((await allowedTier(ctx.actor)) !== 2) {
    throw new ToolError(
      "BAD_INPUT",
      "retier to tier 2 requires an approved tier-2 unlock (minime_unlock)",
    );
  }
  const fromTier = Number(old.tier) as 1 | 2;
  await setPageTier(params.id, 2);
  await setPageChunkTiers(params.id, 2);
  await retierPageEdges(params.id, 2);

  await logEvent({
    actor: ctx.actor,
    verb: "correct:retier",
    payload: auditPayload.correctRetier({
      id: params.id,
      fromTier,
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
    }),
  });

  return envelope({ action: "retier" as const, superseded_id: params.id as string }, [
    { type: "page", id: params.id },
  ]);
}

export const correctTool: ToolDef = {
  name: "minime_correct",
  description:
    "Correct a typed row after the fact: journal | interaction | decision | note (page). " +
    "action=amend inserts a successor row carrying the patched fields (source='correction', " +
    "tier preserved from the original, full I5 provenance) and stamps the original " +
    "superseded_by/superseded_at — the original is never edited or deleted, so both remain " +
    "readable by id (e.g. minime_get_context) and both are cited as sources. Patchable fields: " +
    "journal — entry_md, mood, energy, at; interaction — summary, kind, occurred_at; decision — " +
    "question, choice, reasoning, expected_outcome; note — title, body_md. Any field left out " +
    "carries over unchanged from the original. action=retract withdraws a row with no successor " +
    "(stamps superseded_at only) and drops it from search; the row stays readable by id. " +
    "action=retier promotes a note's tier — and its chunks/edges — from 1 to 2 (to_tier must be " +
    "2); up-only, requires an approved tier-2 unlock, and refuses every other type. Every action " +
    "is bounded by what this session can currently read: a locked session cannot correct a " +
    "tier-2 row, and no session can ever correct a tier-0 row. task rows are not supported here " +
    "— use minime_upsert_task to edit or drop a task. Optional reason (<=200 chars) is recorded " +
    "in the audit trail only, never on the row itself.",
  schema: {
    type: z.enum(CORRECT_TYPE),
    action: z.enum(ACTIONS),
    id: z.string().uuid(),
    reason: z.string().min(1).max(200).optional(),
    // amend patch fields — only the ones matching `type` are read.
    entry_md: z.string().min(1).optional(),
    mood: z.number().int().min(1).max(5).optional(),
    energy: z.number().int().min(1).max(5).optional(),
    at: z.string().datetime({ offset: true }).optional(),
    summary: z.string().min(1).optional(),
    kind: z.enum(["meeting", "call", "message", "email", "note"]).optional(),
    occurred_at: z.string().datetime({ offset: true }).optional(),
    question: z.string().min(1).optional(),
    choice: z.string().optional(),
    reasoning: z.string().optional(),
    expected_outcome: z.string().optional(),
    title: z.string().min(1).optional(),
    body_md: z.string().min(1).optional(),
    // retier only
    to_tier: z.union([z.literal(1), z.literal(2)]).optional(),
  },
  handler: async (params, ctx) => {
    const type = params.type as CorrectType;

    if (params.action === "retier") {
      assertBadInput(type === "note", "retier is supported only for type=note (pages)");
      return handleRetier(params, ctx);
    }

    const parentType = PARENT_TYPE[type];
    const old = await getRow(parentType, params.id, ctx.actor);
    if (!old) throw notFound(type, params.id);
    if (old.superseded_at !== null) {
      throw new ToolError(
        "BAD_INPUT",
        "this row is already superseded — amend or retract the current row instead",
      );
    }

    if (params.action === "retract") return handleRetract(type, parentType, old, params, ctx);
    return handleAmend(type, parentType, old, params, ctx);
  },
};
