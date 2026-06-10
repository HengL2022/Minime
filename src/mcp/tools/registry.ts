// Shared tool plumbing: every tool handler returns an Envelope; invokeTool wraps it with
// audit (I8) and redaction (§8). The MCP server and the test harness both go through here,
// so what we test is exactly what agents get.

import type { ZodRawShape } from "zod";
import { auditToolCall } from "../audit";
import { type Envelope, ToolError } from "../envelope";
import { redactDeep } from "../redact";

export interface ToolCtx {
  actor: string; // 'agent:<client>' | 'human'
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

export async function invokeTool(tool: ToolDef, params: any, ctx: ToolCtx): Promise<ToolResult> {
  try {
    const env = await tool.handler(params, ctx);
    const redacted = redactDeep(env);
    await auditToolCall({
      actor: ctx.actor,
      tool: tool.name,
      params,
      returnedIds: env.sources.map((s) => s.id),
    });
    return { ok: true, envelope: redacted };
  } catch (err) {
    const code = err instanceof ToolError ? err.code : "INTERNAL";
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
