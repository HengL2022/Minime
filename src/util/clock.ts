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
  const d = now();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
