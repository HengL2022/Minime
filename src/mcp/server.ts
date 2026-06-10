// The one door (I2): agents reach Minime data only through this MCP server.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ALL_TOOLS } from "./tools";
import { invokeTool } from "./tools/registry";

export function buildServer(): McpServer {
  const server = new McpServer({ name: "minime", version: "1.0.0" });

  for (const tool of ALL_TOOLS) {
    server.tool(tool.name, tool.description, tool.schema, async (params: any) => {
      const client = server.server.getClientVersion()?.name ?? "unknown";
      const result = await invokeTool(tool, params, { actor: `agent:${client}` });
      if (result.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.envelope, null, 2) }],
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: result.error }) }],
        isError: true,
      };
    });
  }
  return server;
}

export async function startMcpServer(): Promise<McpServer> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error("[minime] MCP server ready on stdio");
  return server;
}
