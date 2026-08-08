// Pure RRULE/RDATE/EXDATE occurrence expansion for the calendar importer (RFC 5545, restricted
// subset). No DB, no clock, no network -- the caller (src/importers/calendar.ts) does all ICS
// parsing and TZID resolution and passes in already-parsed wall-clock fields; this module only
// does calendar-date arithmetic and RRULE grammar. FREQ=DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL,
// COUNT, UNTIL, and WEEKLY-only plain-code BYDAY (MO..SU, no ordinals) are supported; anything
// else (BYMONTHDAY, BYSETPOS, ordinal BYDAY like "1MO", WKST other than MO, HOURLY/MINUTELY/
// SECONDLY, both COUNT and UNTIL together, UNTIL before DTSTART) makes the whole rule
// "unsupported" -- the caller degrades to importing DTSTART alone and audits it, rather than
// guessing at partial semantics.
//
// MONTHLY/YEARLY reproduce RFC 5545's actual "day doesn't exist this cycle -> skip it, don't
// clamp" rule (Jan 31 + FREQ=MONTHLY has no February occurrence; Feb 29 + FREQ=YEARLY only fires
// on leap years) -- deliberately different from src/util/recurrence.ts's end-of-month CLAMPING,
// a separate, simpler design chosen there for task due-dates, not a calendar-occurrence
// semantic. The two modules share the "epoch day" arithmetic trick but not any code; they serve
// genuinely different call sites (task due dates vs. mirrored external calendar data).
//
// Known simplification: the internal per-FREQ candidate generator is capped at MAX_CANDIDATES
// raw dates *before* EXDATE removal, so an EXDATE-heavy window could in principle end with fewer
// than `cap` final occurrences even though more would fit. Acceptable for an approximate "~500
// occurrences" safety valve, not a precision guarantee.
//
// `windowStart` (the caller's "now") anchors where an INDEFINITE series (no COUNT) starts
// generating candidates: at or just before windowStart's own cycle, not always at DTSTART.
// Without this, `cap` raw dates walked forward from a DTSTART years in the past exhausts
// entirely on history before ever reaching windowStart -- silently dropping every upcoming
// occurrence of an old, still-active recurring event (e.g. a years-old daily habit or weekday
// standup). A COUNT-bounded series still walks the exact sequence from DTSTART -- RFC 5545
// counts occurrences from DTSTART, so skipping ahead would miscount -- which is safe because
// COUNT already bounds how far that walk goes.

import { localDateStr, localDateTimeToUtc } from "../util/clock";

const MAX_CANDIDATES = 3000; // generous ceiling over any realistic <=~12-month window; the
// caller's windowEnd normally bounds generation well inside this -- it only matters as a hard
// backstop against a bug or an adversarial INTERVAL/FREQ combination.

export interface RecurrenceStart {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  zone: string;
}

export interface RecurrenceDate {
  instant: Date;
  year: number;
  month: number;
  day: number;
}

export interface ExpansionResult {
  // Ascending, deduped by instant, capped. When `unsupported` is true this is always exactly
  // [DTSTART] -- RDATE/EXDATE are not applied, matching the "safe minimal degrade" contract.
  occurrences: RecurrenceDate[];
  unsupported: boolean;
}

// ---------------------------------------------------------------- calendar-day arithmetic

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

interface Ymd {
  year: number;
  month: number;
  day: number;
}

// Date.UTC is used purely as fixed, DST-free calendar-day arithmetic here -- never as an instant.
function toEpochDay(ymd: Ymd): number {
  return Math.floor(Date.UTC(ymd.year, ymd.month - 1, ymd.day) / 86_400_000);
}

function fromEpochDay(epochDay: number): Ymd {
  const d = new Date(epochDay * 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Pure calendar-date addition (no DST, no zone) -- `offset` may be negative or zero. */
export function addCalendarDays(year: number, month: number, day: number, offset: number): Ymd {
  return fromEpochDay(toEpochDay({ year, month, day }) + offset);
}

/** Whole calendar days from `a` to `b` (positive when `b` is later, zero when equal). */
export function calendarDaysBetween(a: Ymd, b: Ymd): number {
  return toEpochDay(b) - toEpochDay(a);
}

function compareYmd(a: Ymd, b: Ymd): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

// Monday-based weekday: 0=MO..6=SU. Date.UTC/getUTCDay is 0=Sunday..6=Saturday.
function weekdayOf(ymd: Ymd): number {
  return (new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day)).getUTCDay() + 6) % 7;
}

