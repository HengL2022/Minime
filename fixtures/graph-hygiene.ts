// Planted corpus for the graph-hygiene gate: the three historical phantom-entity archetypes
// plus control (good) edges. Fictional data only. Used by test/m14 (mock verdicts, CI bar)
// and scripts/eval-graph-hygiene.ts (live model, owner-run scorecard).
import { sql } from "../src/db/client";

export interface Planted {
  badEdgeIds: string[];
  goodEdgeIds: string[];
}

export async function plantGraphHygieneCorpus(): Promise<Planted> {
  const bad: string[] = [];
  const good: string[] = [];
  const page = async (path: string, body: string, tier = 1) =>
    (
      await sql`
    insert into pages (path, title, body_md, content_hash, tier)
    values (${path}, ${path}, ${body}, ${path}, ${tier}) returning id`
    )[0]!.id as string;
  const chunk = (pid: string, text: string, tier = 1) => sql`
    insert into chunks (parent_type, parent_id, ord, text, tier) values ('page', ${pid}, 0, ${text}, ${tier})`;
  const edge = async (
    src: [string, string],
    rel: string,
    dst: [string, string],
    pid: string,
    conf: number,
  ) =>
    (
      await sql`
    insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by, confidence)
    values (${src[0]}, ${src[1]}, ${rel}, ${dst[0]}, ${dst[1]}, 'pages', ${pid}, 'system:extract', ${conf})
    returning id`
    )[0]!.id as string;

  // Archetype 1: bare-first-name phantom ORG ("Verity" is a person name the rules minted as org)
  const [verity] =
    await sql`insert into orgs (canonical_name, tier) values ('Verity', 1) returning id`;
  const p1 = await page("gh/1.md", "Talked with Verity about the school run.");
  await chunk(p1, "Talked with Verity about the school run.");
  bad.push(await edge(["page", p1], "mentions", ["org", verity!.id], p1, 0.8));

  // Archetype 2: family works_at (daughter + work-cue paragraph)
  const [mia] =
    await sql`insert into people (canonical_name, relation, tier) values ('Mia Ito', 'daughter', 1) returning id`;
  const [lab] =
    await sql`insert into orgs (canonical_name, tier) values ('Northside Lab', 1) returning id`;
  const p2 = await page("gh/2.md", "My daughter Mia Ito visited Northside Lab where I work.");
  await chunk(p2, "My daughter Mia Ito visited Northside Lab where I work.");
  bad.push(await edge(["person", mia!.id], "works_at", ["org", lab!.id], p2, 0.7));

  // Archetype 3: vendor-as-PERSON ("FernCrest Supplies" minted as a person). The name is
  // fictional (fixtures rule) but keeps the "<Name> Supplies" shape of the real 2026-07-01
  // incident so VENDOR_SUFFIX_CUE exercises the same detection path.
  const [ferncrest] =
    await sql`insert into people (canonical_name, tier) values ('FernCrest Supplies', 1) returning id`;
  const p3 = await page("gh/3.md", "Ordered two filters from FernCrest Supplies today.");
  await chunk(p3, "Ordered two filters from FernCrest Supplies today.");
  bad.push(await edge(["page", p3], "mentions", ["person", ferncrest!.id], p3, 0.8));

  // Controls: a real works_at with clean evidence + a real person mention
  const [nadia] =
    await sql`insert into people (canonical_name, tier) values ('Nadia Rossi', 1) returning id`;
  const [acme] =
    await sql`insert into orgs (canonical_name, tier) values ('Acme Corp', 1) returning id`;
  const p4 = await page("gh/4.md", "Nadia Rossi works at Acme Corp as a filtration engineer.");
  await chunk(p4, "Nadia Rossi works at Acme Corp as a filtration engineer.");
  good.push(await edge(["person", nadia!.id], "works_at", ["org", acme!.id], p4, 0.85));
  good.push(await edge(["page", p4], "mentions", ["person", nadia!.id], p4, 0.8));

  return { badEdgeIds: bad, goodEdgeIds: good };
}
