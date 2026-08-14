// Vetted metric_defs.agg_sql template registry for `metric:add` (W4-8, src/cli.ts). Every
// template below is a FIXED skeleton, authored and reviewed here in source control — the CLI
// never accepts free-form SQL (there is deliberately no --sql flag; that stays migration-only,
// same as every metric_defs row seeded before this task). The only owner-supplied text any
// template ever splices in is the single scalar value it names (a health_samples kind, a
// transactions category, or a merchant substring): that value is validated against a narrow
// character class and SQL-literal-escaped before insertion, so no combination of flags can turn
// the generated string into anything but the same fixed shape every template already has —
// group-by-day over health_samples/transactions, returning exactly (period_start date, value
// numeric, label text) via the current 026/027 agg_sql contract ($1/$2 inclusive local dates,
// $3 the explicitly requested IANA zone). Neither source table is in repo.ts's PARENTS
// supersession map (028_correction_supersede.sql) — both are read-only import mirrors, not
// owner-authored content — so no template needs a `superseded_at` filter.
//
// This module only builds strings; it opens no database connection and executes nothing. The
// actual proof that a generated string is safe to keep comes from src/db/repo.ts's
// insertMetricDef, which dry-runs the freshly inserted def through metric_agg() inside the same
// transaction as the insert and rolls back on any failure.

import type { MetricRollup } from "./metric-rollup";

export type MetricTemplateId =
  | "health-sum"
  | "health-avg"
  | "health-count"
  | "spend-by-category"
  | "spend-by-merchant";

export const METRIC_TEMPLATE_IDS: readonly MetricTemplateId[] = Object.freeze([
  "health-sum",
  "health-avg",
  "health-count",
  "spend-by-category",
  "spend-by-merchant",
]);

export function isMetricTemplateId(value: string): value is MetricTemplateId {
  return (METRIC_TEMPLATE_IDS as readonly string[]).includes(value);
}

export type MetricTemplateParams =
  | { template: "health-sum"; kind: string }
  | { template: "health-avg"; kind: string }
  | { template: "health-count"; kind: string }
  | { template: "spend-by-category"; category: string }
  | { template: "spend-by-merchant"; merchantPattern: string };

export interface MetricTemplateResult {
  readonly aggSql: string;
  readonly rollup: MetricRollup;
}

// The single free-text value a template accepts — Unicode letters/digits, space, underscore,
// period, hyphen; 1-64 characters. No quote, percent, backslash, semicolon, or other SQL
// punctuation survives this class, so the escape step below is defense in depth, not the only
// guard: in ordinary use it never actually finds a quote to double.
const SAFE_VALUE_RE = /^[\p{L}\p{N} _.-]{1,64}$/u;

export function isSafeTemplateValue(value: string): boolean {
  return SAFE_VALUE_RE.test(value);
}

// Doubles an embedded single quote so a value is safe to splice as a SQL string literal (e.g.
// "O'Reilly" -> "O''Reilly"). SAFE_VALUE_RE already rejects any input containing a quote, so
// this never finds anything to escape through the public API below — kept anyway so the
// splicing step's safety does not silently depend on that regex never being loosened later.
function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

