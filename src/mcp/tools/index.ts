import { agendaTool } from "./agenda";
import { captureTool } from "./capture";
import { getContextTool } from "./context";
import { correctTool } from "./correct";
import { logDecisionTool, reviewDecisionTool } from "./decisions";
import { upsertGoalTool } from "./goals";
import { logInteractionTool } from "./interactions";
import { journalTool } from "./journal";
import { listMetricsTool, queryMetricTool } from "./metric";
import { upsertPersonTool } from "./person";
import { setPersonDateTool } from "./person-dates";
import { refileTool } from "./refile";
import type { ToolDef } from "./registry";
import { reviewQueueTool } from "./review-queue";
import { searchTool } from "./search";
import { stateTool } from "./state";
import { upsertTaskTool } from "./tasks";
import { timelineTool } from "./timeline";
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
  refileTool,
  correctTool,
  unlockTool,
  upsertPersonTool,
  setPersonDateTool,
  timelineTool,
  upsertGoalTool,
];

export function toolByName(name: string): ToolDef {
  const t = ALL_TOOLS.find((t) => t.name === name);
  if (!t) throw new Error(`unknown tool: ${name}`);
  return t;
}
