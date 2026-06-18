import { z } from "zod";
import { insertJournal } from "../../db/repo";
import { indexParent } from "../../search/index-parent";
import { localDateStr, now } from "../../util/clock";
import { envelope } from "../envelope";
import type { ToolDef } from "./registry";

export const journalTool: ToolDef = {
  name: "minime_journal",
  description: "Write a journal entry (tier 2: writable now, reads require unlock).",
  schema: {
    entry_md: z.string().min(1),
    mood: z.number().int().min(1).max(5).optional(),
    energy: z.number().int().min(1).max(5).optional(),
    at: z.string().datetime({ offset: true }).optional(),
  },
  handler: async (params, ctx) => {
    const at = params.at ? new Date(params.at) : undefined;
    const { id } = await insertJournal({
      entryMd: params.entry_md,
      mood: params.mood ?? null,
      energy: params.energy ?? null,
      at,
      createdBy: ctx.actor,
      source: "capture",
    });
    await indexParent(
      "journal",
      id,
      params.entry_md,
      // Local calendar day, not a UTC slice: toISOString() would title a
      // pre-dawn-local entry with yesterday's date (local past midnight, UTC
      // not yet rolled over). Mirror the `at` override when supplied.
      `Journal ${localDateStr(at ?? now(), ctx.timeZone)}`,
      2,
    );
    return envelope({ journal_entry_id: id }, [{ type: "journal", id }]);
  },
};
