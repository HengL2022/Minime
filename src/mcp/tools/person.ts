// W2-6: minime_upsert_person — the owner's one tool for correcting/enriching a person or org
// after the fact: add an alternate name, set a person's relation/context, or rename. Every
// mutation targets a row the calling session can ALREADY read (resolution below applies the
// same tier predicate as minime_get_context), so nothing here ever promotes a hidden identity
// into visibility or reveals more than a get_context call already would.
//
// Alias tier inheritance is the safety edge this tool exists to get right: a new alias always
// carries the resolved entity's CURRENT tier (never a caller-supplied or default tier), so an
// alias minted for a tier-2 person is itself tier 2 and can never make that person resolvable
// at tier 1. upsert_derived_alias (022) independently enforces the same floor at the SQL layer
// (effective tier = greatest(current entity tier, requested tier)), so this is belt-and-suspenders,
// not the only guard.
//
// Known limitation (CURRENT 022 semantics — flag for W4-1's tiering re-audit): 022's
// upsert_derived_alias refuses an alias string already owned by a DIFFERENT tier-1/2 person/org
// (entity_alias_conflict) regardless of who currently owns it or the caller's own tier — so
// add_alias can PREVENT a future misspelling-driven duplicate (add the correct alias before the
// typo is ever used) but cannot RETROACTIVELY repair one that already minted a separate phantom
// person; that needs an actual merge, out of scope here (W2-7). We surface that conflict as a
// clean BAD_INPUT rather than letting the raw Postgres exception bubble up as INTERNAL.
import { z } from "zod";
import {
  addAlias,
  addOrgAlias,
  getRow,
  logEvent,
  resolveOrg,
  resolvePerson,
  setOrgCanonicalName,
  setPersonCanonicalName,
  setPersonDetails,
} from "../../db/repo";
import { auditPayload } from "../../util/audit-payload";
import { type Envelope, ToolError, envelope } from "../envelope";
import type { ToolCtx, ToolDef } from "./registry";

type TargetType = "person" | "org";
const ACTIONS = ["add_alias", "set_relation", "set_context", "rename"] as const;
type Action = (typeof ACTIONS)[number];

function assertBadInput(condition: boolean, message: string): void {
  if (!condition) throw new ToolError("BAD_INPUT", message);
}

function notFoundById(type: TargetType, id: string): ToolError {
  return new ToolError("NOT_FOUND", `${type} ${id} not found or above current access tier`);
}

// Postgres RAISE EXCEPTION 'entity_alias_conflict' (022_entity_derivation_tiers.sql) surfaces
// with the default SQLSTATE P0001 and a message equal to the raised text, verified empirically
// against the real function (not just read off the SQL source).
function isEntityAliasConflict(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e as { code?: string }).code === "P0001" &&
    e.message === "entity_alias_conflict"
  );
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && (e as { code?: string }).code === "23505";
}

interface Target {
  type: TargetType;
  row: Record<string, any>;
}

// Mirrors minime_get_context's own resolution exactly (context.ts): type+id goes through the
// same tier-filtered getRow, and a bare name tries person then org. The NOT_FOUND wording for
// the name path is byte-identical to context.ts's on purpose — resolvePerson/resolveOrg already
// collapse "nothing exists" and "a tier-2 match exists but is locked" into the same null, so
// this tool must not add a query that would split that back into a tier-2 existence oracle.
async function resolveTarget(params: Record<string, any>, ctx: ToolCtx): Promise<Target> {
  if (params.person_name) {
    let type: TargetType = "person";
    let row = await resolvePerson(params.person_name, ctx.actor);
    if (!row) {
      type = "org";
      row = await resolveOrg(params.person_name, ctx.actor);
    }
    if (!row) {
      throw new ToolError(
        "NOT_FOUND",
        "no person or org matching that name at the current access tier — a match may exist " +
          "at tier 2; offer an owner-approved unlock (minime_unlock)",
      );
    }
    return { type, row };
  }
  if (params.type && params.id) {
    const row = await getRow(params.type, params.id, ctx.actor);
    if (!row) throw notFoundById(params.type, params.id);
    return { type: params.type, row };
  }
  throw new ToolError("BAD_INPUT", "provide either type+id or person_name");
}

