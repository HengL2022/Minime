import { beforeEach, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { insertGoal, upsertTask } from "../src/db/repo";
import { compileGoalDigests } from "../src/pipeline/goal-digest";
import { hybridSearch } from "../src/search/hybrid";
import { config } from "../src/util/config";
import { resetDb, testSql as sql } from "./helpers";

async function digestPage(goalId: string): Promise<any | null> {
  const [row] = await sql`select * from pages where path = ${`derived/goals/${goalId}.md`}`;
  return row ?? null;
}

beforeEach(async () => {
  await resetDb();
});

describe("goal digest pages", () => {
  test("dream compiles a counts-only digest with provenance and a private archive", async () => {
    const { id: goalId } = await insertGoal({
      horizon: "quarter",
      statement: "Ship the fictional SILDRE wet-lab calibration kit",
      why: "The field season needs a repeatable gel protocol.",
      createdBy: "test",
    });
    await upsertTask({
      title: "Order spare hydrophone nodes",
      createdBy: "test",
      goalId,
    });
    const result = await compileGoalDigests();
    expect(result.compiled).toBe(1);
    const page = await digestPage(goalId);
    expect(page).not.toBeNull();
    expect(page.source).toBe("dream:goal-digest");
    expect(page.created_by).toBe("system:dream");
    expect(page.derived_from).toBe(goalId);
    expect(page.body_md).toContain("compiler: dream");
    expect(page.body_md).toContain("## Horizon\nquarter");
    expect(page.body_md).toContain("1 open / 0 done linked tasks.");
    expect(page.body_md).toContain(`- goal:${goalId}`);
    expect(page.body_md).not.toContain("Order spare hydrophone nodes");
    const archivePath = join(config.dataDir, "brain", page.path);
    expect((await stat(config.dataDir)).mode & 0o777).toBe(0o700);
    expect((await stat(dirname(archivePath))).mode & 0o777).toBe(0o700);
    expect((await stat(archivePath)).mode & 0o777).toBe(0o600);
  });

  test("a second run with no goal or task change is unchanged", async () => {
    const { id: goalId } = await insertGoal({
      horizon: "year",
      statement: "Keep the fictional kelp survey funded",
      createdBy: "test",
    });
    const first = await compileGoalDigests();
    expect(first.compiled).toBe(1);
    const before = await digestPage(goalId);
    const second = await compileGoalDigests();
    expect(second.compiled).toBe(0);
    const after = await digestPage(goalId);
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
  });

  test("a linked task change recompiles progress counts", async () => {
    const { id: goalId } = await insertGoal({
      horizon: "life",
      statement: "Stay a working scientist, not only a manager",
      createdBy: "test",
    });
    const { id: taskId } = await upsertTask({
      title: "Block Friday for lab time",
      createdBy: "test",
      goalId,
    });
    await compileGoalDigests();
    const before = await digestPage(goalId);
    expect(before.body_md).toContain("1 open / 0 done linked tasks.");
    await new Promise((r) => setTimeout(r, 10));
    await upsertTask({ id: taskId, title: "Block Friday for lab time", status: "done" });
    const result = await compileGoalDigests();
    expect(result.compiled).toBe(1);
    const after = await digestPage(goalId);
    expect(after.body_md).toContain("0 open / 1 done linked tasks.");
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });

  test("digest inherits the max linked-task tier and stays hidden while locked", async () => {
    const { id: goalId } = await insertGoal({
      horizon: "quarter",
      statement: "Finish the private appendix for the launch memo",
      createdBy: "test",
    });
    await upsertTask({
      title: "Draft the private appendix",
      createdBy: "test",
      goalId,
      tier: 2,
    });
    await compileGoalDigests();
    const page = await digestPage(goalId);
    expect(page.tier).toBe(2);
    expect(page.body_md).not.toContain("Draft the private appendix");
    const locked = await hybridSearch({
      query: "private appendix for the launch memo",
      types: ["page", "goal"],
      includeDerived: true,
      limit: 5,
      actor: "agent:locked",
    });
    expect(locked.some((h) => h.id === page.id)).toBe(false);
  });
});
