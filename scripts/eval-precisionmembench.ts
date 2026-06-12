// PrecisionMemBench (github.com/tenurehq/precisionmembench) — in-process runner.
// The benchmark scores retrieval PRECISION (89 judge-free cases over 35 beliefs): it
// punishes returning extra results and letting the model sort them out — exactly what
// Phase-3 rerank+autocut is for.
//
// This runner executes NO harness code: it reads their JSON fixtures as data and ports
// their external-provider scoring verbatim (BaseAdapter.buildContext + both
// *.external.eval.test.ts files, harness commit cloned at PMB_DIR). The harness side
// (pinned facts, open questions, relation expansion, persona, caps) is fixture-driven
// bookkeeping; the provider side — the thing measured — is Minime's real engine:
// one page per belief, hybridSearch with rerank+autocut as the result cut.
// Reports are written in the harness's exact JSON shape so scorecards stay
// leaderboard-comparable; scripts/pmb-server.ts + make eval-pmb-official run the real
// harness for submission.
//
// Mapping decisions (see DECISIONS.md):
// - scope filter is STRICT equality on the single scope the harness forwards to
//   external providers; the one multi-scope case is structurally unwinnable for them
// - superseded/resolved status is NOT in the external /add metadata — those cases are
//   taken honestly as the shared external-provider handicap
//
// Usage (via make eval-pmb):
//   DATABASE_URL=$EVAL_PMB_DATABASE_URL EVAL_PMB_DATABASE_URL=... \
//     bun run scripts/eval-precisionmembench.ts --out <dir>

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PMB_DIR =
  process.env.PMB_DIR ?? join(process.env.HOME ?? "~", "datasets", "precisionmembench");
const USER_ID = "test-user";
// verbatim from the harness's EVAL_PERSONA — prelude `contains` checks match against it
const PERSONA_UNIVERSAL =
  "You prefer direct answers without preamble. You push back when plans have problems rather than defaulting to agreement. You edit AI output; you do not let AI edit your prose.";

interface Belief {
  _id: string;
  user_id: string;
  type: string;
  canonical_name: string;
  aliases?: string[];
  content: string;
  why_it_matters?: string;
  scope: string[];
  pinned?: boolean;
  superseded_by?: string | null;
  resolved_at?: string | null;
  participants?: string[];
}

interface BeliefsExpect {
  mustInclude?: string[];
  mustExclude?: string[];
  shouldInclude?: string[];
  shouldOnlyInclude?: string[];
  orderedBefore?: [string, string][];
  maxCount?: number;
  minCount?: number;
}

interface RetrievalCase {
  caseId: string;
  category: string;
  description: string;
  userId?: string;
  scope: string[];
  query: string;
  budget?: { maxBeliefs?: number; maxPinnedFacts?: number; maxQuestions?: number };
  expect: {
    personaPrelude?: {
      nonEmpty?: boolean;
      isNull?: boolean;
      contains?: string[];
      mustNotContain?: string[];
    };
    pinnedFacts?: { mustInclude?: string[]; mustExclude?: string[] };
    relevantBeliefs?: BeliefsExpect;
    openQuestions?: { mustInclude?: string[]; mustExclude?: string[] };
  };
}

interface SessionTurn {
  turnIndex: number;
  label: string;
  scope: string[];
  userMessage: string;
  createBeliefAtTurn?: Belief;
  updateBeliefAtTurn?: { beliefId: string; addAliases?: string[] };
  expect: {
    relevantBeliefs?: BeliefsExpect;
    pinnedFacts?: { mustInclude?: string[]; mustExclude?: string[] };
    openQuestions?: { mustInclude?: string[]; mustExclude?: string[] };
    noiseCheck?: { mustNotSurface: string[] };
  };
}

interface SessionCase {
  caseId: string;
  description: string;
  turns: SessionTurn[];
}

function flag(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? dflt) : dflt;
}

// ---------------------------------------------------------------- provider side (Minime)

const fixture = new Map<string, Belief>(); // harness-side seedIndex equivalent
const pathByBelief = new Map<string, string>(); // beliefId -> page path
const pathFor = (userId: string, beliefId: string) => `pmb/${userId}/${beliefId}.md`;
// derived from the id only — gives the title channel something lexical without inventing content
const titleFor = (beliefId: string) => beliefId.replace(/^b-/, "").replace(/-/g, " ");

