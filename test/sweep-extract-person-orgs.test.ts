import { beforeEach, describe, expect, test } from "bun:test";
import sweepExtractPersonOrgs from "../scripts/repairs/sweep-extract-person-orgs";
import {
  ensureOrg,
  ensurePerson,
  extractPersonNamedOrgFlagKey,
  flagExtractPersonNamedOrgs,
  retypeOrgToPerson,
} from "../src/db/repo";
import { toolByName } from "../src/mcp/tools";
import { invokeTool } from "../src/mcp/tools/registry";
import { resetDb, testSql as sql } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

describe("sweep-extract-person-orgs", () => {
  test("flags an extract org that is a known person's name", async () => {
    const { id: personId } = await ensurePerson("Priya Raghunathan", "test");
    const { id: orgId } = await ensureOrg("Priya", "system:extract");
    const result = await flagExtractPersonNamedOrgs();
    expect(result.flagged).toBe(1);
    expect(result.ids).toEqual([orgId]);
    const [q] = await sql`
      select payload from review_queue
      where kind = 'extract_suspect' and status = 'open'
        and payload->>'reason' = 'person_name_extract_org'`;
    expect(q!.payload.flag_key).toBe(extractPersonNamedOrgFlagKey(orgId));
    expect(q!.payload.match_kind).toBe("first_token");
    expect(q!.payload.org).toEqual({ type: "org", id: orgId, name: "Priya" });
    expect(q!.payload.matches).toEqual([
      { type: "person", id: personId, name: "Priya Raghunathan" },
    ]);
  });

  test("flags a possessive extract org against the person", async () => {
    await ensurePerson("Priya", "test");
    const { id: orgId } = await ensureOrg("Priya's", "system:extract");
    const result = await flagExtractPersonNamedOrgs();
    expect(result.flagged).toBe(1);
    const [q] = await sql`
      select payload->>'match_kind' as match_kind from review_queue
      where payload->>'flag_key' = ${extractPersonNamedOrgFlagKey(orgId)}`;
    expect(q!.match_kind).toBe("possessive");
  });

  test("does not flag a human-confirmed org or a real company name", async () => {
    await ensurePerson("Priya", "test");
    await ensureOrg("Priya", "human", "manual");
    await ensureOrg("Fjordsonics AS", "system:extract");
    expect(await flagExtractPersonNamedOrgs()).toEqual({ flagged: 0, ids: [] });
  });

  test("does not flag a retired extract org", async () => {
    await ensurePerson("Priya", "test");
    const { id } = await ensureOrg("Priya", "system:extract");
    await sql`update orgs set retired_at = now() where id = ${id}`;
    expect(await flagExtractPersonNamedOrgs()).toEqual({ flagged: 0, ids: [] });
  });

  test("a second run does not duplicate an open flag", async () => {
    await ensurePerson("Priya", "test");
    await ensureOrg("Priya", "system:extract");
    expect((await flagExtractPersonNamedOrgs()).flagged).toBe(1);
    expect((await flagExtractPersonNamedOrgs()).flagged).toBe(0);
    const [n] = await sql`
      select count(*)::int as n from review_queue
      where kind = 'extract_suspect' and payload->>'reason' = 'person_name_extract_org'`;
    expect(n!.n).toBe(1);
  });

  test("retype-org-to-person resolves the person-name flag", async () => {
    await ensurePerson("Priya", "test");
    const { id: orgId } = await ensureOrg("Priya", "system:extract");
    await flagExtractPersonNamedOrgs();
    await retypeOrgToPerson(orgId, { reason: "test" });
    const [q] = await sql`
      select status from review_queue
      where payload->>'flag_key' = ${extractPersonNamedOrgFlagKey(orgId)}`;
    expect(q!.status).toBe("resolved");
  });

  test("repair module returns the fixed {counts, ids} shape and never names", async () => {
    await ensurePerson("Priya", "test");
    const { id: orgId } = await ensureOrg("Priya", "system:extract");
    const summary = await sweepExtractPersonOrgs.run([]);
    expect(summary).toEqual({ counts: { orgs_flagged: 1 }, ids: [orgId] });
    expect(JSON.stringify(summary)).not.toContain("Priya");
  });

  test("locked review-queue restores the machine reason and masks names", async () => {
    const [org] = await sql`
      insert into orgs (canonical_name, created_by, source, tier)
      values ('Priya', 'system:extract', 'extract', 2) returning id`;
    await ensurePerson("Priya", "test", "capture", { tier: 2 });
    await flagExtractPersonNamedOrgs();
    const listed = await invokeTool(
      toolByName("minime_review_queue"),
      { action: "list", kind: "extract_suspect" },
      { actor: "agent:test" },
    );
    const [item] = (listed as { envelope: { data: { items: any[] } } }).envelope.data.items;
    expect(item.payload.reason).toBe("person_name_extract_org");
    expect(item.payload.org.id).toBe(org!.id);
    expect(item.payload.org.name).toBe("[above current tier]");
    expect(JSON.stringify(item)).not.toContain("Priya");
  });
});
