// W2-3: minime_refile files a pending inbox capture into a typed row, reusing the watcher's
// fileRow/claim machinery. Anti-laundering cross-check: refiling requires an active tier-2
// unlock (a pending capture's text is tier-2-gated exactly like the review-queue read path,
// DECISIONS.md 2026-08-08). Beyond that entry gate, the capture's own stored classifier evidence
// sets a floor every destination is checked against: a note tier override can only raise — never
// lower — the tier that evidence implies, and type=task/decision are rejected outright rather
// than silently filed at their permanent tier-1 default, since neither has a tier-2 pathway.

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { withActorDbSession } from "../src/db/repo";
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
      select entry_md, mood, derived_from, tier, source, created_by
      from journal_entries where id = ${data.filed_id}::uuid`;
    expect(journalRow!.entry_md).toBe(text);
    expect(journalRow!.mood).toBe(4);
    expect(journalRow!.derived_from).toBe(inboxId);
    expect(journalRow!.tier).toBe(2);
    // I5 provenance: attributed to the real MCP caller (ctx.actor), not fileRow's
    // "agent:classifier" default — a refile-filed row must not be mis-stamped as automatic.
    expect(journalRow!.created_by).toBe(ctx.actor);

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
      select path, tier, body_md, created_by from pages where id = ${data.filed_id}::uuid`;
    expect(page!.tier).toBe(2);
    // I5 provenance: the real MCP caller, not "agent:classifier".
    expect(page!.created_by).toBe(ctx.actor);
    const projected = await readFile(join(config.dataDir, "brain", String(page!.path)), "utf8");
    expect(projected).toBe(page!.body_md);
    expect(projected).toContain("ZQX-REFILE-NOTE");
  });

  test("refiles a pending capture as an interaction: person resolved, review item resolved, event logged", async () => {
    const text = "unclear: ZQX-REFILE-INTERACTION fictional chat about the winch bearing";
    const inboxId = await pendingUnfiled("zqx-refile-interaction.md", text);
    const [reviewBefore] = await testSql`
      select id from review_queue
      where kind = 'inbox_unfiled' and payload ->> 'inbox_item_id' = ${inboxId} and status = 'open'`;
    expect(reviewBefore).toBeTruthy();

    const ctx = sessionToolCtx("agent:refile-interaction");
    await requestAndApproveTier2(ctx);
    const result = await refile(ctx, {
      inbox_item_id: inboxId,
      type: "interaction",
      person_name: "Priya Kestrel",
      kind: "call",
    });
    const data = expectOk(result);
    expect(data.filed_table).toBe("interactions");
    expect(data.resolved_review_items).toContain(reviewBefore!.id);

    const [row] = await testSql`
      select summary, kind, tier, derived_from, person_id, org_id, created_by
      from interactions where id = ${data.filed_id}::uuid`;
    expect(row!.summary).toBe(text);
    expect(row!.kind).toBe("call");
    expect(row!.tier).toBe(2);
    expect(row!.derived_from).toBe(inboxId);
    expect(row!.org_id).toBeNull();
    expect(row!.person_id).toBeTruthy();
    // I5 provenance: the real MCP caller, not "agent:classifier".
    expect(row!.created_by).toBe(ctx.actor);

    // "Priya Kestrel" carries no org cue, so fileRow's person/org heuristic must resolve it to a
    // real person row, not a phantom org (the phantom-org bug the heuristic exists to avoid).
    const [person] = await testSql`
      select canonical_name, created_by from people where id = ${row!.person_id}`;
    expect(person!.canonical_name).toBe("Priya Kestrel");
    // The newly-minted person is also attributed to the real caller (fileRow threads `actor`
    // into ensurePerson, not just the interaction row itself).
    expect(person!.created_by).toBe(ctx.actor);

    const [inboxRow] = await testSql`
      select status, filed_table, filed_id from inbox_items where id = ${inboxId}::uuid`;
    expect(inboxRow).toEqual({
      status: "filed",
      filed_table: "interactions",
      filed_id: data.filed_id,
    });

    const [reviewAfter] = await testSql`
      select status from review_queue where id = ${reviewBefore!.id}::uuid`;
    expect(reviewAfter!.status).toBe("resolved");

    const [event] = await testSql`
      select payload from events
      where verb = 'inbox:refiled' and entity_id = ${inboxId}::uuid`;
    expect(event!.payload).toEqual({
      type: "interaction",
      filed_table: "interactions",
      filed_id: data.filed_id,
    });
  });

  test("refiles a pending capture as a decision: fields set correctly, review item resolved, event logged with the decision_note remap", async () => {
    const text = "unclear: ZQX-REFILE-DECISION fictional debate about the spare bilge pump";
    const inboxId = await pendingUnfiled("zqx-refile-decision.md", text);
    const [reviewBefore] = await testSql`
      select id from review_queue
      where kind = 'inbox_unfiled' and payload ->> 'inbox_item_id' = ${inboxId} and status = 'open'`;
    expect(reviewBefore).toBeTruthy();

    const ctx = sessionToolCtx("agent:refile-decision");
    await requestAndApproveTier2(ctx);
    const result = await refile(ctx, {
      inbox_item_id: inboxId,
      type: "decision",
      question: "Replace the spare bilge pump now or at next haul-out?",
      choice: "Replace now",
    });
    const data = expectOk(result);
    expect(data.filed_table).toBe("decisions");
    expect(data.resolved_review_items).toContain(reviewBefore!.id);

    const [row] = await testSql`
      select question, choice, reasoning, tier, derived_from, created_by
      from decisions where id = ${data.filed_id}::uuid`;
    expect(row!.question).toBe("Replace the spare bilge pump now or at next haul-out?");
    expect(row!.choice).toBe("Replace now");
    expect(row!.reasoning).toBe(text);
    expect(row!.tier).toBe(1); // decisions have no owner-facing tier-2 pathway through this tool
    expect(row!.derived_from).toBe(inboxId);
    // I5 provenance: the real MCP caller, not "agent:classifier".
    expect(row!.created_by).toBe(ctx.actor);

    const [inboxRow] = await testSql`
      select status, filed_table, filed_id from inbox_items where id = ${inboxId}::uuid`;
    expect(inboxRow).toEqual({
      status: "filed",
      filed_table: "decisions",
      filed_id: data.filed_id,
    });

    const [reviewAfter] = await testSql`
      select status from review_queue where id = ${reviewBefore!.id}::uuid`;
    expect(reviewAfter!.status).toBe("resolved");

    // CLASSIFICATION_TYPE remaps the owner-facing "decision" to fileRow's internal
    // "decision_note" — the audit payload records that internal type verbatim, not "decision".
    const [event] = await testSql`
      select payload from events
      where verb = 'inbox:refiled' and entity_id = ${inboxId}::uuid`;
    expect(event!.payload).toEqual({
      type: "decision_note",
      filed_table: "decisions",
      filed_id: data.filed_id,
    });
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

  test("type=task is rejected (not silently filed at tier 1) when the capture's stored evidence says journal/interaction", async () => {
    const inboxId = await pendingUnfiled(
      "zqx-refile-task-floor.md",
      "unclear: ZQX-REFILE-TASKFLOOR fictional reflection about the storm watch",
    );
    // Same synthetic evidence as the note-floor test above: the automatic pass guessed
    // "journal" at too-low confidence to auto-file, so this capture is tier-2-grade even though
    // nothing has filed it yet. tasks.tier has no tier-2 pathway through this tool, so the only
    // safe outcome is a rejection, not a downgrade.
    await testSql`
      update inbox_items
      set classifier_output = ${testSql.json({
        type: "journal",
        confidence: 0.5,
        fields: { mood: null },
        reason: "synthetic test evidence",
      })}
      where id = ${inboxId}::uuid`;

    const ctx = sessionToolCtx("agent:refile-task-floor");
    await requestAndApproveTier2(ctx);
    const error = expectErr(
      await refile(ctx, { inbox_item_id: inboxId, type: "task", title: "Storm watch task" }),
    );
    expect(error.code).toBe("BAD_INPUT");
    expect(error.message).toContain("tier-2-grade");

    // Nothing was filed at any tier — the whole point of the floor is that an actor who never
    // unlocked tier 2 must never be able to read this capture's text via a laundered tier-1 row.
    expect(await testSql`select id from tasks where derived_from = ${inboxId}`).toHaveLength(0);
    const [inboxRow] = await testSql`
      select status, classifier_output from inbox_items where id = ${inboxId}::uuid`;
    expect(inboxRow!.status).toBe("pending");
    expect((inboxRow!.classifier_output as any).type).toBe("journal"); // unchanged by the attempt
  });

  test("type=decision is rejected (not silently filed at tier 1) when the capture's stored evidence says journal/interaction", async () => {
    const inboxId = await pendingUnfiled(
      "zqx-refile-decision-floor.md",
      "unclear: ZQX-REFILE-DECISIONFLOOR fictional reflection about spare hydrophone nodes",
    );
    await testSql`
      update inbox_items
      set classifier_output = ${testSql.json({
        type: "interaction",
        confidence: 0.4,
        fields: {},
        reason: "synthetic test evidence",
      })}
      where id = ${inboxId}::uuid`;

    const ctx = sessionToolCtx("agent:refile-decision-floor");
    await requestAndApproveTier2(ctx);
    const error = expectErr(
      await refile(ctx, {
        inbox_item_id: inboxId,
        type: "decision",
        question: "Use the spare hydrophone nodes?",
      }),
    );
    expect(error.code).toBe("BAD_INPUT");
    expect(error.message).toContain("tier-2-grade");

    expect(await testSql`select id from decisions where derived_from = ${inboxId}`).toHaveLength(0);
    const [inboxRow] = await testSql`select status from inbox_items where id = ${inboxId}::uuid`;
    expect(inboxRow!.status).toBe("pending");
  });

  test("a note tier override is floored by the capture's own agent-session hint marker, with no stored classifier evidence at all", async () => {
    const text =
      "unclear: ZQX-REFILE-HINTFLOOR fictional agent session outcome\n" +
      "<!-- hint: agent work session -->\nverbatim fictional session prose about the storm watch";
    const inboxId = await pendingUnfiled("zqx-refile-hintfloor.md", text);
    // Unlike the stored-evidence floor tests above, this capture was never classified at all —
    // classifier_output is NULL, so evidenceFloor(null) is the ordinary tier-1 default. The floor
    // must still land at 2 because noteHintTier(text) reads the capture's OWN archived bytes for
    // the literal agent-session marker, independent of any stored classifier guess. Direct-SQL
    // test scaffolding (test/helpers.ts convention), not an application write path.
    await testSql`update inbox_items set classifier_output = null where id = ${inboxId}::uuid`;

    const ctx = sessionToolCtx("agent:refile-hintfloor");
    await requestAndApproveTier2(ctx);
    const data = expectOk(
      await refile(ctx, {
        inbox_item_id: inboxId,
        type: "note",
        title: "Storm watch hint-floor note",
        tier: 1, // requested below the floor
      }),
    );
    const [page] = await testSql`select tier from pages where id = ${data.filed_id}::uuid`;
    expect(page!.tier).toBe(2); // floored by the text's own hint marker, not stored evidence
  });

  test("type=task is rejected from the capture's own agent-session hint marker alone, with no stored classifier evidence", async () => {
    const text =
      "unclear: ZQX-REFILE-HINTTASKFLOOR fictional agent session outcome\n" +
      "<!-- hint: agent work session -->\nverbatim fictional session prose about the storm watch";
    const inboxId = await pendingUnfiled("zqx-refile-hinttaskfloor.md", text);
    await testSql`update inbox_items set classifier_output = null where id = ${inboxId}::uuid`;

    const ctx = sessionToolCtx("agent:refile-hinttaskfloor");
    await requestAndApproveTier2(ctx);
    const error = expectErr(
      await refile(ctx, { inbox_item_id: inboxId, type: "task", title: "Hint-floor task" }),
    );
    expect(error.code).toBe("BAD_INPUT");
    expect(error.message).toContain("tier-2-grade");

    // Same anti-laundering outcome as the stored-evidence case: nothing filed at any tier, and
    // the reject path fired purely from the text's own hint marker (classifier_output stayed
    // NULL throughout — there was never any stored evidence to fall back on).
    expect(await testSql`select id from tasks where derived_from = ${inboxId}`).toHaveLength(0);
    const [inboxRow] = await testSql`
      select status, classifier_output from inbox_items where id = ${inboxId}::uuid`;
    expect(inboxRow!.status).toBe("pending");
    expect(inboxRow!.classifier_output).toBeNull();
  });

  test("type=journal still succeeds when the capture's stored evidence is tier-2, since journal always files at tier 2 anyway", async () => {
    const inboxId = await pendingUnfiled(
      "zqx-refile-journal-floor.md",
      "unclear: ZQX-REFILE-JOURNALFLOOR fictional reflection about the storm watch",
    );
    await testSql`
      update inbox_items
      set classifier_output = ${testSql.json({
        type: "journal",
        confidence: 0.5,
        fields: { mood: null },
        reason: "synthetic test evidence",
      })}
      where id = ${inboxId}::uuid`;

    const ctx = sessionToolCtx("agent:refile-journal-floor");
    await requestAndApproveTier2(ctx);
    const data = expectOk(await refile(ctx, { inbox_item_id: inboxId, type: "journal" }));
    const [row] = await testSql`
      select tier from journal_entries where id = ${data.filed_id}::uuid`;
    expect(row!.tier).toBe(2);
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
      select due, body, tier, derived_from, created_by from tasks where id = ${data.filed_id}::uuid`;
    expect(task!.due).toBeNull();
    expect(String(task!.body)).toContain("date guardrail");
    expect(String(task!.body)).toContain("2020-01-01");
    expect(task!.tier).toBe(1);
    expect(task!.derived_from).toBe(inboxId);
    // I5 provenance: the real MCP caller, not "agent:classifier".
    expect(task!.created_by).toBe(ctx.actor);
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

    // The whole attempt is one transaction (refile.ts runs the claim/fileRow/duplicate-throw
    // sequence inside its own independent transaction, so a throw here rolls back everything
    // fileRow did too, including its own duplicate review item/event) — the item is left exactly
    // as it was: still pending, its original classification untouched, no new task, and the
    // pre-existing inbox_unfiled item still open and unresolved.
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

  test("a filed note and its markdown projection survive the ambient actor transaction failing to commit afterward", async () => {
    const text = "unclear: ZQX-REFILE-DURABLE fictional log about the spare bilge pump";
    const inboxId = await pendingUnfiled("zqx-refile-durable.md", text);
    const ctx = sessionToolCtx("agent:refile-durable");
    await requestAndApproveTier2(ctx);

    // withActorDbSession is exactly what executeTool wraps every tool.handler call in — calling
    // the handler directly (bypassing invokeTool/executeTool) lets this test hold that same
    // wrapper open and force it to fail to commit AFTER the handler has already returned, the
    // exact crash window DECISIONS.md 2026-08-06 (fenced finalization) requires refile.ts's own
    // filing transaction to be independent of (test/capture-durability.test.ts proves the same
    // guarantee for minime_capture's identity commit using the analogous technique).
    let filedId = "";
    await expect(
      withActorDbSession(
        ctx.actor,
        async () => {
          const result = await toolByName("minime_refile").handler(
            { inbox_item_id: inboxId, type: "note", title: "Bilge pump durability note" },
            ctx,
          );
          filedId = (result.data as { filed_id: string }).filed_id;
          throw new Error("forced_outer_refile_rollback");
        },
        ctx.sessionId,
      ),
    ).rejects.toThrow("forced_outer_refile_rollback");

    // The filing transaction is independent of the ambient session (see refile.ts) — it must
    // already have committed for real, surviving the forced rollback above intact.
    const [page] = await testSql`
      select tier, body_md, path from pages where id = ${filedId}::uuid`;
    expect(page).toBeTruthy();
    const [inboxRow] = await testSql`
      select status, filed_table, filed_id from inbox_items where id = ${inboxId}::uuid`;
    expect(inboxRow).toEqual({ status: "filed", filed_table: "pages", filed_id: filedId });

    // The markdown mirror publishes only after that independent commit, so it is on disk too —
    // proof it was never written from inside a transaction the rollback above could have undone.
    const projected = await readFile(join(config.dataDir, "brain", String(page!.path)), "utf8");
    expect(projected).toBe(page!.body_md);
    expect(projected).toContain("ZQX-REFILE-DURABLE");
  });

  test("refile of a mixed dump files only the owner-chosen type", async () => {
    const text = `unclear: ZQX-REFILE-MIXED leftover dump
todo: send the SILDRE contract
met Nadia Rossi about pricing
note: they want the Q3 quote`;
    const inboxId = await pendingUnfiled("zqx-refile-mixed.md", text);
    const ctx = sessionToolCtx("agent:refile-mixed");
    await requestAndApproveTier2(ctx);
    const data = expectOk(
      await refile(ctx, {
        inbox_item_id: inboxId,
        type: "task",
        title: "ZQX-REFILE-MIXED send the SILDRE contract",
      }),
    );
    expect(data.filed_table).toBe("tasks");
    const tasks = await testSql`select id from tasks where derived_from = ${inboxId}::uuid`;
    expect(tasks).toHaveLength(1);
    const interactions = await testSql`
      select id from interactions where derived_from = ${inboxId}::uuid`;
    expect(interactions).toHaveLength(0);
    const [split] = await testSql`
      select id from events
      where verb = 'inbox:split-intents' and entity_id = ${inboxId}::uuid`;
    expect(split).toBeUndefined();
  });
});