// BaseAdapter.beliefToText, mode "canonical_name_aliases" (the harness default)
function beliefToText(b: Belief): string {
  return [b.canonical_name, ...(b.aliases ?? []), b.content, b.why_it_matters]
    .filter(Boolean)
    .join(" ");
}

async function upsertBelief(b: Belief): Promise<void> {
  const { upsertPage, replaceChunks } = await import("../src/db/repo");
  const { chunkMarkdown } = await import("../src/search/chunker");
  fixture.set(b._id, b);
  pathByBelief.set(b._id, pathFor(b.user_id, b._id));
  const text = beliefToText(b);
  const title = titleFor(b._id);
  // direct replaceChunks (not indexParent): no entity extraction on benchmark fixtures
  const { id, changed } = await upsertPage({
    path: pathByBelief.get(b._id)!,
    title,
    bodyMd: text,
    contentHash: Bun.hash(text).toString(16),
    tier: 1,
    source: "pmb",
  });
  if (changed) await replaceChunks("page", id, chunkMarkdown(text, title), 1);
}

async function embedBacklog(): Promise<void> {
  const { chunksMissingEmbedding, setChunkEmbedding } = await import("../src/db/repo");
  const { embedTexts } = await import("../src/search/embed");
  const { embedModelName } = await import("../src/llm");
  for (;;) {
    const missing = await chunksMissingEmbedding(64, 2);
    if (missing.length === 0) return;
    const vecs = await embedTexts(missing.map((m) => m.text));
    for (let i = 0; i < missing.length; i++)
      await setChunkEmbedding(missing[i]!.id, vecs[i]!, embedModelName());
  }
}

// Provider /search equivalent: hybridSearch over the requesting user's belief pages,
// STRICT single-scope filter (what the harness forwards), autocut as the result cut.
// In session mode the /add metadata also carries type/pinned/superseded_by (their
// UniversalSessionAdapter.seedMetadata), so filtering open questions and superseded
// beliefs there is contract-legit; resolved_at is never sent, so that leak stays.
async function searchBeliefs(
  userId: string,
  query: string,
  limit: number,
  scope: string | undefined,
  mode: "retrieval" | "session",
): Promise<string[]> {
  if (!query.trim() || limit <= 0) return [];
  const { pagesByPaths } = await import("../src/db/repo");
  const { hybridSearch } = await import("../src/search/hybrid");

  const allowed = [...fixture.values()].filter(
    (b) =>
      b.user_id === userId &&
      (!scope || b.scope[0] === scope || b.scope.includes(scope)) &&
      (mode === "retrieval" || (b.type !== "open_question" && !b.superseded_by)),
  );
  if (allowed.length === 0) return [];
  const beliefByPath = new Map(allowed.map((b) => [pathByBelief.get(b._id)!, b._id]));
  const pages = await pagesByPaths([...beliefByPath.keys()]);
  const byPageId = new Map(pages.map((p) => [p.id, beliefByPath.get(p.path)!]));

  const hits = await hybridSearch({
    query,
    scopeParentIds: pages.map((p) => p.id),
    limit,
    autocut: true,
  });
  return hits.map((h) => byPageId.get(h.id)).filter((x): x is string => Boolean(x));
}

// ---------------------------------------------------------------- harness side (ported)

interface BuiltContext {
  personaPrelude: string;
  pinned: string[];
  relevant: string[];
  questions: string[];
}

const scopeMatch = (b: Belief, scope: string[]) => b.scope.some((s) => scope.includes(s));

