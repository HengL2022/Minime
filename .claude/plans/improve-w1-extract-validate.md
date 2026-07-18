# W1 — Extractor re-validation dream step Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or
> superpowers:executing-plans. Parent contract: `improve-2026-07-program.md`. **Depends on W3
> merged** (`classifyProviderForTier`/`classifyIsCloudForTier`).

**Goal:** Close the phantom-entity bug class structurally: a nightly dream step batch-verifies a
budget of `system:extract` edges with the classify model and **flags disagreements to the review
queue — never auto-mutates** — while recording per-rule verdict counts so future rule demotion is
a data decision.

**Architecture:** New module `src/pipeline/validate-edges.ts` (pattern: `notes.ts` — own module,
one-line dream wiring) registered as dream step **`3c_validate_edges`** (the improvement doc's
`2c` slot is taken by `2c_compile_decision_digests`; `3c` follows `3b_phantom_persons`, the
2026-07-01 watchdog this design extends). A verdict ledger table `edge_validations` (migration
017) makes sweep idempotency, unsure-resampling, and rule miss-rates plain SQL — a **deliberate
deviation** from the improvement doc's `extract:rule-miss` events idea (events stay for
egress/tool audit; ledger rows are queryable). Docs/known-issues/extractor-phantom-orgs.md
§"Fix B (dream-step safety net)" is exactly this workstream.

**Tech stack:** existing; migration `017_edge_validation.sql` (renumber at merge if taken).

## Global constraints

- **Flag-only** (I5): the step writes `edge_validations` + `review_queue` rows; it never
  UPDATEs/DELETEs edges/people/orgs. Repairs stay human-invoked (`retypeOrgToPerson` via the W4
  repair runner).
- SQL only in `repo.ts` + the migration. New repo helpers are system-internal (not MCP-exposed)
  and deliberately not tier-gated — same justification as `personById` (DECISIONS 2026-06-16)
  and `noteSourceChunks`: the system job reads locally; egress is gated by W3 routing.
- Facts about the extractor (from reconnaissance — do not "correct" these): provenance column is
  `edges.extracted_by = 'system:extract'` (there is **no** `created_by` on edges);
  `edges.source_table` holds the parent's real SQL table name (`'pages'`), `source_id` the parent
  row id — **edges are parent-anchored, never chunk-anchored**; `edges.tier` is trigger-derived
  from the source row (013).
- Budget convention: hardcoded default param (`validateEdges(budget = 200)`), matching
  `contradictionScan(limit = 100)` — no new env var.
- `rule_key = "${rel}@${confidence}"` (works_at@0.85 same-sentence / @0.7 same-paragraph /
  @0.6 page-dominant; mentions@0.8) — rule identity without touching the extractor.
- CI offline: `config.mockOllama` branch uses a deterministic heuristic verdict.

## Files

- Create: `db/migrations/017_edge_validation.sql`
- Create: `src/pipeline/validate-edges.ts`
- Modify: `src/db/repo.ts` (new helpers only), `src/pipeline/dream.ts` (one step line),
  `src/mcp/tools/review-queue.ts` (KINDS + masking), `Makefile`
- Create: `test/m14.extract-validate.test.ts`, `fixtures/graph-hygiene.ts` (planted corpus,
  shared by tests + live bake), `scripts/eval-graph-hygiene.ts` (owner-run live bake)
- Append: `DECISIONS.md`

**Interfaces produced:**

```ts
// src/db/repo.ts
export interface EdgeToValidate {
  id: string; src_type: string; src_id: string; rel: string; dst_type: string; dst_id: string;
  confidence: number; tier: number; src_name: string | null; dst_name: string | null;
}
export function edgesForValidation(recentHours: number, limit: number): Promise<EdgeToValidate[]>;
export function edgeAnchorTexts(e: EdgeToValidate, needle: string): Promise<{ text: string; tier: number }[]>;
export function insertEdgeValidation(v: { edgeId: string; verdict: "confirm" | "deny" | "unsure";
  entityType?: "person" | "org" | "neither"; reason?: string; model: string; ruleKey: string }): Promise<void>;
export function edgeUnsureCount(edgeId: string): Promise<number>;

// src/pipeline/validate-edges.ts
export function heuristicVerdict(e: EdgeToValidate, anchor: string):
  { verdict: "confirm" | "deny" | "unsure"; entity_type: "person" | "org" | "neither"; reason: string };
export function validateEdges(budget?: number): Promise<{
  checked: number; confirmed: number; denied: number; unsure: number; flagged: number;
  byRule: Record<string, { checked: number; denied: number }>;
}>;
```

---

### Task 1: Migration 017 — verdict ledger + `extract_suspect` review kind

- [ ] **Step 1.1: Failing test** — create `test/m14.extract-validate.test.ts`:

```ts
// W1 extractor re-validation (improve-w1-extract-validate.md). Offline; mock verdicts.
import { beforeAll, describe, expect, test } from "bun:test";
import { expectSqlReject, resetDb, testSql } from "./helpers";
import { insertReviewItem } from "../src/db/repo";

describe("migration 017", () => {
  beforeAll(async () => {
    await resetDb();
  });

  test("edge_validations exists with verdict CHECK; review kind extract_suspect accepted", async () => {
    const [e] = await testSql`insert into edges (src_type, src_id, rel, dst_type, dst_id, extracted_by)
      values ('page', gen_random_uuid(), 'mentions', 'person', gen_random_uuid(), 'system:extract') returning id`;
    await testSql`insert into edge_validations (edge_id, verdict, model, rule_key)
      values (${e!.id}, 'confirm', 'mock', 'mentions@0.8')`;
    await expectSqlReject(
      testSql`insert into edge_validations (edge_id, verdict, model, rule_key)
        values (${e!.id}, 'maybe', 'mock', 'mentions@0.8')`,
      /verdict/,
    );
    const { id } = await insertReviewItem("extract_suspect", { edge_id: e!.id });
    expect(id).toBeTruthy();
    await expectSqlReject(
      testSql`insert into review_queue (kind, payload) values ('bogus_kind', '{}')`,
      /review_queue_kind_check/,
    );
  });
});
```

- [ ] **Step 1.2: Run** — `bun test test/m14.extract-validate.test.ts`
Expected: FAIL — `relation "edge_validations" does not exist`.

- [ ] **Step 1.3: Create `db/migrations/017_edge_validation.sql`**

```sql
-- 017_edge_validation.sql
-- W1 (improve-w1-extract-validate.md): nightly re-validation of system:extract edges.
-- Verdict LEDGER (insert-only by convention; system-internal, not MCP-exposed) — makes sweep
-- idempotency, unsure-resampling, and per-rule miss-rates plain SQL instead of event archaeology.
create table edge_validations (
  id uuid primary key default gen_random_uuid(),
  edge_id uuid not null references edges(id) on delete cascade,
  verdict text not null check (verdict in ('confirm','deny','unsure')),
  entity_type text check (entity_type in ('person','org','neither')),
  reason text,                                  -- model's one-line justification (<=140 chars)
  model text not null,                          -- provider/model or 'mock'
  rule_key text not null,                       -- '<rel>@<confidence>' e.g. 'works_at@0.85'
  checked_at timestamptz not null default now()
);
create index edge_validations_edge_idx on edge_validations (edge_id, checked_at desc);
create index edge_validations_rule_idx on edge_validations (rule_key, verdict);

-- New flag-only review kind for disagreements (same pattern as 016_phantom_person_review).
alter table review_queue drop constraint if exists review_queue_kind_check;
alter table review_queue add constraint review_queue_kind_check
  check (kind in ('contradiction','stale','duplicate','decision_review','inbox_unfiled',
                  'phantom_person','extract_suspect'));
```

- [ ] **Step 1.4: Run** — Task-1 tests PASS (`resetDb` re-runs migrations). Note: `insertReviewItem`
will accept the new kind at the DB layer; the MCP tool enum comes in Task 5.

- [ ] **Step 1.5: Commit** — `git add db/migrations/017_edge_validation.sql test/m14.extract-validate.test.ts && git commit -m "feat(db): edge_validations ledger + extract_suspect review kind (W1)"`

---

### Task 2: repo.ts helpers (candidate sweep, anchors, ledger writes)

- [ ] **Step 2.1: Failing tests** (append to m14 file)

```ts
import { edgeAnchorTexts, edgesForValidation, edgeUnsureCount, insertEdgeValidation } from "../src/db/repo";

describe("validation repo helpers", () => {
  test("edgesForValidation: recent-first, then oldest backlog; excludes validated (non-unsure); resolves names", async () => {
    await resetDb();
    const [person] = await testSql`insert into people (canonical_name, tier) values ('Mia Chen', 1) returning id`;
    const [org] = await testSql`insert into orgs (canonical_name, tier) values ('Acme Corp', 1) returning id`;
    const [pg] = await testSql`insert into pages (path, title, body_md, content_hash, tier)
      values ('w/a.md', 'Work note', 'Mia Chen works at Acme Corp on filters.', 'h1', 1) returning id`;
    const mkEdge = async (createdAt: string) => (await testSql`
      insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by, confidence, created_at)
      values ('person', ${person!.id}, 'works_at', 'org', ${org!.id}, 'pages', ${pg!.id}, 'system:extract', 0.85, ${createdAt})
      returning id`)[0]!.id as string;
    const oldEdge = await mkEdge("2026-06-01T00:00:00Z");
    const newEdge = await mkEdge(new Date().toISOString());
    const confirmed = await mkEdge("2026-05-01T00:00:00Z");
    await insertEdgeValidation({ edgeId: confirmed, verdict: "confirm", model: "mock", ruleKey: "works_at@0.85" });
    const unsureOnce = await mkEdge("2026-04-01T00:00:00Z");
    await insertEdgeValidation({ edgeId: unsureOnce, verdict: "unsure", model: "mock", ruleKey: "works_at@0.85" });

    const batch = await edgesForValidation(24, 10);
    const ids = batch.map((b) => b.id);
    expect(ids[0]).toBe(newEdge);                 // recent window first
    expect(ids).toContain(oldEdge);               // backlog swept
    expect(ids).toContain(unsureOnce);            // unsure gets resampled
    expect(ids).not.toContain(confirmed);         // settled verdicts excluded
    expect(batch[0]!.src_name).toBe("Mia Chen");
    expect(batch[0]!.dst_name).toBe("Acme Corp");
    expect(await edgeUnsureCount(unsureOnce)).toBe(1);
  });

  test("edgeAnchorTexts finds the parent chunks containing the needle (parent-anchored join)", async () => {
    const [batch] = await edgesForValidation(24, 1);
    await testSql`insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('page', ${batch!.source_id ?? batch!.src_id}, 0, 'Mia Chen works at Acme Corp on filters.', 1)`;
    const anchors = await edgeAnchorTexts(batch!, "Acme Corp");
    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors[0]!.text).toContain("Acme Corp");
  });
});
```

