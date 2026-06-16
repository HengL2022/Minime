// Regression guard for the morning-brief wrong-date bug: stateSnapshot anchored
// "today" with `${now()}::date`, cast inside Postgres (session TZ = UTC). At
// 7am Asia/Singapore (= 23:00 UTC the previous day) that truncates to YESTERDAY,
// so a task due TODAY (local) silently drops out of tasks_due and the brief is
// stamped with the wrong day. The contract: a task due on the local calendar day
// must appear in minime_state regardless of the time of day it is queried.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toolByName } from "../src/mcp/tools";
import { invokeTool } from "../src/mcp/tools/registry";
import { localDateStr, setNow, todayStr } from "../src/util/clock";
import { resetAndSeed } from "./helpers";

const ctx = { actor: "agent:test-harness" };
const call = async (name: string, params: any) => {
  const r = await invokeTool(toolByName(name), params, ctx);
  if (!r.ok) throw new Error(`${name} failed: ${r.error.code} ${r.error.message}`);
  return r.envelope;
};

// Anchor "now" at 00:30 LOCAL today. In any positive-offset zone (Singapore is
// UTC+8) this instant's UTC calendar day is the PREVIOUS day — exactly the
// boundary that made the morning brief show yesterday's date.
const base = new Date();
const earlyLocal = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 30, 0);

beforeAll(async () => {
  setNow(earlyLocal);
  await resetAndSeed();
});

afterAll(() => setNow(null));

describe("minime_state date anchoring (morning-brief wrong-date regression)", () => {
  test("a task due on the LOCAL calendar day appears even when queried in the early-morning UTC-boundary window", async () => {
    // Seed has "Rent the 56mm lens for the weekend" with dueOffset 0 → due = local today.
    const state = await call("minime_state", {});
    const titles = (state.data as any).tasks_due.map((t: any) => t.title);
    expect(titles).toContain("Rent the 56mm lens for the weekend");
  });

  test("local and UTC calendar days actually differ at the anchored instant (test is meaningful here)", () => {
    // Documents WHY the first test bites: if this ever stops differing (e.g. run
    // in a UTC/negative-offset zone) the guard degrades to a trivially-true check
    // rather than silently passing for the wrong reason.
    const localDay = localDateStr(earlyLocal);
    const utcDay = earlyLocal.toISOString().slice(0, 10);
    expect(localDay).toBe(todayStr());
    // In UTC+8 these differ; we don't hard-fail elsewhere, just record the fact.
    if (localDay === utcDay) {
      console.warn("state-tz test running in a zone where local==UTC day; guard is weaker here");
    }
  });
});
