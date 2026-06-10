import { z } from "zod";
import { hybridSearch } from "../../search/hybrid";
import { envelope, stalenessOf } from "../envelope";
import type { ToolDef } from "./registry";

export const searchTool: ToolDef = {
  name: "minime_search",
  description:
    "Hybrid (semantic + full-text) search over the owner's notes, journal, decisions, tasks and people. Returns scored hits with snippets and source IDs.",
  schema: {
    query: z.string().min(1),
    types: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    include_derived: z.boolean().optional(),
  },
  handler: async (params) => {
    const hits = await hybridSearch({
      query: params.query,
      types: params.types ?? null,
      limit: params.limit ?? 10,
      includeDerived: params.include_derived ?? false,
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
    return envelope(
      { hits },
      hits.map((h) => ({
        type: h.type,
        id: h.id,
        title: h.title,
        updated_at: h.updated_at,
        created_by: h.created_by,
        derived: h.derived,
      })),
      { staleness: stalenessOf(newest), gaps },
    );
  },
};
