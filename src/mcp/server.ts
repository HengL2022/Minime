// The one door (I2): agents reach Minime data only through this MCP server.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { localizeEnvelopeDates } from "./envelope";
import { ALL_TOOLS } from "./tools";
import { invokeTool, schemaWithCommonParams, timeZoneFromParams } from "./tools/registry";

export function buildServer(): McpServer {
  const server = new McpServer({ name: "minime", version: "1.0.0" });

  for (const tool of ALL_TOOLS) {
    server.tool(
      tool.name,
      tool.description,
      schemaWithCommonParams(tool.schema),
      async (params: any) => {
        const client = server.server.getClientVersion()?.name ?? "unknown";
        let timeZone: string | undefined;
        try {
          timeZone = timeZoneFromParams(params);
        } catch {
          // invokeTool validates and audits the structured BAD_INPUT response.
        }
        const result = await invokeTool(tool, params, { actor: `agent:${client}`, timeZone });
        if (result.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(localizeEnvelopeDates(result.envelope, timeZone), null, 2),
              },
            ],
          };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: result.error }) }],
          isError: true,
        };
      },
    );
  }
  return server;
}

export async function startMcpServer(): Promise<McpServer> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error("[minime] MCP server ready on stdio");
  return server;
}
