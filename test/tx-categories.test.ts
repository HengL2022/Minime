// W4-7 — transaction category rules: owner-editable config/tx-categories.json applied at CSV
// import and minime_log_expense, plus a recategorize-transactions repair for existing rows.
// Modeled on test/merge-person.test.ts's three-tier coverage (pure logic / module directly /
// full scripts/repair.ts registry).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __safeRepairSummaryForTest, runRepair } from "../scripts/repair";
import recategorizeTransactionsRepairModule from "../scripts/repairs/recategorize-transactions";
import { recategorizeTransactions } from "../src/db/repo";
import { type TxProfile, importTransactions } from "../src/importers/transactions";
import { toolByName } from "../src/mcp/tools";
import { invokeTool } from "../src/mcp/tools/registry";
import {
  DEFAULT_TX_CATEGORY_RULES_PATH,
  TX_CATEGORY_RULES_INVALID_MESSAGE,
  type TxCategoryRule,
  applyCategoryRules,
  loadTxCategoryRules,
  parseTxCategoryRules,
} from "../src/util/tx-categories";
import { resetDb, testSql as sql } from "./helpers";
import { sessionToolCtx } from "./support/unlock";

const FIXTURES = join(import.meta.dir, "../fixtures");

async function insertTx(merchant: string, category: string | null, ref: string): Promise<string> {
  const [row] = await sql`
    insert into transactions
      (occurred_at, amount_cents, currency, merchant, category, account_label, external_ref,
       created_by, source, tier)
    values ('2026-07-01'::date, -1000, 'SGD', ${merchant}, ${category}, 'test', ${ref},
            'test', 'test', 0)
    returning id::text as id`;
  return row!.id as string;
}

describe("applyCategoryRules (pure rule matching)", () => {
  const RULES: TxCategoryRule[] = [
    { match: "netflix", category: "subscriptions" },
    { match: "grab", category: "transport", force: true },
    { match: "amazon", category: "shopping" },
  ];

  test("first matching rule fills a blank/null category", () => {
    expect(applyCategoryRules("NETFLIX.COM", null, RULES)).toBe("subscriptions");
    expect(applyCategoryRules("Netflix Inc", "", RULES)).toBe("subscriptions");
  });

  test("case-insensitive substring match", () => {
    expect(applyCategoryRules("i love NETFLIX and chill", null, RULES)).toBe("subscriptions");
  });

  test("a non-force rule never overrides an already-present category", () => {
    expect(applyCategoryRules("Netflix", "entertainment", RULES)).toBe("entertainment");
  });

  test("a force:true rule overrides an already-present category", () => {
    expect(applyCategoryRules("Grab", "misc", RULES)).toBe("transport");
  });

  test("force:true still just fills a blank category like any other rule", () => {
    expect(applyCategoryRules("Grab", null, RULES)).toBe("transport");
  });

  test("no matching rule leaves the given category untouched (or null)", () => {
    expect(applyCategoryRules("Some Random Merchant", "misc", RULES)).toBe("misc");
    expect(applyCategoryRules("Some Random Merchant", null, RULES)).toBeNull();
  });

  test("no merchant (or whitespace-only): rules are never consulted", () => {
    expect(applyCategoryRules(null, "misc", RULES)).toBe("misc");
    expect(applyCategoryRules(undefined, null, RULES)).toBeNull();
    expect(applyCategoryRules("   ", "misc", RULES)).toBe("misc");
  });

  test("first matching rule wins outright -- no fallthrough to a later rule that would apply", () => {
    const rules: TxCategoryRule[] = [
      { match: "prime", category: "should-not-win" },
      { match: "amazon", category: "shopping", force: true },
    ];
    // "Amazon Prime Video" matches the first ("prime") rule; that rule is not force and the
    // category is non-empty, so it does not apply -- and the second (force) rule, though it also
    // matches and would have applied, is never even reached.
    expect(applyCategoryRules("Amazon Prime Video", "existing", rules)).toBe("existing");
  });

  test("empty rules list is a pure passthrough", () => {
    expect(applyCategoryRules("Netflix", "food", [])).toBe("food");
    expect(applyCategoryRules("Netflix", null, [])).toBeNull();
  });
});

