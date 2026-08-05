# H5 Tier-Floor and Recognizer-Parity Amendment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent every tier-0 contradiction evidence path from entering model work and make H5's SQL compiled-note exclusion match H1's case-insensitive UUID-bullet and exact marker-line recognition.

**Architecture:** Keep `contradictionScan()` and its public repository contract unchanged. Strengthen the existing `chunkPairsSharingPerson()` CTE with a static, exhaustive canonical-parent tier projection and four minimum-tier predicates before pairing; then replace only the two divergent SQL recognizer predicates with H1-equivalent semantics.

**Tech Stack:** Bun/TypeScript, PostgreSQL 16, postgres.js parameterized SQL, Bun test, Biome.

## Global Constraints

- Work only in
  `<ABS_REPO_PATH>/.claude/worktrees/hardening-contradiction-scan`.
- The immutable production baseline is exactly
  `6a7877325845ac1d19e3c5bd6924866c90cb5320`.
- The branch is exactly `codex/hardening-contradiction-scan`.
- The amendment documentation commit must be the direct child of the immutable production
  baseline. Record that documentation commit as `AMENDMENT_SHA` before implementation.
- Correction implementation may modify exactly `src/db/repo.ts`,
  `test/h5-contradiction-scan.test.ts`, and `test/m13.provider-routing.test.ts`.
- `src/pipeline/dream.ts`, `src/util/compiled-note-archive.ts`, and
  `test/h1-note-archive.test.ts` are inspection-only.
- Do not modify the original H5 design, original H5 plan, tranche index, `DECISIONS.md`,
  `docs/SUBSYSTEMS.md`, production outside `src/db/repo.ts`, dependencies, `package.json`,
  `bun.lock`, migrations, generated scorecards, `.env*`, `data/`, `db-dump/`, or owner files.
- Preserve the pre-existing untracked
  `docs/benchmarks/2026-07-26-mock-minimebench.md`.
- Keep public interfaces, `ContradictionChunkPair`, `chunkPairsSharingPerson(limit)`, and
  `contradictionScan(limit?)` source-compatible.
- Do not change `src/pipeline/dream.ts`, model prompts, provider selection, queue payloads, or
  scan control flow.
- Add no migration, dependency, provider, subsystem, tool schema, repair, or W5 work.
- Plain application SQL remains only in `src/db/repo.ts`; every marker, regex, and limit
  remains parameterized.
- Resolve and authorize source parents only through a static
  `canonical_parent_tiers(parent_type,parent_id,parent_tier)` CTE joined by
  `e.src_type/e.src_id`.
- The static CTE maps every current `ParentType`: `page/pages`,
  `journal/journal_entries`, `interaction/interactions`, `decision/decisions`,
  `decision_branch/decision_branches`, `task/tasks`, `goal/goals`,
  `value/values_items`, `principle/principles`, `person/people`, `org/orgs`, and
  `commitment/commitments`.
- Unknown parent types and known types with no canonical parent row are excluded by the
  inner join.
- Require all four floors: `e.tier >= 1`, `p.tier >= 1`, `c.tier >= 1`, and
  `cp.parent_tier >= 1`.
- Never authorize or resolve contradiction evidence through `source_table/source_id` or
  `edge_source_tier()`.
- Preserve H1's final exact `## Sources` suffix rule. Match the UUID-bullet regex with `~*`
  and recognize the marker only by equality to an element of
  `string_to_array(normalized_body, E'\n')`.
- The exact marker line must work at body start, middle, and EOF. Marker lookalikes remain
  excluded from compiled-note recognition.
- The RED phase must produce exactly three contract failures: four-way tier floor,
  uppercase UUID bullet, and the routing test's counts-only four-floor preflight. The
  tier-1 positive and marker-at-EOF characterization tests must already pass.
- Every fixture is fictional. Tier-0 sentinel prose may be seeded only as disposable
  test-database content and must never reach a model fixture, provider body, egress event,
  queue payload, test failure, ledger, review packet, report, or log. The routing RED must
  expose only four integer pair counts: it asserts `[0, 0, 0, 0]` before setting
  model/provider configuration, calling `patchFetch()`, or invoking `contradictionScan()`.
