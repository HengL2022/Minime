// M7 typed-edge extraction (DECISIONS.md 2026-06-11): zero-LLM rule layer turning prose
// into mentions/works_at edges, owner-relations, and discovered people/orgs. Fully offline;
// fixtures are fictional (not the owner's data, and distinct from the /tmp eval persona).

import { beforeAll, describe, expect, test } from "bun:test";
import {
  edgesAround,
  entitiesNamedIn,
  oneHopNeighbors,
  resolveOrg,
  resolvePerson,
  upsertPage,
} from "../src/db/repo";
import { extractAndLink, extractFacts, parseNonOrgTerms } from "../src/pipeline/extract-edges";
import { indexParent } from "../src/search/index-parent";
import { resetDb, testSql } from "./helpers";

const EMPTY = { people: [], orgs: [] };

describe("extractFacts (pure rules)", () => {
  test("role + name + org in one sentence → person, relation, works_at @0.85", () => {
    const f = extractFacts(
      "My physiotherapist Solveig Dahl at Lade Fysio fixed my knee in two sessions.",
      EMPTY,
    );
    expect(f.people).toEqual([{ name: "Solveig Dahl", relation: "physiotherapist" }]);
    expect(f.orgs).toEqual(["Lade Fysio"]);
    expect(f.worksAt).toEqual([{ person: "Solveig Dahl", org: "Lade Fysio", confidence: 0.85 }]);
  });

  test("honorific is stripped; 'Vet:' listing form parses", () => {
    const f = extractFacts(
      "Vet: Dr. Nils Moen at Byåsen Smådyrklinikk. Vaccinations due May.",
      EMPTY,
    );
    expect(f.people).toEqual([{ name: "Nils Moen", relation: "vet" }]);
    expect(f.orgs).toEqual(["Byåsen Smådyrklinikk"]);
    expect(f.worksAt[0]).toMatchObject({ person: "Nils Moen", org: "Byåsen Smådyrklinikk" });
  });

  test("bullet paragraph scope: person sentence + job sentence → works_at @0.7", () => {
    const f = extractFacts(
      "- **Kjersti Lund** — best friend, met at choir. Structural engineer at Polarconsult.",
      EMPTY,
    );
    expect(f.people).toEqual([{ name: "Kjersti Lund", relation: "friend" }]);
    expect(f.worksAt).toEqual([{ person: "Kjersti Lund", org: "Polarconsult", confidence: 0.7 }]);
  });

  test("page-dominant org: work-role person inherits the page's org @0.6", () => {
    const f = extractFacts(
      "# Work at Havlyd\n\nI joined Havlyd AS in March 2020 as a sonar engineer.\n\n" +
        "My manager is Astrid Bergland, who runs the platforms group.",
      EMPTY,
    );
    // "Havlyd" (heading) and "Havlyd AS" (prose) merge on the suffix-stripped base name
    expect(f.orgs).toEqual(["Havlyd AS"]);
    expect(f.people).toEqual([{ name: "Astrid Bergland", relation: "manager" }]);
    expect(f.worksAt).toEqual([{ person: "Astrid Bergland", org: "Havlyd AS", confidence: 0.6 }]);
  });

  test("no page-dominant edge when the page names several orgs once each", () => {
    const f = extractFacts(
      "- Runa — my sister, data analyst at Nordbank in Bergen.\n" +
        "- Piotr — work friend, firmware lead.",
      EMPTY,
    );
    expect(f.worksAt).toEqual([{ person: "Runa", org: "Nordbank", confidence: 0.85 }]);
    expect(f.people).toContainEqual({ name: "Piotr", relation: "friend" });
  });

  test("uncued capitalized places are not orgs", () => {
    const f = extractFacts(
      "The run group meets at Solsiden 9:00 on Sundays. Afterwards we get buns at Baker Hansen.",
      EMPTY,
    );
    expect(f.orgs).toEqual([]);
    expect(f.worksAt).toEqual([]);
  });

  test("'I' is never a person; joined-verb still discovers the org", () => {
    const f = extractFacts("I joined Havlyd AS in March 2020.", EMPTY);
    expect(f.people).toEqual([]);
    expect(f.orgs).toEqual(["Havlyd AS"]);
  });

  // --- Fix A: phantom-org prevention at ingestion (2026-06-16) ----------------
  // The relation extractor used to mint phantom orgs from the owner's name,
  // other people's names, places, generic nouns, and therapy/concept terms.
  // See docs/known-issues/extractor-phantom-orgs.md.

  test("a known person's name is never extracted as an org (bare first name)", () => {
    // canonical-only lexicon (no convenient 'Heng' alias) — the real-world gap
    const lex = { people: [{ id: "p1", names: ["Heng Liu"] }], orgs: [] };
    const f = extractFacts("Chen Mengwei now works with Heng on the IDH trial.", lex);
    expect(f.orgs).toEqual([]);
  });

  test("possessive of a known person is not an org", () => {
    const lex = { people: [{ id: "p1", names: ["Max Z. Liu"] }], orgs: [] };
    const f = extractFacts("My collaborator joined Max's group last week.", lex);
    expect(f.orgs).toEqual([]);
  });

  test("cities are not orgs even with a work cue", () => {
    const f = extractFacts("She works at Wuhan on the trial.", EMPTY);
    expect(f.orgs).toEqual([]);
  });

  test("therapy types / concepts are not orgs", () => {
    const f = extractFacts("The team works on CAR-T for glioma.", EMPTY);
    expect(f.orgs).toEqual([]);
  });

  test("a bare generic noun ('School') is not an org by suffix alone", () => {
    const f = extractFacts("Krystal works at School most afternoons.", EMPTY);
    expect(f.orgs).toEqual([]);
  });

  test("a real multi-word org with a generic head word still extracts", () => {
    // guard must be precise: 'School' alone is junk, 'Goddard School' is a real org
    const f = extractFacts("I joined Goddard School AS in 2019 as a teacher.", EMPTY);
    expect(f.orgs).toContain("Goddard School AS");
  });

  test("a pronoun is never minted as a person (source guard for the 'She' bug)", () => {
    // The relation extractor used to mint a person row named "She"/"They"/"It" from
    // role+pronoun constructs, then attach phantom works_at edges from unrelated
    // sentences onto that one blob. validName() now rejects pronoun-led candidates at
    // the source, so detectMistypedEntities() never has to clean them up after the fact.
    for (const text of [
      "Vet: She handled the appointment.",
      "My sister She works at the lab.",
      "Doctor They reviewed the scans.",
      "Therapist It is great with the kids.",
    ]) {
      const f = extractFacts(text, EMPTY);
      expect(f.people).toEqual([]);
    }
  });

  test("known entities are reported as mentions", () => {
    const lex = {
      people: [{ id: "p1", names: ["Kjersti Lund"] }],
      orgs: [{ id: "o1", names: ["Polarconsult"] }],
    };
    const f = extractFacts("Dinner with Kjersti Lund after her Polarconsult offsite.", lex);
    expect(f.mentions).toContainEqual({ type: "person", id: "p1" });
    expect(f.mentions).toContainEqual({ type: "org", id: "o1" });
  });
});