// Shared by action=add_alias and action=rename's old-name preservation step.
async function addResolvedAlias(target: Target, alias: string, actor: string): Promise<void> {
  const tier = Number(target.row.tier) as 1 | 2;
  try {
    if (target.type === "person") {
      await addAlias(target.row.id, alias, { tier, createdBy: actor, source: "owner" });
    } else {
      await addOrgAlias(target.row.id, alias, { tier, createdBy: actor, source: "owner" });
    }
  } catch (e) {
    if (isEntityAliasConflict(e)) {
      throw new ToolError(
        "BAD_INPUT",
        "that alias already resolves to a different person or org at a readable tier — " +
          "merging identities is not supported yet",
      );
    }
    throw e;
  }
}

async function auditAndEnvelope(target: Target, action: Action, ctx: ToolCtx): Promise<Envelope> {
  await logEvent({
    actor: ctx.actor,
    verb: "person:upsert",
    payload: auditPayload.personUpsert({
      entityType: target.type,
      entityId: target.row.id,
      action,
    }),
  });
  return envelope({ type: target.type, id: target.row.id, action }, [
    { type: target.type, id: target.row.id },
  ]);
}

export const upsertPersonTool: ToolDef = {
  name: "minime_upsert_person",
  description:
    "Add an alias, set a person's relation/context, or rename a person or org after the fact. " +
    "Target by type+id, or person_name (resolved as a person then an org, same tier rules and " +
    "wording as minime_get_context — a name matching nothing readable at this session's tier is " +
    "NOT_FOUND). action=add_alias adds an alternate name; the new alias always inherits the " +
    "target's CURRENT privacy tier, so a tier-2 identity's alias is itself tier 2 and never " +
    "becomes resolvable at a locked (tier-1) session — it cannot be used to reduce an identity's " +
    "privacy. action=set_relation / action=set_context set the person's relation label or " +
    "free-text context (person only — org is BAD_INPUT); each patches only its own field and " +
    "never blanks the other. action=rename changes the canonical name and ALWAYS preserves the " +
    "old name as an alias first, so anything that already referred to the old name keeps " +
    "resolving. Adding an alias string already owned by a different visible person/org is " +
    "refused (BAD_INPUT) — full identity merges are not supported by this tool.",
  schema: {
    type: z.enum(["person", "org"]).optional(),
    id: z.string().uuid().optional(),
    person_name: z.string().trim().min(1).max(200).optional(),
    action: z.enum(ACTIONS),
    alias: z.string().trim().min(1).max(200).optional(),
    relation: z.string().trim().min(1).max(200).optional(),
    context: z.string().trim().min(1).max(2000).optional(),
    name: z.string().trim().min(1).max(200).optional(),
  },
  handler: async (params, ctx) => {
    const target = await resolveTarget(params, ctx);
    const action = params.action as Action;

    if (action === "add_alias") {
      assertBadInput(params.alias !== undefined, "alias is required for action=add_alias");
      await addResolvedAlias(target, params.alias, ctx.actor);
      return auditAndEnvelope(target, action, ctx);
    }

    if (action === "set_relation" || action === "set_context") {
      assertBadInput(target.type === "person", `${action} is only supported for type=person`);
      let updated: number;
      if (action === "set_relation") {
        assertBadInput(
          params.relation !== undefined,
          "relation is required for action=set_relation",
        );
        updated = await setPersonDetails(target.row.id, params.relation, null);
      } else {
        assertBadInput(params.context !== undefined, "context is required for action=set_context");
        updated = await setPersonDetails(target.row.id, null, params.context);
      }
      if (updated === 0) throw notFoundById(target.type, target.row.id);
      return auditAndEnvelope(target, action, ctx);
    }

    // rename
    assertBadInput(params.name !== undefined, "name is required for action=rename");
    const oldName = target.row.canonical_name as string;
    // Preserve the old name FIRST so it never has a moment where it stops resolving; mirrors
    // extraction's own name-upgrade behavior (resolve_or_promote_extracted_person, 022).
    await addResolvedAlias(target, oldName, ctx.actor);
    let updated: number;
    try {
      updated =
        target.type === "person"
          ? await setPersonCanonicalName(target.row.id, params.name)
          : await setOrgCanonicalName(target.row.id, params.name);
    } catch (e) {
      // orgs.canonical_name is uniquely indexed among tier-1/2 rows (022); people carries no
      // equivalent constraint (a rename can create two same-named people — no auto-merge, W2-7).
      if (target.type === "org" && isUniqueViolation(e)) {
        throw new ToolError("BAD_INPUT", "another org already has that name");
      }
      throw e;
    }
    if (updated === 0) throw notFoundById(target.type, target.row.id);
    return auditAndEnvelope(target, action, ctx);
  },
};
