// Shared tool plumbing: every tool handler returns an Envelope; invokeTool wraps it with
// audit (I8) and redaction (§8). The MCP server and the test harness both go through here,
// so what we test is exactly what agents get.

import { type ZodRawShape, z } from "zod";
import { configuredTimeZone } from "../../util/clock";
import { auditToolCall } from "../audit";
import { type Envelope, ToolError } from "../envelope";
import { redactDeep } from "../redact";

export interface ToolCtx {
  actor: string; // 'agent:<client>' | 'human'
  timeZone?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: ZodRawShape;
  handler: (params: any, ctx: ToolCtx) => Promise<Envelope>;
}

export type ToolResult =
  | { ok: true; envelope: Envelope }
  | { ok: false; error: { code: string; message: string } };

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

export async function invokeTool(tool: ToolDef, params: any, ctx: ToolCtx): Promise<ToolResult> {
  try {
    const timeZone = ctx.timeZone ?? timeZoneFromParams(params);
    const parsed = z.object(schemaWithCommonParams(tool.schema)).parse(params);
    const env = await tool.handler(parsed, { ...ctx, timeZone });
    const redacted = redactDeep(env);
    await auditToolCall({
      actor: ctx.actor,
      tool: tool.name,
      params,
      returnedIds: env.sources.map((s) => s.id),
    });
    return { ok: true, envelope: redacted };
  } catch (err) {
    const code =
      err instanceof ToolError ? err.code : err instanceof z.ZodError ? "BAD_INPUT" : "INTERNAL";
    const message = err instanceof Error ? err.message : String(err);
    await auditToolCall({
      actor: ctx.actor,
      tool: tool.name,
      params,
      returnedIds: [],
      error: code,
    }).catch(() => {});
    return { ok: false, error: { code, message: redactDeep(message) } };
  }
}
