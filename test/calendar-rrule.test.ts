// W3-2 acceptance: RRULE/RDATE/EXDATE expansion keyed on (uid, occurrence_start) — FREQ=DAILY/
// WEEKLY/MONTHLY/YEARLY, INTERVAL/COUNT/UNTIL, WEEKLY BYDAY across a DST transition (local
// wall-clock preserved), EXDATE/RDATE, MONTHLY/YEARLY "skip, don't clamp" semantics, unsupported
// RRULE safe degrade + audit event, re-import idempotency, future-only pruning on a changed
// rule, and the migration 031 backfill.
//
// Each DB-backed test below owns a distinct uid and picks its own setNow() so tests never
// interfere with each other's rolling window (re-importing the SAME uid with a DIFFERENT "now"
// recomputes -- and may prune -- ALL of that uid's occurrences; see the dedicated pruning tests
// for that behavior exercised on purpose).

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import {
  applyCheckedOutMigration,
  ensureSchemaMigrationLedger,
  schemaMigrationNames,
  stateSnapshot,
} from "../src/db/repo";
import { importCalendar, parseIcs } from "../src/importers/calendar";
import {
  type RecurrenceDate,
  type RecurrenceStart,
  addCalendarDays,
  calendarDaysBetween,
  expandOccurrences,
} from "../src/importers/rrule";
import { setNow } from "../src/util/clock";
import { resetDb, testSql as sql } from "./helpers";
import { registerTestDatabaseCloser, testDatabaseUrl } from "./setup";
import {
  disposeTestDatabase,
  planTestDatabase,
  provisionTestDatabase,
} from "./support/test-database";

const FIXTURES = join(import.meta.dir, "../fixtures");
const FAR_WINDOW_END = new Date("2040-01-01T00:00:00.000Z"); // must clear the Feb-29 YEARLY test's 2036
// Before every DTSTART used below, so the windowStart-anchoring fast-forward (rrule.ts) is a
// no-op and every existing expectation below still walks the exact sequence from DTSTART.
const FAR_WINDOW_START = new Date("2000-01-01T00:00:00.000Z");

afterEach(() => setNow(null));

// ---------------------------------------------------------------- parseIcs capture

