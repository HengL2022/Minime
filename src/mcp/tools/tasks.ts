import { z } from "zod";
import { TaskNotFoundError, upsertTask } from "../../db/repo";
import { indexParent } from "../../search/index-parent";
import { ToolError, envelope } from "../envelope";
import type { ToolDef } from "./registry";

export const upsertTaskTool: ToolDef = {
  name: "minime_upsert_task",
  description: "Create or update a task (status: inbox|active|waiting|done|dropped).",
  schema: {
    id: z.string().uuid().optional(),
    title: z.string().min(1),
    body: z.string().optional(),
    status: z.enum(["inbox", "active", "waiting", "done", "dropped"]).optional(),
    due: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    goal_id: z.string().uuid().optional(),
  },
  handler: async (params, ctx) => {
    let id: string;
    try {
      ({ id } = await upsertTask({
        id: params.id ?? null,
        title: params.title,
        body: params.body ?? null,
        status: params.status ?? null,
        due: params.due ?? null,
        goalId: params.goal_id ?? null,
        createdBy: ctx.actor,
        source: "capture",
      }));
    } catch (e) {
      if (e instanceof TaskNotFoundError) throw new ToolError("NOT_FOUND", "task not found");
      throw e;
    }
    await indexParent("task", id, [params.title, params.body ?? ""].join("\n\n"), undefined, 1);
    return envelope({ task_id: id }, [{ type: "task", id }]);
  },
};