*(Adjust the second test to insert the chunk during fixture setup of the first if ordering is
awkward — the contract under test is: join `chunks.parent_type = <short type for e.source_table>`
and `chunks.parent_id = e.source_id`, filtered `text ilike '%'||needle||'%'`, ordered by `ord`,
limit 3; `EdgeToValidate` must therefore also carry `source_table`/`source_id` — add both fields.)*

- [ ] **Step 2.2: Run** — FAIL: exports missing.

- [ ] **Step 2.3: Implement in `src/db/repo.ts`** (place near the other dream helpers,
after `phantomPersonCandidates`):

```ts
// -- W1 extractor re-validation (system-internal; NOT tier-gated — see personById precedent:
// the dream job reads locally, egress is gated by per-tier routing at the provider layer) ----

export interface EdgeToValidate {
  id: string; src_type: string; src_id: string; rel: string; dst_type: string; dst_id: string;
  confidence: number; tier: number; source_table: string | null; source_id: string | null;
  src_name: string | null; dst_name: string | null;
}

/** system:extract edges needing a verdict: the recent window first (born-yesterday edges get
 * checked the next night), then the oldest backlog, so the whole graph is eventually swept.
 * Settled verdicts (confirm/deny) exclude an edge; a single 'unsure' leaves it eligible for
 * exactly the resample pass (validate-edges flags on the second unsure). */
export async function edgesForValidation(recentHours: number, limit: number): Promise<EdgeToValidate[]> {
  return (await sql`
    select e.id, e.src_type, e.src_id, e.rel, e.dst_type, e.dst_id, e.confidence, e.tier,
           e.source_table, e.source_id,
           coalesce(sp.canonical_name, so.canonical_name) as src_name,
           coalesce(dp.canonical_name, do_.canonical_name) as dst_name
    from edges e
    left join people sp on e.src_type = 'person' and sp.id = e.src_id
    left join orgs   so on e.src_type = 'org'    and so.id = e.src_id
    left join people dp on e.dst_type = 'person' and dp.id = e.dst_id
    left join orgs   do_ on e.dst_type = 'org'   and do_.id = e.dst_id
    where e.extracted_by = 'system:extract'
      and not exists (select 1 from edge_validations v
                      where v.edge_id = e.id and v.verdict <> 'unsure')
      and (select count(*) from edge_validations v2
           where v2.edge_id = e.id and v2.verdict = 'unsure') < 2
    order by (e.created_at >= now() - make_interval(hours => ${recentHours})) desc,
             e.created_at asc
    limit ${limit}`) as unknown as EdgeToValidate[];
}

/** Chunks of the edge's SOURCE PARENT containing the needle — edges are parent-anchored
 * (source_table = real table name, source_id = parent row id; nothing writes chunk-anchored
 * edges). Falls back to the parent's first chunk when the needle is absent. */
export async function edgeAnchorTexts(
  e: Pick<EdgeToValidate, "source_table" | "source_id">, needle: string,
): Promise<{ text: string; tier: number }[]> {
  if (!e.source_table || !e.source_id) return [];
  const shortType = Object.entries(PARENTS).find(([, v]) => v.table === e.source_table)?.[0];
  if (!shortType) return [];
  const hits = (await sql`
    select text, tier from chunks
    where parent_type = ${shortType} and parent_id = ${e.source_id}
      and text ilike ${"%" + needle + "%"}
    order by ord limit 3`) as unknown as { text: string; tier: number }[];
  if (hits.length > 0) return hits;
  return (await sql`
    select text, tier from chunks
    where parent_type = ${shortType} and parent_id = ${e.source_id}
    order by ord limit 1`) as unknown as { text: string; tier: number }[];
}

export async function insertEdgeValidation(v: {
  edgeId: string; verdict: "confirm" | "deny" | "unsure";
  entityType?: "person" | "org" | "neither"; reason?: string; model: string; ruleKey: string;
}): Promise<void> {
  await sql`insert into edge_validations (edge_id, verdict, entity_type, reason, model, rule_key)
    values (${v.edgeId}, ${v.verdict}, ${v.entityType ?? null}, ${v.reason ?? null}, ${v.model}, ${v.ruleKey})`;
}

export async function edgeUnsureCount(edgeId: string): Promise<number> {
  const [r] = await sql`select count(*)::int as n from edge_validations
    where edge_id = ${edgeId} and verdict = 'unsure'`;
  return (r as { n: number }).n;
}
```

