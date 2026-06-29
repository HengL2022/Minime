import { z } from "zod";
import { ensureOrg, ensurePerson, insertInteraction, resolveOrg } from "../../db/repo";
import { indexParent } from "../../search/index-parent";
import { envelope } from "../envelope";
import type { ToolDef } from "./registry";

export const logInteractionTool: ToolDef = {
  name: "minime_log_interaction",
  description:
    "Log a meeting/call/message/email/note with a person OR an org (vendor/institution). " +
    "Resolves aliases, creates the subject if new, updates last-contact for people. " +
    "subject_type defaults to 'auto': if the name already matches an existing org it attaches " +
    "to that org, otherwise it attaches to a person. Pass subject_type='org' to force a vendor/" +
    "institution (avoids minting a phantom person). Tier 2: writable now, reads require unlock.",
  schema: {
    person_name: z.string().min(1),
    kind: z.enum(["meeting", "call", "message", "email", "note"]),
    summary: z.string().min(1),
    occurred_at: z.string().datetime({ offset: true }).optional(),
    subject_type: z.enum(["auto", "person", "org"]).optional(),
  },
  handler: async (params, ctx) => {
    const occurredAt = params.occurred_at ? new Date(params.occurred_at) : undefined;
    const mode = params.subject_type ?? "auto";

    // Decide whether this interaction attaches to an org or a person.
    // - 'org'  : force org (vendor/institution) — never mints a phantom person.
    // - 'auto' : if the name already resolves to an existing org, attach to it;
    //            otherwise fall through to person (preserves prior default behaviour).
    // - 'person': always a person (legacy default).
    let useOrg = false;
    if (mode === "org") {
      useOrg = true;
    } else if (mode === "auto") {
      const existingOrg = await resolveOrg(params.person_name, ctx.actor);
      if (existingOrg) useOrg = true;
    }

    if (useOrg) {
      const org = await ensureOrg(params.person_name, ctx.actor);
      const { id } = await insertInteraction({
        orgId: org.id,
        kind: params.kind,
        summary: params.summary,
        occurredAt,
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
      return envelope({ interaction_id: id, org_id: org.id, org_created: org.created }, [
        { type: "interaction", id },
        { type: "org", id: org.id },
      ]);
    }

    const person = await ensurePerson(params.person_name, ctx.actor);
    const { id } = await insertInteraction({
      personId: person.id,
      kind: params.kind,
      summary: params.summary,
      occurredAt,
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
