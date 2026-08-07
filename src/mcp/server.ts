// The one door (I2): agents reach Minime data only through this MCP server.

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type AuditSink, eventAuditSink } from "./audit";
import { AuditCoordinator, type CoordinatorHooks } from "./audit-coordinator";
import { AuditedServerTransport } from "./audited-transport";
import { ALL_TOOLS } from "./tools";
import {
  type ToolDef,
  executeTool,
  schemaWithCommonParams,
  timeZoneFromParams,
  toAuditableToolResult,
} from "./tools/registry";

export interface MinimeServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

export interface BuildServerOptions {
  auditSink?: AuditSink;
  tools?: readonly ToolDef[];
  hooks?: CoordinatorHooks;
  onClosed?: () => void;
}

type OwnerState = "connecting" | "open" | "closing" | "closed";

interface ConnectionOwner {
  generation: symbol;
  state: OwnerState;
  sdkServer: McpServer;
  adapter: AuditedServerTransport;
  coordinator: AuditCoordinator;
  teardown?: Promise<void>;
}

const SAFE_INTERNAL_RESULT: CallToolResult = {
  isError: true,
  content: [
    { type: "text", text: '{"error":{"code":"INTERNAL","message":"Internal tool error."}}' },
  ],
};

function safeCallToolResult(result: CallToolResult): CallToolResult {
  if (result.content.some((block) => block.type === "text" && typeof block.text !== "string")) {
    return SAFE_INTERNAL_RESULT;
  }
  return result;
}

export function buildServer(options: BuildServerOptions = {}): MinimeServer {
  const tools = options.tools ?? ALL_TOOLS;
  let owner: ConnectionOwner | undefined;

  const beginTeardown = (target: ConnectionOwner): Promise<void> => {
    if (target.teardown) return target.teardown;
    let resolveTeardown!: () => void;
    let rejectTeardown!: (reason: unknown) => void;
    const teardown = new Promise<void>((resolve, reject) => {
      resolveTeardown = resolve;
      rejectTeardown = reject;
    });
    target.state = "closing";
    target.teardown = teardown;

    const adapterClose = target.adapter.close();
    const sdkClose = target.sdkServer.close();
    void (async () => {
      let failure: unknown;
      try {
        const closes = await Promise.allSettled([adapterClose, sdkClose]);
        const rejected = closes.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (rejected) failure = rejected.reason;
        try {
          await target.adapter.drain();
        } catch (error: unknown) {
          if (failure === undefined) failure = error;
        }
      } catch (error: unknown) {
        failure = error;
      } finally {
        target.state = "closed";
        if (owner === target) owner = undefined;
        try {
          options.onClosed?.();
        } catch {
          // Lifecycle observation must not mask transport teardown.
        }
      }
      if (failure === undefined) resolveTeardown();
      else rejectTeardown(failure);
    })();
    return teardown;
  };

  const connect = async (transport: Transport): Promise<void> => {
    if (owner) throw new Error("Minime server is already connected or closing");
    const sessionId = randomUUID();
    const sdkServer = new McpServer({ name: "minime", version: "1.0.0" });
    const coordinator = new AuditCoordinator(options.auditSink ?? eventAuditSink, options.hooks);
    const knownTools = new Set(tools.map((tool) => tool.name));
    for (const tool of tools) {
      sdkServer.tool(
        tool.name,
        tool.description,
        schemaWithCommonParams(tool.schema),
        async (params, extra) =>
          safeCallToolResult(
            await coordinator.handleCallback(extra.requestId, async () => {
              const actor = `agent:${sdkServer.server.getClientVersion()?.name ?? "unknown"}`;
              const result = await executeTool(tool, params, { actor, sessionId });
              const timeZone = result.ok ? timeZoneFromParams(params) : undefined;
              const auditable = toAuditableToolResult(result, timeZone);
              return {
                toolResult: result,
                callToolResult: auditable.callToolResult,
                returnedIds: auditable.returnedIds,
                returnedCount: auditable.returnedCount,
                ok: result.ok,
                error: auditable.error,
              };
            }),
          ),
      );
    }
    const adapter = new AuditedServerTransport({
      inner: transport,
      coordinator,
      actor: () => `agent:${sdkServer.server.getClientVersion()?.name ?? "unknown"}`,
      knownTools,
    });
    const target: ConnectionOwner = {
      generation: Symbol(),
      state: "connecting",
      sdkServer,
      adapter,
      coordinator,
    };
    adapter.onclose = () => {
      void beginTeardown(target);
    };
    owner = target;
    try {
      await sdkServer.connect(adapter);
    } catch (error) {
      await beginTeardown(target);
      throw error;
    }
    if (target.state !== "connecting") {
      await beginTeardown(target);
      throw new Error("Minime connection closed during connect");
    }
    target.state = "open";
  };

  const close = (): Promise<void> => {
    const target = owner;
    if (!target) return Promise.resolve();
    return beginTeardown(target);
  };

  return { connect, close };
}

export interface RunningMinimeServer extends MinimeServer {
  readonly closed: Promise<void>;
}

export async function startMcpServer(): Promise<RunningMinimeServer> {
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const server = buildServer({ onClosed: resolveClosed });
  await server.connect(new StdioServerTransport());
  console.error("[minime] MCP server ready on stdio");
  return { ...server, closed };
}