- [ ] **Step 2.4: Run** — PASS. `bunx tsc --noEmit` clean.
- [ ] **Step 2.5: Commit** — `git add src/db/repo.ts test/m14.extract-validate.test.ts && git commit -m "feat(repo): edge-validation sweep/anchor/ledger helpers (W1)"`

---

### Task 3: `validate-edges.ts` — verdicts, dispositions, budget

- [ ] **Step 3.1: Failing tests** (append; shared planted corpus goes in `fixtures/graph-hygiene.ts`)

Create `fixtures/graph-hygiene.ts`:

```ts
// Planted corpus for the graph-hygiene gate: the three historical phantom-entity archetypes
// plus control (good) edges. Fictional data only. Used by test/m14 (mock verdicts, CI bar)
// and scripts/eval-graph-hygiene.ts (live model, owner-run scorecard).
import { sql } from "../src/db/client";

export interface Planted { badEdgeIds: string[]; goodEdgeIds: string[] }

export async function plantGraphHygieneCorpus(): Promise<Planted> {
  const bad: string[] = [];
  const good: string[] = [];
  const page = async (path: string, body: string, tier = 1) => (await sql`
    insert into pages (path, title, body_md, content_hash, tier)
    values (${path}, ${path}, ${body}, ${path}, ${tier}) returning id`)[0]!.id as string;
  const chunk = (pid: string, text: string, tier = 1) => sql`
    insert into chunks (parent_type, parent_id, ord, text, tier) values ('page', ${pid}, 0, ${text}, ${tier})`;
  const edge = async (src: [string, string], rel: string, dst: [string, string], pid: string, conf: number) => (await sql`
    insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by, confidence)
    values (${src[0]}, ${src[1]}, ${rel}, ${dst[0]}, ${dst[1]}, 'pages', ${pid}, 'system:extract', ${conf})
    returning id`)[0]!.id as string;

  // Archetype 1: bare-first-name phantom ORG ("Verity" is a person name the rules minted as org)
  const [verity] = await sql`insert into orgs (canonical_name, tier) values ('Verity', 1) returning id`;
  const p1 = await page("gh/1.md", "Talked with Verity about the school run.");
  await chunk(p1, "Talked with Verity about the school run.");
  bad.push(await edge(["page", p1], "mentions", ["org", verity!.id], p1, 0.8));

  // Archetype 2: family works_at (daughter + work-cue paragraph)
  const [mia] = await sql`insert into people (canonical_name, relation, tier) values ('Mia Ito', 'daughter', 1) returning id`;
  const [lab] = await sql`insert into orgs (canonical_name, tier) values ('Northside Lab', 1) returning id`;
  const p2 = await page("gh/2.md", "My daughter Mia Ito visited Northside Lab where I work.");
  await chunk(p2, "My daughter Mia Ito visited Northside Lab where I work.");
  bad.push(await edge(["person", mia!.id], "works_at", ["org", lab!.id], p2, 0.7));

  // Archetype 3: vendor-as-PERSON ("FernCrest Supplies" minted as a person)
  const [biotree] = await sql`insert into people (canonical_name, tier) values ('FernCrest Supplies', 1) returning id`;
  const p3 = await page("gh/3.md", "Ordered two filters from FernCrest Supplies today.");
  await chunk(p3, "Ordered two filters from FernCrest Supplies today.");
  bad.push(await edge(["page", p3], "mentions", ["person", biotree!.id], p3, 0.8));

  // Controls: a real works_at with clean evidence + a real person mention
  const [nadia] = await sql`insert into people (canonical_name, tier) values ('Nadia Rossi', 1) returning id`;
  const [acme] = await sql`insert into orgs (canonical_name, tier) values ('Acme Corp', 1) returning id`;
  const p4 = await page("gh/4.md", "Nadia Rossi works at Acme Corp as a filtration engineer.");
  await chunk(p4, "Nadia Rossi works at Acme Corp as a filtration engineer.");
  good.push(await edge(["person", nadia!.id], "works_at", ["org", acme!.id], p4, 0.85));
  good.push(await edge(["page", p4], "mentions", ["person", nadia!.id], p4, 0.8));

  return { badEdgeIds: bad, goodEdgeIds: good };
}
```

Append to `test/m14.extract-validate.test.ts`:

```ts
import { plantGraphHygieneCorpus } from "../fixtures/graph-hygiene";
import { validateEdges } from "../src/pipeline/validate-edges";

describe("validateEdges (mock verdicts — the CI graph-hygiene bar)", () => {
  test("flags 100% of planted bad edges, 0 false flags, ledger written, idempotent", async () => {
    await resetDb();
    const { badEdgeIds, goodEdgeIds } = await plantGraphHygieneCorpus();
    const r1 = await validateEdges();
    expect(r1.checked).toBe(badEdgeIds.length + goodEdgeIds.length);
    expect(r1.flagged).toBe(badEdgeIds.length);                       // 100% bad flagged
    const flagged = await testSql`select payload->>'edge_id' as id from review_queue where kind = 'extract_suspect'`;
    expect(new Set(flagged.map((f: any) => f.id))).toEqual(new Set(badEdgeIds));  // 0 false flags
    expect(r1.byRule["works_at@0.7"]?.denied).toBe(1);
    const r2 = await validateEdges();                                  // settled → nothing to do
    expect(r2.checked).toBe(0);
    const q = await testSql`select count(*)::int as n from review_queue where kind = 'extract_suspect'`;
    expect(q[0]!.n).toBe(badEdgeIds.length);                           // no duplicate flags
  });

  test("budget bounds a night's work; recent edges beat backlog", async () => {
    await resetDb();
    await plantGraphHygieneCorpus();
    const r = await validateEdges(2);
    expect(r.checked).toBe(2);
  });

  test("unsure resamples once, flags on the second unsure", async () => {
    await resetDb();
    // an edge whose anchor never mentions the dst → heuristic returns 'unsure'
    const [ghost] = await testSql`insert into orgs (canonical_name, tier) values ('Quiet Harbor Ltd', 1) returning id`;
    const [pg] = await testSql`insert into pages (path, title, body_md, content_hash, tier)
      values ('gh/u.md', 'gh/u', 'A page about something else entirely.', 'hu', 1) returning id`;
    await testSql`insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('page', ${pg!.id}, 0, 'A page about something else entirely.', 1)`;
    await testSql`insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by, confidence)
      values ('page', ${pg!.id}, 'mentions', 'org', ${ghost!.id}, 'pages', ${pg!.id}, 'system:extract', 0.8)`;
    const r1 = await validateEdges();
    expect(r1.unsure).toBe(1);
    expect(r1.flagged).toBe(0);
    const r2 = await validateEdges();                                  // resample night
    expect(r2.flagged).toBe(1);
    const [item] = await testSql`select payload from review_queue where kind = 'extract_suspect'`;
    expect(item!.payload.reason).toMatch(/unsure/i);
  });
});
```

- [ ] **Step 3.2: Run** — FAIL: module missing.

- [ ] **Step 3.3: Create `src/pipeline/validate-edges.ts`**

```ts
// Dream step 3c (W1, improve-w1-extract-validate.md): nightly re-validation of rule-extracted
// edges. FLAG-ONLY — disagreements go to review_queue('extract_suspect'); nothing here ever
// mutates edges/people/orgs. Verdicts land in the edge_validations ledger so idempotency,
// unsure-resampling, and per-rule miss-rates are plain SQL. Extends 3b_phantom_persons.
import {
  type EdgeToValidate, edgeAnchorTexts, edgeUnsureCount, edgesForValidation,
  insertEdgeValidation, insertReviewItem, reviewItemExists,
} from "../db/repo";
import { config } from "../util/config";
import { orgCue } from "./classify";

const RECENT_HOURS = 24;
const REASON_CAP = 140;
const FAMILY_CUE = /\b(daughter|son|wife|husband|spouse|partner|mother|father|parent|sibling|grandm\w+|grandf\w+)\b/i;
const BARE_FIRST_NAME = /^[A-Z][a-z]+$/;

type Verdict = { verdict: "confirm" | "deny" | "unsure"; entity_type: "person" | "org" | "neither"; reason: string };

/** Deterministic offline verdicts (CI): re-detects the three historical archetypes from the
 * edge shape + anchor text. The live model replaces this under real runs; the archetypes are
 * exactly what the graph-hygiene planted corpus encodes. */
export function heuristicVerdict(e: EdgeToValidate, anchor: string): Verdict {
  const dst = e.dst_name ?? "";
  if (!anchor.toLowerCase().includes(dst.toLowerCase()))
    return { verdict: "unsure", entity_type: "neither", reason: "evidence does not mention the target" };
  if (e.dst_type === "org" && BARE_FIRST_NAME.test(dst) && !orgCue.test(dst))
    return { verdict: "deny", entity_type: "person", reason: "bare first name, no org cue" };
  if (e.rel === "works_at" && FAMILY_CUE.test(anchor))
    return { verdict: "deny", entity_type: "person", reason: "family-relation context, not employment" };
  if (e.dst_type === "person" && orgCue.test(dst))
    return { verdict: "deny", entity_type: "org", reason: "company-cue name typed as person" };
  return { verdict: "confirm", entity_type: e.dst_type === "org" ? "org" : "person", reason: "evidence supports the edge" };
}

function prompt(e: EdgeToValidate, anchor: string): string {
  const triple = e.rel === "works_at"
    ? `${e.src_name ?? e.src_type} -[works_at]-> ${e.dst_name}`
    : `the text mentions ${e.dst_name} (${e.dst_type})`;
  return `You are auditing one machine-extracted edge from a personal knowledge graph.
