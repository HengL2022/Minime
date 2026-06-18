// Every tool returns this envelope (spec §8, I7): data + sources + staleness + gaps,
// so agent answers can cite and disclose rather than confabulate.

import { configuredTimeZone, formatDateTimeInTimeZone, now } from "../util/clock";

export interface SourceRef {
  type: string;
  id: string;
  title?: string;
  updated_at?: Date | string;
  created_by?: string;
  derived?: boolean;
}

export interface Envelope<T = unknown> {
  data: T;
  sources: SourceRef[];
  staleness?: string;
  gaps?: string[];
}

export function envelope<T>(
  data: T,
  sources: SourceRef[] = [],
  opts?: { staleness?: string; gaps?: string[] },
): Envelope<T> {
  const env: Envelope<T> = { data, sources };
  if (opts?.staleness) env.staleness = opts.staleness;
  if (opts?.gaps?.length) env.gaps = opts.gaps;
  return env;
}

export function stalenessOf(
  newest: Date | string | null | undefined,
  what = "newest matching item",
): string | undefined {
  if (!newest) return undefined;
  const ageDays = Math.floor((now().getTime() - new Date(newest).getTime()) / 86_400_000);
  return ageDays > 30 ? `${what} is ${ageDays} days old` : undefined;
}

const DATE_ONLY_KEYS = new Set(["due", "review_at", "period_start", "valid_from", "valid_to"]);

function isTimestampKey(key?: string): boolean {
  if (!key || DATE_ONLY_KEYS.has(key)) return false;
  return key === "at" || key.endsWith("_at");
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}

export function localizeEnvelopeDates<T>(value: T, timeZone?: string): T {
  const tz = configuredTimeZone(timeZone);
  function visit(v: unknown, key?: string): unknown {
    if (v instanceof Date) {
      if (key && DATE_ONLY_KEYS.has(key)) return v.toISOString().slice(0, 10);
      return formatDateTimeInTimeZone(v, tz);
    }
    if (typeof v === "string") {
      if (key && DATE_ONLY_KEYS.has(key) && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
      if (isTimestampKey(key) && isIsoTimestamp(v))
        return formatDateTimeInTimeZone(new Date(v), tz);
      return v;
    }
    if (Array.isArray(v)) return v.map((item) => visit(item));
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([childKey, child]) => [
          childKey,
          visit(child, childKey),
        ]),
      );
    }
    return v;
  }
  return visit(value) as T;
}

// Structured refusals (spec §8): { code, message }
export class ToolError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
