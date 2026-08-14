// Shared tool plumbing: every tool handler returns an Envelope; invokeTool wraps it with
// audit (I8) and redaction (§8). The MCP server and the test harness both go through here,
// so what we test is exactly what agents get.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ZodRawShape, z } from "zod";
import { withActorDbSession } from "../../db/repo";
import { configuredTimeZone } from "../../util/clock";
import { type AuditSink, eventAuditSink } from "../audit";
import { type Envelope, ToolError, localizeEnvelopeDates } from "../envelope";
import { redactDeepCounted } from "../redact";

export interface ToolCtx {
  actor: string; // 'agent:<client>' | 'human'
  timeZone?: string;
  /** Private MCP connection identity. Never include this in envelopes, audit, or errors. */
  sessionId?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: ZodRawShape;
  handler: (params: any, ctx: ToolCtx) => Promise<Envelope>;
}

export type ToolResult =
  | { ok: true; envelope: Envelope }
  | { ok: false; error: { code: string; message: string; retry?: boolean } };

export const ATTEMPT_FAILURE_RESULT = {
  isError: true,
  content: [
    {
      type: "text",
      text: '{"error":{"code":"INTERNAL","message":"Tool unavailable before execution.","retry":true}}',
    },
  ],
} as const satisfies CallToolResult;

export const COMPLETED_RESULT_WITHHELD = {
  isError: false,
  content: [
    {
      type: "text",
      text: '{"data":{"status":"completed_result_withheld","retry":false},"sources":[],"gaps":["completion audit unavailable; result withheld"]}',
    },
  ],
} as const satisfies CallToolResult;

export const AUDIT_UNAVAILABLE_RESULT = {
  isError: true,
  content: [
    {
      type: "text",
      text: '{"error":{"code":"AUDIT_UNAVAILABLE","message":"Tool result withheld because completion audit is unavailable.","retry":false}}',
    },
  ],
} as const satisfies CallToolResult;

export const INTERNAL_EXECUTION_RESULT = {
  isError: true,
  content: [
    { type: "text", text: '{"error":{"code":"INTERNAL","message":"Internal tool error."}}' },
  ],
} as const satisfies CallToolResult;

export const TIME_ZONE_SCHEMA = {
  time_zone: z
    .string()
    .optional()
    .describe("IANA timezone for interpreting date-only input and rendering timestamps."),
  timezone: z.string().optional().describe("Alias for time_zone."),
};

export function schemaWithCommonParams(schema: ZodRawShape): ZodRawShape {
  return { ...schema, ...TIME_ZONE_SCHEMA };
}

export function timeZoneFromParams(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const record = params as Record<string, unknown>;
  const value = record.time_zone ?? record.timezone;
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string")
    throw new ToolError("BAD_INPUT", "time_zone must be an IANA timezone string");
  try {
    return configuredTimeZone(value);
  } catch {
    throw new ToolError("BAD_INPUT", `invalid time_zone: ${value}`);
  }
}

export async function executeTool(tool: ToolDef, params: any, ctx: ToolCtx): Promise<ToolResult> {
  try {
    const timeZone = ctx.timeZone ?? timeZoneFromParams(params);
    const parsed = z.object(schemaWithCommonParams(tool.schema)).parse(params);
    const env = await withActorDbSession(
      ctx.actor,
      () => tool.handler(parsed, { ...ctx, timeZone }),
      ctx.sessionId,
    );
    const { value: redacted, count } = redactDeepCounted(env);
    // W4-10: disclose that outbound redaction changed the answer instead of letting an agent
    // present a [REDACTED:*] placeholder as if it were the real number (spec §8 / I5's
    // disclose-rather-than-confabulate contract). Only appended when something actually fired.
    if (count > 0) {
      redacted.gaps = [
        ...(redacted.gaps ?? []),
        `outbound redaction replaced ${count} number-like string${count === 1 ? "" : "s"}`,
      ];
    }
    return { ok: true, envelope: redacted };
  } catch (err) {
    const code =
      err instanceof ToolError ? err.code : err instanceof z.ZodError ? "BAD_INPUT" : "INTERNAL";
    // ToolError and schema failures are intentional caller-facing failures. Any
    // other exception may contain SQL text, filesystem paths, provider bodies, or
    // captured content, so its wire message is fixed and opaque.
    const message =
      code === "INTERNAL"
        ? "Internal tool error."
        : err instanceof Error
          ? err.message
          : String(err);
    // redactDeepCounted here too, but the count is deliberately discarded: ToolResult's error
    // shape is { code, message[, retry] } (see the type above) with no gaps array to disclose
    // into, and inventing one here would break every caller/test matching this fixed shape.
    return { ok: false, error: { code, message: redactDeepCounted(message).value } };
  }
}

export interface AuditableToolResult {
  toolResult: ToolResult;
  callToolResult: CallToolResult;
  returnedIds: string[];
  returnedCount: number;
  error?: string;
}

export function toAuditableToolResult(result: ToolResult, timeZone?: string): AuditableToolResult {
  if (!result.ok) {
    return {
      toolResult: result,
      callToolResult: {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: result.error }) }],
      },
      returnedIds: [],
      returnedCount: 0,
      error: result.error.code,
    };
  }
  const returnedIds = result.envelope.sources.map((source) => source.id);
  return {
    toolResult: result,
    callToolResult: {
      content: [
        {
          type: "text",
          text: JSON.stringify(localizeEnvelopeDates(result.envelope, timeZone), null, 2),
        },
      ],
    },
    returnedIds,
    returnedCount: returnedIds.length,
  };
}

export async function invokeTool(
  tool: ToolDef,
  params: any,
  ctx: ToolCtx,
  auditSink: AuditSink = eventAuditSink,
): Promise<ToolResult> {
  let hash: string;
  try {
    hash = await auditSink.attempt(ctx.actor, tool.name, params);
  } catch {
    return {
      ok: false,
      error: { code: "INTERNAL", message: "Tool unavailable before execution.", retry: true },
    };
  }

  const result = await executeTool(tool, params, ctx);
  const allIds = result.ok ? result.envelope.sources.map((source) => source.id) : [];
  const ids = allIds.slice(0, 100);
  const returnedCount = allIds.length;
  const error = result.ok ? undefined : result.error.code;
  try {
    const audit = await auditSink.result(ctx.actor, tool.name, hash, {
      returnedIds: ids,
      returnedCount,
      ...(error ? { error } : {}),
      delivery: "direct",
    });
    void audit.eventId;
    return result;
  } catch {
    return result.ok
      ? {
          ok: true,
          envelope: {
            data: { status: "completed_result_withheld", retry: false },
            sources: [],
            gaps: ["completion audit unavailable; result withheld"],
          },
        }
      : {
          ok: false,
          error: {
            code: "AUDIT_UNAVAILABLE",
            message: "Tool result withheld because completion audit is unavailable.",
            retry: false,
          },
        };
  }
}
