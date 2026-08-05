import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { addAlias, chunkPairsSharingPerson, ensurePerson, upsertPage } from "../src/db/repo";
import { contradictionScan } from "../src/pipeline/dream";
import { indexParent } from "../src/search/index-parent";
import {
  COMPILED_NOTE_MARKER,
  compiledNoteIdentityFromPath,
  recognizeCompiledNote,
} from "../src/util/compiled-note-archive";
import { config } from "../src/util/config";
import { resetDb, testSql as sql } from "./helpers";

const savedMockOllama = config.mockOllama;

beforeEach(async () => {
  await resetDb();
  config.mockOllama = true;
});
afterEach(() => {
  config.mockOllama = savedMockOllama;
});

async function indexedPage(path: string, title: string, body: string, tier = 1): Promise<string> {
  const { id } = await upsertPage({
    path,
    title,
    bodyMd: body,
    contentHash: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
    tier,
    source: "test:h5",
  });
  await indexParent("page", id, body, title, tier);
  return id;
}

async function parentMentionEdge(input: {
  parentType: string;
  parentId: string;
  personId: string;
  sourceTable?: string;
  sourceId?: string;
}): Promise<void> {
  await sql`insert into edges
    (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
    values
    (${input.parentType}, ${input.parentId}, 'mentions', 'person', ${input.personId},
     ${input.sourceTable ?? "legacy"}, ${input.sourceId ?? input.parentId}, 'system:extract')`;
}

type H5FloorArm = "edge" | "person" | "chunk" | "parent";

async function h5EvidencePair(
  label: string,
  zeroArm?: H5FloorArm,
): Promise<{ personId: string; chunkIds: [string, string] }> {
  const canonicalName = `H5 Amendment ${label}`;
  const [person] = await sql`
    insert into people (canonical_name, tier, source, created_by)
    values (
      ${canonicalName},
      ${zeroArm === "person" ? 0 : 1},
      'test:h5-amendment',
      'test:h5-amendment'
    )
    returning id`;
  const chunkIds: string[] = [];
  for (const side of [0, 1] as const) {
    const parentId = crypto.randomUUID();
    const text = `${canonicalName} ${side === 0 ? "always" : "never"} checks the harbor bell.`;
    await sql`
      insert into pages
        (id, path, title, body_md, content_hash, tier, source)
      values (
        ${parentId},
        ${`h5/amendment-${label.toLowerCase()}-${side}.md`},
        ${canonicalName},
        ${text},
        ${`h5-amendment-${label}-${side}`},
        ${zeroArm === "parent" && side === 0 ? 0 : 1},
        'test:h5-amendment'
      )`;
    const [chunk] = await sql`
      insert into chunks (parent_type, parent_id, ord, text, tier)
      values (
        'page',
        ${parentId},
        0,
        ${text},
        ${zeroArm === "chunk" && side === 0 ? 0 : 1}
      )
      returning id`;
    chunkIds.push(chunk!.id);
    const [edge] = await sql`
      insert into edges
        (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
      values (
        'page',
        ${parentId},
        'mentions',
        'person',
        ${person!.id},
        'h5_amendment_fixture',
        ${parentId},
        'system:extract'
      )
      returning id`;
    if (zeroArm === "edge" && side === 0) {
      await sql`update edges set tier = 0 where id = ${edge!.id}`;
    }
  }
  return { personId: person!.id, chunkIds: chunkIds as [string, string] };
}

async function h5UnresolvedParentPair(
  label: string,
  parentType: "unknown_parent" | "task",
): Promise<string> {
  const canonicalName = `H5 Unresolved ${label}`;
  const [person] = await sql`
    insert into people (canonical_name, tier, source, created_by)
    values (${canonicalName}, 1, 'test:h5-amendment', 'test:h5-amendment')
    returning id`;
  for (const side of [0, 1] as const) {
    const parentId = crypto.randomUUID();
    const text = `${canonicalName} ${side === 0 ? "always" : "never"} checks the tide chart.`;
    await sql`
      insert into chunks (parent_type, parent_id, ord, text, tier)
      values (${parentType}, ${parentId}, 0, ${text}, 1)`;
    await sql`
      insert into edges
        (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
      values (
        ${parentType},
        ${parentId},
        'mentions',
        'person',
        ${person!.id},
        'h5_amendment_fixture',
        ${parentId},
        'system:extract'
      )`;
  }
  return person!.id;
}