describe("parseIcs: RRULE/RDATE/EXDATE capture", () => {
  test("captures raw RRULE, multi-value RDATE/EXDATE with params, across folded lines", () => {
    const [event] = parseIcs(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:capture-shape@fixture
DTSTART:20260101T100000Z
SUMMARY:Capture shape
RRULE:FREQ=DAILY;COUNT=3
RDATE;TZID=Asia/Singapore:20260105T100000,20260106T100000
EXDATE;VALUE=DATE:20260102,20260103
END:VEVENT
END:VCALENDAR`);
    expect(event!.rrule).toBe("FREQ=DAILY;COUNT=3");
    expect(event!.rdate).toEqual([
      { value: "20260105T100000", params: { TZID: "Asia/Singapore" } },
      { value: "20260106T100000", params: { TZID: "Asia/Singapore" } },
    ]);
    expect(event!.exdate).toEqual([
      { value: "20260102", params: { VALUE: "DATE" } },
      { value: "20260103", params: { VALUE: "DATE" } },
    ]);
  });

  test("a non-recurring event (the existing fixture shape) still has empty rdate/exdate and no rrule", () => {
    const [event] = parseIcs(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:plain@fixture
DTSTART:20260101T100000Z
SUMMARY:Plain
END:VEVENT
END:VCALENDAR`);
    expect(event!.rrule).toBeUndefined();
    expect(event!.rdate).toEqual([]);
    expect(event!.exdate).toEqual([]);
  });

  test("a malformed RRULE/RDATE/EXDATE content line degrades safely: rrule becomes '', dates dropped", () => {
    const [event] = parseIcs(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:malformed-recur@fixture
DTSTART:20260101T100000Z
SUMMARY:Malformed recurrence params
RRULE;BOGUS:FREQ=DAILY;COUNT=3
RDATE;BOGUS:20260105T100000Z
EXDATE;BOGUS:20260102T100000Z
END:VEVENT
END:VCALENDAR`);
    expect(event!.rrule).toBe("");
    expect(event!.rdate).toEqual([]);
    expect(event!.exdate).toEqual([]);
  });
});

// ---------------------------------------------------------------- expandOccurrences (pure)

function ny(): RecurrenceStart {
  return { year: 2026, month: 3, day: 2, hour: 9, minute: 30, second: 0, zone: "America/New_York" };
}

function utcStart(day: number): RecurrenceStart {
  return { year: 2026, month: 1, day, hour: 10, minute: 0, second: 0, zone: "UTC" };
}

function rdate(iso: string, year: number, month: number, day: number): RecurrenceDate {
  return { instant: new Date(iso), year, month, day };
}

describe("expandOccurrences (pure, src/importers/rrule.ts)", () => {
  test("WEEKLY BYDAY=MO across the America/New_York spring-forward transition keeps 09:30 local", () => {
    const result = expandOccurrences(
      ny(),
      "FREQ=WEEKLY;BYDAY=MO;COUNT=5",
      [],
      [],
      FAR_WINDOW_START,
      FAR_WINDOW_END,
      500,
    );
    expect(result.unsupported).toBe(false);
    expect(result.occurrences.map((o) => o.instant.toISOString())).toEqual([
      "2026-03-02T14:30:00.000Z", // EST (UTC-5), before the transition
      "2026-03-09T13:30:00.000Z", // EDT (UTC-4), after — still 09:30 local
      "2026-03-16T13:30:00.000Z",
      "2026-03-23T13:30:00.000Z",
      "2026-03-30T13:30:00.000Z",
    ]);
  });

  test("COUNT bounds the series", () => {
    const result = expandOccurrences(
      utcStart(1),
      "FREQ=DAILY;COUNT=3",
      [],
      [],
      FAR_WINDOW_START,
      FAR_WINDOW_END,
      500,
    );
    expect(result.occurrences).toHaveLength(3);
    expect(result.occurrences[2]!.instant.toISOString()).toBe("2026-01-03T10:00:00.000Z");
  });

  test("UNTIL as a UTC datetime is inclusive", () => {
    const result = expandOccurrences(
      utcStart(1),
      "FREQ=DAILY;UNTIL=20260104T100000Z",
      [],
      [],
      FAR_WINDOW_START,
      FAR_WINDOW_END,
      500,
    );
    expect(result.occurrences.map((o) => o.instant.toISOString())).toEqual([
      "2026-01-01T10:00:00.000Z",
      "2026-01-02T10:00:00.000Z",
      "2026-01-03T10:00:00.000Z",
      "2026-01-04T10:00:00.000Z",
    ]);
  });

  test("UNTIL as a bare DATE compares calendar dates, not instants", () => {
    const result = expandOccurrences(
      utcStart(1),
      "FREQ=DAILY;UNTIL=20260103",
      [],
      [],
      FAR_WINDOW_START,
      FAR_WINDOW_END,
      500,
    );
    expect(result.occurrences).toHaveLength(3); // Jan 1-3; Jan 4 excluded
  });

  test("EXDATE removes and RDATE adds instances, then the whole set is re-sorted", () => {
    const result = expandOccurrences(
      utcStart(1),
      "FREQ=DAILY;COUNT=5",
      [rdate("2026-01-10T10:00:00.000Z", 2026, 1, 10)],
      [rdate("2026-01-03T10:00:00.000Z", 2026, 1, 3)],
      FAR_WINDOW_START,
      FAR_WINDOW_END,
      500,
    );
    expect(result.occurrences.map((o) => o.instant.toISOString())).toEqual([
      "2026-01-01T10:00:00.000Z",
      "2026-01-02T10:00:00.000Z",
      "2026-01-04T10:00:00.000Z",
      "2026-01-05T10:00:00.000Z",
      "2026-01-10T10:00:00.000Z",
    ]);
  });

  test("MONTHLY on the 31st skips months without a 31st (RFC 5545), never clamps", () => {
    const result = expandOccurrences(
      { year: 2026, month: 1, day: 31, hour: 9, minute: 0, second: 0, zone: "UTC" },
      "FREQ=MONTHLY;COUNT=4",
      [],
      [],
      FAR_WINDOW_START,
      FAR_WINDOW_END,
      500,
    );
    expect(result.occurrences.map((o) => `${o.year}-${o.month}`)).toEqual([
      "2026-1",
      "2026-3", // February skipped
      "2026-5", // April skipped
      "2026-7", // June skipped
    ]);
  });

  test("YEARLY on Feb 29 only fires on leap years, never clamps to Feb 28", () => {
    const result = expandOccurrences(
      { year: 2028, month: 2, day: 29, hour: 9, minute: 0, second: 0, zone: "UTC" },
      "FREQ=YEARLY;COUNT=3",
      [],
      [],
      FAR_WINDOW_START,
      FAR_WINDOW_END,
      500,
    );
    expect(result.occurrences.map((o) => o.year)).toEqual([2028, 2032, 2036]);
  });

  test("cap truncates an unbounded series", () => {
    const result = expandOccurrences(
      { year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0, zone: "UTC" },
      "FREQ=DAILY",
      [],
      [],
      FAR_WINDOW_START,
      FAR_WINDOW_END,
      10,
    );
    expect(result.occurrences).toHaveLength(10);
    expect(result.occurrences[9]!.instant.toISOString()).toBe("2026-01-10T00:00:00.000Z");
  });

  test("windowEnd truncates a series that would otherwise run past it", () => {
    const result = expandOccurrences(
      { year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0, zone: "UTC" },
      "FREQ=DAILY",
      [],
      [],
      FAR_WINDOW_START,
      new Date("2026-01-04T00:00:00.000Z"),
      500,
    );
    expect(result.occurrences.map((o) => o.day)).toEqual([1, 2, 3]);
  });

  test("review fix: an indefinite DAILY series anchors near windowStart, not DTSTART, for an old DTSTART", () => {
    // DTSTART is 3+ years before windowStart with no COUNT/UNTIL. Before this fix, `cap` raw
    // dates walked forward from DTSTART exhausted entirely within the past (500 days from
    // 2023-01-01 never reaches 2026), so no occurrence ever reached windowStart, let alone
    // windowEnd -- an indefinitely recurring event silently vanished from any "upcoming" view.
    const windowStart = new Date("2026-08-08T00:00:00.000Z");
    const windowEnd = new Date("2027-08-08T00:00:00.000Z"); // windowStart + 12 months
    const result = expandOccurrences(
      { year: 2023, month: 1, day: 1, hour: 9, minute: 0, second: 0, zone: "UTC" },
      "FREQ=DAILY",
      [],
      [],
      windowStart,
      windowEnd,
      500,
    );
    expect(result.unsupported).toBe(false);
    expect(result.occurrences).toHaveLength(365);
    // DAILY interval=1 always aligns exactly on windowStart's own calendar day.
    expect(result.occurrences[0]!.instant.toISOString()).toBe("2026-08-08T09:00:00.000Z");
    expect(result.occurrences[364]!.instant.toISOString()).toBe("2027-08-07T09:00:00.000Z");
    expect(result.occurrences.some((o) => o.instant.getTime() >= windowStart.getTime())).toBe(true);
  });

  test("review fix: an indefinite WEEKLY BYDAY series (a years-old weekday standup) still surfaces this week and beyond", () => {
    // The review's exact "Mon-Fri weekday standup started 2 years before now" repro. windowStart
    // is a Wednesday; the fast-forward lands on the START of that week (not strictly after
    // windowStart), so this week's earlier Mon/Tue instances stay visible too.
    const windowStart = new Date("2026-08-05T00:00:00.000Z"); // a Wednesday
    const windowEnd = new Date("2027-08-05T00:00:00.000Z");
    const result = expandOccurrences(
      { year: 2024, month: 8, day: 5, hour: 9, minute: 0, second: 0, zone: "UTC" }, // a Monday
      "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
      [],
      [],
      windowStart,
      windowEnd,
      500,
    );
    expect(result.unsupported).toBe(false);
    expect(result.occurrences.slice(0, 7).map((o) => o.instant.toISOString())).toEqual([
      "2026-08-03T09:00:00.000Z",
      "2026-08-04T09:00:00.000Z",
      "2026-08-05T09:00:00.000Z",
      "2026-08-06T09:00:00.000Z",
      "2026-08-07T09:00:00.000Z",
      "2026-08-10T09:00:00.000Z",
      "2026-08-11T09:00:00.000Z",
    ]);
    expect(result.occurrences[result.occurrences.length - 1]!.instant.toISOString()).toBe(
      "2027-08-04T09:00:00.000Z",
    );
    expect(result.occurrences.some((o) => o.instant.getTime() >= windowStart.getTime())).toBe(true);
  });

  test("review fix: a COUNT-bounded series always counts from DTSTART, ignoring windowStart entirely", () => {
    // RFC 5545 COUNT counts occurrences from DTSTART -- the windowStart fast-forward must never
    // apply here, or the Nth occurrence would be computed wrong (or missed as "already over").
    const start = { year: 2020, month: 1, day: 1, hour: 9, minute: 0, second: 0, zone: "UTC" };
    const expected = [
      "2020-01-01T09:00:00.000Z",
      "2020-01-02T09:00:00.000Z",
      "2020-01-03T09:00:00.000Z",
    ];
    const nearStart = expandOccurrences(
      start,
      "FREQ=DAILY;COUNT=3",
      [],
      [],
      FAR_WINDOW_START,
      FAR_WINDOW_END,
      500,
    );
    const farFuture = expandOccurrences(
      start,
      "FREQ=DAILY;COUNT=3",
      [],
      [],
      new Date("2026-08-08T00:00:00.000Z"), // long after this COUNT-bounded series already ended
      FAR_WINDOW_END,
      500,
    );
    expect(nearStart.occurrences.map((o) => o.instant.toISOString())).toEqual(expected);
    expect(farFuture.occurrences.map((o) => o.instant.toISOString())).toEqual(expected);
  });

  test("no RRULE: RDATE/EXDATE still apply on top of the bare DTSTART", () => {
    const result = expandOccurrences(
      utcStart(1),
      undefined,
      [rdate("2026-01-05T10:00:00.000Z", 2026, 1, 5)],
      [],
      FAR_WINDOW_START,
      FAR_WINDOW_END,
      500,
    );
    expect(result.occurrences.map((o) => o.instant.toISOString())).toEqual([
      "2026-01-01T10:00:00.000Z",
      "2026-01-05T10:00:00.000Z",
    ]);
  });

  test.each([
    ["BYMONTHDAY", "FREQ=MONTHLY;BYMONTHDAY=15"],
    ["BYSETPOS", "FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1"],
    ["ordinal BYDAY", "FREQ=WEEKLY;BYDAY=1MO"],
    ["WKST != MO", "FREQ=WEEKLY;BYDAY=MO;WKST=SU"],
    ["unsupported FREQ", "FREQ=HOURLY"],
    ["both COUNT and UNTIL", "FREQ=DAILY;COUNT=3;UNTIL=20260105T000000Z"],
    ["empty value", ""],
    ["UNTIL before DTSTART", "FREQ=DAILY;UNTIL=20251231T000000Z"],
    ["UNTIL with an out-of-range month/day (bare DATE)", "FREQ=DAILY;UNTIL=20261332"],
    ["UNTIL with an out-of-range month/day (DATE-TIME)", "FREQ=DAILY;UNTIL=20261332T000000Z"],
    ["UNTIL day exceeds the target month's real length", "FREQ=DAILY;UNTIL=20260230"], // Feb 30
  ])("unsupported RRULE part (%s) degrades to [DTSTART] with unsupported:true", (_label, rrule) => {
    const result = expandOccurrences(
      utcStart(1),
      rrule,
      [],
      [],
      FAR_WINDOW_START,
      FAR_WINDOW_END,
      500,
    );
    expect(result.unsupported).toBe(true);
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]!.instant.toISOString()).toBe("2026-01-01T10:00:00.000Z");
  });

  test("addCalendarDays/calendarDaysBetween round-trip and handle month/year rollover", () => {
    expect(addCalendarDays(2026, 1, 31, 1)).toEqual({ year: 2026, month: 2, day: 1 });
    expect(addCalendarDays(2026, 12, 31, 1)).toEqual({ year: 2027, month: 1, day: 1 });
    const a = { year: 2026, month: 1, day: 30 };
    const b = { year: 2026, month: 3, day: 2 };
    expect(calendarDaysBetween(a, b)).toBe(31);
    expect(addCalendarDays(a.year, a.month, a.day, calendarDaysBetween(a, b))).toEqual(b);
  });
});

// ---------------------------------------------------------------- calendar importer (DB)

beforeAll(async () => {
  await resetDb();
});

describe("calendar importer: recurring events", () => {
  test("a weekly standup expands to ~52 occurrences over 12 months, keyed (uid, occurrence_start)", async () => {
    setNow(new Date("2026-08-10T00:30:00.000Z")); // just before the first Monday 09:30 SGT instance
    const ics = await Bun.file(join(FIXTURES, "calendar-rrule.ics")).text();
    const stats = await importCalendar(ics);
    expect(stats).toEqual({ total: 1, inserted: 53, updated: 0, skipped: 0 });

    const standup = await sql`
      select occurrence_start, starts_at, ends_at from calendar_events
      where uid = 'evt-rrule-standup@fixture' order by occurrence_start`;
    expect(standup).toHaveLength(53);
    expect(standup[0]!.occurrence_start.toISOString()).toBe("2026-08-10T01:30:00.000Z");
    expect(standup[0]!.starts_at.toISOString()).toBe("2026-08-10T01:30:00.000Z");
    expect(standup[0]!.ends_at.toISOString()).toBe("2026-08-10T01:45:00.000Z");
    // every occurrence_start is exactly 7 days after the previous one (no DST in Asia/Singapore)
    for (let i = 1; i < standup.length; i++) {
      const gapMs =
        standup[i]!.occurrence_start.getTime() - standup[i - 1]!.occurrence_start.getTime();
      expect(gapMs).toBe(7 * 86_400_000);
    }
    expect(standup[standup.length - 1]!.occurrence_start.toISOString()).toBe(
      "2027-08-09T01:30:00.000Z",
    );

    // stateSnapshot's today/tomorrow window (starts_at >= now-1h, < now+2d) shows this week's instance.
    const state = await stateSnapshot();
    expect(state.calendar.some((row: any) => row.uid === "evt-rrule-standup@fixture")).toBe(true);
  });

  test("review fix: a years-old indefinite DAILY event still surfaces in stateSnapshot's today/tomorrow window", async () => {
    // The review's exact repro shape: DTSTART years before "now", FREQ=DAILY, no COUNT/UNTIL --
    // a years-old daily habit, exactly what a life database accumulates. Before this fix, `cap`
    // (500) raw dates walked from DTSTART=2023-01-03 exhausted entirely by ~2024-05, so no
    // occurrence ever reached anywhere near "now" and this event silently vanished from every
    // upcoming-events view despite being actively, indefinitely recurring.
    setNow(new Date("2026-08-10T00:30:00.000Z"));
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:evt-rrule-old-daily@fixture
DTSTART;TZID=Asia/Singapore:20230103T093000
DTEND;TZID=Asia/Singapore:20230103T094500
SUMMARY:Long-running daily habit (rrule)
RRULE:FREQ=DAILY
END:VEVENT
END:VCALENDAR`;
    const stats = await importCalendar(ics);
    expect(stats.total).toBe(1);
    expect(stats.inserted).toBe(365);

    const rows = await sql`
      select occurrence_start from calendar_events
      where uid = 'evt-rrule-old-daily@fixture' order by occurrence_start`;
    expect(rows).toHaveLength(365);
    // Every stored row is anchored near "now" -- none stranded back near the 2023 DTSTART.
    expect(rows[0]!.occurrence_start.toISOString()).toBe("2026-08-10T01:30:00.000Z");
    expect(rows[rows.length - 1]!.occurrence_start.toISOString()).toBe("2027-08-09T01:30:00.000Z");

    // stateSnapshot's today/tomorrow window (starts_at >= now-1h, < now+2d) shows this event.
    const state = await stateSnapshot();
    expect(state.calendar.some((row: any) => row.uid === "evt-rrule-old-daily@fixture")).toBe(true);
  });

  test("all-day YEARLY (birthday-style) expansion spans local midnights", async () => {
    setNow(new Date("2030-01-01T00:00:00.000Z")); // windowEnd 2031-01-01: comfortably past all 3
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:evt-rrule-birthday@fixture
DTSTART;VALUE=DATE:20260612
SUMMARY:Mum's birthday (rrule)
RRULE:FREQ=YEARLY;COUNT=3
END:VEVENT
END:VCALENDAR`;
    await importCalendar(ics);
    const rows = await sql`
      select starts_at, ends_at from calendar_events
      where uid = 'evt-rrule-birthday@fixture' order by starts_at`;
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.starts_at.toISOString())).toEqual([
      "2026-06-11T16:00:00.000Z",
      "2027-06-11T16:00:00.000Z",
      "2028-06-11T16:00:00.000Z",
    ]);
    // each all-day span's end is the exclusive next local midnight (Asia/Singapore, UTC+8).
    expect(rows.map((r) => r.ends_at.toISOString())).toEqual([
      "2026-06-12T16:00:00.000Z",
      "2027-06-12T16:00:00.000Z",
      "2028-06-12T16:00:00.000Z",
    ]);
  });

  test("EXDATE removes and RDATE adds a one-off instance in a real import", async () => {
    setNow(new Date("2026-01-01T00:00:00.000Z"));
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:evt-rrule-exrdate@fixture
DTSTART:20260101T100000Z
DTEND:20260101T103000Z
SUMMARY:Daily check-in (rrule)
RRULE:FREQ=DAILY;COUNT=5
EXDATE:20260103T100000Z
RDATE:20260110T100000Z
END:VEVENT
END:VCALENDAR`;
    const stats = await importCalendar(ics);
    expect(stats).toEqual({ total: 1, inserted: 5, updated: 0, skipped: 0 });
    const rows = await sql`
      select occurrence_start, ends_at from calendar_events
      where uid = 'evt-rrule-exrdate@fixture' order by occurrence_start`;
    expect(rows.map((r) => r.occurrence_start.toISOString())).toEqual([
      "2026-01-01T10:00:00.000Z",
      "2026-01-02T10:00:00.000Z",
      "2026-01-04T10:00:00.000Z", // Jan 3 excluded (EXDATE)
      "2026-01-05T10:00:00.000Z",
      "2026-01-10T10:00:00.000Z", // added (RDATE), 30-minute duration preserved
    ]);
    expect(rows[4]!.ends_at.toISOString()).toBe("2026-01-10T10:30:00.000Z");
  });

  test("an unsupported RRULE (BYSETPOS) imports DTSTART alone and logs a content-free audit event", async () => {
    setNow(new Date("2026-08-10T00:30:00.000Z"));
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:evt-rrule-unsupported@fixture
DTSTART;TZID=Asia/Singapore:20260803T090000
DTEND;TZID=Asia/Singapore:20260803T093000
SUMMARY:First Monday sync (rrule)
RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1
END:VEVENT
END:VCALENDAR`;
    const stats = await importCalendar(ics);
    expect(stats).toEqual({ total: 1, inserted: 1, updated: 0, skipped: 0 });
    const rows = await sql`
      select occurrence_start, starts_at, ends_at from calendar_events
      where uid = 'evt-rrule-unsupported@fixture'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.starts_at.toISOString()).toBe("2026-08-03T01:00:00.000Z");
    expect(rows[0]!.ends_at.toISOString()).toBe("2026-08-03T01:30:00.000Z");

    const audited = await sql`
      select payload from events
      where actor = 'importer:calendar' and verb = 'import:rrule-unsupported'
        and payload->>'record_number' = '1'
      order by id`;
    expect(audited.length).toBeGreaterThan(0);
    for (const row of audited) {
      expect(row.payload).toEqual({
        importer: "calendar",
        reason: "unsupported_rrule",
        record_number: 1,
      });
      expect(JSON.stringify(row.payload)).not.toContain("BYSETPOS");
      expect(JSON.stringify(row.payload)).not.toContain("First Monday sync");
    }
  });

  test("re-importing an identical file is a no-op (idempotent per occurrence)", async () => {
    setNow(new Date("2026-01-01T00:00:00.000Z"));
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:evt-rrule-idempotent@fixture
DTSTART:20260105T090000Z
SUMMARY:Idempotency check
RRULE:FREQ=WEEKLY;COUNT=6
END:VEVENT
END:VCALENDAR`;
    const first = await importCalendar(ics);
    expect(first).toEqual({ total: 1, inserted: 6, updated: 0, skipped: 0 });

    const second = await importCalendar(ics); // identical text, identical "now" -> identical window
    expect(second).toEqual({ total: 1, inserted: 0, updated: 6, skipped: 0 });
    const [count] = await sql`
      select count(*)::int as n from calendar_events where uid = 'evt-rrule-idempotent@fixture'`;
    expect(count!.n).toBe(6);
  });

  test("a changed RRULE prunes stale FUTURE occurrences but never touches past ones", async () => {
    const uid = "evt-prune@fixture";
    const icsV1 = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:${uid}
DTSTART:20260105T090000Z
SUMMARY:Prune target
RRULE:FREQ=WEEKLY;COUNT=4
END:VEVENT
END:VCALENDAR`;
    setNow(new Date("2026-01-01T00:00:00.000Z"));
    await importCalendar(icsV1);
    const initial = await sql`
      select occurrence_start from calendar_events where uid = ${uid} order by occurrence_start`;
    expect(initial.map((r) => r.occurrence_start.toISOString())).toEqual([
      "2026-01-05T09:00:00.000Z",
      "2026-01-12T09:00:00.000Z",
      "2026-01-19T09:00:00.000Z",
      "2026-01-26T09:00:00.000Z",
    ]);

    // Advance past the first two occurrences. The new export drops Jan 5 (now in the past) AND
    // Jan 19 (still in the future) via EXDATE -- Jan 5 must survive anyway (never delete the past).
    setNow(new Date("2026-01-15T00:00:00.000Z"));
    const icsV2 = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:${uid}
DTSTART:20260105T090000Z
SUMMARY:Prune target
RRULE:FREQ=WEEKLY;COUNT=4
EXDATE:20260105T090000Z,20260119T090000Z
END:VEVENT
END:VCALENDAR`;
    await importCalendar(icsV2);

    const after = await sql`
      select occurrence_start from calendar_events where uid = ${uid} order by occurrence_start`;
    expect(after.map((r) => r.occurrence_start.toISOString())).toEqual([
      "2026-01-05T09:00:00.000Z", // past -- preserved even though v2's own rule excludes it
      "2026-01-12T09:00:00.000Z", // past and still in v2's keep set
      "2026-01-26T09:00:00.000Z", // future and in v2's keep set
    ]); // Jan 19 pruned: future and NOT in v2's keep set
  });

  test("pruning also clears a uid whose recurrence was removed entirely (same UID, now one-off)", async () => {
    const uid = "evt-prune-dropped@fixture";
    setNow(new Date("2026-01-01T00:00:00.000Z"));
    await importCalendar(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:${uid}
DTSTART:20260105T090000Z
SUMMARY:Was recurring
RRULE:FREQ=WEEKLY;COUNT=3
END:VEVENT
END:VCALENDAR`);
    const [beforeCount] =
      await sql`select count(*)::int as n from calendar_events where uid = ${uid}`;
    expect(beforeCount!.n).toBe(3);

    setNow(new Date("2026-01-02T00:00:00.000Z")); // before every occurrence -- all are "future"
    await importCalendar(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:${uid}
DTSTART:20260105T090000Z
SUMMARY:No longer recurring
END:VEVENT
END:VCALENDAR`);
    const rows = await sql`select occurrence_start from calendar_events where uid = ${uid}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrence_start.toISOString()).toBe("2026-01-05T09:00:00.000Z");
  });
});