// `instant` read as a calendar date in the event's own zone -- matching how DTSTART's own
// wall-clock fields are local, not UTC, so "today" means the event's local today.
function ymdFromDate(instant: Date, zone: string): Ymd {
  const [year, month, day] = localDateStr(instant, zone).split("-").map(Number);
  return { year: year!, month: month!, day: day! };
}

// ---------------------------------------------------------------- RRULE grammar

type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

const SUPPORTED_FREQ = new Set<string>(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const SUPPORTED_KEYS = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "WKST"]);
const WEEKDAY_CODES: Readonly<Record<string, number>> = {
  MO: 0,
  TU: 1,
  WE: 2,
  TH: 3,
  FR: 4,
  SA: 5,
  SU: 6,
};

interface UntilBound {
  kind: "date" | "instant";
  ymd: Ymd; // always populated; the only field compared for kind "date"
  instant: Date; // only meaningful for kind "instant" (RFC 5545: always UTC)
}

interface RuleParts {
  freq: Freq;
  interval: number;
  count: number | null;
  until: UntilBound | null;
  byday: number[] | null; // Monday-based weekday indices; null = "DTSTART's own weekday"
}

function parseUntil(value: string): UntilBound | null {
  const dateMatch = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateMatch) {
    const [, y, m, d] = dateMatch;
    return { kind: "date", ymd: { year: +y!, month: +m!, day: +d! }, instant: new Date(0) };
  }
  // A DATE-TIME UNTIL must be UTC ("Z") per RFC 5545; a floating or TZID'd UNTIL has no
  // unambiguous meaning here, so it is treated the same as any other malformed RRULE part.
  const dateTimeMatch = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!dateTimeMatch) return null;
  const [, y, m, d, h, mi, s] = dateTimeMatch;
  const ymd = { year: +y!, month: +m!, day: +d! };
  const hour = +h!;
  const minute = +mi!;
  const second = +s!;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return {
    kind: "instant",
    ymd,
    instant: new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day, hour, minute, second)),
  };
}

function parseByDay(value: string): number[] | null {
  const out: number[] = [];
  for (const code of value.split(",")) {
    const idx = WEEKDAY_CODES[code];
    if (idx === undefined) return null; // unknown code, or an ordinal prefix like "1MO"/"-1FR"
    out.push(idx);
  }
  return out.length ? out : null;
}

function exceedsUntil(candidate: Ymd, until: UntilBound, candidateInstant: Date): boolean {
  return until.kind === "date"
    ? compareYmd(candidate, until.ymd) > 0
    : candidateInstant.getTime() > until.instant.getTime();
}

function startInstant(start: RecurrenceStart): Date {
  return localDateTimeToUtc(
    start.year,
    start.month,
    start.day,
    start.hour,
    start.minute,
    start.second,
    0,
    start.zone,
  );
}

function parseRrule(raw: string, start: RecurrenceStart): RuleParts | null {
  const parts = new Map<string, string>();
  for (const segment of raw.split(";")) {
    if (!segment) continue;
    const eq = segment.indexOf("=");
    if (eq <= 0) return null;
    const key = segment.slice(0, eq).toUpperCase();
    const value = segment.slice(eq + 1);
    if (!value || parts.has(key)) return null;
    parts.set(key, value);
  }
  for (const key of parts.keys()) if (!SUPPORTED_KEYS.has(key)) return null;
  if (parts.has("COUNT") && parts.has("UNTIL")) return null; // RFC 5545 forbids both together

  const freq = parts.get("FREQ");
  if (!freq || !SUPPORTED_FREQ.has(freq)) return null;
  if (parts.has("BYDAY") && freq !== "WEEKLY") return null;
  if (parts.has("WKST") && parts.get("WKST") !== "MO") return null;

  let interval = 1;
  if (parts.has("INTERVAL")) {
    const value = parts.get("INTERVAL")!;
    if (!/^\d+$/.test(value) || +value < 1) return null;
    interval = +value;
  }
  let count: number | null = null;
  if (parts.has("COUNT")) {
    const value = parts.get("COUNT")!;
    if (!/^\d+$/.test(value) || +value < 1) return null;
    count = +value;
  }
  let until: UntilBound | null = null;
  if (parts.has("UNTIL")) {
    until = parseUntil(parts.get("UNTIL")!);
    if (!until) return null;
  }
  let byday: number[] | null = null;
  if (parts.has("BYDAY")) {
    byday = parseByDay(parts.get("BYDAY")!);
    if (!byday) return null;
  }
  if (until && exceedsUntil(start, until, startInstant(start))) return null; // UNTIL < DTSTART

  return { freq: freq as Freq, interval, count, until, byday };
}

