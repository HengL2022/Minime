import { z } from "zod";
import {
  type ParentType,
  allowedTier,
  edgeVisibleAtTier,
  getInboxItem,
  openReviewItems,
  parentMeta,
  resolveReviewItem,
} from "../../db/repo";
import { readArchivedCapture, storedClassification } from "../../pipeline/watcher";
import { type SourceRef, ToolError, envelope } from "../envelope";
import type { ToolDef } from "./registry";

const KINDS = [
  "contradiction",
  "stale",
  "duplicate",
  "decision_review",
  "inbox_unfiled",
  "phantom_person",
  "extract_suspect",
] as const;
const HIDDEN = "[above current tier]";
// Distinct from HIDDEN: the tier check passed but the archived bytes could not be proven
// authentic (missing file, hash mismatch). Never fabricate text in that case.
const CAPTURE_UNAVAILABLE = "[archive unavailable]";
const OMITTED_KEYS = new Set(["classifier", "classifier_output", "raw_path"]);
const CONTENT_KEYS = new Set([
  "body",
  "body_md",
  "candidate_title",
  "entry_md",
  "existing_title",
  "question",
  "reason",
  "summary",
  "text",
  "title",
]);

function maskContentKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskContentKeys);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    // Historical inbox_unfiled rows may contain a host-absolute source path and
    // the classifier's complete structured response. Neither is needed to triage
    // the queue, and neither crosses the MCP boundary.
    if (OMITTED_KEYS.has(key)) continue;
    out[key] = CONTENT_KEYS.has(key) ? HIDDEN : maskContentKeys(nested);
  }
  return out;
}

async function visibleTitle(type: ParentType, id: string, actor: string): Promise<string | null> {
  const meta = await parentMeta(type, [id], actor);
  return meta.get(id)?.title ?? null;
}

// extract_suspect endpoints ({type, id, name}) carry names the dream job captured in system
// context (no tier predicate). Even when the edge itself is visible, re-resolve each name
// through the tier-filtered parentMeta so e.g. a tier-2 person's name never rides a tier-1
// edge — anything parentMeta won't return at the caller's tier comes back masked.
async function visibleEndpoint(ep: any, actor: string): Promise<any> {
  if (!ep || typeof ep !== "object" || ep.name == null) return ep;
  if (ep.type !== "person" && ep.type !== "org") return ep; // page/etc. srcs store no name
  return { ...ep, name: (await visibleTitle(ep.type, ep.id, actor)) ?? HIDDEN };
}

function maskEndpointName(ep: any): any {
  if (!ep || typeof ep !== "object" || ep.name == null) return ep;
  return { ...ep, name: HIDDEN };
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

  // Phantom-person payloads store canonical_name captured at dream time (system context) —
  // re-resolve through the tier-filtered parentMeta so a tier-2 person stays masked.
  if (item.kind === "phantom_person" && typeof item.payload?.person_id === "string") {
    try {
      payload = {
        ...payload,
        canonical_name: (await visibleTitle("person", item.payload.person_id, actor)) ?? HIDDEN,
      };
    } catch {
      payload = { ...payload, canonical_name: HIDDEN };
    }
  }

  // Suspect-edge payloads hold the full triple (rel + endpoint names). Gate it on the EDGE's
  // tier (edges inherit their source parent's tier): invisible → mask rel + names, keep
  // edge_id/rule_key/verdict/entity_type for post-unlock triage; visible → still re-resolve
  // each endpoint name at the caller's tier. Fail closed on any lookup error.
  if (item.kind === "extract_suspect" && typeof item.payload?.edge_id === "string") {
    const raw = item.payload;
    try {
      payload = (await edgeVisibleAtTier(raw.edge_id, actor))
        ? {
            ...payload,
            src: await visibleEndpoint(raw.src, actor),
            dst: await visibleEndpoint(raw.dst, actor),
          }
        : {
            ...payload,
            rel: HIDDEN,
            src: maskEndpointName(raw.src),
            dst: maskEndpointName(raw.dst),
          };
    } catch {
      payload = {
        ...payload,
        rel: HIDDEN,
        src: maskEndpointName(raw.src),
        dst: maskEndpointName(raw.dst),
      };
    }
  }

  // inbox_unfiled/duplicate payloads point at the raw capture via inbox_item_id. classify.ts
  // treats a not-yet-filed capture as tier-2-equivalent ("the most intimate destination it
  // might land in" — classify.ts:1-3): the capture's inbox_items row itself stays tier 1
  // (a real tier is only assigned once filed), so this app-layer gate — not a DB tier
  // predicate — is what keeps its free text behind the same tier-2 unlock as journal/
  // interaction content (DECISIONS.md 2026-08-08). The classifier's type/confidence GUESS is
  // metadata ABOUT the capture, not the capture itself, and always crosses so triage can see
  // what the classifier thought without unlocking anything.
  if (
    (item.kind === "inbox_unfiled" || item.kind === "duplicate") &&
    typeof item.payload?.inbox_item_id === "string"
  ) {
    try {
      const inboxItem = await getInboxItem(item.payload.inbox_item_id);
      const guess = inboxItem ? storedClassification(inboxItem.classifier_output) : null;
      if (inboxItem && guess) {
        const capture: Record<string, unknown> = {
          type: guess.type,
          confidence: guess.confidence,
          reason: HIDDEN,
          text: HIDDEN,
        };
        if ((await allowedTier(actor)) === 2) {
          const text = await readArchivedCapture(inboxItem);
          capture.reason = guess.reason ?? "";
          capture.text = text === null ? CAPTURE_UNAVAILABLE : text.slice(0, 500);
        }
        payload = { ...payload, capture };
      }
    } catch {
      // Fail closed: no capture guess is better than a half-resolved or wrong one.
    }
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
    "List open review-queue items (contradiction | stale | duplicate | decision_review | inbox_unfiled | phantom_person | extract_suspect), or resolve one as 'resolved' | 'dismissed'. inbox_unfiled/duplicate items carry the classifier's type/confidence guess (always visible) under payload.capture; its reason and a ~500-char capture text excerpt require an approved tier-2 unlock (minime_unlock) and read '[above current tier]' until then. The queue is flag-only: resolving never edits the flagged rows themselves.",
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
    const gaps: string[] = [];
    if (items.length === 0) gaps.push("review queue is empty — nothing to triage");
    if (items.some((i: any) => i.payload?.capture?.text === HIDDEN)) {
      gaps.push(
        "capture reason/text are tier 2 — locked; ask the owner first, then call minime_unlock " +
          "and have them approve the pending request locally, or run `minime review` locally " +
          "for the unmasked text",
      );
    }
    return envelope({ items }, sources, { gaps });
  },
};