- Two consecutive failed gate/review cycles stop for the owner. A binding Sol `BLOCK` or an
  upheld Critical stops the current cycle immediately.
- Original H5 Task 4 remains the only owner of the later `DECISIONS.md` and
  `docs/SUBSYSTEMS.md` updates.

---

## Authorized file map

| File | Action | Responsibility |
|---|---|---|
| `test/h5-contradiction-scan.test.ts` | Modify | tier-1 characterization, four evidence floors, unknown/orphan parents, uppercase UUID bullet, marker-at-EOF parity |
| `test/m13.provider-routing.test.ts` | Modify | counts-only preflight before any provider setup, followed only after that passes by a real non-mock loopback proof for the positive pair |
| `src/db/repo.ts` | Modify | exhaustive canonical-parent CTE, four tier floors, H1-equivalent SQL recognizer predicates |
| `src/pipeline/dream.ts` | Inspect only | confirm unchanged pair consumption, provider selection, egress path, dedupe, and IDs-only queue payload |
| `src/util/compiled-note-archive.ts` | Inspect only | authoritative H1 marker, path, UUID case-folding, and exact-line behavior |
| `test/h1-note-archive.test.ts` | Inspect/run only | adjacent H1 parity contract |

No task may add another tracked path.

## Exact interfaces

The correction consumes the existing H1 exports without changing them:

```ts
export const COMPILED_NOTE_MARKER: string;
export const COMPILED_NOTE_UUID_PATH_SQL_RE: string;

export function recognizeCompiledNote(page: {
  path: string;
  source?: string | null;
  bodyMd: string;
}):
  | { recognized: false }
  | {
      recognized: true;
      reason: "source" | "uuid_path" | "system_shape";
      pathIdentity: { kind: "person" | "org"; entityId: string } | null;
      sourceIds: string[];
    };
```

The repository interface remains exactly:

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

The dream interface remains exactly:

```ts
export async function contradictionScan(limit?: number): Promise<number>;
```

The queue payload remains:

```ts
{
  pair: `${pair.a_id}:${pair.b_id}`,
  person_id: pair.person_id,
  chunk_ids: [pair.a_id, pair.b_id],
}
```

### Task 1: Freeze the Baseline and Add the Exact RED/Characterization Contract

**Files:**
- Modify: `test/h5-contradiction-scan.test.ts`
- Modify: `test/m13.provider-routing.test.ts`
- Inspect: `src/pipeline/dream.ts`
- Inspect: `src/util/compiled-note-archive.ts`
- Inspect: `test/h1-note-archive.test.ts`

**Interfaces:**
- Consumes: existing `parentMentionEdge()`, `chunkPairsSharingPerson()`,
  `contradictionScan()`, `patchFetch()`, H1 recognition exports, and test database helpers
- Produces: two passing characterization tests and three failing contract tests at the
  immutable production baseline; the routing failure is a counts-only repository preflight
  that occurs before any provider configuration, fetch patch, scan, egress, or queue work

- [ ] **Step 1: Prove the exact starting state**

Run:

```bash
BASELINE=6a7877325845ac1d19e3c5bd6924866c90cb5320
test "$(git branch --show-current)" = "codex/hardening-contradiction-scan"
test "$(git rev-parse "$BASELINE")" = "$BASELINE"
AMENDMENT_SHA="$(git rev-parse HEAD)"
test "$(git rev-parse "$AMENDMENT_SHA^")" = "$BASELINE"
git merge-base --is-ancestor "$BASELINE" "$AMENDMENT_SHA"
git status --short --untracked-files=all
```

Expected: every command exits 0. Status contains only the preserved untracked benchmark.
Record `BASELINE` and `AMENDMENT_SHA` in the ignored execution ledger. Stop if the branch,
ancestry, direct-parent relation, or worktree state differs.