describe("loadTxCategoryRules / parseTxCategoryRules (validation)", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "minime-tx-categories-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a missing file passes through as no rules -- not an error", () => {
    expect(loadTxCategoryRules(join(dir, "does-not-exist.json"))).toEqual([]);
  });

  test("a well-formed file parses to the expected shape; match/category trimmed, force defaulted", () => {
    const path = join(dir, "tx-categories.json");
    writeFileSync(
      path,
      JSON.stringify([
        { match: " Netflix ", category: " subscriptions " },
        { match: "grab", category: "transport", force: true },
      ]),
    );
    expect(loadTxCategoryRules(path)).toEqual([
      { match: "Netflix", category: "subscriptions", force: false },
      { match: "grab", category: "transport", force: true },
    ]);
  });

  test.each([
    ["not valid JSON at all", "{not json"],
    ["a JSON object instead of an array", '{"match":"x","category":"y"}'],
    ["an array containing a non-object entry", '["netflix"]'],
    ["a rule missing category", '[{"match":"netflix"}]'],
    ["a rule missing match", '[{"category":"subscriptions"}]'],
    ["a rule with a non-string match", '[{"match":1,"category":"food"}]'],
    ["a rule with a non-string category", '[{"match":"netflix","category":1}]'],
    ["a rule with an empty match", '[{"match":"","category":"food"}]'],
    ["a rule with a whitespace-only match", '[{"match":"   ","category":"food"}]'],
    ["a rule with an empty category", '[{"match":"netflix","category":""}]'],
    ["a rule with a non-boolean force", '[{"match":"netflix","category":"food","force":"yes"}]'],
  ] as const)("rejects %s with the fixed error", (_label, text) => {
    expect(() => parseTxCategoryRules(text)).toThrow(TX_CATEGORY_RULES_INVALID_MESSAGE);
  });

  test("an existing-but-malformed file throws -- never silently treated as absent", () => {
    const path = join(dir, "tx-categories.json");
    writeFileSync(path, "not json");
    expect(() => loadTxCategoryRules(path)).toThrow(TX_CATEGORY_RULES_INVALID_MESSAGE);
  });

  test("the repository's own committed config/tx-categories.json is itself valid and non-empty", () => {
    expect(() => loadTxCategoryRules(DEFAULT_TX_CATEGORY_RULES_PATH)).not.toThrow();
    expect(loadTxCategoryRules().length).toBeGreaterThan(0);
  });
});

describe("importTransactions applies config/tx-categories.json rules", () => {
  beforeEach(resetDb);

  test("fixture CSV: blank category filled per rule (case-insensitive); explicit category kept when the rule isn't force; no match stays null", async () => {
    const csv = await Bun.file(join(FIXTURES, "transactions-categories.csv")).text();
    const profile = (await Bun.file(
      join(import.meta.dir, "../config/tx-profiles/dbs.json"),
    ).json()) as TxProfile;

    const stats = await importTransactions(csv, profile);
    expect(stats).toMatchObject({ total: 4, inserted: 4, skipped: 0 });

    const rows = await sql`
      select merchant, category from transactions where external_ref like 'FIXCAT-%'
      order by external_ref`;
    expect(rows.map((r) => ({ merchant: r.merchant, category: r.category }))).toEqual([
      { merchant: "Netflix", category: "subscriptions" },
      { merchant: "NETFLIX.COM Streaming", category: "subscriptions" }, // case-insensitive match
      { merchant: "Starbucks", category: "misc" }, // rule isn't force -> explicit CSV value kept
      { merchant: "Boulder Movement", category: null }, // no rule matches -> stays uncategorized
    ]);
  });
});

