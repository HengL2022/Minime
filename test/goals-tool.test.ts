// W3-12: minime_upsert_goal, goals indexed at write, goals_active in minime_state, and the
// goal_review dream kind (migration 035). Mirrors m5.decisions.test.ts's direct-invokeTool style
// (no MCP transport needed to exercise a single tool's business logic) and stale-detection.test
// .ts's raw-SQL backdating convention for staleness fixtures.

import { beforeEach, describe, expect, test } from "bun:test";
import { toolByName } from "../src/mcp/tools";
import { invokeTool } from "../src/mcp/tools/registry";
import { dream, enqueueGoalReviews, goalBacklogIndex } from "../src/pipeline/dream";
import { hybridSearch } from "../src/search/hybrid";
import { resetDb, testSql as sql } from "./helpers";

const ctx = { actor: "agent:test-harness" };
const call = async (name: string, params: Record<string, unknown>) => {
  const r = await invokeTool(toolByName(name), params, ctx);
  if (!r.ok) throw new Error(`${name} failed: ${r.error.code} ${r.error.message}`);
  return r.envelope;
};

async function insertStaleGoal(
  statement: string,
  daysOld: number,
  status = "active",
): Promise<string> {
  const [row] = await sql`
    insert into goals (horizon, statement, status, source, created_by, updated_at)
    values ('year', ${statement}, ${status}, 'fixture', 'fixture',
            now() - make_interval(days => ${daysOld}))
    returning id::text as id`;
  return row!.id;
}

beforeEach(async () => {
  await resetDb();
});

describe("minime_upsert_goal: create", () => {
  test("creates a quarter goal — previously unreachable via any tool — and it becomes searchable", async () => {
    const created = await call("minime_upsert_goal", {
      horizon: "quarter",
      statement: "GOALQUARTERSENTINEL Ship the sensor prototype",
    });
    const goalId = (created.data as any).goal_id;
    expect(goalId).toBeString();

    const [row] = await sql`select horizon, statement, status from goals where id = ${goalId}`;
    expect(row).toMatchObject({
      horizon: "quarter",
      statement: "GOALQUARTERSENTINEL Ship the sensor prototype",
      status: "active",
    });

    const hits = await hybridSearch({ query: "GOALQUARTERSENTINEL sensor prototype", limit: 5 });
    expect(hits.some((h) => h.id === goalId && h.type === "goal")).toBe(true);
  });

  test("rejects a create call missing horizon or statement", async () => {
    const r = await invokeTool(
      toolByName("minime_upsert_goal"),
      { why: "no horizon or statement" },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.error.code).toBe("BAD_INPUT");
  });

  test("parent_id links a goal at creation; an explicit null clears it, omitting the key keeps it", async () => {
    const parent = await call("minime_upsert_goal", {
      horizon: "life",
      statement: "GOALPARENTSENTINEL Stay strong into old age",
    });
    const parentId = (parent.data as any).goal_id;
    const child = await call("minime_upsert_goal", {
      horizon: "year",
      statement: "GOALCHILDSENTINEL Run a marathon this year",
      parent_id: parentId,
    });
    const childId = (child.data as any).goal_id;
    const [linked] = await sql`select parent_id from goals where id = ${childId}`;
    expect(linked!.parent_id).toBe(parentId);

    // id-only update with no parent_id key: keeps the existing link
    await call("minime_upsert_goal", { id: childId, why: "training block" });
    const [kept] = await sql`select parent_id from goals where id = ${childId}`;
    expect(kept!.parent_id).toBe(parentId);

    // explicit null clears it
    await call("minime_upsert_goal", { id: childId, parent_id: null });
    const [cleared] = await sql`select parent_id from goals where id = ${childId}`;
    expect(cleared!.parent_id).toBeNull();
  });
});

