// W4-6: minime_log_expense — a tier-0 insert-only agent write. Mirrors journal.ts/capture.ts's
// write-only shape (no read-back), but transactions has no per-row MCP read at any tier (I3): the
// envelope below is built entirely from values the caller supplied or this handler derived
// locally, never from a query against the row it just wrote.
import { createHash } from "node:crypto";
import { z } from "zod";
import { insertTransaction } from "../../db/repo";
import { parseAmountCents } from "../../importers/transactions";
import { config } from "../../util/config";
import { ToolError, envelope } from "../envelope";
import type { ToolDef } from "./registry";

const AGENT_LOG_ACCOUNT_LABEL = "agent-log";
const CURRENCY_RE = /^[A-Z]{3}$/;
const AMOUNT_RE = /^-?\d+(\.\d{1,2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Deterministic 128-bit row id, formatted as a Postgres uuid, derived from the exact same fields
 * as external_ref below (see insertTransaction's `id` doc in src/db/repo.ts for why this handler
 * can never learn a row's id from the database itself). Re-logging the identical expense derives
 * the identical id, so `transaction_id` in the returned envelope is correct on both the fresh-
 * insert path and the dedupe path -- never a placeholder unrelated to the row that actually
 * exists.
 */
function uuidFromHex(hashHex: string): string {
  const h = hashHex.slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export const logExpenseTool: ToolDef = {
  name: "minime_log_expense",
  description:
    "Log a cash or unbanked expense directly into the tier-0 transaction ledger (insert-only: " +
    "this tool, like every other MCP tool, can never read transaction rows back -- it never " +
    "echoes merchant, amount, or note in its result). Prefer a bank CSV import for card spend; " +
    "use this only for expenses that never hit a bank statement. Amount is always stored as " +
    "spend (negative) regardless of the sign given. Re-logging the exact same " +
    "date+amount+currency+merchant+note dedupes to the original row instead of double-counting " +
    "it. A later bank import that lands on the same date+amount flags itself in the review queue " +
    "(kind: duplicate) instead of silently double-counting the two together.",
  schema: {
    date: z.string().regex(DATE_RE).describe("YYYY-MM-DD, the date the expense occurred."),
    amount: z
      .string()
      .regex(AMOUNT_RE)
      .describe("Decimal dollars, e.g. '12.50'. Sign is ignored -- always stored as spend."),
    currency: z
      .string()
      .regex(CURRENCY_RE)
      .optional()
      .describe("3-letter ISO 4217 code. Falls back to MINIME_DEFAULT_CURRENCY when omitted."),
    merchant: z.string().optional(),
    category: z.string().optional(),
    note: z.string().optional(),
  },
  handler: async (params, ctx) => {
    const currency = params.currency ?? config.defaultCurrency;
    if (!currency) {
      throw new ToolError(
        "BAD_INPUT",
        "currency is required (no MINIME_DEFAULT_CURRENCY configured)",
      );
    }
    if (!CURRENCY_RE.test(currency)) {
      throw new ToolError("BAD_INPUT", "currency must be a 3-letter uppercase ISO 4217 code");
    }
    const parsedCents = parseAmountCents(params.amount);
    if (parsedCents === null) throw new ToolError("BAD_INPUT", "amount is not a valid decimal");
    // 006_metrics_seed.sql's sign convention: spend_total/spend_by_category only ever count
    // amount_cents < 0 as spend. This tool logs expenses only, so the stored sign is forced
    // negative regardless of what the caller typed -- "-12.50" and "12.50" log the same expense.
    const amountCents = parsedCents <= 0n ? parsedCents : -parsedCents;

    const merchant = params.merchant ?? null;
    const note = params.note ?? null;
    const hashHex = createHash("sha256")
      .update(`${params.date}|${amountCents}|${currency}|${merchant ?? ""}|${note ?? ""}`)
      .digest("hex");
    const id = uuidFromHex(hashHex);
    const externalRef = hashHex.slice(24);

    const inserted = await insertTransaction({
      id,
      occurredAt: params.date,
      amountCents,
      currency,
      merchant,
      category: params.category ?? null,
      note,
      accountLabel: AGENT_LOG_ACCOUNT_LABEL,
      externalRef,
      createdBy: ctx.actor,
      source: "agent:log_expense",
    });

    return envelope({ transaction_id: id, deduped: !inserted }, [{ type: "transaction", id }]);
  },
};
