# W3 — Per-tier provider routing Implementation Plan

> **Historical implementation record.** W3 shipped. Its mandatory skills, fresh-agent reviews,
> and parent orchestration are inactive; current work follows `docs/DEVELOPMENT.md`.

**Goal:** Replace the single `CLOUD_MAX_TIER` drop-ceiling with per-tier classify routing
(`PROVIDER_ROUTE_TIER2=ollama`, `PROVIDER_ROUTE_TIER1=bedrock`) so journal-tier text can be
classified locally while tier-1 world-facts keep the cloud model — with `CLOUD_MAX_TIER` kept as
a hard ceiling that routes may only be *stricter* than.

**Architecture:** One new resolution function in `src/llm/index.ts` (`classifyRouteForTier`)
feeding tier-aware factory/cloudness helpers; the three tier-knowing call sites (notes distill,
contradiction scan, embed backlog untouched) plus the tier-unknowable inbox classifier (routes as
assumed tier 2) switch to the tier-aware API. Egress audit rows gain `route_tier`. **Embed routing
is explicitly deferred** (option (a) of the improvement doc §4): one embedding model for all tiers
— the `vector(768)` single-space invariant (`clearEmbeddings`, `repo.ts:133-139`) forbids mixed
embed models per tier in v1.

**Tech stack:** existing — Bun/TS, no new dependencies, no migration.

## Global constraints

- No new external network dependencies (I1); CI fully offline (`MINIME_MOCK_OLLAMA=1`).
- SQL only in `repo.ts`/migrations/`agg_sql` — this workstream adds **no SQL**.
- Tier 0 is never chunked/classified by construction; `PROVIDER_ROUTE_TIER0` must be rejected
  (only the literal `none` or unset is tolerated).
- Legacy behavior byte-identical when no `PROVIDER_ROUTE_*` is set: same provider choices, same
  skip/filter semantics, same egress payloads apart from the additive `route_tier` field.
- Every cloud call audited (`egress:*`, counts never contents) — I8.
- Functions ≤ ~60 lines; comments explain *why*.

## Files

- Modify: `src/util/config.ts` (route env parsing)
- Modify: `src/llm/index.ts` (resolution + tier-aware factories + audit payload)
- Modify: `src/pipeline/classify.ts` (assumed-tier-2 routing + stale header fix)
- Modify: `src/pipeline/dream.ts` (contradictionScan/claimsConflict tier threading)
- Modify: `src/pipeline/notes.ts` (modelDistill tier threading)
- Modify: `src/verify/m0.ts` (per-route model/creds checks)
- Modify: `scripts/setup-env.sh`, `test/setup-env.test.ts` (wizard question)
- Modify: `.env.example`, `AGENTS.md`, `CLAUDE.md` (docs)
- Modify: `Makefile` (verify-m13 + chain into `verify`)
- Create: `test/m13.provider-routing.test.ts`
- Append: `DECISIONS.md`

**Interfaces produced (later tasks + W1 rely on these exact names):**

```ts
// src/util/config.ts
config.providerRouteTier1: ProviderName | undefined
config.providerRouteTier2: ProviderName | undefined

// src/llm/index.ts
export type ClassifyTier = 1 | 2;
export function classifyRouteForTier(tier: ClassifyTier): ProviderName;      // throws on bad config
export function classifyProviderForTier(tier: ClassifyTier, fetchFn?: FetchFn): LlmProvider;
export function classifyIsCloudForTier(tier: ClassifyTier): boolean;
export function validateProviderRoutes(): void;                              // resolves both tiers
```

---

### Task 1: Route config + resolution logic (pure, no call sites yet)

**Files:** modify `src/util/config.ts`, `src/llm/index.ts`; create `test/m13.provider-routing.test.ts`

- [ ] **Step 1.1: Write the failing tests**

Create `test/m13.provider-routing.test.ts`:

