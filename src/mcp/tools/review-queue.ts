import { z } from "zod";
import { type ParentType, openReviewItems, parentMeta, resolveReviewItem } from "../../db/repo";
import { type SourceRef, ToolError, envelope } from "../envelope";
import type { ToolDef } from "./registry";

const KINDS = [
  "contradiction",
  "stale",
  "duplicate",
  "decision_review",
  "inbox_unfiled",
  "phantom_person",
] as const;
const HIDDEN = "[above current tier]";
const CONTENT_KEYS = new Set([
  "body",
  "body_md",
  "candidate_title",
  "entry_md",
  "existing_title",
  "question",
  "summary",
  "text",
  "title",
]);

function maskContentKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskContentKeys);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    out[key] = CONTENT_KEYS.has(key) ? HIDDEN : maskContentKeys(nested);
  }
  return out;
}

async function visibleTitle(type: ParentType, id: string, actor: string): Promise<string | null> {
  const meta = await parentMeta(type, [id], actor);
  return meta.get(id)?.title ?? null;
}

// Stale payloads carry a label captured at dream time, which may title a row that is
// above the caller's current tier — re-resolve through the tier-filtered parentMeta and
// mask what the caller may not see (row IDs are fine, titles are not).
async function maskReviewPayload(item: any, actor: string): Promise<any> {
  let payload = maskContentKeys(item.payload ?? {}) as Record<string, unknown>;

  if (item.kind === "stale" && item.payload?.type && item.payload?.id) {
    try {
      payload = {
        ...payload,
        label: (await visibleTitle(item.payload.type, item.payload.id, actor)) ?? HIDDEN,
      };
    } catch {
      payload = { ...payload, label: HIDDEN };
    }
  }

  if (item.kind === "duplicate" && typeof item.payload?.existing_task_id === "string") {
    payload = {
      ...payload,
      existing_title: (await visibleTitle("task", item.payload.existing_task_id, actor)) ?? HIDDEN,
    };
  }

  if (item.kind === "decision_review" && typeof item.payload?.decision_id === "string") {
    payload = {
      ...payload,
      question: (await visibleTitle("decision", item.payload.decision_id, actor)) ?? HIDDEN,
    };
  }

  return { ...item, payload };
}

async function maskStaleLabel(item: any, actor: string): Promise<any> {
  try {
    return maskReviewPayload(item, actor);
  } catch {
    return { ...item, payload: maskContentKeys(item.payload ?? {}) };
  }
}

export const reviewQueueTool: ToolDef = {
  name: "minime_review_queue",
  description:
    "List open review-queue items (contradiction | stale | duplicate | decision_review | inbox_unfiled | phantom_person), or resolve one as 'resolved' | 'dismissed'. The queue is flag-only: resolving never edits the flagged rows themselves.",
  schema: {
    action: z.enum(["list", "resolve"]).default("list"),
    kind: z.enum(KINDS).optional(),
    id: z.string().uuid().optional(),
    status: z.enum(["resolved", "dismissed"]).optional(),
  },
  handler: async (params, ctx) => {
    if (params.action === "resolve") {
      if (!params.id || !params.status)
        throw new ToolError("BAD_INPUT", "resolve requires id and status");
      await resolveReviewItem(params.id, params.status);
      return envelope({ resolved: params.id, status: params.status }, [
        { type: "review_item", id: params.id, created_by: "system" },
      ]);
    }
    const items = [];
    for (const item of await openReviewItems(params.kind))
      items.push(await maskStaleLabel(item, ctx.actor));
    const sources: SourceRef[] = items.map((i: any) => ({
      type: "review_item",
      id: i.id,
      updated_at: i.created_at,
      created_by: "system",
    }));
    return envelope({ items }, sources, {
      gaps: items.length === 0 ? ["review queue is empty — nothing to triage"] : undefined,
    });
  },
};