// ---------------------------------------------------------------- migration 031 backfill

describe("migration 031: occurrence_start backfill", () => {
  const MIGRATIONS_DIR = join(import.meta.dir, "../db/migrations");
  const BEFORE = "030_task_recurrence.sql";
  const TARGET = "031_calendar_occurrences.sql";

  test("031 backfills occurrence_start from starts_at and preserves an existing single row", async () => {
    const token = `m031_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const plan = planTestDatabase(testDatabaseUrl(), token);
    const handle = await provisionTestDatabase(plan);
    const isolated = postgres(plan.databaseUrl, { max: 1, onnotice: () => {} });
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      let failed = false;
      try {
        await isolated.end({ timeout: 5 });
      } catch {
        failed = true;
      }
      try {
        await disposeTestDatabase(handle);
      } catch {
        failed = true;
      }
      if (failed) throw new Error("test_database_cleanup_failed");
    };
    const unregister = registerTestDatabaseCloser(cleanup);

    try {
      // The installer template may already carry the current schema. Strip application
      // relations/functions so this scratch authentically replays checked-out history only
      // through 030 (same preamble as test/migration-026-upgrade.test.ts).
      const applicationFunctions = await isolated`
        select pg_catalog.format('%I.%I(%s)', ns.nspname, p.proname,
                 pg_catalog.pg_get_function_identity_arguments(p.oid)) as signature
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname = 'public'
          and not exists (
            select 1 from pg_catalog.pg_depend dep
            join pg_catalog.pg_extension ext on ext.oid = dep.refobjid
            where dep.classid = 'pg_catalog.pg_proc'::regclass
              and dep.objid = p.oid and dep.deptype = 'e'
          )`;
      const applicationTables = await isolated`
        select tablename from pg_catalog.pg_tables where schemaname = 'public'`;
      for (const row of applicationTables) {
        await isolated`drop table if exists ${isolated(String(row.tablename))} cascade`;
      }
      for (const row of applicationFunctions) {
        await isolated.unsafe(`drop function if exists ${String(row.signature)} cascade`);
      }

      const names = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort();
      const beforeIndex = names.indexOf(BEFORE);
      expect(beforeIndex).toBeGreaterThanOrEqual(0);
      expect(names[beforeIndex + 1]).toBe(TARGET);

      await ensureSchemaMigrationLedger(isolated);
      for (const name of names.slice(0, beforeIndex + 1)) {
        await applyCheckedOutMigration(
          isolated,
          name,
          await Bun.file(join(MIGRATIONS_DIR, name)).text(),
        );
      }
      expect(await schemaMigrationNames(isolated)).toEqual(names.slice(0, beforeIndex + 1));

      const legacyStart = new Date("2026-08-10T01:30:00.000Z");
      const legacyEnd = new Date("2026-08-10T02:00:00.000Z");
      await isolated`
        insert into calendar_events (uid, starts_at, ends_at, title, location, tier)
        values ('fictional-legacy@migration-031', ${legacyStart}, ${legacyEnd},
                'Fictional legacy standup', 'Fictional Room', 1)`;

      const body = await Bun.file(join(MIGRATIONS_DIR, TARGET)).text();
      await applyCheckedOutMigration(isolated, TARGET, body);
      expect(await schemaMigrationNames(isolated)).toEqual(names.slice(0, beforeIndex + 2));

      const [row] = await isolated`
        select uid, occurrence_start, starts_at, ends_at, title, location, tier
        from calendar_events where uid = 'fictional-legacy@migration-031'`;
      expect(row!.occurrence_start.toISOString()).toBe(legacyStart.toISOString());
      expect(row!.starts_at.toISOString()).toBe(legacyStart.toISOString());
      expect(row!.ends_at.toISOString()).toBe(legacyEnd.toISOString());
      expect(row!.title).toBe("Fictional legacy standup");
      expect(row!.location).toBe("Fictional Room");
      expect(row!.tier).toBe(1);

      const [constraints] = await isolated`
        select
          not exists (
            select 1 from pg_constraint where conname = 'calendar_events_uid_key'
          ) as old_dropped,
          exists (
            select 1 from pg_constraint where conname = 'calendar_events_uid_occurrence_start_key'
          ) as new_present`;
      expect(constraints).toEqual({ old_dropped: true, new_present: true });

      // A second insert with the SAME uid but a different occurrence_start must now succeed
      // (the old unique(uid) constraint would have rejected it).
      await isolated`
        insert into calendar_events (uid, occurrence_start, starts_at, ends_at, title, tier)
        values ('fictional-legacy@migration-031', ${new Date("2026-08-17T01:30:00.000Z")},
                ${new Date("2026-08-17T01:30:00.000Z")}, ${new Date("2026-08-17T02:00:00.000Z")},
                'Fictional legacy standup', 1)`;
      const [count] = await isolated`
        select count(*)::int as n from calendar_events
        where uid = 'fictional-legacy@migration-031'`;
      expect(count!.n).toBe(2);

      const [grant] = await isolated`
        select has_table_privilege('minime_app', 'public.calendar_events', 'DELETE') as app_delete`;
      expect(grant!.app_delete).toBe(true);

      const [policy] = await isolated`
        select roles, qual from pg_policies
        where schemaname = 'public' and tablename = 'calendar_events' and policyname = 'tier_delete'`;
      expect([...policy!.roles]).toEqual(["minime_app"]);
      expect(policy!.qual.replaceAll(/[()]/g, "")).toContain("tier >= 1");
      expect(policy!.qual.replaceAll(/[()]/g, "")).toContain("tier <= app_allowed_tier");
    } finally {
      unregister();
      await cleanup();
    }
  });
});
