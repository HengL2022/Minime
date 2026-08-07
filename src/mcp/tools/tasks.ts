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
    title: z.string().min(1).optional(),
    body: z.string().optional(),
    status: z.enum(["inbox", "active", "waiting", "done", "dropped"]).optional(),
    // due/goal_id are nullable: an explicit null CLEARS the field on an update, while
    // omitting the key entirely KEEPS it — the id-only "mark it done" case must not
    // silently wipe due/goal_id, but an agent that DOES want to detach a goal or clear
    // a due date needs a way to say so distinct from "unchanged".
    due: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    goal_id: z.string().uuid().nullable().optional(),
  },
  handler: async (params, ctx) => {
    if (!params.id && !params.title) {
      throw new ToolError("BAD_INPUT", "title is required when creating a task");
    }
    let id: string;
    let title: string;
    let body: string | null;
    try {
      ({ id, title, body } = await upsertTask({
        id: params.id ?? null,
        title: params.title ?? null,
        body: params.body ?? null,
        status: params.status ?? null,
        due: params.due,
        goalId: params.goal_id,
        createdBy: ctx.actor,
        source: "capture",
      }));
    } catch (e) {
      if (e instanceof TaskNotFoundError) throw new ToolError("NOT_FOUND", "task not found");
      throw e;
    }
    // Index the STORED title+body (returned from the write), not the raw params — an
    // id-only update omits both, and indexing params would either blank the search text
    // or (pre-existing wart) drop the body from the reindex entirely.
    await indexParent("task", id, [title, body ?? ""].join("\n\n"), undefined, 1);
    return envelope({ task_id: id }, [{ type: "task", id }]);
  },
};
