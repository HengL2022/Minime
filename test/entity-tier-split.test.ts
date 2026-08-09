// W4-1: identity/content tier split (037_identity_content_tier_split.sql). Owner-ratified
// 2026-08-07: a person/org's own IDENTITY (canonical name, relation, last_contact_at) lives at
// that row's OWN tier and is never raised merely because the entity is mentioned in tier-2
// content; a brand-new alias/edge genuinely DERIVED from tier-2 prose still mints at tier 2.
// minime_log_interaction's subject identity now mints at tier 1 (owner-initiated contact is
// identity-tier data, not content), while the interaction row/chunks stay tier 2.
//
// test/entity-tier-provenance.test.ts already covers the broad surface (extraction reuse across
// several scenarios, the tier-0 quarantine namespace, alias privacy-namespace mechanics, the
// forward-migration replay of 022's own historical backfill) and was updated in this same task
// for the new tier values. This file is the focused, adversarial-leak companion: the five
// scenarios the task specifically calls out, plus the guarded-trigger's own direct SQL tests
// (the definer functions never touch the tier column on an existing row any more, so the trigger
// itself is the only thing standing between a bug/bypass and an actual demotion or a stealth
// tier-0 transition).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { withAdminDbTransaction } from "../src/db/client";
import { addAlias, approveTier2UnlockRequest, ensurePerson, upsertPage } from "../src/db/repo";
import { toolByName } from "../src/mcp/tools";
import { invokeTool } from "../src/mcp/tools/registry";
import { extractAndLink } from "../src/pipeline/extract-edges";
import { expectSqlReject, resetDb, testSql } from "./helpers";
import { dropTestAppRole, mintTestAppRole } from "./support/app-role";
import { requestAndApproveTier2, sessionToolCtx } from "./support/unlock";

