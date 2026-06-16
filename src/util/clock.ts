// Injectable clock so M5 review-scheduling tests can advance time without sleeping.
// Repo reads pass clock time as SQL params instead of using SQL now().

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

// Local-calendar YYYY-MM-DD for an arbitrary date. Use this everywhere a due-date
// or day bucket is compared against todayStr()/the agenda window. Do NOT use
// Date.toISOString().slice(0,10) for that purpose — that yields the UTC calendar
// day, which drifts one day off the local day for ~1/3 of the clock (e.g. after
// 16:00 in UTC+8), silently shifting every relative due-date by a day.
export function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
