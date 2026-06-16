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

export function todayStr(): string {
  // date in local TZ, YYYY-MM-DD
  return localDateStr(now());
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
const _dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: config.tz,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export function localDateStr(d: Date): string {
  return _dayFmt.format(d);
}
