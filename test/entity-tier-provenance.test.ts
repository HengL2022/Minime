import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { withAdminDbTransaction } from "../src/db/client";
import {
  addAlias,
  addOrgAlias,
  approveTier2UnlockRequest,
  resolveOrg,
  resolvePerson,
  upsertPage,
} from "../src/db/repo";
import { indexParent } from "../src/search/index-parent";
import { config } from "../src/util/config";
import { expectSqlReject, resetDb, testSql } from "./helpers";
import { dropTestAppRole, mintTestAppRole } from "./support/app-role";

let app: ReturnType<typeof postgres>;
let appRole: Awaited<ReturnType<typeof mintTestAppRole>>;

async function indexAsLockedApp(parentId: string, text: string, tier: 1 | 2): Promise<void> {
  const source = `
    import { closeDb } from "./src/db/client.ts";
    import { indexParent } from "./src/search/index-parent.ts";
    await indexParent("page", ${JSON.stringify(parentId)}, ${JSON.stringify(text)}, "Tier fixture", ${tier});
    await closeDb();
  `;
  const proc = Bun.spawn([process.execPath, "--eval", source], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: appRole.databaseUrl,
      MINIME_APP_DATABASE_URL: appRole.databaseUrl,
      MINIME_MOCK_OLLAMA: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  if (exitCode !== 0) throw new Error(`locked app index failed: ${stderr.trim()}`);
}

async function logInteractionAsLockedApp(
  name: string,
  subjectType: "auto" | "person" | "org",
  promise?: { what: string; due?: string },
): Promise<{
  data: { interaction_id: string; commitment_id?: string };
  sources: Array<{ type: string; id: string }>;
}> {
  // Building the whole params object through one JSON.stringify (rather than splicing each
  // field into the template by hand) is what lets an optional `promise` ride along for W3-13's
  // locked-role regression test below without a second copy of this harness.
  const params = {
    person_name: name,
    kind: "meeting",
    summary: "Fictional restricted-role interaction fixture.",
    subject_type: subjectType,
    ...(promise ? { promise } : {}),
  };
  const source = `
    import { closeDb } from "./src/db/client.ts";
    import { logInteractionTool } from "./src/mcp/tools/interactions.ts";
    import { executeTool } from "./src/mcp/tools/registry.ts";
    const result = await executeTool(logInteractionTool, ${JSON.stringify(params)}, {
      actor: "agent:tier-fixture",
    });
    if (!result.ok) throw new Error(result.error.message);
    process.stdout.write(JSON.stringify(result.envelope));
    await closeDb();
  `;
  const proc = Bun.spawn([process.execPath, "--eval", source], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: appRole.databaseUrl,
      MINIME_APP_DATABASE_URL: appRole.databaseUrl,
      MINIME_MOCK_OLLAMA: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`locked app interaction failed: ${stderr.trim()}`);
  return JSON.parse(stdout);
}

async function processInboxAsLockedApp(path: string): Promise<void> {
  const source = `
    import { closeDb } from "./src/db/client.ts";
    import { processInboxFile } from "./src/pipeline/watcher.ts";
    const result = await processInboxFile(${JSON.stringify(path)});
    if (!result.filed) throw new Error("locked watcher did not file interaction");
    await closeDb();
  `;
  const proc = Bun.spawn([process.execPath, "--eval", source], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: appRole.databaseUrl,
      MINIME_APP_DATABASE_URL: appRole.databaseUrl,
      MINIME_MOCK_OLLAMA: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  if (exitCode !== 0) throw new Error(`locked app watcher failed: ${stderr.trim()}`);
}

async function reviewTier2DecisionAsApprovedApp(
  decisionId: string,
  lesson: string,
): Promise<{ data: { decision_id: string; principle_id: string }; sources: unknown[] }> {
  const actor = "agent:tier-fixture";
  const sessionId = crypto.randomUUID();
  const [request] = await app.begin(async (tx) => {
    await tx`select set_config('minime.actor', ${actor}, true)`;
    await tx`select set_config('minime.session_id', ${sessionId}, true)`;
    return tx`select app_request_tier2_unlock(5::smallint)::text as id`;
  });
  await withAdminDbTransaction(() => approveTier2UnlockRequest(request!.id, "owner:test"));

  const source = `
    import { closeDb } from "./src/db/client.ts";
    import { reviewDecisionTool } from "./src/mcp/tools/decisions.ts";
    import { executeTool } from "./src/mcp/tools/registry.ts";
    const result = await executeTool(reviewDecisionTool, {
      decision_id: ${JSON.stringify(decisionId)},
      actual_outcome: "Fictional private outcome",
      lesson: ${JSON.stringify(lesson)}
    }, { actor: ${JSON.stringify(actor)}, sessionId: ${JSON.stringify(sessionId)} });
    if (!result.ok) throw new Error(result.error.message);
    process.stdout.write(JSON.stringify(result.envelope));
    await closeDb();
  `;
  const proc = Bun.spawn([process.execPath, "--eval", source], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: appRole.databaseUrl,
      MINIME_APP_DATABASE_URL: appRole.databaseUrl,
      MINIME_MOCK_OLLAMA: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`locked app decision review failed: ${stderr.trim()}`);
  return JSON.parse(stdout);
}

beforeAll(async () => {
  await resetDb();
  appRole = await mintTestAppRole(process.env.DATABASE_URL!);
  await testSql.unsafe(`grant minime_app to "${appRole.roleName}"`);
  app = postgres(appRole.databaseUrl, { max: 2, onnotice: () => {} });
});

afterAll(async () => {
  await app?.end({ timeout: 2 });
  if (appRole) await dropTestAppRole(appRole);
});

describe("derived entity tier and provenance", () => {
  test("locked tier-2 extraction reuses identities without promoting their tier or exposing tier-2 content", async () => {
    const sharedText = "My physiotherapist Liora Penn at Amber Clinic helped my shoulder.";
    const tierOne = await upsertPage({
      path: "tier/entity-one.md",
      title: "Tier one entity source",
      bodyMd: sharedText,
      contentHash: "entity-tier-one",
      tier: 1,
      source: "test",
    });
    await indexParent("page", tierOne.id, sharedText, "Tier one entity source", 1);

    const [initialPerson] = await testSql`
      select id from people where canonical_name = 'Liora Penn'`;
    const [initialOrg] = await testSql`
      select id from orgs where canonical_name = 'Amber Clinic'`;
    expect(initialPerson).toBeTruthy();
    expect(initialOrg).toBeTruthy();
    await addAlias(initialPerson!.id, "Dr Liora Penn", {
      tier: 1,
      createdBy: "test",
      source: "test",
      derivedFrom: tierOne.id,
    });

    const tierTwo = await upsertPage({
      path: "tier/entity-two.md",
      title: "Tier two entity source",
      bodyMd: sharedText,
      contentHash: "entity-tier-two",
      tier: 2,
      source: "test",
    });
    await indexAsLockedApp(tierTwo.id, sharedText, 2);

    // W4-1 identity/content tier split: the identity (people/orgs row + its pre-existing
    // aliases, all minted at tier 1 by the FIRST, tier-1 page) stays at tier 1 even though it was
    // just re-resolved by a tier-2 extraction -- resolving an EXISTING identity never raises its
    // tier. The tier-2 mention used the exact same spelling as the existing aliases, so no NEW
    // alias was minted either. The works_at EDGE below is content, not identity, so it still
    // inherits the more-private evidence tier exactly as it did before the split.
    const people = await testSql`
      select id, tier, derived_from from people where canonical_name = 'Liora Penn'`;
    const orgs = await testSql`
      select id, tier, derived_from from orgs where canonical_name = 'Amber Clinic'`;
    expect(people.map((row) => ({ ...row }))).toEqual([
      { id: initialPerson!.id, tier: 1, derived_from: tierOne.id },
    ]);
    expect(orgs.map((row) => ({ ...row }))).toEqual([
      { id: initialOrg!.id, tier: 1, derived_from: tierOne.id },
    ]);

    const personAliases = await testSql`
      select alias, tier from person_aliases where person_id = ${initialPerson!.id} order by alias`;
    expect(personAliases.map((row) => ({ ...row }))).toEqual([
      { alias: "Dr Liora Penn", tier: 1 },
      { alias: "Liora Penn", tier: 1 },
    ]);
    const orgAliases = await testSql`
      select alias, tier from org_aliases where org_id = ${initialOrg!.id} order by alias`;
    expect(orgAliases.every((row) => row.tier === 1)).toBe(true);

    const [worksAt] = await testSql`
      select id, tier, source, created_by, derived_from, source_table, source_id
      from edges
      where src_type = 'person' and src_id = ${initialPerson!.id}
        and rel = 'works_at' and dst_type = 'org' and dst_id = ${initialOrg!.id}`;
    expect(worksAt).toMatchObject({
      tier: 2,
      source: "extract",
      created_by: "system:extract",
      derived_from: tierTwo.id,
      source_table: "pages",
      source_id: tierTwo.id,
    });

    // The identity card is readable at tier 1 even by the locked app role -- that is the whole
    // point of the split. The works_at edge stays content-tier-2 and is still invisible to it.
    expect(
      (await app`select canonical_name from people where id = ${initialPerson!.id}`).map((row) => ({
        ...row,
      })),
    ).toEqual([{ canonical_name: "Liora Penn" }]);
    const lockedAliases = await app`
      select alias from person_aliases where person_id = ${initialPerson!.id}`;
    expect(lockedAliases.map((row) => row.alias).sort()).toEqual(["Dr Liora Penn", "Liora Penn"]);
    expect((await app`select id from edges where id = ${worksAt!.id}`).length).toBe(0);

    const privateText = "My dentist Sanna Lark at Cobalt Dental checked a molar.";
    const privatePage = await upsertPage({
      path: "tier/entity-private.md",
      title: "Private entity source",
      bodyMd: privateText,
      contentHash: "entity-private",
      tier: 2,
      source: "test",
    });
    await indexAsLockedApp(privatePage.id, privateText, 2);
    const [privatePerson] = await testSql`
      select id, tier, derived_from, relation from people where canonical_name = 'Sanna Lark'`;
    const [privateAlias] = await testSql`
      select tier, derived_from from person_aliases where person_id = ${privatePerson!.id}`;
    expect(privatePerson).toMatchObject({
      tier: 2,
      derived_from: privatePage.id,
      relation: "dentist",
    });
    expect(privateAlias).toMatchObject({ tier: 2, derived_from: privatePage.id });

    // W4-1: minime_log_interaction mints a brand-new subject's identity at tier 1 -- an
    // owner-initiated contact is identity-tier data, not content -- while the interaction row
    // itself (checked via the locked-app envelope shape below) stays tier-2-locked.
    const mcpPerson = await logInteractionAsLockedApp("MCP Rowan", "person");
    expect(Object.keys(mcpPerson.data)).toEqual(["interaction_id"]);
    expect(mcpPerson.sources).toEqual([{ type: "interaction", id: mcpPerson.data.interaction_id }]);
    const [mcpPersonLink] = await testSql`
      select person_id from interactions where id = ${mcpPerson.data.interaction_id}`;
    const [mcpPersonRow] = await testSql`
      select tier, derived_from, last_contact_at from people where id = ${mcpPersonLink!.person_id}`;
    expect(mcpPersonRow).toMatchObject({
      tier: 1,
      derived_from: mcpPerson.data.interaction_id,
    });
    expect(mcpPersonRow!.last_contact_at).not.toBeNull();

    const existingPersonReceipt = await logInteractionAsLockedApp("Sanna Lark", "person");
    expect(Object.keys(existingPersonReceipt.data)).toEqual(["interaction_id"]);
    expect(existingPersonReceipt.sources).toEqual([
      { type: "interaction", id: existingPersonReceipt.data.interaction_id },
    ]);

    const mcpOrg = await logInteractionAsLockedApp("Signal Harbor Ltd", "org");
    expect(Object.keys(mcpOrg.data)).toEqual(["interaction_id"]);
    expect(mcpOrg.sources).toEqual([{ type: "interaction", id: mcpOrg.data.interaction_id }]);
    const [mcpOrgLink] = await testSql`
      select org_id from interactions where id = ${mcpOrg.data.interaction_id}`;
    const [mcpOrgRow] = await testSql`
      select tier, derived_from from orgs where id = ${mcpOrgLink!.org_id}`;
    expect(mcpOrgRow).toMatchObject({ tier: 1, derived_from: mcpOrg.data.interaction_id });

    const hiddenOrgName = "Quiet Harbor";
    const [hiddenOrg] = await testSql`
      insert into orgs (canonical_name, tier, source, created_by)
      values (${hiddenOrgName}, 2, 'capture', 'human') returning id`;
    await testSql`
      insert into org_aliases (org_id, alias, tier, source, created_by)
      values (${hiddenOrg!.id}, ${hiddenOrgName}, 2, 'capture', 'human')`;
    expect((await app`select id from orgs where id = ${hiddenOrg!.id}`).length).toBe(0);

    const hiddenOrgReceipt = await logInteractionAsLockedApp(hiddenOrgName, "auto");
    expect(Object.keys(hiddenOrgReceipt.data)).toEqual(["interaction_id"]);
    expect(hiddenOrgReceipt.sources).toEqual([
      { type: "interaction", id: hiddenOrgReceipt.data.interaction_id },
    ]);
    const [hiddenOrgLink] = await testSql`
      select person_id, org_id from interactions
      where id = ${hiddenOrgReceipt.data.interaction_id}`;
    expect(hiddenOrgLink).toEqual({ person_id: null, org_id: hiddenOrg!.id });
    const [phantomAfterTool] = await testSql`
      select count(*)::int as n from people where lower(canonical_name) = lower(${hiddenOrgName})`;
    expect(phantomAfterTool!.n).toBe(0);

    const inboxDir = join(config.dataDir, "inbox");
    await mkdir(inboxDir, { recursive: true });
    const inboxPath = join(inboxDir, `hidden-org-${crypto.randomUUID()}.md`);
    await Bun.write(inboxPath, `met ${hiddenOrgName}, discussed calibration timing`);
    await processInboxAsLockedApp(inboxPath);
    const [inbox] = await testSql`
      select filed_id from inbox_items where raw_path = ${inboxPath} order by received_at desc limit 1`;
    const [watcherLink] = await testSql`
      select person_id, org_id from interactions where id = ${inbox!.filed_id}`;
    expect(watcherLink).toEqual({ person_id: null, org_id: hiddenOrg!.id });
    const [phantomAfterWatcher] = await testSql`
      select count(*)::int as n from people where lower(canonical_name) = lower(${hiddenOrgName})`;
    expect(phantomAfterWatcher!.n).toBe(0);

    const tierOneReplay = await upsertPage({
      path: "tier/entity-replay.md",
      title: "Tier one replay",
      bodyMd: sharedText,
      contentHash: "entity-replay",
      tier: 1,
      source: "test",
    });
    await indexParent("page", tierOneReplay.id, sharedText, "Tier one replay", 1);
    const [afterReplay] = await testSql`
      select tier from people where id = ${initialPerson!.id}`;
    const [edgeAfterReplay] = await testSql`
      select tier from edges where src_id = ${initialPerson!.id} and rel = 'works_at'
        and dst_id = ${initialOrg!.id}`;
    // A third mention, this time at tier 1, still doesn't touch the identity's tier (it was
    // never raised in the first place, so there's nothing to leave unchanged but everything to
    // NOT lower either -- resolving an existing identity never changes its tier either direction).
    // The edge stays content-tier-2: it's still evidenced by the tier-2 mention from earlier.
    expect(afterReplay!.tier).toBe(1);
    expect(edgeAfterReplay!.tier).toBe(2);

    const concurrentName = "Concurrent Rowan";
    const calls = await Promise.all([
      app`select * from resolve_or_promote_entity(
        'person', ${concurrentName}, 2::smallint, 'system:extract', 'extract', ${privatePage.id}::uuid)`,
      app`select * from resolve_or_promote_entity(
        'person', ${concurrentName}, 2::smallint, 'system:extract', 'extract', ${privatePage.id}::uuid)`,
    ]);
    expect(calls[0]![0]!.entity_id).toBe(calls[1]![0]!.entity_id);
    const [concurrentCount] = await testSql`
      select count(*)::int as n from people where canonical_name = ${concurrentName}`;
    expect(concurrentCount!.n).toBe(1);

    await expectSqlReject(
      app`insert into edges
        (src_type, src_id, rel, dst_type, dst_id, extracted_by)
        values ('page', ${crypto.randomUUID()}, 'mentions', 'person', ${crypto.randomUUID()},
                'system:extract')`,
      /extracted_edge_source_invalid/,
    );
  });

  test("locked tier-2 extraction still blocks family works_at edges for a mentioned tier-1 daughter", async () => {
    const childName = "Mina Solberg";
    const [child] = await testSql`
      insert into people (canonical_name, relation, tier, source, created_by)
      values (${childName}, 'daughter', 1, 'capture', 'human') returning id`;
    await testSql`
      insert into person_aliases (person_id, alias, tier, source, created_by)
      values (${child!.id}, ${childName}, 1, 'capture', 'human')`;
    const text =
      "Mina Solberg joined her violin class; meanwhile work at Havlyd AS continued and she visited Lade Fysio.";
    const page = await upsertPage({
      path: "tier/private-family.md",
      title: "Private family source",
      bodyMd: text,
      contentHash: "private-family-source",
      tier: 2,
      source: "test",
    });

    await indexAsLockedApp(page.id, text, 2);

    // W4-1: her identity stays tier 1 (never promoted by the mention) -- the family-relation
    // work-edge guard below is independent of tier and must still hold either way.
    const [afterMention] = await testSql`select tier from people where id = ${child!.id}`;
    expect(afterMention!.tier).toBe(1);
    const [worksAt] = await testSql`
      select count(*)::int as n from edges
      where src_type = 'person' and src_id = ${child!.id} and rel = 'works_at'`;
    expect(worksAt!.n).toBe(0);
    const [mentions] = await testSql`
      select count(*)::int as n from edges
      where dst_type = 'person' and dst_id = ${child!.id} and rel = 'mentions'`;
    expect(mentions!.n).toBeGreaterThan(0);
  });

  test("locked tier-2 extraction reconciles person and org name variants without forks", async () => {
    const cases = [
      {
        path: "tier/private-short-person.md",
        text: "Tavian — work friend, board games on Thursdays.",
      },
      {
        path: "tier/private-full-person.md",
        text: "Tavian Orre — my mentor since 2021.",
      },
      {
        path: "tier/private-full-first.md",
        text: "Ylva Strand — my mentor since 2022.",
      },
      {
        path: "tier/private-short-second.md",
        text: "Ylva — work friend, trail walks on Sundays.",
      },
      {
        path: "tier/private-org-base.md",
        text: "I joined Silver Quay in 2024 as a designer.",
      },
      {
        path: "tier/private-org-suffix.md",
        text: "I joined Silver Quay AS in 2025 as a designer.",
      },
    ];
    for (const [index, fixture] of cases.entries()) {
      const page = await upsertPage({
        path: fixture.path,
        title: `Private variant ${index}`,
        bodyMd: fixture.text,
        contentHash: `private-variant-${index}`,
        tier: 2,
        source: "test",
      });
      await indexAsLockedApp(page.id, fixture.text, 2);
    }

    const tavian = await testSql`
      select id, canonical_name, tier from people
      where lower(split_part(canonical_name, ' ', 1)) = 'tavian'`;
    expect(tavian.map((row) => ({ ...row }))).toEqual([
      { id: tavian[0]!.id, canonical_name: "Tavian Orre", tier: 2 },
    ]);
    const tavianAliases = await testSql`
      select alias from person_aliases where person_id = ${tavian[0]!.id} order by alias`;
    expect(tavianAliases.map((row) => row.alias)).toEqual(["Tavian", "Tavian Orre"]);

    const ylva = await testSql`
      select id, canonical_name, tier from people
      where lower(split_part(canonical_name, ' ', 1)) = 'ylva'`;
    expect(ylva.map((row) => ({ ...row }))).toEqual([
      { id: ylva[0]!.id, canonical_name: "Ylva Strand", tier: 2 },
    ]);
    const ylvaAliases = await testSql`
      select alias from person_aliases where person_id = ${ylva[0]!.id} order by alias`;
    expect(ylvaAliases.map((row) => row.alias)).toEqual(["Ylva", "Ylva Strand"]);

    const silverQuay = await testSql`
      select id, canonical_name, tier from orgs
      where lower(canonical_name) in ('silver quay', 'silver quay as')`;
    expect(silverQuay.map((row) => ({ ...row }))).toEqual([
      { id: silverQuay[0]!.id, canonical_name: "Silver Quay AS", tier: 2 },
    ]);
    const orgAliases = await testSql`
      select alias from org_aliases where org_id = ${silverQuay[0]!.id} order by alias`;
    expect(orgAliases.map((row) => row.alias)).toEqual(["Silver Quay", "Silver Quay AS"]);
  });

  test("a reviewed tier-2 decision keeps its lesson, graph, and identities tier 2", async () => {
    const [decision] = await testSql`
      insert into decisions
        (question, options, choice, created_by, source, tier)
      values
        ('Private fixture decision?', '["yes","no"]'::jsonb, 'yes',
         'agent:tier-fixture', 'capture', 2)
      returning id`;
    const lesson =
      "My dentist Nella Voss at Obsidian Dental taught me to confirm the private plan in writing.";
    const receipt = await reviewTier2DecisionAsApprovedApp(decision!.id, lesson);
    expect(receipt.data.decision_id).toBe(decision!.id);
    expect(receipt.data.principle_id).toBeString();

    const [principle] = await testSql`
      select tier, derived_from, source, created_by
      from principles where id = ${receipt.data.principle_id}`;
    expect(principle).toEqual({
      tier: 2,
      derived_from: decision!.id,
      source: "review",
      created_by: "agent:tier-fixture",
    });
    const chunks = await testSql`
      select tier from chunks
      where parent_type = 'principle' and parent_id = ${receipt.data.principle_id}`;
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((row) => row.tier === 2)).toBe(true);

    const [person] = await testSql`
      select id, tier, derived_from from people where canonical_name = 'Nella Voss'`;
    const [org] = await testSql`
      select id, tier, derived_from from orgs where canonical_name = 'Obsidian Dental'`;
    expect(person).toMatchObject({ tier: 2, derived_from: receipt.data.principle_id });
    expect(org).toMatchObject({ tier: 2, derived_from: receipt.data.principle_id });

    const graph = await testSql`
      select tier, source, created_by, derived_from, source_id
      from edges
      where (source_table = 'principles' and source_id = ${receipt.data.principle_id})
         or (src_type = 'principle' and src_id = ${receipt.data.principle_id}
             and rel = 'learned_from')`;
    expect(graph.length).toBeGreaterThan(0);
    expect(graph.every((row) => row.tier === 2)).toBe(true);
    expect(
      graph.every(
        (row) =>
          row.derived_from === row.source_id &&
          (row.created_by === "agent:tier-fixture" || row.created_by === "system:extract"),
      ),
    ).toBe(true);

    expect(
      (await app`select id from principles where id = ${receipt.data.principle_id}`).length,
    ).toBe(0);
    expect(
      (
        await app`select id from chunks
          where parent_type = 'principle' and parent_id = ${receipt.data.principle_id}`
      ).length,
    ).toBe(0);
    expect((await app`select id from people where id = ${person!.id}`).length).toBe(0);
    expect((await app`select id from orgs where id = ${org!.id}`).length).toBe(0);
    expect(
      (
        await app`select id from edges
          where source_id = ${receipt.data.principle_id}
             or (src_type = 'principle' and src_id = ${receipt.data.principle_id})`
      ).length,
    ).toBe(0);
  });

  test("tier-0 identities and edge provenance remain quarantined under readable writes", async () => {
    const tierZeroPersonName = "Quarantined Rowan";
    const tierZeroOrgName = "Quarantined Harbor";
    const [tierZeroPerson] = await testSql`
      insert into people (canonical_name, relation, tier, source, created_by)
      values (${tierZeroPersonName}, 'daughter', 0, 'quarantine', 'owner:test') returning id`;
    await testSql`
      insert into person_aliases (person_id, alias, tier, source, created_by)
      values
        (${tierZeroPerson!.id}, ${tierZeroPersonName}, 0, 'quarantine', 'owner:test'),
        (${tierZeroPerson!.id}, 'Quarantined Rowan Private Alias', 0, 'quarantine', 'owner:test')`;
    const [tierZeroOrg] = await testSql`
      insert into orgs (canonical_name, tier, source, created_by)
      values (${tierZeroOrgName}, 0, 'quarantine', 'owner:test') returning id`;
    await testSql`
      insert into org_aliases (org_id, alias, tier, source, created_by)
      values
        (${tierZeroOrg!.id}, ${tierZeroOrgName}, 0, 'quarantine', 'owner:test'),
        (${tierZeroOrg!.id}, 'Quarantined Harbor Private Alias', 0, 'quarantine', 'owner:test')`;

    const [structural] = await app`
      select person_has_nonworking_relation(${tierZeroPerson!.id}::uuid) as family,
             exact_active_org_exists(${tierZeroOrgName}) as org_exists,
             readable_source_tier('people', ${tierZeroPerson!.id}::uuid) as source_tier`;
    expect(structural).toEqual({ family: false, org_exists: false, source_tier: null });
    await expectSqlReject(
      app`select edge_source_tier('people', ${tierZeroPerson!.id}::uuid)`,
      /permission denied/,
    );

    // The tier-0 name is excluded from resolution, so a brand-new READABLE identity mints
    // instead of reusing the quarantined one -- at tier 1 (W4-1's interaction-mint tier), not the
    // quarantined row's tier 0.
    const personReceipt = await logInteractionAsLockedApp(tierZeroPersonName, "person");
    const [personLink] = await testSql`
      select person_id from interactions where id = ${personReceipt.data.interaction_id}`;
    expect(personLink!.person_id).not.toBe(tierZeroPerson!.id);
    const [readablePerson] = await testSql`
      select tier from people where id = ${personLink!.person_id}`;
    expect(readablePerson!.tier).toBe(1);
    await app`select upsert_derived_alias(
      'person', ${personLink!.person_id}::uuid, 'Quarantined Rowan Private Alias',
      2::smallint, 'agent:tier-fixture', 'capture', ${personReceipt.data.interaction_id}::uuid
    )`;

    const orgReceipt = await logInteractionAsLockedApp(tierZeroOrgName, "org");
    const [orgLink] = await testSql`
      select org_id from interactions where id = ${orgReceipt.data.interaction_id}`;
    expect(orgLink!.org_id).not.toBe(tierZeroOrg!.id);
    const [readableOrg] = await testSql`select tier from orgs where id = ${orgLink!.org_id}`;
    expect(readableOrg!.tier).toBe(1);
    await app`select upsert_derived_alias(
      'org', ${orgLink!.org_id}::uuid, 'Quarantined Harbor Private Alias',
      2::smallint, 'agent:tier-fixture', 'capture', ${orgReceipt.data.interaction_id}::uuid
    )`;
    const readableAliases = await testSql`
      select alias from person_aliases where person_id = ${personLink!.person_id}
      union all
      select alias from org_aliases where org_id = ${orgLink!.org_id}`;
    expect(readableAliases.map((row) => row.alias)).toContain("Quarantined Rowan Private Alias");
    expect(readableAliases.map((row) => row.alias)).toContain("Quarantined Harbor Private Alias");

    const [tierZeroSource] = await testSql`
      insert into pages (path, title, body_md, content_hash, tier, source, created_by)
      values ('tier/edge-zero.md', 'Tier zero edge source', 'quarantine',
              'tier-zero-edge-source', 0, 'quarantine', 'owner:test') returning id`;
    const [tierTwoSource] = await testSql`
      insert into pages (path, title, body_md, content_hash, tier, source, created_by)
      values ('tier/edge-two.md', 'Tier two edge source', 'private',
              'tier-two-edge-source', 2, 'capture', 'agent:tier-fixture') returning id`;
    await testSql`
      insert into edges
        (src_type, src_id, rel, dst_type, dst_id, source_table, source_id,
         extracted_by, confidence, tier, source, created_by, derived_from)
      values
        ('person', ${personLink!.person_id}, 'works_at', 'org', ${orgLink!.org_id},
         'pages', ${tierZeroSource!.id}, 'system:extract', 0.4, 0,
         'extract', 'system:extract', ${tierZeroSource!.id}),
        ('person', ${personLink!.person_id}, 'works_at', 'org', ${orgLink!.org_id},
         'pages', ${tierTwoSource!.id}, 'system:extract', 0.6, 2,
         'extract', 'system:extract', ${tierTwoSource!.id})`;
    const [upsert] = await app`
      select upsert_extracted_edge(
        'person', ${personLink!.person_id}::uuid, 'works_at',
        'org', ${orgLink!.org_id}::uuid, 'pages', ${tierTwoSource!.id}::uuid, 0.9::real
      ) as created`;
    expect(upsert!.created).toBe(false);
    const merged = await testSql`
      select tier, source_id, derived_from, confidence
      from edges
      where src_type = 'person' and src_id = ${personLink!.person_id}
        and rel = 'works_at' and dst_type = 'org' and dst_id = ${orgLink!.org_id}`;
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      tier: 0,
      source_id: tierZeroSource!.id,
      derived_from: tierZeroSource!.id,
      confidence: 0.9,
    });
    expect(
      (
        await app`select id from edges
          where src_id = ${personLink!.person_id} and dst_id = ${orgLink!.org_id}`
      ).length,
    ).toBe(0);
  });

  test("alias privacy namespaces coexist, resolve independently, and merge on quarantine", async () => {
    const [person] = await testSql`
      insert into people (canonical_name, tier, source, created_by)
      values ('Namespace Person', 1, 'test', 'test') returning id`;
    const personAlias = "Shared Namespace Person Alias";
    await addAlias(person!.id, personAlias, {
      tier: 1,
      source: "test",
      createdBy: "agent:test",
    });
    // Insert the readable namespace first: the parent cascade must safely delete it even if
    // the outer UPDATE has not visited the later quarantine twin yet.
    await testSql`
      insert into person_aliases (person_id, alias, tier, source, created_by)
      values (${person!.id}, ${personAlias}, 0, 'quarantine', 'owner:test')`;
    const personTwins = await testSql`
      select tier, privacy_namespace from person_aliases
      where person_id = ${person!.id} and alias = ${personAlias} order by tier`;
    expect(personTwins.map((row) => ({ ...row }))).toEqual([
      { tier: 0, privacy_namespace: 0 },
      { tier: 1, privacy_namespace: 1 },
    ]);
    expect((await resolvePerson(personAlias))?.id).toBe(person!.id);

    const [org] = await testSql`
      insert into orgs (canonical_name, tier, source, created_by)
      values ('Namespace Org', 1, 'test', 'test') returning id`;
    const orgAlias = "Shared Namespace Org Alias";
    await testSql`
      insert into org_aliases (org_id, alias, tier, source, created_by)
      values (${org!.id}, ${orgAlias}, 0, 'quarantine', 'owner:test')`;
    await addOrgAlias(org!.id, orgAlias, {
      tier: 1,
      source: "test",
      createdBy: "agent:test",
    });
    expect((await resolveOrg(orgAlias))?.id).toBe(org!.id);

    await testSql`
      update org_aliases set tier = 0
      where org_id = ${org!.id} and alias = ${orgAlias} and privacy_namespace = 1`;
    const orgAfterDirectQuarantine = await testSql`
      select tier, privacy_namespace from org_aliases
      where org_id = ${org!.id} and alias = ${orgAlias}`;
    expect(orgAfterDirectQuarantine.map((row) => ({ ...row }))).toEqual([
      { tier: 0, privacy_namespace: 0 },
    ]);
    expect(await resolveOrg(orgAlias)).toBeNull();

    const personPhysicalOrder = await testSql`
      select privacy_namespace from person_aliases
      where person_id = ${person!.id} and alias = ${personAlias}
      order by ctid`;
    expect(personPhysicalOrder.map((row) => row.privacy_namespace)).toEqual([1, 0]);

    await testSql`update people set tier = 0 where id = ${person!.id}`;
    await testSql`update orgs set tier = 0 where id = ${org!.id}`;
    const personAfter = await testSql`
      select tier, privacy_namespace from person_aliases
      where person_id = ${person!.id} and alias = ${personAlias}`;
    const orgAfter = await testSql`
      select tier, privacy_namespace from org_aliases
      where org_id = ${org!.id} and alias = ${orgAlias}`;
    expect(personAfter.map((row) => ({ ...row }))).toEqual([{ tier: 0, privacy_namespace: 0 }]);
    expect(orgAfter.map((row) => ({ ...row }))).toEqual([{ tier: 0, privacy_namespace: 0 }]);
    expect(await resolvePerson(personAlias)).toBeNull();
    expect(await resolveOrg(orgAlias)).toBeNull();
  });

  test("alias insertion serializes with parent quarantine", async () => {
    const [person] = await testSql`
      insert into people (canonical_name, tier, source, created_by)
      values ('Concurrent Alias Parent', 1, 'test', 'test') returning id`;
    const alias = "Concurrent Alias Fixture";

    let inserted!: () => void;
    const insertedPromise = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    let releaseInsert!: () => void;
    const holdInsert = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    const aliasInsert = app.begin(async (tx) => {
      await tx`set local role minime_app`;
      await tx`
        insert into person_aliases (person_id, alias, tier, source, created_by)
        values (${person!.id}, ${alias}, 1, 'test', 'agent:test')`;
      inserted();
      await holdInsert;
    });
    await insertedPromise;

    let quarantineSettled = false;
    const quarantine = (async () => {
      await testSql`update people set tier = 0 where id = ${person!.id}`;
      quarantineSettled = true;
    })();
    await Bun.sleep(75);
    const quarantineCompletedBeforeInsert = quarantineSettled;
    releaseInsert();
    await Promise.all([aliasInsert, quarantine]);

    expect(quarantineCompletedBeforeInsert).toBe(false);
    const aliases = await testSql`
      select tier, privacy_namespace from person_aliases
      where person_id = ${person!.id} and alias = ${alias}`;
    expect(aliases.map((row) => ({ ...row }))).toEqual([{ tier: 0, privacy_namespace: 0 }]);
    const visibleAliases = await app.begin(async (tx) => {
      await tx`set local role minime_app`;
      return tx`select alias from person_aliases where person_id = ${person!.id}`;
    });
    expect(visibleAliases).toHaveLength(0);
  });

  test("alias read policies require a readable parent even if stored tiers drift", async () => {
    const [person] = await testSql`
      insert into people (canonical_name, tier, source, created_by)
      values ('Drifted Alias Person', 1, 'test', 'test') returning id`;
    const [org] = await testSql`
      insert into orgs (canonical_name, tier, source, created_by)
      values ('Drifted Alias Org', 1, 'test', 'test') returning id`;
    await testSql`
      insert into person_aliases (person_id, alias, tier, source, created_by)
      values (${person!.id}, 'Drifted Person Alias', 1, 'test', 'test')`;
    await testSql`
      insert into org_aliases (org_id, alias, tier, source, created_by)
      values (${org!.id}, 'Drifted Org Alias', 1, 'test', 'test')`;

    await testSql.begin(async (tx) => {
      await tx`alter table people disable trigger people_cascade_tier_to_aliases`;
      await tx`alter table orgs disable trigger orgs_cascade_tier_to_aliases`;
      await tx`update people set tier = 0 where id = ${person!.id}`;
      await tx`update orgs set tier = 0 where id = ${org!.id}`;
      await tx`alter table people enable trigger people_cascade_tier_to_aliases`;
      await tx`alter table orgs enable trigger orgs_cascade_tier_to_aliases`;
    });
    const stored = await testSql`
      select 'person' as kind, tier from person_aliases where person_id = ${person!.id}
      union all
      select 'org' as kind, tier from org_aliases where org_id = ${org!.id}
      order by kind`;
    expect(stored.map((row) => ({ ...row }))).toEqual([
      { kind: "org", tier: 1 },
      { kind: "person", tier: 1 },
    ]);
    const visible = await app.begin(async (tx) => {
      await tx`set local role minime_app`;
      const people = await tx`select alias from person_aliases where person_id = ${person!.id}`;
      const orgs = await tx`select alias from org_aliases where org_id = ${org!.id}`;
      return { people, orgs };
    });
    expect(visible.people).toHaveLength(0);
    expect(visible.orgs).toHaveLength(0);
  });

  test("a lone readable alias moves into quarantine without blocking a readable twin", async () => {
    const [person] = await testSql`
      insert into people (canonical_name, tier, source, created_by)
      values ('Lone Alias Person', 1, 'test', 'test') returning id`;
    const [org] = await testSql`
      insert into orgs (canonical_name, tier, source, created_by)
      values ('Lone Alias Org', 1, 'test', 'test') returning id`;
    const personAlias = "Lone Person Alias";
    const orgAlias = "Lone Org Alias";
    const personDerivation = crypto.randomUUID();
    const orgDerivation = crypto.randomUUID();
    await addAlias(person!.id, personAlias, {
      tier: 1,
      source: "test",
      createdBy: "agent:test",
      derivedFrom: personDerivation,
    });
    await addOrgAlias(org!.id, orgAlias, {
      tier: 1,
      source: "test",
      createdBy: "agent:test",
      derivedFrom: orgDerivation,
    });

    await testSql`
      update person_aliases set tier = 0
      where person_id = ${person!.id} and alias = ${personAlias}`;
    await testSql`
      update org_aliases set tier = 0
      where org_id = ${org!.id} and alias = ${orgAlias}`;
    const quarantined = await testSql`
      select 'person' as kind, tier, privacy_namespace, source, created_by, derived_from
      from person_aliases
      where person_id = ${person!.id} and alias = ${personAlias}
      union all
      select 'org' as kind, tier, privacy_namespace, source, created_by, derived_from
      from org_aliases
      where org_id = ${org!.id} and alias = ${orgAlias}
      order by kind`;
    expect(quarantined.map((row) => ({ ...row }))).toEqual([
      {
        kind: "org",
        tier: 0,
        privacy_namespace: 0,
        source: "test",
        created_by: "agent:test",
        derived_from: orgDerivation,
      },
      {
        kind: "person",
        tier: 0,
        privacy_namespace: 0,
        source: "test",
        created_by: "agent:test",
        derived_from: personDerivation,
      },
    ]);

    await addAlias(person!.id, personAlias, {
      tier: 1,
      source: "test",
      createdBy: "agent:test",
    });
    await addOrgAlias(org!.id, orgAlias, {
      tier: 1,
      source: "test",
      createdBy: "agent:test",
    });
    const twins = await testSql`
      select 'person' as kind, tier, privacy_namespace from person_aliases
      where person_id = ${person!.id} and alias = ${personAlias}
      union all
      select 'org' as kind, tier, privacy_namespace from org_aliases
      where org_id = ${org!.id} and alias = ${orgAlias}
      order by kind, tier`;
    expect(twins.map((row) => ({ ...row }))).toEqual([
      { kind: "org", tier: 0, privacy_namespace: 0 },
      { kind: "org", tier: 1, privacy_namespace: 1 },
      { kind: "person", tier: 0, privacy_namespace: 0 },
      { kind: "person", tier: 1, privacy_namespace: 1 },
    ]);
    expect((await resolvePerson(personAlias))?.id).toBe(person!.id);
    expect((await resolveOrg(orgAlias))?.id).toBe(org!.id);
  });

  test("forward migration repairs tier/provenance for legacy derived rows", async () => {
    const [source] = await testSql`
      insert into pages (path, title, body_md, content_hash, tier, source, created_by)
      values ('tier/legacy-private.md', 'Legacy private source', 'fixture',
              'legacy-private-source', 2, 'capture', 'agent:legacy') returning id`;
    const [person] = await testSql`
      insert into people (canonical_name, tier, source, created_by)
      values ('Legacy Private Person', 1, 'extract', 'system:extract') returning id`;
    const [org] = await testSql`
      insert into orgs (canonical_name, tier, source, created_by)
      values ('Legacy Private Org', 1, 'extract', 'system:extract') returning id`;
    const [tierZeroSource] = await testSql`
      insert into pages (path, title, body_md, content_hash, tier, source, created_by)
      values ('tier/legacy-zero.md', 'Legacy tier-zero source', 'fixture',
              'legacy-zero-source', 0, 'quarantine', 'owner:legacy') returning id`;
    const [tierZeroPerson] = await testSql`
      insert into people (canonical_name, tier, source, created_by)
      values ('Legacy Quarantined Person', 1, 'extract', 'system:extract') returning id`;
    const [tierZeroOrg] = await testSql`
      insert into orgs (canonical_name, tier, source, created_by)
      values ('Legacy Quarantined Org', 1, 'extract', 'system:extract') returning id`;
    await testSql`
      insert into person_aliases (person_id, alias, tier, source, created_by)
      values (${person!.id}, 'Legacy Private Person', 1, 'extract', 'system:extract')`;
    await testSql`
      insert into org_aliases (org_id, alias, tier, source, created_by)
      values (${org!.id}, 'Legacy Private Org', 1, 'extract', 'system:extract')`;
    await testSql`
      insert into person_aliases (person_id, alias, tier, source, created_by)
      values (${tierZeroPerson!.id}, 'Legacy Quarantined Person', 1, 'extract', 'system:extract')`;
    await testSql`
      insert into org_aliases (org_id, alias, tier, source, created_by)
      values (${tierZeroOrg!.id}, 'Legacy Quarantined Org', 1, 'extract', 'system:extract')`;
    // Current-schema alias triggers synthesize parent-id provenance. Clear it with triggers
    // disabled to reproduce the pre-022 row shape, where these columns did not yet exist.
    await testSql.unsafe("drop trigger person_aliases_set_tier on person_aliases");
    await testSql.unsafe("drop trigger org_aliases_set_tier on org_aliases");
    await testSql`update person_aliases set derived_from = null where person_id = ${person!.id}`;
    await testSql`update org_aliases set derived_from = null where org_id = ${org!.id}`;
    await testSql`
      update person_aliases set derived_from = null where person_id = ${tierZeroPerson!.id}`;
    await testSql`
      update org_aliases set derived_from = null where org_id = ${tierZeroOrg!.id}`;
    await testSql`
      insert into edges
        (src_type, src_id, rel, dst_type, dst_id, source_table, source_id,
         extracted_by, tier, source, created_by)
      values
        ('page', ${source!.id}, 'mentions', 'person', ${person!.id}, 'pages', ${source!.id},
         'system:extract', 2, 'extract', 'system:extract'),
        ('person', ${person!.id}, 'works_at', 'org', ${org!.id}, 'pages', ${source!.id},
         'system:extract', 2, 'extract', 'system:extract'),
        ('page', ${tierZeroSource!.id}, 'mentions', 'person', ${tierZeroPerson!.id},
         'pages', ${tierZeroSource!.id}, 'system:extract', 0, 'extract', 'system:extract'),
        ('person', ${tierZeroPerson!.id}, 'works_at', 'org', ${tierZeroOrg!.id},
         'pages', ${tierZeroSource!.id}, 'system:extract', 0, 'extract', 'system:extract')`;

    const [interaction] = await testSql`
      insert into interactions
        (person_id, kind, summary, occurred_at, tier, source, created_by)
      values (${person!.id}, 'note', 'legacy provenance fixture', now(), 2,
              'capture', 'agent:legacy') returning id`;
    const [decision] = await testSql`
      insert into decisions (question, options, tier, source, created_by)
      values ('Legacy review provenance?', '["yes"]'::jsonb, 2, 'capture', 'agent:legacy')
      returning id`;
    const [principle] = await testSql`
      insert into principles
        (rule, learned_from_decision, tier, source, created_by, derived_from)
      values ('Legacy review rule', ${decision!.id}, 2, 'review', 'agent:legacy', ${decision!.id})
      returning id`;
    await testSql`
      insert into edges
        (src_type, src_id, rel, dst_type, dst_id, source_table, source_id,
         extracted_by, source, created_by, derived_from)
      values
        ('interaction', ${interaction!.id}, 'involves', 'person', ${person!.id},
         'interactions', ${interaction!.id}, 'agent:legacy', 'manual', 'human', null),
        ('principle', ${principle!.id}, 'learned_from', 'decision', ${decision!.id},
         'decisions', ${decision!.id}, 'agent:legacy', 'manual', 'human', null),
        ('task', ${crypto.randomUUID()}, 'mentions', 'person', ${person!.id},
         null, null, 'agent:null-source', 'manual', 'human', null)`;

    await testSql.unsafe(
      await Bun.file(
        new URL("../db/migrations/022_entity_derivation_tiers.sql", import.meta.url),
      ).text(),
    );

    const [personAfter] = await testSql`
      select tier, derived_from from people where id = ${person!.id}`;
    const [orgAfter] = await testSql`
      select tier, derived_from from orgs where id = ${org!.id}`;
    expect(personAfter).toMatchObject({ tier: 2, derived_from: source!.id });
    expect(orgAfter).toMatchObject({ tier: 2, derived_from: source!.id });
    const aliases = await testSql`
      select tier, derived_from from person_aliases where person_id = ${person!.id}
      union all
      select tier, derived_from from org_aliases where org_id = ${org!.id}`;
    expect(aliases).toHaveLength(2);
    expect(aliases.every((row) => row.tier === 2 && row.derived_from === source!.id)).toBe(true);

    const [tierZeroPersonAfter] = await testSql`
      select tier, derived_from from people where id = ${tierZeroPerson!.id}`;
    const [tierZeroOrgAfter] = await testSql`
      select tier, derived_from from orgs where id = ${tierZeroOrg!.id}`;
    expect(tierZeroPersonAfter).toEqual({ tier: 0, derived_from: tierZeroSource!.id });
    expect(tierZeroOrgAfter).toEqual({ tier: 0, derived_from: tierZeroSource!.id });
    const tierZeroAliases = await testSql`
      select tier, derived_from from person_aliases where person_id = ${tierZeroPerson!.id}
      union all
      select tier, derived_from from org_aliases where org_id = ${tierZeroOrg!.id}`;
    expect(tierZeroAliases).toHaveLength(2);
    expect(
      tierZeroAliases.every((row) => row.tier === 0 && row.derived_from === tierZeroSource!.id),
    ).toBe(true);
    expect((await app`select id from people where id = ${tierZeroPerson!.id}`).length).toBe(0);
    expect((await app`select id from orgs where id = ${tierZeroOrg!.id}`).length).toBe(0);

    const provenance = await testSql`
      select rel, source, created_by, derived_from, source_id
      from edges
      where id in (
        select id from edges where source_id in (${interaction!.id}, ${decision!.id})
        union all
        select id from edges where extracted_by = 'agent:null-source'
      )
      order by rel`;
    expect(provenance.map((row) => ({ ...row }))).toEqual([
      {
        rel: "involves",
        source: "capture",
        created_by: "agent:legacy",
        derived_from: interaction!.id,
        source_id: interaction!.id,
      },
      {
        rel: "learned_from",
        source: "review",
        created_by: "agent:legacy",
        derived_from: decision!.id,
        source_id: decision!.id,
      },
      {
        rel: "mentions",
        source: "manual",
        created_by: "agent:null-source",
        derived_from: null,
        source_id: null,
      },
    ]);

    // The 022 replay above CREATE OR REPLACEs resolve_or_promote_entity/
    // resolve_or_promote_extracted_person/resolve_or_promote_extracted_org/upsert_derived_alias
    // and the tier-guard trigger back to their pre-037 (greatest()-promoting) bodies, and this
    // file shares one never-reset database across all its tests -- left alone, every later test
    // would silently run under reverted, pre-W4-1 tier-promotion semantics (caught in review:
    // minime_log_interaction's own indexParent call re-extracts its just-minted identity from
    // the interaction text, which re-resolves through the reverted function and silently
    // re-promotes it). Restore 037 before handing back to the rest of the suite. Pre-drop the
    // two guarded triggers by name first: 037's own text is applied exactly once by the normal
    // migration chain, so unlike 022 (written to be safely re-playable for this exact technique)
    // its "create trigger" statements are not themselves guarded with "if exists".
    await testSql.unsafe("drop trigger if exists people_keep_tier_guarded on people");
    await testSql.unsafe("drop trigger if exists orgs_keep_tier_guarded on orgs");
    await testSql.unsafe(
      await Bun.file(
        new URL("../db/migrations/037_identity_content_tier_split.sql", import.meta.url),
      ).text(),
    );
  });

  test("W3-13: promise capture resolves to_whom via entity_canonical_name for a subject minted " +
    "in this same locked call", async () => {
    // The exact scenario DECISIONS.md / repo.ts / 036_commitment_update_grant.sql's own
    // comments cite as entity_canonical_name()'s reason to exist: a locked role mints a
    // brand-new person/org via ensurePerson/ensureOrg (tier 1 since W4-1 -- an
    // interaction-minted identity is identity-tier data, not content -- 037_identity_content_
    // tier_split.sql), then minime_log_interaction's promise capture must read its
    // canonical_name back in the SAME call to fill commitments.to_whom. personCanonicalName/
    // orgCanonicalName take no actor/session id, so they cannot rely on an ordinary select
    // reaching the pooled connection carrying THIS call's own session GUCs (app_allowed_tier()
    // is session-scoped, 023_session_unlock_approval.sql) -- entity_canonical_name sidesteps
    // that entirely by being SECURITY DEFINER and reading tier in (1,2) directly, independent of
    // both the caller's own tier_read RLS and which physical connection serves the read. Nothing
    // else in the suite drove a promise through the actual minime_app role: commitments.test.ts's
    // own promise assertions all run on the ordinary bun-test connection (owner role, no RLS --
    // see src/db/client.ts's runtime-URL fallback), so this is the one place that exercises the
    // function at all. (Reverting personCanonicalName/orgCanonicalName to a plain select makes
    // both branches below fail with *_not_found_for_canonical_name.)
    const personName = "MCP Promise Talia Renn";
    const personReceipt = await logInteractionAsLockedApp(personName, "person", {
      what: "MCP Promise send the calibration report",
      due: "2026-09-01",
    });
    const personCommitmentId = personReceipt.data.commitment_id;
    if (!personCommitmentId) throw new Error("expected commitment_id when a promise is given");
    expect(Object.keys(personReceipt.data).sort()).toEqual(["commitment_id", "interaction_id"]);
    expect(personReceipt.sources).toEqual(
      expect.arrayContaining([
        { type: "interaction", id: personReceipt.data.interaction_id },
        { type: "commitment", id: personCommitmentId },
      ]),
    );
    const [personLink] = await testSql`
        select person_id from interactions where id = ${personReceipt.data.interaction_id}`;
    const [mintedPerson] = await testSql`
        select tier, canonical_name from people where id = ${personLink!.person_id}`;
    expect(mintedPerson!.tier).toBe(1);
    const [personCommitment] = await testSql`
        select to_whom, tier, derived_from from commitments where id = ${personCommitmentId}`;
    expect(personCommitment).toEqual({
      to_whom: mintedPerson!.canonical_name,
      tier: 2,
      derived_from: personReceipt.data.interaction_id,
    });

    const orgName = "MCP Promise Fjord Systems";
    const orgReceipt = await logInteractionAsLockedApp(orgName, "org", {
      what: "MCP Promise send the signed PO",
    });
    const orgCommitmentId = orgReceipt.data.commitment_id;
    if (!orgCommitmentId) throw new Error("expected commitment_id when a promise is given");
    const [orgLink] = await testSql`
        select org_id from interactions where id = ${orgReceipt.data.interaction_id}`;
    const [mintedOrg] = await testSql`
        select tier, canonical_name from orgs where id = ${orgLink!.org_id}`;
    expect(mintedOrg!.tier).toBe(1);
    const [orgCommitment] = await testSql`
        select to_whom, tier from commitments where id = ${orgCommitmentId}`;
    expect(orgCommitment).toEqual({ to_whom: mintedOrg!.canonical_name, tier: 2 });
  });
});