```ts
// W3 per-tier provider routing (improve-w3-provider-routing.md). Offline: resolution logic
// is pure config; provider-level tests inject fakeFetch; pipeline tests patch globalThis.fetch.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { classifyIsCloudForTier, classifyRouteForTier } from "../src/llm";
import { config } from "../src/util/config";

const saved = {
  classifyProvider: config.classifyProvider,
  cloudMaxTier: config.cloudMaxTier,
  r1: config.providerRouteTier1,
  r2: config.providerRouteTier2,
};
afterEach(() => {
  config.classifyProvider = saved.classifyProvider;
  config.cloudMaxTier = saved.cloudMaxTier;
  config.providerRouteTier1 = saved.r1;
  config.providerRouteTier2 = saved.r2;
  delete process.env.PROVIDER_ROUTE_TIER0;
});

describe("classifyRouteForTier resolution", () => {
  test("no routes set → CLASSIFY_PROVIDER for both tiers (legacy)", () => {
    config.classifyProvider = "bedrock";
    config.providerRouteTier1 = undefined;
    config.providerRouteTier2 = undefined;
    expect(classifyRouteForTier(1)).toBe("bedrock");
    expect(classifyRouteForTier(2)).toBe("bedrock");
  });

  test("tier-2 route overrides only tier 2", () => {
    config.classifyProvider = "bedrock";
    config.providerRouteTier2 = "ollama";
    expect(classifyRouteForTier(2)).toBe("ollama");
    expect(classifyRouteForTier(1)).toBe("bedrock");
    expect(classifyIsCloudForTier(2)).toBe(false);
    expect(classifyIsCloudForTier(1)).toBe(true);
  });

  test("cloud route above CLOUD_MAX_TIER is a loud config error, not a silent send", () => {
    config.cloudMaxTier = 1;
    config.providerRouteTier2 = "bedrock";
    expect(() => classifyRouteForTier(2)).toThrow(/stricter/);
  });

  test("local route above the ceiling is fine (stricter is allowed)", () => {
    config.cloudMaxTier = 1;
    config.providerRouteTier2 = "ollama";
    expect(classifyRouteForTier(2)).toBe("ollama");
  });

  test("PROVIDER_ROUTE_TIER0 rejected unless the literal 'none'", () => {
    process.env.PROVIDER_ROUTE_TIER0 = "ollama";
    expect(() => classifyRouteForTier(1)).toThrow(/tier-0/);
    process.env.PROVIDER_ROUTE_TIER0 = "none";
    expect(classifyRouteForTier(1)).toBe(config.classifyProvider);
  });

  test("unknown provider name in a route throws with the valid list", () => {
    config.providerRouteTier1 = "gpt5" as never;
    expect(() => classifyRouteForTier(1)).toThrow(/ollama\|anthropic\|openai\|openrouter\|bedrock/);
  });
});
```

- [ ] **Step 1.2: Run to verify failure**

Run: `bun test test/m13.provider-routing.test.ts`
Expected: FAIL — `classifyRouteForTier` is not exported (`export named 'classifyRouteForTier' not found`).

- [ ] **Step 1.3: Implement config parsing**

In `src/util/config.ts`, insert above `export const config = {`:

```ts
// "" and unset both mean "no route". Name validation happens in src/llm/index.ts so a typo
// fails loudly at first resolution, not silently at parse time.
function routeEnv(name: string): ProviderName | undefined {
  const v = process.env[name]?.trim();
  return v ? (v as ProviderName) : undefined;
}
```

and insert directly under the `cloudMaxTier` line (keep its comment intact):

```ts
  // Per-tier classify routing (W3, DECISIONS.md 2026-07): optional stricter-only overrides of
  // CLASSIFY_PROVIDER per content tier. Tier 0 is never classified and has no route.
  providerRouteTier1: routeEnv("PROVIDER_ROUTE_TIER1"),
  providerRouteTier2: routeEnv("PROVIDER_ROUTE_TIER2"),
```

- [ ] **Step 1.4: Implement resolution in `src/llm/index.ts`**

Insert after the existing `build()` function:

