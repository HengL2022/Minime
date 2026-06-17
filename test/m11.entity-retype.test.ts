// M11 — sanctioned entity retype/supersede (DECISIONS.md 2026-06-16).
// The relation extractor can mint an `org` row for something that is really a person
// (e.g. "Hai Yan", a boss first seen only inside a task title), and there is no
// classifier path that retypes an existing wrong row. retypeOrgToPerson() is the
// authorized, reversible admin operation that:
//   - creates (or reuses) a person row carrying the org's name + aliases
//   - repoints every edge that referenced the org (src or dst) to the new person
//   - de-dupes edges that now collide, and drops self-referential edges
//   - soft-supersedes the org (keeps the row for provenance, sets supersedes pointer
//     on the person, marks the org retired) — never a hard delete
// detectMistypedEntities() is the read-only DB-wide screen that flags this whole class
// (org that should be a person; person minted from a pronoun) for review — never auto-fixes.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  detectMistypedEntities,
  ensureOrg,
  ensurePerson,
  parseKnownOrgs,
  resolveOrg,
  resolvePerson,
  retypeOrgToPerson,
} from "../src/db/repo";
import { resetDb, testSql as sql } from "./helpers";

describe("retypeOrgToPerson", () => {
  beforeEach(async () => {
    await resetDb();
  });

  test("converts an org into a person, preserving name + alias", async () => {
    const { id: orgId } = await ensureOrg("Hai Yan", "system:extract");
    await sql`insert into org_aliases (org_id, alias) values (${orgId}, '阎海') on conflict do nothing`;

    const res = await retypeOrgToPerson(orgId, { relation: "boss" });

    expect(res.personId).toBeTruthy();
    expect(res.orgId).toBe(orgId);
    // org no longer resolves as an active org
    expect(await resolveOrg("Hai Yan")).toBeNull();
    // person now resolves under canonical name AND the preserved alias
    const p = await resolvePerson("Hai Yan");
    expect(p?.id).toBe(res.personId);
    expect(p?.relation).toBe("boss");
    const byAlias = await resolvePerson("阎海");
    expect(byAlias?.id).toBe(res.personId);
  });

  test("repoints edges from the org to the new person and de-dupes collisions", async () => {
    const { id: orgId } = await ensureOrg("Hai Yan", "system:extract");
    const { id: keepPerson } = await ensurePerson("Chen Mengwei", "agent:classifier");
    const pageId = (
      await sql`insert into pages (path,title,body_md,content_hash)
      values ('p/1','t','b','h1') returning id`
    )[0]!.id;

    // two edges pointing at the org: one mention from a page, one that will collide
    await sql`insert into edges (src_type,src_id,rel,dst_type,dst_id,extracted_by)
      values ('page',${pageId},'mentions','org',${orgId},'system:extract')`;
    // a pre-existing identical-after-retype edge (page -> person mentions) to force a collision
    await sql`insert into edges (src_type,src_id,rel,dst_type,dst_id,extracted_by)
      values ('page',${pageId},'mentions','person',${keepPerson},'system:extract')`;
    // an edge with the org on the src side
    await sql`insert into edges (src_type,src_id,rel,dst_type,dst_id,extracted_by)
      values ('org',${orgId},'works_at','org',${orgId},'system:extract')`;

    const res = await retypeOrgToPerson(orgId, {});

    // no edge should still reference the old org id on either side
    const dangling = await sql`select count(*)::int n from edges
      where src_id=${orgId} or dst_id=${orgId}`;
    expect(dangling[0]!.n).toBe(0);
    // the self-referential works_at (person works_at itself) must be dropped
    const selfRef = await sql`select count(*)::int n from edges
      where src_id=${res.personId} and dst_id=${res.personId}`;
    expect(selfRef[0]!.n).toBe(0);
    // the page->org mention, retyped to page->person, collides with the existing one → exactly one
    const mentions = await sql`select count(*)::int n from edges
      where src_id=${pageId} and dst_id=${res.personId} and rel='mentions'`;
    expect(mentions[0]!.n).toBe(1);
  });

  test("merges into an existing person of the same name instead of creating a duplicate", async () => {
    const { id: existing } = await ensurePerson("Hai Yan", "agent:mcp");
    const { id: orgId } = await ensureOrg("Hai Yan", "system:extract");

    const res = await retypeOrgToPerson(orgId, {});

    expect(res.personId).toBe(existing);
    const all = await sql`select count(*)::int n from people where lower(canonical_name)='hai yan'`;
    expect(all[0]!.n).toBe(1);
  });

  test("is reversible-friendly: org row is retired (kept), not hard-deleted", async () => {
    const { id: orgId } = await ensureOrg("Hai Yan", "system:extract");
    const res = await retypeOrgToPerson(orgId, {});
    const row = await sql`select id, retired_at, supersedes_id from orgs where id=${orgId}`;
    expect(row.length).toBe(1); // still present
    expect(row[0]!.retired_at).not.toBeNull();
    // the person points back at the org it superseded
    const p = await sql`select supersedes_id from people where id=${res.personId}`;
    expect(p[0]!.supersedes_id).toBe(orgId);
  });

  test("rejects an unknown org id", async () => {
    await expect(retypeOrgToPerson("00000000-0000-0000-0000-000000000000", {})).rejects.toThrow(
      /not found/i,
    );
  });
});