test("real extractAndLink parent edges produce one canonical pair and one review item", async () => {
  const { id: personId } = await ensurePerson("Juniper Vale", "test:h5");
  await indexedPage("h5/juniper-a.md", "Morning note", "Juniper Vale always walks at dawn.");
  await indexedPage("h5/juniper-b.md", "Evening note", "Juniper Vale never walks at dawn.");

  const edges = await sql`select src_type, src_id, source_table, source_id
    from edges where rel = 'mentions' and dst_type = 'person' and dst_id = ${personId}
    order by src_id`;
  expect(edges).toHaveLength(2);
  expect(edges.every((edge) => edge.src_type === "page")).toBe(true);
  expect(edges.every((edge) => edge.source_table === "pages")).toBe(true);
  expect(edges.every((edge) => edge.source_id === edge.src_id)).toBe(true);

  const pairs = await chunkPairsSharingPerson(100);
  expect(pairs).toHaveLength(1);
  expect(pairs[0]!.person_id).toBe(personId);
  expect(pairs[0]!.a_id < pairs[0]!.b_id).toBe(true);

  expect(await contradictionScan(100)).toBe(1);
  expect(await contradictionScan(100)).toBe(0);
  const queue = await sql`select payload from review_queue where kind = 'contradiction'`;
  expect(queue).toHaveLength(1);
  expect(queue[0]!.payload).toEqual({
    pair: `${pairs[0]!.a_id}:${pairs[0]!.b_id}`,
    person_id: personId,
    chunk_ids: [pairs[0]!.a_id, pairs[0]!.b_id],
  });
  expect(JSON.stringify(queue[0]!.payload)).not.toContain("walks at dawn");
});

test("canonical names and aliases use case-folded literal substring semantics", async () => {
  const literalNames = [
    "Percent%Person",
    "Under_score",
    "O'Rill",
    String.raw`Back\\Slash`,
    "MiXeD CaSe",
    "点点",
    "Dr. Q—North!",
  ] as const;

  for (const [index, literal] of literalNames.entries()) {
    const { id: personId } = await ensurePerson(`Canonical Fixture ${index}`, "test:h5");
    await addAlias(personId, literal);
    const decoy = literal
      .replace("%", "X")
      .replace("_", "X")
      .replace("\\", "/")
      .replace("MiXeD", "unrelated")
      .replace("点点", "点线")
      .replace("North", "South")
      .replace("Rill", "Vale");
    const chunkIds: string[] = [];
    for (const [ord, text] of [
      `${literal.toLocaleLowerCase()} always chooses tea.`,
      `${literal.toLocaleUpperCase()} never chooses tea.`,
      `${decoy} is an attached wildcard decoy.`,
    ].entries()) {
      const [page] = await sql`insert into pages
        (path, title, body_md, content_hash, tier, source)
        values (${`h5/literal-${index}-${ord}.md`}, ${`Literal ${index}-${ord}`},
                ${text}, ${`literal-${index}-${ord}`}, 1, 'test:h5')
        returning id`;
      const [chunk] = await sql`insert into chunks
        (parent_type, parent_id, ord, text, tier)
        values ('page', ${page!.id}, 0, ${text}, 1)
        returning id`;
      chunkIds.push(chunk!.id);
      await parentMentionEdge({ parentType: "page", parentId: page!.id, personId });
    }
    const pairs = (await chunkPairsSharingPerson(1_000)).filter(
      (pair) => pair.person_id === personId,
    );
    expect(pairs).toHaveLength(1);
    expect(new Set([pairs[0]!.a_id, pairs[0]!.b_id])).toEqual(new Set(chunkIds.slice(0, 2)));
    expect([pairs[0]!.a_id, pairs[0]!.b_id]).not.toContain(chunkIds[2]!);
  }

  const [blank] = await sql`insert into people (canonical_name, tier, source, created_by)
      values ('   ', 1, 'test:h5', 'test:h5') returning id`;
  for (const [index, text] of ["words with spaces", "other spaced words"].entries()) {
    const [page] = await sql`insert into pages
      (path, title, body_md, content_hash, tier, source)
      values (${`h5/blank-${index}.md`}, 'Blank name fixture', ${text},
              ${`blank-${index}`}, 1, 'test:h5') returning id`;
    await sql`insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('page', ${page!.id}, 0, ${text}, 1)`;
    await parentMentionEdge({ parentType: "page", parentId: page!.id, personId: blank!.id });
  }
  expect(
    (await chunkPairsSharingPerson(1_000)).filter((pair) => pair.person_id === blank!.id),
  ).toEqual([]);
});

