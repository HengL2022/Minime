// W3-4: minime_search from/to date-range filters. Verifies the filter narrows hits by each
// parent type's semantic event date (repo.ts PARENTS[type].dateCol) rather than always
// updated_at, and that an empty in-window result set falls through to search's existing
// zero-hit gap rather than a bespoke date-empty message (spec: "searchTool's existing zero-hit
// gap fires").

import { beforeAll, describe, expect, test } from "bun:test";
import { insertDecision, insertJournal, upsertPage } from "../src/db/repo";
import type { Envelope } from "../src/mcp/envelope";
import { toolByName } from "../src/mcp/tools";
import { type ToolCtx, type ToolResult, invokeTool } from "../src/mcp/tools/registry";
import { indexParent } from "../src/search/index-parent";
import { addLocalCalendarDays, now, todayStr } from "../src/util/clock";
import { resetDb } from "./helpers";
import { sessionToolCtx } from "./support/unlock";

const ctx: ToolCtx = sessionToolCtx("agent:search-daterange");

function expectOk(result: ToolResult): Envelope<{ hits: any[] }> {
  if (!result.ok)
    throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result.envelope as Envelope<{ hits: any[] }>;
}

function search(params: Record<string, unknown>): Promise<ToolResult> {
  return invokeTool(toolByName("minime_search"), params, ctx);
}

let journalId: string;
let pageId: string;
let decisionId: string;

beforeAll(async () => {
  await resetDb();

  // Journal: `at` (2024-01-15) is the semantic date; `updated_at` defaults to "now" (today) —
  // far outside every 2023/2024 window below, so a pass here can only be explained by the
  // filter reading `at`, not `updated_at`.
  const entryMd = "Fictional diary entry: the ZQXFERRETDIARY kayaking trip along the fjord.";
  const journal = await insertJournal({
    entryMd,
    tier: 1, // avoids the tier-2 unlock ceremony; irrelevant to what this test checks
    createdBy: "human",
    source: "test:search-daterange",
    at: new Date("2024-01-15T12:00:00Z"),
  });
  journalId = journal.id;
  await indexParent("journal", journalId, entryMd, undefined, 1);

  // Page: has no dedicated event-date column, so its dateCol is plain updated_at (the
  // "everything else" default in the PARENTS map). Pages' updated_at is trigger-owned
  // (set_updated_at() forces it to real now() on every write, INSERT included) so it can't be
  // backdated directly — instead the in/out-of-window assertions below bracket "today" itself.
  const title = "ZQXKESTRELPAGE nesting survey";
  const body = "# ZQXKESTRELPAGE nesting survey\n\nField notes on kestrel nesting sites.";
  const page = await upsertPage({
    path: "test/search-daterange-page.md",
    title,
    bodyMd: body,
    contentHash: "search-daterange-page-h1",
    tier: 1,
    createdBy: "human",
    source: "manual",
  });
  pageId = page.id;
  await indexParent("page", pageId, body, title, 1);

  // Decision: dateCol is coalesce(decided_at, created_at) — the one non-trivial SQL expression
  // in the PARENTS map, worth its own smoke test since it exercises db().unsafe() nesting a
  // multi-column expression rather than a bare identifier. decided_at is set explicitly and far
  // in the past; updated_at (left unset) defaults to "now", so this also proves the coalesce
  // wins over updated_at, same as the journal case above.
  const question = "ZQXWALRUSDECISION should we relocate the aquarium habitat";
  const decision = await insertDecision({
    question,
    options: ["Yes", "No"],
    decidedAt: new Date("2022-05-01T00:00:00Z"),
    createdBy: "human",
    source: "test:search-daterange",
  });
  decisionId = decision.id;
  await indexParent(
    "decision",
    decisionId,
    `# Decision: ${question}\n\nWalrus habitat relocation planning notes.`,
    undefined,
    1,
  );
});

describe("minime_search from/to date filters", () => {
  test("journal: filters by its own `at`, not `updated_at`", async () => {
    const inWindow = expectOk(
      await search({ query: "ZQXFERRETDIARY", from: "2024-01-01", to: "2024-01-31" }),
    );
    expect(inWindow.data.hits.some((h) => h.id === journalId)).toBe(true);

    const outOfWindow = expectOk(
      await search({ query: "ZQXFERRETDIARY", from: "2023-01-01", to: "2023-01-31" }),
    );
    expect(outOfWindow.data.hits.some((h) => h.id === journalId)).toBe(false);

    // control: unfiltered search still finds it, isolating the date filter as the variable.
    const unfiltered = expectOk(await search({ query: "ZQXFERRETDIARY" }));
    expect(unfiltered.data.hits.some((h) => h.id === journalId)).toBe(true);
  });

  test("page: filters by updated_at, the default dateCol for types with no dedicated event date", async () => {
    const today = todayStr();
    const yesterday = addLocalCalendarDays(now(), -1);

    const inWindow = expectOk(await search({ query: "ZQXKESTRELPAGE", from: today, to: today }));
    expect(inWindow.data.hits.some((h) => h.id === pageId)).toBe(true);

    const outOfWindow = expectOk(
      await search({ query: "ZQXKESTRELPAGE", from: "2020-01-01", to: yesterday }),
    );
    expect(outOfWindow.data.hits.some((h) => h.id === pageId)).toBe(false);
  });

  test("decision: filters by coalesce(decided_at, created_at), not updated_at", async () => {
    const inWindow = expectOk(
      await search({ query: "ZQXWALRUSDECISION", from: "2022-04-01", to: "2022-05-31" }),
    );
    expect(inWindow.data.hits.some((h) => h.id === decisionId)).toBe(true);

    const outOfWindow = expectOk(
      await search({ query: "ZQXWALRUSDECISION", from: "2021-01-01", to: "2021-12-31" }),
    );
    expect(outOfWindow.data.hits.some((h) => h.id === decisionId)).toBe(false);
  });

  test("an open-ended from or to (only one bound given) still narrows correctly", async () => {
    const fromOnly = expectOk(await search({ query: "ZQXFERRETDIARY", from: "2024-01-01" }));
    expect(fromOnly.data.hits.some((h) => h.id === journalId)).toBe(true);

    const toOnlyExcludes = expectOk(await search({ query: "ZQXFERRETDIARY", to: "2023-12-31" }));
    expect(toOnlyExcludes.data.hits.some((h) => h.id === journalId)).toBe(false);
  });

  test("a window matching nothing yields the standard zero-hit gap", async () => {
    const result = expectOk(
      await search({ query: "ZQXFERRETDIARY", from: "2099-01-01", to: "2099-01-31" }),
    );
    expect(result.data.hits).toEqual([]);
    expect(result.gaps).toContain(
      "no indexed content matches the query at the current access tier",
    );
  });

  test("from after to is rejected as BAD_INPUT", async () => {
    const result = await search({
      query: "ZQXFERRETDIARY",
      from: "2024-02-01",
      to: "2024-01-01",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("BAD_INPUT");
  });
});
