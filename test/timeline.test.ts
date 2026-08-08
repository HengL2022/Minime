// minime_timeline (W3-3): tier-gated date-range read across calendar, closed tasks, decisions,
// and (once unlocked) journal/interactions. All fixture rows use fixed 2020-03 instants so the
// window/ordering assertions never depend on the real wall clock — the one exception is the
// dropped-task anchor case below, which reads Postgres's own `updated_at` trigger back rather
// than fighting it (see the comment on that test).

import { beforeAll, describe, expect, test } from "bun:test";
import {
  ensurePerson,
  insertDecision,
  insertHealthSample,
  insertInteraction,
  insertJournal,
  insertTransaction,
  upsertCalendarEvent,
  upsertTask,
} from "../src/db/repo";
import { toolByName } from "../src/mcp/tools";
import { type ToolCtx, type ToolResult, invokeTool } from "../src/mcp/tools/registry";
import { setNow } from "../src/util/clock";
import { resetDb, testSql } from "./helpers";
import { requestAndApproveTier2, sessionToolCtx } from "./support/unlock";

const lockedCtx: ToolCtx = { actor: "agent:timeline-locked" };
const MAIN_FROM = "2020-03-05";
const MAIN_TO = "2020-03-25";

function call(params: Record<string, unknown>, ctx: ToolCtx = lockedCtx): Promise<ToolResult> {
  return invokeTool(toolByName("minime_timeline"), { time_zone: "UTC", ...params }, ctx);
}

function okData(result: ToolResult): any {
  if (!result.ok)
    throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result.envelope.data;
}

let calIds: string[] = [];
let doneTaskId: string;
let decisionInId: string;
let journalInId: string;
let interactionInId: string;

beforeAll(async () => {
  await resetDb();

  // --- calendar: five in-window rows (pagination set) + one before, one after the window ---
  const calSpecs: [string, string][] = [
    ["Timeline cal A", "2020-03-10T09:00:00Z"],
    ["Timeline cal B", "2020-03-11T09:00:00Z"],
    ["Timeline cal C", "2020-03-12T09:00:00Z"],
    ["Timeline cal D", "2020-03-13T09:00:00Z"],
    ["Timeline cal E", "2020-03-14T09:00:00Z"],
  ];
  calIds = [];
  for (const [title, iso] of calSpecs) {
    const at = new Date(iso);
    await upsertCalendarEvent({
      uid: `timeline-test-${title.replace(/\s+/g, "-")}@minime`,
      occurrenceStart: at,
      startsAt: at,
      title,
    });
  }
  const calRows =
    await testSql`select id, title from calendar_events where title like 'Timeline cal %' order by starts_at`;
  calIds = calRows.map((r: any) => r.id as string);
  const calBeforeAt = new Date("2020-02-01T09:00:00Z");
  await upsertCalendarEvent({
    uid: "timeline-test-before@minime",
    occurrenceStart: calBeforeAt,
    startsAt: calBeforeAt,
    title: "Timeline cal before window",
  });
  const calAfterAt = new Date("2020-04-01T09:00:00Z");
  await upsertCalendarEvent({
    uid: "timeline-test-after@minime",
    occurrenceStart: calAfterAt,
    startsAt: calAfterAt,
    title: "Timeline cal after window",
  });

  // --- task: one closed (done) in window, anchored on completed_at; one never-closed (must
  // never appear regardless of window, since minime_timeline only shows CLOSED tasks) ---
  setNow(new Date("2020-03-17T10:00:00Z"));
  const done = await upsertTask({ title: "Timeline task done", status: "done", source: "test" });
  setNow(null);
  doneTaskId = done.id;
  const open = await upsertTask({ title: "Timeline task open", status: "active", source: "test" });
  void open;

  // --- decision: one in window (decided_at), one after the window ---
  const decisionIn = await insertDecision({
    question: "Timeline decision in window",
    options: ["yes", "no"],
    choice: "yes",
    decidedAt: new Date("2020-03-19T09:00:00Z"),
    source: "test",
  });
  decisionInId = decisionIn.id;
  await insertDecision({
    question: "Timeline decision out of window",
    options: ["yes", "no"],
    choice: "yes",
    decidedAt: new Date("2020-04-05T09:00:00Z"),
    source: "test",
  });

  // --- journal (tier 2 default): one in window, one before it ---
  const journalIn = await insertJournal({
    entryMd: "Timeline journal entry in window.",
    at: new Date("2020-03-20T09:00:00Z"),
    source: "test",
  });
  journalInId = journalIn.id;
  await insertJournal({
    entryMd: "Timeline journal entry out of window.",
    at: new Date("2020-01-01T09:00:00Z"),
    source: "test",
  });

  // --- interaction (tier 2 default): one in window, one after it ---
  const person = await ensurePerson("Timeline Test Person", "human", "test");
  const interactionIn = await insertInteraction({
    personId: person.id,
    kind: "note",
    summary: "Timeline interaction in window.",
    occurredAt: new Date("2020-03-21T09:00:00Z"),
    source: "test",
  });
  interactionInId = interactionIn.id;
  await insertInteraction({
    personId: person.id,
    kind: "note",
    summary: "Timeline interaction out of window.",
    occurredAt: new Date("2020-05-01T09:00:00Z"),
    source: "test",
  });

  // --- tier 0: seeded INSIDE the window; must never surface via minime_timeline (I3) ---
  await insertTransaction({
    occurredAt: "2020-03-15",
    amountCents: -500,
    currency: "SGD",
    accountLabel: "timeline-test",
    externalRef: "timeline-test-tx-1",
  });
  await insertHealthSample({
    kind: "steps",
    at: new Date("2020-03-15T06:00:00Z"),
    value: 4321,
    unit: "steps",
    source: "test",
  });
});