describe("detectMistypedEntities (read-only screen)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  test("flags an org whose name looks like a person (extractor-minted, has a relation cue)", async () => {
    // org created by the extractor, referenced by a task whose body calls it a boss
    const { id: orgId } = await ensureOrg("Hai Yan", "system:extract");
    const taskId = (
      await sql`insert into tasks (title,status,created_by)
      values ('PPT for Hai Yan (my boss)','inbox','agent:classifier') returning id`
    )[0]!.id;
    await sql`insert into edges (src_type,src_id,rel,dst_type,dst_id,extracted_by)
      values ('task',${taskId},'mentions','org',${orgId},'system:extract')`;

    const flags = await detectMistypedEntities();
    const hit = flags.find((f) => f.id === orgId);
    expect(hit).toBeTruthy();
    expect(hit?.kind).toBe("org_should_be_person");
  });

  test("flags a person minted from a bare pronoun", async () => {
    const { id } = await ensurePerson("She", "system:extract");
    const flags = await detectMistypedEntities();
    const hit = flags.find((f) => f.id === id);
    expect(hit?.kind).toBe("person_from_pronoun");
  });

  test("does NOT flag a legitimate human-confirmed org", async () => {
    await ensureOrg("Vazyme", "agent:mcp");
    const flags = await detectMistypedEntities();
    expect(flags.find((f) => f.name === "Vazyme")).toBeUndefined();
  });

  test("does NOT flag a single-token extractor org (brand-vs-surname ambiguity)", async () => {
    // "Vazyme"/"Fapon" are real biotech brands the extractor mints as orgs; a single
    // capitalized token must not be treated as a person-name false positive.
    await ensureOrg("Fapon", "system:extract");
    const flags = await detectMistypedEntities();
    expect(flags.find((f) => f.name === "Fapon")).toBeUndefined();
  });

  test("does NOT flag a person-looking org that >= 2 distinct people work_at (workplace signal)", async () => {
    // "Kiddie Winkie" looks like "First Last" but is a real multi-person workplace.
    // An org that is the works_at destination of 2+ distinct people is never a person,
    // so the screen excludes it automatically — no curation needed.
    const { id: orgId } = await ensureOrg("Kiddie Winkie", "system:extract");
    const { id: p1 } = await ensurePerson("Mia Liu", "system:extract");
    const { id: p2 } = await ensurePerson("Noa Tan", "system:extract");
    for (const pid of [p1, p2]) {
      await sql`insert into edges (src_type,src_id,rel,dst_type,dst_id,extracted_by)
        values ('person',${pid},'works_at','org',${orgId},'system:extract')`;
    }
    const flags = await detectMistypedEntities();
    expect(flags.find((f) => f.id === orgId)).toBeUndefined();
  });

  test("STILL flags a person-looking org that only ONE person works_at (no over-suppression)", async () => {
    // The workplace signal needs >= 2 distinct people; a single employee is structurally
    // identical to a genuinely mistyped person ("Bert Vogelstein"), so it must still surface.
    const { id: orgId } = await ensureOrg("Bert Vogelstein", "system:extract");
    const { id: pid } = await ensurePerson("Heng Liu", "system:extract");
    await sql`insert into edges (src_type,src_id,rel,dst_type,dst_id,extracted_by)
      values ('person',${pid},'works_at','org',${orgId},'system:extract')`;
    const flags = await detectMistypedEntities();
    expect(flags.find((f) => f.id === orgId)?.kind).toBe("org_should_be_person");
  });

  test("parseKnownOrgs: comments/blanks ignored, case-folded exact names (allow-list)", () => {
    // The irreducible semantic case — a single-employee institution ("Johns Hopkins") that
    // IS an org but looks like a person — is silenced by the owner's known-orgs.txt allow-list.
    const set = parseKnownOrgs("# header\n\nJohns Hopkins\n  Morgan Stanley  \n# trailing comment\n");
    expect([...set].sort()).toEqual(["johns hopkins", "morgan stanley"]);
    expect(set.has("johns hopkins")).toBe(true);
    expect(set.has("Johns Hopkins".toLowerCase())).toBe(true);
  });
});
