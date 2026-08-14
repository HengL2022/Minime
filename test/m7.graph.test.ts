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
    // canonical-only lexicon (no convenient 'Priya' alias) — the real-world gap
    const lex = { people: [{ id: "p1", names: ["Priya Raghunathan"] }], orgs: [] };
    const f = extractFacts("Nadia Rossi now works with Priya on the array trial.", lex);
    expect(f.orgs).toEqual([]);
  });

  test("possessive of a known person is not an org", () => {
    const lex = { people: [{ id: "p1", names: ["Sigrid Halvorsen"] }], orgs: [] };
    const f = extractFacts("My collaborator joined Sigrid's group last week.", lex);
    expect(f.orgs).toEqual([]);
  });

  test("generic places are not orgs even with a work cue", () => {
    const f = extractFacts("She works at Home on the project.", EMPTY);
    expect(f.orgs).toEqual([]);
  });

  test("local stoplist concepts are not orgs", () => {
    const f = extractFacts("The team works with Atlas on calibration.", EMPTY, new Set(["atlas"]));
    expect(f.orgs).toEqual([]);
  });

  test("a bare generic noun ('School') is not an org by suffix alone", () => {
    const f = extractFacts("Krystal works at School most afternoons.", EMPTY);
    expect(f.orgs).toEqual([]);
  });

  test("a real multi-word org with a generic head word still extracts", () => {
    // guard must be precise: 'School' alone is junk, 'Acme School' is a fictional org
    const f = extractFacts("I joined Acme School AS in 2019 as a teacher.", EMPTY);
    expect(f.orgs).toContain("Acme School AS");
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
// ("Priya" vs stored "Priya Raghunathan") and people known only elsewhere slip through;
// generic nouns and fictional local-stoplist terms ("Springfield", "Atlas") have no person
// to anchor them at all.
describe("extractFacts org-poisoning guard", () => {
  const lex = (...names: string[]) => ({
    people: names.map((n, i) => ({ id: `p${i}`, names: [n] })),
    orgs: [],
  });

  test("a known person's bare first name is not minted as an org", () => {
    const f = extractFacts(
      "Spent the afternoon working with Priya on the calibration run.",
      lex("Priya Raghunathan"),
    );
    expect(f.orgs).toEqual([]);
    expect(f.worksAt).toEqual([]);
  });

  test("a known person named only elsewhere is still blocked", () => {
    const f = extractFacts(
      "Worked through the project budget with Nadia again.",
      lex("Nadia Rossi"),
    );
    expect(f.orgs).toEqual([]);
  });

  test("possessive of a known person ('Sigrid's') is stripped, then blocked", () => {
    const f = extractFacts(
      "Spent the morning working with Sigrid's draft.",
      lex("Sigrid Halvorsen"),
    );
    expect(f.orgs).toEqual([]);
  });

  test("a stoplisted city/jargon token is not an org even with a work cue", () => {
    const f = extractFacts(
      "I worked at Springfield for two years.",
      EMPTY,
      new Set(["springfield"]),
    );
    expect(f.orgs).toEqual([]);
    expect(f.worksAt).toEqual([]);
  });

  test("stoplist is exact-match: a real org containing the word still extracts", () => {
    const stop = new Set(["school"]);
    expect(extractFacts("I left my bag at School yesterday.", EMPTY, stop).orgs).toEqual([]);
    expect(extractFacts("She works at Acme School now.", EMPTY, stop).orgs).toEqual([
      "Acme School",
    ]);
  });

  test("a legitimate single-word org via 'at' + cue is still extracted (no over-blocking)", () => {
    const f = extractFacts("I work at Fjordsonics now.", EMPTY, new Set(["springfield"]));
    expect(f.orgs).toEqual(["Fjordsonics"]);
  });

  test("parseNonOrgTerms: comments and blank lines ignored, case-folded", () => {
    const s = parseNonOrgTerms("# header\nSpringfield\n\n  Downtown  \natlas\nSignal-Lattice\n");
    expect([...s].sort()).toEqual(["atlas", "downtown", "signal-lattice", "springfield"]);
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

  test("re-indexing replaces stale extracted edges for that source row", async () => {
    const { id } = await upsertPage({
      path: "test/reindex-probe.md",
      title: "Reindex probe",
      bodyMd: "My physiotherapist Mara Sol at North Clinic helped my knee.",
      contentHash: "hash-m7-reindex-a",
      source: "test",
    });
    await indexParent(
      "page",
      id,
      "My physiotherapist Mara Sol at North Clinic helped my knee.",
      "Reindex probe",
      1,
    );
    const oldPerson = await resolvePerson("Mara Sol");
    const oldOrg = await resolveOrg("North Clinic");
    expect(oldPerson).not.toBeNull();
    expect(oldOrg).not.toBeNull();

    await indexParent(
      "page",
      id,
      "My dentist Oskar Li at South Clinic checked a molar.",
      "Reindex probe",
      1,
    );

    const oldEdges = await testSql`
      select count(*)::int as n from edges
      where source_table = 'pages' and source_id = ${id}
        and (src_id = ${oldPerson.id} or dst_id = ${oldPerson.id} or dst_id = ${oldOrg.id})`;
    expect(oldEdges[0]!.n).toBe(0);
    const newPerson = await resolvePerson("Oskar Li");
    const newOrg = await resolveOrg("South Clinic");
    const newEdges = await testSql`
      select count(*)::int as n from edges
      where source_table = 'pages' and source_id = ${id}
        and rel = 'works_at' and src_id = ${newPerson.id} and dst_id = ${newOrg.id}`;
    expect(newEdges[0]!.n).toBe(1);
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
    // exactly the shape that minted phantom "Mina Solberg works_at Acme Corp" edges. With the
    // child stored as relation='daughter', extractAndLink must refuse any works_at edge.
    const { ensurePerson, setPersonRelationIfNull } = await import("../src/db/repo");
    const { id: minaId } = await ensurePerson("Mina Solberg", "test", "capture");
    await setPersonRelationIfNull(minaId, "daughter");

    await extractAndLink(
      "page",
      pageId,
      "Mina Solberg joined her violin class; meanwhile work at Havlyd AS continued and she visited Lade Fysio.",
    );

    const work = await testSql`
      select count(*)::int as n from edges
      where rel = 'works_at' and src_type = 'person' and src_id = ${minaId}`;
    expect(work[0]!.n).toBe(0);
    // a normal mentions edge is still fine — the guard is works_at-specific
    const mentions = await testSql`
      select count(*)::int as n from edges
      where rel = 'mentions' and dst_type = 'person' and dst_id = ${minaId}`;
    expect(mentions[0]!.n).toBeGreaterThan(0);
  });

  test("adult family relations can still have employers", async () => {
    const { ensurePerson, setPersonRelationIfNull } = await import("../src/db/repo");
    const { id: meeraId } = await ensurePerson("Meera", "test", "capture");
    await setPersonRelationIfNull(meeraId, "sister");

    await extractAndLink("page", pageId, "Meera — my younger sister, data scientist at RBC.");

    const rbc = await resolveOrg("RBC");
    expect(rbc).not.toBeNull();
    const work = await testSql`
      select count(*)::int as n from edges
      where rel = 'works_at' and src_type = 'person' and src_id = ${meeraId}
        and dst_type = 'org' and dst_id = ${rbc.id}`;
    expect(work[0]!.n).toBe(1);
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

    const { id } = await insertReviewItem("inbox_unfiled", {
      inbox_item_id: "11111111-1111-4111-8111-111111111111",
      raw_path: "/private/owner/inbox/x.txt",
      classifier: {
        type: "unknown",
        confidence: 0.2,
        fields: { text: "LEGACY-CLASSIFIER-CONTENT-SENTINEL" },
      },
    });
    const list = await invokeTool(tool, { action: "list", kind: "inbox_unfiled" }, ctx);
    if (!list.ok) throw new Error(list.error.message);
    expect((list.envelope.data as any).items.some((i: any) => i.id === id)).toBe(true);
    const wire = JSON.stringify(list.envelope);
    expect(wire).not.toContain("raw_path");
    expect(wire).not.toContain("/private/owner/inbox/x.txt");
    expect(wire).not.toContain("classifier");
    expect(wire).not.toContain("LEGACY-CLASSIFIER-CONTENT-SENTINEL");

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

// W1-5: the person_name NOT_FOUND message must never distinguish "exists at tier 2, locked"
// from "does not exist at all" — that distinction would be an oracle for otherwise
// RLS-hidden tier-2 identities (e.g. people minted purely from journal/page extraction via
// ensureExtractedPerson — since W4-1, minime_log_interaction's OWN subjects mint at tier 1
// instead, 037_identity_content_tier_split.sql, but a tier-2 identity is still directly
// reachable through ensurePerson({tier:2}) below, which is exactly what this test exercises).
describe("minime_get_context person_name NOT_FOUND (tier-aware, no oracle)", () => {
  const TIER_AWARE_NOT_FOUND =
    "no person or org matching that name at the current access tier — a match may exist " +
    "at tier 2; offer an owner-approved unlock (minime_unlock)";

  test("locked tier-2 person and a name matching nothing at all emit byte-identical NOT_FOUND", async () => {
    const { ensurePerson } = await import("../src/db/repo");
    const { toolByName } = await import("../src/mcp/tools");
    const { invokeTool } = await import("../src/mcp/tools/registry");
    const ctx = { actor: "agent:w1-5-test" };
    const tool = toolByName("minime_get_context");

    await ensurePerson("Rikke Solstad", "agent:w1-5-test", "capture", { tier: 2 });

    const tier2Result = await invokeTool(tool, { person_name: "Rikke Solstad" }, ctx);
    if (tier2Result.ok) throw new Error("expected NOT_FOUND for a locked tier-2 person");
    expect(tier2Result.error.code).toBe("NOT_FOUND");
    expect(tier2Result.error.message).toBe(TIER_AWARE_NOT_FOUND);

    const noMatchResult = await invokeTool(
      tool,
      { person_name: "Nobody Ever Logged This Name" },
      ctx,
    );
    if (noMatchResult.ok) throw new Error("expected NOT_FOUND for a name matching nothing");
    expect(noMatchResult.error.code).toBe("NOT_FOUND");
    expect(noMatchResult.error.message).toBe(TIER_AWARE_NOT_FOUND);

    // The oracle-risk assertion itself: identical wording regardless of which case occurred.
    expect(tier2Result.error.message).toBe(noMatchResult.error.message);
  });

  test("a tier-1 person still resolves normally (unchanged by the tier-aware wording)", async () => {
    const { ensurePerson } = await import("../src/db/repo");
    const { toolByName } = await import("../src/mcp/tools");
    const { invokeTool } = await import("../src/mcp/tools/registry");
    const ctx = { actor: "agent:w1-5-test" };

    const { id: personId } = await ensurePerson("Tier One Ola Berg", "agent:w1-5-test", "capture", {
      tier: 1,
    });

    const result = await invokeTool(
      toolByName("minime_get_context"),
      { person_name: "Tier One Ola Berg" },
      ctx,
    );
    if (!result.ok) throw new Error(`expected tier-1 person to resolve: ${result.error.message}`);
    expect(result.envelope.sources[0]).toMatchObject({ type: "person", id: personId });
  });
});
