// minime_timeline (W3-3): tier-gated date-range read across every life source. Answers period
// questions minime_agenda (forward-looking, open tasks only) and minime_state (today-anchored)
// structurally cannot — "what happened in June", "summarize last week".

import { z } from "zod";
import { type TimelineKind, timelineRows } from "../../db/repo";
import { type SourceRef, ToolError, envelope, stalenessOf } from "../envelope";
import type { ToolDef } from "./registry";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMELINE_KIND_VALUES = [
  "calendar",
  "journal",
  "interaction",
  "task",
  "decision",
] as const satisfies readonly TimelineKind[];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// state.ts's own citations use "calendar_event" for this same source (calendar_events has no
// PARENTS entry — it is a write-only importer mirror, not a correctable content row) — match
// that exact vocabulary here so a citation reads the same regardless of which tool produced it.
// The `types` filter and each row's own `kind` field stay "calendar" (the spec's mandated enum).
const SOURCE_TYPE: Record<TimelineKind, string> = {
  calendar: "calendar_event",
  journal: "journal",
  interaction: "interaction",
  task: "task",
  decision: "decision",
};

export const timelineTool: ToolDef = {
  name: "minime_timeline",
  description:
    "Tier-gated date-range read across every life source: calendar, closed tasks (done/dropped), " +
    "and decisions at tier 1, plus journal entries and interactions once tier 2 is unlocked. " +
    "Answers period questions minime_agenda (forward-looking, open tasks only) and minime_state " +
    "(today-anchored) cannot — 'what happened in June', 'summarize last week'. A locked range " +
    "still discloses that tier-2 entries exist as a bare count in `gaps` — never their titles or " +
    "ids — so a locked read is distinguishable from an empty one.",
  schema: {
    from: z.string().regex(DATE).describe("Inclusive start date, YYYY-MM-DD, in time_zone."),
    to: z.string().regex(DATE).describe("Inclusive end date, YYYY-MM-DD, in time_zone."),
    types: z
      .array(z.enum(TIMELINE_KIND_VALUES))
      .optional()
      .describe("Narrow to a subset of sources. Defaults to all five."),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    offset: z.number().int().min(0).optional(),
  },
  handler: async (params, ctx) => {
    if (params.from > params.to) {
      throw new ToolError("BAD_INPUT", "from must be on or before to");
    }
    const limit = params.limit ?? DEFAULT_LIMIT;
    const offset = params.offset ?? 0;

    const { rows, locked } = await timelineRows(
      params.from,
      params.to,
      params.types,
      limit,
      offset,
      ctx.actor,
      ctx.timeZone,
    );

    const sources: SourceRef[] = rows.map((row) => ({
      type: SOURCE_TYPE[row.kind],
      id: row.id,
      title: row.title,
      updated_at: row.at,
    }));

    const lockedTotal = locked.journal + locked.interaction;
    const gaps: string[] = [];
    if (lockedTotal > 0) {
      gaps.push(
        `${lockedTotal} tier-2 ${lockedTotal === 1 ? "entry" : "entries"} in range ${
          lockedTotal === 1 ? "is" : "are"
        } locked (${locked.journal} journal, ${locked.interaction} interaction) — an owner-approved unlock (minime_unlock) would include them`,
      );
    }

    // rows are `order by at asc, id asc` (repo.timelineRows), so the last row is the newest.
    // Reused like every other read tool (context.ts, search.ts) for parity — even though this
    // range is caller-bounded rather than open-ended, so an intentionally historical query (e.g.
    // "June 2020") will often report an old age by design, that is still real information about
    // how current the range's own newest visible row is, so it stays on rather than being
    // suppressed for bounded reads and kept only for "current state" ones.
    const newest = rows.at(-1)?.at;
    return envelope(
      { from: params.from, to: params.to, limit, offset, count: rows.length, rows, locked },
      sources,
      { staleness: stalenessOf(newest), gaps },
    );
  },
};