describe("minime_log_expense applies config/tx-categories.json rules when category is omitted", () => {
  beforeEach(resetDb);
  const ctx = sessionToolCtx("agent:test-harness");

  test("an omitted category is filled from a matching rule", async () => {
    const r = await invokeTool(
      toolByName("minime_log_expense"),
      { date: "2026-08-07", amount: "17.90", currency: "SGD", merchant: "Netflix" },
      ctx,
    );
    if (!r.ok) throw new Error(r.error.message);
    const id = (r.envelope.data as any).transaction_id;
    const [row] = await sql`select category from transactions where id = ${id}`;
    expect(row!.category).toBe("subscriptions");
  });

  test("an explicit category is kept as-is, never reconsidered against a rule", async () => {
    const r = await invokeTool(
      toolByName("minime_log_expense"),
      {
        date: "2026-08-07",
        amount: "5.00",
        currency: "SGD",
        merchant: "Netflix",
        category: "entertainment",
      },
      ctx,
    );
    if (!r.ok) throw new Error(r.error.message);
    const id = (r.envelope.data as any).transaction_id;
    const [row] = await sql`select category from transactions where id = ${id}`;
    expect(row!.category).toBe("entertainment");
  });

  test("no matching rule and no explicit category stays null", async () => {
    const r = await invokeTool(
      toolByName("minime_log_expense"),
      {
        date: "2026-08-07",
        amount: "5.00",
        currency: "SGD",
        merchant: "Totally Unknown Merchant Co",
      },
      ctx,
    );
    if (!r.ok) throw new Error(r.error.message);
    const id = (r.envelope.data as any).transaction_id;
    const [row] = await sql`select category from transactions where id = ${id}`;
    expect(row!.category).toBeNull();
  });
});

describe("recategorizeTransactions (repo)", () => {
  beforeEach(resetDb);

  const RULES: TxCategoryRule[] = [
    { match: "netflix", category: "subscriptions" },
    { match: "grab", category: "transport", force: true },
  ];

  test("default scope (category-null only): recategorizes null rows, never even scans an already-categorized one", async () => {
    const nullId = await insertTx("Netflix", null, "REPO-CAT-1");
    const keptId = await insertTx("Grab", "misc", "REPO-CAT-2");

    const res = await recategorizeTransactions(RULES, false);

    expect(res).toEqual({ scanned: 1, recategorized: 1 });
    const [nullRow] = await sql`select category from transactions where id = ${nullId}`;
    expect(nullRow!.category).toBe("subscriptions");
    const [keptRow] = await sql`select category from transactions where id = ${keptId}`;
    expect(keptRow!.category).toBe("misc");
  });

  test("includeAll scope: a force rule reaches an already-categorized row; a non-force rule still does not", async () => {
    const forcedId = await insertTx("Grab", "misc", "REPO-CAT-3");
    const untouchedId = await insertTx("Netflix", "entertainment", "REPO-CAT-4");

    const res = await recategorizeTransactions(RULES, true);

    expect(res).toEqual({ scanned: 2, recategorized: 1 });
    const [forcedRow] = await sql`select category from transactions where id = ${forcedId}`;
    expect(forcedRow!.category).toBe("transport");
    const [untouchedRow] = await sql`select category from transactions where id = ${untouchedId}`;
    expect(untouchedRow!.category).toBe("entertainment");
  });

  test("no-op when no rule matches: scanned but not counted as recategorized", async () => {
    await insertTx("Totally Unmatched Co", null, "REPO-CAT-5");

    const res = await recategorizeTransactions(RULES, false);

    expect(res).toEqual({ scanned: 1, recategorized: 0 });
  });

  test("the returned result is counts only -- never a merchant/category value", async () => {
    await insertTx("EXPENSESENTINEL-Netflix-Marker", null, "REPO-CAT-6");

    const res = await recategorizeTransactions(
      [{ match: "expensesentinel-netflix-marker", category: "EXPENSESENTINEL-should-not-leak" }],
      false,
    );

    expect(Object.keys(res).sort()).toEqual(["recategorized", "scanned"]);
    expect(JSON.stringify(res)).not.toContain("EXPENSESENTINEL");
  });
});

describe("scripts/repairs/recategorize-transactions.ts (module)", () => {
  beforeEach(resetDb);

  test("default run recategorizes null rows per the committed rules; returns the fixed {counts, ids} shape", async () => {
    expect(recategorizeTransactionsRepairModule.name).toBe("recategorize-transactions");
    const netflixId = await insertTx("Netflix", null, "MOD-CAT-1");
    const starbucksId = await insertTx("Starbucks", "misc", "MOD-CAT-2"); // out of default scope

    const summary = await recategorizeTransactionsRepairModule.run([]);
    const expected = { counts: { transactions_recategorized: 1 }, ids: [] as string[] };

    expect(summary).toEqual(expected);
    expect(__safeRepairSummaryForTest(summary)).toEqual(expected); // exactly what the runner accepts
    const [netflixRow] = await sql`select category from transactions where id = ${netflixId}`;
    expect(netflixRow!.category).toBe("subscriptions");
    const [starbucksRow] = await sql`select category from transactions where id = ${starbucksId}`;
    expect(starbucksRow!.category).toBe("misc");
  });

  test("--force-all widens the scanned scope but still only rewrites what a rule decides to change", async () => {
    const starbucksId = await insertTx("Starbucks", "misc", "MOD-CAT-3");

    const summary = await recategorizeTransactionsRepairModule.run(["--force-all"]);

    // the committed "starbucks" rule is not force:true, so even --force-all's wider scan leaves
    // an already-categorized Starbucks row alone -- --force-all only changes which rows are
    // CONSIDERED, never whether a non-force rule may overwrite one.
    expect(summary).toEqual({ counts: { transactions_recategorized: 0 }, ids: [] });
    const [row] = await sql`select category from transactions where id = ${starbucksId}`;
    expect(row!.category).toBe("misc");
  });
});

