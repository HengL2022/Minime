// W4-2: demotion path for entities the pre-037 monotonic-tier rule swallowed into tier 2 and
// that 037_identity_content_tier_split.sql deliberately left untouched (037's own header comment:
// "a review/backfill pass over history is W4-2, deliberately out of scope here"). Three pieces
// under test: (1) the migration 038 backfill over pre-existing history, (2)/(2b) the ongoing
// ensurePerson/ensureOrg detection hook for a tier-1 resolve that hits an already-tier-2
// identity, and (3)-(5) the owner-CLI-only restoreEntityTier demotion itself. Demotion approval
// lives in the owner terminal, never MCP (DECISIONS.md 2026-08-09) — there is no tool call under
// test here that can move a tier, only ones that can flag or read.

import { beforeAll, describe, expect, test } from "bun:test";
import { withAdminDbTransaction } from "../src/db/client";
import {
  addAlias,
  ensureOrg,
  ensurePerson,
  insertEdge,
  restoreEntityTier,
  upsertPage,
} from "../src/db/repo";
import { toolByName } from "../src/mcp/tools";
import { invokeTool } from "../src/mcp/tools/registry";
import { resetDb, testSql } from "./helpers";
import { dropTestAppRole, mintTestAppRole } from "./support/app-role";
import { requestAndApproveTier2, sessionToolCtx } from "./support/unlock";

const HIDDEN = "[above current tier]";

