// W2-6: minime_upsert_person — alias, relation/context, and rename for a person or org, all
// tier-safe and audited. The alias-tier-inheritance test below is the safety edge this tool
// exists to get right (program risk note): a new alias must inherit the resolved entity's
// CURRENT tier, never a caller-chosen or default one, so a tier-2 person's new alias can never
// resolve at a locked (tier-1) session — an alias can never reduce an identity's privacy.
//
// Resolution (person_name or type+id) is tier-filtered exactly like minime_get_context, so every
// "does this now resolve" check below goes through minime_get_context itself (via invokeTool)
// rather than calling repo.ts's resolvePerson/resolveOrg directly — those take only an actor, not
// a session id, so a bare call outside a tool's own withActorDbSession would silently evaluate
// against an empty session and could never see a real tier-2 unlock (app_allowed_tier() keys
// unlocks by exact session_id, 023_session_unlock_approval.sql). Going through the tool is both
// correct and the more realistic end-to-end check.

import { beforeAll, describe, expect, test } from "bun:test";
import { ensureOrg, ensurePerson } from "../src/db/repo";
import { toolByName } from "../src/mcp/tools";
import { type ToolResult, invokeTool } from "../src/mcp/tools/registry";
import { resetDb, testSql } from "./helpers";
import { requestAndApproveTier2, sessionToolCtx } from "./support/unlock";

beforeAll(async () => {
  await resetDb();
});

type Ctx = ReturnType<typeof sessionToolCtx>;

function upsertPerson(ctx: Ctx, params: Record<string, unknown>): Promise<ToolResult> {
  return invokeTool(toolByName("minime_upsert_person"), params, ctx);
}

function expectOk(result: ToolResult): Record<string, any> {
  if (!result.ok)
    throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result.envelope.data as Record<string, any>;
}

function expectErr(result: ToolResult): { code: string; message: string } {
  if (result.ok) throw new Error("expected failure, got success");
  return result.error;
}

// Resolves a name the same way an agent would — through minime_get_context — so every check
// below respects the calling session's real tier (see file-header note).
async function findByName(ctx: Ctx, name: string): Promise<string | null> {
  const result = await invokeTool(toolByName("minime_get_context"), { person_name: name }, ctx);
  return result.ok ? ((result.envelope.data as any).row.id as string) : null;
}

async function eventsMarker(): Promise<number> {
  const [row] = await testSql`select coalesce(max(id), 0)::bigint as id from events`;
  return Number(row!.id);
}

async function eventPayload(verb: string, marker: number): Promise<any> {
  const [row] = await testSql`
    select payload, entity_type, entity_id from events
    where verb = ${verb} and id > ${marker}::bigint order by id limit 1`;
  return row;
}

