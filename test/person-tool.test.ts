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
    // Unlocked so the phantom minted below (log_interaction always tiers its subject 2) is
    // actually VISIBLE to this session — otherwise the conflict check correctly treats it as
    // invisible (029's tier-bound fix, see the tier-oracle tests above) and this would no longer
    // exercise "a DIFFERENT VISIBLE person already owns it" at all.
    await requestAndApproveTier2(ctx);
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

  // Review fix for W2-6: upsert_derived_alias's conflict check and orgs' canonical-name
  // uniqueness both used to span tier 1+2 unconditionally, with no bound against the CALLING
  // session's own tier — so a locked (tier-1) session probing minime_upsert_person with candidate
  // strings against its OWN already-visible person/org could read the ok-vs-BAD_INPUT split as a
  // tier-2 existence oracle. 029_scope_entity_conflicts_by_tier.sql closes this by making a
  // conflict only "count" when the caller could already see it. The three tests below reproduce
  // the exact repro shape from the finding: mint a hidden tier-2 identity from an unlocked owner
  // session, then show a SEPARATE, never-unlocked session cannot distinguish "that string belongs
  // to a hidden identity" from "that string belongs to nobody" — while a same-tier (mutually
  // visible) conflict is still correctly refused, proving the fix narrows rather than removes the
  // guard.
  test("add_alias does not leak whether a hidden tier-2 person already owns the alias string — existence-oracle closed", async () => {
    const ownerCtx = sessionToolCtx("agent:alias-oracle-owner");
    await requestAndApproveTier2(ownerCtx);
    const secretName = "Fictional Secret Affair Person";
    const interactionData = expectOk(
      await invokeTool(
        toolByName("minime_log_interaction"),
        { person_name: secretName, kind: "note", summary: "Fictional hidden note." },
        ownerCtx,
      ),
    );
    const [secretRow] = await testSql`
      select person_id from interactions where id = ${interactionData.interaction_id}::uuid`;
    const secretId = secretRow!.person_id as string;
    const [secretPerson] = await testSql`select tier from people where id = ${secretId}::uuid`;
    expect(secretPerson!.tier).toBe(2); // repro precondition: a genuinely hidden tier-2 person

    // A separate, COLD, never-unlocked tier-1 session that already controls a visible person of
    // its own — zero unlocks on this session, matching the finding's probing-session setup.
    const lockedCtx = sessionToolCtx("agent:alias-oracle-locked");
    const { id: ownPersonId } = await ensurePerson(
      "Fictional Locked Session Own Contact",
      "human",
      "manual",
      { tier: 1 },
    );

    // Probing with the hidden person's EXACT name must look identical to probing with a string
    // nobody has ever used anywhere — that indistinguishability is the whole point of the fix.
    expectOk(
      await upsertPerson(lockedCtx, {
        type: "person",
        id: ownPersonId,
        action: "add_alias",
        alias: secretName,
      }),
    );
    expectOk(
      await upsertPerson(lockedCtx, {
        type: "person",
        id: ownPersonId,
        action: "add_alias",
        alias: "Fictional Definitely Never Used Anywhere",
      }),
    );

    // The write actually happened — not a silent no-op, which would just reopen the oracle on
    // the very next resolve — and it landed at the LOCKED session's own tier, never promoted
    // toward the hidden person's tier.
    expect(await findByName(lockedCtx, secretName)).toBe(ownPersonId);
    expect(await findByName(lockedCtx, "Fictional Definitely Never Used Anywhere")).toBe(
      ownPersonId,
    );
    const [newAliasRow] = await testSql`
      select tier from person_aliases where person_id = ${ownPersonId}::uuid
        and lower(alias) = lower(${secretName})`;
    expect(newAliasRow!.tier).toBe(1);

    // The hidden person is untouched: still tier 2, canonical name unchanged — not merged into
    // or exposed via the locked session's person. (Documented accepted trade-off, see 029's
    // migration comment: the alias string now legitimately matches two different entities, so an
    // ALREADY-unlocked session's exact-name resolution may pick either one — that ambiguity is
    // invisible to, and unreachable by, the locked caller exercised above.)
    const [stillSecret] = await testSql`
      select tier, canonical_name from people where id = ${secretId}::uuid`;
    expect(stillSecret!.tier).toBe(2);
    expect(stillSecret!.canonical_name).toBe(secretName);
  });

  test("org add_alias: same fix — hidden-tier conflicts are invisible to the caller, same-tier conflicts still refuse", async () => {
    const ownerCtx = sessionToolCtx("agent:org-alias-oracle-owner");
    await requestAndApproveTier2(ownerCtx);
    const hiddenAlias = "Fictional Hidden Org Alias";
    const { id: hiddenOrgId } = await ensureOrg(
      "Fictional Hidden Org Canonical",
      "human",
      "manual",
      { tier: 2 },
    );
    expectOk(
      await upsertPerson(ownerCtx, {
        type: "org",
        id: hiddenOrgId,
        action: "add_alias",
        alias: hiddenAlias,
      }),
    );

    const lockedCtx = sessionToolCtx("agent:org-alias-oracle-locked");
    const { id: visibleOrgId } = await ensureOrg("Fictional Visible Org Own", "human", "manual", {
      tier: 1,
    });
    expectOk(
      await upsertPerson(lockedCtx, {
        type: "org",
        id: visibleOrgId,
        action: "add_alias",
        alias: hiddenAlias,
      }),
    );
    expect(await findByName(lockedCtx, hiddenAlias)).toBe(visibleOrgId);

    // Same-tier (mutually visible) conflicts are still refused: the fix narrows the check to the
    // caller's own tier, it does not disable it. visibleOrgId now legitimately owns hiddenAlias
    // at tier 1 (previous step), so a second, different tier-1 org claiming it must still fail.
    const { id: otherVisibleOrgId } = await ensureOrg(
      "Fictional Other Visible Org",
      "human",
      "manual",
      { tier: 1 },
    );
    const error = expectErr(
      await upsertPerson(lockedCtx, {
        type: "org",
        id: otherVisibleOrgId,
        action: "add_alias",
        alias: hiddenAlias,
      }),
    );
    expect(error.code).toBe("BAD_INPUT");
  });

  test("rename does not leak whether the new name already belongs to a hidden tier-2 org, but a same-tier collision is still refused", async () => {
    const ownerCtx = sessionToolCtx("agent:org-rename-oracle-owner");
    await requestAndApproveTier2(ownerCtx);
    const hiddenName = "Fictional Hidden Wellness Retreat LLC";
    const { id: hiddenOrgId } = await ensureOrg(hiddenName, "human", "manual", { tier: 2 });

    const lockedCtx = sessionToolCtx("agent:org-rename-oracle-locked");
    const { id: visibleOrgId } = await ensureOrg(
      "Fictional Visible Consulting Co",
      "human",
      "manual",
      { tier: 1 },
    );
    expectOk(
      await upsertPerson(lockedCtx, {
        type: "org",
        id: visibleOrgId,
        action: "rename",
        name: hiddenName,
      }),
    );
    expect(await findByName(lockedCtx, hiddenName)).toBe(visibleOrgId);

    // The hidden org is untouched — a per-tier unique index (029), not a merge or an overwrite.
    const [stillHidden] = await testSql`
      select canonical_name, tier from orgs where id = ${hiddenOrgId}::uuid`;
    expect(stillHidden!.canonical_name).toBe(hiddenName);
    expect(stillHidden!.tier).toBe(2);

    // A same-tier collision (both orgs now visibly named alike) is still refused, not silently
    // allowed — the index split narrows org-name uniqueness to per-tier, it does not remove it.
    const { id: anotherVisibleOrgId } = await ensureOrg(
      "Fictional Another Visible Org",
      "human",
      "manual",
      { tier: 1 },
    );
    const error = expectErr(
      await upsertPerson(lockedCtx, {
        type: "org",
        id: anotherVisibleOrgId,
        action: "rename",
        name: hiddenName,
      }),
    );
    expect(error.code).toBe("BAD_INPUT");
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

  // Review fix for W2-6: a retired org (retypeOrgToPerson's soft-delete, repo.ts, marks
  // retired_at when an extractor-minted org turns out to actually be a person) was still
  // resolvable as a MUTATION target via type+id — getRow deliberately leaves retired_at
  // unfiltered for inspection tools (minime_get_context) but this tool never excluded it for
  // itself, so add_alias/rename reached upsert_derived_alias's `retired_at is null` guard (029)
  // and crashed with an opaque INTERNAL error instead of a clean domain one. resolveTarget now
  // excludes retired orgs on the type+id path too, matching resolveOrg's own name-path exclusion.
  test("retired org resolved by id is NOT_FOUND, not an opaque INTERNAL crash — add_alias and rename", async () => {
    const ctx = sessionToolCtx("agent:org-retired-target");
    const { id: orgId } = await ensureOrg("Fictional Retired Holdings Co", "human", "manual", {
      tier: 1,
    });
    // Mirrors retypeOrgToPerson's own write (repo.ts) without the full retype dance — retired_at
    // alone is what getRow leaves unfiltered and what the fix now checks for.
    await testSql`
      update orgs set retired_at = now(), retired_reason = 'fictional test retirement'
      where id = ${orgId}::uuid`;

    const aliasError = expectErr(
      await upsertPerson(ctx, {
        type: "org",
        id: orgId,
        action: "add_alias",
        alias: "Fictional Ret Alias",
      }),
    );
    expect(aliasError.code).toBe("NOT_FOUND");

    const renameError = expectErr(
      await upsertPerson(ctx, {
        type: "org",
        id: orgId,
        action: "rename",
        name: "Fictional Retired Renamed",
      }),
    );
    expect(renameError.code).toBe("NOT_FOUND");

    // Neither refusal wrote anything: no alias row landed, canonical name untouched.
    const aliasRows = await testSql`
      select 1 from org_aliases where org_id = ${orgId}::uuid
        and lower(alias) = lower('Fictional Ret Alias')`;
    expect(aliasRows).toHaveLength(0);
    const [orgRow] = await testSql`select canonical_name from orgs where id = ${orgId}::uuid`;
    expect(orgRow!.canonical_name).toBe("Fictional Retired Holdings Co");
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