describe("entity tier restore (W4-2)", () => {
  beforeAll(async () => {
    await resetDb();
  });

  test("(1) migration 038 backfills owner-created and tier-1-evidenced tier-2 people/orgs on both branches of the UNION ALL, not a purely-extraction-born one with no tier-1 evidence", async () => {
    const [ownerPerson] = await testSql`
      insert into people (canonical_name, tier, created_by, source)
      values ('Fictional Backfill Owner Person', 2, 'human', 'manual')
      returning id`;
    const [extractionPerson] = await testSql`
      insert into people (canonical_name, tier, created_by, source)
      values ('Fictional Backfill Extraction Person', 2, 'system:extract', 'extract')
      returning id`;

    // Org mirror of the pair above (review finding, 2026-08-09): the migration's org branch
    // (the UNION ALL half over orgs/edges/org_aliases) previously had zero test coverage.
    const [ownerOrg] = await testSql`
      insert into orgs (canonical_name, tier, created_by, source)
      values ('Fictional Backfill Owner Org', 2, 'human', 'manual')
      returning id`;
    const [extractionOrg] = await testSql`
      insert into orgs (canonical_name, tier, created_by, source)
      values ('Fictional Backfill Extraction Org', 2, 'system:extract', 'extract')
      returning id`;

    // The migration's OTHER OR-arm, on both branches (review finding, 2026-08-09): not
    // owner-created, but a tier-1 edge already touches the tier-2 identity -- e.g. extraction
    // ran over a readable (tier-1) page and recorded a graph edge sourced from it, which
    // inherits the PAGE's own tier (edge_source_tier, 022_entity_derivation_tiers.sql)
    // independent of whatever tier the referenced person/org row itself sits at. This is the
    // realistic "previously swallowed" case the heuristic's second OR-arm targets, and mirrors
    // test (3) below (which sources a tier-2 edge from a tier-2 page the same way) with a
    // tier-1 page instead. Deliberately NOT exercised here via a tier-1 person_alias/org_alias:
    // 022's set_entity_alias_tier BEFORE INSERT trigger floors every alias write at its
    // parent's CURRENT tier, and cascade_entity_tier_to_aliases re-floors every existing alias
    // whenever the parent is later raised -- so an alias sitting strictly below its tier-2
    // parent's tier cannot be produced by any ordinary trigger-respecting write post-022 (only
    // conceivably by genuinely pre-022 historical data). That EXISTS arm is structurally
    // parallel to, and was reviewed line-for-line against, the edges arm exercised below.
    const [evidencedPerson] = await testSql`
      insert into people (canonical_name, tier, created_by, source)
      values ('Fictional Backfill Tier1Evidenced Person', 2, 'system:extract', 'extract')
      returning id`;
    const [evidencedOrg] = await testSql`
      insert into orgs (canonical_name, tier, created_by, source)
      values ('Fictional Backfill Tier1Evidenced Org', 2, 'system:extract', 'extract')
      returning id`;
    const evidenceSource = await upsertPage({
      path: "entity-tier-restore/backfill-tier1-evidence-source.md",
      title: "Backfill tier-1 evidence source",
      bodyMd: "fictional tier-1 extraction source text",
      contentHash: "entity-tier-restore-backfill-evidence-hash",
      tier: 1,
      source: "test",
    });
    await insertEdge({
      srcType: "page",
      srcId: evidenceSource.id,
      rel: "mentions",
      dstType: "person",
      dstId: evidencedPerson!.id,
      sourceTable: "pages",
      sourceId: evidenceSource.id,
      extractedBy: "system:extract",
      source: "extract",
    });
    await insertEdge({
      srcType: "page",
      srcId: evidenceSource.id,
      rel: "mentions",
      dstType: "org",
      dstId: evidencedOrg!.id,
      sourceTable: "pages",
      sourceId: evidenceSource.id,
      extractedBy: "system:extract",
      source: "extract",
    });

    // Replay the backfill migration's raw SQL against the now-populated fixtures — the same
    // technique entity-tier-provenance.test.ts uses for 022's own historical backfill. Safe to
    // run a second time (resetDb already applied it once, against an empty table): the
    // constraint recreation is drop-then-add and the INSERT dedupes against open items.
    await testSql.unsafe(
      await Bun.file(
        new URL("../db/migrations/038_entity_promotion_backfill.sql", import.meta.url),
      ).text(),
    );

    const expectFlagged = async (entityType: "person" | "org", entityId: string) => {
      const rows = await testSql`
        select payload from review_queue
        where kind = 'entity_promotion' and payload ->> 'entity_id' = ${entityId}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toEqual({ entity_type: entityType, entity_id: entityId });
    };
    const expectNotFlagged = async (entityId: string) => {
      const rows = await testSql`
        select id from review_queue
        where kind = 'entity_promotion' and payload ->> 'entity_id' = ${entityId}`;
      expect(rows).toHaveLength(0);
    };

    await expectFlagged("person", ownerPerson!.id);
    await expectNotFlagged(extractionPerson!.id);
    await expectFlagged("person", evidencedPerson!.id);
    await expectFlagged("org", ownerOrg!.id);
    await expectNotFlagged(extractionOrg!.id);
    await expectFlagged("org", evidencedOrg!.id);

    // Replaying it again inserts nothing further for the same id (dedup against the open item).
    await testSql.unsafe(
      await Bun.file(
        new URL("../db/migrations/038_entity_promotion_backfill.sql", import.meta.url),
      ).text(),
    );
    const ownedAgain = await testSql`
      select id from review_queue
      where kind = 'entity_promotion' and payload ->> 'entity_id' = ${ownerPerson!.id}`;
    expect(ownedAgain).toHaveLength(1);
  });

  test("(2) a tier-1 resolve against an existing tier-2 person inserts exactly one deduped entity_promotion item across repeated resolves", async () => {
    const name = "Fictional Repeated Resolve Person";
    const { id: personId, created } = await ensurePerson(name, "human", "manual", { tier: 2 });
    expect(created).toBe(true);

    const beforeAnyResolve = await testSql`
      select id from review_queue
      where kind = 'entity_promotion' and payload ->> 'entity_id' = ${personId}`;
    expect(beforeAnyResolve).toHaveLength(0); // creating at tier 2 is not itself a "swallow" signal

    for (let i = 0; i < 3; i++) {
      const resolved = await ensurePerson(name, "agent:test", "capture", { tier: 1 });
      expect(resolved).toEqual({ id: personId, created: false });
    }

    const items = await testSql`
      select id from review_queue
      where kind = 'entity_promotion' and status = 'open' and payload ->> 'entity_id' = ${personId}`;
    expect(items).toHaveLength(1);

    // The hook only flags — it never touches the row's own stored tier.
    const [row] = await testSql`select tier from people where id = ${personId}`;
    expect(row!.tier).toBe(2);
  });

  test("(2b) ensureOrg carries the identical detection hook", async () => {
    const name = "Fictional Repeated Resolve Org";
    const { id: orgId, created } = await ensureOrg(name, "human", "manual", { tier: 2 });
    expect(created).toBe(true);

    await ensureOrg(name, "agent:test", "capture", { tier: 1 });
    await ensureOrg(name, "agent:test", "capture", { tier: 1 });

    const items = await testSql`
      select id from review_queue
      where kind = 'entity_promotion' and status = 'open' and payload ->> 'entity_id' = ${orgId}`;
    expect(items).toHaveLength(1);
    const [row] = await testSql`select tier from orgs where id = ${orgId}`;
    expect(row!.tier).toBe(2);
  });

  test("(3) restoreEntityTier demotes only the identity row, leaves tier-2 aliases/edges untouched, resolves the review item, and audits with no name in the payload", async () => {
    const name = "Fictional Restore Path Person";
    const { id: personId } = await ensurePerson(name, "human", "manual", { tier: 2 });
    await addAlias(personId, "Restore Path Alias", {
      tier: 2,
      createdBy: "system:extract",
      source: "extract",
    });
    const page = await upsertPage({
      path: "entity-tier-restore/restore-path-source.md",
      title: "Restore path source",
      bodyMd: "fictional extraction source text",
      contentHash: "entity-tier-restore-source-hash",
      tier: 2,
      source: "test",
    });
    await insertEdge({
      srcType: "page",
      srcId: page.id,
      rel: "mentions",
      dstType: "person",
      dstId: personId,
      sourceTable: "pages",
      sourceId: page.id,
      extractedBy: "system:extract",
      source: "extract",
    });

    // Trigger the ongoing-detection hook the same way minime_log_interaction would.
    await ensurePerson(name, "agent:test", "capture", { tier: 1 });
    const [openItem] = await testSql`
      select id from review_queue where kind = 'entity_promotion' and status = 'open'
        and payload ->> 'entity_id' = ${personId}`;
    expect(openItem).toBeTruthy();

    // Real CLI shape: entity:restore-tier wraps the call in withAdminDbTransaction.
    const result = await withAdminDbTransaction(() => restoreEntityTier("person", personId));
    expect(result).toEqual({
      entityType: "person",
      entityId: personId,
      resolvedReviewItemId: String(openItem!.id),
    });

    const [personRow] = await testSql`select tier from people where id = ${personId}`;
    expect(personRow!.tier).toBe(1);

    const [aliasRow] = await testSql`
      select tier from person_aliases
      where person_id = ${personId} and alias = 'Restore Path Alias'`;
    expect(aliasRow!.tier).toBe(2); // extraction-derived content stays tier 2

    const [edgeRow] = await testSql`
      select tier from edges where dst_type = 'person' and dst_id = ${personId}`;
    expect(edgeRow!.tier).toBe(2); // extraction-derived content stays tier 2

    const [resolvedItem] = await testSql`
      select status, resolved_at from review_queue where id = ${openItem!.id}`;
    expect(resolvedItem!.status).toBe("resolved");
    expect(resolvedItem!.resolved_at).not.toBeNull();

    const [auditRow] = await testSql`
      select payload from events
      where verb = 'entity:tier:restored' and payload ->> 'entity_id' = ${personId}
      order by at desc limit 1`;
    expect(auditRow!.payload).toEqual({ entity_type: "person", entity_id: personId });
    expect(JSON.stringify(auditRow!.payload)).not.toContain(name);
  });

  test("(4) through minime_review_queue, entity_promotion's name is masked at tier 1 and visible once tier-2-unlocked", async () => {
    const name = "Fictional MCP Masking Person";
    const { id: personId } = await ensurePerson(name, "human", "manual", { tier: 2 });
    await ensurePerson(name, "agent:test", "capture", { tier: 1 }); // triggers the flag

    const locked = sessionToolCtx("agent:entity-promotion-locked");
    const lockedResult = await invokeTool(
      toolByName("minime_review_queue"),
      { action: "list", kind: "entity_promotion" },
      locked,
    );
    if (!lockedResult.ok) throw new Error(lockedResult.error.message);
    const lockedItems = (lockedResult.envelope.data as any).items as any[];
    const lockedItem = lockedItems.find((i) => i.payload?.entity_id === personId);
    expect(lockedItem).toBeTruthy();
    expect(lockedItem.payload.entity_type).toBe("person");
    expect(lockedItem.payload.name).toBe(HIDDEN);
    expect(JSON.stringify(lockedResult)).not.toContain(name);

    const unlocked = sessionToolCtx("agent:entity-promotion-unlocked");
    await requestAndApproveTier2(unlocked);
    const unlockedResult = await invokeTool(
      toolByName("minime_review_queue"),
      { action: "list", kind: "entity_promotion" },
      unlocked,
    );
    if (!unlockedResult.ok) throw new Error(unlockedResult.error.message);
    const unlockedItems = (unlockedResult.envelope.data as any).items as any[];
    const unlockedItem = unlockedItems.find((i) => i.payload?.entity_id === personId);
    expect(unlockedItem.payload.name).toBe(name);
  });

  test("(5) restoreEntityTier refuses an unknown id and a non-tier-2 identity (tier 0 and tier 1), defensively", async () => {
    const unknownId = crypto.randomUUID();
    await expect(restoreEntityTier("person", unknownId)).rejects.toThrow("entity_not_found");

    const [tierZero] = await testSql`
      insert into people (canonical_name, tier, created_by, source)
      values ('Fictional Tier Zero Restore Candidate', 0, 'quarantine', 'owner:test')
      returning id`;
    await expect(restoreEntityTier("person", tierZero!.id)).rejects.toThrow("entity_not_tier_two");
    const [stillZero] = await testSql`select tier from people where id = ${tierZero!.id}`;
    expect(stillZero!.tier).toBe(0); // refused, not silently coerced

    const { id: tierOneId } = await ensurePerson(
      "Fictional Tier One Restore Candidate",
      "human",
      "manual",
      { tier: 1 },
    );
    await expect(restoreEntityTier("person", tierOneId)).rejects.toThrow("entity_not_tier_two");
  });

  // Real subprocess through src/cli.ts, matching unlock-approval.test.ts's own "CLI approval
  // runs before the Ollama preflight" precedent exactly: --no-env-file so the child cannot
  // reload the repo's real .env over the inherited scratch DATABASE_URL, and an unreachable
  // OLLAMA_URL to prove the command truly never reaches ollamaPreflight (acceptance: `entity:
  // restore-tier --list` works without Ollama running).
  test("(6) CLI subprocess: --list and the restore itself both run before the Ollama preflight", async () => {
    const name = "Fictional CLI Subprocess Person";
    const { id: personId } = await ensurePerson(name, "human", "manual", { tier: 2 });
    await ensurePerson(name, "agent:test", "capture", { tier: 1 }); // triggers the flag

    const listed = await spawnEntityRestoreTier(["--list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(personId);
    expect(listed.stdout).toContain(name); // the one owner-terminal surface allowed to show it
    expect(`${listed.stdout}\n${listed.stderr}`).not.toContain("OLLAMA_URL");

    const restored = await spawnEntityRestoreTier(["person", personId]);
    expect(restored.code).toBe(0);
    expect(restored.stdout).toContain(`restored person ${personId}`);
    expect(restored.stdout).not.toContain(name); // the restore's own output never repeats it
    expect(`${restored.stdout}\n${restored.stderr}`).not.toContain("OLLAMA_URL");

    const [row] = await testSql`select tier from people where id = ${personId}`;
    expect(row!.tier).toBe(1);

    // Defensive-CLI-arg cases need no DB fixture: bad kind/id shape and an unknown id.
    const badArgs = await spawnEntityRestoreTier(["team", personId]);
    expect(badArgs.code).toBe(2);
    const unknown = await spawnEntityRestoreTier(["person", crypto.randomUUID()]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("no such person/org id");
  });

  // Review remediation (high-severity finding, 2026-08-09): --list used to run
  // pendingEntityPromotions() on the bare runtime pool. In a real installed deployment that pool
  // is the restricted minime_app role (scripts/install.sh writes MINIME_APP_DATABASE_URL into
  // .env), and people/orgs both carry `tier_read ... using (tier <= app_allowed_tier())`
  // (007_rls.sql/008_orgs.sql). Since every entity_promotion item points at a tier-2 identity and
  // app_allowed_tier() is locked at 1 absent a live unlock, the per-item select silently returned
  // zero rows for every item and `if (!row) continue` (repo.ts) dropped it — the owner would see
  // "0 pending" no matter how many were actually queued. test (6) above cannot catch this: per
  // test/setup.ts, MINIME_APP_DATABASE_URL is deleted before any test runs, so the runtime pool
  // there falls back to the same owner DSN as adminSql and RLS never actually applies. This test
  // uses the same mintTestAppRole/Bun.spawn pattern as timeline-restricted-role.test.ts to exercise
  // the genuinely restricted role and prove the --list admin-scope wrap (src/cli.ts) fixes it.
  test("(7) CLI subprocess --list: a pending item stays visible under the real restricted minime_app role", async () => {
    const name = "Fictional Restricted Role List Person";
    const { id: personId } = await ensurePerson(name, "human", "manual", { tier: 2 });
    await ensurePerson(name, "agent:test", "capture", { tier: 1 }); // triggers the flag

    const appRole = await mintTestAppRole(process.env.DATABASE_URL!);
    try {
      const listed = await spawnEntityRestoreTier(["--list"], {
        MINIME_APP_DATABASE_URL: appRole.databaseUrl,
      });
      expect(listed.code).toBe(0);
      expect(listed.stdout).toContain(personId);
      expect(listed.stdout).toContain(name);
    } finally {
      await dropTestAppRole(appRole);
    }
  });
});

async function spawnEntityRestoreTier(
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "run", "src/cli.ts", "entity:restore-tier", ...args],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, OLLAMA_URL: "http://example.test:11434", ...envOverrides },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