- [ ] **Step 2: Add one reusable H5 evidence fixture**

In `test/h5-contradiction-scan.test.ts`, add after `parentMentionEdge()`:

```ts
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
    const text =
      `${canonicalName} ${side === 0 ? "always" : "never"} checks the harbor bell.`;
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
    const text =
      `${canonicalName} ${side === 0 ? "always" : "never"} checks the tide chart.`;
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
```

The unknown `source_table` is deliberate: the trigger produces its legacy default tier 1,
then the edge-arm fixture explicitly lowers only the accepted edge. This isolates the four
evidence surfaces and does not use `source_table/source_id` as authorization.

- [ ] **Step 3: Add and run the tier-1 characterization**

Add:

```ts
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
  expect(new Set([pairs[0]!.a_id, pairs[0]!.b_id])).toEqual(
    new Set(fixture.chunkIds),
  );
});
```

Run:

```bash
bun test test/h5-contradiction-scan.test.ts \
  -t "H5 amendment characterization: four tier-one evidence surfaces remain eligible"
```

Expected at baseline: PASS. Stop if it fails; the correction must not proceed on a broken
positive path.

- [ ] **Step 4: Add and run the marker-at-EOF characterization**

Add:

```ts
test("H5 amendment characterization: exact marker line at EOF is compiled evidence", async () => {
  const { id: personId } = await ensurePerson("Mina Harbor", "test:h5-amendment");
  const primary = await indexedPage(
    "h5/amendment-marker-primary.md",
    "Marker primary",
    "Mina Harbor always records the north buoy.",
  );
  const [primaryChunk] = await sql`
    select id from chunks where parent_type = 'page' and parent_id = ${primary}`;
  const body =
    `## Sources\n- ${primaryChunk!.id}\n\n` +
    "Mina Harbor never records the north buoy.\n\n" +
    COMPILED_NOTE_MARKER;
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
```

Run:

```bash
bun test test/h5-contradiction-scan.test.ts \
  -t "H5 amendment characterization: exact marker line at EOF is compiled evidence"
```

Expected at baseline: PASS. This locks in EOF behavior while the implementation replaces the
predicate with exact H1 line equality.

- [ ] **Step 5: Add the four-floor plus unknown/orphan RED test**

Add:

```ts
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
```

Run:

```bash
bun test test/h5-contradiction-scan.test.ts \
  -t "H5 amendment RED: tier-zero and unresolved canonical-parent evidence cannot pair"
