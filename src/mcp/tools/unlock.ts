import { z } from "zod";
import { logEvent, requestTier2Unlock } from "../../db/repo";
import { auditPayload } from "../../util/audit-payload";
import { assertTier2UnlockMaxMinutes, config } from "../../util/config";
import { ToolError, envelope } from "../envelope";
import type { ToolDef } from "./registry";

export const unlockTool: ToolDef = {
  name: "minime_unlock",
  description:
    "Request an owner-approved, time-boxed tier-2 read unlock for this MCP connection (journal, interactions, email metadata). Tier 0 is never unlockable.",
  schema: {
    minutes: z.number().int().min(1),
  },
  handler: async (params, ctx) => {
    assertTier2UnlockMaxMinutes(config.tier2UnlockMaxMinutes);
    if (params.minutes > config.tier2UnlockMaxMinutes) {
      throw new ToolError(
        "UNLOCK_TOO_LONG",
        `requested ${params.minutes}min exceeds TIER2_UNLOCK_MAX_MINUTES=${config.tier2UnlockMaxMinutes}`,
      );
    }
    const request = await requestTier2Unlock(params.minutes);
    await logEvent({
      actor: ctx.actor,
      verb: "unlock:tier2:requested",
      entityType: "session_unlock",
      entityId: request.id,
      payload: auditPayload.tier2Unlock({ requestId: request.id, minutes: params.minutes }),
    });
    return envelope(
      {
        request_id: request.id,
        status: "pending",
        minutes: params.minutes,
        approval_command: `bun run src/cli.ts unlock:approve ${request.id}`,
      },
      [{ type: "session_unlock", id: request.id }],
      { gaps: ["tier-2 remains locked until the owner approves this request locally"] },
    );
  },
};