test("same parent never pairs its own chunks; same UUID text in different parent types remains distinct", async () => {
  const sharedId = crypto.randomUUID();
  const { id: personId } = await ensurePerson("Tamsin Reed", "test:h5");
  await sql`insert into pages (id, path, title, body_md, content_hash, tier, source)
    values (${sharedId}, 'h5/shared.md', 'Shared page',
            'Tamsin Reed always takes the ferry.', 'h5-shared-page', 1, 'test:h5')`;
  await sql`insert into tasks (id, title, body, tier, source)
    values (${sharedId}, 'Tamsin Reed task', 'Tamsin Reed never takes the ferry.', 2, 'test:h5')`;
  await sql`insert into chunks (parent_type, parent_id, ord, text, tier) values
    ('page', ${sharedId}, 0, 'Tamsin Reed always takes the ferry.', 1),
    ('page', ${sharedId}, 1, 'Tamsin Reed always checks the timetable.', 1),
    ('task', ${sharedId}, 0, 'Tamsin Reed never takes the ferry.', 2)`;
  await parentMentionEdge({ parentType: "page", parentId: sharedId, personId });
  await parentMentionEdge({ parentType: "task", parentId: sharedId, personId });

  const pairs = (await chunkPairsSharingPerson(100)).filter((pair) => pair.person_id === personId);
  expect(pairs).toHaveLength(2);
  expect(pairs.every((pair) => Math.max(pair.a_tier, pair.b_tier) === 2)).toBe(true);
  const pageOnly = await sql`select id from chunks
    where parent_type = 'page' and parent_id = ${sharedId} order by ord`;
  expect(
    pairs.some(
      (pair) =>
        [pair.a_id, pair.b_id].includes(pageOnly[0]!.id) &&
        [pair.a_id, pair.b_id].includes(pageOnly[1]!.id),
    ),
  ).toBe(false);
});

test("different people never share a pair", async () => {
  const a = await ensurePerson("Rowan East", "test:h5");
  const b = await ensurePerson("Sable West", "test:h5");
  const pa = await indexedPage("h5/rowan.md", "Rowan", "Rowan East always sails.");
  const pb = await indexedPage("h5/sable.md", "Sable", "Sable West never sails.");
  expect(pa).not.toBe(pb);
  expect(await chunkPairsSharingPerson(100)).toEqual([]);
  const counts = await sql`select dst_id, count(*)::int n from edges
    where rel = 'mentions' and dst_id in (${a.id}, ${b.id}) group by dst_id order by dst_id`;
  expect(counts).toHaveLength(2);
});

test("soft-deleted page chunks are stale, while non-page parent chunks remain eligible", async () => {
  const { id: personId } = await ensurePerson("Mara Quill", "test:h5");
  const staleA = await indexedPage("h5/stale-a.md", "Stale A", "Mara Quill always rows.");
  const staleB = await indexedPage("h5/stale-b.md", "Stale B", "Mara Quill never rows.");
  await sql`update pages set status = 'deleted' where id in (${staleA}, ${staleB})`;

  const taskIds = [crypto.randomUUID(), crypto.randomUUID()];
  const taskChunks: string[] = [];
  for (const [index, taskId] of taskIds.entries()) {
    const text = `Mara Quill ${index === 0 ? "always" : "never"} rows.`;
    await sql`insert into tasks (id, title, body, tier, source)
      values (${taskId}, ${`Mara task ${index}`}, ${text}, 1, 'test:h5')`;
    const [chunk] = await sql`insert into chunks
      (parent_type, parent_id, ord, text, tier)
      values ('task', ${taskId}, 0, ${text}, 1) returning id`;
    taskChunks.push(chunk!.id);
    await parentMentionEdge({ parentType: "task", parentId: taskId, personId });
  }

  const pairs = (await chunkPairsSharingPerson(100)).filter((pair) => pair.person_id === personId);
  expect(pairs).toHaveLength(1);
  expect(new Set([pairs[0]!.a_id, pairs[0]!.b_id])).toEqual(new Set(taskChunks));
  const parentTypes = await sql`select distinct parent_type from chunks
    where id in (${pairs[0]!.a_id}, ${pairs[0]!.b_id})`;
  expect([...parentTypes]).toEqual([{ parent_type: "task" }]);
});

