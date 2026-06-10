// I6: numbers come from SQL aggregation only. Reads metric_values; missing periods are
// computed through metric_agg() (whitelisted, parameterized agg_sql) and persisted.

import { z } from "zod";
import { metricDef, runMetricAgg, storedMetricValues, upsertMetricValue } from "../../db/repo";
import { ToolError, envelope } from "../envelope";
import type { ToolDef } from "./registry";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function truncate(dateStr: string, granularity: "week" | "month"): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (granularity === "month") {
    return `${dateStr.slice(0, 7)}-01`;
  }
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export async function queryMetric(
  name: string,
  from: string,
  to: string,
  granularity: "day" | "week" | "month",
) {
  const def = await metricDef(name);
  if (!def) throw new ToolError("UNKNOWN_METRIC", `no metric named '${name}'; see metric_defs`);
  if (!DATE.test(from) || !DATE.test(to))
    throw new ToolError("BAD_INPUT", "from/to must be YYYY-MM-DD");

  const daily = await runMetricAgg(name, from, to);
  const labeled = daily.some((r) => r.label !== null);

  // persist day-granularity rollups for dimensionless metrics so state() anomalies work
  if (!labeled) {
    for (const r of daily) await upsertMetricValue(name, r.period_start, "day", r.value, "query");
  }

  let series: { period_start: string; value: number; label?: string }[];
  if (granularity === "day") {
    series = daily.map((r) => ({
      period_start: r.period_start,
      value: r.value,
      ...(r.label ? { label: r.label } : {}),
    }));
  } else {
    const acc = new Map<string, number>();
    for (const r of daily) {
      const key = `${truncate(r.period_start, granularity)}|${r.label ?? ""}`;
      acc.set(key, (acc.get(key) ?? 0) + r.value);
    }
    series = [...acc.entries()]
      .map(([key, value]) => {
        const [period_start, label] = key.split("|");
        return { period_start: period_start!, value, ...(label ? { label } : {}) };
      })
      .sort((a, b) => a.period_start.localeCompare(b.period_start));
  }

  const gaps: string[] = [];
  if (series.length === 0) gaps.push(`no data for '${name}' between ${from} and ${to}`);
  const stored = await storedMetricValues(name, from, to, "day");
  return envelope(
    { metric: name, unit: def.unit, granularity, series },
    [{ type: "metric", id: name, title: def.description ?? name }],
    {
      gaps,
      staleness:
        stored.length === 0 && series.length === 0
          ? "metric has never been computed for this range"
          : undefined,
    },
  );
}

export const queryMetricTool: ToolDef = {
  name: "minime_query_metric",
  description:
    "The ONLY path to quantitative answers (spend, sleep, steps, deep work, journal streak). Returns a numeric series via whitelisted SQL aggregation — never does the model do arithmetic over prose.",
  schema: {
    name: z.string().min(1),
    from: z.string().regex(DATE),
    to: z.string().regex(DATE),
    granularity: z.enum(["day", "week", "month"]).optional(),
  },
  handler: (params) =>
    queryMetric(params.name, params.from, params.to, params.granularity ?? "day"),
};
