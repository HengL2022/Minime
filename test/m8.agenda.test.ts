// Agenda tool: forward-looking task lookup that minime_state cannot do.
// Regression guard for the bug where "what's due tomorrow/Saturday" returned
// nothing because state is today-anchored (due <= today). Seed tasks have known
// future offsets: +1, +2, +5 (active), +12, +20 (inbox); -3 (waiting, past).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toolByName } from "../src/mcp/tools";
import { invokeTool } from "../src/mcp/tools/registry";
import { setNow, todayStr } from "../src/util/clock";
import { resetAndSeed } from "./helpers";

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
});