test("compiled pages are excluded under source, UUID-path, and H1 system-shape recognition", async () => {
  const { id: personId } = await ensurePerson("Ione Mercer", "test:h5");
  const primary = await indexedPage(
    "h5/ione-primary.md",
    "Primary",
    "Ione Mercer always grows thyme.",
  );
  const [primaryChunk] =
    await sql`select id from chunks where parent_type = 'page' and parent_id = ${primary}`;
  const sourceId = primaryChunk!.id;
  const shapes = [
    {
      path: `derived/notes/person/ione-mercer--${personId}.md`,
      source: "brain-sync",
      body: "# Ione Mercer\n\nIone Mercer never grows thyme.\n",
    },
    {
      path: "imports/offset-zero-marker-and-sources.md",
      source: "brain-sync",
      body: `${COMPILED_NOTE_MARKER}\n\n## Sources\n- ${sourceId}\n\nIone Mercer never grows thyme.\n`,
    },
    {
      path: "derived/notes/person/ione-mercer.md",
      source: "brain-sync",
      body: `# Ione Mercer\n\n${COMPILED_NOTE_MARKER}\n\nIone Mercer never grows thyme.\n\n## Sources\n- ${sourceId}\n`,
    },
    {
      path: "imports/temporarily-misprovenanced.md",
      source: "brain-sync",
      body: `## Sources\r\n- ${sourceId}\r\n\r\n${COMPILED_NOTE_MARKER}\r\n\r\nIone Mercer never grows thyme.\r\n`,
    },
    {
      path: "imports/blank-before-source.md",
      source: "brain-sync",
      body:
        `# Ione Mercer\n\n${COMPILED_NOTE_MARKER}\n\n` +
        `Ione Mercer never grows thyme.\n\n## Sources\n\n- ${sourceId}\n`,
    },
    {
      path: "imports/comment-before-source.md",
      source: "brain-sync",
      body: `# Ione Mercer\n\n${COMPILED_NOTE_MARKER}\n\nIone Mercer never grows thyme.\n\n## Sources\n<!-- temporary provenance note -->\n- ${sourceId}\n`,
    },
    {
      path: "imports/prose-before-source.md",
      source: "brain-sync",
      body: `# Ione Mercer\n\n${COMPILED_NOTE_MARKER}\n\nIone Mercer never grows thyme.\n\n## Sources\nSource rows follow.\n- ${sourceId}\n`,
    },
    {
      path: "derived/notes/person/canonical-source.md",
      source: "dream:notes",
      body: "Ione Mercer never grows thyme.",
    },
    {
      path: "derived/decisions/digest.md",
      source: "dream:decision-digest",
      body: "Ione Mercer never grows thyme.",
    },
  ];
  expect(compiledNoteIdentityFromPath(shapes[0]!.path)).toEqual({
    kind: "person",
    entityId: personId,
  });
  expect(
    shapes.map(
      (shape) =>
        recognizeCompiledNote({
          path: shape.path,
          source: shape.source,
          bodyMd: shape.body,
        }).recognized,
    ),
  ).toEqual([true, true, true, true, true, true, true, true, false]);
  for (const [index, shape] of shapes.entries()) {
    const [page] = await sql`insert into pages (path, title, body_md, content_hash, tier, source)
      values (${shape.path}, 'Derived fixture', ${shape.body}, ${`derived-${index}`}, 1, ${shape.source})
      returning id`;
    await sql`insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('page', ${page!.id}, 0, 'Ione Mercer never grows thyme.', 1)`;
    await parentMentionEdge({ parentType: "page", parentId: page!.id, personId });
  }
  expect(
    (await chunkPairsSharingPerson(100)).filter((pair) => pair.person_id === personId),
  ).toEqual([]);
});

test("legacy chunk-anchored metadata is ignored in favor of the canonical parent tuple", async () => {
  const { id: personId } = await ensurePerson("Niko Fern", "test:h5");
  const a = await indexedPage("h5/niko-a.md", "A", "Niko Fern always brings tea.");
  const b = await indexedPage("h5/niko-b.md", "B", "Niko Fern never brings tea.");
  const chunks = await sql`select id, parent_id from chunks
    where parent_type = 'page' and parent_id in (${a}, ${b}) order by id`;
  await sql`update edges e set source_table = 'chunks', source_id = c.id
    from chunks c where e.rel = 'mentions' and e.dst_id = ${personId}
      and c.parent_type = e.src_type and c.parent_id = e.src_id`;
  expect(chunks).toHaveLength(2);
  expect(
    (await chunkPairsSharingPerson(100)).filter((pair) => pair.person_id === personId),
  ).toHaveLength(1);
});

