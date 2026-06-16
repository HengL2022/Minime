// Regression guard: localDateStr must compute the calendar day in the OWNER's
// configured timezone (config.tz), NOT the process-local timezone. The morning
// brief showed yesterday because the minime daemon runs with system localtime =
// Etc/UTC and the JS runtime caches process.env.TZ at startup — so the repo .env
// TZ fallback (loaded later) never re-cached Date, and localDateStr's getFullYear/
// getMonth/getDate getters returned the UTC day. Anchoring on Intl.DateTimeFormat
// with an explicit timeZone makes the boundary correct regardless of process TZ.

import { describe, expect, test } from "bun:test";
import { localDateStr } from "../src/util/clock";
import { config } from "../src/util/config";

describe("localDateStr honors config.tz independent of process TZ", () => {
  test("an instant that is the NEXT day in Asia/Singapore but PREVIOUS day in UTC resolves to the SGT day", () => {
    // 2026-06-16T23:30:00Z === 2026-06-17 07:30 in Asia/Singapore (UTC+8).
    // A UTC-anchored computation yields 2026-06-16 (the bug); the SGT day is 2026-06-17.
    const instant = new Date("2026-06-16T23:30:00.000Z");
    expect(config.tz).toBe("Asia/Singapore");
    expect(localDateStr(instant)).toBe("2026-06-17");
  });

  test("the SGT-day result matches an independent Intl computation in config.tz", () => {
    const instant = new Date("2026-06-16T23:30:00.000Z");
    const expected = new Intl.DateTimeFormat("en-CA", {
      timeZone: config.tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant); // en-CA → YYYY-MM-DD
    expect(localDateStr(instant)).toBe(expected);
  });
});
