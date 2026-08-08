// Pure date arithmetic for task recurrence (spec: task recurrence primitive). No DB, no clock —
// callers pass explicit YYYY-MM-DD calendar strings and get one back. There is no time-of-day or
// timezone component (non-goal: no time-of-day reminders); a recurring task's `due` is a plain
// SQL `date`, and this module treats every date as a calendar label, never an instant.

export type RecurFreq = "daily" | "weekly" | "monthly" | "yearly";

interface YMD {
  y: number;
  m: number; // 1-12
  d: number;
}

function parseYMD(s: string): YMD {
  const [y, m, d] = s.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

function formatYMD({ y, m, d }: YMD): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// Days since an arbitrary fixed epoch, for day-granularity cycle arithmetic. Date.UTC keeps
// this free of any process/DST timezone dependence — it's calendar math, never an instant.
function toEpochDay(ymd: YMD): number {
  return Math.floor(Date.UTC(ymd.y, ymd.m - 1, ymd.d) / 86_400_000);
}

function fromEpochDay(epochDay: number): YMD {
  const d = new Date(epochDay * 86_400_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function monthIndex(ymd: YMD): number {
  return ymd.y * 12 + (ymd.m - 1);
}

// Add `months` calendar months to a Y-M-D, clamping the day into the target month (Jan 31 + 1
// month -> Feb 28/29, never overflowing into March).
function addMonthsClamped(anchor: YMD, months: number): YMD {
  const total = monthIndex(anchor) + months;
  const y = Math.floor(total / 12);
  const m = (((total % 12) + 12) % 12) + 1;
  const d = Math.min(anchor.d, daysInMonth(y, m));
  return { y, m, d };
}

// Smallest `anchor + k*cycleDays` strictly after `fromDue`. Writing the anchor-to-fromDue gap
// as diff = q*cycleDays + r (0 <= r < cycleDays), (q+1)*cycleDays is always > diff — so this
// can never return a date <= fromDue, regardless of how far fromDue has drifted out of phase
// with the anchor (a manually-edited due date, an interval change, etc). When it IS in phase
// (the normal case: each successor's own due becomes the next call's fromDue), the result lands
// exactly `interval` cycles later, preserving the anchor's weekday exactly (cycleDays is always
// a multiple of 7 for "weekly").
function nextDayCycle(anchor: YMD, cycleDays: number, fromDue: YMD): YMD {
  const diff = toEpochDay(fromDue) - toEpochDay(anchor);
  const q = Math.floor(diff / cycleDays);
  return fromEpochDay(toEpochDay(anchor) + (q + 1) * cycleDays);
}

// Same derivation as nextDayCycle one calendar level up: cycles of `cycleMonths` months from
// the anchor's own day-of-month, end-of-month clamped every step. Because month index alone
// (not day-within-month) determines chronological order, the same q/r argument guarantees the
// result's month is always strictly after fromDue's month — so, unlike a naive "add N months to
// fromDue" walk, a clamped short month (Jan 31 -> Feb 28) never permanently downgrades the
// series to the 28th; the next cycle recovers the anchor's real day (Mar 31).
function nextMonthCycle(anchor: YMD, cycleMonths: number, fromDue: YMD): YMD {
  const diff = monthIndex(fromDue) - monthIndex(anchor);
  const q = Math.floor(diff / cycleMonths);
  return addMonthsClamped(anchor, (q + 1) * cycleMonths);
}

/**
 * Next due date strictly after `fromDue` for a recurring task.
 *
 * `anchor` fixes the phase — the weekday for `weekly`, the day-of-month (end-of-month clamped)
 * for `monthly`/`yearly` — so an interval > 1 (biweekly, quarterly) stays locked to the
 * original due date's phase even when a completion lands off-cycle. `anchor` defaults to
 * `fromDue` when null (recurrence enabled with no recur_anchor persisted yet), which degrades
 * to "N units after this due date" with no fixed phase to preserve — exactly reproduces a
 * persisted anchor's result for `daily`/`weekly` (cycle length is a multiple of 7 either way),
 * but for `monthly`/`yearly` will not recover a clamped day-of-month the way a real anchor does.
 */
export function nextDue(
  freq: RecurFreq,
  interval: number,
  anchor: string | null,
  fromDue: string,
): string {
  if (!Number.isInteger(interval) || interval < 1) {
    throw new RangeError(`recur_interval must be a positive integer, got ${interval}`);
  }
  const anchorYmd = parseYMD(anchor ?? fromDue);
  const fromYmd = parseYMD(fromDue);
  switch (freq) {
    case "daily":
      return formatYMD(nextDayCycle(anchorYmd, interval, fromYmd));
    case "weekly":
      return formatYMD(nextDayCycle(anchorYmd, interval * 7, fromYmd));
    case "monthly":
      return formatYMD(nextMonthCycle(anchorYmd, interval, fromYmd));
    case "yearly":
      return formatYMD(nextMonthCycle(anchorYmd, interval * 12, fromYmd));
    default: {
      const exhaustive: never = freq;
      throw new RangeError(`unknown recur_freq: ${exhaustive}`);
    }
  }
}