test("uppercase human/UUID paths remain candidates while lowercase canonical paths stay excluded", async () => {
  const { id: personId } = await ensurePerson("Ione Mercer", "test:h5");
  const lowercasePath = `derived/notes/person/ione-mercer--${personId}.md`;
  const uppercasePath = `derived/notes/person/Ione-Mercer--${personId.toUpperCase()}.md`;
  expect(compiledNoteIdentityFromPath(lowercasePath)).toEqual({
    kind: "person",
    entityId: personId,
  });
  expect(compiledNoteIdentityFromPath(uppercasePath)).toBeNull();
  expect(
    recognizeCompiledNote({
      path: uppercasePath,
      source: "brain-sync",
      bodyMd: "Ione Mercer never grows thyme.\n",
    }).recognized,
  ).toBe(false);

  const lower = await indexedPage(
    lowercasePath,
    "Lowercase compiled",
    "Ione Mercer always grows thyme.",
  );
  const upper = await indexedPage(
    uppercasePath,
    "Uppercase human path",
    "Ione Mercer never grows thyme.",
  );
  const plain = await indexedPage("h5/ione-plain.md", "Plain", "Ione Mercer always grows thyme.");
  const chunks = await sql`select id, parent_id from chunks
    where parent_type = 'page' and parent_id in (${lower}, ${upper}, ${plain}) order by id`;
  const pairs = (await chunkPairsSharingPerson(100)).filter((pair) => pair.person_id === personId);
  expect(pairs).toHaveLength(1);
  expect(new Set([pairs[0]!.a_id, pairs[0]!.b_id])).toEqual(
    new Set([
      chunks.find((row) => row.parent_id === upper)!.id,
      chunks.find((row) => row.parent_id === plain)!.id,
    ]),
  );
});

test("only the final exact Sources suffix can supply the recognition UUID bullet", async () => {
  const { id: personId } = await ensurePerson("Orla Pine", "test:h5");
  const primary = await indexedPage(
    "h5/orla-primary.md",
    "Primary",
    "Orla Pine always keeps the blue notebook.",
  );
  const [primaryChunk] =
    await sql`select id from chunks where parent_type = 'page' and parent_id = ${primary}`;
  const body = `# Orla Pine\n\n${COMPILED_NOTE_MARKER}\n\n## Sources\n- ${primaryChunk!.id}\n\nIntervening text.\n\n## Sources\nNo current source row.\n`;
  expect(
    recognizeCompiledNote({
      path: "imports/final-sources-empty.md",
      source: "brain-sync",
      bodyMd: body,
    }).recognized,
  ).toBe(false);
  const [page] = await sql`insert into pages
    (path, title, body_md, content_hash, tier, source)
    values ('imports/final-sources-empty.md', 'Candidate', ${body},
            'h5-final-sources-empty', 1, 'brain-sync')
    returning id`;
  await sql`insert into chunks (parent_type, parent_id, ord, text, tier)
    values ('page', ${page!.id}, 0,
            'Orla Pine never keeps the blue notebook.', 1)`;
  await parentMentionEdge({ parentType: "page", parentId: page!.id, personId });

  expect(
    (await chunkPairsSharingPerson(100)).filter((pair) => pair.person_id === personId),
  ).toHaveLength(1);
});

test("H5 amendment characterization: four tier-one evidence surfaces remain eligible", async () => {
  const fixture = await h5EvidencePair("Tier One");
  const [evidence] = await sql`
    select min(e.tier)::int as edge_min,
           min(p.tier)::int as person_min,
           min(c.tier)::int as chunk_min,
           min(pg.tier)::int as parent_min
    from edges e
    join people p on p.id = e.dst_id
    join chunks c on c.parent_type = e.src_type and c.parent_id = e.src_id
    join pages pg on pg.id = e.src_id
    where e.dst_id = ${fixture.personId}`;
  expect(evidence).toEqual({
    edge_min: 1,
    person_min: 1,
    chunk_min: 1,
    parent_min: 1,
  });
  const pairs = (await chunkPairsSharingPerson(100)).filter(
    (pair) => pair.person_id === fixture.personId,
  );
  expect(pairs).toHaveLength(1);
  expect(new Set([pairs[0]!.a_id, pairs[0]!.b_id])).toEqual(new Set(fixture.chunkIds));
});

