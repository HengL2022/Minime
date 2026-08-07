// M11 — sanctioned entity retype/supersede (DECISIONS.md 2026-06-16).
// The relation extractor can mint an `org` row for something that is really a person
// (e.g. "Vera Saltmarsh", a boss first seen only inside a task title), and there is no
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
    const { id: orgId } = await ensureOrg("Vera Saltmarsh", "system:extract");
    await sql`insert into org_aliases (org_id, alias) values (${orgId}, 'Вера Солтмарш') on conflict do nothing`;

    const res = await retypeOrgToPerson(orgId, { relation: "boss" });

    expect(res.personId).toBeTruthy();
    expect(res.orgId).toBe(orgId);
    // org no longer resolves as an active org
    expect(await resolveOrg("Vera Saltmarsh")).toBeNull();
    // person now resolves under canonical name AND the preserved alias
    const p = await resolvePerson("Vera Saltmarsh");
    expect(p?.id).toBe(res.personId);
    expect(p?.relation).toBe("boss");
    const byAlias = await resolvePerson("Вера Солтмарш");
    expect(byAlias?.id).toBe(res.personId);
  });

  test("repoints edges from the org to the new person and de-dupes collisions", async () => {
    const { id: orgId } = await ensureOrg("Vera Saltmarsh", "system:extract");
    const { id: keepPerson } = await ensurePerson("Nadia Rossi", "agent:classifier");
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
    const { id: existing } = await ensurePerson("Vera Saltmarsh", "agent:mcp");
    const { id: orgId } = await ensureOrg("Vera Saltmarsh", "system:extract");

    const res = await retypeOrgToPerson(orgId, {});

    expect(res.personId).toBe(existing);
    const all =
      await sql`select count(*)::int n from people where lower(canonical_name)='vera saltmarsh'`;
    expect(all[0]!.n).toBe(1);
  });

  test("preserves tier-2 provenance for both new and reused people", async () => {
    const [source] = await sql`
      insert into pages (path, title, body_md, content_hash, tier)
      values ('retype/private-source', 'Private source', 'fixture', 'retype-private', 2)
      returning id`;

    const freshOrg = await ensureOrg("Private Fresh Person", "system:extract", "extract", {
      tier: 2,
      derivedFrom: source!.id,
    });
    await sql`
      insert into org_aliases (org_id, alias, tier, source, created_by, derived_from)
      values (${freshOrg.id}, 'Fresh Private Alias', 2, 'extract', 'system:extract', ${source!.id})`;
    const fresh = await retypeOrgToPerson(freshOrg.id);
    const [freshPerson] = await sql`
      select tier, source, created_by, derived_from from people where id = ${fresh.personId}`;
    expect(freshPerson).toMatchObject({
      tier: 2,
      source: "retype",
      created_by: "agent:retype",
      derived_from: source!.id,
    });
    const freshAliases = await sql`
      select alias, tier, source, created_by, derived_from
      from person_aliases where person_id = ${fresh.personId} order by alias`;
    expect(freshAliases.map((row) => ({ ...row }))).toEqual([
      {
        alias: "Fresh Private Alias",
        tier: 2,
        source: "retype",
        created_by: "agent:retype",
        derived_from: source!.id,
      },
      {
        alias: "Private Fresh Person",
        tier: 2,
        source: "retype",
        created_by: "agent:retype",
        derived_from: source!.id,
      },
    ]);

    const reusedPerson = await ensurePerson("Private Reused Person", "human");
    const reusedOrg = await ensureOrg("Private Reused Person", "system:extract", "extract", {
      tier: 2,
      derivedFrom: source!.id,
    });
    const reused = await retypeOrgToPerson(reusedOrg.id);
    expect(reused.personId).toBe(reusedPerson.id);
    const [reusedAfter] = await sql`
      select tier, derived_from from people where id = ${reused.personId}`;
    expect(reusedAfter).toMatchObject({ tier: 2, derived_from: source!.id });
    const aliases = await sql`
      select tier from person_aliases where person_id in (${fresh.personId}, ${reused.personId})`;
    expect(aliases.length).toBeGreaterThanOrEqual(3);
    expect(aliases.every((row) => row.tier === 2)).toBe(true);
  });

  test("mixed alias namespaces survive retype without downgrading the readable alias", async () => {
    const existing = await ensurePerson("Mixed Namespace Retype", "human");
    const sharedAlias = "Mixed Namespace Shared Alias";
    await sql`
      insert into person_aliases (person_id, alias, tier, source, created_by)
      values (${existing.id}, ${sharedAlias}, 1, 'manual', 'human')`;
    const org = await ensureOrg("Mixed Namespace Retype", "system:extract");
    const [source] = await sql`
      insert into pages (path, title, body_md, content_hash, tier)
      values ('retype/mixed-namespace.md', 'Mixed namespace', 'fixture',
              'retype-mixed-namespace', 0) returning id`;
    await sql`
      insert into org_aliases (org_id, alias, tier, source, created_by, derived_from)
      values (${org.id}, ${sharedAlias}, 0, 'quarantine', 'owner:test', ${source!.id})`;

    const result = await retypeOrgToPerson(org.id);
    expect(result.personId).toBe(existing.id);
    const aliases = await sql`
      select tier, privacy_namespace, source, created_by, derived_from
      from person_aliases
      where person_id = ${existing.id} and alias = ${sharedAlias}
      order by tier`;
    expect(aliases.map((row) => ({ ...row }))).toEqual([
      {
        tier: 0,
        privacy_namespace: 0,
        source: "retype",
        created_by: "agent:retype",
        derived_from: source!.id,
      },
      {
        tier: 1,
        privacy_namespace: 1,
        source: "manual",
        created_by: "human",
        derived_from: existing.id,
      },
    ]);
    expect((await resolvePerson(sharedAlias))?.id).toBe(existing.id);
  });

  test("a tier-zero org cannot reuse a readable person through that person's tier-zero alias", async () => {
    const readable = await ensurePerson("Readable Namespace Keeper", "human");
    const hiddenName = "Hidden Retype Namespace";
    await sql`
      insert into person_aliases (person_id, alias, tier, source, created_by)
      values (${readable.id}, ${hiddenName}, 0, 'quarantine', 'owner:test')`;
    const [org] = await sql`
      insert into orgs (canonical_name, tier, source, created_by)
      values (${hiddenName}, 0, 'quarantine', 'owner:test') returning id`;

    const result = await retypeOrgToPerson(org!.id);
    expect(result.personId).not.toBe(readable.id);
    const [kept] = await sql`select tier from people where id = ${readable.id}`;
    const [quarantined] = await sql`select tier from people where id = ${result.personId}`;
    expect(kept!.tier).toBe(1);
    expect(quarantined!.tier).toBe(0);
  });

  test("collision cleanup keeps tier-zero evidence even when it is newer", async () => {
    const existingPerson = await ensurePerson("Quarantined Retype", "human");
    await sql`update people set tier = 0 where id = ${existingPerson.id}`;
    const [org] = await sql`
      insert into orgs (canonical_name, tier, source, created_by, derived_from)
      values ('Quarantined Retype', 0, 'quarantine', 'owner:test', gen_random_uuid())
      returning id, derived_from`;
    await sql`
      insert into org_aliases (org_id, alias, tier, source, created_by, derived_from)
      values (${org!.id}, 'Quarantined Retype', 0, 'quarantine', 'owner:test',
              ${org!.derived_from})`;
    const [graphSource] = await sql`
      insert into pages (path, title, body_md, content_hash, tier)
      values ('retype/collision.md', 'Collision', 'fixture', 'retype-collision', 1)
      returning id`;
    const [tierZeroSource] = await sql`
      insert into pages (path, title, body_md, content_hash, tier)
      values ('retype/collision-zero.md', 'Zero source', 'fixture',
              'retype-collision-zero', 0) returning id`;
    const [tierTwoSource] = await sql`
      insert into pages (path, title, body_md, content_hash, tier)
      values ('retype/collision-two.md', 'Two source', 'fixture',
              'retype-collision-two', 2) returning id`;
    await sql`
      insert into edges
        (src_type, src_id, rel, dst_type, dst_id, source_table, source_id,
         extracted_by, tier, source, created_by, derived_from, created_at)
      values
        ('page', ${graphSource!.id}, 'mentions', 'person', ${existingPerson.id},
         'pages', ${tierTwoSource!.id}, 'system:extract', 2, 'extract',
         'system:extract', ${tierTwoSource!.id}, '2026-01-01T00:00:00Z'),
        ('page', ${graphSource!.id}, 'mentions', 'org', ${org!.id},
         'pages', ${tierZeroSource!.id}, 'system:extract', 0, 'extract',
         'system:extract', ${tierZeroSource!.id}, '2026-01-02T00:00:00Z')`;

    const result = await retypeOrgToPerson(org!.id);
    expect(result.personId).toBe(existingPerson.id);
    const [person] = await sql`
      select tier, derived_from from people where id = ${existingPerson.id}`;
    expect(person).toEqual({ tier: 0, derived_from: org!.derived_from });
    const edges = await sql`
      select tier, source_id, derived_from from edges
      where src_type = 'page' and src_id = ${graphSource!.id}
        and rel = 'mentions' and dst_type = 'person' and dst_id = ${existingPerson.id}`;
    expect(edges.map((row) => ({ ...row }))).toEqual([
      { tier: 0, source_id: tierZeroSource!.id, derived_from: tierZeroSource!.id },
    ]);
  });

  test("is reversible-friendly: org row is retired (kept), not hard-deleted", async () => {
    const { id: orgId } = await ensureOrg("Vera Saltmarsh", "system:extract");
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
    const { id: orgId } = await ensureOrg("Vera Saltmarsh", "system:extract");
    const taskId = (
      await sql`insert into tasks (title,status,created_by)
      values ('PPT for Vera Saltmarsh (my boss)','inbox','agent:classifier') returning id`
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
    await ensureOrg("Fjordsonics", "agent:mcp");
    const flags = await detectMistypedEntities();
    expect(flags.find((f) => f.name === "Fjordsonics")).toBeUndefined();
  });

  test("does NOT flag a single-token extractor org (brand-vs-surname ambiguity)", async () => {
    // "Fjordsonics"/"Glasswing" are fictional brands the extractor mints as orgs; a single
    // capitalized token must not be treated as a person-name false positive.
    await ensureOrg("Glasswing", "system:extract");
    const flags = await detectMistypedEntities();
    expect(flags.find((f) => f.name === "Glasswing")).toBeUndefined();
  });

  test("does NOT flag a person-looking org that >= 2 distinct people work_at (workplace signal)", async () => {
    // "Marble Lantern" looks like "First Last" but is a fictional multi-person workplace.
    // An org that is the works_at destination of 2+ distinct people is never a person,
    // so the screen excludes it automatically — no curation needed.
    const { id: orgId } = await ensureOrg("Marble Lantern", "system:extract");
    const { id: p1 } = await ensurePerson("Priya Raghunathan", "system:extract");
    const { id: p2 } = await ensurePerson("Nadia Rossi", "system:extract");
    for (const pid of [p1, p2]) {
      await sql`insert into edges (src_type,src_id,rel,dst_type,dst_id,extracted_by)
        values ('person',${pid},'works_at','org',${orgId},'system:extract')`;
    }
    const flags = await detectMistypedEntities();
    expect(flags.find((f) => f.id === orgId)).toBeUndefined();
  });

  test("STILL flags a person-looking org that only ONE person works_at (no over-suppression)", async () => {
    // The workplace signal needs >= 2 distinct people; a single employee is structurally
    // identical to a genuinely mistyped person ("Sigrid Halvorsen"), so it must still surface.
    const { id: orgId } = await ensureOrg("Sigrid Halvorsen", "system:extract");
    const { id: pid } = await ensurePerson("Priya Raghunathan", "system:extract");
    await sql`insert into edges (src_type,src_id,rel,dst_type,dst_id,extracted_by)
      values ('person',${pid},'works_at','org',${orgId},'system:extract')`;
    const flags = await detectMistypedEntities();
    expect(flags.find((f) => f.id === orgId)?.kind).toBe("org_should_be_person");
  });

  test("parseKnownOrgs: comments/blanks ignored, case-folded exact names (allow-list)", () => {
    // The irreducible semantic case — a single-employee fictional institution
    // ("Marble Lantern") that looks like a person — is silenced by known-orgs.txt.
    const set = parseKnownOrgs(
      "# header\n\nMarble Lantern\n  Cobalt Meadow  \n# trailing comment\n",
    );
    expect([...set].sort()).toEqual(["cobalt meadow", "marble lantern"]);
    expect(set.has("marble lantern")).toBe(true);
    expect(set.has("Marble Lantern".toLowerCase())).toBe(true);
  });
});
