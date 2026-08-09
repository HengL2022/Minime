// W4-7: owner-editable transaction category rules. Follows config/tx-profiles' JSON-config
// precedent (dbs.json) -- a single committed file the owner edits by hand, loaded and validated
// here, never touched by SQL. Two integration points share this module: the CSV importer
// (src/importers/transactions.ts, fills a blank/CSV-provided category at import time) and
// minime_log_expense (src/mcp/tools/expense.ts, fills a category the caller omitted). A third,
// scripts/repairs/recategorize-transactions.ts, re-applies the current rules to existing rows.
//
// Deliberately no SQL and no DB import anywhere in this file -- it is pure config-loading and
// string matching, callable from a plain importer function or an MCP tool handler without
// dragging repo.ts's tier machinery into what is really just "does this merchant substring match".

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./config";

export interface TxCategoryRule {
  readonly match: string; // case-insensitive substring match against the transaction's merchant
  readonly category: string;
  readonly force?: boolean; // override an already-present category, not just fill a gap
}

export const DEFAULT_TX_CATEGORY_RULES_PATH = join(REPO_ROOT, "config", "tx-categories.json");

// One fixed message for every validation failure. Deliberately never echoes the file's own
// content or names which field/rule failed -- the owner could paste something sensitive into a
// hand-edited config by mistake, and this codebase's convention (scripts/repair.ts's
// REPAIR_*_FAILURE_MESSAGE constants) is a fixed code, not a bespoke per-field message.
export const TX_CATEGORY_RULES_INVALID_MESSAGE =
  "tx category rules file is invalid (fixed message: tx_category_rules_invalid)";

function invalid(): never {
  throw new Error(TX_CATEGORY_RULES_INVALID_MESSAGE);
}

/**
 * Parses and validates rules already read into memory -- no I/O, so shape/precedence tests can
 * exercise it directly against inline strings instead of writing throwaway files to disk. Rejects
 * anything that is not a JSON array of {match, category, force?} objects with non-empty
 * (post-trim) string match/category and a boolean force when present. `match`/`category` are
 * trimmed before being stored, the same normalization the CSV importer already applies to every
 * cell it reads.
 */
export function parseTxCategoryRules(text: string): TxCategoryRule[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    invalid();
  }
  if (!Array.isArray(raw)) invalid();
  return raw.map((entry): TxCategoryRule => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid();
    const { match, category, force } = entry as Record<string, unknown>;
    if (typeof match !== "string" || typeof category !== "string") invalid();
    if (force !== undefined && typeof force !== "boolean") invalid();
    const trimmedMatch = match.trim();
    const trimmedCategory = category.trim();
    if (trimmedMatch.length === 0 || trimmedCategory.length === 0) invalid();
    return { match: trimmedMatch, category: trimmedCategory, force: force === true };
  });
}

/**
 * Loads config/tx-categories.json (or an explicit override path -- tests point this at a fixture
 * instead of the repo's own committed file). A MISSING file is a normal, unconfigured state (a
 * fresh install has never created one) and passes through as "no rules": every caller here just
 * leaves the category exactly as it already was. A file that EXISTS but fails validation is a
 * mistake worth surfacing, so that path throws instead of silently behaving as if absent.
 *
 * Re-reads and re-validates on every call rather than caching: this is an owner-edited,
 * low-frequency config (read once per CSV import, once per minime_log_expense call), not a hot
 * loop, so trivial cache-free correctness is worth more here than shaving one file read.
 */
export function loadTxCategoryRules(
  path: string = DEFAULT_TX_CATEGORY_RULES_PATH,
): TxCategoryRule[] {
  if (!existsSync(path)) return [];
  return parseTxCategoryRules(readFileSync(path, "utf8"));
}

/**
 * Pure: decides the category for one transaction from its merchant and whatever category the
 * caller already has (a CSV column's value, or null/undefined when there is none). Rules are
 * tried in file order; the FIRST rule whose `match` is a case-insensitive substring of the
 * merchant is the one and only rule considered -- there is no fallthrough to a later rule if the
 * first match doesn't end up applying. That winning rule is applied (its category replaces
 * whatever was given) when the existing category is empty/null, or unconditionally when the rule
 * itself has force: true; otherwise the existing category is kept exactly as given. No match, or
 * no merchant at all, returns the existing category unchanged.
 */
export function applyCategoryRules(
  merchant: string | null | undefined,
  existingCategory: string | null | undefined,
  rules: readonly TxCategoryRule[],
): string | null {
  const category = existingCategory?.trim() || null;
  const merchantText = merchant?.trim() || "";
  if (merchantText) {
    const lowerMerchant = merchantText.toLowerCase();
    for (const rule of rules) {
      if (!lowerMerchant.includes(rule.match.toLowerCase())) continue;
      return rule.force || !category ? rule.category : category;
    }
  }
  return category;
}
