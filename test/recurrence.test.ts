// W3-1: task recurrence primitive + habit_streak metric.
//   - nextDue (src/util/recurrence.ts): pure date arithmetic, no DB.
//   - upsertTask's done-transition materialization (repo.ts): mints exactly one successor,
//     idempotently, with full I5 provenance.
//   - the watcher's "X — done" dedup-close path (watcher.ts fileRow) routes through the same
//     upsertTask materialization, since it is just another id-update to status='done'.
//   - the dream sweeper (dream.ts recurrenceBackfill, step 5b) backfills a done recurring task
//     that never went through upsertTask at all — the crash-safety net.
//   - habit_streak (migration 030): per-title labeled streak, live-only, tier-1 restricted (I3).

import { beforeAll, describe, expect, test } from "bun:test";
import { withDbTransaction } from "../src/db/client";
import { upsertTask } from "../src/db/repo";
import { toolByName } from "../src/mcp/tools";
import { queryMetric } from "../src/mcp/tools/metric";
import { invokeTool } from "../src/mcp/tools/registry";
import type { Classification } from "../src/pipeline/classify";
import { recurrenceBackfill } from "../src/pipeline/dream";
import { fileRow } from "../src/pipeline/watcher";
import { nextDue } from "../src/util/recurrence";
import { resetDb, testSql as sql } from "./helpers";
import { sessionToolCtx } from "./support/unlock";

beforeAll(async () => {
  await resetDb();
});

describe("nextDue", () => {
  test("daily: adds interval days, anchor unused", () => {
    expect(nextDue("daily", 1, null, "2026-08-03")).toBe("2026-08-04");
    expect(nextDue("daily", 3, "2020-01-01", "2026-08-03")).toBe("2026-08-06");
  });

  test("weekly: interval 2 stays locked to the anchor's weekday across the whole chain", () => {
    // 2026-08-03 and 2026-08-17 are both Mondays — the anchor equals due at first creation.
    expect(nextDue("weekly", 2, "2026-08-03", "2026-08-03")).toBe("2026-08-17");
    expect(nextDue("weekly", 2, "2026-08-03", "2026-08-17")).toBe("2026-08-31");
  });

  test("monthly: clamps the 31st into a shorter month, then recovers it next cycle", () => {
    expect(nextDue("monthly", 1, "2026-01-31", "2026-01-31")).toBe("2026-02-28");
    expect(nextDue("monthly", 1, "2026-01-31", "2026-02-28")).toBe("2026-03-31");
  });

  test("monthly: leap-year February clamps to the 29th", () => {
    expect(nextDue("monthly", 1, "2024-01-31", "2024-01-31")).toBe("2024-02-29");
  });

  test("yearly: same month/day next year; a leap-day anchor clamps in a non-leap year", () => {
    expect(nextDue("yearly", 1, "2026-03-15", "2026-03-15")).toBe("2027-03-15");
    expect(nextDue("yearly", 1, "2024-02-29", "2024-02-29")).toBe("2025-02-28");
  });

  test("null anchor falls back to fromDue's own phase", () => {
    expect(nextDue("daily", 1, null, "2026-08-03")).toBe("2026-08-04");
    expect(nextDue("weekly", 1, null, "2026-08-03")).toBe("2026-08-10");
  });

  test("rejects a non-positive or non-integer interval", () => {
    expect(() => nextDue("daily", 0, null, "2026-08-03")).toThrow();
    expect(() => nextDue("daily", 1.5, null, "2026-08-03")).toThrow();
  });
});

