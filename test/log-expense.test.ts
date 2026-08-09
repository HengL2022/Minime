// W4-6: minime_log_expense -- a tier-0 insert-only agent write (021's insert-only boundary,
// unchanged by migration 040's nullable `note` column) with CSV-import collision dedup.
// Mirrors commitments.test.ts's direct-invokeTool style; the SELECT-boundary probe reuses
// m15.roles.test.ts's mintTestAppRole pattern (m15.roles/m6.leak themselves are untouched).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type TxProfile, importTransactions } from "../src/importers/transactions";
import { toolByName } from "../src/mcp/tools";
import { invokeTool } from "../src/mcp/tools/registry";
import { config } from "../src/util/config";
import { expectSqlReject, resetDb, testSql as sql } from "./helpers";
import { type TestAppRoleLease, dropTestAppRole, mintTestAppRole } from "./support/app-role";
import { sessionToolCtx } from "./support/unlock";

const ctx = sessionToolCtx("agent:test-harness");
const call = async (name: string, params: Record<string, unknown>) => {
  const r = await invokeTool(toolByName(name), params, ctx);
  if (!r.ok) throw new Error(`${name} failed: ${r.error.code} ${r.error.message}`);
  return r.envelope;
};

describe("minime_log_expense: insert", () => {
  beforeEach(resetDb);

  test("lands at tier 0, provenance-stamped to the actor, amount stored negative", async () => {
    const logged = await call("minime_log_expense", {
      date: "2026-08-06",
      amount: "12.50",
      currency: "SGD",
      merchant: "EXPENSESENTINEL Kopitiam",
      category: "food",
      note: "EXPENSESENTINEL cash lunch",
    });
    const data = logged.data as any;
    expect(data.transaction_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(data.deduped).toBe(false);
    expect(logged.sources).toEqual([{ type: "transaction", id: data.transaction_id }]);

    const [row] = await sql`
      select amount_cents, currency, merchant, category, note, account_label, external_ref,
             created_by, source, tier
      from transactions where id = ${data.transaction_id}`;
    expect(row).toMatchObject({
      currency: "SGD",
      merchant: "EXPENSESENTINEL Kopitiam",
      category: "food",
      note: "EXPENSESENTINEL cash lunch",
      account_label: "agent-log",
      created_by: "agent:test-harness",
      source: "agent:log_expense",
      tier: 0,
    });
    // "amount is always stored as spend (negative) regardless of the sign given" -- typed
    // positive here, stored negative.
    expect(Number(row!.amount_cents)).toBe(-1250);
    expect(row!.external_ref).toMatch(/^[0-9a-f]{40}$/);
  });

  test("a typed-negative amount stores the same way (sign is a spend/not-spend flag, not data)", async () => {
    const logged = await call("minime_log_expense", {
      date: "2026-08-06",
      amount: "-30.00",
      currency: "SGD",
    });
    const [row] = await sql`
      select amount_cents from transactions where id = ${(logged.data as any).transaction_id}`;
    expect(Number(row!.amount_cents)).toBe(-3000);
  });
});

describe("minime_log_expense: dedup", () => {
  beforeEach(resetDb);

  test("re-logging the identical expense dedupes to the original row, sign-invariant", async () => {
    const first = await call("minime_log_expense", {
      date: "2026-08-05",
      amount: "9.90",
      currency: "SGD",
      merchant: "EXPENSESENTINEL Toast Box",
    });
    const firstData = first.data as any;
    expect(firstData.deduped).toBe(false);

    const second = await call("minime_log_expense", {
      date: "2026-08-05",
      amount: "9.90",
      currency: "SGD",
      merchant: "EXPENSESENTINEL Toast Box",
    });
    const secondData = second.data as any;
    expect(secondData.deduped).toBe(true);
    expect(secondData.transaction_id).toBe(firstData.transaction_id);

    // "-9.90" and "9.90" log the same expense (expense.ts's forced-negative sign convention) --
    // the dedupe hash is computed on the normalized amount, so this also dedupes.
    const third = await call("minime_log_expense", {
      date: "2026-08-05",
      amount: "-9.90",
      currency: "SGD",
      merchant: "EXPENSESENTINEL Toast Box",
    });
    expect((third.data as any).deduped).toBe(true);
    expect((third.data as any).transaction_id).toBe(firstData.transaction_id);

    const [row] = await sql`
      select count(*)::int as n from transactions where merchant = 'EXPENSESENTINEL Toast Box'`;
    expect(row!.n).toBe(1);
  });

  test("a different note breaks the dedupe -- a genuinely new row, not a collision", async () => {
    const first = await call("minime_log_expense", {
      date: "2026-08-05",
      amount: "9.90",
      currency: "SGD",
      merchant: "EXPENSESENTINEL Toast Box",
      note: "EXPENSESENTINEL breakfast",
    });
    const second = await call("minime_log_expense", {
      date: "2026-08-05",
      amount: "9.90",
      currency: "SGD",
      merchant: "EXPENSESENTINEL Toast Box",
      note: "EXPENSESENTINEL second cup",
    });
    expect((second.data as any).deduped).toBe(false);
    expect((second.data as any).transaction_id).not.toBe((first.data as any).transaction_id);
    const [row] = await sql`
      select count(*)::int as n from transactions where merchant = 'EXPENSESENTINEL Toast Box'`;
    expect(row!.n).toBe(2);
  });
});

describe("minime_log_expense: currency is required, no silent default", () => {
  beforeEach(resetDb);

  test("missing currency with no MINIME_DEFAULT_CURRENCY configured throws BAD_INPUT", async () => {
    expect(config.defaultCurrency).toBeUndefined();
    const r = await invokeTool(
      toolByName("minime_log_expense"),
      { date: "2026-08-01", amount: "3.50" },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.error.code).toBe("BAD_INPUT");

    const [row] = await sql`select count(*)::int as n from transactions`;
    expect(row!.n).toBe(0);
  });
});

describe("minime_log_expense: envelope and audit trail never carry tier-0 content back", () => {
  beforeEach(resetDb);

  test("the envelope is id/boolean only, and every audit event for this call is too", async () => {
    const sentinelMerchant = "EXPENSESENTINEL-MERCHANT-Kopitiam";
    const sentinelNote = "EXPENSESENTINEL-NOTE-do not leak me";
    const sentinelCategory = "EXPENSESENTINEL-CATEGORY-food";

    const logged = await call("minime_log_expense", {
      date: "2026-08-06",
      amount: "18.88",
      currency: "SGD",
      merchant: sentinelMerchant,
      category: sentinelCategory,
      note: sentinelNote,
    });
    const data = logged.data as any;
    // Exact shape -- {transaction_id, deduped} only, nothing echoed or read back.
    expect(Object.keys(data).sort()).toEqual(["deduped", "transaction_id"]);

    const envelopeJson = JSON.stringify(logged);
    for (const sentinel of [sentinelMerchant, sentinelNote, sentinelCategory, "18.88", "1888"]) {
      expect(envelopeJson).not.toContain(sentinel);
    }

    // I8: every call is audited (attempt + result). The generic sink only ever stores a
    // paramsHash and returned row ids (src/mcp/audit.ts) -- pin that guarantee for this
    // specific tool's own call, not just trust it generically.
    const events = await sql`
      select payload from events where verb like ${"tool:minime_log_expense%"} order by id`;
    expect(events.length).toBeGreaterThanOrEqual(2); // attempt + result
    const eventsJson = JSON.stringify(events);
    for (const sentinel of [sentinelMerchant, sentinelNote, sentinelCategory, "18.88", "1888"]) {
      expect(eventsJson).not.toContain(sentinel);
    }
    const resultEvent = events.find((e: any) => e.payload?.returned_ids !== undefined);
    expect(resultEvent?.payload?.returned_ids).toEqual([data.transaction_id]);
  });
});

describe("CSV bank import flags a collision with an agent-logged expense (W4-6 dedup)", () => {
  beforeEach(resetDb);

  test("a bank row on the same date+amount as an agent-log row raises one 'duplicate' review item, ids only", async () => {
    const logged = await call("minime_log_expense", {
      date: "2026-08-03",
      amount: "42.00",
      currency: "SGD",
      merchant: "EXPENSESENTINEL Cash Toast",
      note: "EXPENSESENTINEL paid cash",
    });
    const loggedData = logged.data as any;

    const profile: TxProfile = {
      account_label: "EXPENSESENTINEL-bank",
      currency: "SGD",
      columns: { date: "Date", amount: "Amount", merchant: "Merchant" },
      date_format: "YYYY-MM-DD",
      sign_convention: "negative_is_spend",
    };
    const csv = "Date,Amount,Merchant\n2026-08-03,-42.00,EXPENSESENTINEL Cafe Statement\n";
    const stats = await importTransactions(csv, profile);
    expect(stats).toMatchObject({ total: 1, inserted: 1, skipped: 0 });

    const [bankRow] = await sql`
      select id from transactions where account_label = ${profile.account_label}`;
    expect(bankRow).toBeDefined();

    const reviewRows = await sql`
      select id, kind, status, payload from review_queue where kind = 'duplicate'`;
    expect(reviewRows.length).toBe(1);
    expect(reviewRows[0]!.status).toBe("open");
    expect(reviewRows[0]!.payload).toEqual({
      transaction_id: bankRow!.id,
      existing_transaction_id: loggedData.transaction_id,
    });

    // Surfaced through the MCP review queue unmasked (ids only -- no CONTENT_KEYS to hide,
    // review-queue.ts's existing_task_id/inbox_item_id special-cases don't match this payload).
    const rq = await invokeTool(toolByName("minime_review_queue"), { kind: "duplicate" }, ctx);
    if (!rq.ok) throw new Error(rq.error.message);
    const items = (rq.envelope.data as any).items;
    expect(items).toHaveLength(1);
    expect(items[0].payload).toEqual({
      transaction_id: bankRow!.id,
      existing_transaction_id: loggedData.transaction_id,
    });
  });

  test("a bank import with no agent-log collision raises no review item", async () => {
    const profile: TxProfile = {
      account_label: "EXPENSESENTINEL-bank-solo",
      currency: "SGD",
      columns: { date: "Date", amount: "Amount" },
      date_format: "YYYY-MM-DD",
      sign_convention: "negative_is_spend",
    };
    const csv = "Date,Amount\n2026-08-03,-42.00\n";
    const stats = await importTransactions(csv, profile);
    expect(stats).toMatchObject({ total: 1, inserted: 1 });
    const [row] = await sql`
      select count(*)::int as n from review_queue where kind = 'duplicate'`;
    expect(row!.n).toBe(0);
  });
});

describe("boundary: minime_app cannot SELECT transactions -- table-scoped, not column-scoped (021, unchanged by 040)", () => {
  let appRole: TestAppRoleLease;
  let app: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await resetDb();
    appRole = await mintTestAppRole(config.databaseUrl);
    app = postgres(appRole.databaseUrl, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await app?.end({ timeout: 5 });
    await dropTestAppRole(appRole);
  });

  test("INSERT still succeeds (insert-only, not fully closed); SELECT and UPDATE are denied, note column included", async () => {
    await app`
      insert into transactions (occurred_at, amount_cents, currency, account_label, external_ref)
      values ('2026-08-02'::date, -700, 'SGD', 'EXPENSESENTINEL-role-probe', 'EXPENSESENTINEL-ref-1')`;

    await expectSqlReject(app`select * from transactions`, /permission denied/);
    await expectSqlReject(app`select note from transactions limit 1`, /permission denied/);
    await expectSqlReject(
      app`update transactions set note = 'x' where account_label = 'EXPENSESENTINEL-role-probe'`,
      /permission denied/,
    );
  });
});
