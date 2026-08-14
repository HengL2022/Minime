import { z } from "zod";
import {
  type ParentType,
  allowedTier,
  edgeVisibleAtTier,
  getInboxItem,
  getRow,
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
  "ops_failure",
  "goal_review",
  "entity_promotion",
] as const;
const HIDDEN = "[above current tier]";
// Distinct from HIDDEN: the tier check passed but the archived bytes could not be proven
// authentic (missing file, hash mismatch). Never fabricate text in that case.
const CAPTURE_UNAVAILABLE = "[archive unavailable]";
// Distinct from HIDDEN: the tier check passed but the target row itself was withdrawn
// (minime_correct retraction, W2-4). parentMeta (repo.ts) now excludes retracted rows for every
// caller, not just hybridSearch, so a retracted-but-tier-visible target also misses parentMeta —
// see visibleTitle, which tells the two miss reasons apart so this never reports a false tier
// claim (that could prompt an unneeded owner tier-2-unlock) for a row the caller can fully see.
const RETRACTED = "[retracted]";
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
  const hit = meta.get(id);
  if (hit) return hit.title;
  // parentMeta misses for two reasons: the row is above the caller's tier, or it's retracted
  // (superseded_at set, superseded_by null — the only extra condition parentMeta excludes beyond
  // the tier predicate, repo.ts:702-714). getRow applies the same tier bound WITHOUT the
  // retraction filter, so a hit here proves tier was never the issue — report RETRACTED, not
  // HIDDEN. A miss on both means genuinely above tier (or the id doesn't exist), unchanged from
  // before this distinction existed.
  const row = await getRow(type, id, actor);
  return row ? RETRACTED : null;
}

// extract_suspect endpoints ({type, id, name}) carry names the dream job captured in system
// context (no tier predicate). Even when the edge itself is visible, re-resolve each name
// through the tier-filtered parentMeta (via visibleTitle) so e.g. a tier-2 person's name never
// rides a tier-1 edge, and a retracted endpoint reads RETRACTED rather than a false HIDDEN.
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
// above the caller's current tier — re-resolve through visibleTitle and mask what the caller
// may not see (row IDs are fine, titles are not); a retracted-but-visible target reads
// RETRACTED instead, since that isn't a tier problem.
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

  // goal_review payloads carry goal_id only (dream.ts enqueueGoalReviews) — the statement is
  // never stored in the queue row itself, always resolved fresh here at the caller's own tier,
  // mirroring decision_review's question resolution just above.
  if (item.kind === "goal_review" && typeof item.payload?.goal_id === "string") {
    payload = {
      ...payload,
      statement: (await visibleTitle("goal", item.payload.goal_id, actor)) ?? HIDDEN,
    };
  }

  // Phantom-person payloads store canonical_name captured at dream time (system context) —
  // re-resolve through visibleTitle so a tier-2 person stays masked (a retracted-but-visible
  // person reads RETRACTED instead).
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

  // Entity-promotion payloads store entity_type + entity_id ONLY (W4-2 backfill/ensurePerson-
  // ensureOrg detection) — never a name, since the queue is read at tier 1 and the flagged
  // identity is still sitting at tier 2. Re-resolve the current name fresh through visibleTitle
  // exactly like phantom_person's canonical_name above, so it stays masked until the caller's own
  // tier covers it. Demoting the row is owner-CLI-only (entity:restore-tier) regardless of what
  // this read shows — an unlocked caller can see the name, but no MCP tool can act on it.
  if (
    item.kind === "entity_promotion" &&
    (item.payload?.entity_type === "person" || item.payload?.entity_type === "org") &&
    typeof item.payload?.entity_id === "string"
  ) {
    try {
      payload = {
        ...payload,
        name:
          (await visibleTitle(item.payload.entity_type, item.payload.entity_id, actor)) ?? HIDDEN,
      };
    } catch {
      payload = { ...payload, name: HIDDEN };
    }
  }

  // Suspect-edge payloads hold the full triple (rel + endpoint names). Gate it on the EDGE's
  // tier (edges inherit their source parent's tier): invisible → mask rel + names, keep
  // edge_id/rule_key/verdict/entity_type for post-unlock triage; visible → still re-resolve
  // each endpoint name at the caller's tier. Fail closed on any lookup error.
  // Fix B flags (no edge_id) carry the same endpoint shape plus a machine-code reason;
  // restore that code after CONTENT_KEYS masking and re-resolve names the same way.
  if (item.kind === "extract_suspect") {
    const raw = item.payload ?? {};
    if (raw.reason === "fuzzy_org_ambiguous" || raw.reason === "low_confidence_edge") {
      payload = { ...payload, reason: raw.reason };
    }
    if (Array.isArray(raw.matches)) {
      payload = {
        ...payload,
        matches: await Promise.all(raw.matches.map((ep: unknown) => visibleEndpoint(ep, actor))),
      };
    }
    if (raw.person) payload = { ...payload, person: await visibleEndpoint(raw.person, actor) };
    if (raw.org) payload = { ...payload, org: await visibleEndpoint(raw.org, actor) };
    if (typeof raw.edge_id === "string") {
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
    "List open review-queue items (contradiction | stale | duplicate | decision_review | inbox_unfiled | phantom_person | extract_suspect | ops_failure | goal_review | entity_promotion), or resolve one as 'resolved' | 'dismissed'. inbox_unfiled/duplicate items carry the classifier's type/confidence guess (always visible) under payload.capture; its reason and a ~500-char capture text excerpt require an approved tier-2 unlock (minime_unlock) and read '[above current tier]' until then. ops_failure carries only fixed dream-step identifiers and a timestamp (payload.failed_steps, payload.since) — always visible, no unlock needed; run `bun run src/cli.ts doctor` locally for the full maintenance checklist. goal_review flags an active goal untouched (and with no linked task touched) for 90+ days; update it with minime_upsert_goal. entity_promotion flags a person/org whose identity is still tier 2 though it looks owner-known or independently tier-1-evidenced; its name reads '[above current tier]' until an approved tier-2 unlock, and only the owner's own terminal (`bun run src/cli.ts entity:restore-tier`) can actually restore it to tier 1 — this tool can surface the flag but never execute that change. The queue is flag-only: resolving never edits the flagged rows themselves.",
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