describe("identity/content tier split", () => {
  beforeAll(async () => {
    await resetDb();
  });

  test("(1) a tier-1 person mentioned in tier-2 content keeps identity tier 1; the alias/edge minted BY that extraction are tier 2", async () => {
    const { id: personId } = await ensurePerson("Erik Voss", "human", "manual", { tier: 1 });
    await addAlias(personId, "E. Voss", { tier: 1, createdBy: "human", source: "manual" });

    const privateText = "Erik — work friend, coffee catch-up on Tuesdays.";
    const privatePage = await upsertPage({
      path: "tier-split/erik-private.md",
      title: "Private Erik mention",
      bodyMd: privateText,
      contentHash: "tier-split-erik-private",
      tier: 2,
      source: "test",
    });
    await extractAndLink("page", privatePage.id, privateText);

    // Identity: never raised by resolving an existing identity, regardless of the mention's tier.
    const [personRow] = await testSql`select tier from people where id = ${personId}`;
    expect(personRow!.tier).toBe(1);

    // Pre-existing aliases (the auto-minted canonical spelling + the manually added one) stay
    // tier 1 — resolving them is not "deriving" them.
    const priorAliases = await testSql`
      select alias, tier from person_aliases where person_id = ${personId}
        and lower(alias) in ('erik voss', 'e. voss') order by alias`;
    expect(priorAliases.map((row) => ({ ...row }))).toEqual([
      { alias: "E. Voss", tier: 1 },
      { alias: "Erik Voss", tier: 1 },
    ]);

    // A brand-new alias minted BY this tier-2 extraction (the bare first name, never on file
    // before) is content-derived and stays at the content's own tier: 2.
    const [newAlias] = await testSql`
      select tier from person_aliases where person_id = ${personId} and lower(alias) = 'erik'`;
    expect(newAlias).toBeTruthy();
    expect(newAlias!.tier).toBe(2);

    // The graph edge this extraction produced is content, not identity: tier 2, same as before
    // the split.
    const edges = await testSql`
      select tier from edges
      where (src_type = 'person' and src_id = ${personId})
         or (dst_type = 'person' and dst_id = ${personId})`;
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((row) => row.tier === 2)).toBe(true);

    // Locked: the identity card resolves by its pre-existing name, but NOT by the new,
    // content-derived alias — that alias does not exist for a locked reader.
    const locked = sessionToolCtx("agent:tier-split-locked-1");
    const lockedByName = await invokeTool(
      toolByName("minime_get_context"),
      { person_name: "Erik Voss" },
      locked,
    );
    if (!lockedByName.ok) throw new Error(lockedByName.error.message);
    expect((lockedByName.envelope.data as any).row.id).toBe(personId);

    const lockedByNewAlias = await invokeTool(
      toolByName("minime_get_context"),
      { person_name: "Erik" },
      locked,
    );
    expect(lockedByNewAlias.ok).toBe(false);
    if (lockedByNewAlias.ok) throw new Error("unreachable");
    expect(lockedByNewAlias.error.code).toBe("NOT_FOUND");

    // Unlocked: the same content-derived alias now resolves to the very same identity.
    const unlocked = sessionToolCtx("agent:tier-split-unlocked-1");
    await requestAndApproveTier2(unlocked);
    const unlockedByNewAlias = await invokeTool(
      toolByName("minime_get_context"),
      { person_name: "Erik" },
      unlocked,
    );
    if (!unlockedByNewAlias.ok) throw new Error(unlockedByNewAlias.error.message);
    expect((unlockedByNewAlias.envelope.data as any).row.id).toBe(personId);
  });

  test("(2) a person created purely by tier-2 extraction is tier 2 and invisible at tier 1", async () => {
    const privateText = "My dentist Talia Renn at Riverside Dental checked a molar.";
    const privatePage = await upsertPage({
      path: "tier-split/talia-private.md",
      title: "Private Talia mention",
      bodyMd: privateText,
      contentHash: "tier-split-talia-private",
      tier: 2,
      source: "test",
    });
    await extractAndLink("page", privatePage.id, privateText);

    const [personRow] = await testSql`
      select id, tier from people where canonical_name = 'Talia Renn'`;
    expect(personRow).toBeTruthy();
    expect(personRow!.tier).toBe(2);

    const locked = sessionToolCtx("agent:tier-split-locked-2");
    const lockedResult = await invokeTool(
      toolByName("minime_get_context"),
      { person_name: "Talia Renn" },
      locked,
    );
    expect(lockedResult.ok).toBe(false);
    if (lockedResult.ok) throw new Error("unreachable");
    expect(lockedResult.error.code).toBe("NOT_FOUND");

    const unlocked = sessionToolCtx("agent:tier-split-unlocked-2");
    await requestAndApproveTier2(unlocked);
    const unlockedResult = await invokeTool(
      toolByName("minime_get_context"),
      { person_name: "Talia Renn" },
      unlocked,
    );
    if (!unlockedResult.ok) throw new Error(unlockedResult.error.message);
    expect((unlockedResult.envelope.data as any).row.id).toBe(personRow!.id);
  });

  test("(3) minime_log_interaction with a new name mints a tier-1 identity while the interaction row and its chunks stay tier-2-locked", async () => {
    const ctx = sessionToolCtx("agent:tier-split-interaction");
    const result = await invokeTool(
      toolByName("minime_log_interaction"),
      {
        person_name: "Fictional Nils Haugen",
        kind: "call",
        summary: "Fictional summary text that must stay tier-2-locked.",
      },
      ctx,
    );
    if (!result.ok) throw new Error(result.error.message);
    const interactionId = (result.envelope.data as any).interaction_id as string;

    const [interactionRow] = await testSql`
      select person_id, tier from interactions where id = ${interactionId}::uuid`;
    expect(interactionRow!.tier).toBe(2);
    const personId = interactionRow!.person_id as string;

    const [personRow] = await testSql`select tier from people where id = ${personId}`;
    expect(personRow!.tier).toBe(1);

    const chunks = await testSql`
      select tier from chunks where parent_type = 'interaction' and parent_id = ${interactionId}::uuid`;
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((row) => row.tier === 2)).toBe(true);

    // Same, still-locked session: the identity resolves, but the interaction's own content does
    // not — neither through the person dossier's interactions list nor by direct id.
    const dossier = await invokeTool(
      toolByName("minime_get_context"),
      { person_name: "Fictional Nils Haugen" },
      ctx,
    );
    if (!dossier.ok) throw new Error(dossier.error.message);
    expect((dossier.envelope.data as any).row.id).toBe(personId);
    expect((dossier.envelope.data as any).interactions).toEqual([]);

    const directRead = await invokeTool(
      toolByName("minime_get_context"),
      { type: "interaction", id: interactionId },
      ctx,
    );
    expect(directRead.ok).toBe(false);
  });

  test("(5a) upsert_derived_alias still refuses a tier-0 (quarantined) parent", async () => {
    const [tierZeroPerson] = await testSql`
      insert into people (canonical_name, tier, source, created_by)
      values ('Fictional Tier Zero Person', 0, 'quarantine', 'owner:test') returning id`;

    await expectSqlReject(
      testSql`select upsert_derived_alias(
        'person', ${tierZeroPerson!.id}::uuid, 'Fictional Alias Attempt',
        1::smallint, 'agent:test', 'capture', null::uuid
      )`,
      /entity_alias_parent_missing/,
    );
  });

  test("(5b) resolve_or_promote_entity never resolves into a tier-0 namesake — a readable mint proceeds independently", async () => {
    const name = "Fictional Namesake Person";
    await testSql`
      insert into people (canonical_name, tier, source, created_by)
      values (${name}, 0, 'quarantine', 'owner:test')`;

    const { id: readableId, created } = await ensurePerson(name, "human", "manual", { tier: 1 });
    expect(created).toBe(true);
    const rows = await testSql`
      select tier from people where canonical_name = ${name} order by tier`;
    expect(rows.map((row) => row.tier)).toEqual([0, 1]);
    expect(readableId).toBeTruthy();
  });
});