// ---------------------------------------------------------------- FREQ candidate generation

function dailyCandidates(anchor: Ymd, interval: number, from: Ymd): Ymd[] {
  const anchorEpoch = toEpochDay(anchor);
  const fromEpoch = toEpochDay(from);
  // Fast-forward to the cycle at or immediately before `from` instead of always walking the raw
  // sequence from DTSTART -- see the module comment on why an old DTSTART otherwise starves
  // `cap` on history it will never need.
  const skip = fromEpoch > anchorEpoch ? Math.floor((fromEpoch - anchorEpoch) / interval) : 0;
  return Array.from({ length: MAX_CANDIDATES }, (_, i) =>
    fromEpochDay(anchorEpoch + (skip + i) * interval),
  );
}

function weeklyCandidates(anchor: Ymd, interval: number, byday: number[] | null, from: Ymd): Ymd[] {
  const days = [...(byday ?? [weekdayOf(anchor)])].sort((a, b) => a - b);
  const startEpoch = toEpochDay(anchor);
  const anchorMonday = startEpoch - weekdayOf(anchor);
  const cycleDays = interval * 7;
  // Fast-forward to the interval-aligned week at or immediately before `from`'s own week (same
  // rationale as dailyCandidates); landing on the whole week (not past its later days) keeps
  // e.g. "earlier this week" BYDAY occurrences visible rather than only strictly-future ones.
  const fromMonday = toEpochDay(from) - weekdayOf(from);
  const weekSkip =
    fromMonday > anchorMonday ? Math.floor((fromMonday - anchorMonday) / cycleDays) : 0;
  const out: Ymd[] = [];
  for (let week = weekSkip; week < weekSkip + MAX_CANDIDATES; week++) {
    const weekMonday = anchorMonday + week * cycleDays;
    for (const wd of days) {
      if (out.length >= MAX_CANDIDATES) return out;
      const epochDay = weekMonday + wd;
      // Drop days from DTSTART's own week that fall before DTSTART itself (e.g. DTSTART is
      // Wednesday, BYDAY includes Monday) -- BYDAY defines which weekdays occur, DTSTART only
      // anchors the phase and time-of-day, so it is not force-included when it doesn't match.
      if (epochDay >= startEpoch) out.push(fromEpochDay(epochDay));
    }
  }
  return out;
}

function monthlyCandidates(anchor: Ymd, interval: number, from: Ymd): Ymd[] {
  const anchorMonthIndex = anchor.year * 12 + (anchor.month - 1);
  const fromMonthIndex = from.year * 12 + (from.month - 1);
  const skip =
    fromMonthIndex > anchorMonthIndex
      ? Math.floor((fromMonthIndex - anchorMonthIndex) / interval)
      : 0;
  const out: Ymd[] = [];
  for (let i = skip; i < skip + MAX_CANDIDATES && out.length < MAX_CANDIDATES; i++) {
    const total = anchorMonthIndex + i * interval;
    const year = Math.floor(total / 12);
    const month = (((total % 12) + 12) % 12) + 1;
    // RFC 5545: a target month without this day-of-month (e.g. day 31 in April) is skipped
    // entirely, not clamped to the month's last day -- see the module comment.
    if (anchor.day <= daysInMonth(year, month)) out.push({ year, month, day: anchor.day });
  }
  return out;
}

function yearlyCandidates(anchor: Ymd, interval: number, from: Ymd): Ymd[] {
  const skip = from.year > anchor.year ? Math.floor((from.year - anchor.year) / interval) : 0;
  const out: Ymd[] = [];
  for (let i = skip; i < skip + MAX_CANDIDATES && out.length < MAX_CANDIDATES; i++) {
    const year = anchor.year + i * interval;
    if (anchor.month === 2 && anchor.day === 29 && !isLeapYear(year)) continue; // skip, don't clamp
    out.push({ year, month: anchor.month, day: anchor.day });
  }
  return out;
}