// BaseAdapter.buildContext, verbatim semantics (incl. its caps: maxBeliefs bounds the
// pinned list too, and pinned search hits consume provider limit slots before exclusion)
async function buildContext(
  userId: string,
  scope: string[],
  rawQuery: string,
  budget: RetrievalCase["budget"] = {},
  mode: "retrieval" | "session" = "retrieval",
): Promise<BuiltContext> {
  const maxBeliefs = budget.maxBeliefs ?? 20;
  const maxQuestions = budget.maxQuestions ?? 15;

  const pinnedFacts = [...fixture.values()].filter(
    (b) =>
      b.user_id === userId &&
      b.pinned === true &&
      b.type !== "open_question" &&
      !b.superseded_by &&
      !b.resolved_at &&
      scopeMatch(b, scope),
  );
  const questions = [...fixture.values()].filter(
    (b) =>
      b.user_id === userId &&
      b.type === "open_question" &&
      b.pinned === true &&
      !b.resolved_at &&
      scopeMatch(b, scope),
  );
  const pinnedIds = new Set(pinnedFacts.map((b) => b._id));

  const rawIds = await searchBeliefs(userId, rawQuery, maxBeliefs, scope[0], mode);
  const results = rawIds.filter((id) => !pinnedIds.has(id)).map((id) => fixture.get(id)!);

  const exclude = new Set([...pinnedIds, ...results.map((b) => b._id)]);
  const expansions: Belief[] = [];
  for (const rel of results.filter((b) => b.type === "relation")) {
    for (const pid of rel.participants ?? []) {
      if (exclude.has(pid)) continue;
      const p = fixture.get(pid);
      if (p && p.user_id === userId && scopeMatch(p, scope)) expansions.push(p);
    }
  }

  const cappedPinned = pinnedFacts.slice(0, maxBeliefs);
  const cappedRelevant = [...results, ...expansions].slice(
    0,
    Math.max(0, maxBeliefs - cappedPinned.length),
  );
  return {
    personaPrelude: userId === USER_ID ? PERSONA_UNIVERSAL : "",
    pinned: cappedPinned.map((b) => b._id),
    relevant: cappedRelevant.map((b) => b._id),
    questions: questions.slice(0, maxQuestions).map((b) => b._id),
  };
}

// ---------------------------------------------------------------- scoring (ported)

interface Entry {
  caseId: string;
  category: string;
  description?: string;
  turnIndex?: number;
  label?: string;
  pinnedBeliefs?: string[];
  relevantBeliefs?: string[];
  retrievedQuestions?: string[];
  retrievedBeliefIds?: string[];
  pinnedBeliefIds?: string[];
  noiseBeliefIds?: string[];
  driftScore?: number;
  retrievalPrecision: number | null;
  retrievalRecall: number | null;
  pinnedCoverage?: number | null;
  passed: boolean;
  failures: string[];
  retrievalLatencyMs: number;
}

function scoreRetrievalCase(tc: RetrievalCase, ctx: BuiltContext, ms: number): Entry {
  const pinnedIds = new Set(ctx.pinned);
  const relevantIds = new Set(ctx.relevant);
  const questionIds = new Set(ctx.questions);
  const unionIds = new Set([...pinnedIds, ...relevantIds]);
  const failures: string[] = [];
  const check = (cond: boolean, msg: string) => {
    if (!cond) failures.push(msg);
  };

  const rb = tc.expect.relevantBeliefs ?? {};
  for (const id of rb.mustInclude ?? []) check(unionIds.has(id), `missing expected belief: ${id}`);
  for (const id of rb.mustExclude ?? [])
    check(!unionIds.has(id), `forbidden belief surfaced: ${id}`);
  for (const id of rb.shouldInclude ?? [])
    check(unionIds.has(id), `expected belief missing (shouldInclude): ${id}`);
  if (rb.shouldOnlyInclude) {
    const expected = new Set(rb.shouldOnlyInclude);
    for (const id of relevantIds)
      check(expected.has(id), `unexpected belief in relevantBeliefs: ${id}`);
    for (const id of expected) check(relevantIds.has(id), `missing expected belief: ${id}`);
  }
  if (rb.maxCount != null)
    check(
      relevantIds.size <= rb.maxCount,
      `relevantBeliefs count ${relevantIds.size} > maxCount ${rb.maxCount}`,
    );
  if (rb.minCount != null)
    check(
      relevantIds.size >= rb.minCount,
      `relevantBeliefs count ${relevantIds.size} < minCount ${rb.minCount}`,
    );
  for (const [a, b] of rb.orderedBefore ?? []) {
    const ia = ctx.relevant.indexOf(a);
    const ib = ctx.relevant.indexOf(b);
    check(ia !== -1, `orderedBefore: ${a} not in relevantBeliefs`);
    check(ib !== -1, `orderedBefore: ${b} not in relevantBeliefs`);
    if (ia !== -1 && ib !== -1)
      check(ia < ib, `ranking: ${a} (idx ${ia}) should precede ${b} (idx ${ib})`);
  }

  const pf = tc.expect.pinnedFacts ?? {};
  for (const id of pf.mustInclude ?? []) check(pinnedIds.has(id), `missing pinned belief: ${id}`);
  for (const id of pf.mustExclude ?? [])
    check(!pinnedIds.has(id), `forbidden belief in pinnedFacts: ${id}`);

  const oq = tc.expect.openQuestions ?? {};
  for (const id of oq.mustInclude ?? [])
    check(questionIds.has(id), `missing expected question: ${id}`);
  for (const id of oq.mustExclude ?? [])
    check(!questionIds.has(id), `forbidden question surfaced: ${id}`);

  const pp = tc.expect.personaPrelude;
  if (pp?.nonEmpty) check(ctx.personaPrelude.length > 0, "personaPrelude empty");
  if (pp?.isNull) check(ctx.personaPrelude === "", "personaPrelude not empty");
  for (const s of pp?.contains ?? [])
    check(ctx.personaPrelude.includes(s), `personaPrelude missing "${s}"`);
  for (const s of pp?.mustNotContain ?? [])
    check(!ctx.personaPrelude.includes(s), `personaPrelude contains "${s}"`);

  const pinnedInSeed = new Set(
    [...fixture.values()]
      .filter((b) => b.pinned === true && b.user_id === USER_ID)
      .map((b) => b._id),
  );
  const expectedRelevant = rb.shouldOnlyInclude
    ? new Set(rb.shouldOnlyInclude)
    : new Set((rb.mustInclude ?? []).filter((id) => !pinnedInSeed.has(id)));
  const hits = [...expectedRelevant].filter((id) => relevantIds.has(id)).length;
  const retrievalPrecision =
    relevantIds.size === 0 && expectedRelevant.size === 0
      ? null
      : relevantIds.size === 0
        ? 0.0
        : hits / relevantIds.size;
  const retrievalRecall = expectedRelevant.size === 0 ? null : hits / expectedRelevant.size;
  const expectedPinned = new Set(pf.mustInclude ?? []);
  const pinnedHits = [...expectedPinned].filter((id) => pinnedIds.has(id)).length;

  return {
    caseId: tc.caseId,
    category: tc.category,
    description: tc.description,
    pinnedBeliefs: [...pinnedIds],
    relevantBeliefs: [...relevantIds],
    retrievedQuestions: [...questionIds],
    retrievalPrecision,
    retrievalRecall,
    pinnedCoverage: expectedPinned.size === 0 ? null : pinnedHits / expectedPinned.size,
    passed: failures.length === 0,
    failures,
    retrievalLatencyMs: ms,
  };
}