describe("minime_upsert_goal: id-only update", () => {
  test("updates status to achieved without resending the statement, and reindexes the stored statement", async () => {
    const created = await call("minime_upsert_goal", {
      horizon: "life",
      statement: "GOALACHIEVEDSENTINEL Reach a clean promotion case",
    });
    const goalId = (created.data as any).goal_id;

    const updated = await call("minime_upsert_goal", { id: goalId, status: "achieved" });
    expect((updated.data as any).goal_id).toBe(goalId);

    const [row] = await sql`select statement, status from goals where id = ${goalId}`;
    expect(row).toMatchObject({
      statement: "GOALACHIEVEDSENTINEL Reach a clean promotion case",
      status: "achieved",
    });

    // The reindex on update must use the STORED statement, not the (omitted) params — an
    // id-only status update must never blank the search text.
    const hits = await hybridSearch({ query: "GOALACHIEVEDSENTINEL promotion case", limit: 5 });
    expect(hits.some((h) => h.id === goalId && h.type === "goal")).toBe(true);
  });

  test("updating an unknown goal id returns NOT_FOUND", async () => {
    const r = await invokeTool(
      toolByName("minime_upsert_goal"),
      { id: crypto.randomUUID(), status: "dropped" },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.error.code).toBe("NOT_FOUND");
  });
});

describe("minime_state: goals_active", () => {
  test("reports correct open-task counts and last activity; achieved goals are excluded", async () => {
    const goal = await call("minime_upsert_goal", {
      horizon: "year",
      statement: "GOALSTATESENTINEL Publish the seagrass paper",
    });
    const goalId = (goal.data as any).goal_id;
    await call("minime_upsert_task", { title: "Draft outline", goal_id: goalId, status: "active" });
    await call("minime_upsert_task", {
      title: "Collect samples",
      goal_id: goalId,
      status: "waiting",
    });
    await call("minime_upsert_task", { title: "Old draft", goal_id: goalId, status: "done" });

    const achieved = await call("minime_upsert_goal", {
      horizon: "year",
      statement: "GOALHIDDENSENTINEL Already done, should not appear",
    });
    await call("minime_upsert_goal", { id: (achieved.data as any).goal_id, status: "achieved" });

    const state = await call("minime_state", {});
    const goalsActive = (state.data as any).goals_active as any[];
    const entry = goalsActive.find((g) => g.id === goalId);
    expect(entry).toBeDefined();
    expect(entry.statement).toBe("GOALSTATESENTINEL Publish the seagrass paper");
    expect(entry.open_task_count).toBe(2); // active + waiting, not done
    expect(entry.last_task_activity_at).not.toBeNull();
    expect(new Date(entry.last_task_activity_at).getTime()).toBeGreaterThan(Date.now() - 60_000);

    expect(goalsActive.some((g) => g.statement?.includes("GOALHIDDENSENTINEL"))).toBe(false);

    const sources = state.sources.filter((s: any) => s.type === "goal");
    expect(sources.some((s: any) => s.id === goalId)).toBe(true);
  });
});

