import { stateSnapshot } from "../../db/repo";
import { type SourceRef, envelope } from "../envelope";
import type { ToolDef } from "./registry";

export const stateTool: ToolDef = {
  name: "minime_state",
  description:
    "Snapshot of now: today/tomorrow calendar, due tasks, open commitments, decision reviews due, review-queue count, metric anomalies (from rollups only).",
  schema: {},
  handler: async () => {
    const s = await stateSnapshot();
    const sources: SourceRef[] = [
      ...s.calendar.map((c: any) => ({ type: "calendar_event", id: c.id, title: c.title })),
      ...s.tasks_due.map((t: any) => ({ type: "task", id: t.id, title: t.title })),
      ...s.commitments_open.map((c: any) => ({ type: "commitment", id: c.id, title: c.what })),
      ...s.decision_reviews_due.map((d: any) => ({
        type: "decision",
        id: d.id,
        title: d.question,
      })),
    ];
    return envelope(s, sources);
  },
};
