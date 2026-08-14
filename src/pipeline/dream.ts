// Nightly dream job (spec §10), 8 steps in order. Each step is best-effort: a failure is
// recorded and the remaining steps still run. Flags, never auto-resolves (step 3).

import { withAdminDbScope, withAdminDbTransaction, withDbTransaction } from "../db/client";
import {
  chunkPairsSharingPerson,
  clearDreamMetricRefreshWindow,
  decisionsNeedingReview,
  goalsNeedingReview,
  goalsWithoutChunks,
  highEdgeExtractOrgCandidates,
  highEdgeExtractOrgFlagKey,
  highEdgeExtractOrgRecentlyFlagged,
  insertReviewItem,
  listMetricDefs,
  logEvent,
  materializeRecurrence,
  parentsNeedingExtraction,
  phantomPersonCandidates,
  prepareMetricCache,
  recurringTasksNeedingSuccessor,
  reviewItemExists,
  runMetricAgg,
  staleItems,
  staleRecentlyFlagged,
  upsertMetricValue,
} from "../db/repo";
import { appendOpsLine } from "../ops/ops-log";
import { drainEmbedBacklog, indexParent } from "../search/index-parent";
import { auditPayload } from "../util/audit-payload";
import { configuredTimeZone, todayStr } from "../util/clock";
import { config } from "../util/config";
import { metricPeriodStart, reduceMetricSeries, shiftMetricDate } from "../util/metric-rollup";
import { backup } from "./backup";

const ACTOR = "system:dream";

// -- step 2: entity linking ------------------------------------------------

// Typed-edge extraction over the backlog: parents the per-write hook hasn't covered
// (rows written before this feature existed, or writes where extraction errored).
export async function entityLinkPass(limit = 500): Promise<number> {
  const { extractAndLink } = await import("./extract-edges");
  const parents = await parentsNeedingExtraction(limit);
  let linked = 0;
  for (const p of parents) {
    const stats = await extractAndLink(p.parent_type, p.parent_id, p.text, {
      tier: p.tier,
      derivedFrom: p.derived_from,
    }).catch(() => null);
    linked += stats?.edges ?? 0;
  }
  return linked;
}

// -- step 2d: goal search backfill -------------------------------------------
//
// insertGoal never indexes itself (unlike upsertTask/insertDecision, indexing is the caller's
// job) -- this drains whatever a caller missed, chiefly onboarding-era goals written before
// W3-12 and demo/fixture seed data, so they eventually become searchable. Bounded and
// idempotent (goalsWithoutChunks, repo.ts): a goal drops off the list as soon as it's indexed.
export async function goalBacklogIndex(limit = 200): Promise<number> {
  let indexed = 0;
  for (const goal of await goalsWithoutChunks(limit)) {
    const ok = await indexParent(
      "goal",
      goal.id,
      [goal.statement, goal.why ?? ""].filter(Boolean).join("\n\n"),
      goal.statement,
      goal.tier === 2 ? 2 : 1,
    )
      .then(() => true)
      .catch(() => false);
    if (ok) indexed++;
  }
  return indexed;
}

// -- step 3: contradiction scan --------------------------------------------

const ANTONYMS: [RegExp, RegExp][] = [
  [/\balways\b/i, /\bnever\b/i],
  [/\bloves?\b/i, /\bhates?\b/i],
  [/\bvegetarian\b/i, /\b(steak|meat[- ]eater)\b/i],
  [/\bmoved to\b/i, /\bstill lives in\b/i],
];

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
      // IDs only in the queue payload — flag, never auto-resolve
      await insertReviewItem("contradiction", {
        pair: `${p.a_id}:${p.b_id}`,
        person_id: p.person_id,
        chunk_ids: [p.a_id, p.b_id],
      });
      flagged++;
    }
  }
  return flagged;
}

// -- step 3b: phantom-person watchdog ---------------------------------------
//
// Safety net for the phantom-org bug. 015 + the classifier subject_type fix stop NEW
// vendors/companies from minting a person row on the write path; this scan catches any
// that slip through (a synced legacy capture, an MCP binding that can't pass subject_type,
// a model miss). Flags — never auto-retypes — so a human confirms via the review queue.
// Two independent signals:
//   1. name_match: the person shares a name/alias with an existing non-retired org.
//   2. company cue in the name (orgCue) AND zero human signal (no relation, no
//      interactions) — a bare "Glasswing Biotech"-shaped row nobody has ever interacted with.
export async function phantomPersonScan(): Promise<number> {
  const { orgCue } = await import("./classify");
  let flagged = 0;
  for (const c of await phantomPersonCandidates()) {
    const cueOnly = !c.has_human_signal && orgCue(c.canonical_name);
    if (!c.name_match && !cueOnly) continue;
    if (await reviewItemExists("phantom_person", "person_id", c.id)) continue;
    const reason = c.name_match
      ? "person shares a name with an existing organisation"
      : "name looks like a company and has no human interaction/relation signal";
    await insertReviewItem("phantom_person", {
      person_id: c.id,
      canonical_name: c.canonical_name,
      reason,
      suggestion: "retype to org, or dismiss if this really is a person",
    });
    flagged++;
  }
  return flagged;
}

