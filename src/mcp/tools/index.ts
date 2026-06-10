import { captureTool } from "./capture";
import { getContextTool } from "./context";
import { logDecisionTool, reviewDecisionTool } from "./decisions";
import { logInteractionTool } from "./interactions";
import { journalTool } from "./journal";
import { queryMetricTool } from "./metric";
import type { ToolDef } from "./registry";
import { searchTool } from "./search";
import { stateTool } from "./state";
import { upsertTaskTool } from "./tasks";
import { unlockTool } from "./unlock";

export const ALL_TOOLS: ToolDef[] = [
  searchTool,
  getContextTool,
  stateTool,
  queryMetricTool,
  captureTool,
  journalTool,
  logDecisionTool,
  reviewDecisionTool,
  upsertTaskTool,
  logInteractionTool,
  unlockTool,
];

export function toolByName(name: string): ToolDef {
  const t = ALL_TOOLS.find((t) => t.name === name);
  if (!t) throw new Error(`unknown tool: ${name}`);
  return t;
}
