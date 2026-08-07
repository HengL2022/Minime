// W2-3: minime_refile files a pending inbox capture into a typed row, reusing the watcher's
// fileRow/claim machinery. Anti-laundering cross-check: refiling requires an active tier-2
// unlock (a pending capture's text is tier-2-gated exactly like the review-queue read path,
// DECISIONS.md 2026-08-08), and a note tier override can only raise — never lower — the tier
// the capture's own stored classifier evidence implies.

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { toolByName } from "../src/mcp/tools";
import { type ToolResult, invokeTool } from "../src/mcp/tools/registry";
import { processInboxFile } from "../src/pipeline/watcher";
import { config } from "../src/util/config";
import { resetDb, testSql } from "./helpers";
import { requestAndApproveTier2, sessionToolCtx } from "./support/unlock";

const inboxDir = join(config.dataDir, "inbox");

beforeAll(async () => {
  await resetDb();
  await mkdir(inboxDir, { recursive: true });
});

/** Write a capture that the mocked heuristic classifier leaves pending (low confidence). */
async function pendingUnfiled(name: string, text: string): Promise<string> {
  const path = join(inboxDir, name);
  await Bun.write(path, text);
  const { inboxId, filed } = await processInboxFile(path);
  expect(filed).toBe(false);
  return inboxId;
}

function refile(
  ctx: ReturnType<typeof sessionToolCtx>,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  return invokeTool(toolByName("minime_refile"), params, ctx);
}

function expectOk(result: ToolResult): Record<string, any> {
  if (!result.ok)
    throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result.envelope.data as Record<string, any>;
}

function expectErr(result: ToolResult): { code: string; message: string } {
  if (result.ok) throw new Error("expected failure, got success");
  return result.error;
}

