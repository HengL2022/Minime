// Injectable clock so M5 review-scheduling tests can advance time without sleeping.
// Repo reads pass clock time as SQL params instead of using SQL now().

import { config } from "./config";

let fakeNow: Date | null = null;

export function now(): Date {
  return fakeNow ? new Date(fakeNow.getTime()) : new Date();
}

export function setNow(d: Date | null): void {
  fakeNow = d;
}

export function todayStr(timeZone = config.tz): string {
  // date in local TZ, YYYY-MM-DD
  return localDateStr(now(), timeZone);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function configuredTimeZone(timeZone?: string | null): string {
  const tz = timeZone?.trim() || config.tz.trim();
  if (!isValidTimeZone(tz)) throw new Error(`invalid time zone: ${tz}`);
  return tz;
}

const dayFmtCache = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  const tz = configuredTimeZone(timeZone);
  let fmt = dayFmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFmtCache.set(tz, fmt);
  }
  return fmt;
}

const partsFmtCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const tz = configuredTimeZone(timeZone);
  let fmt = partsFmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFmtCache.set(tz, fmt);
  }
  return fmt;
}

function partMap(d: Date, timeZone: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(timeZone).formatToParts(d)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out;
}

interface DateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function assertDateTimeParts(parts: DateTimeParts): void {
  const { year, month, day, hour, minute, second, millisecond } = parts;
  if (
    !Object.values(parts).every(Number.isInteger) ||
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59 ||
    millisecond < 0 ||
    millisecond > 999
  ) {
    throw new RangeError("invalid local date-time components");
  }
}

function utcLikeInstant(parts: DateTimeParts): Date {
  const d = new Date(0);
  d.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  d.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  return d;
}

function matchesLocalParts(d: Date, expected: DateTimeParts, timeZone: string): boolean {
  const actual = partMap(d, timeZone);
  return (
    actual.year === expected.year &&
    actual.month === expected.month &&
    actual.day === expected.day &&
    actual.hour === expected.hour &&
    actual.minute === expected.minute &&
    actual.second === expected.second &&
    d.getUTCMilliseconds() === expected.millisecond
  );
}

function nearbyOffsets(localEpochMs: number, timeZone: string): number[] {
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    offsets.add(timeZoneOffsetMs(new Date(localEpochMs + hours * 3_600_000), timeZone));
  }
  return [...offsets];
}

export function timeZoneOffsetMs(d: Date, timeZone = config.tz): number {
  const p = partMap(d, timeZone);
  const localAsUtc = utcLikeInstant({
    year: p.year!,
    month: p.month!,
    day: p.day!,
    hour: p.hour!,
    minute: p.minute!,
    second: p.second!,
    millisecond: d.getUTCMilliseconds(),
  });
  return localAsUtc.getTime() - d.getTime();
}

export function localDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
  timeZone = config.tz,
): Date {
  const tz = configuredTimeZone(timeZone);
  const parts = { year, month, day, hour, minute, second, millisecond };
  assertDateTimeParts(parts);
  const localEpochMs = utcLikeInstant(parts).getTime();
  const candidates = nearbyOffsets(localEpochMs, tz)
    .map((offset) => new Date(localEpochMs - offset))
    .sort((a, b) => a.getTime() - b.getTime());
  const exact = candidates.find((candidate) => matchesLocalParts(candidate, parts, tz));

  // The first exact instant is the first occurrence in a fall-back overlap. If the wall
  // time is inside a spring-forward gap, using the offset before the gap shifts it forward
  // by the gap, matching RFC/Temporal's compatible disambiguation.
  return exact ?? candidates[candidates.length - 1]!;
}

export function nextLocalMidnight(
  year: number,
  month: number,
  day: number,
  timeZone = config.tz,
): Date {
  const parts = { year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 };
  assertDateTimeParts(parts);
  let nextYear = year;
  let nextMonth = month;
  let nextDay = day + 1;
  if (nextDay > daysInMonth(year, month)) {
    nextDay = 1;
    nextMonth++;
    if (nextMonth > 12) {
      nextMonth = 1;
      nextYear++;
    }
  }
  return localDateTimeToUtc(nextYear, nextMonth, nextDay, 0, 0, 0, 0, timeZone);
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

export function formatDateTimeInTimeZone(d: Date, timeZone = config.tz): string {
  const tz = configuredTimeZone(timeZone);
  const p = partMap(d, tz);
  const offset = timeZoneOffsetMs(d, tz);
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const offsetHours = Math.floor(abs / 3_600_000);
  const offsetMinutes = Math.floor((abs % 3_600_000) / 60_000);
  return `${pad(p.year!, 4)}-${pad(p.month!)}-${pad(p.day!)}T${pad(p.hour!)}:${pad(
    p.minute!,
  )}:${pad(p.second!)}.${pad(d.getUTCMilliseconds(), 3)}${sign}${pad(offsetHours)}:${pad(
    offsetMinutes,
  )}`;
}

// Local-calendar YYYY-MM-DD for an arbitrary date, computed in the OWNER's configured
// timezone (config.tz) — NOT the process-local timezone. Use this everywhere a due-date
// or day bucket is compared against todayStr()/the agenda window.
//
// Why not Date's local getters (getFullYear/getMonth/getDate)? Those read the *process*
// timezone, which the JS runtime caches from process.env.TZ at startup. The minime daemons
// run with system localtime = Etc/UTC, and the repo .env TZ fallback is loaded AFTER the
// runtime initializes — too late to re-cache Date. So local getters returned the UTC day,
// drifting one day off for ~1/3 of the clock (after 16:00 UTC = past midnight in UTC+8) and
// stamping the 7am Asia/Singapore morning brief with yesterday. Intl.DateTimeFormat with an
// explicit timeZone is independent of the process TZ, so the boundary is correct regardless
// of how/where the daemon was launched. en-CA formats as YYYY-MM-DD. See DECISIONS.md.
export function localDateStr(d: Date, timeZone = config.tz): string {
  return dayFormatter(timeZone).format(d);
}

/**
 * Return the local calendar date `days` away from an instant. This deliberately
 * adds to the YYYY-MM-DD value rather than adding 24-hour durations, which can
 * skip or repeat a local date across daylight-saving transitions.
 */
export function addLocalCalendarDays(d: Date, days: number, timeZone = config.tz): string {
  if (!Number.isInteger(days)) throw new RangeError("calendar-day offset must be an integer");
  const [year, month, day] = localDateStr(d, timeZone).split("-").map(Number);
  const shifted = utcLikeInstant({
    year: year!,
    month: month!,
    day: day!,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(
    shifted.getUTCDate(),
  )}`;
}
