// Sanctioned repair: re-apply config/tx-categories.json's current rules to existing transaction
// rows -- for after the owner edits/adds a rule and wants it to reach rows an earlier import (or
// minime_log_expense call) already wrote. Wraps repo.recategorizeTransactions; category-only,
// never touches merchant/amount/date/note. Default scope is category-null rows ("fill gaps");
// --force-all considers every row, letting a force:true rule reach an already-categorized one too.
import { recategorizeTransactions } from "../../src/db/repo";
import { loadTxCategoryRules } from "../../src/util/tx-categories";
import type { RepairModule } from "../repair";

const mod: RepairModule = {
  name: "recategorize-transactions",
  description:
    "Re-apply config/tx-categories.json's rules to transactions: category-null rows by default, every row with --force-all.",
  async run(args) {
    const includeAll = args.includes("--force-all");
    const rules = loadTxCategoryRules();
    const res = await recategorizeTransactions(rules, includeAll);
    // counts only -- never a merchant/category value (I3), matching the runner's own
    // fixed-allowlist discipline (scripts/repair.ts's REPAIR_SUMMARY_COUNT_KEYS)
    return {
      counts: { transactions_recategorized: res.recategorized },
      ids: [],
    };
  },
};
export default mod;
