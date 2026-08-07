import { randomUUID } from "node:crypto";
import { withAdminDbTransaction } from "../../src/db/client";
import { approveTier2UnlockRequest } from "../../src/db/repo";
import { toolByName } from "../../src/mcp/tools";
import { type ToolCtx, invokeTool } from "../../src/mcp/tools/registry";

export function sessionToolCtx(actor: string): ToolCtx {
  return { actor, sessionId: randomUUID() };
}

export async function requestAndApproveTier2(
  ctx: ToolCtx,
  minutes = 5,
): Promise<{ requestId: string; expiresAt: Date }> {
  if (!ctx.sessionId) throw new Error("test unlock context requires a session id");
  const result = await invokeTool(toolByName("minime_unlock"), { minutes }, ctx);
  if (!result.ok) throw new Error(`unlock request failed: ${result.error.code}`);
  const requestId = String((result.envelope.data as any).request_id);
  const approved = await withAdminDbTransaction(() => approveTier2UnlockRequest(requestId));
  return { requestId, expiresAt: approved.expires_at };
}
