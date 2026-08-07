import { z } from "zod";
import {
  type ParentType,
  allowedTier,
  edgesAround,
  getDecisionBranches,
  getDecisionTranscript,
  getRow,
  openItemsFor,
  parentMeta,
  recentInteractionsFor,
  recentInteractionsForOrg,
  resolveOrg,
  resolvePerson,
} from "../../db/repo";
import { type SourceRef, ToolError, envelope, stalenessOf } from "../envelope";
import type { ToolDef } from "./registry";

const TYPES = [
  "page",
  "journal",
  "interaction",
  "decision",
  "decision_branch",
  "task",
  "goal",
  "value",
  "principle",
  "person",
  "org",
  "commitment",
] as const;

async function resolveEdgeTitles(edges: any[], actor: string): Promise<any[]> {
  const byType = new Map<string, Set<string>>();
  for (const e of edges) {
    for (const [t, i] of [
      [e.src_type, e.src_id],
      [e.dst_type, e.dst_id],
    ] as const) {
      if (!byType.has(t)) byType.set(t, new Set());
      byType.get(t)!.add(i);
    }
  }
  const titles = new Map<string, string>();
  for (const [t, ids] of byType) {
    try {
      for (const [id, m] of await parentMeta(t as ParentType, [...ids], actor))
        titles.set(`${t}:${id}`, m.title);
    } catch {
      // edge endpoints may reference types without content tables; leave untitled
    }
  }
  return edges.map((e) => ({
    id: e.id,
    rel: e.rel,
    src: { type: e.src_type, id: e.src_id, title: titles.get(`${e.src_type}:${e.src_id}`) },
    dst: { type: e.dst_type, id: e.dst_id, title: titles.get(`${e.dst_type}:${e.dst_id}`) },
    source_table: e.source_table,
    source_id: e.source_id,
    extracted_by: e.extracted_by,
    confidence: e.confidence,
  }));
}

export const getContextTool: ToolDef = {
  name: "minime_get_context",
  description:
    "Resolve an entity (by type+id, or person_name matching a person or org by name/alias) and return the row, related rows via edges, open items, and provenance.",
  schema: {
    type: z.enum(TYPES).optional(),
    id: z.string().uuid().optional(),
    person_name: z.string().optional(),
  },
  handler: async (params, ctx) => {
    const gaps: string[] = [];
    const sources: SourceRef[] = [];
    let type: ParentType;
    let row: any;

    if (params.person_name) {
      type = "person";
      row = await resolvePerson(params.person_name, ctx.actor);
      if (!row) {
        type = "org";
        row = await resolveOrg(params.person_name, ctx.actor);
      }
      // Wording MUST be byte-identical whether a tier-2 row exists or nothing exists at all —
      // resolvePerson/resolveOrg already return null for both cases (repo.ts tier predicate),
      // so no extra query may be added here to distinguish them (would introduce an oracle for
      // otherwise RLS-hidden tier-2 identities, e.g. people minted by minime_log_interaction).
      if (!row)
        throw new ToolError(
          "NOT_FOUND",
          "no person or org matching that name at the current access tier — a match may exist " +
            "at tier 2; offer an owner-approved unlock (minime_unlock)",
        );
    } else if (params.type && params.id) {
      type = params.type;
      row = await getRow(type, params.id, ctx.actor);
      if (!row)
        throw new ToolError(
          "NOT_FOUND",
          `${params.type} ${params.id} not found or above current access tier`,
        );
    } else {
      throw new ToolError("BAD_INPUT", "provide either type+id or person_name");
    }

    sources.push({
      type,
      id: row.id,
      updated_at: row.updated_at,
      created_by: row.created_by,
      derived: row.derived_from !== null,
    });

    const related = await resolveEdgeTitles(
      await edgesAround(type, row.id, 20, ctx.actor),
      ctx.actor,
    );
    for (const edge of related) {
      sources.push({
        type: "edge",
        id: edge.id,
        title: edge.rel,
      });
    }

    let transcript: any[] = [];
    let branches: any[] = [];
    if (type === "decision") {
      transcript = await getDecisionTranscript(row.id, ctx.actor);
      branches = await getDecisionBranches(row.id, ctx.actor);
      for (const t of transcript) {
        sources.push({
          type: "decision_transcript",
          id: t.id,
          updated_at: t.at,
          created_by: t.created_by,
        });
      }
      for (const b of branches) {
        sources.push({
          type: "decision_branch",
          id: b.id,
          title: b.label,
          updated_at: b.updated_at,
          created_by: b.created_by,
        });
      }
    }

    let interactions: any[] = [];
    let openItems: { commitments: any[]; tasks: any[] } = { commitments: [], tasks: [] };
    if (type === "person") {
      interactions = await recentInteractionsFor(row.id, 20, ctx.actor);
      if (interactions.length === 0 && (await allowedTier(ctx.actor)) < 2) {
        gaps.push(
          "interactions are tier 2 — locked; ask the owner first, then call minime_unlock and have them approve the pending request locally",
        );
      }
      for (const i of interactions) {
        sources.push({
          type: "interaction",
          id: i.id,
          updated_at: i.occurred_at,
          created_by: i.created_by,
        });
      }
      openItems = await openItemsFor(row.canonical_name, ctx.actor);
      for (const commitment of openItems.commitments) {
        sources.push({
          type: "commitment",
          id: commitment.id,
          title: commitment.what,
        });
      }
      for (const task of openItems.tasks) {
        sources.push({
          type: "task",
          id: task.id,
          title: task.title,
        });
      }
    } else if (type === "org") {
      // Org-keyed interactions (vendors/institutions) — enabled by 013_interactions_org.sql.
      interactions = await recentInteractionsForOrg(row.id, 20, ctx.actor);
      if (interactions.length === 0 && (await allowedTier(ctx.actor)) < 2) {
        gaps.push(
          "interactions are tier 2 — locked; ask the owner first, then call minime_unlock and have them approve the pending request locally",
        );
      }
      for (const i of interactions) {
        sources.push({
          type: "interaction",
          id: i.id,
          updated_at: i.occurred_at,
          created_by: i.created_by,
        });
      }
    }

    const newest = type === "person" ? (row.last_contact_at ?? row.updated_at) : row.updated_at;
    return envelope(
      {
        row,
        related,
        transcript,
        branches,
        interactions,
        open_commitments: openItems.commitments,
        open_tasks: openItems.tasks,
        provenance: {
          source: row.source,
          created_by: row.created_by,
          derived_from: row.derived_from,
        },
      },
      sources,
      { staleness: stalenessOf(newest, type === "person" ? "last contact" : "row"), gaps },
    );
  },
};