// LIKE/ILIKE metacharacter escaping, mirroring src/db/repo.ts's tier0CliEscapeLikePattern.
// Postgres's default LIKE escape character is backslash, so a literal "_" in the owner's text
// (allowed by SAFE_VALUE_RE) is escaped here to match itself instead of "any one character".
// '%' does not need escaping in the input — SAFE_VALUE_RE has no '%', so the only '%' characters
// that ever appear in a merchant pattern are the two this module adds itself, below.
function escapeLikeMetachars(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Validate + SQL-literal-escape a template's single scalar value for exact-match splicing. */
function exactLiteral(rawValue: string): string {
  if (!isSafeTemplateValue(rawValue)) throw new Error("metric_template_value_invalid");
  return escapeSqlLiteral(rawValue);
}

/** Validate + escape a template's scalar value for substring ILIKE splicing. */
function substringLiteral(rawValue: string): string {
  if (!isSafeTemplateValue(rawValue)) throw new Error("metric_template_value_invalid");
  return escapeSqlLiteral(`%${escapeLikeMetachars(rawValue)}%`);
}

const HEALTH_VALUE_EXPR: Record<"sum" | "avg" | "count", string> = {
  sum: "sum(value)::numeric",
  avg: "avg(value)::numeric",
  count: "count(*)::numeric",
};

// health-sum / health-avg / health-count: one health_samples kind, bucketed into the caller's
// requested local day via the timestamp contract 026_time_semantics.sql / 027_life_metrics_seed
// established for `at` — the same "(at at time zone $3)::date" expression 'steps'/'hr_resting'
// already use. Exact-match on `kind`, not a substring: health kinds are a small fixed vocabulary
// (src/importers/health.ts's KIND_WHITELIST), so "contains" semantics would only ever be
// confusing there, unlike merchant text below.
function healthAggSql(kind: string, mode: "sum" | "avg" | "count"): string {
  const escapedKind = exactLiteral(kind);
  return `select (at at time zone $3)::date as period_start,
       ${HEALTH_VALUE_EXPR[mode]} as value,
       null::text as label
  from health_samples
  where kind = '${escapedKind}'
    and (at at time zone $3)::date between $1 and $2
  group by 1 order by 1`;
}

// spend-by-category / spend-by-merchant: one transactions dimension, summing outflows only
// (amount_cents < 0, negated to a positive dollar figure) — the exact sign convention
// 006_metrics_seed.sql's spend_total/spend_by_category already use. `occurred_at` is a plain
// `date` column (005_mirrors.sql), not a timestamptz, so — as 026_time_semantics.sql's own
// comment puts it, "date-backed transactions need no conversion; timestamp-backed metrics do" —
// neither template references $3 at all, the same shape spend_total/spend_by_category have kept
// unmodified since 006 even after metric_agg() gained its timezone parameter in 026. $3 is still
// silently accepted (and ignored) on every call, since metric_agg() always binds all three.
// Both functions below share this exact SELECT/tail shape by construction (copy, not a runtime
// dependency) — each is deliberately a single, complete, independently-readable skeleton rather
// than one built from shared fragments, so a reviewer can read either function top to bottom.
const SPEND_VALUE_EXPR =
  "(sum(case when amount_cents < 0 then -amount_cents else 0 end) / 100.0)::numeric";

// Exact match: transaction categories are assigned by config/tx-categories.json's rules into a
// small, already-clean vocabulary, so "contains" semantics would add ambiguity for no benefit.
function spendByCategoryAggSql(category: string): string {
  const escaped = exactLiteral(category);
  return `select occurred_at as period_start,
       ${SPEND_VALUE_EXPR} as value,
       null::text as label
  from transactions
  where category = '${escaped}'
    and occurred_at between $1 and $2
  group by 1 order by 1`;
}

// Substring ILIKE match: raw bank merchant text is messy ("AMAZON.COM*ABC123 SEATTLE WA"), so
// unlike category, exact match would be impractical here — this is the one template that filters
// on a pattern rather than a value, matching its --merchant-pattern flag name.
function spendByMerchantAggSql(merchantPattern: string): string {
  const escaped = substringLiteral(merchantPattern);
  return `select occurred_at as period_start,
       ${SPEND_VALUE_EXPR} as value,
       null::text as label
  from transactions
  where merchant ilike '${escaped}'
    and occurred_at between $1 and $2
  group by 1 order by 1`;
}

/**
 * Generate one vetted agg_sql skeleton + its associated rollup for the given template params.
 * Throws `metric_template_value_invalid` when the caller's scalar value fails SAFE_VALUE_RE —
 * the only error this function can raise, since every skeleton is otherwise fixed.
 */
export function generateMetricTemplate(params: MetricTemplateParams): MetricTemplateResult {
  switch (params.template) {
    case "health-sum":
      return { aggSql: healthAggSql(params.kind, "sum"), rollup: "sum" };
    case "health-avg":
      return { aggSql: healthAggSql(params.kind, "avg"), rollup: "avg" };
    case "health-count":
      return { aggSql: healthAggSql(params.kind, "count"), rollup: "sum" };
    case "spend-by-category":
      return { aggSql: spendByCategoryAggSql(params.category), rollup: "sum" };
    case "spend-by-merchant":
      return { aggSql: spendByMerchantAggSql(params.merchantPattern), rollup: "sum" };
    default: {
      const exhaustive: never = params;
      throw new Error(`metric_template_unknown: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// A short, generic default description per template, used when the owner does not pass
// --description. Purely cosmetic (metric_defs.description is agent-visible via
// minime_list_metrics, same as every seeded metric's own description) — never part of agg_sql.
export const METRIC_TEMPLATE_DEFAULT_DESCRIPTION: Record<MetricTemplateId, string> = {
  "health-sum": "Daily total of a health_samples kind",
  "health-avg": "Daily average of a health_samples kind",
  "health-count": "Daily sample count of a health_samples kind",
  "spend-by-category": "Daily spend total for one transaction category",
  "spend-by-merchant": "Daily spend total for merchants matching a substring",
};