```

Expected at baseline: FAIL with nonzero counts. The query currently lacks all four floors and
the canonical-parent join. Setup, import, migration, or syntax failure is invalid RED
evidence.

- [ ] **Step 6: Add the uppercase-UUID RED test**

Add:

```ts
test("H5 amendment RED: uppercase canonical UUID bullets are compiled evidence", async () => {
  const { id: personId } = await ensurePerson("Uma Cypress", "test:h5-amendment");
  const primary = await indexedPage(
    "h5/amendment-uppercase-primary.md",
    "Uppercase primary",
    "Uma Cypress always carries the brass compass.",
  );
  const [primaryChunk] = await sql`
    select id from chunks where parent_type = 'page' and parent_id = ${primary}`;
  const body =
    `${COMPILED_NOTE_MARKER}\n\n` +
    "Uma Cypress never carries the brass compass.\n\n" +
    `## Sources\n- ${primaryChunk!.id.toUpperCase()}`;
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
```

Run:

```bash
bun test test/h5-contradiction-scan.test.ts \
  -t "H5 amendment RED: uppercase canonical UUID bullets are compiled evidence"
```

Expected at baseline: FAIL because H1 recognizes the uppercase bullet but H5's lowercase-only
SQL admits the derived chunk into a pair.

- [ ] **Step 7: Add the counts-only routing RED with post-fix non-mock proof**

In `test/m13.provider-routing.test.ts`, add the repository query import:

```ts
import { chunkPairsSharingPerson } from "../src/db/repo";
```

Then add this local helper before the contradiction-scan describe block:

```ts
type H5RoutingFloorArm = "edge" | "person" | "chunk" | "parent";

async function h5RoutingPair(
  label: string,
  zeroArm?: H5RoutingFloorArm,
): Promise<{ personId: string }> {
  const canonicalName = `H5 Route ${label}`;
  const sentinel = zeroArm ? `H5-TIER0-${label.toUpperCase()}-SENTINEL` : "";
  const [person] = await testSql`
    insert into people (canonical_name, tier, source, created_by)
    values (
      ${canonicalName},
      ${zeroArm === "person" ? 0 : 1},
      'test:h5-amendment',
      'test:h5-amendment'
    )
    returning id`;
  for (const side of [0, 1] as const) {
    const parentId = crypto.randomUUID();
    const text =
      `${canonicalName}${sentinel ? ` ${sentinel}` : ""} ${
        side === 0 ? "always" : "never"
      } rings at noon.`;
    await testSql`
      insert into pages
        (id, path, title, body_md, content_hash, tier, source)
      values (
        ${parentId},
        ${`h5-routing/${label.toLowerCase()}-${side}.md`},
        ${canonicalName},
        ${text},
        ${`h5-routing-${label}-${side}`},
        ${zeroArm === "parent" && side === 0 ? 0 : 1},
        'test:h5-amendment'
      )`;
    const [chunk] = await testSql`
      insert into chunks (parent_type, parent_id, ord, text, tier)
      values (
        'page',
        ${parentId},
        0,
        ${text},
        ${zeroArm === "chunk" && side === 0 ? 0 : 1}
      )
      returning id`;
    const [edge] = await testSql`
      insert into edges
        (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
      values (
        'page',
        ${parentId},
        'mentions',
        'person',
        ${person!.id},
        'h5_amendment_fixture',
        ${chunk!.id},
        'system:extract'
      )
      returning id`;
    if (zeroArm === "edge" && side === 0) {
      await testSql`update edges set tier = 0 where id = ${edge!.id}`;
    }
  }
  return { personId: person!.id };
}
```

Then add:

```ts
test("H5 amendment RED: tier-zero pairs reach no provider, egress event, or review item", async () => {
  await resetDb();
  const positive = await h5RoutingPair("Positive");
  const blocked = await Promise.all(
    (["edge", "person", "chunk", "parent"] as const).map((arm) =>
      h5RoutingPair(arm, arm),
    ),
  );

  // This is the fail-closed RED boundary. Keep only content-free counts and assert them
  // before mutating model/provider config, installing a fetch fixture, or scanning.
  const candidatePairs = await chunkPairsSharingPerson(100);
  const blockedPairCounts = blocked.map(
    (fixture) =>
      candidatePairs.filter((pair) => pair.person_id === fixture.personId).length,
  );
  expect(blockedPairCounts).toEqual([0, 0, 0, 0]);

  // The remaining assertions execute only after corrected production passes the preflight.
  config.mockOllama = false;
  config.classifyProvider = "openrouter";
  config.openrouterApiKey = "test-key";
  config.cloudMaxTier = 1;
  config.providerRouteTier1 = "ollama";
  config.providerRouteTier2 = "ollama";
  const patched = await patchFetch(() => ({ response: '{"conflict":true}' }));
  try {
    expect(await contradictionScan(100)).toBe(1);
    expect(patched.cloudCalls).toEqual([]);
    expect(patched.localRequests).toHaveLength(1);
    expect(patched.localRequests[0]!.path).toBe("/api/generate");
    expect(patched.localRequests[0]!.body).toContain("H5 Route Positive");
    expect(patched.localRequests[0]!.body).not.toContain("SENTINEL");
    const [egress] = await testSql`
      select count(*)::int as n from events where verb like 'egress:%'`;
    expect(egress!.n).toBe(0);
    const queue = await testSql`
      select payload from review_queue where kind = 'contradiction' order by id`;
    expect(queue).toHaveLength(1);
    expect(queue[0]!.payload.person_id).toBe(positive.personId);
    expect(Object.keys(queue[0]!.payload).sort()).toEqual([
      "chunk_ids",
      "pair",
      "person_id",
    ]);
    expect(JSON.stringify(queue[0]!.payload)).not.toContain("SENTINEL");
  } finally {
    await patched.restore();
  }
});
```

Run:

```bash
bun test test/m13.provider-routing.test.ts \
  -t "H5 amendment RED: tier-zero pairs reach no provider, egress event, or review item"
```

Expected at baseline: FAIL only at the preflight assertion. The received value is the
content-free integer count vector `[1, 1, 1, 1]`; the expected value is `[0, 0, 0, 0]`.
Because this assertion precedes every configuration assignment, `patchFetch()`, and
`contradictionScan()`, the defective baseline sends no blocked prose, sentinel, or ID to a
provider, event, queue, test failure, ledger, report, or log. A failure after provider
configuration, a provider request, a review insertion, an egress event, or any network,
server, setup, provider-construction, import, migration, or syntax failure is invalid RED
evidence.

The positive fixture deliberately has no sentinel. Each blocked fixture has a unique
sentinel only in its disposable tier-0 database prose, so the post-fix generic
`not.toContain("SENTINEL")` assertions prove that no blocked sentinel reached either the
single provider body or the IDs-only queue.

- [ ] **Step 8: Capture the exact combined RED ledger**

Run:

```bash
bun test test/h5-contradiction-scan.test.ts test/m13.provider-routing.test.ts \
  -t "H5 amendment"
```

Expected: exactly two characterization tests PASS and exactly three contract tests FAIL:

```text
PASS four tier-one evidence surfaces remain eligible
PASS exact marker line at EOF is compiled evidence
FAIL tier-zero and unresolved canonical-parent evidence cannot pair
FAIL uppercase canonical UUID bullets are compiled evidence
FAIL tier-zero pairs reach no provider, egress event, or review item
     counts-only preflight: expected [0,0,0,0], received [1,1,1,1]
```

The third failure must occur before model/provider configuration, `patchFetch()`, and
`contradictionScan()`; its diagnostic may contain only the two integer vectors above.
Stop if the pass/fail partition or failure location differs, or if tier-0 prose, sentinels,
or IDs appear in any test output, log, ledger, report, provider, event, or queue.

- [ ] **Step 9: Commit the exact test contract**

```bash
git add test/h5-contradiction-scan.test.ts test/m13.provider-routing.test.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "test(dream): expose H5 evidence authorization gaps"
```

Expected staged names are exactly the two test files. Do not stage the benchmark.

### Task 2: Enforce Canonical Parent and Tier Floors in the Repository Query

**Files:**
- Modify: `src/db/repo.ts`
- Test: `test/h5-contradiction-scan.test.ts`
- Test: `test/m13.provider-routing.test.ts`
- Inspect only: `src/pipeline/dream.ts`
- Inspect only: `src/util/compiled-note-archive.ts`

**Interfaces:**
- Consumes: `edges.src_type/src_id`, `chunks.parent_type/parent_id`, every current
  `ParentType` table, H1's marker and path constants
- Produces: the unchanged `ContradictionChunkPair[]`, with tier-zero and unresolved parents
  removed before pairing and SQL recognizer parity restored

- [ ] **Step 1: Add the exhaustive static parent CTE**

In `chunkPairsSharingPerson()` in `src/db/repo.ts`, make the first CTE exactly:

```sql
with canonical_parent_tiers(parent_type, parent_id, parent_tier) as (
  select 'page'::text, id, tier from pages
  union all
  select 'journal', id, tier from journal_entries
  union all
  select 'interaction', id, tier from interactions
  union all
  select 'decision', id, tier from decisions
  union all
  select 'decision_branch', id, tier from decision_branches
  union all
  select 'task', id, tier from tasks
  union all
  select 'goal', id, tier from goals
  union all
  select 'value', id, tier from values_items
  union all
  select 'principle', id, tier from principles
  union all
  select 'person', id, tier from people
  union all
  select 'org', id, tier from orgs
  union all
  select 'commitment', id, tier from commitments
),
normalized_pages as (
```

Do not generate table names dynamically. Do not copy `COMPILED_PARENT_TIER`, call
`parentTable()`, or call `edge_source_tier()`. The literal list above must remain visibly
comparable with the `ParentType`/`PARENTS` map at the top of `src/db/repo.ts`.

- [ ] **Step 2: Join the canonical parent and add all four floors**

In `mention_chunks`, keep the existing `people` and `chunks` joins and add:

```sql
join canonical_parent_tiers cp
  on cp.parent_type = e.src_type and cp.parent_id = e.src_id
```

Add these predicates next to the existing relation/destination predicates:

```sql
and e.tier >= 1
and p.tier >= 1
and c.tier >= 1
and cp.parent_tier >= 1
```

The relevant query fragment must read:

```sql
from edges e
join people p on p.id = e.dst_id
join chunks c on c.parent_type = e.src_type and c.parent_id = e.src_id
join canonical_parent_tiers cp
  on cp.parent_type = e.src_type and cp.parent_id = e.src_id
where e.rel = 'mentions' and e.dst_type = 'person'
  and e.tier >= 1
  and p.tier >= 1
  and c.tier >= 1
  and cp.parent_tier >= 1
```

Do not add `source_table`, `source_id`, or `edge_source_tier()` anywhere in this query.
Preserve the existing active-page, literal-name/alias, compiled-page, composite-parent,
canonicalization, deduplication, ordering, and limit clauses byte-for-byte except for
formatting required around these insertions.

- [ ] **Step 3: Make the marker predicate exact-line H1 parity**

In `excluded_page_parents`, replace only the current `strpos()` marker expression with:

```sql
${COMPILED_NOTE_MARKER} =
  any(string_to_array(ps.normalized_body, E'\n'))
```

The complete system-shape arm becomes:

```sql
or (
  ${COMPILED_NOTE_MARKER} =
    any(string_to_array(ps.normalized_body, E'\n'))
  and cardinality(ps.sources_parts) > 1
  and ps.sources_parts[cardinality(ps.sources_parts)]
    ~* ${COMPILED_NOTE_UUID_BULLET_SQL_RE}
)
```

Do not trim, case-fold, substring-match, or regex-match the marker. The current leading LF
used by `normalized_pages` is harmless: it creates an empty first array element and preserves
exact body-start, middle, and EOF lines.

- [ ] **Step 4: Make the UUID-bullet predicate case-insensitive**

Use PostgreSQL `~*`, as shown in Step 3. Keep
`COMPILED_NOTE_UUID_BULLET_SQL_RE` itself parameterized and otherwise unchanged. Do not make
the path regex case-insensitive: H1's canonical compiled-note path remains lowercase-only.

- [ ] **Step 5: Run the five amendment tests GREEN**

```bash
bun test test/h5-contradiction-scan.test.ts test/m13.provider-routing.test.ts \
  -t "H5 amendment"
```

Expected: five PASS, zero FAIL. The non-mock test has one loopback `/api/generate` request,
zero cloud calls, zero `egress:*` rows, and one IDs-only positive review item. Its
counts-only preflight is `[0, 0, 0, 0]` before any provider configuration, fetch patch, or
scan call, and neither the provider body nor queue contains `SENTINEL`.

- [ ] **Step 6: Run the complete focused correction suite**

```bash
bun test test/h5-contradiction-scan.test.ts test/m13.provider-routing.test.ts
```

Expected: PASS. Existing production-edge, literal-name, active-page, composite-parent,
compiled-source/path/shape, legacy metadata, H1 final-Sources, and W3 route behavior remain
green.

- [ ] **Step 7: Inspect the unchanged dream boundary**

Read `contradictionScan()` and record exact evidence that it still:

```text
loads only chunkPairsSharingPerson(limit)
collapses max(a_tier,b_tier) to route tier 1|2
applies the existing cloud-ceiling guard
deduplicates by canonical pair before model work
invokes the existing claimsConflict prompt
writes only pair, person_id, and chunk_ids to review_queue
increments flagged only after insertReviewItem
```

If any production change outside `src/db/repo.ts` appears necessary, stop for the owner.

- [ ] **Step 8: Commit the minimal production correction**

```bash
git add src/db/repo.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "fix(dream): enforce H5 contradiction evidence floors"
```

Expected staged name: exactly `src/db/repo.ts`.

### Task 3: Run Adjacent and Full Acceptance Gates

**Files:**
- Test only: all repository files
- Do not modify: any path outside the authorized three-file correction scope

**Interfaces:**
- Consumes: Task 2 correction commit
- Produces: focused, adjacent, full, scope, and immutable dependency evidence for review

- [ ] **Step 1: Run the exact focused gate**

```bash
bun test test/h5-contradiction-scan.test.ts test/m13.provider-routing.test.ts
```

Expected: exit 0.

- [ ] **Step 2: Run the exact adjacent gate**

```bash
bun test \
  test/h5-contradiction-scan.test.ts \
  test/m13.provider-routing.test.ts \
  test/h1-note-archive.test.ts \
  test/m9.notes.test.ts \
  test/decision-digest.test.ts
```

Expected: exit 0. `test/h1-note-archive.test.ts` is run but not modified.

- [ ] **Step 3: Run the complete project gate**

Run in this order:

```bash
bun test
bunx tsc --noEmit
bunx biome check .
git diff --check
make check-subsystems
make verify
```

Expected: every command exits 0; Biome makes no changes; offline MinimeBench floors hold.
Do not stage or remove the generated untracked benchmark.

- [ ] **Step 4: Prove immutable dependency and correction scope**

With the `BASELINE` and `AMENDMENT_SHA` recorded in Task 1, run:

```bash
test "$(git hash-object package.json)" = "1bebc8b0f4bc942684d157f60f9fe9c68ad22a05"
test "$(git hash-object bun.lock)" = "d18e982b0ebfd331f275f0063963cc0ad5ae7f29"
git diff --name-only "$AMENDMENT_SHA"...HEAD
git diff --name-only "$BASELINE"...HEAD
git diff "$AMENDMENT_SHA"...HEAD --check
git diff "$BASELINE"...HEAD --check
git status --short --untracked-files=all
```

Expected implementation diff from `AMENDMENT_SHA`:

```text
src/db/repo.ts
test/h5-contradiction-scan.test.ts
test/m13.provider-routing.test.ts
```

Expected complete diff from `BASELINE`:

```text
docs/superpowers/plans/2026-07-27-h5-tier-floor-and-recognizer-parity-amendment.md
docs/superpowers/specs/2026-07-27-h5-tier-floor-and-recognizer-parity-amendment.md
src/db/repo.ts
test/h5-contradiction-scan.test.ts
test/m13.provider-routing.test.ts
```

Both diff checks are silent. Status contains only:

```text
?? docs/benchmarks/2026-07-26-mock-minimebench.md
```

Stop on any other path, hash, whitespace, staged state, or worktree change.

### Task 4: Obtain Independent Correction Closure

**Files:**
- Review: the immutable correction diff and evidence
- Do not modify: historical addenda/decisions, deferred original H5 Task 4 files, or owner data

**Interfaces:**
- Consumes: Task 3 acceptance packet
- Produces: fresh Luna review, fresh closure of the original upheld Critical, binding Sol
  decision, and a handoff back to original H5 Task 3

- [ ] **Step 1: Prepare one content-free review packet**

Store the packet only in the ignored H5 SDD directory. It must contain:

```text
branch and worktree
BASELINE and AMENDMENT_SHA
final HEAD
two characterization PASS results
three exact RED results at the baseline
the routing RED's counts-only expected/received vectors and proof that its assertion
precedes every provider configuration assignment, patchFetch(), and contradictionScan()
five-test GREEN result
focused, adjacent, and full gate exit summaries
package.json and bun.lock git object hashes
AMENDMENT_SHA...HEAD name-only/stat/check
BASELINE...HEAD name-only/stat/check
confirmation that the benchmark remains untracked
```

Do not include tier-0 sentinel prose or identifiers, prompts, response bodies, database
URLs, secrets, or owner content. The routing RED evidence may include only its test name,
PASS/FAIL status, and the integer vectors `[0, 0, 0, 0]` and `[1, 1, 1, 1]`.

- [ ] **Step 2: Obtain fresh Luna/xhigh first-pass review**

Assign a fresh `first_pass_reviewer_luna` the amendment spec, this plan, the review packet,
and these immutable diffs:

```bash
git diff "$AMENDMENT_SHA"...HEAD --stat
git diff "$AMENDMENT_SHA"...HEAD --check
git diff "$AMENDMENT_SHA"...HEAD
```

Require explicit findings on:

```text
all four >= 1 predicates
all 12 ParentType/table mappings
unknown and orphan exclusion
no source_table/source_id or edge_source_tier authorization
tier-1 preservation
uppercase UUID ~* parity
exact marker equality at start/middle/EOF
final Sources suffix preservation
non-mock provider, egress, and review-queue evidence
counts-only routing RED assertion before model/provider configuration, patchFetch(), and scan
post-fix preflight `[0,0,0,0]` before exactly one positive local request
unchanged public interfaces and dream.ts
exact three-file correction scope
fixture privacy, including no tier-0 prose or IDs in failures/logs/reports/review packets and
no `SENTINEL` in the provider body or queue
```

Expected: no unresolved Critical or Important. Apply any valid finding only inside the
authorized three files, rerun focused/adjacent/full/scope/hash gates, and return the changed
diff to a fresh Luna review. An unresolved Critical or Important stops the cycle.

- [ ] **Step 3: Obtain fresh independent closure of the original Critical**

Regardless of whether Luna raises a new Critical, assign a fresh
`critical_adjudicator_sol` the original finding
`H5-T2-LUNA-C1-TIER0-PAIR-EGRESS`, baseline
`6a7877325845ac1d19e3c5bd6924866c90cb5320`, the final correction diff, and Task 3 evidence.
Ask it to determine whether tier zero on each of edge, target person, chunk, and canonical
parent is excluded before any model/provider/egress/review path, and whether the baseline
RED proves that boundary without invoking `contradictionScan()` or exposing tier-0 prose or
IDs.

Expected: explicit `CLOSED/PASS`. The earlier `UPHELD/BLOCK` adjudication at the baseline is
historical evidence and cannot satisfy this gate. Stop immediately on `UPHELD`, `BLOCK`, or
ambiguous closure.

- [ ] **Step 4: Obtain binding Sol/xhigh final review**

Assign a fresh `final_reviewer_sol` the owner-approved amendment spec, this implementation
plan, the review packet, Luna result, fresh Critical closure, and:

```bash
git diff "$BASELINE"...HEAD --stat
git diff "$BASELINE"...HEAD --check
git diff "$BASELINE"...HEAD
```

Require a binding decision on invariant safety, amendment compliance, test sufficiency,
scope, hashes, and readiness to resume original H5 Task 3.

Expected: explicit binding `PASS`. A `BLOCK` is final for the cycle and cannot be waived by
the executor, Luna, or the Critical adjudicator.

- [ ] **Step 5: Apply the two-cycle stop rule and hand off**

One finding-driven correction plus a complete rerun is one cycle. If the next complete
gate/review attempt fails again, stop after the second consecutive failed cycle and report
the exact blocker to the owner.

After Luna has no unresolved Critical/Important, the fresh Critical Sol returns
`CLOSED/PASS`, and binding Sol returns `PASS`, record the final SHA and stop this amendment.
Resume the original H5 plan at Task 3 in a separate execution. Do not perform original H5
Task 4 documentation changes in this correction.