```ts
const PROVIDER_NAMES: readonly ProviderName[] = ["ollama", "anthropic", "openai", "openrouter", "bedrock"];

function providerIsCloud(name: ProviderName): boolean {
  return name !== "ollama";
}

export type ClassifyTier = 1 | 2;

/** W3 routing: which provider classifies content of this tier. Fallback chain:
 * PROVIDER_ROUTE_TIER<t> → CLASSIFY_PROVIDER. Routes may only be STRICTER than
 * CLOUD_MAX_TIER — an explicit cloud route above the ceiling throws (fail loud, never send).
 * Tier-0 content is never classified (I3), so a tier-0 route is rejected outright. */
export function classifyRouteForTier(tier: ClassifyTier): ProviderName {
  const t0 = process.env.PROVIDER_ROUTE_TIER0;
  if (t0 && t0 !== "none")
    throw new Error("PROVIDER_ROUTE_TIER0 is not configurable: tier-0 content is never classified (I3)");
  const route = tier === 2 ? config.providerRouteTier2 : config.providerRouteTier1;
  if (route && !PROVIDER_NAMES.includes(route))
    throw new Error(`PROVIDER_ROUTE_TIER${tier}='${route}' unknown (ollama|anthropic|openai|openrouter|bedrock)`);
  if (route && providerIsCloud(route) && tier > config.cloudMaxTier)
    throw new Error(
      `PROVIDER_ROUTE_TIER${tier}=${route} is a cloud provider but CLOUD_MAX_TIER=` +
        `${config.cloudMaxTier} forbids tier-${tier} egress — routes may only be stricter than the ceiling`,
    );
  return route ?? config.classifyProvider;
}

export function classifyProviderForTier(tier: ClassifyTier, fetchFn?: FetchFn): LlmProvider {
  return withEgressAudit(build(classifyRouteForTier(tier), fetchFn), tier);
}

export function classifyIsCloudForTier(tier: ClassifyTier): boolean {
  return providerIsCloud(classifyRouteForTier(tier));
}

/** Startup validation: resolve both tiers so a bad route fails the daemon/m0 immediately. */
export function validateProviderRoutes(): void {
  classifyRouteForTier(1);
  classifyRouteForTier(2);
}
```

Change `withEgressAudit`'s signature and classify payload (embed payload unchanged):

```ts
function withEgressAudit(p: LlmProvider, routeTier?: number): LlmProvider {
```

and in its `completeJson` wrapper replace the payload line with:

```ts
        payload: {
          provider: p.name,
          model: p.model,
          items: 1,
          ...(routeTier !== undefined ? { route_tier: routeTier } : {}),
        },
```

- [ ] **Step 1.5: Run tests**

Run: `bun test test/m13.provider-routing.test.ts`
Expected: PASS (6 tests). Also run `bunx tsc --noEmit` — clean.

- [ ] **Step 1.6: Commit**

```bash
git add src/util/config.ts src/llm/index.ts test/m13.provider-routing.test.ts
git commit -m "feat(llm): per-tier classify route resolution with stricter-only ceiling (W3)"
```

---

### Task 2: Egress audit carries route_tier (provider-level, fakeFetch)

**Files:** modify `test/m13.provider-routing.test.ts`

**Interfaces consumed:** `classifyProviderForTier(tier, fetchFn)` from Task 1; `fakeFetch` pattern
from `test/providers.test.ts:21-38`; `countEvents` + `resetDb` from `test/helpers.ts`; events read
via `testSql`.

- [ ] **Step 2.1: Write the failing test** (append to m13 file)

```ts
import { resetDb, testSql } from "./helpers";
import { classifyProviderForTier } from "../src/llm";

type Captured = { url: string; body: any };
function fakeFetch(responder: (c: Captured) => unknown): { calls: Captured[]; fn: typeof fetch } {
  const calls: Captured[] = [];
  const fn = (async (url: any, init?: any) => {
    const captured: Captured = { url: String(url), body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(captured);
    return new Response(JSON.stringify(responder(captured)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fn };
}

describe("egress audit route_tier", () => {
  beforeAll(async () => {
    await resetDb();
  });

  test("cloud classify via a tier route stamps route_tier; payload never contains the prompt", async () => {
    config.openrouterApiKey = "test-key";
    config.providerRouteTier1 = "openrouter";
    const { fn } = fakeFetch(() => ({ choices: [{ message: { content: '{"ok":true}' } }] }));
    await classifyProviderForTier(1, fn).completeJson("TIER1 SECRET PROMPT");
    const rows = await testSql`select payload from events where verb = 'egress:classify'`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.payload.route_tier).toBe(1);
    expect(rows[0]!.payload.provider).toBe("openrouter");
    expect(JSON.stringify(rows[0]!.payload)).not.toContain("SECRET");
  });

  test("local route writes zero egress rows", async () => {
    config.providerRouteTier2 = "ollama";
    const { fn } = fakeFetch(() => ({ response: '{"ok":true}' }));
    const before = await testSql`select count(*)::int as n from events where verb like 'egress:%'`;
    await classifyProviderForTier(2, fn).completeJson("journal text");
    const after = await testSql`select count(*)::int as n from events where verb like 'egress:%'`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});
```

Add `config.openrouterApiKey` to the `saved`/`afterEach` restore block from Task 1.

