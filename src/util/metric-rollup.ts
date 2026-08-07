export type MetricRollup = "sum" | "last" | "avg";
export type MetricGranularity = "day" | "week" | "month";

export interface DailyMetricValue {
  period_start: string;
  value: number;
  label: string | null;
}

export interface MetricSeriesValue {
  period_start: string;
  value: number;
  label?: string;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isMetricDate(value: string): boolean {
  const match = DATE_ONLY.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  instant.setUTCHours(0, 0, 0, 0);
  return (
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === day
  );
}

/** PostgreSQL `date` values are calendar labels, so never render them with process-local getters. */
export function metricDateString(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

export function shiftMetricDate(date: string, days: number): string {
  if (!isMetricDate(date) || !Number.isSafeInteger(days)) throw new Error("invalid metric date");
  const match = DATE_ONLY.exec(date)!;
  const instant = new Date(0);
  instant.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  instant.setUTCHours(0, 0, 0, 0);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

export function metricPeriodStart(
  date: string,
  granularity: Exclude<MetricGranularity, "day">,
): string {
  if (!isMetricDate(date)) throw new Error("invalid metric date");
  if (granularity === "month") return `${date.slice(0, 7)}-01`;
  const match = DATE_ONLY.exec(date)!;
  const instant = new Date(0);
  instant.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  instant.setUTCHours(0, 0, 0, 0);
  const mondayOffset = (instant.getUTCDay() + 6) % 7;
  instant.setUTCDate(instant.getUTCDate() - mondayOffset);
  return instant.toISOString().slice(0, 10);
}

/** Reduce daily rows with the metric definition's declared week/month semantics. */
export function reduceMetricSeries(
  daily: readonly DailyMetricValue[],
  granularity: MetricGranularity,
  rollup: MetricRollup,
): MetricSeriesValue[] {
  if (granularity === "day") {
    return daily
      .map((row) => ({
        period_start: row.period_start,
        value: row.value,
        ...(row.label !== null ? { label: row.label } : {}),
      }))
      .sort(compareSeriesValues);
  }

  const buckets = new Map<
    string,
    { period_start: string; value: number; count: number; label: string | null; lastDate: string }
  >();
  for (const row of daily) {
    const periodStart = metricPeriodStart(row.period_start, granularity);
    const key = JSON.stringify([periodStart, row.label]);
    const current = buckets.get(key);
    if (!current) {
      buckets.set(key, {
        period_start: periodStart,
        value: row.value,
        count: 1,
        label: row.label,
        lastDate: row.period_start,
      });
    } else if (rollup === "sum" || rollup === "avg") {
      // 'avg' tracks a running sum + count here and divides only when emitting below, so
      // interleaved rows (any arrival order) still average correctly within a bucket.
      current.value += row.value;
      current.count += 1;
    } else if (row.period_start >= current.lastDate) {
      current.value = row.value;
      current.lastDate = row.period_start;
    }
  }

  return [...buckets.values()]
    .map((row) => ({
      period_start: row.period_start,
      value: rollup === "avg" ? row.value / row.count : row.value,
      ...(row.label !== null ? { label: row.label } : {}),
    }))
    .sort(compareSeriesValues);
}

function compareSeriesValues(a: MetricSeriesValue, b: MetricSeriesValue): number {
  return (
    a.period_start.localeCompare(b.period_start) || (a.label ?? "").localeCompare(b.label ?? "")
  );
}
