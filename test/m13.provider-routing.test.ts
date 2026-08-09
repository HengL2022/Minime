// W3 per-tier provider routing (improve-w3-provider-routing.md). Offline: resolution logic
// is pure config; provider-level tests inject fakeFetch; pipeline tests use a loopback fixture
// and a deny-only globalThis.fetch trap for unexpected cloud traffic.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { chunkPairsSharingPerson } from "../src/db/repo";
import {
  classifyIsCloudForTier,
  classifyProviderForTier,
  classifyRouteForTier,
  validateProviderRoutes,
} from "../src/llm";
import { classify } from "../src/pipeline/classify";
import { contradictionScan } from "../src/pipeline/dream";
import { compileNotes } from "../src/pipeline/notes";
import { config } from "../src/util/config";
import { resetDb, testSql } from "./helpers";

const saved = {
  ollamaUrl: config.ollamaUrl,
  classifyProvider: config.classifyProvider,
  cloudMaxTier: config.cloudMaxTier,
  r1: config.providerRouteTier1,
  r2: config.providerRouteTier2,
  openrouterApiKey: config.openrouterApiKey,
  mockOllama: config.mockOllama,
};
afterEach(() => {
  config.ollamaUrl = saved.ollamaUrl;
  config.classifyProvider = saved.classifyProvider;
  config.cloudMaxTier = saved.cloudMaxTier;
  config.providerRouteTier1 = saved.r1;
  config.providerRouteTier2 = saved.r2;
  config.openrouterApiKey = saved.openrouterApiKey;
  config.mockOllama = saved.mockOllama;
  Reflect.deleteProperty(process.env, "PROVIDER_ROUTE_TIER0");
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

  test("startup accepts an implicit cloud fallback above the ceiling, but not an explicit route", () => {
    config.classifyProvider = "openrouter";
    config.cloudMaxTier = 1;
    config.providerRouteTier1 = undefined;
    config.providerRouteTier2 = undefined;
    expect(() => validateProviderRoutes()).not.toThrow();

    config.providerRouteTier2 = "openrouter";
    expect(() => validateProviderRoutes()).toThrow(/stricter/);
  });

  test("malformed CLOUD_MAX_TIER fails closed, not open (NaN/out-of-range throws)", () => {
    // `tier > NaN` is false, so without this guard a NaN ceiling (e.g. an inline .env
    // comment surviving a lax parser) would wave every cloud route through (review B1).
    config.cloudMaxTier = Number.NaN;
    expect(() => classifyRouteForTier(2)).toThrow(/CLOUD_MAX_TIER/);
    config.cloudMaxTier = 5;
    expect(() => classifyRouteForTier(2)).toThrow(/CLOUD_MAX_TIER/);
    config.cloudMaxTier = 0; // legal strictest ceiling — must not throw
    expect(classifyRouteForTier(2)).toBe(config.classifyProvider);
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

type Captured = { url: string; body: any };
function fakeFetch(responder: (c: Captured) => unknown): { calls: Captured[]; fn: typeof fetch } {
  const calls: Captured[] = [];
  const fn = (async (url: any, init?: any) => {
    const captured: Captured = {
      url: String(url),
      body: init?.body ? JSON.parse(init.body) : undefined,
    };
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

  test("effective cloud fallback above the ceiling is refused before fetch or audit", async () => {
    config.classifyProvider = "openrouter";
    config.openrouterApiKey = "test-key";
    config.cloudMaxTier = 1;
    config.providerRouteTier1 = undefined;
    config.providerRouteTier2 = undefined;
    const { calls, fn } = fakeFetch(() => ({
      choices: [{ message: { content: '{"ok":true}' } }],
    }));
    const [before] =
      await testSql`select count(*)::int as n from events where verb = 'egress:classify'`;

    let error: unknown;
    try {
      await classifyProviderForTier(2, fn).completeJson("TIER2 MUST STAY LOCAL");
    } catch (caught) {
      error = caught;
    }

    const [after] =
      await testSql`select count(*)::int as n from events where verb = 'egress:classify'`;
    expect({
      error: error instanceof Error ? error.message : null,
      fetchCalls: calls.length,
      egressRows: after!.n - before!.n,
    }).toEqual({
      error: expect.stringMatching(/effective classify provider.*CLOUD_MAX_TIER=1.*tier-2 egress/),
      fetchCalls: 0,
      egressRows: 0,
    });
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

interface LocalOllamaRequest {
  method: string;
  path: string;
  body: string;
}

/** Direct local fixture for Ollama; ANY ambient fetch call is treated as cloud egress. */
async function patchFetch(ollamaResponder: (request: LocalOllamaRequest) => unknown) {
  const localRequests: LocalOllamaRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const item = {
        method: request.method ?? "",
        path: request.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      };
      localRequests.push(item);
      const payload = ollamaResponder(item);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Ollama fixture did not bind");
  const real = globalThis.fetch;
  const cloudCalls: string[] = [];
  const previousUrl = config.ollamaUrl;
  config.ollamaUrl = `http://127.0.0.1:${address.port}`;
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    cloudCalls.push(u);
    throw new Error(`LEAK: unexpected non-local egress to ${u}`);
  }) as unknown as typeof fetch;
  return {
    cloudCalls,
    localRequests,
    restore: async () => {
      globalThis.fetch = real;
      config.ollamaUrl = previousUrl;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

type H5RoutingFloorArm = "edge" | "person" | "chunk" | "parent" | "alias";

async function h5RoutingPair(
  label: string,
  zeroArm?: H5RoutingFloorArm,
): Promise<{ personId: string }> {
  const mentionName = `H5 Route ${label}`;
  const canonicalName = zeroArm === "alias" ? `H5 Canonical ${label}` : mentionName;
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
  if (zeroArm === "alias") {
    await testSql`
      insert into person_aliases (person_id, alias, tier, source, created_by)
      values (${person!.id}, ${mentionName}, 0, 'test:h5-amendment', 'test:h5-amendment')`;
  }
  for (const side of [0, 1] as const) {
    const parentId = crypto.randomUUID();
    const text = `${mentionName}${sentinel ? ` ${sentinel}` : ""} ${
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

describe("notes distillation per-tier routing", () => {
  test("tier-2 sources + PROVIDER_ROUTE_TIER2=ollama → distilled locally, all chunks in prompt, zero egress", async () => {
    await resetDb();
    // Seed a person with 3 mentioning chunks, one of them tier 2 (same shape as m9.notes tests):
    const [p] =
      await testSql`insert into people (canonical_name, tier) values ('Nadia Rossi', 1) returning id`;
    for (const [i, tier] of [1, 1, 2].entries()) {
      const [pg] = await testSql`insert into pages (path, title, body_md, content_hash, tier)
        values (${`t/${i}.md`}, ${`T${i}`}, 'Nadia Rossi built the koi pond filter.', ${`h${i}`}, ${tier}) returning id`;
      await testSql`insert into chunks (parent_type, parent_id, ord, text, tier)
        values ('page', ${pg!.id}, 0, ${`Nadia Rossi built the koi pond filter. Sentence ${i}`}, ${tier})`;
      await testSql`insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
        values ('page', ${pg!.id}, 'mentions', 'person', ${p!.id}, 'pages', ${pg!.id}, 'system:extract')`;
    }
    config.mockOllama = false; // exercise the real modelDistill path
    // Cloud default that must NOT be reached. openrouter (not bedrock): it constructs with
    // any truthy key, so un-routed code genuinely reaches the patched fetch and trips the
    // leak wire — bedrock would throw at construction (no BEDROCK_MODEL offline) and the
    // heuristic fallback would mask the leak, making the tripwire inert.
    config.classifyProvider = "openrouter";
    config.openrouterApiKey = "test-key";
    config.providerRouteTier2 = "ollama";
    const patched = await patchFetch(() => ({
      response: JSON.stringify({ note: "Nadia Rossi: koi pond filter builder." }),
    }));
    try {
      const res = await compileNotes();
      expect(res.created + res.updated).toBeGreaterThanOrEqual(1);
      expect(patched.localRequests.map((request) => request.path)).toEqual([
        "/api/generate",
        "/api/embed",
      ]);
      expect(patched.localRequests[0]!.body).toContain("Nadia Rossi built the koi pond filter.");
      expect(patched.cloudCalls).toEqual([]);
      const egress =
        await testSql`select count(*)::int as n from events where verb like 'egress:%'`;
      expect(egress[0]!.n).toBe(0);
      const [note] = await testSql`select tier, body_md from pages where source = 'dream:notes'`;
      expect(note!.tier).toBe(2); // tier = max(sources), unchanged by routing
    } finally {
      await patched.restore();
      config.mockOllama = true;
    }
  });

  test("parent, target-entity, and accepted-edge tier two all select the tier-two provider route", async () => {
    await resetDb();
    const fixtures = [
      { name: "Parent Route Two", title: "Parent Route Two", evidence: "parent" },
      { name: "Entity Route Two", title: "Entity Route Two", evidence: "entity" },
      { name: "Edge Route Two", title: "Edge Route Two", evidence: "edge" },
      { name: "Private Alias Route Two", title: "Alias Canonical One", evidence: "alias" },
    ] as const;
    for (const fixture of fixtures) {
      const [person] = await testSql`
        insert into people (canonical_name, tier)
        values (${fixture.title}, ${fixture.evidence === "entity" ? 2 : 1})
        returning id`;
      if (fixture.evidence === "alias") {
        await testSql`
          insert into person_aliases (person_id, alias, tier, source, created_by)
          values (${person!.id}, ${fixture.name}, 2, 'test:route-evidence', 'test:route-evidence')`;
      }
      for (let index = 0; index < 3; index++) {
        const text = `${fixture.name} authoritative source ${index}.`;
        const [page] = await testSql`
          insert into pages (path, title, body_md, content_hash, tier)
          values (${`route-evidence/${fixture.evidence}/${index}.md`}, ${fixture.name}, ${text},
                  ${`${fixture.evidence}-${index}`},
                  ${fixture.evidence === "parent" && index === 0 ? 2 : 1})
          returning id`;
        const [chunk] = await testSql`
          insert into chunks (parent_type, parent_id, ord, text, tier)
          values ('page', ${page!.id}, 0, ${text}, 1)
          returning id`;
        const [edge] = await testSql`
          insert into edges
            (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier, extracted_by)
          values ('page', ${page!.id}, 'mentions', 'person', ${person!.id},
                  'chunks', ${chunk!.id},
                  ${fixture.evidence === "edge" && index === 0 ? 2 : 1},
                  'test:h1-authoritative-route')
          returning id`;
        // The privacy trigger derives initial edge tier from the source chunk. Exercise the
        // independently raised accepted-edge evidence reproduced by the binding review.
        if (fixture.evidence === "edge" && index === 0) {
          await testSql`update edges set tier = 2 where id = ${edge!.id}`;
        }
      }
    }
    config.mockOllama = false;
    config.classifyProvider = "openrouter";
    config.openrouterApiKey = "test-key";
    config.providerRouteTier1 = "openrouter";
    config.providerRouteTier2 = "ollama";
    const patched = await patchFetch((request) => ({
      response: JSON.stringify({
        note: `${fixtures.find((fixture) => request.body.includes(fixture.name))?.name} local note.`,
      }),
      embeddings: [[0.1]],
    }));
    try {
      const result = await compileNotes();
      expect(result.failed).toBe(0);
      expect(patched.cloudCalls).toEqual([]);
      const generateBodies = patched.localRequests
        .filter((request) => request.path === "/api/generate")
        .map((request) => request.body);
      expect(generateBodies).toHaveLength(4);
      for (const fixture of fixtures) {
        expect(generateBodies.some((body) => body.includes(fixture.name))).toBe(true);
      }
      const notes = await testSql`
        select title, tier from pages where source = 'dream:notes' order by title`;
      expect(notes.map((row) => ({ title: row.title, tier: row.tier }))).toEqual(
        fixtures
          .map((fixture) => ({ title: fixture.title, tier: 2 }))
          .sort((left, right) => left.title.localeCompare(right.title)),
      );
      const [egress] =
        await testSql`select count(*)::int as n from events where verb like 'egress:%'`;
      expect(egress!.n).toBe(0);
    } finally {
      await patched.restore();
      config.mockOllama = true;
    }
  });

  test("effective tier two above the cloud ceiling never uses an un-routed cloud fallback", async () => {
    await resetDb();
    const fixtures = [
      { name: "Parent Ceiling Two", evidence: "parent" },
      { name: "Entity Ceiling Two", evidence: "entity" },
      { name: "Edge Ceiling Two", evidence: "edge" },
    ] as const;
    for (const fixture of fixtures) {
      const [person] = await testSql`
        insert into people (canonical_name, tier)
        values (${fixture.name}, ${fixture.evidence === "entity" ? 2 : 1})
        returning id`;
      for (let index = 0; index < 3; index++) {
        const text = `${fixture.name} ceiling source ${index}.`;
        const [page] = await testSql`
          insert into pages (path, title, body_md, content_hash, tier)
          values (${`ceiling-evidence/${fixture.evidence}/${index}.md`}, ${fixture.name}, ${text},
                  ${`ceiling-${fixture.evidence}-${index}`},
                  ${fixture.evidence === "parent" && index === 0 ? 2 : 1})
          returning id`;
        const [chunk] = await testSql`
          insert into chunks (parent_type, parent_id, ord, text, tier)
          values ('page', ${page!.id}, 0, ${text}, 1)
          returning id`;
        const [edge] = await testSql`
          insert into edges
            (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier, extracted_by)
          values ('page', ${page!.id}, 'mentions', 'person', ${person!.id},
                  'chunks', ${chunk!.id}, 1, 'test:h1-cloud-ceiling')
          returning id`;
        if (fixture.evidence === "edge" && index === 0) {
          await testSql`update edges set tier = 2 where id = ${edge!.id}`;
        }
      }
    }
    config.mockOllama = false;
    config.classifyProvider = "openrouter";
    config.openrouterApiKey = "test-key";
    config.cloudMaxTier = 1;
    config.providerRouteTier1 = undefined;
    config.providerRouteTier2 = undefined;
    const [beforeEgress] =
      await testSql`select count(*)::int as n from events where verb like 'egress:%'`;
    const patched = await patchFetch(() => ({
      response: JSON.stringify({ note: "must not be generated" }),
      embeddings: [[0.1]],
    }));
    try {
      const result = await compileNotes();

      expect(result.failed).toBe(0);
      expect(result.results).toHaveLength(3);
      expect(
        result.results.filter(
          (entry) => entry.status !== "failed" && entry.code === "model_distill_failed",
        ),
      ).toHaveLength(3);
      expect(patched.cloudCalls).toEqual([]);
      expect(patched.localRequests.filter((request) => request.path === "/api/generate")).toEqual(
        [],
      );
      const [afterEgress] =
        await testSql`select count(*)::int as n from events where verb like 'egress:%'`;
      expect(afterEgress!.n).toBe(beforeEgress!.n);
      const notes = await testSql`
        select title, tier from pages where source = 'dream:notes' order by title`;
      expect(notes.map((row) => ({ title: row.title, tier: row.tier }))).toEqual(
        fixtures
          .map((fixture) => ({ title: fixture.name, tier: 2 }))
          .sort((left, right) => left.title.localeCompare(right.title)),
      );
    } finally {
      await patched.restore();
      config.mockOllama = true;
    }
  });

  test("tier-zero evidence reaches neither classify nor embed providers and produces no egress audit", async () => {
    await resetDb();
    const sentinel = "TIER0-PROVIDER-PROMPT-SENTINEL";
    const [person] =
      await testSql`insert into people (canonical_name, tier) values ('Provider Zero', 1) returning id`;
    for (const [index, tier] of [0, 1, 1].entries()) {
      const text = `Provider Zero ${sentinel} source ${index}.`;
      const [page] = await testSql`
        insert into pages (path, title, body_md, content_hash, tier)
        values (${`provider-zero/${index}.md`}, ${`Provider zero ${index}`}, ${text},
                ${`provider-zero-${index}`}, ${tier}) returning id`;
      const [chunk] = await testSql`
        insert into chunks (parent_type, parent_id, ord, text, tier)
        values ('page', ${page!.id}, 0, ${text}, ${tier}) returning id`;
      await testSql`
        insert into edges
          (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier, extracted_by)
        values
          ('page', ${page!.id}, 'mentions', 'person', ${person!.id},
           'chunks', ${chunk!.id}, ${tier}, 'test:tier-zero-provider')`;
    }
    config.mockOllama = false;
    config.classifyProvider = "ollama";
    config.embedProvider = "ollama";
    const patched = await patchFetch(() => ({
      response: JSON.stringify({ note: `LEAKED ${sentinel}` }),
      embeddings: [[0.1]],
    }));
    try {
      const result = await compileNotes();
      expect(result.candidates).toBe(0);
      expect(result.results).toEqual([]);
      expect(patched.localRequests).toEqual([]);
      expect(patched.cloudCalls).toEqual([]);
      expect(JSON.stringify(patched.localRequests)).not.toContain(sentinel);
      const [egress] =
        await testSql`select count(*)::int as n from events where verb like 'egress:%'`;
      expect(egress!.n).toBe(0);
      expect(await testSql`select id from pages where source = 'dream:notes'`).toHaveLength(0);
      expect(
        await testSql`select id from chunks where embed_model is not null and text like ${`%${sentinel}%`}`,
      ).toHaveLength(0);
    } finally {
      await patched.restore();
      config.mockOllama = true;
    }
  });
});

describe("contradiction scan per-tier routing", () => {
  test("tier-2 pair + local tier-2 route is scanned locally (was: skipped when cloud+ceiling)", async () => {
    await resetDb();
    const [p] =
      await testSql`insert into people (canonical_name, tier) values ('Old Cat', 1) returning id`;
    const mk = async (i: number, text: string) => {
      const [pg] = await testSql`insert into pages (path, title, body_md, content_hash, tier)
        values (${`c/${i}.md`}, ${`C${i}`}, ${text}, ${`ch${i}`}, 2) returning id`;
      const [ch] = await testSql`insert into chunks (parent_type, parent_id, ord, text, tier)
        values ('page', ${pg!.id}, 0, ${text}, 2) returning id`;
      // Historical chunk-anchored source metadata remains accepted: H5 resolves the canonical
      // parent from src_type/src_id and deliberately ignores source_table/source_id.
      await testSql`insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
        values ('page', ${pg!.id}, 'mentions', 'person', ${p!.id}, 'chunks', ${ch!.id}, 'system:extract')`;
    };
    await mk(1, "Old Cat always eats at dawn.");
    await mk(2, "Old Cat never eats at dawn.");
    config.mockOllama = false;
    config.classifyProvider = "bedrock";
    config.cloudMaxTier = 1; // legacy behavior: tier-2 pair would be SKIPPED
    config.providerRouteTier2 = "ollama"; // W3: now scanned locally instead
    const patched = await patchFetch(() => ({ response: '{"conflict": true}' }));
    try {
      const flagged = await contradictionScan();
      expect(flagged).toBe(1);
      expect(patched.localRequests.map((request) => request.path)).toEqual(["/api/generate"]);
      expect(patched.localRequests[0]!.body).toContain("Old Cat always eats at dawn.");
      expect(patched.cloudCalls).toEqual([]);
      const q =
        await testSql`select count(*)::int as n from review_queue where kind = 'contradiction'`;
      expect(q[0]!.n).toBe(1);
    } finally {
      await patched.restore();
      config.mockOllama = true;
      config.cloudMaxTier = saved.cloudMaxTier;
    }
  });

  test("a matched tier-two alias raises a tier-one contradiction pair onto the local route", async () => {
    await resetDb();
    const alias = "Private Alias Route H5";
    const [person] = await testSql`
      insert into people (canonical_name, tier) values ('Alias Canonical H5', 1) returning id`;
    await testSql`
      insert into person_aliases (person_id, alias, tier, source, created_by)
      values (${person!.id}, ${alias}, 2, 'test:h5-alias-route', 'test:h5-alias-route')`;
    for (const [index, claim] of ["always rings at noon", "never rings at noon"].entries()) {
      const text = `${alias} ${claim}.`;
      const [page] = await testSql`
        insert into pages (path, title, body_md, content_hash, tier)
        values (${`h5-alias-route/${index}.md`}, ${alias}, ${text},
                ${`h5-alias-route-${index}`}, 1) returning id`;
      const [chunk] = await testSql`
        insert into chunks (parent_type, parent_id, ord, text, tier)
        values ('page', ${page!.id}, 0, ${text}, 1) returning id`;
      await testSql`
        insert into edges
          (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
        values ('page', ${page!.id}, 'mentions', 'person', ${person!.id},
                'chunks', ${chunk!.id}, 'system:extract')`;
    }
    const pairs = (await chunkPairsSharingPerson(100)).filter(
      (pair) => pair.person_id === person!.id,
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ a_tier: 2, b_tier: 2 });

    config.mockOllama = false;
    config.classifyProvider = "openrouter";
    config.openrouterApiKey = "test-key";
    config.providerRouteTier1 = "openrouter";
    config.providerRouteTier2 = "ollama";
    const patched = await patchFetch(() => ({ response: '{"conflict":true}' }));
    try {
      expect(await contradictionScan(100)).toBe(1);
      expect(patched.cloudCalls).toEqual([]);
      expect(patched.localRequests).toHaveLength(1);
      expect(patched.localRequests[0]!.body).toContain(alias);
    } finally {
      await patched.restore();
    }
  });

  test("H5 amendment RED: tier-zero pairs reach no provider, egress event, or review item", async () => {
    await resetDb();
    const positive = await h5RoutingPair("Positive");
    const blocked = await Promise.all(
      (["edge", "person", "chunk", "parent", "alias"] as const).map((arm) =>
        h5RoutingPair(arm, arm),
      ),
    );

    // This is the fail-closed RED boundary. Keep only content-free counts and assert them
    // before mutating model/provider config, installing a fetch fixture, or scanning.
    const candidatePairs = await chunkPairsSharingPerson(100);
    const blockedPairCounts = blocked.map(
      (fixture) => candidatePairs.filter((pair) => pair.person_id === fixture.personId).length,
    );
    expect(blockedPairCounts).toEqual([0, 0, 0, 0, 0]);

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
      expect(Object.keys(queue[0]!.payload).sort()).toEqual(["chunk_ids", "pair", "person_id"]);
      expect(JSON.stringify(queue[0]!.payload)).not.toContain("SENTINEL");
    } finally {
      await patched.restore();
    }
  });
});

describe("inbox classify assumed-tier-2 routing", () => {
  test("capture text never reaches the cloud provider when tier-2 routes local", async () => {
    await resetDb();
    config.mockOllama = false;
    config.classifyProvider = "openrouter";
    config.openrouterApiKey = "test-key";
    config.providerRouteTier2 = "ollama";
    const patched = await patchFetch(() => ({
      response: JSON.stringify({ type: "journal", confidence: 0.9, fields: {}, reason: "test" }),
    }));
    try {
      const c = await classify("dear diary, extremely private thought");
      expect(c.type).toBe("journal");
      expect(patched.localRequests.map((request) => request.path)).toEqual(["/api/generate"]);
      expect(patched.localRequests[0]!.body).toContain("dear diary, extremely private thought");
      expect(patched.cloudCalls).toEqual([]);
      const egress =
        await testSql`select count(*)::int as n from events where verb like 'egress:%'`;
      expect(egress[0]!.n).toBe(0);
    } finally {
      await patched.restore();
      config.mockOllama = true;
    }
  });

  test("cloud fallback above max tier returns unknown without local or cloud egress", async () => {
    await resetDb();
    config.mockOllama = false;
    config.classifyProvider = "openrouter";
    config.openrouterApiKey = "test-key";
    config.cloudMaxTier = 1;
    config.providerRouteTier1 = undefined;
    config.providerRouteTier2 = undefined;
    const patched = await patchFetch(() => ({
      response: JSON.stringify({ type: "journal", confidence: 0.9, fields: {}, reason: "test" }),
    }));
    const [before] =
      await testSql`select count(*)::int as n from events where verb = 'egress:classify'`;
    try {
      const classification = await classify("dear diary, this raw capture must stay private");
      const [after] =
        await testSql`select count(*)::int as n from events where verb = 'egress:classify'`;
      expect({
        classification,
        localRequests: patched.localRequests.length,
        cloudCalls: patched.cloudCalls.length,
        egressRows: after!.n - before!.n,
      }).toEqual({
        classification: {
          type: "unknown",
          confidence: 0,
          fields: {},
          reason: "classifier error or unparseable output",
        },
        localRequests: 0,
        cloudCalls: 0,
        egressRows: 0,
      });
    } finally {
      await patched.restore();
      config.mockOllama = true;
    }
  });

  test("W4-9: fresh env (CLOUD_MAX_TIER unset) keeps tier-2 local end-to-end with a cloud CLASSIFY_PROVIDER", async () => {
    // No config.cloudMaxTier assignment here, deliberately: this is the one test in the suite
    // that must exercise the actual shipped default (DECISIONS.md 2026-08-10 — default 1, was
    // 2), not an explicit override. Guard the premise so a leaked mutation from an earlier test
    // fails loudly here instead of this test silently passing for the wrong reason.
    expect(config.cloudMaxTier).toBe(1);
    await resetDb();
    config.mockOllama = false;
    config.classifyProvider = "openrouter";
    config.openrouterApiKey = "test-key";
    config.providerRouteTier1 = undefined;
    config.providerRouteTier2 = undefined;
    const patched = await patchFetch(() => ({
      response: JSON.stringify({ type: "journal", confidence: 0.9, fields: {}, reason: "test" }),
    }));
    const [before] =
      await testSql`select count(*)::int as n from events where verb = 'egress:classify'`;
    try {
      const classification = await classify("dear diary, the default install must keep this local");
      const [after] =
        await testSql`select count(*)::int as n from events where verb = 'egress:classify'`;
      expect({
        classification,
        localRequests: patched.localRequests.length,
        cloudCalls: patched.cloudCalls.length,
        egressRows: after!.n - before!.n,
      }).toEqual({
        // Falls back per the existing ceiling behavior (classifyProviderForTier rejects the
        // job before provider construction): never silently sent, never silently invented.
        classification: {
          type: "unknown",
          confidence: 0,
          fields: {},
          reason: "classifier error or unparseable output",
        },
        localRequests: 0,
        cloudCalls: 0,
        egressRows: 0,
      });
    } finally {
      await patched.restore();
      config.mockOllama = true;
    }
  });
});
