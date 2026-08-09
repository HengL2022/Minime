import { z } from "zod";
import {
  ensureOrg,
  ensurePerson,
  exactActiveOrgExists,
  insertCommitment,
  insertInteraction,
  orgCanonicalName,
  personCanonicalName,
} from "../../db/repo";
import { indexParent } from "../../search/index-parent";
import { type Envelope, envelope } from "../envelope";
import type { ToolDef } from "./registry";

// Shared by both subject branches below: build the write receipt, adding commitment_id/its
// source ONLY when a promise was actually captured — the no-promise case must stay byte-identical
// to the pre-W3-13 shape ({interaction_id} alone), which existing callers already depend on.
function receipt(interactionId: string, commitment: { id: string } | null): Envelope {
  return envelope(
    { interaction_id: interactionId, ...(commitment ? { commitment_id: commitment.id } : {}) },
    [
      { type: "interaction", id: interactionId },
      ...(commitment ? [{ type: "commitment", id: commitment.id }] : []),
    ],
  );
}

export const logInteractionTool: ToolDef = {
  name: "minime_log_interaction",
  description:
    "Log a meeting/call/message/email/note with a person OR an org (vendor/institution). " +
    "Resolves aliases, creates the subject if new, updates last-contact for people. " +
    "subject_type defaults to 'auto': if the name already matches an existing org it attaches " +
    "to that org, otherwise it attaches to a person. Pass subject_type='org' to force a vendor/" +
    "institution (avoids minting a phantom person). Tier 2: writable now, reads require unlock. " +
    "Optional promise={what, due?} records a commitment made during this interaction — to_whom " +
    "is the resolved subject's own canonical name, tier 2 like the interaction itself, and " +
    "derived_from links back to it. Close or reschedule it later with minime_upsert_commitment.",
  schema: {
    person_name: z.string().min(1),
    kind: z.enum(["meeting", "call", "message", "email", "note"]),
    summary: z.string().min(1),
    occurred_at: z.string().datetime({ offset: true }).optional(),
    subject_type: z.enum(["auto", "person", "org"]).optional(),
    promise: z
      .object({
        what: z.string().min(1),
        due: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .optional(),
  },
  handler: async (params, ctx) => {
    const occurredAt = params.occurred_at ? new Date(params.occurred_at) : undefined;
    const mode = params.subject_type ?? "auto";
    const interactionId = crypto.randomUUID();

    // Decide whether this interaction attaches to an org or a person.
    // - 'org'  : force org (vendor/institution) — never mints a phantom person.
    // - 'auto' : if the name already resolves to an existing org, attach to it;
    //            otherwise fall through to person (preserves prior default behaviour).
    // - 'person': always a person (legacy default).
    let useOrg = false;
    if (mode === "org") {
      useOrg = true;
    } else if (mode === "auto") {
      useOrg = await exactActiveOrgExists(params.person_name);
    }

    // Commitment made during this interaction, if any. Resolving the canonical name is lazy
    // (skipped entirely when no promise was given, the overwhelmingly common call) and happens
    // only inside this function, never at the call sites below — a plain log_interaction call
    // must neither pay for nor depend on entity_canonical_name's grant. When a promise IS given,
    // to_whom is read back from the row this call just ensured (its canonical name may differ
    // from the raw input on an alias match — "Bob" resolving to "Bob Smith"), not trusted from
    // params. Tier matches the interaction itself (2): a promise made during a logged,
    // relationship-tier contact is the same class of content as the interaction that carries it.
    async function logPromise(subject: { kind: "person" | "org"; id: string }): Promise<{
      id: string;
    } | null> {
      if (!params.promise) return null;
      const toWhom =
        subject.kind === "person"
          ? await personCanonicalName(subject.id)
          : await orgCanonicalName(subject.id);
      const { id } = await insertCommitment({
        what: params.promise.what,
        toWhom,
        due: params.promise.due ?? null,
        createdBy: ctx.actor,
        source: "capture",
        derivedFrom: interactionId,
        tier: 2,
      });
      await indexParent("commitment", id, params.promise.what, params.promise.what, 2);
      return { id };
    }

    if (useOrg) {
      const org = await ensureOrg(params.person_name, ctx.actor, "capture", {
        tier: 2,
        derivedFrom: interactionId,
      });
      const { id } = await insertInteraction({
        id: interactionId,
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
      // Keep write receipts shape-invariant beyond the caller's own promise input. Subject IDs
      // and created/reused flags would turn exact-name resolution into an oracle for an
      // otherwise RLS-hidden tier-2 identity — commitment_id carries no such signal, since its
      // presence reflects only whether the CALLER passed a promise, not how the subject resolved.
      return receipt(id, await logPromise({ kind: "org", id: org.id }));
    }

    const person = await ensurePerson(params.person_name, ctx.actor, "capture", {
      tier: 2,
      derivedFrom: interactionId,
    });
    const { id } = await insertInteraction({
      id: interactionId,
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
    return receipt(id, await logPromise({ kind: "person", id: person.id }));
  },
};
