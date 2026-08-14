// W3-10: minime_set_person_date — record a person's birthday, anniversary, or a free-form
// recurring "custom" date, so it surfaces in minime_state's upcoming_dates (next 14 days) and the
// morning brief without the owner re-remembering it every year. Resolution mirrors
// minime_get_context/minime_upsert_person (person_name or an explicit id, same tier-filtered
// read), but unlike those two this tool only ever targets a person — a date has no org
// equivalent — and both branches use the SAME direct "not found or above current access tier"
// wording (context.ts/person.ts's own name-branch is deliberately softer, offering an unlock
// hint; that wording still applies where it originated, this tool just doesn't duplicate it).
import { z } from "zod";
import { type PersonDateKind, getRow, resolvePerson, upsertPersonDate } from "../../db/repo";
import { ToolError, envelope } from "../envelope";
import type { ToolDef } from "./registry";

const KINDS = ["birthday", "anniversary", "custom"] as const satisfies readonly PersonDateKind[];

function notFoundPerson(nameOrId: string): ToolError {
  return new ToolError("NOT_FOUND", `person ${nameOrId} not found or above current access tier`);
}

// person_name takes precedence when both are given, matching minime_upsert_person's own
// resolveTarget order. getRow("person", id, actor) deliberately does not filter superseded_at
// (same as person.ts's id branch) -- resolvePerson does filter it, via the name path.
async function resolvePersonTarget(
  params: Record<string, any>,
  ctx: { actor: string },
): Promise<string> {
  if (params.person_name) {
    const row = await resolvePerson(params.person_name, ctx.actor);
    if (!row) throw notFoundPerson(params.person_name);
    return row.id as string;
  }
  if (params.person_id) {
    const row = await getRow("person", params.person_id, ctx.actor);
    if (!row) throw notFoundPerson(params.person_id);
    return row.id as string;
  }
  throw new ToolError("BAD_INPUT", "provide either person_name or person_id");
}

export const setPersonDateTool: ToolDef = {
  name: "minime_set_person_date",
  description:
    "Set a person's birthday, anniversary, or a custom recurring date (month/day, optional year). " +
    "Target by person_name (resolved the same way as minime_get_context) or person_id -- a name " +
    "or id matching nothing readable at this session's tier is NOT_FOUND, worded identically " +
    "either way. kind=custom requires a label, used to tell multiple custom dates for the same " +
    'person apart (e.g. "mom\'s memorial" vs "house purchase"); birthday/anniversary must not ' +
    "carry one -- a person has only one of each. Re-setting the same person+kind (or " +
    "person+custom+label) updates month/day/year in place instead of creating a duplicate. year " +
    "is optional (e.g. birth year) and not required for the date to recur. A date stored as Feb " +
    "29 surfaces on Feb 28 in a non-leap year, never skipped. Every date is tier 1; if the person " +
    "themselves is tier 2 (locked), the date stays invisible until an owner-approved unlock, same " +
    "as any other attribute of a locked person.",
  schema: {
    person_name: z.string().trim().min(1).max(200).optional(),
    person_id: z.string().uuid().optional(),
    kind: z.enum(KINDS),
    label: z.string().trim().min(1).max(200).optional(),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
    year: z.number().int().min(1).max(9999).optional(),
  },
  handler: async (params, ctx) => {
    const personId = await resolvePersonTarget(params, ctx);
    const kind = params.kind as PersonDateKind;
    if (kind === "custom") {
      if (params.label === undefined) {
        throw new ToolError("BAD_INPUT", "label is required for kind=custom");
      }
    } else if (params.label !== undefined) {
      throw new ToolError("BAD_INPUT", "label is only allowed for kind=custom");
    }

    const { id } = await upsertPersonDate({
      personId,
      kind,
      label: params.label ?? null,
      month: params.month,
      day: params.day,
      year: params.year ?? null,
      createdBy: ctx.actor,
      source: "manual",
    });

    return envelope(
      {
        person_date_id: id,
        person_id: personId,
        kind,
        label: params.label ?? null,
        month: params.month,
        day: params.day,
        year: params.year ?? null,
      },
      [{ type: "person_date", id }],
    );
  },
};