EDGE: ${triple}
EVIDENCE (all the extractor saw): "${anchor.slice(0, 600)}"
Answer ONLY {"verdict":"confirm|deny|unsure","entity_type":"person|org|neither","reason":"<=${REASON_CAP} chars"}.
confirm only if the EVIDENCE itself supports the edge; entity_type = what "${e.dst_name}" actually is per the evidence.`;
}

async function modelVerdict(e: EdgeToValidate, anchor: string, tier: 1 | 2): Promise<Verdict | null> {
  try {
    const { classifyProviderForTier } = await import("../llm");
    const raw = await classifyProviderForTier(tier).completeJson(prompt(e, anchor));
    const p = JSON.parse(raw);
    const verdict = ["confirm", "deny", "unsure"].includes(p.verdict) ? p.verdict : "unsure";
    const entity_type = ["person", "org", "neither"].includes(p.entity_type) ? p.entity_type : "neither";
    return { verdict, entity_type, reason: String(p.reason ?? "").slice(0, REASON_CAP) };
  } catch {
    return null; // provider down: leave the edge unvalidated for a future night, never guess
  }
}

export async function validateEdges(budget = 200) {
  const { classifyIsCloudForTier } = await import("../llm");
  const edges = await edgesForValidation(RECENT_HOURS, budget);
  const out = { checked: 0, confirmed: 0, denied: 0, unsure: 0, flagged: 0,
    byRule: {} as Record<string, { checked: number; denied: number }> };
  for (const e of edges) {
    const tier = (e.tier >= 2 ? 2 : 1) as 1 | 2;
    // legacy ceiling semantics (only reachable with no route set): skip rather than send
    if (!config.mockOllama && classifyIsCloudForTier(tier) && tier > config.cloudMaxTier) continue;
    const anchors = await edgeAnchorTexts(e, e.dst_name ?? "");
    const anchor = anchors.map((a) => a.text).join(" ");
    const v = config.mockOllama ? heuristicVerdict(e, anchor) : await modelVerdict(e, anchor, tier);
    if (!v) continue;
    const ruleKey = `${e.rel}@${e.confidence}`;
    const model = config.mockOllama ? "mock" : (await import("../llm")).classifyRouteForTier(tier);
    await insertEdgeValidation({ edgeId: e.id, verdict: v.verdict, entityType: v.entity_type,
      reason: v.reason, model, ruleKey });
    out.checked++;
    const rule = (out.byRule[ruleKey] ??= { checked: 0, denied: 0 });
    rule.checked++;
    const typeMismatch = v.verdict !== "unsure" && v.entity_type !== "neither" && v.entity_type !== e.dst_type;
    if (v.verdict === "deny" || typeMismatch) {
      out.denied++;
      rule.denied++;
      if (!(await reviewItemExists("extract_suspect", "edge_id", e.id))) {
        // IDs + names + one-line reason only — the anchor text itself never enters the payload
        await insertReviewItem("extract_suspect", {
          edge_id: e.id, rel: e.rel, rule_key: ruleKey, verdict: v.verdict,
          src: { type: e.src_type, id: e.src_id, name: e.src_name },
          dst: { type: e.dst_type, id: e.dst_id, name: e.dst_name },
          entity_type: v.entity_type, reason: v.reason,
        });
        out.flagged++;
      }
    } else if (v.verdict === "unsure") {
      out.unsure++;
      if ((await edgeUnsureCount(e.id)) >= 2 && !(await reviewItemExists("extract_suspect", "edge_id", e.id))) {
        await insertReviewItem("extract_suspect", {
          edge_id: e.id, rel: e.rel, rule_key: ruleKey, verdict: "unsure",
          src: { type: e.src_type, id: e.src_id, name: e.src_name },
          dst: { type: e.dst_type, id: e.dst_id, name: e.dst_name },
          entity_type: v.entity_type, reason: `unsure twice: ${v.reason}`.slice(0, REASON_CAP),
        });
        out.flagged++;
      }
    } else out.confirmed++;
  }
  return out;
}
```

*(Import note: `orgCue` is exported from `src/pipeline/classify.ts` per the 2026-07-01 fix. The
`edgesForValidation` SQL from Task 2 already caps unsure-resamples at 2, so a twice-unsure edge
leaves the sweep after flagging.)*

