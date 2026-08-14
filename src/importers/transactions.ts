// Bank CSV importer driven by per-bank profiles (config/tx-profiles/<bank>.json).
// Idempotent: dedupe on (account_label, external_ref); row-hash fallback when the
// bank provides no stable reference. Malformed rows are logged, never fatal (M4 AC).

import { createHash, randomUUID } from "node:crypto";
import { withAdminDbScope } from "../db/client";
import { findAgentLoggedTxMatch, insertReviewItem, insertTransaction, logEvent } from "../db/repo";
import { auditPayload } from "../util/audit-payload";
import { applyCategoryRules, loadTxCategoryRules } from "../util/tx-categories";
import type { ImportStats } from "./calendar";

export interface TxProfile {
  account_label: string;
  currency: string; // ISO 4217
  delimiter?: string; // default ','
  has_header?: boolean; // default true
  columns: {
    date: string;
    amount: string;
    merchant?: string;
    category?: string;
    external_ref?: string; // optional stable bank reference
  };
  date_format: "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY";
  // 'negative_is_spend': amounts already signed; 'positive_is_spend': flip sign on import
  sign_convention: "negative_is_spend" | "positive_is_spend";
}

// Small CSV parser handling quoted fields with embedded delimiters/quotes. No deps (boring).
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((f) => f !== "")) rows.push(row);
  }
  return rows;
}

export function parseProfileDate(value: string, format: TxProfile["date_format"]): string | null {
  const v = value.trim();
  let m: RegExpMatchArray | null;
  switch (format) {
    case "YYYY-MM-DD":
      m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
    case "DD/MM/YYYY":
      m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
    case "MM/DD/YYYY":
      m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
  }
}

export function parseAmountCents(value: string): bigint | null {
  const cleaned = value.replace(/[,$\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const negative = cleaned.startsWith("-");
  const [whole, frac = ""] = cleaned.replace("-", "").split(".");
  const cents = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, "0") || "0");
  return negative ? -cents : cents;
}

export async function importTransactions(
  csvText: string,
  profile: TxProfile,
): Promise<ImportStats> {
  const stats: ImportStats = { total: 0, inserted: 0, updated: 0, skipped: 0 };
  const rows = parseCsv(csvText, profile.delimiter ?? ",");
  if (rows.length === 0) return stats;
  // W4-7: loaded once per import call, not once per row (config/tx-categories.json, no SQL).
  const categoryRules = loadTxCategoryRules();

  const hasHeader = profile.has_header ?? true;
  const header = hasHeader ? rows[0]!.map((h) => h.trim()) : [];
  const col = (name: string | undefined): number =>
    name === undefined ? -1 : header.indexOf(name);
  const idx = {
    date: col(profile.columns.date),
    amount: col(profile.columns.amount),
    merchant: col(profile.columns.merchant),
    category: col(profile.columns.category),
    externalRef: col(profile.columns.external_ref),
  };
  if (hasHeader && (idx.date === -1 || idx.amount === -1)) {
    // The presumed header may actually be the first tier-0 transaction row when the
    // profile is wrong. Never copy input fields into an exception that the CLI can print.
    throw new Error("profile columns not found in CSV header");
  }

  for (const row of rows.slice(hasHeader ? 1 : 0)) {
    stats.total++;
    const dateRaw = row[idx.date] ?? "";
    const amountRaw = row[idx.amount] ?? "";
    const occurredAt = parseProfileDate(dateRaw, profile.date_format);
    let amount = parseAmountCents(amountRaw);
    if (!occurredAt || amount === null) {
      stats.skipped++;
      // never log row contents — transactions are tier 0
      await logEvent({
        actor: "importer:transactions",
        verb: "import:malformed",
        payload: auditPayload.importMalformed({
          importer: "transactions",
          reason: "invalid_date_or_amount",
          recordNumber: stats.total,
        }),
      });
      continue;
    }
    if (profile.sign_convention === "positive_is_spend") amount = -amount;
    const externalRef =
      idx.externalRef >= 0 && row[idx.externalRef]
        ? row[idx.externalRef]!.trim()
        : createHash("sha256").update(row.join("\u0000")).digest("hex").slice(0, 24);

    // Client-generated (not gen_random_uuid()'s DB-side default) so this row's own id is known
    // here without needing `returning id` -- see insertTransaction's `id` doc (src/db/repo.ts):
    // minime_app's insert-only grant on `transactions` means RETURNING is never available on this
    // path either. Functionally identical to the prior DB-generated default (both are random
    // v4-shaped UUIDs); only used below when this row turns out to collide with an agent-logged
    // expense worth flagging.
    const id = randomUUID();
    const merchant = idx.merchant >= 0 ? row[idx.merchant]?.trim() || null : null;
    const csvCategory = idx.category >= 0 ? row[idx.category]?.trim() || null : null;
    // W4-7: config/tx-categories.json fills a blank CSV category; a force:true rule can also
    // override a CSV-provided one. No match, or no rules configured, leaves csvCategory as-is.
    const category = applyCategoryRules(merchant, csvCategory, categoryRules);
    const inserted = await insertTransaction({
      id,
      occurredAt,
      amountCents: amount,
      currency: profile.currency,
      merchant,
      category,
      accountLabel: profile.account_label,
      externalRef,
    });
    if (inserted) {
      stats.inserted++;
      // W4-6: a same-day, same-amount minime_log_expense row already exists -- flag both for
      // owner review rather than silently letting the bank import double-count a cash expense
      // the owner already logged by hand. Admin-scoped: findAgentLoggedTxMatch is a genuine
      // SELECT on `transactions`, and minime_app has no SELECT grant on that table.
      const match = await withAdminDbScope(() => findAgentLoggedTxMatch(occurredAt, amount));
      if (match) {
        await insertReviewItem("duplicate", {
          transaction_id: id,
          existing_transaction_id: match.id,
        });
      }
    } else {
      stats.updated++; // duplicate: no-op upsert
    }
  }
  await logEvent({
    actor: "importer:transactions",
    verb: "import:transactions",
    payload: auditPayload.importSummary({ importer: "transactions", ...stats }),
  });
  return stats;
}
