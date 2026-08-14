import { z } from "zod";
import { TaskNotFoundError, upsertTask } from "../../db/repo";
import { indexParent } from "../../search/index-parent";
import { ToolError, envelope } from "../envelope";
import type { ToolDef } from "./registry";

const RECUR_FREQ = ["daily", "weekly", "monthly", "yearly", "none"] as const;

export const upsertTaskTool: ToolDef = {
  name: "minime_upsert_task",
  description:
    "Create or update a task (status: inbox|active|waiting|done|dropped). A recurring task " +
    "(recur_freq set) materializes its next instance automatically when marked done.",
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
    // "none" (not a bare null) clears recurrence — a JSON Schema enum reads more predictably
    // to callers than a nullable enum, and matches due/goal_id's own keep/clear split: omit
    // the key to keep, "none" to stop recurring, one of the four names to set/change it. On
    // create, recur_anchor defaults to `due` when both are given (no separate input for it —
    // non-goal: no inbox-capture syntax for recurrence, no time-of-day reminders).
    recur_freq: z.enum(RECUR_FREQ).optional(),
    recur_interval: z.number().int().min(1).max(365).optional(),
  },
  handler: async (params, ctx) => {
    if (!params.id && !params.title) {
      throw new ToolError("BAD_INPUT", "title is required when creating a task");
    }
    const recurFreq =
      params.recur_freq === undefined
        ? undefined
        : params.recur_freq === "none"
          ? null
          : params.recur_freq;
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
        recurFreq,
        recurInterval: params.recur_interval,
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