function scoreSessionTurn(caseId: string, turn: SessionTurn, ctx: BuiltContext, ms: number): Entry {
  const pinnedIds = new Set(ctx.pinned);
  const relevantIds = new Set(ctx.relevant);
  const questionIds = new Set(ctx.questions);
  const failures: string[] = [];
  const check = (cond: boolean, msg: string) => {
    if (!cond) failures.push(msg);
  };

  const rb = turn.expect.relevantBeliefs;
  if (rb) {
    if (rb.shouldOnlyInclude) {
      const expected = new Set(rb.shouldOnlyInclude);
      for (const id of relevantIds)
        check(expected.has(id), `turn ${turn.turnIndex}: unexpected relevant belief: ${id}`);
      for (const id of expected)
        check(relevantIds.has(id), `turn ${turn.turnIndex}: missing expected belief: ${id}`);
    }
    for (const id of rb.mustInclude ?? [])
      check(
        relevantIds.has(id) || pinnedIds.has(id),
        `turn ${turn.turnIndex}: missing belief: ${id}`,
      );
    for (const id of rb.mustExclude ?? [])
      check(
        !relevantIds.has(id) && !pinnedIds.has(id),
        `turn ${turn.turnIndex}: forbidden belief: ${id}`,
      );
  }
  for (const id of turn.expect.pinnedFacts?.mustInclude ?? [])
    check(pinnedIds.has(id), `turn ${turn.turnIndex}: missing pinned: ${id}`);
  for (const id of turn.expect.pinnedFacts?.mustExclude ?? [])
    check(!pinnedIds.has(id), `turn ${turn.turnIndex}: forbidden pinned: ${id}`);
  for (const id of turn.expect.openQuestions?.mustInclude ?? [])
    check(questionIds.has(id), `turn ${turn.turnIndex}: missing question: ${id}`);
  for (const id of turn.expect.openQuestions?.mustExclude ?? [])
    check(!questionIds.has(id), `turn ${turn.turnIndex}: forbidden question: ${id}`);

  const noiseBeliefIds: string[] = [];
  for (const id of turn.expect.noiseCheck?.mustNotSurface ?? []) {
    if (relevantIds.has(id) || pinnedIds.has(id)) {
      noiseBeliefIds.push(id);
      failures.push(`turn ${turn.turnIndex}: noise belief surfaced: ${id}`);
    }
  }

  const goldSet = rb?.shouldOnlyInclude
    ? new Set(rb.shouldOnlyInclude)
    : new Set(rb?.mustInclude ?? []);
  const hits = [...goldSet].filter((id) => relevantIds.has(id) || pinnedIds.has(id)).length;
  const retrievalRecall = goldSet.size === 0 ? null : hits / goldSet.size;
  const retrievalPrecision = relevantIds.size === 0 ? null : hits / relevantIds.size;

  return {
    caseId,
    category: "Session-level noise isolation",
    turnIndex: turn.turnIndex,
    label: turn.label,
    retrievedBeliefIds: [...relevantIds],
    pinnedBeliefIds: [...pinnedIds],
    noiseBeliefIds,
    driftScore: retrievalPrecision !== null ? 1 - retrievalPrecision : 0,
    retrievalPrecision,
    retrievalRecall,
    passed: failures.length === 0,
    failures,
    retrievalLatencyMs: ms,
  };
}

