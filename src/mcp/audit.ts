// Append-only audit (I8): every tool call — reads included — writes an events row with
// actor, verb, a params hash, and the IDs of returned rows. NEVER contents (tier-0 rule).

import { createHash } from "node:crypto";
import { logEvent } from "../db/repo";

export function paramsHash(params: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(params ?? {}))
    .digest("hex")
    .slice(0, 16);
}

export async function auditToolCall(opts: {
  actor: string;
  tool: string;
  params: unknown;
  returnedIds: string[];
  error?: string;
}): Promise<void> {
  await logEvent({
    actor: opts.actor,
    verb: `tool:${opts.tool}`,
    payload: {
      params_hash: paramsHash(opts.params),
      returned_ids: opts.returnedIds.slice(0, 100),
      returned_count: opts.returnedIds.length,
      ...(opts.error ? { error: opts.error } : {}),
    },
  });
}