- [ ] **Step 3.4: Run** — Task-3 tests PASS; whole m14 file PASS.
- [ ] **Step 3.5: Commit** — `git add src/pipeline/validate-edges.ts fixtures/graph-hygiene.ts test/m14.extract-validate.test.ts && git commit -m "feat(dream): flag-only extractor re-validation core (W1)"`

---

### Task 4: Routing/tier gate test (W3 interplay)

- [ ] **Step 4.1: Failing test** (append; copy the `patchFetch` helper from
`test/m13.provider-routing.test.ts` — test files stay self-contained):

```ts
describe("validateEdges provider routing", () => {
  test("tier-2 edge: cloud+no-route skips; local tier-2 route validates on-box with zero egress", async () => {
    await resetDb();
    const [org] = await testSql`insert into orgs (canonical_name, tier) values ('Verity', 1) returning id`;
    const [pg] = await testSql`insert into pages (path, title, body_md, content_hash, tier)
      values ('gh/t2.md', 'gh/t2', 'Talked with Verity about the school run.', 'ht2', 2) returning id`;
    await testSql`insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('page', ${pg!.id}, 0, 'Talked with Verity about the school run.', 2)`;
    await testSql`insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by, confidence)
      values ('page', ${pg!.id}, 'mentions', 'org', ${org!.id}, 'pages', ${pg!.id}, 'system:extract', 0.8)`;
    config.mockOllama = false;
    config.classifyProvider = "bedrock";
    config.cloudMaxTier = 1;
    const patched = patchFetch(() => ({
      response: '{"verdict":"deny","entity_type":"person","reason":"bare first name"}',
    }));
    try {
      const skip = await validateEdges();
      expect(skip.checked).toBe(0);                       // legacy: skipped, never sent
      config.providerRouteTier2 = "ollama";
      const run = await validateEdges();
      expect(run.checked).toBe(1);
      expect(run.flagged).toBe(1);
      expect(patched.cloudCalls).toEqual([]);
      const egress = await testSql`select count(*)::int as n from events where verb like 'egress:%'`;
      expect(egress[0]!.n).toBe(0);
    } finally {
      patched.restore();
      config.mockOllama = true;
      config.cloudMaxTier = saved.cloudMaxTier;
      config.providerRouteTier2 = undefined;
      config.classifyProvider = saved.classifyProvider;
    }
  });
});
```