describe("repair.ts registry: recategorize-transactions", () => {
  let dumpScratch: string;
  let dumpDir: string;

  beforeEach(() => {
    dumpScratch = realpathSync(mkdtempSync(join(tmpdir(), "minime-recategorize-tx-repair-")));
    dumpDir = join(dumpScratch, "db-dump");
  });
  afterEach(() => {
    rmSync(dumpScratch, { recursive: true, force: true });
  });

  test("happy path: runRepair recategorizes per the committed rules and audits counts only, no merchant/category leak", async () => {
    if (!Bun.which("pg_dump")) return; // environment without client tools
    await resetDb();
    const sentinelMerchant = "EXPENSESENTINEL-netflix-marker"; // contains "netflix" -> matches
    const sentinelId = await insertTx(sentinelMerchant, null, "E2E-CAT-1");
    const untouchedId = await insertTx("EXPENSESENTINEL-nomatch", "misc", "E2E-CAT-2");
    const [prev] = await sql`select coalesce(max(id), 0)::int as max_id from events`;

    const code = await runRepair("recategorize-transactions", [], { dumpDir });

    expect(code).toBe(0);
    // the module actually ran (not just the CLI plumbing): the sentinel row was really matched.
    const [sentinelRow] = await sql`select category from transactions where id = ${sentinelId}`;
    expect(sentinelRow!.category).toBe("subscriptions");
    const [untouchedRow] = await sql`select category from transactions where id = ${untouchedId}`;
    expect(untouchedRow!.category).toBe("misc"); // out of default (category-null-only) scope

    const events = await sql`
      select verb, payload from events where verb like 'repair:%' and id > ${prev!.max_id}
      order by id`;
    expect(events.map((e) => e.verb)).toEqual(["repair:recategorize-transactions"]);
    expect(events[0]!.payload).toMatchObject({
      script: "recategorize-transactions",
      phase: "complete",
      code: "repair_complete",
      counts: { transactions_recategorized: 1 },
    });
    expect(events[0]!.payload.ids).toEqual([]);
    const eventsJson = JSON.stringify(events);
    expect(eventsJson).not.toContain("EXPENSESENTINEL");
    expect(eventsJson).not.toContain("subscriptions");
    expect(eventsJson).not.toContain("misc");
    const backups = [...new Bun.Glob("repair-recategorize-transactions-*.sql").scanSync(dumpDir)];
    expect(backups.length).toBeGreaterThan(0);
  });

  test("--force-all flag flows through runRepair: a force:true rule reaches an already-categorized row", async () => {
    if (!Bun.which("pg_dump")) return;
    await resetDb();
    const grabId = await insertTx("EXPENSESENTINEL-Grab-Ride", "misc", "E2E-CAT-3"); // contains "grab"
    const [prev] = await sql`select coalesce(max(id), 0)::int as max_id from events`;

    const code = await runRepair("recategorize-transactions", ["--force-all"], { dumpDir });

    expect(code).toBe(0);
    const [row] = await sql`select category from transactions where id = ${grabId}`;
    expect(row!.category).toBe("transport");
    const events = await sql`
      select payload from events
      where verb = 'repair:recategorize-transactions' and id > ${prev!.max_id}
      order by id`;
    expect(events[0]!.payload).toMatchObject({ counts: { transactions_recategorized: 1 } });
  });

  test("summary counts allowlist accepts the module's exact output shape", () => {
    const shape = { counts: { transactions_recategorized: 5 }, ids: [] as string[] };
    expect(__safeRepairSummaryForTest(shape)).toEqual(shape);
  });
});
