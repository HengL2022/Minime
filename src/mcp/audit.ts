// Append-only audit (I8): every tool call — reads included — writes an attempt and a
// result event with actor, hashes, and the IDs of returned rows. NEVER contents.

import { createHash } from "node:crypto";
import { logEvent } from "../db/repo";
import { auditPayload } from "../util/audit-payload";

export function paramsHash(params: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(params ?? {}))
    .digest("hex")
    .slice(0, 16);
}

export function requestedNameHash(rawName: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(rawName ?? null))
    .digest("hex")
    .slice(0, 16);
}

export type AuditOutcome =
  | "cancelled_before_execution"
  | "transport_closed_before_execution"
  | "completed_not_released"
  | "completed_after_disconnect";

export type AuditDelivery = "transport" | "direct";

export interface ResultAuditRecord {
  returnedIds: string[];
  returnedCount: number;
  error?: string;
  delivery: AuditDelivery;
}

export interface DurableResultAudit {
  eventId: string;
}

export type AuditDisposition =
  | { status: "suppressed"; outcome?: AuditOutcome }
  | { status: "released" }
  | { status: "send_uncertain" };

export interface AuditSink {
  attempt(
    actor: string,
    tool: string,
    params: unknown,
    requestedNameHash?: string,
  ): Promise<string>;
  result(
    actor: string,
    tool: string,
    paramsHash: string,
    record: ResultAuditRecord,
    requestedNameHash?: string,
  ): Promise<DurableResultAudit>;
  disposition(
    actor: string,
    tool: string,
    resultEventId: string,
    disposition: AuditDisposition,
  ): Promise<void>;
}

async function result(
  actor: string,
  tool: string,
  hash: string,
  record: ResultAuditRecord,
  requestedNameHashValue?: string,
): Promise<DurableResultAudit> {
  const eventId = await logEvent({
    actor,
    verb: `tool:${tool}`,
    payload: auditPayload.toolResult({
      paramsHash: hash,
      returnedIds: record.returnedIds,
      returnedCount: record.returnedCount,
      ...(record.error ? { errorCode: record.error } : {}),
      ...(requestedNameHashValue ? { requestedNameHash: requestedNameHashValue } : {}),
      delivery: record.delivery,
    }),
  });
  return { eventId };
}

export const eventAuditSink: AuditSink = {
  async attempt(actor, tool, params, requestedNameHashValue) {
    const hash = paramsHash(params);
    await logEvent({
      actor,
      verb: `tool:${tool}:attempt`,
      payload: auditPayload.toolAttempt({
        paramsHash: hash,
        ...(requestedNameHashValue ? { requestedNameHash: requestedNameHashValue } : {}),
      }),
    });
    return hash;
  },

  result,

  async disposition(actor, tool, resultEventId, disposition) {
    await logEvent({
      actor,
      verb: `tool:${tool}:disposition`,
      payload: auditPayload.toolDisposition({
        resultEventId,
        ...disposition,
      }),
    });
  },
};