(Declare the same `saved`/`afterEach` restore block and `patchFetch` helper at the top of the m14
file as in m13 — full code in that plan's Task 1/3.)

- [ ] **Step 4.2: Run** — PASS expected if Task 3 used `classifyIsCloudForTier` correctly; a FAIL
here means the gate or route resolution is wired wrong — fix before proceeding.
- [ ] **Step 4.3: Commit** — `git add test/m14.extract-validate.test.ts && git commit -m "test(dream): validate-edges honors per-tier routing and ceiling (W1)"`

---

### Task 5: Dream wiring + review-queue tool surface

- [ ] **Step 5.1: Failing tests** (append)

```ts
import { toolByName } from "../src/mcp/tools";           // match m7.graph.test.ts's actual import
import { invokeTool } from "../src/mcp/tools/registry";

describe("dream wiring + review tool", () => {
  test("dream() runs 3c_validate_edges and reports counts", async () => {
    await resetDb();
    await plantGraphHygieneCorpus();
    const { dream } = await import("../src/pipeline/dream");
    const summary = await dream();
    // dream() runs 2_entity_link first, which may extract ADDITIONAL edges over the planted
    // pages — so assert the step ran and caught at least the planted bad ones; the exact
    // 3-flags/0-false bar lives in the direct validateEdges tests above.
    const step = summary["3c_validate_edges"] as { flagged: number };
    expect(step.flagged).toBeGreaterThanOrEqual(3);
  });

  test("minime_review_queue lists extract_suspect with names visible and reason masked at tier 1", async () => {
    const tool = toolByName("minime_review_queue");
    const res = await invokeTool(tool, { action: "list", kind: "extract_suspect" }, { actor: "agent:test" });
    expect(res.ok).toBe(true);
    const items = (res as any).envelope.data.items;
    expect(items.length).toBe(3);
    expect(JSON.stringify(items)).toContain("Verity");            // entity names are the label
    expect(JSON.stringify(items)).not.toContain("school run");    // anchor text never surfaces
    const resolved = await invokeTool(tool,
      { action: "resolve", id: items[0].id, status: "dismissed" }, { actor: "agent:test" });
    expect(resolved.ok).toBe(true);
  });
});
```

*(Check `m7.graph.test.ts:374-392` for the exact tool-lookup import path and mirror it.)*

- [ ] **Step 5.2: Run** — FAIL: no `3c_validate_edges` in summary; tool enum rejects the kind.

- [ ] **Step 5.3: Implement** —

`src/pipeline/dream.ts`: add after the `3b_phantom_persons` step line:

```ts
  await step("3c_validate_edges", async () => {
    const { validateEdges } = await import("./validate-edges");
    return validateEdges();
  });
```

`src/mcp/tools/review-queue.ts`:
1. Add `"extract_suspect"` to the `KINDS` array and to the tool `description` string.
2. Add `"reason"` to the masked content-key list in `maskContentKeys` (the model's one-line reason
   may quote tier-2 anchor text; names/ids stay visible — same posture as `phantom_person`).
3. In `maskReviewPayload`'s kind-specific branch, treat `extract_suspect` like `phantom_person`:
   the label is built from `payload.src.name` / `payload.dst.name` (already tier-safe strings),
   no `parentMeta` re-resolution needed.

- [ ] **Step 5.4: Run** — PASS. Also `bun test test/m7.graph.test.ts test/m12.phantom-org.test.ts` PASS.
- [ ] **Step 5.5: Commit** — `git add src/pipeline/dream.ts src/mcp/tools/review-queue.ts test/m14.extract-validate.test.ts && git commit -m "feat(dream): wire 3c_validate_edges + review-queue surface (W1)"`

---

### Task 6: Live graph-hygiene bake runner (owner-run) + gates

- [ ] **Step 6.1: Create `scripts/eval-graph-hygiene.ts`** — a thin owner-run bake: same
scratch-DB hard guard as `scripts/eval-search.ts:179-201` (copy the three checks verbatim, env var
`EVAL_DATABASE_URL`), then: `resetDb()`-equivalent (drop+migrate on the scratch DB),
`plantGraphHygieneCorpus()`, force `config.mockOllama = false`, run `validateEdges()`, and print +
write a scorecard to `docs/benchmarks/<date>-graph-hygiene.md` with: planted-bad flagged n/3,
false flags n/2, per-rule table, model used. Exit non-zero if bad<3 or false>0. Add Makefile target:

```makefile
# W1 graph-hygiene live bake (owner-run; CI bar is the mock path inside verify-m14)
eval-graph-hygiene:
	@createdb $(notdir $(EVAL_DATABASE_URL)) 2>/dev/null || true
	@DATABASE_URL=$(EVAL_DATABASE_URL) EVAL_DATABASE_URL=$(EVAL_DATABASE_URL) \
		$(BUN) run scripts/eval-graph-hygiene.ts
```

- [ ] **Step 6.2: Makefile verify target** — add `verify-m14` (`@$(BUN) test test/m14.*.test.ts`),
chain into `verify`, extend `.PHONY`.

- [ ] **Step 6.3: Full gates** — `bun test` green; `bunx tsc --noEmit` clean; `biome` clean;
`make verify` green; `make eval-search` no regression (this workstream must not touch retrieval).

- [ ] **Step 6.4: DECISIONS.md entry**

```markdown
## 2026-07-XX — W1: nightly extractor re-validation (dream 3c, flag-only)

- **Context:** Five same-class extractor fixes in one month (phantom orgs, family works_at,
  vendor-as-person). Rule fixes close instances, not the class. known-issues/
  extractor-phantom-orgs.md anticipated this as "Fix B (dream-step safety net)".
- **Decision:** Dream step 3c_validate_edges re-verifies a nightly budget (200) of
  system:extract edges — recent 24h first, then oldest backlog — via the tier-routed classify
  provider with min-context prompts (edge triple + anchoring sentences). deny/type-mismatch →
  review_queue('extract_suspect'); unsure resamples once then flags. Verdicts land in the new
  edge_validations ledger (migration 017) keyed by rule_key '<rel>@<confidence>' so rule
  miss-rates are SQL, not event archaeology — a deliberate deviation from the proposal's
  'extract:rule-miss' events. Step name 3c (proposal said 2c; that slot is decision digests).
  Flag-only: repairs remain human-invoked (retypeOrgToPerson via the W4 repair runner).
- **Why:** Converts silent graph poisoning into triaged review items without LLM write
  authority (I5/I8 intact); creates the measurement for future rule demotion decisions.
- **Approved by:** human (owner, 2026-07-18 improvement plan §2).
```

- [ ] **Step 6.5: Commit + review** — `git add scripts/eval-graph-hygiene.ts Makefile DECISIONS.md && git commit -m "feat(eval): graph-hygiene live bake + verify-m14 gate (W1)"` — then Sonnet
first-pass review, then invariant-reviewer on the branch diff.

## Acceptance gates (workstream-level)

1. CI bar (mock): 100% of the 3 planted bad edges flagged in one `validateEdges()` cycle, 0 false
   flags on the 2 planted good edges — enforced by `verify-m14`.
2. Live bar (owner-run): `make eval-graph-hygiene` green with the real routed model; scorecard
   committed to docs/benchmarks/.
3. Flag-only proof: the m14 suite asserts no UPDATE/DELETE on edges/people/orgs (the module has
   no such SQL; invariant-reviewer confirms).
4. `make verify` + `make eval-search` green; invariant-reviewer PASS.
5. 30-day live success measure (owner-tracked): zero new phantom-entity DECISIONS entries.