// buildRetrievalSummary, ported — identical aggregate shape for leaderboard-comparable JSON
const STRUCTURAL = new Set([
  "Scope disambiguation",
  "Supersession chain exclusion",
  "Type routing and open questions",
  "Budget eviction and capacity",
  "Cross-user isolation",
  "Ranking stability",
  "Persona prelude content",
]);

function summarize(entries: Entry[], caseCount: number, turnCount?: number) {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const r4 = (x: number) => Math.round(x * 10000) / 10000;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
  const lat = entries.map((e) => e.retrievalLatencyMs).sort((a, b) => a - b);
  const prec = entries.map((e) => e.retrievalPrecision).filter((v): v is number => v !== null);
  const rec = entries.map((e) => e.retrievalRecall).filter((v): v is number => v !== null);
  const passTypes = { activeRetrieval: 0, structural: 0, triviallyEmpty: 0 };
  for (const e of entries) {
    if (!e.passed) continue;
    if (e.retrievalPrecision !== null && e.retrievalPrecision > 0) passTypes.activeRetrieval++;
    else if (STRUCTURAL.has(e.category)) passTypes.structural++;
    else passTypes.triviallyEmpty++;
  }
  const byCat = new Map<string, Entry[]>();
  for (const e of entries) byCat.set(e.category, [...(byCat.get(e.category) ?? []), e]);
  const totalPassed = entries.filter((e) => e.passed).length;
  return {
    meanLatencyMs: r2(mean(lat) ?? 0),
    p50LatencyMs: lat[Math.ceil(0.5 * lat.length) - 1] ?? 0,
    p95LatencyMs: lat[Math.ceil(0.95 * lat.length) - 1] ?? 0,
    caseCount,
    ...(turnCount !== undefined ? { turnCount } : {}),
    meanPrecision: prec.length ? r4(mean(prec)!) : null,
    meanRecall: rec.length ? r4(mean(rec)!) : null,
    totalPassed,
    totalCases: entries.length,
    passRate: entries.length ? r4(totalPassed / entries.length) : null,
    activeRetrievalPasses: passTypes.activeRetrieval,
    passTypes,
    categories: [...byCat.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([category, es]) => {
        const cp = es.map((e) => e.retrievalPrecision).filter((v): v is number => v !== null);
        const cr = es.map((e) => e.retrievalRecall).filter((v): v is number => v !== null);
        return {
          category,
          caseCount: es.length,
          passed: es.filter((e) => e.passed).length,
          failed: es.filter((e) => !e.passed).length,
          meanPrecision: cp.length ? r4(mean(cp)!) : null,
          meanRecall: cr.length ? r4(mean(cr)!) : null,
        };
      }),
  };
}

// ---------------------------------------------------------------- main

