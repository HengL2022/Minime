import { stateSnapshot } from "../../db/repo";
import { type SourceRef, envelope } from "../envelope";
import type { ToolDef } from "./registry";

export const stateTool: ToolDef = {
  name: "minime_state",
  description:
    "Snapshot of now: today/tomorrow calendar, due tasks, tasks moved (closed) today, captures filed today (type/confidence/title/tier), open commitments, decision reviews due, goals_active (active goals with horizon, statement, open-task count, and most recent linked-task activity), review-queue count, metric anomalies (from rollups only), upcoming_dates (birthdays/anniversaries/custom person dates recurring in the next 14 days, next occurrence only), and ops_health (nightly maintenance status: dream_last_at, failed_steps, ops_failure_open — content-free, same for every actor).",
  schema: {},
  handler: async (_params, ctx) => {
    const s = await stateSnapshot(ctx.actor, ctx.timeZone);
    const sources: SourceRef[] = [
      ...s.calendar.map((c: any) => ({ type: "calendar_event", id: c.id, title: c.title })),
      ...s.tasks_due.map((t: any) => ({ type: "task", id: t.id, title: t.title })),
      ...s.moved_today.map((t: any) => ({ type: "task", id: t.id, title: t.title })),
      // title rides as-is: stateSnapshot already resolved it through tier-filtered parentMeta,
      // masking to "[above current tier]" when the destination row isn't visible, or
      // "[retracted]" when it's visible but was withdrawn via minime_correct (repo.ts).
      ...s.filed_today.map((f: any) => ({
        type: f.type ?? f.filed_table,
        id: f.filed_id,
        title: f.title,
      })),
      ...s.commitments_open.map((c: any) => ({ type: "commitment", id: c.id, title: c.what })),
      ...s.decision_reviews_due.map((d: any) => ({
        type: "decision",
        id: d.id,
        title: d.question,
      })),
      ...s.goals_active.map((g: any) => ({ type: "goal", id: g.id, title: g.statement })),
      ...s.upcoming_dates.map((d: any) => ({
        type: "person_date",
        id: d.id,
        title: d.canonical_name,
      })),
    ];
    return envelope(s, sources);
  },
};
