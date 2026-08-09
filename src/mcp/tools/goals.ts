import { z } from "zod";
import { GoalNotFoundError, type GoalRow, insertGoal, updateGoal } from "../../db/repo";
import { indexParent } from "../../search/index-parent";
import { ToolError, envelope } from "../envelope";
import type { ToolDef } from "./registry";

const HORIZON = ["life", "year", "quarter"] as const;
const STATUS = ["active", "achieved", "dropped"] as const;

function goalMd(g: { statement: string; why?: string | null }): string {
  return [g.statement, g.why ?? ""].filter(Boolean).join("\n\n");
}

export const upsertGoalTool: ToolDef = {
  name: "minime_upsert_goal",
  description:
    "Create or update a goal (horizon: life|year|quarter, fixed at creation; status: " +
    "active|achieved|dropped). horizon and statement are required when creating; omit them on " +
    "an id-only update to change only what you pass — e.g. mark a goal achieved without " +
    "resending its statement. Goals appear in minime_search and minime_state's goals_active " +
    "section with each goal's open-task count and most recent linked-task activity.",
  schema: {
    id: z.string().uuid().optional(),
    horizon: z.enum(HORIZON).optional(),
    statement: z.string().min(1).optional(),
    why: z.string().optional(),
    status: z.enum(STATUS).optional(),
    parent_id: z.string().uuid().nullable().optional(),
  },
  handler: async (params, ctx) => {
    if (!params.id) {
      if (!params.horizon || !params.statement) {
        throw new ToolError("BAD_INPUT", "horizon and statement are required when creating a goal");
      }
      const { id } = await insertGoal({
        horizon: params.horizon,
        statement: params.statement,
        why: params.why ?? null,
        parentId: params.parent_id,
        createdBy: ctx.actor,
        source: "capture",
      });
      await indexParent(
        "goal",
        id,
        goalMd({ statement: params.statement, why: params.why }),
        params.statement,
        1,
      );
      return envelope({ goal_id: id }, [{ type: "goal", id }]);
    }
    // horizon is deliberately not accepted here: a goal's horizon is set once at creation and
    // immutable via this tool (updateGoal's own signature has no horizon field) — an id-only
    // update never needs it, matching the "resend only what changed" ergonomic below.
    let goal: GoalRow;
    try {
      goal = await updateGoal(params.id, {
        statement: params.statement ?? null,
        why: params.why ?? null,
        status: params.status ?? null,
        parentId: params.parent_id,
      });
    } catch (e) {
      if (e instanceof GoalNotFoundError) throw new ToolError("NOT_FOUND", "goal not found");
      throw e;
    }
    // Index the STORED statement/why (returned from the write), not the raw params — an
    // id-only status update omits both, and indexing params would blank the search text (the
    // exact upsertTask title-rewrite wart this tool must not replicate; see repo.ts).
    await indexParent("goal", goal.id, goalMd(goal), goal.statement, 1);
    return envelope({ goal_id: goal.id }, [{ type: "goal", id: goal.id }]);
  },
};