// -- step 3d: high-edge extract-org watchdog --------------------------------
//
// Periodic audit for the class detectMistypedEntities misses: an extractor-minted org
// (including a single-token name like "Priya") that accreted an unusual number of edges
// and was never human-confirmed. Flag-only — never auto-retype or delete. Payload is
// ids + counts + a machine reason; no source text.
export async function highEdgeExtractOrgScan(): Promise<number> {
  let flagged = 0;
  for (const c of await highEdgeExtractOrgCandidates()) {
    if (await highEdgeExtractOrgRecentlyFlagged(c.id)) continue;
    await insertReviewItem("extract_suspect", {
      reason: "high_edge_extract_org",
      flag_key: highEdgeExtractOrgFlagKey(c.id),
      org: { type: "org", id: c.id, name: c.canonical_name },
      edge_count: c.edges,
      works_at_people: c.works_at_people,
    });
    flagged++;
  }
  return flagged;
}

// -- step 4: stale detection -------------------------------------------------
//
// staleItems(referencedSinceDays, untouchedDays) already applies the untouched-AND-referenced
// conjunction (repo.ts); this loop's own job is re-flag suppression. staleRecentlyFlagged
// (unlike the plain reviewItemExists other steps use) also counts recently-created dismissed
// items, so a dismissal stays quiet for its suppression window instead of being re-flagged the
// very next night (review-triage.md: "dismissed means dismissed").
export async function staleScan(): Promise<number> {
  let flagged = 0;
  for (const item of await staleItems(7, 180)) {
    if (await staleRecentlyFlagged(item.id)) continue;
    await insertReviewItem("stale", { id: item.id, type: item.type, label: item.label });
    flagged++;
  }
  return flagged;
}

// -- step 5b: recurrence crash-safety net ------------------------------------
//
// upsertTask's own done-transition materialization (repo.ts) already mints a recurring task's
// next instance inside the SAME transaction as the completing update, so this should normally
// find nothing. It exists for the path that transaction never ran at all — a done recurring
// task written by some future code that bypasses upsertTask, a restored/replayed row, or any
// other way status='done' could land without going through the one write path that knows to
// materialize. Runs before rollups (not lettered after 5 like the other N-vs-Nb steps) so a
// crash-recovered task's next due date is in place before the night's numbers are read.
export async function recurrenceBackfill(): Promise<number> {
  let materialized = 0;
  for (const task of await recurringTasksNeedingSuccessor()) {
    if (await withDbTransaction(() => materializeRecurrence(task))) materialized++;
  }
  return materialized;
}

// -- step 5: metric rollups -------------------------------------------------

export async function rollupMetrics(days = 90): Promise<number> {
  return withAdminDbScope(() =>
    withAdminDbTransaction(async () => {
      const ownerTimeZone = configuredTimeZone(config.tz);
      const to = todayStr(ownerTimeZone);
      const requestedFrom = shiftMetricDate(to, -days);
      const cacheChanged = await prepareMetricCache(ownerTimeZone);
      const weekFrom = metricPeriodStart(requestedFrom, "week");
      const monthFrom = metricPeriodStart(requestedFrom, "month");
      const weekTo = metricPeriodStart(to, "week");
      const monthTo = metricPeriodStart(to, "month");
      // A timezone switch rebuilds every source-backed Dream value. Ordinary refreshes read from
      // the earliest leading week/month boundary so a partial sliding window cannot erode a
      // closed period. Only the requested day window is rewritten during the ordinary path.
      const aggregateFrom = cacheChanged ? "0001-01-01" : [weekFrom, monthFrom].sort()[0]!;
      let written = 0;
      for (const def of await listMetricDefs()) {
        if (!def.agg_sql) continue;
        const daily = await runMetricAgg(def.name, aggregateFrom, to, ownerTimeZone);
        if (!cacheChanged) {
          await clearDreamMetricRefreshWindow({
            name: def.name,
            dayFrom: requestedFrom,
            dayTo: to,
            weekFrom,
            weekTo,
            monthFrom,
            monthTo,
          });
        }
        if (daily.some((r) => r.label !== null)) continue; // labeled metrics are live-only
        for (const r of daily) {
          if (!cacheChanged && r.period_start < requestedFrom) continue;
          await upsertMetricValue(def.name, r.period_start, "day", r.value, "dream");
          written++;
        }
        const weeklyDaily = cacheChanged
          ? daily
          : daily.filter((row) => row.period_start >= weekFrom);
        const monthlyDaily = cacheChanged
          ? daily
          : daily.filter((row) => row.period_start >= monthFrom);
        for (const row of reduceMetricSeries(weeklyDaily, "week", def.rollup))
          await upsertMetricValue(def.name, row.period_start, "week", row.value, "dream");
        for (const row of reduceMetricSeries(monthlyDaily, "month", def.rollup))
          await upsertMetricValue(def.name, row.period_start, "month", row.value, "dream");
      }
      return written;
    }),
  );
}