describe("upsertTask recurrence materialization", () => {
  test("done-transition materializes exactly one successor with full provenance; repeat done-updates never duplicate it", async () => {
    const [goal] = await sql`
      insert into goals (horizon, statement, source, created_by)
      values ('quarter', 'Recurrence test goal', 'fixture', 'fixture') returning id`;

    const { id } = await upsertTask({
      title: "Recurrence test: water the plants",
      status: "active",
      due: "2026-08-10",
      goalId: goal!.id,
      tier: 1,
      recurFreq: "weekly",
      recurInterval: 1,
      source: "test",
    });

    // create-time default: recur_anchor takes the due date supplied in the same call.
    const [created] = await sql`select recur_anchor from tasks where id = ${id}`;
    expect(created!.recur_anchor?.toISOString().slice(0, 10)).toBe("2026-08-10");

    await upsertTask({ id, status: "done" });
    const successors = await sql`
      select title, due, source, derived_from, goal_id, tier, recur_freq, recur_interval,
             created_by
      from tasks where derived_from = ${id} and source = 'recurrence'`;
    expect(successors.length).toBe(1);
    const successor = successors[0]!;
    expect(successor.title).toBe("Recurrence test: water the plants");
    expect(successor.due?.toISOString().slice(0, 10)).toBe("2026-08-17"); // +1 week, phase-locked
    expect(successor.goal_id).toBe(goal!.id);
    expect(successor.tier).toBe(1);
    expect(successor.recur_freq).toBe("weekly");
    expect(successor.recur_interval).toBe(1);
    expect(successor.created_by).toBe("system:recurrence");

    // A second done-update on the SAME already-done row (no reopen) must not duplicate —
    // guarded by wasDone, since the transition condition never re-fires.
    await upsertTask({ id, status: "done" });
    const stillOne = await sql`
      select id from tasks where derived_from = ${id} and source = 'recurrence'`;
    expect(stillOne.length).toBe(1);

    // Reopen (wasDone becomes false again) then re-done exercises the OTHER guard — the
    // "successor already exists" idempotency check — rather than the wasDone guard above.
    await upsertTask({ id, status: "active" });
    await upsertTask({ id, status: "done" });
    const stillOneAfterReopen = await sql`
      select id from tasks where derived_from = ${id} and source = 'recurrence'`;
    expect(stillOneAfterReopen.length).toBe(1);
  });
});

describe("minime_upsert_task tool surface", () => {
  test("recur_freq/recur_interval create a recurring task; completing it via the tool materializes a successor; 'none' clears recurrence", async () => {
    const ctx = sessionToolCtx("agent:recurrence-tool-test");
    const created = await invokeTool(
      toolByName("minime_upsert_task"),
      {
        title: "Recurrence tool test: floss",
        due: "2026-08-04",
        recur_freq: "daily",
        recur_interval: 2,
      },
      ctx,
    );
    if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
    const taskId = (created.envelope.data as any).task_id as string;

    const [row] = await sql`
      select recur_freq, recur_interval, recur_anchor from tasks where id = ${taskId}`;
    expect(row!.recur_freq).toBe("daily");
    expect(row!.recur_interval).toBe(2);
    expect(row!.recur_anchor?.toISOString().slice(0, 10)).toBe("2026-08-04"); // create-time default

    const done = await invokeTool(
      toolByName("minime_upsert_task"),
      { id: taskId, status: "done" },
      ctx,
    );
    expect(done.ok).toBe(true);
    const successors = await sql`
      select id, due, recur_freq from tasks where derived_from = ${taskId} and source = 'recurrence'`;
    expect(successors.length).toBe(1);
    expect(successors[0]!.due?.toISOString().slice(0, 10)).toBe("2026-08-06"); // +2 days
    expect(successors[0]!.recur_freq).toBe("daily");

    // "none" (not a bare null) clears recurrence going forward — distinct from omitting the
    // key entirely, which keeps whatever recur_freq the row already had.
    const successorId = successors[0]!.id as string;
    const cleared = await invokeTool(
      toolByName("minime_upsert_task"),
      { id: successorId, recur_freq: "none" },
      ctx,
    );
    expect(cleared.ok).toBe(true);
    const [afterClear] = await sql`select recur_freq from tasks where id = ${successorId}`;
    expect(afterClear!.recur_freq).toBeNull();
  });
});