- [ ] **Step 2.2: Run** — `bun test test/m13.provider-routing.test.ts`
Expected: PASS immediately if Task 1 was implemented correctly (this task is a contract lock, not
new production code). If `route_tier` is missing → FAIL points at the `withEgressAudit` payload.

- [ ] **Step 2.3: Commit**

```bash
git add test/m13.provider-routing.test.ts
git commit -m "test(llm): lock egress route_tier payload contract (W3)"
```

---

### Task 3: Notes distillation routes by max source tier

**Files:** modify `src/pipeline/notes.ts`; append to `test/m13.provider-routing.test.ts`

**Interfaces consumed:** `compileNotes()` from `src/pipeline/notes.ts:183`; note fixtures follow
`test/m9.notes.test.ts` seeding (person + ≥3 mentioning chunks via `indexParent`/direct SQL).

- [ ] **Step 3.1: Write the failing test** (append; global-fetch patch pattern — the pipeline does
not accept `fetchFn`, so the tripwire lives on `globalThis.fetch`)

```ts
import { compileNotes } from "../src/pipeline/notes";

/** Patch fetch: localhost Ollama gets a canned answer; ANY other host trips the leak wire. */
function patchFetch(ollamaResponder: () => unknown) {
  const real = globalThis.fetch;
  const cloudCalls: string[] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.startsWith(config.ollamaUrl))
      return new Response(JSON.stringify(ollamaResponder()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    cloudCalls.push(u);
    throw new Error(`LEAK: unexpected non-local egress to ${u}`);
  }) as typeof fetch;
  return { cloudCalls, restore: () => void (globalThis.fetch = real) };
}

describe("notes distillation per-tier routing", () => {
  test("tier-2 sources + PROVIDER_ROUTE_TIER2=ollama → distilled locally, all chunks in prompt, zero egress", async () => {
    await resetDb();
    // Seed a person with 3 mentioning chunks, one of them tier 2 (same shape as m9.notes tests):
    const [p] = await testSql`insert into people (canonical_name, tier) values ('Nadia Rossi', 1) returning id`;
    for (const [i, tier] of [1, 1, 2].entries()) {
      const [pg] = await testSql`insert into pages (path, title, body_md, content_hash, tier)
        values (${`t/${i}.md`}, ${`T${i}`}, 'Nadia Rossi built the koi pond filter.', ${`h${i}`}, ${tier}) returning id`;
      await testSql`insert into chunks (parent_type, parent_id, ord, text, tier)
        values ('page', ${pg!.id}, 0, ${'Nadia Rossi built the koi pond filter. Sentence ' + i}, ${tier})`;
      await testSql`insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
        values ('page', ${pg!.id}, 'mentions', 'person', ${p!.id}, 'pages', ${pg!.id}, 'system:extract')`;
    }
    config.mockOllama = false;               // exercise the real modelDistill path
    config.classifyProvider = "bedrock";     // cloud default that must NOT be reached
    config.providerRouteTier2 = "ollama";
    const patched = patchFetch(() => ({ response: JSON.stringify({ note: "Nadia Rossi: koi pond filter builder." }) }));
    try {
      const res = await compileNotes();
      expect(res.compiled).toBeGreaterThanOrEqual(1);
      expect(patched.cloudCalls).toEqual([]);
      const egress = await testSql`select count(*)::int as n from events where verb like 'egress:%'`;
      expect(egress[0]!.n).toBe(0);
      const [note] = await testSql`select tier, body_md from pages where source = 'dream:notes'`;
      expect(note!.tier).toBe(2); // tier = max(sources), unchanged by routing
    } finally {
      patched.restore();
      config.mockOllama = true;
    }
  });
});
```

- [ ] **Step 3.2: Run** — expected FAIL: the leak tripwire throws (`modelDistill` still resolves the
cloud `classifyProvider` and calls a non-local URL), surfacing as heuristic-fallback + `cloudCalls`
non-empty or an `egress:classify` row, depending on provider creds — either way assertions fail.

- [ ] **Step 3.3: Implement** — in `src/pipeline/notes.ts`, replace `modelDistill`'s first lines
(the import + `classifyIsCloud` filter block, currently lines 82-87) with:

```ts
async function modelDistill(name: string, allChunks: SourceChunk[]): Promise<string> {
  const { classifyProviderForTier, classifyIsCloudForTier } = await import("../llm");
  // W3 routing: provider chosen by the HIGHEST source tier present (same rule as digest
  // tiering). If the resolved provider is still cloud, the CLOUD_MAX_TIER filter keeps
  // over-ceiling chunks out of the prompt (belt-and-braces); a stricter local route makes
  // the filter a no-op so the full source set stays in.
  const maxTier = (allChunks.some((c) => c.tier >= 2) ? 2 : 1) as 1 | 2;
  const chunks = classifyIsCloudForTier(maxTier)
    ? allChunks.filter((c) => c.tier <= config.cloudMaxTier)
    : allChunks;
  if (chunks.length === 0) throw new Error("all source chunks above CLOUD_MAX_TIER");
```

and replace the provider call line (`const raw = await classifyProvider().completeJson(prompt);`)
with:

```ts
  const raw = await classifyProviderForTier(maxTier).completeJson(prompt);
```

Update the stale comment block above the function (lines 78-81) to describe routing (keep the
fallback-to-heuristic sentence).

- [ ] **Step 3.4: Run** — `bun test test/m13.provider-routing.test.ts` PASS; `bun test test/m9.notes.test.ts` PASS (heuristic path untouched under mock).

- [ ] **Step 3.5: Commit**

```bash
git add src/pipeline/notes.ts test/m13.provider-routing.test.ts
git commit -m "feat(notes): route distillation provider by max source tier (W3)"
```

---

### Task 4: Contradiction scan routes per pair tier

**Files:** modify `src/pipeline/dream.ts`; append tests

- [ ] **Step 4.1: Write the failing test** (append)

```ts
import { contradictionScan } from "../src/pipeline/dream";

describe("contradiction scan per-tier routing", () => {
  test("tier-2 pair + local tier-2 route is scanned locally (was: skipped when cloud+ceiling)", async () => {
    await resetDb();
    const [p] = await testSql`insert into people (canonical_name, tier) values ('Old Cat', 1) returning id`;
    const mk = async (i: number, text: string) => {
      const [pg] = await testSql`insert into pages (path, title, body_md, content_hash, tier)
        values (${`c/${i}.md`}, ${`C${i}`}, ${text}, ${`ch${i}`}, 2) returning id`;
      const [ch] = await testSql`insert into chunks (parent_type, parent_id, ord, text, tier)
        values ('page', ${pg!.id}, 0, ${text}, 2) returning id`;
      // pair query joins mentions edges anchored at chunks (see repo.chunkPairsSharingPerson)
      await testSql`insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
        values ('page', ${pg!.id}, 'mentions', 'person', ${p!.id}, 'chunks', ${ch!.id}, 'system:extract')`;
    };
    await mk(1, "Old Cat always eats at dawn.");
    await mk(2, "Old Cat never eats at dawn.");
    config.mockOllama = false;
    config.classifyProvider = "bedrock";
    config.cloudMaxTier = 1;                 // legacy behavior: tier-2 pair would be SKIPPED
    config.providerRouteTier2 = "ollama";    // W3: now scanned locally instead
    const patched = patchFetch(() => ({ response: '{"conflict": true}' }));
    try {
      const flagged = await contradictionScan();
      expect(flagged).toBe(1);
      expect(patched.cloudCalls).toEqual([]);
      const q = await testSql`select count(*)::int as n from review_queue where kind = 'contradiction'`;
      expect(q[0]!.n).toBe(1);
    } finally {
      patched.restore();
      config.mockOllama = true;
      config.cloudMaxTier = saved.cloudMaxTier;
    }
  });
});
```

*Note:* if the pair-join fix chip (`task_ce246ce5`) has landed first, build the fixture per its
corrected parent-anchored shape instead (edges `source_table='pages'`); the assertion stays identical.

- [ ] **Step 4.2: Run** — expected FAIL: `flagged` is 0 (legacy code skips the tier-2 pair because
`classifyIsCloud()` is true and 2 > ceiling 1).

- [ ] **Step 4.3: Implement** — in `src/pipeline/dream.ts` replace `claimsConflict` and the gate in
`contradictionScan` (current lines 48-70):