function applyBounds(
  candidates: Ymd[],
  start: RecurrenceStart,
  until: UntilBound | null,
  count: number | null,
  windowEnd: Date,
  cap: number,
): RecurrenceDate[] {
  const out: RecurrenceDate[] = [];
  for (const c of candidates) {
    const instant = localDateTimeToUtc(
      c.year,
      c.month,
      c.day,
      start.hour,
      start.minute,
      start.second,
      0,
      start.zone,
    );
    if (until && exceedsUntil(c, until, instant)) break; // candidates are strictly ascending
    if (instant.getTime() >= windowEnd.getTime()) break;
    out.push({ instant, year: c.year, month: c.month, day: c.day });
    if ((count !== null && out.length >= count) || out.length >= cap) break;
  }
  return out;
}

function generateSeries(
  start: RecurrenceStart,
  rule: RuleParts,
  windowStart: Date,
  windowEnd: Date,
  cap: number,
): RecurrenceDate[] {
  const anchor: Ymd = { year: start.year, month: start.month, day: start.day };
  // COUNT must be counted exactly from DTSTART per RFC 5545, so a COUNT-bounded rule always
  // walks the real candidate sequence from the true anchor; only an indefinite (no-COUNT) rule
  // fast-forwards toward `windowStart` (see the module comment).
  const from = rule.count === null ? ymdFromDate(windowStart, start.zone) : anchor;
  const candidates =
    rule.freq === "DAILY"
      ? dailyCandidates(anchor, rule.interval, from)
      : rule.freq === "WEEKLY"
        ? weeklyCandidates(anchor, rule.interval, rule.byday, from)
        : rule.freq === "MONTHLY"
          ? monthlyCandidates(anchor, rule.interval, from)
          : yearlyCandidates(anchor, rule.interval, from);
  return applyBounds(candidates, start, rule.until, rule.count, windowEnd, cap);
}

function mergeAndCap(
  series: RecurrenceDate[],
  rdates: RecurrenceDate[],
  exdates: RecurrenceDate[],
  windowEnd: Date,
  cap: number,
): RecurrenceDate[] {
  const excluded = new Set(exdates.map((d) => d.instant.getTime()));
  const merged = new Map<number, RecurrenceDate>();
  for (const d of [...series, ...rdates]) {
    const t = d.instant.getTime();
    if (t >= windowEnd.getTime() || excluded.has(t)) continue;
    merged.set(t, d);
  }
  return [...merged.values()]
    .sort((a, b) => a.instant.getTime() - b.instant.getTime())
    .slice(0, cap);
}

/**
 * Expand one event's RRULE/RDATE/EXDATE into concrete occurrence instants.
 *
 * `rrule` undefined means "no recurrence rule" -- RDATE/EXDATE (if any) still apply on top of
 * the bare DTSTART. An unsupported RRULE (see module comment) returns exactly [DTSTART] with
 * `unsupported: true` and does NOT apply RDATE/EXDATE -- the caller treats that single instance
 * exactly like an ordinary non-recurring event, never a partially-understood one.
 *
 * `windowStart` is the caller's "now" -- see the module comment on why an indefinite series
 * anchors candidate generation there instead of always at DTSTART.
 */
export function expandOccurrences(
  start: RecurrenceStart,
  rrule: string | undefined,
  rdates: RecurrenceDate[],
  exdates: RecurrenceDate[],
  windowStart: Date,
  windowEnd: Date,
  cap: number,
): ExpansionResult {
  const dtstart: RecurrenceDate = {
    instant: startInstant(start),
    year: start.year,
    month: start.month,
    day: start.day,
  };

  if (rrule === undefined) {
    return {
      occurrences: mergeAndCap([dtstart], rdates, exdates, windowEnd, cap),
      unsupported: false,
    };
  }
  const rule = parseRrule(rrule, start);
  if (!rule) return { occurrences: [dtstart], unsupported: true };
  const series = generateSeries(start, rule, windowStart, windowEnd, cap);
  return { occurrences: mergeAndCap(series, rdates, exdates, windowEnd, cap), unsupported: false };
}