export async function enqueueDecisionReviews(asOfDate: string): Promise<number> {
  let queued = 0;
  for (const decision of await decisionsNeedingReview(asOfDate)) {
    if (await reviewItemExists("decision_review", "decision_id", decision.id)) continue;
    await insertReviewItem("decision_review", {
      decision_id: decision.id,
      question: decision.question,
    });
    queued++;
  }
  return queued;
}

// -- step 6b: goal reviews ----------------------------------------------------
//
// goal_review payload carries goal_id only (never the statement — review-queue.ts resolves it
// fresh at read time via visibleTitle, the same tier-aware path decision_review's question
// uses), so a locked-tier goal's wording is never written unmasked into review_queue.
export async function enqueueGoalReviews(): Promise<number> {
  let queued = 0;
  for (const goal of await goalsNeedingReview()) {
    if (await reviewItemExists("goal_review", "goal_id", goal.id)) continue;
    await insertReviewItem("goal_review", { goal_id: goal.id });
    queued++;
  }
  return queued;
}

// -- step 7: backup ----------------------------------------------------------

// re-export for callers that import backup from this module. `backup` itself is
// imported at the top (a bare `export ... from` creates no local binding, which
// would leave the step("7_backup", () => backup()) call below referencing nothing).
export { backup };

// -- orchestration -----------------------------------------------------------

// One dream step, best-effort: a thrown exception is recorded as the literal "failed" in the
// in-memory summary (printed by the owner CLI and reduced into the dream:summary audit event --
// auditPayload.dreamSummary filters by DREAM_STEPS key, never by this value) and, separately,
// as one sanitized line in the local owner-only ops log (data/logs/ops.log). Provider/SQL/
// filesystem exceptions may contain private prose or paths, so only the exception's own
// constructor name -- never error.message -- ever leaves this catch. Exported so tests can
// drive it directly without running the full dream() pipeline. appendOpsLine is itself
// best-effort (`.catch(() => {})`): a logging failure here must never stop the remaining steps.
export async function runDreamStep(
  summary: Record<string, unknown>,
  name: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    summary[name] = await fn();
  } catch (error) {
    summary[name] = "failed";
    const errorClass = error instanceof Error ? error.constructor.name : typeof error;
    await appendOpsLine({ step: name, errorClass }).catch(() => {});
  }
}

export async function dream(): Promise<Record<string, unknown>> {
  const summary: Record<string, unknown> = {};
  const step = (name: string, fn: () => Promise<unknown>) => runDreamStep(summary, name, fn);

  await step("1_embed_backlog", () => drainEmbedBacklog());
  await step("2_entity_link", () => entityLinkPass());
  await step("2b_compile_notes", async () => {
    try {
      const { compileNotes } = await import("./notes");
      const { candidates, created, updated, repaired, unchanged, failed } = await compileNotes();
      return { candidates, created, updated, repaired, unchanged, failed };
    } catch {
      return { candidates: 0, created: 0, updated: 0, repaired: 0, unchanged: 0, failed: 1 };
    }
  });
  await step("2c_compile_decision_digests", async () => {
    const { compileDecisionDigests } = await import("./decision-digest");
    const { candidates, compiled, skipped } = await compileDecisionDigests();
    return { candidates, compiled, skipped };
  });
  await step("2d_goal_backlog_index", () => goalBacklogIndex());
  await step("3_contradictions", () => contradictionScan());
  await step("3b_phantom_persons", () => phantomPersonScan());
  await step("3c_validate_edges", async () => {
    const { validateEdges } = await import("./validate-edges");
    return validateEdges();
  });
  await step("3d_high_edge_orgs", () => highEdgeExtractOrgScan());
  await step("4_stale", () => staleScan());
  await step("5b_recurrence", () => recurrenceBackfill());
  await step("5_rollups", () => rollupMetrics());
  await step("6_decision_reviews", () => enqueueDecisionReviews(todayStr(config.tz)));
  await step("6b_goal_reviews", () => enqueueGoalReviews());
  await step("7_backup", () => backup());

  // step 8: the summary event
  await logEvent({
    actor: ACTOR,
    verb: "dream:summary",
    payload: auditPayload.dreamSummary(summary),
  });
  return summary;
}
