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
  const tz = timeZone?.trim() || config.tz;
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

export function timeZoneOffsetMs(d: Date, timeZone = config.tz): number {
  const p = partMap(d, timeZone);
  const asUtc = Date.UTC(
    p.year!,
    p.month! - 1,
    p.day!,
    p.hour!,
    p.minute!,
    p.second!,
    d.getUTCMilliseconds(),
  );
  return asUtc - d.getTime();
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
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const first = new Date(localAsUtc - timeZoneOffsetMs(new Date(localAsUtc), tz));
  return new Date(localAsUtc - timeZoneOffsetMs(first, tz));
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
