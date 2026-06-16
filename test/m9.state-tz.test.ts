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
import { resetAndSeed, testSql as sql } from "./helpers";

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

describe("write-tool date anchoring (evening-review late-night regression)", () => {
  // Same UTC-boundary clock (00:30 local). These guard the write paths the
  // evening review uses when capturing the owner's reply: a journal/decision
  // created in the pre-dawn-local window must carry the LOCAL calendar day, not
  // the UTC slice (which would land on yesterday / off-by-one).

  test("minime_log_decision review_at is the LOCAL calendar date N days out", async () => {
    const expected = localDateStr(new Date(earlyLocal.getTime() + 30 * 86_400_000));
    const logged = await call("minime_log_decision", {
      question: "Late-night TZ guard: pick a lysis-buffer supplier?",
      options: ["Chinese domestic", "import"],
      review_in_days: 30,
    });
    const reviewAt = (logged.data as any).review_at;
    expect(reviewAt).toBe(expected);
    // And the persisted row agrees (no UTC re-truncation on the way to/from PG).
    const [row] =
      await sql`select review_at::text as r from decisions where id = ${(logged.data as any).decision_id}`;
    expect(String(row!.r)).toBe(expected);
  });

  test("minime_journal titles the entry with the LOCAL calendar day", async () => {
    const today = localDateStr(earlyLocal);
    const yesterdayUTC = earlyLocal.toISOString().slice(0, 10);
    const marker = "tz-guard-journal-marker-7f3a";
    const j = await call("minime_journal", { entry_md: `${marker} late night reflection` });
    const id = (j.data as any).journal_entry_id;
    // The title is embedded in the indexed chunk text; assert it carries local today.
    const rows =
      await sql`select text from chunks where parent_type = 'journal' and parent_id = ${id}`;
    const blob = rows.map((r: any) => r.text).join("\n");
    expect(blob).toContain(`Journal ${today}`);
    if (today !== yesterdayUTC) {
      expect(blob).not.toContain(`Journal ${yesterdayUTC}`);
    }
  });
});