test("H5 amendment characterization: exact marker line at EOF is compiled evidence", async () => {
  const { id: personId } = await ensurePerson("Mina Harbor", "test:h5-amendment");
  const primary = await indexedPage(
    "h5/amendment-marker-primary.md",
    "Marker primary",
    "Mina Harbor always records the north buoy.",
  );
  const [primaryChunk] = await sql`
    select id from chunks where parent_type = 'page' and parent_id = ${primary}`;
  const body = `## Sources\n- ${primaryChunk!.id}\n\nMina Harbor never records the north buoy.\n\n${COMPILED_NOTE_MARKER}`;
  expect(body.endsWith(COMPILED_NOTE_MARKER)).toBe(true);
  expect(
    recognizeCompiledNote({
      path: "imports/h5-amendment-marker-eof.md",
      source: "brain-sync",
      bodyMd: body,
    }),
  ).toEqual({
    recognized: true,
    reason: "system_shape",
    pathIdentity: null,
    sourceIds: [primaryChunk!.id],
  });
  const [derived] = await sql`
    insert into pages (path, title, body_md, content_hash, tier, source)
    values (
      'imports/h5-amendment-marker-eof.md',
      'Marker EOF',
      ${body},
      'h5-amendment-marker-eof',
      1,
      'brain-sync'
    )
    returning id`;
  await sql`
    insert into chunks (parent_type, parent_id, ord, text, tier)
    values (
      'page',
      ${derived!.id},
      0,
      'Mina Harbor never records the north buoy.',
      1
    )`;
  await parentMentionEdge({
    parentType: "page",
    parentId: derived!.id,
    personId,
  });
  expect(
    (await chunkPairsSharingPerson(100)).filter((pair) => pair.person_id === personId),
  ).toEqual([]);
});

test("H5 amendment RED: tier-zero and unresolved canonical-parent evidence cannot pair", async () => {
  const floorFixtures = await Promise.all(
    (["edge", "person", "chunk", "parent"] as const).map(async (arm) => ({
      label: arm,
      personId: (await h5EvidencePair(`Floor ${arm}`, arm)).personId,
    })),
  );
  const unresolved = [
    {
      label: "unknown",
      personId: await h5UnresolvedParentPair("Unknown", "unknown_parent"),
    },
    {
      label: "orphan",
      personId: await h5UnresolvedParentPair("Orphan", "task"),
    },
  ];
  const pairs = await chunkPairsSharingPerson(1_000);
  expect(
    [...floorFixtures, ...unresolved].map((fixture) => ({
      label: fixture.label,
      count: pairs.filter((pair) => pair.person_id === fixture.personId).length,
    })),
  ).toEqual([
    { label: "edge", count: 0 },
    { label: "person", count: 0 },
    { label: "chunk", count: 0 },
    { label: "parent", count: 0 },
    { label: "unknown", count: 0 },
    { label: "orphan", count: 0 },
  ]);
});

test("H5 amendment RED: uppercase canonical UUID bullets are compiled evidence", async () => {
  const { id: personId } = await ensurePerson("Uma Cypress", "test:h5-amendment");
  const primary = await indexedPage(
    "h5/amendment-uppercase-primary.md",
    "Uppercase primary",
    "Uma Cypress always carries the brass compass.",
  );
  const [primaryChunk] = await sql`
    select id from chunks where parent_type = 'page' and parent_id = ${primary}`;
  const body = `${COMPILED_NOTE_MARKER}\n\nUma Cypress never carries the brass compass.\n\n## Sources\n- ${primaryChunk!.id.toUpperCase()}`;
  expect(
    recognizeCompiledNote({
      path: "imports/h5-amendment-uppercase-source.md",
      source: "brain-sync",
      bodyMd: body,
    }),
  ).toEqual({
    recognized: true,
    reason: "system_shape",
    pathIdentity: null,
    sourceIds: [primaryChunk!.id],
  });
  const [derived] = await sql`
    insert into pages (path, title, body_md, content_hash, tier, source)
    values (
      'imports/h5-amendment-uppercase-source.md',
      'Uppercase source',
      ${body},
      'h5-amendment-uppercase-source',
      1,
      'brain-sync'
    )
    returning id`;
  await sql`
    insert into chunks (parent_type, parent_id, ord, text, tier)
    values (
      'page',
      ${derived!.id},
      0,
      'Uma Cypress never carries the brass compass.',
      1
    )`;
  await parentMentionEdge({
    parentType: "page",
    parentId: derived!.id,
    personId,
  });
  expect(
    (await chunkPairsSharingPerson(100)).filter((pair) => pair.person_id === personId),
  ).toEqual([]);
});

