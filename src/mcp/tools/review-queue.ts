import { z } from "zod";
import { openReviewItems, parentMeta, resolveReviewItem } from "../../db/repo";
import { type SourceRef, ToolError, envelope } from "../envelope";
import type { ToolDef } from "./registry";

const KINDS = ["contradiction", "stale", "duplicate", "decision_review", "inbox_unfiled"] as const;

// Stale payloads carry a label captured at dream time, which may title a row that is
// above the caller's current tier — re-resolve through the tier-filtered parentMeta and
// mask what the caller may not see (row IDs are fine, titles are not).
async function maskStaleLabel(item: any): Promise<any> {
  if (item.kind !== "stale" || !item.payload?.type || !item.payload?.id) return item;
  try {
    const meta = await parentMeta(item.payload.type, [item.payload.id]);
    const visible = meta.get(item.payload.id);
    return {
      ...item,
      payload: { ...item.payload, label: visible ? visible.title : "[above current tier]" },
    };
  } catch {
    return item;
  }
}

export const reviewQueueTool: ToolDef = {
  name: "minime_review_queue",
  description:
    "List open review-queue items (contradiction | stale | duplicate | decision_review | inbox_unfiled), or resolve one as 'resolved' | 'dismissed'. The queue is flag-only: resolving never edits the flagged rows themselves.",
  schema: {
    action: z.enum(["list", "resolve"]).default("list"),
    kind: z.enum(KINDS).optional(),
    id: z.string().uuid().optional(),
    status: z.enum(["resolved", "dismissed"]).optional(),
  },
  handler: async (params) => {
    if (params.action === "resolve") {
      if (!params.id || !params.status)
        throw new ToolError("BAD_INPUT", "resolve requires id and status");
      await resolveReviewItem(params.id, params.status);
      return envelope({ resolved: params.id, status: params.status }, [
        { type: "review_item", id: params.id, created_by: "system" },
      ]);
    }
    const items = [];
    for (const item of await openReviewItems(params.kind)) items.push(await maskStaleLabel(item));
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
