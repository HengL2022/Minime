import { z } from "zod";
import { type OpenTaskStatus, tasksInRange } from "../../db/repo";
import { todayStr } from "../../util/clock";
import { type SourceRef, envelope } from "../envelope";
import type { ToolDef } from "./registry";

const OPEN_TASK_STATUS_VALUES = [
  "inbox",
  "active",
  "waiting",
] as const satisfies readonly OpenTaskStatus[];

// Add N days to a YYYY-MM-DD string without TZ drift (UTC math, date-only).
function addDays(isoDate: string, n: number): string {
  const parts = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export const agendaTool: ToolDef = {
  name: "minime_agenda",
  description:
    "Forward-looking task agenda for a date range. Answers 'what's due tomorrow / Saturday / this week' — which minime_state CANNOT (it is today-anchored, due<=today only). Defaults to today..+7 days when no dates given. Returns open tasks (inbox/active/waiting) due in [from, to], grouped by due date. include_undated:true also returns open tasks with no due date — the ones that otherwise never resurface — in a separate `undated` list (never mixed into by_day). status:[...] narrows to a subset of open statuses (default: inbox, active, waiting).",
  schema: {
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    include_undated: z.boolean().optional(),
    status: z.array(z.enum(OPEN_TASK_STATUS_VALUES)).optional(),
  },
  handler: async (params, ctx) => {
    const from = params.from ?? todayStr(ctx.timeZone);
    // default window: a 7-day look-ahead from `from`
    const to = params.to ?? addDays(from, 7);
    const includeUndated = params.include_undated ?? false;
    const tasks = await tasksInRange(from, to, ctx.actor, {
      includeUndated,
      statuses: params.status,
    });

    // group by due date for a clean day-by-day agenda; undated tasks (only present when
    // include_undated:true) get their own list instead of a fake by_day key — by_day's
    // keys are date strings, and a task with no due date has none to offer.
    const by_day: Record<string, { id: string; title: string; status: string }[]> = {};
    const undated: { id: string; title: string; status: string }[] = [];
    for (const t of tasks) {
      if (t.due == null) {
        undated.push({ id: t.id, title: t.title, status: t.status });
        continue;
      }
      const day =
        t.due instanceof Date ? t.due.toISOString().slice(0, 10) : String(t.due).slice(0, 10);
      if (!by_day[day]) by_day[day] = [];
      by_day[day].push({ id: t.id, title: t.title, status: t.status });
    }

    const sources: SourceRef[] = tasks.map((t: any) => ({
      type: "task",
      id: t.id,
      title: t.title,
    }));
    return envelope({ from, to, count: tasks.length, by_day, undated, tasks }, sources);
  },
};
