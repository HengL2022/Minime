# H5 Production-Shaped Contradiction Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the nightly contradiction scan pair independent production extractor parents that mention the same person, using literal canonical-name/alias evidence and excluding compiled summaries.

**Architecture:** Replace the chunk-anchored query with one parameterized CTE pipeline in `src/db/repo.ts`: resolve parent-anchored mention edges to chunks, retain literal person-name hits, exclude every canonical or legacy compiled-note shape, pair distinct composite parents, canonicalize/deduplicate chunk pairs, then apply deterministic ordering and the work limit. `contradictionScan()` keeps its existing tier routing, mock conflict detector, queue dedupe, and IDs-only payload.

**Tech Stack:** Bun/TypeScript, PostgreSQL 16 parameterized SQL, existing `extractAndLink()`/`indexParent()` pipeline, `bun test`.

## Global Constraints

- Start branch `codex/hardening-contradiction-scan` from the exact binding-reviewed H4 branch
  SHA; H2, H3, H1, and H4 must already be integrated.
- Use the pinned ignored worktree `.claude/worktrees/hardening-contradiction-scan`, record
  its initial head as `START_SHA`, and scope every status, ledger, diff, gate, and review
  command to that worktree.
- Consume H1's exact `COMPILED_NOTE_MARKER`, `COMPILED_NOTE_UUID_PATH_SQL_RE`,
  `compiledNoteIdentityFromPath()`, and `recognizeCompiledNote()` exports from the neutral
  pure module `src/util/compiled-note-archive.ts`; do not create a competing definition or
  import a pipeline module into `src/db/repo.ts`.
- Plain SQL remains only in `src/db/repo.ts`; every dynamic value, marker, regex, and limit is parameterized.
- Pair only two distinct source-parent composite keys `(src_type, src_id)`, even when UUID text is equal across parent types.
- Canonical-name and alias matching uses `strpos(lower(text), lower(name)) > 0`; never use `LIKE` or `ILIKE` for person-name matching.
- Empty and whitespace-only names never match.
- Preserve punctuation, `%`, `_`, apostrophes, backslashes, mixed case, and CJK as literal characters.
- Exclude `dream:notes`, `dream:decision-digest`, UUID-suffixed compiled-note paths, and
  every page with H1's exact marker + normalized `## Sources`/UUID-bullet system shape even
  while source temporarily says `brain-sync` or the page sits outside `derived/notes/`.
- System-shape SQL must mirror H1 exactly: isolate the suffix after the final normalized
  exact `## Sources` heading, then accept an exact canonical UUID bullet anywhere in that
  suffix. Blank lines, comments, and intervening prose are allowed; a UUID bullet beneath an
  earlier Sources heading does not recognize a final heading with no UUID bullet.
- Historical `source_table='chunks'` edges remain compatible by ignoring `source_table/source_id` when resolving the canonical parent tuple.
- Canonicalize by lexicographic chunk UUID, deduplicate before limiting, and order by newest participating chunk descending, then `a_id`, `b_id`, `person_id` ascending.
- A page-parent chunk is eligible only while its parent page is `status='active'`; stale
  chunks and mention edges left by a soft-deleted page are excluded. Non-page parents remain
  eligible without a page-status lookup, and the regression fixture must prove both halves.
- Keep result fields exactly `person_id, a_id, a_text, a_tier, b_id, b_text, b_tier`.
- Keep maximum-pair-tier routing, cloud ceiling behavior, mock antonym detection, queue idempotence, and IDs-only review payload unchanged.
- The scan remains flag-only; no entity, edge, chunk, page, or prior review item is repaired or deleted.
- Fixtures are realistic and fictional; no tier-0 data or owner content enters tests/logs.
- No migration, new dependency, new subsystem, or W5 work.
- The branch evidence and every advisory/binding review diff use the recorded immutable
  `START_SHA` (`git diff "$START_SHA"...HEAD`), never an implicit working-tree baseline.

---

## File and responsibility map