```ts
async function claimsConflict(a: string, b: string, tier: 1 | 2): Promise<boolean> {
  if (config.mockOllama) {
    return ANTONYMS.some(([x, y]) => (x.test(a) && y.test(b)) || (y.test(a) && x.test(b)));
  }
  try {
    const { classifyProviderForTier } = await import("../llm");
    const raw = await classifyProviderForTier(tier).completeJson(
      `Do these two statements about the same person contradict each other? Answer ONLY {"conflict": true} or {"conflict": false}.\nA: ${a.slice(0, 500)}\nB: ${b.slice(0, 500)}`,
    );
    return JSON.parse(raw).conflict === true;
  } catch {
    return false;
  }
}

export async function contradictionScan(limit = 100): Promise<number> {
  const { classifyIsCloudForTier } = await import("../llm");
  const pairs = await chunkPairsSharingPerson(limit);
  let flagged = 0;
  for (const p of pairs) {
    const tier = (Math.max(p.a_tier, p.b_tier) >= 2 ? 2 : 1) as 1 | 2;
    // tier gate: only reachable via the legacy fallback (no route set, cloud CLASSIFY_PROVIDER)
    // — an explicit cloud route above the ceiling already failed loudly at resolution. With a
    // local route the pair is scanned on-box instead of skipped (that is the W3 point).
    if (!config.mockOllama && classifyIsCloudForTier(tier) && tier > config.cloudMaxTier) continue;
    if (await reviewItemExists("contradiction", "pair", `${p.a_id}:${p.b_id}`)) continue;
    if (await claimsConflict(p.a_text, p.b_text, tier)) {
```

(the review-item insert and the rest of the loop are unchanged).

- [ ] **Step 4.4: Run** — m13 suite PASS; `bun test test/m7.graph.test.ts` PASS.

- [ ] **Step 4.5: Commit**

```bash
git add src/pipeline/dream.ts test/m13.provider-routing.test.ts
git commit -m "feat(dream): contradiction scan routes classify per pair tier (W3)"
```

---

### Task 5: Inbox classifier routes as assumed tier 2 + stale-header fix

**Files:** modify `src/pipeline/classify.ts`; append tests

**Why assumed tier 2:** the raw capture has no tier yet — tier is assigned *after* classification
in `watcher.fileRow` (task→1, journal/interaction→2). The router must assume the most intimate
destination. With no routes configured this resolves to `CLASSIFY_PROVIDER` — byte-identical
legacy behavior.

- [ ] **Step 5.1: Write the failing test** (append)

```ts
import { classify } from "../src/pipeline/classify";

describe("inbox classify assumed-tier-2 routing", () => {
  test("capture text never reaches the cloud provider when tier-2 routes local", async () => {
    await resetDb();
    config.mockOllama = false;
    config.classifyProvider = "openrouter";
    config.openrouterApiKey = "test-key";
    config.providerRouteTier2 = "ollama";
    const patched = patchFetch(() => ({
      response: JSON.stringify({ type: "journal", confidence: 0.9, fields: {}, reason: "test" }),
    }));
    try {
      const c = await classify("dear diary, extremely private thought");
      expect(c.type).toBe("journal");
      expect(patched.cloudCalls).toEqual([]);
      const egress = await testSql`select count(*)::int as n from events where verb like 'egress:%'`;
      expect(egress[0]!.n).toBe(0);
    } finally {
      patched.restore();
      config.mockOllama = true;
    }
  });
});
```

- [ ] **Step 5.2: Run** — expected FAIL: `cloudCalls` contains the OpenRouter URL (or the classifier
falls into its catch and returns `unknown`), because `classify()` still uses the un-routed
`classifyProvider()`.

- [ ] **Step 5.3: Implement** — in `src/pipeline/classify.ts`:

Replace the file's line-1 header comment (stale since the pluggable-provider change) with:

```ts
// Inbox classifier: strict-JSON prompt via the classify provider. Raw captures have no tier
// yet (tier is assigned AFTER classification by watcher.fileRow), so W3 routing treats them
// as tier 2 — the most intimate destination they might land in. Mocked offline in CI.
```

In `classify()` replace the two provider lines:

```ts
    const { classifyProviderForTier } = await import("../llm");
    // Assumed tier 2: a capture may be journal/interaction-bound; route for the worst case.
    const raw = await classifyProviderForTier(2).completeJson(
      buildPrompt(todayStr()) + text.slice(0, 4000),
    );
```

- [ ] **Step 5.4: Run** — m13 suite PASS; `bun test test/m10.classify-guardrails.test.ts test/m12.phantom-org.test.ts` PASS (mock path untouched).

- [ ] **Step 5.5: Commit**

```bash
git add src/pipeline/classify.ts test/m13.provider-routing.test.ts
git commit -m "feat(classify): inbox captures route as assumed tier 2 (W3)"
```

---

### Task 6: verify-m0, setup wizard, env docs

