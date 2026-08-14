// Agenda tool: forward-looking task lookup that minime_state cannot do.
// Regression guard for the bug where "what's due tomorrow/Saturday" returned
// nothing because state is today-anchored (due <= today). Seed tasks have known
// future offsets: +1, +2, +5 (active), +12, +20 (inbox); -3 (waiting, past).
// "Order climbing chalk and finger tape" (inbox) has no due date at all — the
// undated-open-task case that include_undated surfaces.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { upsertTask } from "../src/db/repo";
import { toolByName } from "../src/mcp/tools";
import { invokeTool } from "../src/mcp/tools/registry";
import { localDateStr, setNow, todayStr } from "../src/util/clock";
import { resetAndSeed } from "./helpers";
import { requestAndApproveTier2, sessionToolCtx } from "./support/unlock";

const ctx = { actor: "agent:test-harness" };
const call = async (name: string, params: any) => {
  const r = await invokeTool(toolByName(name), params, ctx);
  if (!r.ok) throw new Error(`${name} failed: ${r.error.code} ${r.error.message}`);
  return r.envelope;
};

function addDays(isoDate: string, n: number): string {
  const parts = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

beforeAll(async () => {
  setNow(new Date()); // anchor "today" deterministically for the run
  await resetAndSeed();
});

afterAll(() => setNow(null));

describe("minime_agenda (forward-looking task lookup)", () => {
  test("is registered as an MCP tool", () => {
    expect(toolByName("minime_agenda").name).toBe("minime_agenda");
  });

  test("surfaces a FUTURE-dated task that minime_state (today-anchored) omits", async () => {
    const today = todayStr();
    const tomorrow = addDays(today, 1); // seed: "Water change for the aquarium" is due +1

    // state must NOT contain the +1 task (it only returns due <= today)
    const state = await call("minime_state", {});
    const stateTitles = (state.data as any).tasks_due.map((t: any) => t.title);
    expect(stateTitles).not.toContain("Water change for the aquarium");

    // agenda for [tomorrow, tomorrow] MUST contain it
    const agenda = await call("minime_agenda", { from: tomorrow, to: tomorrow });
    const titles = (agenda.data as any).tasks.map((t: any) => t.title);
    expect(titles).toContain("Water change for the aquarium");
    expect((agenda.data as any).by_day[tomorrow]).toBeDefined();
  });

  test("default window (no args) looks 7 days ahead and includes inbox/active/waiting", async () => {
    const agenda = await call("minime_agenda", {});
    const data = agenda.data as any;
    // default from=today, to=today+7 → catches +1, +2, +5 but NOT +12/+20
    const titles = data.tasks.map((t: any) => t.title);
    expect(titles).toContain("Water change for the aquarium"); // +1 active
    expect(titles).toContain("Send promotion case draft to Jordan"); // +2 active
    expect(titles).toContain("Book Tokyo accommodation near Shinjuku"); // +5 active
    expect(titles).not.toContain("Buy Kai's birthday microscope"); // +12, out of window
    expect(titles).not.toContain("Draft tech talk proposal"); // +20, out of window
    // byte-compat: omitting include_undated/status must not add undated rows or new statuses.
    expect(data.undated).toEqual([]);
  });

  test("default window anchors to the caller timezone when provided", async () => {
    const instant = new Date("2026-06-17T01:00:00.000Z");
    setNow(instant);
    try {
      const agenda = await call("minime_agenda", { time_zone: "America/Los_Angeles" });
      expect((agenda.data as any).from).toBe(localDateStr(instant, "America/Los_Angeles"));
    } finally {
      // Restore the real-now anchor the seed was built against. Without this the frozen
      // 2026-06-17 clock leaks into later tests, shifting their date windows off the seed's
      // future-dated tasks (+12/+20) and making them pass/fail depending on the calendar
      // date the suite runs — which is what broke the install workflow's `bun test` gate.
      setNow(new Date());
    }
  });

  test("explicit wide range includes inbox-status tasks and excludes done/dropped", async () => {
    const today = todayStr();
    const agenda = await call("minime_agenda", { from: today, to: addDays(today, 30) });
    const titles = (agenda.data as any).tasks.map((t: any) => t.title);
    expect(titles).toContain("Buy Kai's birthday microscope"); // +12 inbox → included
    expect(titles).toContain("Draft tech talk proposal"); // +20 inbox → included
    expect(titles).not.toContain("Schedule annual checkup with Dr. Ng"); // done → excluded
  });

  test("sources are populated for citation", async () => {
    const agenda = await call("minime_agenda", {});
    expect(agenda.sources.length).toBeGreaterThan(0);
    expect(agenda.sources[0]).toHaveProperty("id");
    expect(agenda.sources[0]!.type).toBe("task");
  });

  test("include_undated surfaces undated open tasks in `undated`, never in by_day, and cites them", async () => {
    // Without the flag: the undated seed task is invisible (matches pre-existing behavior).
    const without = await call("minime_agenda", {});
    const withoutTitles = (without.data as any).tasks.map((t: any) => t.title);
    expect(withoutTitles).not.toContain("Order climbing chalk and finger tape");

    const agenda = await call("minime_agenda", { include_undated: true });
    const data = agenda.data as any;
    const undatedTitles = data.undated.map((t: any) => t.title);
    expect(undatedTitles).toContain("Order climbing chalk and finger tape");

    // by_day keys are date strings (YYYY-MM-DD) — an undated task must never land in one.
    for (const day of Object.keys(data.by_day)) {
      expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(
        data.by_day[day].some((t: any) => t.title === "Order climbing chalk and finger tape"),
      ).toBe(false);
    }

    // count and sources include the undated task for citation.
    const undatedEntry = data.undated.find(
      (t: any) => t.title === "Order climbing chalk and finger tape",
    );
    expect(data.count).toBe(data.tasks.length);
    expect(agenda.sources.some((s) => s.id === undatedEntry.id)).toBe(true);
  });

  test("status filter narrows to the requested open statuses", async () => {
    const today = todayStr();
    // "Fix the dripping kitchen tap" is the only waiting-status seed task, due -3 (past),
    // so the range must reach back before today to catch it.
    const agenda = await call("minime_agenda", {
      from: addDays(today, -10),
      to: addDays(today, 30),
      status: ["waiting"],
    });
    const data = agenda.data as any;
    const titles = data.tasks.map((t: any) => t.title);
    expect(titles).toEqual(["Fix the dripping kitchen tap"]);
    for (const t of data.tasks) expect(t.status).toBe("waiting");
  });

  test("an undated tier-2 task stays hidden from include_undated until unlock (tier predicate)", async () => {
    const tierCtx = sessionToolCtx("agent:agenda-tier-test");
    const { id } = await upsertTask({
      title: "Undated tier-2 confidential follow-up",
      status: "inbox",
      due: null,
      tier: 2,
      source: "test",
    });

    const locked = await invokeTool(
      toolByName("minime_agenda"),
      { include_undated: true },
      tierCtx,
    );
    if (!locked.ok) throw new Error(`locked call failed: ${locked.error.code}`);
    const lockedIds = (locked.envelope.data as any).undated.map((t: any) => t.id);
    expect(lockedIds).not.toContain(id);

    await requestAndApproveTier2(tierCtx);
    const unlocked = await invokeTool(
      toolByName("minime_agenda"),
      { include_undated: true },
      tierCtx,
    );
    if (!unlocked.ok) throw new Error(`unlocked call failed: ${unlocked.error.code}`);
    const unlockedIds = (unlocked.envelope.data as any).undated.map((t: any) => t.id);
    expect(unlockedIds).toContain(id);
  });
});
