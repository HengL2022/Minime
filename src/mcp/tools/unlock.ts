import { z } from "zod";
import { insertUnlock, logEvent } from "../../db/repo";
import { config } from "../../util/config";
import { ToolError, envelope } from "../envelope";
import type { ToolDef } from "./registry";

export const unlockTool: ToolDef = {
  name: "minime_unlock",
  description:
    "Grant a time-boxed tier-2 read unlock (journal, interactions, email metadata). Loudly audited. Tier 0 (transactions, health) is NEVER unlockable.",
  schema: {
    minutes: z.number().int().min(1),
  },
  handler: async (params, ctx) => {
    if (params.minutes > config.tier2UnlockMaxMinutes) {
      throw new ToolError(
        "UNLOCK_TOO_LONG",
        `requested ${params.minutes}min exceeds TIER2_UNLOCK_MAX_MINUTES=${config.tier2UnlockMaxMinutes}`,
      );
    }
    const unlock = await insertUnlock(params.minutes, ctx.actor);
    // log loudly (spec §8): a dedicated event on top of the standard tool audit
    await logEvent({
      actor: ctx.actor,
      verb: "unlock:tier2",
      entityType: "session_unlock",
      entityId: unlock.id,
      payload: { minutes: params.minutes, expires_at: unlock.expires_at },
    });
    console.error(
      `[minime] TIER-2 UNLOCK granted to ${ctx.actor} for ${params.minutes}min (until ${unlock.expires_at.toISOString()})`,
    );
    return envelope({ unlock_id: unlock.id, expires_at: unlock.expires_at }, [
      { type: "session_unlock", id: unlock.id },
    ]);
  },
};