test("deduplication precedes the complete deterministic ordering and limit", async () => {
  const ordered = [
    {
      person: "Newest Person",
      at: "2026-07-23T03:00:00Z",
      a: "00000000-0000-4000-8000-000000000011",
      b: "00000000-0000-4000-8000-000000000012",
    },
    {
      person: "Tie Alpha",
      at: "2026-07-23T02:00:00Z",
      a: "00000000-0000-4000-8000-000000000021",
      b: "00000000-0000-4000-8000-000000000022",
    },
    {
      person: "Tie Beta",
      at: "2026-07-23T02:00:00Z",
      a: "00000000-0000-4000-8000-000000000031",
      b: "00000000-0000-4000-8000-000000000032",
    },
  ] as const;

  for (const [index, item] of ordered.entries()) {
    const { id: personId } = await ensurePerson(item.person, "test:h5");
    const parentIds = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [side, parentId] of parentIds.entries()) {
      const text = `${item.person} ${side === 0 ? "always" : "never"} checks the tide.`;
      await sql`insert into pages
        (id, path, title, body_md, content_hash, tier, source)
        values (${parentId}, ${`h5/order-${index}-${side}.md`}, ${item.person},
                ${text}, ${`order-${index}-${side}`}, 1, 'test:h5')`;
      await sql`insert into chunks
        (id, parent_type, parent_id, ord, text, tier, updated_at)
        values (${side === 0 ? item.a : item.b}, 'page', ${parentId}, 0,
                ${text}, 1, ${item.at}::timestamptz)`;
      await parentMentionEdge({ parentType: "page", parentId, personId });
      await parentMentionEdge({ parentType: "page", parentId, personId });
    }
  }

  const sharedPeople = [
    { id: "00000000-0000-4000-8000-000000000101", name: "Aster Low" },
    { id: "00000000-0000-4000-8000-000000000102", name: "Briar Low" },
  ] as const;
  for (const person of sharedPeople) {
    await sql`insert into people (id, canonical_name, tier, source, created_by)
      values (${person.id}, ${person.name}, 1, 'test:h5', 'test:h5')`;
  }
  const sharedParents = [crypto.randomUUID(), crypto.randomUUID()];
  const sharedChunks = [
    "00000000-0000-4000-8000-000000000041",
    "00000000-0000-4000-8000-000000000042",
  ] as const;
  for (const [side, parentId] of sharedParents.entries()) {
    const text =
      side === 0
        ? "Aster Low and Briar Low always inspect the bell."
        : "Aster Low and Briar Low never inspect the bell.";
    await sql`insert into pages
      (id, path, title, body_md, content_hash, tier, source)
      values (${parentId}, ${`h5/order-shared-${side}.md`}, 'Shared people',
              ${text}, ${`order-shared-${side}`}, 1, 'test:h5')`;
    await sql`insert into chunks
      (id, parent_type, parent_id, ord, text, tier, updated_at)
      values (${sharedChunks[side]!}, 'page', ${parentId}, 0, ${text}, 1,
              '2026-07-23T01:00:00Z'::timestamptz)`;
    for (const person of sharedPeople) {
      await parentMentionEdge({ parentType: "page", parentId, personId: person.id });
    }
  }

  const tiePerson = { id: "00000000-0000-4000-8000-000000000103", name: "B Id Tie" } as const;
  await sql`insert into people (id, canonical_name, tier, source, created_by)
    values (${tiePerson.id}, ${tiePerson.name}, 1, 'test:h5', 'test:h5')`;
  const tieParents = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const tieChunks = [
    "00000000-0000-4000-8000-000000000051",
    "00000000-0000-4000-8000-000000000061",
    "00000000-0000-4000-8000-000000000062",
  ] as const;
  for (const [index, parentId] of tieParents.entries()) {
    const text = `B Id Tie ${index === 0 ? "always" : "never"} checks the bell ${index}.`;
    await sql`insert into pages
      (id, path, title, body_md, content_hash, tier, source)
      values (${parentId}, ${`h5/order-b-id-${index}.md`}, ${tiePerson.name},
              ${text}, ${`order-b-id-${index}`}, 1, 'test:h5')`;
    await sql`insert into chunks
      (id, parent_type, parent_id, ord, text, tier, updated_at)
      values (${tieChunks[index]!}, 'page', ${parentId}, 0, ${text}, 1,
              '2026-07-23T00:00:00Z'::timestamptz)`;
    await parentMentionEdge({ parentType: "page", parentId, personId: tiePerson.id });
  }

  const all = await chunkPairsSharingPerson(100);
  expect(all.slice(0, 3).map((pair) => [pair.a_id, pair.b_id])).toEqual(
    ordered.map((item) => [item.a, item.b]),
  );
  expect(all.slice(3).map((pair) => pair.person_id)).toEqual([
    ...sharedPeople.map((person) => person.id),
    tiePerson.id,
    tiePerson.id,
    tiePerson.id,
  ]);
  expect(all.slice(3, 5).map((pair) => pair.person_id)).toEqual(
    sharedPeople.map((person) => person.id),
  );
  const tiePairs = all.slice(5);
  expect(tiePairs.map((pair) => [pair.a_id, pair.b_id])).toEqual([
    [tieChunks[0], tieChunks[1]],
    [tieChunks[0], tieChunks[2]],
    [tieChunks[1], tieChunks[2]],
  ]);
  expect(tiePairs.slice(0, 2).map((pair) => pair.a_id)).toEqual([tieChunks[0], tieChunks[0]]);
  expect(tiePairs.slice(0, 2).map((pair) => pair.b_id)).toEqual([tieChunks[1], tieChunks[2]]);
  expect(await chunkPairsSharingPerson(2)).toEqual(all.slice(0, 2));
});