async function guard(): Promise<void> {
  if (
    !process.env.EVAL_PMB_DATABASE_URL ||
    process.env.DATABASE_URL !== process.env.EVAL_PMB_DATABASE_URL
  ) {
    console.error(
      "ERROR: refusing to run — start with DATABASE_URL=EVAL_PMB_DATABASE_URL (scratch DB; the pool binds at module load).",
    );
    process.exit(2);
  }
  const { sql } = await import("../src/db/client");
  const [{ db }] = (await sql`select current_database() as db`) as unknown as [{ db: string }];
  if (!/eval/i.test(db)) {
    console.error(`ERROR: refusing to run — connected database "${db}" is not a scratch eval DB.`);
    process.exit(2);
  }
  // precision is the whole benchmark: a silently degraded reranker turns autocut into a
  // no-op and the run measures fixed top-K instead (same loud-failure rule as the other runners)
  const { rerankEnabled, rerankProbe } = await import("../src/search/rerank");
  let rerankActive = false;
  if (rerankEnabled()) {
    rerankActive = await rerankProbe();
    if (!rerankActive) {
      console.error(
        "ERROR: RERANK_URL is set but the probe call failed — fix the server or unset.",
      );
      process.exit(2);
    }
  }
  console.error(
    `PrecisionMemBench: db=${db} rerank=${rerankActive ? `on (${process.env.RERANK_MODEL ?? "bge-reranker-v2-m3"}) + autocut` : "OFF — fixed top-K baseline"}`,
  );
}

async function seedAll(beliefs: Belief[]): Promise<void> {
  const { resetDb } = await import("../test/helpers"); // drop + migrate, sanctioned reset path
  await resetDb();
  fixture.clear();
  pathByBelief.clear();
  for (const b of beliefs) await upsertBelief(b);
  await embedBacklog();
}

async function main(): Promise<number> {
  await guard();
  const outDir = flag("out", join(process.env.TMPDIR ?? "/tmp", "minime-pmb"));
  mkdirSync(outDir, { recursive: true });
  const fx = (name: string) => JSON.parse(readFileSync(join(PMB_DIR, "fixtures", name), "utf8"));
  const beliefs = fx("beliefs.seed.json") as Belief[];
  const retrievalCases = fx("retrieval.cases.json") as RetrievalCase[];
  const sessionCases = fx("session-retrieval.cases.json") as SessionCase[];

  console.error(`seeding ${beliefs.length} beliefs (retrieval suite)...`);
  await seedAll(beliefs);
  const entries: Entry[] = [];
  for (const tc of retrievalCases) {
    const t0 = performance.now();
    const ctx = await buildContext(tc.userId ?? USER_ID, tc.scope, tc.query, tc.budget);
    const e = scoreRetrievalCase(tc, ctx, Math.round((performance.now() - t0) * 100) / 100);
    entries.push(e);
    console.error(`  ${e.passed ? "ok  " : "FAIL"} ${tc.caseId}`);
  }
  writeFileSync(
    join(outDir, "retrieval-report-minime.json"),
    JSON.stringify(
      {
        provider: "minime",
        retrieval: summarize(entries, retrievalCases.length),
        cases: entries,
      },
      null,
      2,
    ),
  );

  console.error("re-seeding (session suite)...");
  await seedAll(beliefs);
  const turns: Entry[] = [];
  for (const sc of sessionCases) {
    for (const turn of sc.turns) {
      const t0 = performance.now();
      const ctx = await buildContext(USER_ID, turn.scope, turn.userMessage, {}, "session");
      const e = scoreSessionTurn(
        sc.caseId,
        turn,
        ctx,
        Math.round((performance.now() - t0) * 100) / 100,
      );
      turns.push(e);
      console.error(`  ${e.passed ? "ok  " : "FAIL"} ${sc.caseId} turn ${turn.turnIndex}`);
      if (turn.createBeliefAtTurn) {
        await upsertBelief(turn.createBeliefAtTurn);
        await embedBacklog();
      }
      if (turn.updateBeliefAtTurn?.addAliases?.length) {
        const b = fixture.get(turn.updateBeliefAtTurn.beliefId);
        if (b) {
          b.aliases = [
            ...new Set([
              ...(b.aliases ?? []),
              ...turn.updateBeliefAtTurn.addAliases.map((a) => a.trim().toLowerCase()),
            ]),
          ];
          await upsertBelief(b);
          await embedBacklog();
        }
      }
    }
  }
  writeFileSync(
    join(outDir, "session-retrieval-report-minime.json"),
    JSON.stringify(
      {
        provider: "minime",
        retrieval: summarize(turns, sessionCases.length, turns.length),
        cases: turns,
      },
      null,
      2,
    ),
  );

  const passed = entries.filter((e) => e.passed).length;
  const tPassed = turns.filter((e) => e.passed).length;
  console.error(
    `retrieval: ${passed}/${entries.length} — session turns: ${tPassed}/${turns.length} — reports in ${outDir}`,
  );
  const { closeDb } = await import("../src/db/client");
  await closeDb();
  return 0;
}

process.exit(await main());
