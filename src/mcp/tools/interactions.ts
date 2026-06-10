import { z } from "zod";
import { ensurePerson, insertInteraction } from "../../db/repo";
import { indexParent } from "../../search/index-parent";
import { envelope } from "../envelope";
import type { ToolDef } from "./registry";

export const logInteractionTool: ToolDef = {
  name: "minime_log_interaction",
  description:
    "Log a meeting/call/message/email/note with a person (resolves aliases, creates the person if new, updates last-contact). Tier 2: writable now, reads require unlock.",
  schema: {
    person_name: z.string().min(1),
    kind: z.enum(["meeting", "call", "message", "email", "note"]),
    summary: z.string().min(1),
    occurred_at: z.string().datetime({ offset: true }).optional(),
  },
  handler: async (params, ctx) => {
    const person = await ensurePerson(params.person_name, ctx.actor);
    const { id } = await insertInteraction({
      personId: person.id,
      kind: params.kind,
      summary: params.summary,
      occurredAt: params.occurred_at ? new Date(params.occurred_at) : undefined,
      createdBy: ctx.actor,
      source: "capture",
    });
    await indexParent(
      "interaction",
      id,
      `${params.kind} with ${params.person_name}\n\n${params.summary}`,
      undefined,
      2,
    );
    return envelope({ interaction_id: id, person_id: person.id, person_created: person.created }, [
      { type: "interaction", id },
      { type: "person", id: person.id },
    ]);
  },
};