describe("watcher fileRow done-close path", () => {
  test("an 'X — done' capture that closes a matching recurring task materializes its successor", async () => {
    const { id } = await upsertTask({
      title: "Recurrence test: submit weekly report",
      status: "active",
      due: "2026-08-05",
      recurFreq: "weekly",
      recurInterval: 1,
      source: "test",
    });

    const classification: Classification = {
      type: "task",
      confidence: 0.95,
      fields: { title: "Recurrence test: submit weekly report", due: null },
    };
    const result = await withDbTransaction(() =>
      fileRow(
        classification,
        "Recurrence test: submit weekly report — done",
        crypto.randomUUID(),
        "agent:test",
      ),
    );
    if (result === null || result === "duplicate") {
      throw new Error(`expected fileRow to close the existing task, got ${String(result)}`);
    }
    expect(result.primary).toEqual(["tasks", id]);

    const [closed] = await sql`select status from tasks where id = ${id}`;
    expect(closed!.status).toBe("done");

    const successors = await sql`
      select due from tasks where derived_from = ${id} and source = 'recurrence'`;
    expect(successors.length).toBe(1);
    expect(successors[0]!.due?.toISOString().slice(0, 10)).toBe("2026-08-12");
  });
});

describe("dream recurrence sweeper (step 5b, crash-safety net)", () => {
  test("backfills a done recurring task that never went through upsertTask, then is idempotent", async () => {
    const orphanId = crypto.randomUUID();
    await sql`
      insert into tasks
        (id, title, status, due, completed_at, recur_freq, recur_interval, recur_anchor,
         source, created_by, tier)
      values
        (${orphanId}, 'Recurrence test: orphaned daily habit', 'done', '2026-08-01',
         '2026-08-01T09:00:00Z', 'daily', 1, '2026-08-01', 'test', 'fixture', 1)`;

    const materialized = await recurrenceBackfill();
    expect(materialized).toBe(1);

    const successors = await sql`
      select due, source, created_by from tasks where derived_from = ${orphanId}`;
    expect(successors.length).toBe(1);
    expect(successors[0]!.source).toBe("recurrence");
    expect(successors[0]!.created_by).toBe("system:recurrence");
    expect(successors[0]!.due?.toISOString().slice(0, 10)).toBe("2026-08-02");

    const again = await recurrenceBackfill();
    expect(again).toBe(0);
  });
});

describe("habit_streak metric", () => {
  test("queryMetric('habit_streak') returns per-title labeled streaks via the live path, tier-1 only", async () => {
    // Far-future dates (matching metric-time-semantics.test.ts's own 2099 convention) so this
    // query's fixed window can never coincide with another test's now()-derived completed_at.
    await sql`
      insert into tasks
        (title, status, due, completed_at, recur_freq, recur_interval, source, created_by, tier)
      values
        ('Meditate daily (recurrence test)', 'done', '2099-08-01', '2099-08-01T09:00:00Z',
         'daily', 1, 'test', 'fixture', 1),
        ('Meditate daily (recurrence test)', 'done', '2099-08-02', '2099-08-02T09:00:00Z',
         'daily', 1, 'test', 'fixture', 1),
        ('Meditate daily (recurrence test)', 'done', '2099-08-03', '2099-08-03T09:00:00Z',
         'daily', 1, 'test', 'fixture', 1),
        ('Stretch daily (recurrence test)', 'done', '2099-08-02', '2099-08-02T09:00:00Z',
         'daily', 1, 'test', 'fixture', 1),
        ('Confidential checkin (recurrence test)', 'done', '2099-08-02', '2099-08-02T09:00:00Z',
         'daily', 1, 'test', 'fixture', 2)`;

    const result = await queryMetric("habit_streak", "2099-08-01", "2099-08-03", "day", "UTC");
    expect((result.data as any).series).toEqual([
      { period_start: "2099-08-01", value: 1, label: "Meditate daily (recurrence test)" },
      { period_start: "2099-08-02", value: 2, label: "Meditate daily (recurrence test)" },
      { period_start: "2099-08-02", value: 1, label: "Stretch daily (recurrence test)" },
      { period_start: "2099-08-03", value: 3, label: "Meditate daily (recurrence test)" },
    ]);
    // I3: a tier-2 recurring task's title must never leak through this always-unlocked metric
    // path — minime_query_metric has no unlock gate of its own (metric_defs.agg_sql IS the
    // whitelist boundary), so the tier screen has to live in the query itself (migration 030).
    expect(JSON.stringify(result)).not.toContain("Confidential");
  });
});