describe("goal_review (dream step 6b): staleness enqueue", () => {
  test("a 90d-stale active goal with no linked task activity produces exactly one goal_review item after dream, deduped on a second run", async () => {
    const goalId = await insertStaleGoal("GOALDREAMSENTINEL Hold a 15-minute conversation", 100);

    const summary = await dream();
    expect(summary["6b_goal_reviews"]).toBe(1);
    const queued = await sql`select count(*)::int as n from review_queue
      where kind = 'goal_review' and payload ->> 'goal_id' = ${goalId}`;
    expect(queued[0]!.n).toBe(1);

    const again = await dream();
    expect(again["6b_goal_reviews"]).toBe(0); // deduped, not double-queued
    const stillOne = await sql`select count(*)::int as n from review_queue
      where kind = 'goal_review' and payload ->> 'goal_id' = ${goalId}`;
    expect(stillOne[0]!.n).toBe(1);
  });

  test("a stale goal with a recently-updated linked task is not enqueued", async () => {
    const goalId = await insertStaleGoal("GOALLINKEDTASKSENTINEL train consistently", 100);
    await sql`insert into tasks (goal_id, title, status, updated_at)
      values (${goalId}::uuid, 'still working this goal', 'active', now())`;

    expect(await enqueueGoalReviews()).toBe(0);
    const queued = await sql`select count(*)::int as n from review_queue
      where kind = 'goal_review' and payload ->> 'goal_id' = ${goalId}`;
    expect(queued[0]!.n).toBe(0);
  });

  test("a recently-active goal is not enqueued", async () => {
    const goalId = await insertStaleGoal("GOALFRESHSENTINEL just set this", 0);
    expect(await enqueueGoalReviews()).toBe(0);
    const queued = await sql`select count(*)::int as n from review_queue
      where kind = 'goal_review' and payload ->> 'goal_id' = ${goalId}`;
    expect(queued[0]!.n).toBe(0);
  });

  test("a dropped goal is never enqueued even when stale", async () => {
    const goalId = await insertStaleGoal("GOALDROPPEDSENTINEL abandoned plan", 100, "dropped");
    expect(await enqueueGoalReviews()).toBe(0);
    const queued = await sql`select count(*)::int as n from review_queue
      where kind = 'goal_review' and payload ->> 'goal_id' = ${goalId}`;
    expect(queued[0]!.n).toBe(0);
  });
});

describe("minime_review_queue: goal_review rendering", () => {
  test("resolves the goal's statement fresh at the caller's tier (payload carries goal_id only)", async () => {
    const goalId = await insertStaleGoal("GOALQUEUESENTINEL keep the habit visible", 100);
    expect(await enqueueGoalReviews()).toBe(1);

    const [stored] = await sql`select payload from review_queue where kind = 'goal_review'
      and payload ->> 'goal_id' = ${goalId}`;
    expect(stored!.payload).toEqual({ goal_id: goalId }); // no statement stored at enqueue time

    const listed = await call("minime_review_queue", { action: "list", kind: "goal_review" });
    const items = (listed.data as any).items as any[];
    const item = items.find((i) => i.payload?.goal_id === goalId);
    expect(item).toBeDefined();
    expect(item.payload.statement).toBe("GOALQUEUESENTINEL keep the habit visible");
  });
});

describe("goal search backfill (dream step 2d)", () => {
  test("indexes a goal with no chunks yet (e.g. an onboarding-era or seed row), then is idempotent", async () => {
    const [row] = await sql`
      insert into goals (horizon, statement, why, source, created_by)
      values ('quarter', 'GOALBACKFILLSENTINEL Train for the marathon', 'keeps me honest',
              'fixture', 'fixture')
      returning id::text as id`;
    const goalId = row!.id;

    const before = await sql`select count(*)::int as n from chunks
      where parent_type = 'goal' and parent_id = ${goalId}::uuid`;
    expect(before[0]!.n).toBe(0);

    expect(await goalBacklogIndex()).toBeGreaterThanOrEqual(1);
    const after = await sql`select count(*)::int as n from chunks
      where parent_type = 'goal' and parent_id = ${goalId}::uuid`;
    expect(after[0]!.n).toBeGreaterThan(0);

    const hits = await hybridSearch({ query: "GOALBACKFILLSENTINEL marathon", limit: 5 });
    expect(hits.some((h) => h.id === goalId && h.type === "goal")).toBe(true);

    // idempotent: this goal already has chunks, so a second pass finds nothing left to index
    expect(await goalBacklogIndex()).toBe(0);
  });
});

describe("app-role least-privilege expansion (migration 035)", () => {
  test("minime_app has full table-wide UPDATE on goals", async () => {
    const rows = await sql`
      select 1 from information_schema.role_table_grants
      where grantee = 'minime_app' and table_name = 'goals' and privilege_type = 'UPDATE'`;
    expect(rows.length).toBe(1);
  });
});
