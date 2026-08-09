// W3-13: minime_upsert_commitment — create a commitment directly, or close/reschedule an
// existing one. minime_log_interaction's own `promise` param (interactions.ts) is the usual way
// a commitment starts (a promise made during a logged contact); this tool is for one made with no
// interaction to hang it on, and for closing any commitment either path created.

import { z } from "zod";
import {
  CommitmentNotFoundError,
  type CommitmentRow,
  insertCommitment,
  updateCommitment,
} from "../../db/repo";
import { indexParent } from "../../search/index-parent";
import { ToolError, envelope } from "../envelope";
import type { ToolDef } from "./registry";

const STATUS = ["open", "kept", "renegotiated", "broken"] as const;

export const upsertCommitmentTool: ToolDef = {
  name: "minime_upsert_commitment",
  description:
    "Create or update a commitment — a promise made to a person or org (status: " +
    "open|kept|renegotiated|broken, default open). what and to_whom are required when creating; " +
    "omit them on an id-only update to change only status/due — e.g. close one as kept without " +
    "resending what was promised. Open commitments appear in minime_state's commitments_open and " +
    "in the subject's dossier (minime_get_context) when to_whom matches their canonical name. " +
    "minime_log_interaction's own promise param is the usual way a commitment starts (to_whom " +
    "resolved automatically); use this tool directly for one with no interaction to hang it on.",
  schema: {
    id: z.string().uuid().optional(),
    what: z.string().min(1).optional(),
    to_whom: z.string().min(1).optional(),
    due: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    status: z.enum(STATUS).optional(),
  },
  handler: async (params, ctx) => {
    if (!params.id) {
      if (!params.what || !params.to_whom) {
        throw new ToolError(
          "BAD_INPUT",
          "what and to_whom are required when creating a commitment",
        );
      }
      const { id } = await insertCommitment({
        what: params.what,
        toWhom: params.to_whom,
        due: params.due ?? null,
        status: params.status,
        createdBy: ctx.actor,
        source: "capture",
        tier: 1,
      });
      await indexParent("commitment", id, params.what, params.what, 1);
      return envelope({ commitment_id: id }, [{ type: "commitment", id }]);
    }
    // what/to_whom are deliberately not accepted here: they are set once at creation and
    // immutable via this path (mirrors updateGoal's own horizon-is-immutable design) — an
    // id-only update never needs them, matching the "resend only what changed" ergonomic
    // upsertTask/upsertGoal already established.
    let commitment: CommitmentRow;
    try {
      commitment = await updateCommitment(params.id, {
        status: params.status ?? null,
        due: params.due,
      });
    } catch (e) {
      if (e instanceof CommitmentNotFoundError) {
        throw new ToolError("NOT_FOUND", "commitment not found");
      }
      throw e;
    }
    // Index the STORED what (returned from the write), not raw params — an id-only status
    // update never sends `what`, and indexing params would blank the search text (the exact
    // upsertTask title-rewrite wart this tool must not replicate; see repo.ts).
    await indexParent(
      "commitment",
      commitment.id,
      commitment.what,
      commitment.what,
      commitment.tier === 2 ? 2 : 1,
    );
    return envelope({ commitment_id: commitment.id }, [{ type: "commitment", id: commitment.id }]);
  },
};