// Ingestion-time prevention of phantom "org" nodes minted from the ORG_PREP rule
// (at/for/with + Capitalized word). The same-sentence person check let bare first names
// ("Heng" vs stored "Heng Liu") and people known only elsewhere slip through; cities and
// lab/assay jargon ("Wuhan", "CAR-T") have no person to anchor them at all.
describe("extractFacts org-poisoning guard", () => {
  const lex = (...names: string[]) => ({
    people: names.map((n, i) => ({ id: `p${i}`, names: [n] })),
    orgs: [],
  });

  test("a known person's bare first name is not minted as an org", () => {
    const f = extractFacts("Spent the afternoon working with Heng on the assay.", lex("Heng Liu"));
    expect(f.orgs).toEqual([]);
    expect(f.worksAt).toEqual([]);
  });

  test("a known person named only elsewhere is still blocked", () => {
    const f = extractFacts("Worked through the grant budget with Liz again.", lex("Liz Park"));
    expect(f.orgs).toEqual([]);
  });

  test("possessive of a known person ('Max's') is stripped, then blocked", () => {
    const f = extractFacts("Spent the morning working with Max's draft.", lex("Max Brenner"));
    expect(f.orgs).toEqual([]);
  });

  test("a stoplisted city/jargon token is not an org even with a work cue", () => {
    const f = extractFacts("I worked at Wuhan for two years.", EMPTY, new Set(["wuhan"]));
    expect(f.orgs).toEqual([]);
    expect(f.worksAt).toEqual([]);
  });

  test("stoplist is exact-match: a real org containing the word still extracts", () => {
    const stop = new Set(["school"]);
    expect(extractFacts("I left my bag at School yesterday.", EMPTY, stop).orgs).toEqual([]);
    expect(extractFacts("She works at Goddard School now.", EMPTY, stop).orgs).toEqual([
      "Goddard School",
    ]);
  });

  test("a legitimate single-word org via 'at' + cue is still extracted (no over-blocking)", () => {
    const f = extractFacts("I work at Equinor now.", EMPTY, new Set(["wuhan"]));
    expect(f.orgs).toEqual(["Equinor"]);
  });

  test("parseNonOrgTerms: comments and blank lines ignored, case-folded", () => {
    const s = parseNonOrgTerms("# header\nWuhan\n\n  CAR-T  \npcr\n");
    expect([...s].sort()).toEqual(["car-t", "pcr", "wuhan"]);
  });
});

