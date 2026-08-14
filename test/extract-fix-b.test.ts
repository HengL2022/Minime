// Fix B: fuzzy org dedup on extract write + low-confidence works_at → review queue.
// See docs/known-issues/extractor-phantom-orgs.md. Fixtures are fictional.

import { beforeAll, describe, expect, test } from "bun:test";
import { ensureOrg, resolveOrg, resolvePerson, upsertPage } from "../src/db/repo";
import { extractAndLink, extractFacts } from "../src/pipeline/extract-edges";
import { resetDb, testSql } from "./helpers";

const EMPTY = { people: [], orgs: [] };

async function page(path: string, title: string, body: string): Promise<string> {
  const { id } = await upsertPage({
    path,
    title,
    bodyMd: body,
    contentHash: `hash-${path}`,
    source: "test",
  });
  return id;
}

describe("Fix B: fuzzy org dedup + confidence floor", () => {
  beforeAll(async () => {
    await resetDb();
  });

  test("unique near-match merges: Fjordsonic AS aliases into Fjordsonics AS", async () => {
    const existing = await ensureOrg("Fjordsonics AS", "test", "manual");
    const body = "I joined Fjordsonic AS in 2018 as a sonar engineer.";
    const pageId = await page("test/fix-b-merge.md", "Fjordsonic join", body);
    await extractAndLink("page", pageId, body);

    const twins = await testSql`
      select count(*)::int as n from orgs
      where retired_at is null and lower(canonical_name) like 'fjordsonic%'`;
    expect(twins[0]!.n).toBe(1);
    const org = await resolveOrg("Fjordsonic AS");
    expect(org).not.toBeNull();
    expect(org.id).toBe(existing.id);
    expect(org.canonical_name).toBe("Fjordsonics AS");
    const [alias] = await testSql`
      select count(*)::int as n from org_aliases
      where org_id = ${existing.id} and lower(alias) = 'fjordsonic as'`;
    expect(alias!.n).toBe(1);
    const flags = await testSql`
      select count(*)::int as n from review_queue
      where kind = 'extract_suspect' and status = 'open'
        and payload->>'reason' = 'fuzzy_org_ambiguous'`;
    expect(flags[0]!.n).toBe(0);
  });

  test("ambiguous near-match flags and does not mint a third org", async () => {
    const a = await ensureOrg("Norrlyd AS", "test", "manual");
    const b = await ensureOrg("Norrlyds AS", "test", "manual");
    const body = "I joined Norrlydx AS after the glacier-mapping internship ended.";
    const pageId = await page("test/fix-b-ambiguous.md", "Norrlydx note", body);
    await extractAndLink("page", pageId, body);

    const orgs = await testSql`
      select count(*)::int as n from orgs
      where retired_at is null and lower(canonical_name) like 'norrlyd%'`;
    expect(orgs[0]!.n).toBe(2);
    expect(await resolveOrg("Norrlydx AS")).toBeNull();

    const flags = await testSql`
      select payload from review_queue
      where kind = 'extract_suspect' and status = 'open'
        and payload->>'reason' = 'fuzzy_org_ambiguous'`;
    expect(flags.length).toBe(1);
    const payload = flags[0]!.payload as {
      reason: string;
      candidate: string;
      matches: { type: string; id: string; name: string }[];
    };
    expect(payload.candidate).toBe("Norrlydx AS");
    expect(payload.matches.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
    expect(payload.matches.every((m) => m.type === "org")).toBe(true);
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain("glacier-mapping");
    expect(wire).not.toContain("internship");
    expect(wire).not.toContain(body);

    await extractAndLink("page", pageId, body);
    const again = await testSql`
      select count(*)::int as n from review_queue
      where kind = 'extract_suspect' and status = 'open'
        and payload->>'reason' = 'fuzzy_org_ambiguous'
        and payload->>'candidate' = 'Norrlydx AS'`;
    expect(again[0]!.n).toBe(1);
  });

  test("page-dominant @0.6 is queued; same-sentence @0.85 still writes", async () => {
    const body =
      "# Work at Nordvind\n\nI joined Nordvind AS in April 2018 as a radar engineer.\n\n" +
      "My manager is Liv Haugen, who runs the sensors group.\n\n" +
      "My dentist Kari Moen at Fjordklinikk checked a molar.";
    const facts = extractFacts(body, EMPTY);
    expect(facts.worksAt).toContainEqual({
      person: "Liv Haugen",
      org: "Nordvind AS",
      confidence: 0.6,
    });
    expect(facts.worksAt).toContainEqual({
      person: "Kari Moen",
      org: "Fjordklinikk",
      confidence: 0.85,
    });

    const pageId = await page("test/fix-b-floor.md", "Work at Nordvind", body);
    await extractAndLink("page", pageId, body);

    const liv = await resolvePerson("Liv Haugen");
    const nordvind = await resolveOrg("Nordvind AS");
    const kari = await resolvePerson("Kari Moen");
    const clinic = await resolveOrg("Fjordklinikk");
    expect(liv).not.toBeNull();
    expect(nordvind).not.toBeNull();
    expect(kari).not.toBeNull();
    expect(clinic).not.toBeNull();

    const [low] = await testSql`
      select e.confidence from edges e
      where e.rel = 'works_at' and e.src_id = ${liv.id} and e.dst_id = ${nordvind.id}`;
    expect(low).toBeUndefined();
    const [high] = await testSql`
      select e.confidence from edges e
      where e.rel = 'works_at' and e.src_id = ${kari.id} and e.dst_id = ${clinic.id}`;
    expect(Number(high!.confidence)).toBeCloseTo(0.85, 5);

    const flags = await testSql`
      select payload from review_queue
      where kind = 'extract_suspect' and status = 'open'
        and payload->>'reason' = 'low_confidence_edge'`;
    expect(flags.length).toBe(1);
    const payload = flags[0]!.payload as {
      reason: string;
      confidence: number;
      person: { type: string; id: string; name: string };
      org: { type: string; id: string; name: string };
    };
    expect(payload.person).toEqual({ type: "person", id: liv.id, name: "Liv Haugen" });
    expect(payload.org).toEqual({ type: "org", id: nordvind.id, name: "Nordvind AS" });
    expect(Number(payload.confidence)).toBeCloseTo(0.6, 5);
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain("sensors group");
    expect(wire).not.toContain("radar engineer");
    expect(wire).not.toContain(body);

    await extractAndLink("page", pageId, body);
    const again = await testSql`
      select count(*)::int as n from review_queue
      where kind = 'extract_suspect' and status = 'open'
        and payload->>'reason' = 'low_confidence_edge'`;
    expect(again[0]!.n).toBe(1);
  });

  test("paragraph-scope works_at @0.7 is still written", async () => {
    const body =
      "- **Kjersti Lund** — best friend, met at choir. Structural engineer at Polarconsult.";
    const pageId = await page("test/fix-b-paragraph.md", "Choir friend", body);
    await extractAndLink("page", pageId, body);
    const person = await resolvePerson("Kjersti Lund");
    const org = await resolveOrg("Polarconsult");
    const [edge] = await testSql`
      select e.confidence from edges e
      where e.rel = 'works_at' and e.src_id = ${person.id} and e.dst_id = ${org.id}`;
    expect(Number(edge!.confidence)).toBeCloseTo(0.7, 5);
  });
});