test("scan routes by maximum pair tier and queues IDs only", async () => {
  const { id: personId } = await ensurePerson("Elian Moss", "test:h5");
  await indexedPage("h5/elian-a.md", "Elian A", "Elian Moss always visits the pier.", 1);
  await indexedPage("h5/elian-b.md", "Elian B", "Elian Moss never visits the pier.", 2);
  const [pair] = (await chunkPairsSharingPerson(100)).filter(
    (candidate) => candidate.person_id === personId,
  );
  expect(pair).toBeDefined();
  expect(Math.max(pair!.a_tier, pair!.b_tier)).toBe(2);

  const previous = {
    ollamaUrl: config.ollamaUrl,
    classifyProvider: config.classifyProvider,
    cloudMaxTier: config.cloudMaxTier,
    providerRouteTier1: config.providerRouteTier1,
    providerRouteTier2: config.providerRouteTier2,
    openrouterApiKey: config.openrouterApiKey,
    mockOllama: config.mockOllama,
  };
  const localRequests: { path: string; body: string }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      localRequests.push({
        path: request.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ response: '{"conflict":true}' }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("H5 Ollama fixture did not bind");
  const realFetch = globalThis.fetch;
  const cloudCalls: string[] = [];
  globalThis.fetch = (async (url: any) => {
    cloudCalls.push(String(url));
    throw new Error(`unexpected cloud egress: ${url}`);
  }) as unknown as typeof fetch;
  config.ollamaUrl = `http://127.0.0.1:${address.port}`;
  config.classifyProvider = "openrouter";
  config.openrouterApiKey = "h5-test-key";
  config.cloudMaxTier = 1;
  config.providerRouteTier1 = "openrouter";
  config.providerRouteTier2 = "ollama";
  config.mockOllama = false;
  // Non-vacuity: a Math.min regression resolves tier 1 to the denied cloud route, so it
  // produces no local request and no flag; both outcomes fail the assertions below.
  try {
    const flagged = await contradictionScan(100);
    expect(flagged).toBe(1);
    expect(cloudCalls).toEqual([]);
    expect(localRequests.map((request) => request.path)).toEqual(["/api/generate"]);
    expect(localRequests[0]!.body).toContain("Elian Moss always visits the pier.");
    expect(localRequests[0]!.body).toContain("Elian Moss never visits the pier.");
    const [queue] = await sql`select payload from review_queue
        where kind = 'contradiction' and payload ->> 'person_id' = ${personId}`;
    expect(queue!.payload.chunk_ids).toEqual([pair!.a_id, pair!.b_id]);
    expect(Object.keys(queue!.payload).sort()).toEqual(["chunk_ids", "pair", "person_id"]);
    expect(JSON.stringify(queue!.payload)).not.toContain("always");
    expect(JSON.stringify(queue!.payload)).not.toContain("never");
  } finally {
    globalThis.fetch = realFetch;
    config.ollamaUrl = previous.ollamaUrl;
    config.classifyProvider = previous.classifyProvider;
    config.cloudMaxTier = previous.cloudMaxTier;
    config.providerRouteTier1 = previous.providerRouteTier1;
    config.providerRouteTier2 = previous.providerRouteTier2;
    config.openrouterApiKey = previous.openrouterApiKey;
    config.mockOllama = previous.mockOllama;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
