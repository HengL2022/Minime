// I6: numbers come from SQL aggregation only. Live caller-zone results are read-only;
// the configured owner-zone dream job is the sole writer of persisted rollups.

import { z } from "zod";
import { metricDef, runMetricAgg } from "../../db/repo";
import { configuredTimeZone } from "../../util/clock";
import { isMetricDate, reduceMetricSeries } from "../../util/metric-rollup";
import { ToolError, envelope } from "../envelope";
import type { ToolDef } from "./registry";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function queryMetric(
  name: string,
  from: string,
  to: string,
  granularity: "day" | "week" | "month",
  timeZone?: string,
) {
  const def = await metricDef(name);
  if (!def) throw new ToolError("UNKNOWN_METRIC", `no metric named '${name}'; see metric_defs`);
  if (!isMetricDate(from) || !isMetricDate(to))
    throw new ToolError("BAD_INPUT", "from/to must be valid YYYY-MM-DD dates");
  if (from > to) throw new ToolError("BAD_INPUT", "from must be on or before to");

  const effectiveTimeZone = configuredTimeZone(timeZone);
  const daily = await runMetricAgg(name, from, to, effectiveTimeZone);
  const series = reduceMetricSeries(daily, granularity, def.rollup);

  const gaps: string[] = [];
  if (series.length === 0) gaps.push(`no data for '${name}' between ${from} and ${to}`);
  return envelope(
    { metric: name, unit: def.unit, granularity, series },
    [{ type: "metric", id: name, title: def.description ?? name }],
    { gaps },
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
  handler: (params, ctx) =>
    queryMetric(params.name, params.from, params.to, params.granularity ?? "day", ctx.timeZone),
};