describe("minime_refile", () => {
  test("refiles a pending capture as a journal entry: row filed, review item resolved, event logged", async () => {
    const text = "unclear: ZQX-REFILE-JOURNAL fictional note about the tide log";
    const inboxId = await pendingUnfiled("zqx-refile-journal.md", text);
    const [reviewBefore] = await testSql`
      select id from review_queue
      where kind = 'inbox_unfiled' and payload ->> 'inbox_item_id' = ${inboxId} and status = 'open'`;
    expect(reviewBefore).toBeTruthy();

    const ctx = sessionToolCtx("agent:refile-journal");
    await requestAndApproveTier2(ctx);
    const result = await refile(ctx, { inbox_item_id: inboxId, type: "journal", mood: 4 });
    const data = expectOk(result);
    expect(data.filed_table).toBe("journal_entries");
    expect(data.resolved_review_items).toContain(reviewBefore!.id);

    const [journalRow] = await testSql`
      select entry_md, mood, derived_from, tier, source
      from journal_entries where id = ${data.filed_id}::uuid`;
    expect(journalRow!.entry_md).toBe(text);
    expect(journalRow!.mood).toBe(4);
    expect(journalRow!.derived_from).toBe(inboxId);
    expect(journalRow!.tier).toBe(2);

    const [inboxRow] = await testSql`
      select status, filed_table, filed_id from inbox_items where id = ${inboxId}::uuid`;
    expect(inboxRow).toEqual({
      status: "filed",
      filed_table: "journal_entries",
      filed_id: data.filed_id,
    });

    const [reviewAfter] = await testSql`
      select status from review_queue where id = ${reviewBefore!.id}::uuid`;
    expect(reviewAfter!.status).toBe("resolved");

    const [event] = await testSql`
      select payload from events
      where verb = 'inbox:refiled' and entity_id = ${inboxId}::uuid`;
    expect(event!.payload).toEqual({
      type: "journal",
      filed_table: "journal_entries",
      filed_id: data.filed_id,
    });

    // Capture text never rides back in the envelope.
    expect(JSON.stringify(result)).not.toContain("tide log");
  });

  test("refiling as a note honors an explicit tier override and publishes the projection", async () => {
    const text = "unclear: ZQX-REFILE-NOTE fictional reference about mooring hardware";
    const inboxId = await pendingUnfiled("zqx-refile-note.md", text);

    const ctx = sessionToolCtx("agent:refile-note");
    await requestAndApproveTier2(ctx);
    const data = expectOk(
      await refile(ctx, {
        inbox_item_id: inboxId,
        type: "note",
        title: "Mooring hardware reference",
        tier: 2,
      }),
    );
    expect(data.filed_table).toBe("pages");

    const [page] = await testSql`
      select path, tier, body_md from pages where id = ${data.filed_id}::uuid`;
    expect(page!.tier).toBe(2);
    const projected = await readFile(join(config.dataDir, "brain", String(page!.path)), "utf8");
    expect(projected).toBe(page!.body_md);
    expect(projected).toContain("ZQX-REFILE-NOTE");
  });

  test("refiling without an active tier-2 unlock is rejected and leaves the item pending", async () => {
    const inboxId = await pendingUnfiled(
      "zqx-refile-locked.md",
      "unclear: ZQX-REFILE-LOCKED fictional note about the compass rose",
    );
    const error = expectErr(
      await refile(sessionToolCtx("agent:refile-locked"), {
        inbox_item_id: inboxId,
        type: "note",
      }),
    );
    expect(error.code).toBe("BAD_INPUT");
    expect(error.message).toContain("tier-2 unlock");

    const [row] = await testSql`select status from inbox_items where id = ${inboxId}::uuid`;
    expect(row!.status).toBe("pending");
  });

  test("a note tier override is floored by the capture's stored journal/interaction evidence", async () => {
    const inboxId = await pendingUnfiled(
      "zqx-refile-floor.md",
      "unclear: ZQX-REFILE-FLOOR fictional reflection about the storm watch",
    );
    // Simulate the ORIGINAL automatic pass having guessed "journal" at too-low confidence to
    // auto-file (so the item stayed pending for review). Direct-SQL test scaffolding — not an
    // application write path (test/helpers.ts).
    await testSql`
      update inbox_items
      set classifier_output = ${testSql.json({
        type: "journal",
        confidence: 0.5,
        fields: { mood: null },
        reason: "synthetic test evidence",
      })}
      where id = ${inboxId}::uuid`;

    const ctx = sessionToolCtx("agent:refile-floor");
    await requestAndApproveTier2(ctx);
    const data = expectOk(
      await refile(ctx, {
        inbox_item_id: inboxId,
        type: "note",
        title: "Storm watch note",
        tier: 1, // requested below the floor
      }),
    );
    const [page] = await testSql`select tier from pages where id = ${data.filed_id}::uuid`;
    expect(page!.tier).toBe(2); // floored, not the requested 1
  });

  test("a non-pending (already filed) item is rejected", async () => {
    const path = join(inboxDir, "zqx-refile-filed.md");
    const text = "todo: ZQX-REFILE-FILED sailboat winch tuning by 2099-01-01";
    await Bun.write(path, text);
    const { inboxId, filed } = await processInboxFile(path);
    expect(filed).toBe(true);

    const ctx = sessionToolCtx("agent:refile-filed");
    await requestAndApproveTier2(ctx);
    const error = expectErr(await refile(ctx, { inbox_item_id: inboxId, type: "note" }));
    expect(error.code).toBe("BAD_INPUT");
    expect(error.message).toContain("already filed");
  });

  test("an unknown inbox item is rejected before any tier check", async () => {
    const error = expectErr(
      await refile(sessionToolCtx("agent:refile-missing"), {
        inbox_item_id: "11111111-1111-4111-8111-111111111111",
        type: "note",
      }),
    );
    expect(error.code).toBe("NOT_FOUND");
  });

  test("type=task with a past due override respects fileRow's date guardrail", async () => {
    const inboxId = await pendingUnfiled(
      "zqx-refile-pastdate.md",
      "unclear: ZQX-REFILE-PASTDATE kayak rudder alignment note",
    );
    const ctx = sessionToolCtx("agent:refile-pastdate");
    await requestAndApproveTier2(ctx);
    const data = expectOk(
      await refile(ctx, {
        inbox_item_id: inboxId,
        type: "task",
        title: "ZQX-REFILE-PASTDATE kayak rudder alignment",
        due: "2020-01-01",
      }),
    );
    const [task] = await testSql`
      select due, body, tier, derived_from from tasks where id = ${data.filed_id}::uuid`;
    expect(task!.due).toBeNull();
    expect(String(task!.body)).toContain("date guardrail");
    expect(String(task!.body)).toContain("2020-01-01");
    expect(task!.tier).toBe(1);
    expect(task!.derived_from).toBe(inboxId);
  });

  test("a fileRow duplicate result surfaces as BAD_INPUT and rolls back cleanly", async () => {
    await testSql`
      insert into tasks (title, status, tier)
      values ('ZQX-REFILE-DUP fictional pier inspection', 'active', 1)`;
    const inboxId = await pendingUnfiled(
      "zqx-refile-dup.md",
      "unclear: ZQX-REFILE-DUP fictional pier inspection",
    );
    const [reviewBefore] = await testSql`
      select id, status from review_queue
      where kind = 'inbox_unfiled' and payload ->> 'inbox_item_id' = ${inboxId}`;
    expect(reviewBefore!.status).toBe("open");

    const ctx = sessionToolCtx("agent:refile-dup");
    await requestAndApproveTier2(ctx);
    const error = expectErr(
      await refile(ctx, {
        inbox_item_id: inboxId,
        type: "task",
        title: "ZQX-REFILE-DUP fictional pier inspection",
      }),
    );
    expect(error.code).toBe("BAD_INPUT");
    expect(error.message).toContain("existing open task");

    // The whole attempt is one transaction (minime_refile runs inside the tool call's ambient
    // actor transaction, so a throw here rolls back everything fileRow did too, including its
    // own duplicate review item/event) — the item is left exactly as it was: still pending, its
    // original classification untouched, no new task, and the pre-existing inbox_unfiled item
    // still open and unresolved.
    expect(
      await testSql`select id from tasks where title = 'ZQX-REFILE-DUP fictional pier inspection'`,
    ).toHaveLength(1); // only the pre-inserted existing task, no second row
    expect(
      await testSql`
        select id from review_queue
        where kind = 'duplicate' and payload ->> 'inbox_item_id' = ${inboxId}`,
    ).toHaveLength(0);
    expect(
      await testSql`
        select id from events
        where verb = 'inbox:duplicate' and entity_id = ${inboxId}::uuid`,
    ).toHaveLength(0);
    const [inboxRow] = await testSql`
      select status, classifier_output from inbox_items where id = ${inboxId}::uuid`;
    expect(inboxRow!.status).toBe("pending");
    expect((inboxRow!.classifier_output as any).type).toBe("unknown"); // unchanged by the attempt
    const [reviewAfter] = await testSql`
      select status from review_queue where id = ${reviewBefore!.id}::uuid`;
    expect(reviewAfter!.status).toBe("open");
  });

  test("racing a concurrent claim loses cleanly: exactly one refile call wins, no double-filing", async () => {
    const inboxId = await pendingUnfiled(
      "zqx-refile-race.md",
      "unclear: ZQX-REFILE-RACE fictional note about the anchor chain",
    );
    const ctx = sessionToolCtx("agent:refile-race");
    await requestAndApproveTier2(ctx);

    const params = { inbox_item_id: inboxId, type: "note", title: "Anchor chain note" };
    const [a, b] = await Promise.all([refile(ctx, params), refile(ctx, params)]);
    const outcomes = [a, b];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    const losers = outcomes.filter((r) => !r.ok);
    expect(losers).toHaveLength(1);
    expect(expectErr(losers[0]!).code).toBe("BAD_INPUT");

    const [row] = await testSql`
      select status, filed_table from inbox_items where id = ${inboxId}::uuid`;
    expect(row!.status).toBe("filed");
    expect(row!.filed_table).toBe("pages");
    expect(await testSql`select id from pages where derived_from = ${inboxId}`).toHaveLength(1);
  });
});