describe("minime_timeline", () => {
  test("is registered as an MCP tool", () => {
    expect(toolByName("minime_timeline").name).toBe("minime_timeline");
  });

  test("tier-1 (locked) actor: calendar/task/decision return in order and window; journal/interaction are absent with a locked-count gap", async () => {
    const data = okData(await call({ from: MAIN_FROM, to: MAIN_TO }));
    expect(data.rows.map((r: any) => [r.kind, r.title])).toEqual([
      ["calendar", "Timeline cal A"],
      ["calendar", "Timeline cal B"],
      ["calendar", "Timeline cal C"],
      ["calendar", "Timeline cal D"],
      ["calendar", "Timeline cal E"],
      ["task", "Timeline task done"],
      ["decision", "Timeline decision in window"],
    ]);
    expect(data.count).toBe(7);
    expect(data.locked).toEqual({ journal: 1, interaction: 1 });

    const result = await call({ from: MAIN_FROM, to: MAIN_TO });
    if (!result.ok) throw new Error("unexpected failure");
    expect(result.envelope.gaps).toEqual([
      "2 tier-2 entries in range are locked (1 journal, 1 interaction) — an owner-approved unlock (minime_unlock) would include them",
    ]);

    // citation type for a calendar row matches state.ts's existing "calendar_event" vocabulary,
    // even though the row's own `kind` (and the `types` filter) stay "calendar".
    const calSource = result.envelope.sources.find((s) => s.id === calIds[0]);
    expect(calSource?.type).toBe("calendar_event");
    const taskSource = result.envelope.sources.find((s) => s.id === doneTaskId);
    expect(taskSource?.type).toBe("task");
    const decisionSource = result.envelope.sources.find((s) => s.id === decisionInId);
    expect(decisionSource?.type).toBe("decision");
  });

  test("unlocked session additionally sees journal/interaction rows, still ordered by time, and reports zero locked", async () => {
    const ctx = sessionToolCtx("agent:timeline-unlocked");
    await requestAndApproveTier2(ctx);
    const result = await call({ from: MAIN_FROM, to: MAIN_TO }, ctx);
    const data = okData(result);
    expect(data.rows.map((r: any) => r.kind)).toEqual([
      "calendar",
      "calendar",
      "calendar",
      "calendar",
      "calendar",
      "task",
      "decision",
      "journal",
      "interaction",
    ]);
    expect(data.rows.map((r: any) => r.id)).toContain(journalInId);
    expect(data.rows.map((r: any) => r.id)).toContain(interactionInId);
    expect(data.locked).toEqual({ journal: 0, interaction: 0 });
    if (!result.ok) throw new Error("unexpected failure");
    expect(result.envelope.gaps).toBeUndefined();
  });

  test("types filter narrows both the rows and which kinds are counted as locked", async () => {
    // Locked journal/interaction rows genuinely exist in this window (previous test), but a
    // caller that never asked for those kinds must get no accounting for them at all.
    const result = await call({ from: MAIN_FROM, to: MAIN_TO, types: ["calendar"] });
    const data = okData(result);
    expect(data.rows.every((r: any) => r.kind === "calendar")).toBe(true);
    expect(data.rows).toHaveLength(5);
    expect(data.locked).toEqual({ journal: 0, interaction: 0 });
    if (!result.ok) throw new Error("unexpected failure");
    expect(result.envelope.gaps).toBeUndefined();
  });

  test("pagination is stable and deterministic across limit/offset with no gaps or overlap", async () => {
    const titles = async (offset: number) => {
      const data = okData(
        await call({ from: MAIN_FROM, to: MAIN_TO, types: ["calendar"], limit: 2, offset }),
      );
      return data.rows.map((r: any) => r.title);
    };
    expect(await titles(0)).toEqual(["Timeline cal A", "Timeline cal B"]);
    expect(await titles(2)).toEqual(["Timeline cal C", "Timeline cal D"]);
    expect(await titles(4)).toEqual(["Timeline cal E"]);
    expect(await titles(6)).toEqual([]);
  });

  test("from later than to is rejected as BAD_INPUT", async () => {
    const result = await call({ from: MAIN_TO, to: MAIN_FROM });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("BAD_INPUT");
  });

  test("tier-0 sources never appear even though transaction/health rows were seeded inside the window (I3)", async () => {
    const result = await call({ from: MAIN_FROM, to: MAIN_TO });
    const data = okData(result);
    const kinds = new Set(data.rows.map((r: any) => r.kind));
    expect(kinds.has("transaction")).toBe(false);
    expect(kinds.has("health")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("timeline-test-tx-1");
  });

  test("closed tasks anchor on completed_at when done, and on updated_at when dropped", async () => {
    // done: completed_at is stamped by app-level now() inside upsertTask, so it is fully
    // controllable via setNow() like every other fixture above.
    setNow(new Date("2020-06-01T10:00:00Z"));
    const done = await upsertTask({
      title: "Timeline anchor done task",
      status: "done",
      source: "test",
    });
    setNow(null);
    const doneResult = okData(
      await call({ from: "2020-05-30", to: "2020-06-03", types: ["task"] }),
    );
    expect(doneResult.rows.map((r: any) => r.id)).toEqual([done.id]);

    // dropped: updated_at is stamped by Postgres's own `now()` (the set_updated_at trigger /
    // column default), which setNow() cannot reach — read the real persisted value back and
    // query its own calendar day instead of trying to control it.
    const dropped = await upsertTask({
      title: "Timeline anchor dropped task",
      status: "dropped",
      source: "test",
    });
    const [droppedRow] = await testSql`select updated_at from tasks where id = ${dropped.id}`;
    const droppedDay = (droppedRow!.updated_at as Date).toISOString().slice(0, 10);
    const droppedResult = okData(await call({ from: droppedDay, to: droppedDay, types: ["task"] }));
    expect(droppedResult.rows.map((r: any) => r.id)).toEqual([dropped.id]);
  });
});
