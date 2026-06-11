// Nightly dream job (spec §10), 8 steps in order. Each step is best-effort: a failure is
// recorded and the remaining steps still run. Flags, never auto-resolves (step 3).

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  chunkPairsSharingPerson,
  decisionsNeedingReview,
  insertReviewItem,
  listMetricDefs,
  logEvent,
  parentsNeedingExtraction,
  reviewItemExists,
  runMetricAgg,
  staleItems,
  upsertMetricValue,
} from "../db/repo";
import { drainEmbedBacklog } from "../search/index-parent";
import { now } from "../util/clock";
import { config } from "../util/config";

const ACTOR = "system:dream";

// -- step 2: entity linking ------------------------------------------------

// Typed-edge extraction over the backlog: parents the per-write hook hasn't covered
// (rows written before this feature existed, or writes where extraction errored).
export async function entityLinkPass(limit = 500): Promise<number> {
  const { extractAndLink } = await import("./extract-edges");
  const parents = await parentsNeedingExtraction(limit);
  let linked = 0;
  for (const p of parents) {
    const stats = await extractAndLink(p.parent_type, p.parent_id, p.text).catch(() => null);
    linked += stats?.edges ?? 0;
  }
  return linked;
}

// -- step 3: contradiction scan --------------------------------------------

const ANTONYMS: [RegExp, RegExp][] = [
  [/\balways\b/i, /\bnever\b/i],
  [/\bloves?\b/i, /\bhates?\b/i],
  [/\bvegetarian\b/i, /\b(steak|meat[- ]eater)\b/i],
  [/\bmoved to\b/i, /\bstill lives in\b/i],
];

async function claimsConflict(a: string, b: string): Promise<boolean> {
  if (config.mockOllama) {
    return ANTONYMS.some(([x, y]) => (x.test(a) && y.test(b)) || (y.test(a) && x.test(b)));
  }
  try {
    const { classifyProvider } = await import("../llm");
    const raw = await classifyProvider().completeJson(
      `Do these two statements about the same person contradict each other? Answer ONLY {"conflict": true} or {"conflict": false}.\nA: ${a.slice(0, 500)}\nB: ${b.slice(0, 500)}`,
    );
    return JSON.parse(raw).conflict === true;
  } catch {
    return false;
  }
}

export async function contradictionScan(limit = 100): Promise<number> {
  const { classifyIsCloud } = await import("../llm");
  const cloud = !config.mockOllama && classifyIsCloud();
  const pairs = await chunkPairsSharingPerson(limit);
  let flagged = 0;
  for (const p of pairs) {
    // tier gate (CLOUD_MAX_TIER): never send higher-tier chunk text to a cloud provider
    if (cloud && Math.max(p.a_tier, p.b_tier) > config.cloudMaxTier) continue;
    if (await reviewItemExists("contradiction", "pair", `${p.a_id}:${p.b_id}`)) continue;
    if (await claimsConflict(p.a_text, p.b_text)) {
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

// -- step 5: metric rollups -------------------------------------------------

export async function rollupMetrics(days = 90): Promise<number> {
  const to = now().toISOString().slice(0, 10);
  const from = new Date(now().getTime() - days * 86_400_000).toISOString().slice(0, 10);
  let written = 0;
  for (const def of await listMetricDefs()) {
    if (!def.agg_sql) continue;
    const daily = await runMetricAgg(def.name, from, to);
    if (daily.some((r) => r.label !== null)) continue; // labeled metrics are live-only
    const weekly = new Map<string, number>();
    const monthly = new Map<string, number>();
    for (const r of daily) {
      await upsertMetricValue(def.name, r.period_start, "day", r.value, "dream");
      written++;
      const d = new Date(`${r.period_start}T00:00:00Z`);
      const dow = (d.getUTCDay() + 6) % 7;
      const week = new Date(d.getTime() - dow * 86_400_000).toISOString().slice(0, 10);
      const month = `${r.period_start.slice(0, 7)}-01`;
      weekly.set(week, (weekly.get(week) ?? 0) + r.value);
      monthly.set(month, (monthly.get(month) ?? 0) + r.value);
    }
    for (const [start, value] of weekly)
      await upsertMetricValue(def.name, start, "week", value, "dream");
    for (const [start, value] of monthly)
      await upsertMetricValue(def.name, start, "month", value, "dream");
  }
  return written;
}

// -- step 7: backup ----------------------------------------------------------

async function run(
  cmd: string[],
  env?: Record<string, string>,
): Promise<{ ok: boolean; err: string }> {
  try {
    const proc = Bun.spawn(cmd, {
      env: { ...process.env, ...env },
      stdout: "ignore",
      stderr: "pipe",
    });
    const err = await new Response(proc.stderr).text();
    return { ok: (await proc.exited) === 0, err: err.slice(0, 500) };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

export async function backup(): Promise<{ ran: boolean; detail: string }> {
  if (!config.resticRepository || !config.resticPasswordFile) {
    return {
      ran: false,
      detail: "restic not configured (RESTIC_REPOSITORY / RESTIC_PASSWORD_FILE)",
    };
  }
  const which = await run(["sh", "-c", "command -v restic && command -v pg_dump"]);
  if (!which.ok) return { ran: false, detail: "restic or pg_dump binary not found" };

  const dumpDir = join(process.cwd(), "db-dump");
  await mkdir(dumpDir, { recursive: true });
  const dump = await run([
    "sh",
    "-c",
    `pg_dump "${config.databaseUrl}" > "${join(dumpDir, "minime.sql")}"`,
  ]);
  if (!dump.ok) return { ran: false, detail: `pg_dump failed: ${dump.err}` };

  const env = {
    RESTIC_REPOSITORY: config.resticRepository,
    RESTIC_PASSWORD_FILE: config.resticPasswordFile,
  };
  const bk = await run(["restic", "backup", config.dataDir, dumpDir], env);
  if (!bk.ok) return { ran: false, detail: `restic backup failed: ${bk.err}` };
  await run(
    [
      "restic",
      "forget",
      "--prune",
      "--keep-daily",
      "7",
      "--keep-weekly",
      "8",
      "--keep-monthly",
      "24",
    ],
    env,
  );
  return { ran: true, detail: "backup + prune complete" };
}

// -- orchestration -----------------------------------------------------------

export async function dream(): Promise<Record<string, unknown>> {
  const summary: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      summary[name] = await fn();
    } catch (e) {
      summary[name] = `failed: ${e instanceof Error ? e.message : e}`;
    }
  };

  await step("1_embed_backlog", () => drainEmbedBacklog());
  await step("2_entity_link", () => entityLinkPass());
  await step("3_contradictions", () => contradictionScan());
  await step("4_stale", async () => {
    let flagged = 0;
    for (const item of await staleItems(7, 180)) {
      if (await reviewItemExists("stale", "id", item.id)) continue;
      await insertReviewItem("stale", { id: item.id, type: item.type, label: item.label });
      flagged++;
    }
    return flagged;
  });
  await step("5_rollups", () => rollupMetrics());
  await step("6_decision_reviews", async () => {
    let queued = 0;
    for (const d of await decisionsNeedingReview()) {
      if (await reviewItemExists("decision_review", "decision_id", d.id)) continue;
      await insertReviewItem("decision_review", { decision_id: d.id, question: d.question });
      queued++;
    }
    return queued;
  });
  await step("7_backup", () => backup());

  // step 8: the summary event
  await logEvent({ actor: ACTOR, verb: "dream:summary", payload: summary });
  return summary;
}