describe("extractAndLink (DB application)", () => {
  beforeAll(async () => {
    await resetDb();
  });

  const PAGE = `I joined Havlyd AS in March 2020 as a sonar engineer.

My manager is Astrid Bergland, who runs the platforms group. My closest collaborator is
Piotr Nowak, our embedded firmware lead.

My physiotherapist Solveig Dahl at Lade Fysio fixed my knee.`;

  let pageId: string;

  test("indexParent extracts entities and edges on write", async () => {
    const { id } = await upsertPage({
      path: "test/work.md",
      title: "Work at Havlyd",
      bodyMd: PAGE,
      contentHash: "hash-m7-1",
      source: "test",
    });
    pageId = id;
    await indexParent("page", id, PAGE, "Work at Havlyd", 1);

    const astrid = await resolvePerson("Astrid Bergland");
    expect(astrid).not.toBeNull();
    expect(astrid.relation).toBe("manager");
    expect(astrid.created_by).toBe("system:extract");
    const havlyd = await resolveOrg("Havlyd");
    expect(havlyd).not.toBeNull();
    expect(havlyd.canonical_name).toBe("Havlyd AS");

    const [worksAt] = await testSql`
      select e.confidence from edges e
      where e.rel = 'works_at' and e.src_id = ${astrid.id} and e.dst_id = ${havlyd.id}`;
    expect(worksAt).toBeDefined();
    const solveig = await resolvePerson("Solveig Dahl");
    const fysio = await resolveOrg("Lade Fysio");
    const [physioEdge] = await testSql`
      select e.confidence from edges e
      where e.rel = 'works_at' and e.src_id = ${solveig.id} and e.dst_id = ${fysio.id}`;
    expect(Number(physioEdge!.confidence)).toBeCloseTo(0.85, 5);
  });

  test("re-indexing is idempotent (no duplicate edges or entities)", async () => {
    const before = await testSql`select count(*)::int as n from edges`;
    await indexParent("page", pageId, PAGE, "Work at Havlyd", 1);
    const after = await testSql`select count(*)::int as n from edges`;
    expect(after[0]!.n).toBe(before[0]!.n);
    const people = await testSql`select count(*)::int as n from people`;
    await indexParent("page", pageId, PAGE, "Work at Havlyd", 1);
    expect((await testSql`select count(*)::int as n from people`)[0]!.n).toBe(people[0]!.n);
  });

  test("short name later upgraded by fuller form, not forked", async () => {
    await extractAndLink("page", pageId, "Piotr — work friend, board games on Thursdays.");
    const piotr = await resolvePerson("Piotr");
    expect(piotr).not.toBeNull();
    expect(piotr.canonical_name).toBe("Piotr Nowak");
    const n = await testSql`
      select count(*)::int as n from people where canonical_name ilike 'piotr%'`;
    expect(n[0]!.n).toBe(1);
  });

  test("a human-set relation is never overwritten", async () => {
    await testSql`update people set relation = 'old colleague' where canonical_name = 'Piotr Nowak'`;
    await extractAndLink("page", pageId, "Piotr Nowak — my mentor since 2021.");
    const piotr = await resolvePerson("Piotr Nowak");
    expect(piotr.relation).toBe("old colleague");
  });

  test("family-relation people never get a works_at edge (kids don't work at orgs)", async () => {
    // A family narrative co-mentions a child, a work cue, and orgs in one paragraph —
    // exactly the shape that minted phantom "Mia works_at Hehuang Pharma" edges. With the
    // child stored as relation='daughter', extractAndLink must refuse any works_at edge.
    const { ensurePerson, setPersonRelationIfNull } = await import("../src/db/repo");
    const { id: miaId } = await ensurePerson("Mialin Tofteberg", "test", "capture");
    await setPersonRelationIfNull(miaId, "daughter");

    await extractAndLink(
      "page",
      pageId,
      "Mialin Tofteberg joined her violin class; meanwhile work at Havlyd AS continued and she visited Lade Fysio.",
    );

    const work = await testSql`
      select count(*)::int as n from edges
      where rel = 'works_at' and src_type = 'person' and src_id = ${miaId}`;
    expect(work[0]!.n).toBe(0);
    // a normal mentions edge is still fine — the guard is works_at-specific
    const mentions = await testSql`
      select count(*)::int as n from edges
      where rel = 'mentions' and dst_type = 'person' and dst_id = ${miaId}`;
    expect(mentions[0]!.n).toBeGreaterThan(0);
  });

  test("graph boost reaches orgs: entitiesNamedIn + oneHopNeighbors", async () => {
    const refs = await entitiesNamedIn("who works at Havlyd these days?");
    expect(refs.some((r) => r.type === "org")).toBe(true);
    const hop = await oneHopNeighbors(refs);
    expect(hop.has(`page:${pageId}`)).toBe(true);
  });

  test("get_context-style traversal answers 'who works at X'", async () => {
    const havlyd = await resolveOrg("Havlyd AS");
    const edges = await edgesAround("org", havlyd.id, 20);
    const workers = edges.filter((e: any) => e.rel === "works_at");
    expect(workers.length).toBe(2); // Astrid (manager) + Piotr (lead), both page-dominant
  });
});

