import { z } from "zod";
import { tasksInRange } from "../../db/repo";
import { todayStr } from "../../util/clock";
import { type SourceRef, envelope } from "../envelope";
import type { ToolDef } from "./registry";

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
    "Forward-looking task agenda for a date range. Answers 'what's due tomorrow / Saturday / this week' — which minime_state CANNOT (it is today-anchored, due<=today only). Defaults to today..+7 days when no dates given. Returns open tasks (inbox/active/waiting) due in [from, to], grouped by due date.",
  schema: {
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  },
  handler: async (params, ctx) => {
    const from = params.from ?? todayStr();
    // default window: a 7-day look-ahead from `from`
    const to = params.to ?? addDays(from, 7);
    const tasks = await tasksInRange(from, to, ctx.actor);

    // group by due date for a clean day-by-day agenda
    const by_day: Record<string, { id: string; title: string; status: string }[]> = {};
    for (const t of tasks) {
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
    return envelope({ from, to, count: tasks.length, by_day, tasks }, sources);
  },
};
