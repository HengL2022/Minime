// High-edge extract-org watchdog (dream step 3d). Flag-only audit for
// system:extract orgs that accreted an unusual edge count — the class
// detectMistypedEntities misses on single-token names. Fixtures are fictional.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  HIGH_EDGE_EXTRACT_ORG_MIN,
  ensureOrg,
  ensurePerson,
  highEdgeExtractOrgFlagKey,
  retypeOrgToPerson,
} from "../src/db/repo";
import { toolByName } from "../src/mcp/tools";
import { invokeTool } from "../src/mcp/tools/registry";
import { highEdgeExtractOrgScan } from "../src/pipeline/dream";
import { resetDb, testSql as sql } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

async function attachMentions(orgId: string, n: number): Promise<void> {
  await sql`
    insert into edges (src_type, src_id, rel, dst_type, dst_id, extracted_by)
    select 'page', gen_random_uuid(), 'mentions', 'org', ${orgId}::uuid, 'system:extract'
    from generate_series(1, ${n})`;
}

describe("high-edge extract-org watchdog (dream step 3d)", () => {
  test("flags a single-token extract org at the edge floor", async () => {
    const { id } = await ensureOrg("Priya", "system:extract");
    await attachMentions(id, HIGH_EDGE_EXTRACT_ORG_MIN);
    expect(await highEdgeExtractOrgScan()).toBe(1);

    const [q] = await sql`
      select payload from review_queue
      where kind = 'extract_suspect' and status = 'open'
        and payload->>'reason' = 'high_edge_extract_org'`;
    expect(q!.payload.flag_key).toBe(highEdgeExtractOrgFlagKey(id));
    expect(q!.payload.org).toEqual({ type: "org", id, name: "Priya" });
    expect(q!.payload.edge_count).toBe(HIGH_EDGE_EXTRACT_ORG_MIN);
    expect(q!.payload.works_at_people).toBe(0);
  });

  test("does NOT flag one edge below the floor", async () => {
    const { id } = await ensureOrg("Priya", "system:extract");
    await attachMentions(id, HIGH_EDGE_EXTRACT_ORG_MIN - 1);
    expect(await highEdgeExtractOrgScan()).toBe(0);
  });

  test("does NOT flag a human-confirmed org at the same degree", async () => {
    const { id } = await ensureOrg("Fjordsonics AS", "human", "manual");
    await attachMentions(id, HIGH_EDGE_EXTRACT_ORG_MIN);
    expect(await highEdgeExtractOrgScan()).toBe(0);
  });

  test("does NOT flag a retired extract org", async () => {
    const { id } = await ensureOrg("Priya", "system:extract");
    await attachMentions(id, HIGH_EDGE_EXTRACT_ORG_MIN);
    await sql`update orgs set retired_at = now() where id = ${id}`;
    expect(await highEdgeExtractOrgScan()).toBe(0);
  });

  test("records works_at people as a count only", async () => {
    const { id: orgId } = await ensureOrg("Priya", "system:extract");
    const { id: p1 } = await ensurePerson("Nadia Rossi", "system:extract");
    const { id: p2 } = await ensurePerson("Sigrid Halvorsen", "system:extract");
    await attachMentions(orgId, HIGH_EDGE_EXTRACT_ORG_MIN - 2);
    for (const pid of [p1, p2]) {
      await sql`
        insert into edges (src_type, src_id, rel, dst_type, dst_id, extracted_by)
        values ('person', ${pid}, 'works_at', 'org', ${orgId}, 'system:extract')`;
    }
    expect(await highEdgeExtractOrgScan()).toBe(1);
    const [q] = await sql`
      select payload from review_queue
      where kind = 'extract_suspect' and payload->>'reason' = 'high_edge_extract_org'`;
    expect(q!.payload.works_at_people).toBe(2);
    expect(q!.payload.edge_count).toBe(HIGH_EDGE_EXTRACT_ORG_MIN);
    expect(JSON.stringify(q!.payload)).not.toContain("Nadia");
    expect(JSON.stringify(q!.payload)).not.toContain("Sigrid");
  });

  test("is idempotent — a second scan does not double-flag", async () => {
    const { id } = await ensureOrg("Priya", "system:extract");
    await attachMentions(id, HIGH_EDGE_EXTRACT_ORG_MIN);
    expect(await highEdgeExtractOrgScan()).toBe(1);
    expect(await highEdgeExtractOrgScan()).toBe(0);
    const [n] = await sql`
      select count(*)::int as n from review_queue
      where kind = 'extract_suspect' and payload->>'reason' = 'high_edge_extract_org'`;
    expect(n!.n).toBe(1);
  });

  test("a dismissal stays quiet inside the suppression window", async () => {
    const { id } = await ensureOrg("Priya", "system:extract");
    await attachMentions(id, HIGH_EDGE_EXTRACT_ORG_MIN);
    expect(await highEdgeExtractOrgScan()).toBe(1);
    await sql`
      update review_queue set status = 'dismissed', resolved_at = now()
      where kind = 'extract_suspect' and payload->>'reason' = 'high_edge_extract_org'`;
    expect(await highEdgeExtractOrgScan()).toBe(0);
  });

  test("a dismissal older than 90 days can resurface", async () => {
    const { id } = await ensureOrg("Priya", "system:extract");
    await attachMentions(id, HIGH_EDGE_EXTRACT_ORG_MIN);
    expect(await highEdgeExtractOrgScan()).toBe(1);
    await sql`
      update review_queue
      set status = 'dismissed', resolved_at = now(),
          created_at = now() - interval '91 days'
      where kind = 'extract_suspect' and payload->>'reason' = 'high_edge_extract_org'`;
    expect(await highEdgeExtractOrgScan()).toBe(1);
  });

  test("retypeOrgToPerson auto-resolves the open high-edge flag", async () => {
    const { id } = await ensureOrg("Priya", "system:extract");
    await attachMentions(id, HIGH_EDGE_EXTRACT_ORG_MIN);
    expect(await highEdgeExtractOrgScan()).toBe(1);
    await retypeOrgToPerson(id, {});
    const [q] = await sql`
      select status from review_queue
      where kind = 'extract_suspect' and payload->>'reason' = 'high_edge_extract_org'`;
    expect(q!.status).toBe("resolved");
  });

  test("minime_review_queue restores the machine reason and re-resolves the org name", async () => {
    const { id } = await ensureOrg("Priya", "system:extract");
    await attachMentions(id, HIGH_EDGE_EXTRACT_ORG_MIN);
    expect(await highEdgeExtractOrgScan()).toBe(1);

    const listed = await invokeTool(
      toolByName("minime_review_queue"),
      { action: "list", kind: "extract_suspect" },
      { actor: "agent:test" },
    );
    expect(listed.ok).toBe(true);
    const [item] = (listed as { envelope: { data: { items: any[] } } }).envelope.data.items;
    expect(item.payload.reason).toBe("high_edge_extract_org");
    expect(item.payload.org.name).toBe("Priya");
    expect(item.payload.edge_count).toBe(HIGH_EDGE_EXTRACT_ORG_MIN);
  });

  test("tier-2 extract org name is masked at tier 1; counts stay visible", async () => {
    const [org] = await sql`
      insert into orgs (canonical_name, created_by, source, tier)
      values ('Priya', 'system:extract', 'extract', 2) returning id`;
    await attachMentions(org!.id, HIGH_EDGE_EXTRACT_ORG_MIN);
    expect(await highEdgeExtractOrgScan()).toBe(1);

    const listed = await invokeTool(
      toolByName("minime_review_queue"),
      { action: "list", kind: "extract_suspect" },
      { actor: "agent:test" },
    );
    const [item] = (listed as { envelope: { data: { items: any[] } } }).envelope.data.items;
    expect(item.payload.reason).toBe("high_edge_extract_org");
    expect(item.payload.org.id).toBe(org!.id);
    expect(item.payload.org.name).toBe("[above current tier]");
    expect(item.payload.edge_count).toBe(HIGH_EDGE_EXTRACT_ORG_MIN);
    expect(JSON.stringify(item)).not.toContain("Priya");
  });
});