| File | Action | Responsibility |
|---|---|---|
| `test/h5-contradiction-scan.test.ts` | Create | Production extractor, literal matching, composite-parent, compiled-parent, limit/order, tier/idempotence regressions |
| `src/util/compiled-note-archive.ts` | Consume; do not modify | H1's single marker, anchored UUID-path regex, path identity, and recognition contract |
| `src/db/repo.ts` | Modify | Replace `chunkPairsSharingPerson()` with parent-shaped, deduplicated, deterministic SQL |
| `src/pipeline/dream.ts` | Inspect; comment-only if stale wording requires correction | Preserve `contradictionScan()` behavior and result consumption |
| `test/m13.provider-routing.test.ts` | Modify | Update stale chunk-anchor comment; preserve legacy source-table compatibility fixture |
| `DECISIONS.md` | Modify | Append the H5 decision only |
| `docs/SUBSYSTEMS.md` | Modify | Update only the Dream job maintenance text |

## Exact interfaces

H1's cycle-free `src/util/compiled-note-archive.ts` must already export:

```ts
export const COMPILED_NOTE_MARKER =
  "*Compiled note — distilled by the dream job from the sources below. No new claims; verify against the cited source rows.*";
export const COMPILED_NOTE_UUID_PATH_SQL_RE =
  "^derived/notes/(person|org)/[^/]+--[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.md$";

export interface CompiledNoteIdentity {
  kind: "person" | "org";
  entityId: string;
}

export function compiledNoteIdentityFromPath(path: string): CompiledNoteIdentity | null;
export function recognizeCompiledNote(page: {
  path: string;
  source?: string | null;
  bodyMd: string;
}):
  | { recognized: false }
  | {
      recognized: true;
      reason: "source" | "uuid_path" | "system_shape";
      pathIdentity: CompiledNoteIdentity | null;
      sourceIds: string[];
    };
```

H5 keeps the repository API source-compatible:

```ts
export interface ContradictionChunkPair {
  person_id: string;
  a_id: string;
  a_text: string;
  a_tier: number;
  b_id: string;
  b_text: string;
  b_tier: number;
}

export async function chunkPairsSharingPerson(
  limit: number,
): Promise<ContradictionChunkPair[]>;
```

`contradictionScan()` remains:

```ts
export async function contradictionScan(limit?: number): Promise<number>;
```

The canonical review key remains:

```text
pair = "<lexicographically-smaller-chunk-uuid>:<lexicographically-larger-chunk-uuid>"
```

### Task 1: Prove the production-shape failure and literal-name contract

**Files:**
- Create: `test/h5-contradiction-scan.test.ts`
- Test: `src/pipeline/extract-edges.ts` symbol `extractAndLink()`
- Test: `src/search/index-parent.ts` symbol `indexParent()`

**Interfaces:**
- Consumes: `ensurePerson()`, `addAlias()`, `upsertPage()`, `indexParent()`, `chunkPairsSharingPerson()`, `contradictionScan()`
- Produces: red regression coverage for real parent-anchored edges and literal aliases

- [ ] **Step 1: Create complete fictional parent helpers**

Start `test/h5-contradiction-scan.test.ts` with:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  addAlias,
  chunkPairsSharingPerson,
  ensurePerson,
  upsertPage,
} from "../src/db/repo";
import { contradictionScan } from "../src/pipeline/dream";
import { indexParent } from "../src/search/index-parent";
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
```

- [ ] **Step 2: Add the production extractor and queue-idempotence test**

Add:

```ts
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
```

This uses the real `indexParent() -> extractAndLink()` path. Do not manually insert its mention edges.

- [ ] **Step 3: Add literal canonical-name and alias cases**

Add this complete test:

```ts
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
    expect(new Set([pairs[0]!.a_id, pairs[0]!.b_id])).toEqual(
      new Set(chunkIds.slice(0, 2)),
    );
    expect([pairs[0]!.a_id, pairs[0]!.b_id]).not.toContain(chunkIds[2]!);
  }

  const [blank] =
    await sql`insert into people (canonical_name, tier, source, created_by)
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
```

The direct whitespace-only row supplies every non-null provenance/tier field explicitly;
timestamps and remaining standard columns use schema defaults. The `literalNames` loop closes
before the blank-name fixture, and the test has exactly one final `});` closure; do not add an
extra brace or scope around either fixture.

- [ ] **Step 4: Run the focused red tests**

```bash
bun test test/h5-contradiction-scan.test.ts
```

Expected:

- production extractor test FAILS with `pairs` length 0 because current SQL requires `source_table='chunks'`;
- literal aliases also produce zero pairs under the current chunk-ID join;
- current hand-built legacy fixtures are not sufficient to make these tests pass.

- [ ] **Step 5: Commit the red tests**

```bash
git add test/h5-contradiction-scan.test.ts
git commit -m "test(dream): expose parent-shaped contradiction gap"
```

### Task 2: Implement parent-shaped pairing, deduplication, and derived exclusion

**Files:**
- Modify: `src/db/repo.ts` at `chunkPairsSharingPerson()`
- Modify: `test/h5-contradiction-scan.test.ts`
- Modify: `test/m13.provider-routing.test.ts` comment at the contradiction fixture

**Interfaces:**
- Consumes: H1 marker/path exports, parent-anchored `edges.src_type/src_id`, `chunks.parent_type/parent_id`
- Produces: `ContradictionChunkPair[]` in deterministic newest-first order after dedupe/limit

- [ ] **Step 1: Add composite-parent and same-parent tests**

Add:

```ts
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
    pairs.some((pair) =>
      [pair.a_id, pair.b_id].includes(pageOnly[0]!.id) &&
      [pair.a_id, pair.b_id].includes(pageOnly[1]!.id)),
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

  const pairs = (await chunkPairsSharingPerson(100)).filter(
    (pair) => pair.person_id === personId,
  );
  expect(pairs).toHaveLength(1);
  expect(new Set([pairs[0]!.a_id, pairs[0]!.b_id])).toEqual(new Set(taskChunks));
  const parentTypes = await sql`select distinct parent_type from chunks
    where id in (${pairs[0]!.a_id}, ${pairs[0]!.b_id})`;
  expect(parentTypes).toEqual([{ parent_type: "task" }]);
});
```

- [ ] **Step 2: Add compiled-parent and historical-edge tests**

Import H1's recognition contract:

```ts
import {
  COMPILED_NOTE_MARKER,
  compiledNoteIdentityFromPath,
  recognizeCompiledNote,
} from "../src/util/compiled-note-archive";
```

Then create:

```ts
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
      body:
        `${COMPILED_NOTE_MARKER}\n\n## Sources\n- ${sourceId}\n\n` +
        "Ione Mercer never grows thyme.\n",
    },
    {
      path: "derived/notes/person/ione-mercer.md",
      source: "brain-sync",
      body: `# Ione Mercer\n\n${COMPILED_NOTE_MARKER}\n\nIone Mercer never grows thyme.\n\n## Sources\n- ${sourceId}\n`,
    },
    {
      path: "imports/temporarily-misprovenanced.md",
      source: "brain-sync",
      body:
        `## Sources\r\n- ${sourceId}\r\n\r\n${COMPILED_NOTE_MARKER}\r\n\r\n` +
        "Ione Mercer never grows thyme.\r\n",
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
      body:
        `# Ione Mercer\n\n${COMPILED_NOTE_MARKER}\n\n` +
        "Ione Mercer never grows thyme.\n\n## Sources\n" +
        `<!-- temporary provenance note -->\n- ${sourceId}\n`,
    },
    {
      path: "imports/prose-before-source.md",
      source: "brain-sync",
      body:
        `# Ione Mercer\n\n${COMPILED_NOTE_MARKER}\n\n` +
        "Ione Mercer never grows thyme.\n\n## Sources\n" +
        `Source rows follow.\n- ${sourceId}\n`,
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
    shapes.map((shape) =>
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
  expect((await chunkPairsSharingPerson(100)).filter((pair) => pair.person_id === personId)).toEqual([]);
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
  expect((await chunkPairsSharingPerson(100)).filter((pair) => pair.person_id === personId)).toHaveLength(1);
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

  const lower = await indexedPage(lowercasePath, "Lowercase compiled", "Ione Mercer always grows thyme.");
  const upper = await indexedPage(uppercasePath, "Uppercase human path", "Ione Mercer never grows thyme.");
  const plain = await indexedPage("h5/ione-plain.md", "Plain", "Ione Mercer always grows thyme.");
  const chunks = await sql`select id, parent_id from chunks
    where parent_type = 'page' and parent_id in (${lower}, ${upper}, ${plain}) order by id`;
  const pairs = (await chunkPairsSharingPerson(100)).filter((pair) => pair.person_id === personId);
  expect(pairs).toHaveLength(1);
  expect(new Set([pairs[0]!.a_id, pairs[0]!.b_id])).toEqual(
    new Set([chunks.find((row) => row.parent_id === upper)!.id, chunks.find((row) => row.parent_id === plain)!.id]),
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
  const body =
    `# Orla Pine\n\n${COMPILED_NOTE_MARKER}\n\n` +
    `## Sources\n- ${primaryChunk!.id}\n\n` +
    "Intervening text.\n\n## Sources\nNo current source row.\n";
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
```

The last `false` in the recognition assertion is intentional:
`dream:decision-digest` is H5's separate derived-source exclusion, not a compiled-note
identity claimed by H1. The offset-zero marker/Sources row is inserted into `pages` and
queried through `chunkPairsSharingPerson()` in this same test, so it is an actual SQL-query
regression rather than a pure TypeScript recognizer assertion.

- [ ] **Step 3: Replace the repository query with the exact CTE pipeline**

Import the two H1 constants near the top of `src/db/repo.ts` from the neutral module:

```ts
import {
  COMPILED_NOTE_MARKER,
  COMPILED_NOTE_UUID_PATH_SQL_RE,
} from "../util/compiled-note-archive";
```

Add the named return interface and replace the current function body:

```ts
const COMPILED_NOTE_SOURCES_DELIMITER = "\n## Sources\n";
const COMPILED_NOTE_UUID_BULLET_SQL_RE =
  "(^|\n)- [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}($|\n)";

export interface ContradictionChunkPair {
  person_id: string;
  a_id: string;
  a_text: string;
  a_tier: number;
  b_id: string;
  b_text: string;
  b_tier: number;
}

export async function chunkPairsSharingPerson(
  limit: number,
): Promise<ContradictionChunkPair[]> {
  return (await sql`
    with normalized_pages as (
      select pg.id, pg.source, pg.path,
             E'\n' ||
               replace(replace(coalesce(pg.body_md, ''), E'\r\n', E'\n'), E'\r', E'\n')
               as normalized_body
      from pages pg
    ),
    page_shape_parts as (
      select np.*,
             string_to_array(
               np.normalized_body,
               ${COMPILED_NOTE_SOURCES_DELIMITER}
             ) as sources_parts
      from normalized_pages np
    ),
    excluded_page_parents as (
      select ps.id
      from page_shape_parts ps
      where ps.source in ('dream:notes', 'dream:decision-digest')
         or ps.path ~ ${COMPILED_NOTE_UUID_PATH_SQL_RE}
         or (
           strpos(
             ps.normalized_body || E'\n',
             E'\n' || ${COMPILED_NOTE_MARKER} || E'\n'
           ) > 0
           and cardinality(ps.sources_parts) > 1
           and ps.sources_parts[cardinality(ps.sources_parts)]
             ~ ${COMPILED_NOTE_UUID_BULLET_SQL_RE}
         )
    ),
    mention_chunks as (
      select distinct e.dst_id as person_id, e.src_type, e.src_id,
             c.id as chunk_id, c.text, c.tier, c.updated_at
      from edges e
      join people p on p.id = e.dst_id
      join chunks c on c.parent_type = e.src_type and c.parent_id = e.src_id
      where e.rel = 'mentions' and e.dst_type = 'person'
        and (
          c.parent_type <> 'page'
          or exists (
            select 1 from pages live_page
            where live_page.id = c.parent_id and live_page.status = 'active'
          )
        )
        and (
          (
            btrim(p.canonical_name) <> ''
            and strpos(lower(c.text), lower(p.canonical_name)) > 0
          )
          or exists (
            select 1 from person_aliases a
            where a.person_id = p.id
              and btrim(a.alias) <> ''
              and strpos(lower(c.text), lower(a.alias)) > 0
          )
        )
        and not (
          e.src_type = 'page' and exists (
            select 1 from excluded_page_parents excluded
            where excluded.id = e.src_id
          )
        )
    ),
    raw_pairs as (
      select x.person_id,
             case when x.chunk_id < y.chunk_id then x.chunk_id else y.chunk_id end as a_id,
             case when x.chunk_id < y.chunk_id then x.text else y.text end as a_text,
             case when x.chunk_id < y.chunk_id then x.tier else y.tier end as a_tier,
             case when x.chunk_id < y.chunk_id then y.chunk_id else x.chunk_id end as b_id,
             case when x.chunk_id < y.chunk_id then y.text else x.text end as b_text,
             case when x.chunk_id < y.chunk_id then y.tier else x.tier end as b_tier,
             greatest(x.updated_at, y.updated_at) as newest_at
      from mention_chunks x
      join mention_chunks y on y.person_id = x.person_id
       and (
         x.src_type < y.src_type
         or (x.src_type = y.src_type and x.src_id < y.src_id)
       )
    ),
    deduplicated as (
      select distinct on (person_id, a_id, b_id)
             person_id, a_id, a_text, a_tier, b_id, b_text, b_tier, newest_at
      from raw_pairs
      order by person_id, a_id, b_id, newest_at desc
    )
    select person_id, a_id, a_text, a_tier, b_id, b_text, b_tier
    from deduplicated
    order by newest_at desc, a_id asc, b_id asc, person_id asc
    limit ${limit}`) as unknown as ContradictionChunkPair[];
}
```

The `source_table/source_id` columns are deliberately absent from joins. Name matching is
exclusively literal `strpos`; path recognition uses H1's anchored regex. All marker,
delimiter, path-regex, bullet-regex, and limit values are parameters. Prefixing one LF makes
an exact heading at body offset zero use the same delimiter as a later heading.
There is exactly one parameterized UUID-bullet regex predicate, applied to the final
`sources_parts` suffix; do not add a duplicate bare `body ~ ...` predicate or a second copy
of the UUID-bullet expression. The offset-zero fixture above is the actual-query proof for
this single predicate.
`string_to_array(...)[cardinality(...)]` selects only the suffix after the final normalized
exact `## Sources` heading; the UUID regex then finds an exact canonical bullet anywhere in
that suffix. Thus blank/comment/prose lines before a bullet are accepted, while a bullet
beneath an earlier heading cannot recognize a final heading without one. No SQL module
imports a pipeline module, and the H1 constants remain in the neutral pure utility.

- [ ] **Step 4: Update both stale chunk-source comments without changing behavior**

In `src/db/repo.ts`, replace the stale comment immediately above `NoteCandidate` that says
the entity-link pass anchors mentions at chunks. Use:

```ts
// System-job reads (like chunkPairsSharingPerson): chunk text stays on-box and the resulting
// note page carries the inherited tier, so agent reads are tier-gated at the page. No
// allowedTier predicate here — the dream job is not an agent context. Production mention
// edges are parent-anchored at (src_type, src_id); noteSourceChunks() resolves the chunks
// through that typed parent and ignores historical source_table/source_id metadata.
```

In `test/m13.provider-routing.test.ts`, change the comment above the legacy edge insert to:

```ts
// Historical chunk-anchored source metadata remains accepted: H5 resolves the canonical
// parent from src_type/src_id and deliberately ignores source_table/source_id.
```

Keep `source_table='chunks', source_id=chunk.id` so this existing test remains the compatibility proof.

- [ ] **Step 5: Run the query and routing tests green**

```bash
bun test test/h5-contradiction-scan.test.ts test/m13.provider-routing.test.ts
```

Expected: PASS. The production pair is found, historical metadata still works, compiled pages produce no pairs, and W3 tier-2 local routing remains green.

- [ ] **Step 6: Commit the pairing implementation**

```bash
git add src/db/repo.ts test/h5-contradiction-scan.test.ts test/m13.provider-routing.test.ts
git commit -m "fix(dream): pair contradictions by source parent"
```

### Task 3: Deterministic limit, tier routing, and regression closure

**Files:**
- Modify: `test/h5-contradiction-scan.test.ts`
- Test: `src/pipeline/dream.ts` symbol `contradictionScan()`

**Interfaces:**
- Consumes: deterministic query order and unchanged max-tier scan
- Produces: proof that limit follows dedupe/order and review payloads remain IDs-only

- [ ] **Step 1: Add a complete deterministic ordering/limit test**

Add:

```ts
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

  const all = await chunkPairsSharingPerson(100);
  expect(all.slice(0, 3).map((pair) => [pair.a_id, pair.b_id])).toEqual(
    ordered.map((item) => [item.a, item.b]),
  );
  expect(all.slice(3).map((pair) => pair.person_id)).toEqual(
    sharedPeople.map((person) => person.id),
  );
  expect(await chunkPairsSharingPerson(2)).toEqual(all.slice(0, 2));
});
```

This proves duplicate edges do not consume the limit and the timestamp tie is broken by `a_id`, `b_id`, then `person_id`.

- [ ] **Step 2: Add max-tier and IDs-only scan assertions**

Add:

```ts
test("scan routes by maximum pair tier and queues IDs only", async () => {
  const { id: personId } = await ensurePerson("Elian Moss", "test:h5");
  await indexedPage("h5/elian-a.md", "Elian A", "Elian Moss always visits the pier.", 1);
  await indexedPage("h5/elian-b.md", "Elian B", "Elian Moss never visits the pier.", 2);
  const [pair] = (await chunkPairsSharingPerson(100)).filter(
    (candidate) => candidate.person_id === personId,
  );
  expect(pair).toBeDefined();
  expect(Math.max(pair!.a_tier, pair!.b_tier)).toBe(2);

  const flagged = await contradictionScan(100);
  expect(flagged).toBe(1);
  const [queue] =
    await sql`select payload from review_queue
      where kind = 'contradiction' and payload ->> 'person_id' = ${personId}`;
  expect(queue!.payload.chunk_ids).toEqual([pair!.a_id, pair!.b_id]);
  expect(Object.keys(queue!.payload).sort()).toEqual(["chunk_ids", "pair", "person_id"]);
  expect(JSON.stringify(queue!.payload)).not.toContain("always");
  expect(JSON.stringify(queue!.payload)).not.toContain("never");
});
```

The existing `test/m13.provider-routing.test.ts` remains the non-mock proof that this maximum tier selects the tier-2 route.

- [ ] **Step 3: Run all contradiction-adjacent tests**

```bash
bun test test/h5-contradiction-scan.test.ts test/m13.provider-routing.test.ts test/m9.notes.test.ts test/decision-digest.test.ts
```

Expected: PASS. H1 compiled-note tests and decision-digest tests remain green because derived summaries are excluded only as contradiction evidence.

- [ ] **Step 4: Commit the deterministic regression unit**

```bash
git add test/h5-contradiction-scan.test.ts
git commit -m "test(dream): lock contradiction pair ordering"
```

### Task 4: Decision record, subsystem inventory, and branch gate

**Files:**
- Modify: `DECISIONS.md`
- Modify: `docs/SUBSYSTEMS.md`
- Inspect: `src/pipeline/dream.ts`

**Interfaces:**
- Produces: documented H5 semantics without adding a subsystem

- [ ] **Step 1: Verify the scan implementation itself did not drift**

Inspect `contradictionScan()` and prove its loop still:

```text
tier = max(a_tier, b_tier), collapsed to 1|2
cloud-over-ceiling pair skipped under the legacy fallback
open review pair checked before the model
mock ANTONYMS unchanged
payload contains pair/person_id/chunk_ids only
flagged count increments only after insert
```

If comments still claim chunk-anchored edges, change only those comments to parent-shaped wording. Do not alter control flow.

- [ ] **Step 2: Append the H5 decision**

Append:

```markdown
## 2026-07-23 — H5: production parent contradiction pairing

- **Context:** The contradiction query required mention edges whose source metadata pointed
  at chunk IDs, while the production extractor anchors mentions at typed parent rows. The
  nightly scan therefore missed production evidence.
- **Decision:** Resolve mention edges through `(src_type, src_id)` to parent chunks; require
  distinct composite parents; retain chunks containing a nonblank canonical name or alias
  via case-folded literal `strpos`; canonicalize and deduplicate chunk pairs before the
  deterministic newest-first limit. Exclude compiled notes/digests by provenance,
  UUID-suffixed path, or the legacy system marker plus a canonical UUID bullet anywhere
  beneath the final normalized exact Sources heading, including temporary `brain-sync`
  provenance. Historical chunk-source metadata remains tolerated but is not trusted for
  joining.
- **Why:** Contradictions must compare independent primary captures, not two chunks of one
  row or a derived summary against its own source; literal matching keeps punctuation and
  CJK aliases from becoming SQL wildcards.
- **Validated by:** real `extractAndLink()` parent-edge tests, literal alias corpus,
  derived-parent exclusions, final-Sources parity fixtures with intervening text and an
  earlier-heading decoy, composite-parent collision, deterministic post-dedupe limit, tier
  routing, and full project gate.
- **Approved by:** owner-approved pre-W5 hardening design (2026-07-23).
```

- [ ] **Step 3: Update only the Dream job subsystem row**

In `docs/SUBSYSTEMS.md`, append the H5 decision heading to the Dream job Maintenance field and add “production-shaped contradiction pair suite” to its eval text. Do not add a subsystem row: this fixes the existing dream step.

- [ ] **Step 4: Run targeted and complete gates**

```bash
bun test test/h5-contradiction-scan.test.ts test/m13.provider-routing.test.ts test/m9.notes.test.ts test/decision-digest.test.ts
bun test
bunx tsc --noEmit
bunx biome check .
git diff --check
make check-subsystems
make verify
```

Expected: all commands exit 0, Biome makes no changes, and offline MinimeBench floors remain green.

- [ ] **Step 5: Commit documentation**

```bash
git add DECISIONS.md docs/SUBSYSTEMS.md src/pipeline/dream.ts
git commit -m "docs: record production contradiction pairing"
```

If `src/pipeline/dream.ts` required no comment change, omit it from `git add`.

### Task 5: Branch review and integrated handoff

**Files:**
- Review: every H5 branch change
- Do not modify: approved design, H1 recovery logic, H4 gateway logic, owner data

**Interfaces:**
- Produces: final hardening branch SHA ready for five-branch integrated acceptance

- [ ] **Step 1: Capture branch evidence**

```bash
test -n "${WORKTREE_PATH:?set the pinned H5 worktree path}"
test -n "${START_SHA:?recorded when the H5 worktree was created}"
test "$START_SHA" = "$H4_MERGE_SHA"
git -C "$WORKTREE_PATH" status --short
git -C "$WORKTREE_PATH" log --oneline --decorate -5
git -C "$WORKTREE_PATH" diff "$START_SHA"...HEAD --stat
git -C "$WORKTREE_PATH" diff "$START_SHA"...HEAD --check
```

Expected: only H5-owned files changed, focused commits are present, and diff check is silent.

- [ ] **Step 2: Run advisory review**

Assign a fresh `first_pass_reviewer_luna` to compare the branch with H5 of the approved
design. Require explicit findings on SQL containment, literal matching, composite-parent
identity, compiled-summary exclusion, parity with H1's final-Sources-suffix recognizer,
parameterization/cycle freedom, dedupe-before-limit, tier routing, queue payloads, and
fixture privacy.

Expected: no unresolved Critical or Important finding.

- [ ] **Step 3: Adjudicate only a disputed Luna Critical**

If required, send the exact disputed Critical and evidence to a fresh `critical_adjudicator_sol`. Apply the result, rerun the targeted/full gates, and return changed code to Luna.

- [ ] **Step 4: Obtain binding branch review**

Assign a fresh `final_reviewer_sol` to the final diff and acceptance evidence generated from
the immutable baseline only:

```bash
git -C "$WORKTREE_PATH" diff "$START_SHA"...HEAD --stat
git -C "$WORKTREE_PATH" diff "$START_SHA"...HEAD --check
git -C "$WORKTREE_PATH" diff "$START_SHA"...HEAD
```

Do not substitute a branch name or an implicit working-tree diff, and keep any review packet
in the pinned ignored worktree or an OS temporary directory outside owner trees.

Expected: explicit binding `PASS`. Stop on `BLOCK`; do not declare pre-W5 hardening complete.

- [ ] **Step 5: Run the integrated five-branch gate after merge**

From the named tranche-base worktree:

```bash
test "$(git -C "$TRANCHE_WORKTREE_PATH" rev-parse HEAD)" = "$H5_MERGE_SHA"
(
  cd "$TRANCHE_WORKTREE_PATH"
  bun test
  bunx tsc --noEmit
  bunx biome check .
  git diff --check
  make check-subsystems
  make verify
)
```

Expected: all exit 0. Then obtain the fresh integrated `final_reviewer_sol` PASS required by the tranche index. W5 design remains blocked until that PASS is recorded.