describe("minime_review_queue tool", () => {
  test("list → resolve round-trip", async () => {
    const { insertReviewItem } = await import("../src/db/repo");
    const { toolByName } = await import("../src/mcp/tools");
    const { invokeTool } = await import("../src/mcp/tools/registry");
    const ctx = { actor: "agent:test" };
    const tool = toolByName("minime_review_queue");

    const { id } = await insertReviewItem("inbox_unfiled", { raw_path: "inbox/x.txt" });
    const list = await invokeTool(tool, { action: "list", kind: "inbox_unfiled" }, ctx);
    if (!list.ok) throw new Error(list.error.message);
    expect((list.envelope.data as any).items.some((i: any) => i.id === id)).toBe(true);

    const res = await invokeTool(tool, { action: "resolve", id, status: "resolved" }, ctx);
    expect(res.ok).toBe(true);
    const again = await invokeTool(tool, { action: "list", kind: "inbox_unfiled" }, ctx);
    if (!again.ok) throw new Error(again.error.message);
    expect((again.envelope.data as any).items.some((i: any) => i.id === id)).toBe(false);
  });

  test("stale label of a tier-2 row is masked at tier 1", async () => {
    const { insertReviewItem, upsertPage } = await import("../src/db/repo");
    const { toolByName } = await import("../src/mcp/tools");
    const { invokeTool } = await import("../src/mcp/tools/registry");
    const { id: pageId } = await upsertPage({
      path: "t2/private-page.md",
      title: "Private tier-2 page title",
      bodyMd: "private body",
      contentHash: "hash-m7-t2",
      tier: 2,
      source: "test",
    });
    const { id: itemId } = await insertReviewItem("stale", {
      id: pageId,
      type: "page",
      label: "Private tier-2 page title", // baked in at flag time; must not surface at tier 1
    });
    const list = await invokeTool(
      toolByName("minime_review_queue"),
      { action: "list", kind: "stale" },
      { actor: "agent:test" },
    );
    if (!list.ok) throw new Error(list.error.message);
    const item = (list.envelope.data as any).items.find((i: any) => i.id === itemId);
    expect(item.payload.label).toBe("[above current tier]");
  });
});