describe("minime_upsert_person", () => {
  test("add_alias: the person resolves by the new alias, and the audit event carries only ids", async () => {
    const ctx = sessionToolCtx("agent:person-add-alias");
    const { id: personId } = await ensurePerson("Fictional Boba Nguyen", "human", "manual", {
      tier: 1,
    });
    const marker = await eventsMarker();

    const data = expectOk(
      await upsertPerson(ctx, {
        person_name: "Fictional Boba Nguyen",
        action: "add_alias",
        alias: "Fictional Bob N",
      }),
    );
    expect(data).toEqual({ type: "person", id: personId, action: "add_alias" });
    expect(await findByName(ctx, "Fictional Bob N")).toBe(personId);

    const [aliasRow] = await testSql`
      select tier, source, created_by from person_aliases
      where person_id = ${personId}::uuid and lower(alias) = lower('Fictional Bob N')`;
    expect(aliasRow!.tier).toBe(1);
    expect(aliasRow!.source).toBe("owner");
    expect(aliasRow!.created_by).toBe(ctx.actor);

    const upsertEvent = await eventPayload("person:upsert", marker);
    expect(upsertEvent!.entity_type).toBeNull(); // top-level event cols unused; ids live in payload
    expect(upsertEvent!.entity_id).toBeNull();
    expect(upsertEvent!.payload).toEqual({
      entity_type: "person",
      entity_id: personId,
      action: "add_alias",
    });
  });

  test("rename: old canonical name keeps resolving via an auto-preserved alias, new name resolves too", async () => {
    const ctx = sessionToolCtx("agent:person-rename");
    const { id: personId } = await ensurePerson("Fictional Priya Old", "human", "manual", {
      tier: 1,
    });

    const data = expectOk(
      await upsertPerson(ctx, {
        type: "person",
        id: personId,
        action: "rename",
        name: "Fictional Priya New",
      }),
    );
    expect(data).toEqual({ type: "person", id: personId, action: "rename" });

    const [row] = await testSql`select canonical_name from people where id = ${personId}::uuid`;
    expect(row!.canonical_name).toBe("Fictional Priya New");
    expect(await findByName(ctx, "Fictional Priya Old")).toBe(personId);
    expect(await findByName(ctx, "Fictional Priya New")).toBe(personId);

    // "Fictional Priya Old" was already this person's own alias from creation (ensurePerson
    // auto-aliases the initial canonical name) — rename's preserve step (upsert_derived_alias)
    // finds that row already exists and no-ops rather than rewriting it, so provenance still
    // truthfully reflects original creation, not the later rename call.
    const [oldAlias] = await testSql`
      select tier, source, created_by from person_aliases
      where person_id = ${personId}::uuid and lower(alias) = lower('Fictional Priya Old')`;
    expect(oldAlias!.tier).toBe(1);
    expect(oldAlias!.source).toBe("manual");
    expect(oldAlias!.created_by).toBe("human");
  });

  test("misspelling repair: adding the typo as an alias BEFORE it is ever used makes minime_log_interaction reuse the real person instead of minting a phantom", async () => {
    const ctx = sessionToolCtx("agent:person-repair");
    await requestAndApproveTier2(ctx);
    const { id: sarahId } = await ensurePerson("Fictional Sarah Chen", "human", "manual", {
      tier: 1,
    });

    expectOk(
      await upsertPerson(ctx, {
        person_name: "Fictional Sarah Chen",
        action: "add_alias",
        alias: "Fictional Sarha Chen",
      }),
    );

    const interactionData = expectOk(
      await invokeTool(
        toolByName("minime_log_interaction"),
        {
          person_name: "Fictional Sarha Chen", // the misspelling, used for the first time here
          kind: "message",
          summary: "Fictional note that happens to use the misspelled name.",
        },
        ctx,
      ),
    );

    const [interactionRow] = await testSql`
      select person_id from interactions where id = ${interactionData.interaction_id}::uuid`;
    expect(interactionRow!.person_id).toBe(sarahId); // attached to the real Sarah — no phantom

    const peopleNamedSarha = await testSql`
      select id from people where lower(canonical_name) = lower('Fictional Sarha Chen')`;
    expect(peopleNamedSarha).toHaveLength(0); // no separate person was ever minted

    // The interaction promotes her to tier 2 (minime_log_interaction always writes tier 2); the
    // owner's unlocked session can still find her by the misspelling going forward.
    expect(await findByName(ctx, "Fictional Sarha Chen")).toBe(sarahId);
  });

  test("add_alias refuses a string a DIFFERENT visible person already owns (current 022 conflict guard — retroactive repair is not a merge)", async () => {
    const ctx = sessionToolCtx("agent:person-conflict");
    const { id: realId } = await ensurePerson("Fictional Real Marta", "human", "manual", {
      tier: 1,
    });
    // Mints a SEPARATE phantom via the real minting path; resolve_or_promote_entity (022) gives
    // it an alias row equal to its own name. Donating that exact string to a different person
    // afterward is refused, not silently merged — merging identities is W2-7, out of scope here.
    await invokeTool(
      toolByName("minime_log_interaction"),
      { person_name: "Fictional Marta Typo", kind: "note", summary: "Fictional typo interaction." },
      ctx,
    );

    const error = expectErr(
      await upsertPerson(ctx, {
        person_name: "Fictional Real Marta",
        action: "add_alias",
        alias: "Fictional Marta Typo",
      }),
    );
    expect(error.code).toBe("BAD_INPUT");

    // The refusal wrote nothing: the alias is still only the phantom's own name, not Marta's.
    const aliasRows = await testSql`
      select person_id from person_aliases where lower(alias) = lower('Fictional Marta Typo')`;
    expect(aliasRows).toHaveLength(1);
    expect(aliasRows[0]!.person_id).not.toBe(realId);
  });

  test("tier-2 person's new alias is itself tier 2 and does NOT resolve at a locked (tier-1) session — the alias-tier-inheritance safety edge", async () => {
    const ownerCtx = sessionToolCtx("agent:person-tier2-owner");
    await requestAndApproveTier2(ownerCtx);
    // A tier-2 person, minted the way minime_log_interaction always mints its subjects.
    const interactionData = expectOk(
      await invokeTool(
        toolByName("minime_log_interaction"),
        { person_name: "Fictional Hidden Dana", kind: "call", summary: "Fictional tier-2 call." },
        ownerCtx,
      ),
    );
    const [interactionRow] = await testSql`
      select person_id from interactions where id = ${interactionData.interaction_id}::uuid`;
    const danaId = interactionRow!.person_id as string;
    const [danaRow] = await testSql`select tier from people where id = ${danaId}::uuid`;
    expect(danaRow!.tier).toBe(2);

    const data = expectOk(
      await upsertPerson(ownerCtx, {
        type: "person",
        id: danaId,
        action: "add_alias",
        alias: "Fictional D. Hidden",
      }),
    );
    expect(data).toEqual({ type: "person", id: danaId, action: "add_alias" });

    const [aliasRow] = await testSql`
      select tier from person_aliases where person_id = ${danaId}::uuid
        and lower(alias) = lower('Fictional D. Hidden')`;
    expect(aliasRow!.tier).toBe(2); // inherited the person's CURRENT tier, never a default of 1

    // A locked (tier-1) session cannot find her by the new alias — it never "outed" her.
    const lockedCtx = sessionToolCtx("agent:person-tier2-locked"); // no requestAndApproveTier2
    expect(await findByName(lockedCtx, "Fictional D. Hidden")).toBeNull();

    // Nor can it write through the tool by id — same NOT_FOUND minime_get_context would give.
    const lockedAttempt = expectErr(
      await upsertPerson(lockedCtx, {
        type: "person",
        id: danaId,
        action: "add_alias",
        alias: "Fictional Should Not Land",
      }),
    );
    expect(lockedAttempt.code).toBe("NOT_FOUND");
    const notWritten = await testSql`
      select 1 from person_aliases where person_id = ${danaId}::uuid
        and lower(alias) = lower('Fictional Should Not Land')`;
    expect(notWritten).toHaveLength(0); // the refusal wrote nothing

    // The tier-2-unlocked owner can still resolve her by the new alias.
    expect(await findByName(ownerCtx, "Fictional D. Hidden")).toBe(danaId);
  });

  test("org: add_alias and rename work the same way; set_relation/set_context are refused for org", async () => {
    const ctx = sessionToolCtx("agent:org-alias-rename");
    const { id: orgId } = await ensureOrg("Fictional Acme Clinic", "human", "manual", { tier: 1 });

    expectOk(
      await upsertPerson(ctx, {
        type: "org",
        id: orgId,
        action: "add_alias",
        alias: "Fictional Acme",
      }),
    );
    expect(await findByName(ctx, "Fictional Acme")).toBe(orgId);

    expectOk(
      await upsertPerson(ctx, {
        type: "org",
        id: orgId,
        action: "rename",
        name: "Fictional Acme Medical Clinic",
      }),
    );
    expect(await findByName(ctx, "Fictional Acme Clinic")).toBe(orgId); // old name preserved
    expect(await findByName(ctx, "Fictional Acme Medical Clinic")).toBe(orgId);

    const relationError = expectErr(
      await upsertPerson(ctx, {
        type: "org",
        id: orgId,
        action: "set_relation",
        relation: "vendor",
      }),
    );
    expect(relationError.code).toBe("BAD_INPUT");
    const contextError = expectErr(
      await upsertPerson(ctx, {
        type: "org",
        id: orgId,
        action: "set_context",
        context: "some fictional context",
      }),
    );
    expect(contextError.code).toBe("BAD_INPUT");
  });

  test("set_relation and set_context use coalesce semantics: each patches only its own field", async () => {
    const ctx = sessionToolCtx("agent:person-relation-context");
    const { id: personId } = await ensurePerson("Fictional Owen Rel", "human", "manual", {
      tier: 1,
    });

    expectOk(
      await upsertPerson(ctx, {
        type: "person",
        id: personId,
        action: "set_relation",
        relation: "my physiotherapist",
      }),
    );
    let [row] = await testSql`select relation, context from people where id = ${personId}::uuid`;
    expect(row!.relation).toBe("my physiotherapist");
    expect(row!.context).toBeNull();

    expectOk(
      await upsertPerson(ctx, {
        type: "person",
        id: personId,
        action: "set_context",
        context: "Fictional context: met at the clinic in 2024.",
      }),
    );
    [row] = await testSql`select relation, context from people where id = ${personId}::uuid`;
    expect(row!.relation).toBe("my physiotherapist"); // untouched by set_context
    expect(row!.context).toBe("Fictional context: met at the clinic in 2024.");
  });

  test("each action requires its own field, and an unresolvable target is NOT_FOUND (or BAD_INPUT with neither selector)", async () => {
    const ctx = sessionToolCtx("agent:person-bad-input");
    const { id: personId } = await ensurePerson("Fictional Val Field", "human", "manual", {
      tier: 1,
    });

    for (const action of ["add_alias", "set_relation", "set_context", "rename"]) {
      const error = expectErr(await upsertPerson(ctx, { type: "person", id: personId, action }));
      expect(error.code).toBe("BAD_INPUT");
    }

    expect(expectErr(await upsertPerson(ctx, { action: "add_alias", alias: "Whoever" })).code).toBe(
      "BAD_INPUT",
    ); // no type+id and no person_name

    const missingById = expectErr(
      await upsertPerson(ctx, {
        type: "person",
        id: crypto.randomUUID(),
        action: "add_alias",
        alias: "Ghost",
      }),
    );
    expect(missingById.code).toBe("NOT_FOUND");

    const missingByName = expectErr(
      await upsertPerson(ctx, {
        person_name: "Fictional Nobody At All",
        action: "add_alias",
        alias: "Ghost2",
      }),
    );
    expect(missingByName.code).toBe("NOT_FOUND");
    expect(missingByName.message).toContain("at the current access tier");
  });
});