describe("keep_entity_tier_guarded trigger (adversarial: minime_app vs. the owner connection)", () => {
  let appRole: Awaited<ReturnType<typeof mintTestAppRole>>;
  let app: ReturnType<typeof postgres>;
  const appActor = "agent:tier-guard-adversarial";
  const appSessionId = crypto.randomUUID();

  beforeAll(async () => {
    await resetDb();
    appRole = await mintTestAppRole(process.env.DATABASE_URL!);
    // SET LOCAL ROLE below needs actual membership, not just the boundary mintTestAppRole
    // already applies directly to the minted login role — same grant
    // entity-tier-provenance.test.ts/privacy-hardening.test.ts's own adversarial app-role probes
    // already rely on.
    await testSql.unsafe(`grant minime_app to "${appRole.roleName}"`);
    app = postgres(appRole.databaseUrl, { max: 2, onnotice: () => {} });

    // Unlock this session once, up front. RLS's own tier_update policy on people/orgs
    // (tier >= 1 and tier <= app_allowed_tier()) gates which row an UPDATE can even TARGET,
    // before the trigger below ever runs -- so demoting a tier-2 row needs this session
    // unlocked just to reach the trigger at all, exactly as a real minime_app connection would
    // need to be if the owner had it unlocked when a bypass write was attempted.
    const [request] = await app.begin(async (tx) => {
      await tx`set local role minime_app`;
      await tx`select set_config('minime.actor', ${appActor}, true)`;
      await tx`select set_config('minime.session_id', ${appSessionId}, true)`;
      return tx`select app_request_tier2_unlock(5::smallint)::text as id`;
    });
    await withAdminDbTransaction(() => approveTier2UnlockRequest(request!.id, "owner:test"));
  });

  afterAll(async () => {
    await app?.end({ timeout: 2 });
    if (appRole) await dropTestAppRole(appRole);
  });

  // SET LOCAL ROLE and set_config's `true` (local) flag are both transaction-scoped, so both
  // must be re-applied on every call -- this makes current_user literally 'minime_app' (not just
  // the minted test-role name) and keeps this session's own unlock in effect for `work`.
  async function asUnlockedApp<T>(work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return (await app.begin(async (tx) => {
      await tx`set local role minime_app`;
      await tx`select set_config('minime.actor', ${appActor}, true)`;
      await tx`select set_config('minime.session_id', ${appSessionId}, true)`;
      return work(tx);
    })) as T;
  }

  test("(4) minime_app cannot demote a tier-2 person directly, with or without setting the GUC itself", async () => {
    const { id: personId } = await ensurePerson("Fictional Guarded Person", "human", "manual", {
      tier: 2,
    });

    // No GUC at all: the trigger's own current_user check refuses it outright.
    await expectSqlReject(
      asUnlockedApp((tx) => tx`update people set tier = 1 where id = ${personId}::uuid`),
      /entity_tier_demotion_forbidden/,
    );
    const [afterPlain] = await testSql`select tier from people where id = ${personId}`;
    expect(afterPlain!.tier).toBe(2);

    // Self-authorizing via the GUC does not help — minime_app can set it, but the role check is
    // independent of the GUC's value and still refuses the write (double-gated, not just GUC-gated).
    await expectSqlReject(
      asUnlockedApp(async (tx) => {
        await tx`select set_config('minime.allow_tier_demotion', '1', true)`;
        return tx`update people set tier = 1 where id = ${personId}::uuid`;
      }),
      /entity_tier_demotion_forbidden/,
    );
    const [afterGuc] = await testSql`select tier from people where id = ${personId}`;
    expect(afterGuc!.tier).toBe(2);
  });

  test("the owner connection can demote only with the GUC explicitly set (the sanctioned W4-2 path)", async () => {
    const { id: personId } = await ensurePerson(
      "Fictional Owner Guarded Person",
      "human",
      "manual",
      { tier: 2 },
    );

    await expectSqlReject(
      testSql`update people set tier = 1 where id = ${personId}`,
      /entity_tier_demotion_forbidden/,
    );
    const [beforeGuc] = await testSql`select tier from people where id = ${personId}`;
    expect(beforeGuc!.tier).toBe(2);

    await testSql.begin(async (tx) => {
      await tx`select set_config('minime.allow_tier_demotion', '1', true)`;
      await tx`update people set tier = 1 where id = ${personId}`;
    });
    const [afterGuc] = await testSql`select tier from people where id = ${personId}`;
    expect(afterGuc!.tier).toBe(1);
  });

  test("minime_app cannot cause a tier-0 transition in either direction; the owner connection still can, unconditionally", async () => {
    const { id: candidateId } = await ensurePerson(
      "Fictional Quarantine Candidate",
      "human",
      "manual",
      { tier: 1 },
    );

    // Direction 1 (readable -> quarantine): RLS lets a tier-1 row through regardless of lock
    // state, so this reaches the trigger, which refuses it outright.
    await expectSqlReject(
      asUnlockedApp((tx) => tx`update people set tier = 0 where id = ${candidateId}::uuid`),
      /entity_tier_zero_transition_forbidden/,
    );
    const [stillOne] = await testSql`select tier from people where id = ${candidateId}`;
    expect(stillOne!.tier).toBe(1);

    // The owner connection can still quarantine unconditionally — no GUC needed, unchanged from
    // before the split.
    await testSql`update people set tier = 0 where id = ${candidateId}`;
    const [nowZero] = await testSql`select tier from people where id = ${candidateId}`;
    expect(nowZero!.tier).toBe(0);

    // Direction 2 (quarantine -> readable): RLS's own tier_update policy (tier >= 1 and
    // tier <= app_allowed_tier()) already makes a tier-0 row untargetable by minime_app for ANY
    // update, at ANY tier — it never even reaches the trigger, so this silently matches zero
    // rows rather than raising. Either mechanism enforces the same invariant this direction
    // needs: minime_app can never un-quarantine a row. (The trigger's own equivalent guard for
    // this direction is defense-in-depth for a path RLS doesn't already close — the direction
    // above, which DOES reach it directly.)
    const zeroRowResult = await asUnlockedApp(
      (tx) => tx`update people set tier = 1 where id = ${candidateId}::uuid`,
    );
    expect(zeroRowResult.count).toBe(0);
    const [stillZero] = await testSql`select tier from people where id = ${candidateId}`;
    expect(stillZero!.tier).toBe(0);
  });
});
