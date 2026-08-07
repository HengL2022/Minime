import { agendaTool } from "./agenda";
import { captureTool } from "./capture";
import { getContextTool } from "./context";
import { logDecisionTool, reviewDecisionTool } from "./decisions";
import { logInteractionTool } from "./interactions";
import { journalTool } from "./journal";
import { listMetricsTool, queryMetricTool } from "./metric";
import type { ToolDef } from "./registry";
import { reviewQueueTool } from "./review-queue";
import { searchTool } from "./search";
import { stateTool } from "./state";
import { upsertTaskTool } from "./tasks";
import { unlockTool } from "./unlock";

export const ALL_TOOLS: ToolDef[] = [
  searchTool,
  getContextTool,
  stateTool,
  listMetricsTool,
  queryMetricTool,
  captureTool,
  journalTool,
  logDecisionTool,
  reviewDecisionTool,
  upsertTaskTool,
  agendaTool,
  logInteractionTool,
  reviewQueueTool,
  unlockTool,
];

export function toolByName(name: string): ToolDef {
  const t = ALL_TOOLS.find((t) => t.name === name);
  if (!t) throw new Error(`unknown tool: ${name}`);
  return t;
}