**Files:** modify `src/verify/m0.ts`, `scripts/setup-env.sh`, `test/setup-env.test.ts`, `.env.example`, `AGENTS.md`, `CLAUDE.md`

- [ ] **Step 6.1: m0 per-route checks** — in `src/verify/m0.ts` add to the imports:

```ts
import { classifyRouteForTier, validateProviderRoutes } from "../llm";
```

Replace the provider-check block (the `if (config.mockOllama) { ... } else { ... }` section) body
of the `else` branch with:

```ts
  let routesOk = true;
  try {
    validateProviderRoutes();
  } catch (e) {
    routesOk = false;
    check("provider routes valid", false, e instanceof Error ? e.message : String(e));
  }
  const jobs: [string, string][] = [["embed", config.embedProvider]];
  if (routesOk) {
    jobs.push(["classify tier1", classifyRouteForTier(1)], ["classify tier2", classifyRouteForTier(2)]);
  }
  const needsOllama = new Set<string>();
  if (config.embedProvider === "ollama") needsOllama.add(config.embedModel);
  for (const [job, provider] of jobs)
    if (job.startsWith("classify") && provider === "ollama") needsOllama.add(config.classifyModel);

  if (needsOllama.size > 0) {
    try {
      const res = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      const tags = (await res.json()) as { models: { name: string }[] };
      const names = tags.models.map((m) => m.name);
      const has = (model: string) => names.some((n) => n === model || n.startsWith(`${model}:`));
      for (const model of needsOllama) check(`ollama model: ${model}`, has(model));
    } catch (e) {
      check("ollama reachable", false, e instanceof Error ? e.message : String(e));
    }
  }
  const embedModelFor: Record<string, string> = {
    openai: config.openaiEmbedModel,
    openrouter: config.openrouterEmbedModel,
  };
  for (const [job, provider] of jobs) {
    if (provider === "ollama") continue;
    const [ok, detail] = cloudCredsOk(provider);
    const shown =
      job === "embed" && embedModelFor[provider]
        ? detail.replace(/^[^ ]+/, embedModelFor[provider]!)
        : detail;
    check(`${job} provider: ${provider}`, ok, shown);
  }
```

Also call `validateProviderRoutes()` (same try/catch → `console.error` + exit 1) at the top of the
`serve` and `dream` cases in `src/cli.ts` so a bad route fails the daemon at startup, not at 3am.

- [ ] **Step 6.2: Wizard question** — in `scripts/setup-env.sh`, directly after the
`set_kv CLOUD_MAX_TIER "$REPLY"` line add:

```bash
  if [ "$(get_kv CLOUD_MAX_TIER)" = "2" ]; then
    echo "Tier-2 = journals/interactions — the most intimate text. You can keep CLOUDs for"
    echo "tier-1 world-facts but classify tier-2 locally (needs: ollama pull llama3.1:8b)."
    ask "Route tier-2 classification to local Ollama? [y/N]" "N"
    case "$REPLY" in
      y|Y|yes) set_kv PROVIDER_ROUTE_TIER2 ollama; ROUTE2_LOCAL=1 ;;
    esac
  fi
```

and change the later `INSTALL_FLAGS=" --no-ollama"` line to:

```bash
  [ "${ROUTE2_LOCAL:-0}" = "1" ] || INSTALL_FLAGS=" --no-ollama"
```

- [ ] **Step 6.3: Extend `test/setup-env.test.ts`** — the scripted-answers driver gains one answer
in the cloud path sequence (the new question defaults to `N`, so existing scripted runs must add
one blank/`N` line at that position; locate the answers array feeding the cloud-provider scenario
and insert the extra newline). Add one new test: answering `y` writes `PROVIDER_ROUTE_TIER2=ollama`
to the generated `.env` (assert with the same `get_kv`-style grep the file already uses) and the
summary does not pass `--no-ollama`.

- [ ] **Step 6.4: Docs** —

`.env.example`, under the `CLOUD_MAX_TIER=2` line:

```
# Per-tier classify routing (W3): stricter-only overrides of CLASSIFY_PROVIDER. Recommended
# standing config: tier-2 journals/interactions classified locally, tier-1 on the cloud model.
# A cloud route above CLOUD_MAX_TIER refuses to start. Raw inbox captures route as tier 2.
#PROVIDER_ROUTE_TIER2=ollama
#PROVIDER_ROUTE_TIER1=bedrock
```

`AGENTS.md`, in the "Cloud LLM providers" section after the privacy-contract paragraph:

```markdown
**Per-tier routing (W3):** `PROVIDER_ROUTE_TIER1` / `PROVIDER_ROUTE_TIER2` override
`CLASSIFY_PROVIDER` for content of that tier (embeddings are NOT tier-routable — one vector
space per index). Routes may only be stricter than `CLOUD_MAX_TIER`; violations fail at
startup. Egress events carry the resolved `route_tier`. Raw inbox captures (tier unknown
until classified) route as tier 2.
```

`CLAUDE.md`, amend the I1 bullet (it predates the 2026-06-11 amendment) to:

```markdown
- **I1 Local-first**: no cloud DB, no SaaS APIs, no telemetry. Default runtime network =
  localhost Postgres + localhost Ollama. Amendment (DECISIONS.md 2026-06-11 + W3): optional
  cloud LLM providers for embed/classify, gated by `CLOUD_MAX_TIER` and per-tier
  `PROVIDER_ROUTE_*` (stricter-only), every call audited as `egress:*`; tier-0 content never
  leaves on any path. CI/tests still run fully offline (mock Ollama).
```

- [ ] **Step 6.5: Run** — `bun test test/setup-env.test.ts` PASS; `make verify-m0` locally (needs DB up) PASS.

- [ ] **Step 6.6: Commit**

```bash
git add src/verify/m0.ts src/cli.ts scripts/setup-env.sh test/setup-env.test.ts .env.example AGENTS.md CLAUDE.md
git commit -m "feat(ops): route-aware verify-m0, setup wizard question, env/docs for W3"
```

---

### Task 7: Gate wiring + DECISIONS entry

**Files:** modify `Makefile`; append `DECISIONS.md`

- [ ] **Step 7.1: Makefile** — add after `verify-m9`:

```makefile
verify-m13:
	@$(BUN) test test/m13.*.test.ts
```

and extend the `verify` line to include `verify-m13` (W2 will backfill m10–m12; do not add those
here). Add `verify-m13` to the `.PHONY` list.

- [ ] **Step 7.2: Full gates**

Run: `bun test` → all pass; `bunx tsc --noEmit` → clean; `bunx biome check --write .` → clean;
`make verify` → green; `make eval-search` → no regression (routing must not touch retrieval).

- [ ] **Step 7.3: DECISIONS.md entry** (append, adjust date to merge day):

```markdown
## 2026-07-XX — W3: per-tier classify routing (PROVIDER_ROUTE_TIER1/2)

- **Context:** CLOUD_MAX_TIER was all-or-nothing per job: the standing config sent tier-2
  journal/interaction text to Bedrock for classification and notes compilation. Reconnaissance
  found the inbox classifier had NO tier gate at all and its content tier is unknowable at
  call time (assigned after classification).
- **Decision:** PROVIDER_ROUTE_TIER1/TIER2 override CLASSIFY_PROVIDER per content tier;
  CLOUD_MAX_TIER stays as a hard ceiling (routes may only be stricter — violations throw at
  startup). Tier-0 routes rejected. Inbox captures route as assumed tier 2. Egress events
  gain route_tier. Embed routing DEFERRED (single 768-dim vector space invariant): one embed
  model for all tiers; revisit only with a per-tier embedding-space design.
- **Why:** Minimizes the intimate-text egress surface without giving up cloud quality on
  tier-1 world-facts; pairs skipped under the old ceiling are now scanned locally instead.
- **Approved by:** human (owner, 2026-07-18 improvement plan §4/§13-Q1 defaults).
```

- [ ] **Step 7.4: Commit + hand to review**

```bash
git add Makefile DECISIONS.md
git commit -m "chore(gates): verify-m13 target + W3 decision entry"
```

Reviewer protocol per program plan: Sonnet first-pass (spec + quality), then invariant-reviewer
(expected findings to pre-empt: no new SQL, no string-interpolated SQL, egress payloads carry no
content, CI offline — the m13 suite must never hit a real network endpoint).

## Acceptance gates (workstream-level)

1. `make verify` + `make eval-search` green (floors untouched).
2. Leak assertions: with `PROVIDER_ROUTE_TIER2=ollama`, the m13 suite proves tier-2 content in
   notes/contradiction/inbox paths produces **zero** `egress:*` rows and zero non-localhost fetch
   calls (tripwire).
3. Legacy identity: full suite green with all routes unset (the only observable delta is the
   additive `route_tier` egress field).
4. invariant-reviewer PASS.
