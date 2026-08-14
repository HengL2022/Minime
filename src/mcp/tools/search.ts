import { z } from "zod";
import { hybridSearchDetailed } from "../../search/hybrid";
import { ToolError, envelope, stalenessOf } from "../envelope";
import type { ToolDef } from "./registry";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const searchTool: ToolDef = {
  name: "minime_search",
  description:
    "Hybrid (semantic + full-text) search over the owner's notes, journal, decisions, tasks and people. Returns scored hits with snippets and source IDs. Optional from/to (YYYY-MM-DD) narrow hits to a semantic event-date window (a journal entry's own date, a decision's decided-at, etc — not necessarily updated_at). This is best-effort, NOT an exhaustive date read: it only filters the top-ranked semantic/full-text candidates already fetched for the query, so an in-window item that doesn't otherwise match the query well may be missed. For exhaustive date-range coverage regardless of query relevance, use minime_timeline instead. A locked session's `gaps` discloses a bare count of matching tier-2 hits it cannot read — never their titles or ids — so a locked result is distinguishable from a genuinely empty one.",
  schema: {
    query: z.string().min(1),
    types: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    include_derived: z.boolean().optional(),
    from: z.string().regex(DATE).optional().describe("Inclusive start date, YYYY-MM-DD."),
    to: z.string().regex(DATE).optional().describe("Inclusive end date, YYYY-MM-DD."),
  },
  handler: async (params, ctx) => {
    if (params.from && params.to && params.from > params.to) {
      throw new ToolError("BAD_INPUT", "from must be on or before to");
    }
    const { hits, suppressedTier2Count } = await hybridSearchDetailed({
      query: params.query,
      types: params.types ?? null,
      limit: params.limit ?? 10,
      includeDerived: params.include_derived ?? false,
      actor: ctx.actor,
      from: params.from ?? null,
      to: params.to ?? null,
      timeZone: ctx.timeZone,
    });
    const newest = hits.length
      ? hits.reduce<Date | null>(
          (acc, h) => (!acc || new Date(h.updated_at) > acc ? new Date(h.updated_at) : acc),
          null,
        )
      : null;
    const gaps: string[] = [];
    if (hits.length === 0)
      gaps.push("no indexed content matches the query at the current access tier");
    // Independent of the no-match gap above — a locked query can match zero VISIBLE hits while
    // still having tier-2 matches above the ceiling, so both gaps can fire on the same call.
    if (suppressedTier2Count > 0) {
      const plural = suppressedTier2Count !== 1;
      gaps.push(
        `${suppressedTier2Count} matching ${plural ? "results are" : "result is"} tier-2 locked` +
          ` — an owner-approved unlock (minime_unlock) would include ${plural ? "them" : "it"}`,
      );
    }
    return envelope(
      { hits },
      hits.map((h) => ({
        type: h.type,
        id: h.id,
        title: h.title,
        updated_at: h.updated_at,
        created_by: h.created_by,
        derived: h.derived,
        // Only stamped when true (spec: agents should cite the successor instead) — keeps the
        // common unflagged case's source refs unchanged.
        ...(h.superseded ? { superseded: true as const } : {}),
      })),
      { staleness: stalenessOf(newest), gaps },
    );
  },
};
