// W2-4: minime_correct amend/retract/retier for typed rows — "that's wrong, fix it" through one
// audited MCP call. amend inserts a successor + stamps the original superseded_by/superseded_at
// (migration 028); retract stamps superseded_at only and drops the row from search; retier
// promotes a note (page) from tier 1 to tier 2, up-only. The tier rule under test throughout:
// this tool can only correct what the calling session can currently read — getRow's own tier
// predicate 404s a locked session before any write, and supersedeRow/retractRow (repo.ts)
// independently re-check the same bound at the SQL layer (028's tier_update RLS policy), so a
// locked session gets the identical NOT_FOUND either way. Two halves of that rule are covered
// below: a locked (tier-1) session hitting a tier-2 row, and — independently — no session at all,
// including one with a genuine active tier-2 unlock, ever reaching a tier-0 row, since getRow's
// predicate carries an unconditional `tier >= 1` floor with no exception.

import { beforeAll, describe, expect, test } from "bun:test";
import {
  ensurePerson,
  ftsCandidates,
  insertDecision,
  insertInteraction,
  insertJournal,
  upsertPage,
  withActorDbSession,
} from "../src/db/repo";
import { toolByName } from "../src/mcp/tools";
import { queryMetric } from "../src/mcp/tools/metric";
import { type ToolResult, invokeTool } from "../src/mcp/tools/registry";
import { resetDb, testSql } from "./helpers";
import { requestAndApproveTier2, sessionToolCtx } from "./support/unlock";

beforeAll(async () => {
  await resetDb();
});

function correct(
  ctx: ReturnType<typeof sessionToolCtx>,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  return invokeTool(toolByName("minime_correct"), params, ctx);
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

async function eventPayload(verb: string, marker: number): Promise<any> {
  const [row] = await testSql`
    select payload, entity_type, entity_id from events
    where verb = ${verb} and id > ${marker}::bigint order by id limit 1`;
  return row;
}

// ftsCandidates applies RLS through app_allowed_tier(), which reads the `minime.actor` GUC —
// calling it bare (no ambient transaction) would set that GUC in allowedTier()'s own throwaway
// transaction and then lose it before the chunks query itself runs on a fresh connection. Every
// real caller goes through withActorDbSession (executeTool's wrapper); mirror that here so the
// search-visibility assertions reflect the actor's real unlocked/locked state.
function searchFts(
  ctx: ReturnType<typeof sessionToolCtx>,
  query: string,
): Promise<Awaited<ReturnType<typeof ftsCandidates>>> {
  return withActorDbSession(
    ctx.actor,
    () => ftsCandidates(query, null, null, ctx.actor),
    ctx.sessionId,
  );
}

describe("minime_correct", () => {
  test("amend journal: successor carries patched fields + supersedes_id, old row stamped, both events audited, get_context on old id still works", async () => {
    const ctx = sessionToolCtx("agent:correct-amend-journal");
    await requestAndApproveTier2(ctx);
    const { id: oldId } = await insertJournal({
      entryMd: "Fictional original entry about the sourdough starter timing.",
      mood: 2,
      energy: 2,
      at: new Date("2026-05-01T09:00:00Z"),
      createdBy: "human",
      source: "test:correct",
    });
    const [marker] = await testSql`select coalesce(max(id), 0)::bigint as id from events`;

    const data = expectOk(
      await correct(ctx, {
        type: "journal",
        action: "amend",
        id: oldId,
        entry_md: "Fictional corrected entry about the sourdough starter timing.",
        mood: 4,
        reason: "misremembered how the day actually went",
      }),
    );
    expect(data).toEqual({ action: "amend", new_id: data.new_id, superseded_id: oldId });
    const newId = data.new_id as string;

    const [newRow] = await testSql`
      select entry_md, mood, energy, at, tier, source, created_by, derived_from, supersedes_id,
             superseded_by, superseded_at
      from journal_entries where id = ${newId}::uuid`;
    expect(newRow!.entry_md).toBe("Fictional corrected entry about the sourdough starter timing.");
    expect(newRow!.mood).toBe(4);
    expect(newRow!.energy).toBe(2); // unpatched field carries over from the original
    expect(newRow!.at.toISOString()).toBe("2026-05-01T09:00:00.000Z"); // unpatched, preserved
    expect(newRow!.tier).toBe(2);
    expect(newRow!.source).toBe("correction");
    expect(newRow!.created_by).toBe(ctx.actor);
    expect(newRow!.derived_from).toBe(oldId);
    expect(newRow!.supersedes_id).toBe(oldId);
    expect(newRow!.superseded_by).toBeNull();
    expect(newRow!.superseded_at).toBeNull();

    const [oldRow] = await testSql`
      select superseded_by, superseded_at from journal_entries where id = ${oldId}::uuid`;
    expect(oldRow!.superseded_by).toBe(newId);
    expect(oldRow!.superseded_at).not.toBeNull();

    // Both events audited: the standard tool:minime_correct result AND the explicit correct:amend.
    const attempt = await eventPayload("tool:minime_correct:attempt", marker!.id);
    expect(attempt).toBeTruthy();
    const toolResult = await eventPayload("tool:minime_correct", marker!.id);
    expect(toolResult).toBeTruthy();
    const amendEvent = await eventPayload("correct:amend", marker!.id);
    expect(amendEvent!.entity_type).toBeNull();
    expect(amendEvent!.entity_id).toBeNull();
    expect(amendEvent!.payload).toEqual({
      type: "journal",
      old_id: oldId,
      new_id: newId,
      tier: 2,
      reason: "misremembered how the day actually went",
    });

    // get_context on the OLD id still works — the original is never edited or deleted (I5).
    const contextData = expectOk(
      await invokeTool(toolByName("minime_get_context"), { type: "journal", id: oldId }, ctx),
    );
    expect(contextData.row.id).toBe(oldId);
    expect(contextData.row.entry_md).toBe(
      "Fictional original entry about the sourdough starter timing.",
    );
  });

  test("amend interaction: preserves occurred_at and tier when only summary is patched", async () => {
    const ctx = sessionToolCtx("agent:correct-amend-interaction");
    await requestAndApproveTier2(ctx);
    const person = await ensurePerson("Fictional Correct Person", ctx.actor, "test:correct", {
      tier: 2,
    });
    const occurredAt = new Date("2026-05-02T14:00:00Z");
    const { id: oldId } = await insertInteraction({
      personId: person.id,
      kind: "call",
      summary: "Fictional original summary about the delivery window.",
      occurredAt,
      createdBy: "human",
      source: "test:correct",
    });

    const data = expectOk(
      await correct(ctx, {
        type: "interaction",
        action: "amend",
        id: oldId,
        summary: "Fictional corrected summary about the delivery window.",
      }),
    );
    const newId = data.new_id as string;
    const [newRow] = await testSql`
      select summary, kind, occurred_at, tier, person_id, org_id from interactions
      where id = ${newId}::uuid`;
    expect(newRow!.summary).toBe("Fictional corrected summary about the delivery window.");
    expect(newRow!.kind).toBe("call"); // unpatched, preserved
    expect(newRow!.occurred_at.toISOString()).toBe(occurredAt.toISOString()); // unpatched, preserved
    expect(newRow!.tier).toBe(2); // preserved from the original, never lowered
    expect(newRow!.person_id).toBe(person.id);
    expect(newRow!.org_id).toBeNull();
  });

  test("amend decision: preserves options/falsifier/stakes when only choice is patched", async () => {
    const ctx = sessionToolCtx("agent:correct-amend-decision");
    const { id: oldId } = await insertDecision({
      question: "Replace the fictional spare bilge pump now or later?",
      options: ["now", "later"],
      choice: "later",
      falsifier: "Fictional falsifier text.",
      stakes: "medium",
      reversibility: "reversible",
      confidence: 60,
      createdBy: "human",
      source: "test:correct",
    });

    const data = expectOk(
      await correct(ctx, {
        type: "decision",
        action: "amend",
        id: oldId,
        choice: "now",
        reasoning: "Fictional corrected reasoning: it can't wait.",
      }),
    );
    const newId = data.new_id as string;
    const [newRow] = await testSql`
      select question, options, choice, reasoning, falsifier, stakes, reversibility, confidence,
             tier, source
      from decisions where id = ${newId}::uuid`;
    expect(newRow!.choice).toBe("now");
    expect(newRow!.reasoning).toBe("Fictional corrected reasoning: it can't wait.");
    expect(newRow!.question).toBe("Replace the fictional spare bilge pump now or later?");
    expect(newRow!.options).toEqual(["now", "later"]);
    expect(newRow!.falsifier).toBe("Fictional falsifier text.");
    expect(newRow!.stakes).toBe("medium");
    expect(newRow!.tier).toBe(1);
    expect(newRow!.source).toBe("correction");
  });

  test("amend note: successor page carries patched title/body_md at a fresh path; original page untouched", async () => {
    const ctx = sessionToolCtx("agent:correct-amend-note");
    const original = await upsertPage({
      path: "test/zqx-correct-note.md",
      title: "Fictional original title",
      bodyMd: "Fictional original body about the mooring hardware.",
      contentHash: "zqx-correct-note-original",
      tier: 1,
      createdBy: "human",
      source: "manual",
    });
    await testSql`
      insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('page', ${original.id}, 0, 'Fictional original body about the mooring hardware.', 1)`;

    const data = expectOk(
      await correct(ctx, {
        type: "note",
        action: "amend",
        id: original.id,
        body_md: "Fictional corrected body about the mooring hardware.",
      }),
    );
    const newId = data.new_id as string;
    const [newRow] = await testSql`
      select path, title, body_md, tier, source, supersedes_id, derived_from
      from pages where id = ${newId}::uuid`;
    expect(newRow!.title).toBe("Fictional original title"); // unpatched, preserved
    expect(newRow!.body_md).toBe("Fictional corrected body about the mooring hardware.");
    expect(newRow!.path).not.toBe("test/zqx-correct-note.md"); // pages.path is unique
    expect(newRow!.tier).toBe(1);
    expect(newRow!.source).toBe("correction");
    expect(newRow!.supersedes_id).toBe(original.id);
    expect(newRow!.derived_from).toBe(original.id);

    // The original row's own content and chunks are untouched by amend (only retract clears
    // chunks) — only superseded_by/superseded_at change.
    const [oldRow] = await testSql`
      select body_md, superseded_by, superseded_at from pages where id = ${original.id}::uuid`;
    expect(oldRow!.body_md).toBe("Fictional original body about the mooring hardware.");
    expect(oldRow!.superseded_by).toBe(newId);
    const oldChunks = await testSql`
      select id from chunks where parent_type = 'page' and parent_id = ${original.id}::uuid`;
    expect(oldChunks).toHaveLength(1);
  });

  test("retract removes chunks (ftsCandidates no longer returns it) but the row remains readable by id", async () => {
    const ctx = sessionToolCtx("agent:correct-retract");
    await requestAndApproveTier2(ctx);
    const { id } = await insertJournal({
      entryMd: "Fictional retract-target entry about ZQXRETRACTSENTINEL kayak trim.",
      mood: 3,
      createdBy: "human",
      source: "test:correct",
    });
    await testSql`
      insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('journal', ${id}, 0,
              'Fictional retract-target entry about ZQXRETRACTSENTINEL kayak trim.', 2)`;

    const before = await searchFts(ctx, "ZQXRETRACTSENTINEL");
    expect(before.some((c) => c.parent_id === id)).toBe(true);

    const [marker] = await testSql`select coalesce(max(id), 0)::bigint as id from events`;
    const data = expectOk(
      await correct(ctx, {
        type: "journal",
        action: "retract",
        id,
        reason: "duplicate of another entry",
      }),
    );
    expect(data).toEqual({ action: "retract", superseded_id: id });

    const after = await searchFts(ctx, "ZQXRETRACTSENTINEL");
    expect(after.some((c) => c.parent_id === id)).toBe(false);
    expect(await testSql`select id from chunks where parent_id = ${id}::uuid`).toHaveLength(0);

    const [row] = await testSql`
      select entry_md, superseded_by, superseded_at from journal_entries where id = ${id}::uuid`;
    expect(row!.entry_md).toContain("ZQXRETRACTSENTINEL"); // row itself is never edited/deleted
    expect(row!.superseded_by).toBeNull(); // retracted, not amended — no successor
    expect(row!.superseded_at).not.toBeNull();

    const retractEvent = await eventPayload("correct:retract", marker!.id);
    expect(retractEvent!.payload).toEqual({
      type: "journal",
      id,
      tier: 2,
      reason: "duplicate of another entry",
    });

    // get_context still resolves it by id.
    const contextData = expectOk(
      await invokeTool(toolByName("minime_get_context"), { type: "journal", id }, ctx),
    );
    expect(contextData.row.id).toBe(id);
  });

  test("retier promotes a note's page+chunks+edges from tier 1 to tier 2 together, and is refused for 2->1", async () => {
    const ctx = sessionToolCtx("agent:correct-retier");
    await requestAndApproveTier2(ctx);
    const page = await upsertPage({
      path: "test/zqx-correct-retier.md",
      title: "Fictional retier target",
      bodyMd: "Fictional body for the retier test.",
      contentHash: "zqx-correct-retier",
      tier: 1,
      createdBy: "human",
      source: "manual",
    });
    await testSql`
      insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('page', ${page.id}, 0, 'Fictional body for the retier test.', 1)`;
    const dstId = crypto.randomUUID();
    await testSql`
      insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier)
      values ('page', ${page.id}, 'mentions', 'person', ${dstId}::uuid, 'pages', ${page.id}, 1)`;

    const [marker] = await testSql`select coalesce(max(id), 0)::bigint as id from events`;
    const data = expectOk(
      await correct(ctx, {
        type: "note",
        action: "retier",
        id: page.id,
        to_tier: 2,
        reason: "misclassified as tier 1 originally",
      }),
    );
    expect(data).toEqual({ action: "retier", superseded_id: page.id });

    const [pageRow] = await testSql`select tier from pages where id = ${page.id}::uuid`;
    expect(pageRow!.tier).toBe(2);
    const [chunkRow] = await testSql`
      select tier from chunks where parent_type = 'page' and parent_id = ${page.id}::uuid`;
    expect(chunkRow!.tier).toBe(2);
    const [edgeRow] = await testSql`
      select tier from edges where src_type = 'page' and src_id = ${page.id}::uuid`;
    expect(edgeRow!.tier).toBe(2);

    // reason is audited on retier too — the tool's schema/docstring accept it for every action,
    // not just amend/retract (W2-4 review finding).
    const retierEvent = await eventPayload("correct:retier", marker!.id);
    expect(retierEvent!.payload).toEqual({
      type: "note",
      id: page.id,
      from_tier: 1,
      to_tier: 2,
      reason: "misclassified as tier 1 originally",
    });

    // up-only: an explicit request to move to tier 1 is refused, not silently ignored.
    const error = expectErr(
      await correct(ctx, { type: "note", action: "retier", id: page.id, to_tier: 1 }),
    );
    expect(error.code).toBe("BAD_INPUT");
    expect(error.message).toContain("up-only");
    const [unchanged] = await testSql`select tier from pages where id = ${page.id}::uuid`;
    expect(unchanged!.tier).toBe(2); // refusal did not touch the row
  });

  test("retier without an active tier-2 unlock is refused (retier always produces tier-2 content)", async () => {
    const page = await upsertPage({
      path: "test/zqx-correct-retier-locked.md",
      title: "Fictional locked retier target",
      bodyMd: "Fictional body.",
      contentHash: "zqx-correct-retier-locked",
      tier: 1,
      createdBy: "human",
      source: "manual",
    });
    const error = expectErr(
      await correct(sessionToolCtx("agent:correct-retier-locked"), {
        type: "note",
        action: "retier",
        id: page.id,
        to_tier: 2,
      }),
    );
    expect(error.code).toBe("BAD_INPUT");
    expect(error.message).toContain("tier-2 unlock");
    const [row] = await testSql`select tier from pages where id = ${page.id}::uuid`;
    expect(row!.tier).toBe(1); // refusal did not touch the row
  });

  test("a tier-1 (locked) session amending or retracting a tier-2 journal row gets NOT_FOUND", async () => {
    const { id } = await insertJournal({
      entryMd: "Fictional locked-session target entry.",
      mood: 3,
      createdBy: "human",
      source: "test:correct",
    });
    const lockedCtx = sessionToolCtx("agent:correct-locked"); // no requestAndApproveTier2

    const amendError = expectErr(
      await correct(lockedCtx, {
        type: "journal",
        action: "amend",
        id,
        entry_md: "Should not land.",
      }),
    );
    expect(amendError.code).toBe("NOT_FOUND");

    const retractError = expectErr(
      await correct(lockedCtx, { type: "journal", action: "retract", id }),
    );
    expect(retractError.code).toBe("NOT_FOUND");

    // Neither attempt touched the row: still live, no successor, chunks (if any) untouched.
    const [row] = await testSql`
      select superseded_by, superseded_at from journal_entries where id = ${id}::uuid`;
    expect(row!.superseded_by).toBeNull();
    expect(row!.superseded_at).toBeNull();
  });

  test("a session with an active tier-2 unlock still cannot amend, retract, or retier a tier-0 row (absorbing quarantine has no bypass)", async () => {
    const ctx = sessionToolCtx("agent:correct-tier0-unlocked");
    await requestAndApproveTier2(ctx); // genuine, approved tier-2 unlock for THIS session

    // journal_entries.tier carries no CHECK constraint (unlike decisions, which the DB itself
    // refuses at tier 0 -- 014_decision_interview.sql's `decisions_tier_check`) and insertJournal
    // passes `tier` straight through with no JS-side gate, so this is a legitimate tier-0
    // fixture: the same technique test/h1-brain-sync.test.ts and test/h1-note-recovery.test.ts
    // already use to construct tier-0 pages ("Private zero" / `tier: 0` frontmatter).
    const { id: journalId } = await insertJournal({
      entryMd: "Fictional absorbing-quarantine entry that must never be correctable.",
      mood: 3,
      tier: 0,
      createdBy: "human",
      source: "test:correct",
    });

    const amendError = expectErr(
      await correct(ctx, {
        type: "journal",
        action: "amend",
        id: journalId,
        entry_md: "Should not land.",
      }),
    );
    expect(amendError.code).toBe("NOT_FOUND");

    const retractError = expectErr(
      await correct(ctx, { type: "journal", action: "retract", id: journalId }),
    );
    expect(retractError.code).toBe("NOT_FOUND");

    const [journalRow] = await testSql`
      select tier, superseded_by, superseded_at from journal_entries where id = ${journalId}::uuid`;
    expect(journalRow!.tier).toBe(0); // refusal did not touch the row
    expect(journalRow!.superseded_by).toBeNull();
    expect(journalRow!.superseded_at).toBeNull();

    // pages.tier is equally unconstrained at the DB layer, but upsertPage's own assertProseTier
    // JS gate refuses tier 0 outright (TIER0_PROSE_BLOCKED) -- bypass it with a raw insert, same
    // technique as above, to reach handleRetier's independent getRow("page", ...) call with a
    // tier-0 target. retier has its own explicit "requires an approved tier-2 unlock" check, but
    // getRow runs first (correct.ts), so a real unlock here proves the tier-0 floor specifically,
    // not just the separate no-unlock refusal already covered above.
    const [zeroPage] = await testSql`
      insert into pages (path, title, body_md, content_hash, tier, created_by, source)
      values ('test/zqx-correct-tier0-note.md', 'Fictional tier-0 note',
              'Fictional tier-0 body that must never be retiered.', 'zqx-correct-tier0-note', 0,
              'human', 'manual')
      returning id`;

    const retierError = expectErr(
      await correct(ctx, { type: "note", action: "retier", id: zeroPage!.id, to_tier: 2 }),
    );
    expect(retierError.code).toBe("NOT_FOUND");

    const [pageRow] = await testSql`select tier from pages where id = ${zeroPage!.id}::uuid`;
    expect(pageRow!.tier).toBe(0); // refusal did not touch the row
  });

  test("type=task is rejected by the schema (not a supported correction type)", async () => {
    const error = expectErr(
      await correct(sessionToolCtx("agent:correct-task-rejected"), {
        type: "task",
        action: "amend",
        id: crypto.randomUUID(),
        entry_md: "irrelevant",
      }),
    );
    expect(error.code).toBe("BAD_INPUT");
  });

  test("amend requires at least one patch field for the given type", async () => {
    const ctx = sessionToolCtx("agent:correct-noop-guard");
    await requestAndApproveTier2(ctx);
    const { id } = await insertJournal({
      entryMd: "Fictional entry with nothing to patch.",
      createdBy: "human",
      source: "test:correct",
    });
    const error = expectErr(await correct(ctx, { type: "journal", action: "amend", id }));
    expect(error.code).toBe("BAD_INPUT");
    expect(error.message).toContain("at least one field");
  });

  test("a row already superseded cannot be amended or retracted again", async () => {
    const ctx = sessionToolCtx("agent:correct-already-superseded");
    await requestAndApproveTier2(ctx);
    const { id } = await insertJournal({
      entryMd: "Fictional entry that will be amended once.",
      mood: 2,
      createdBy: "human",
      source: "test:correct",
    });
    expectOk(
      await correct(ctx, { type: "journal", action: "amend", id, entry_md: "Amended once." }),
    );

    const secondAmend = expectErr(
      await correct(ctx, { type: "journal", action: "amend", id, entry_md: "Amended twice?" }),
    );
    expect(secondAmend.code).toBe("BAD_INPUT");
    expect(secondAmend.message).toContain("already superseded");

    const retractAttempt = expectErr(
      await correct(ctx, { type: "journal", action: "retract", id }),
    );
    expect(retractAttempt.code).toBe("BAD_INPUT");
    expect(retractAttempt.message).toContain("already superseded");
  });

  test("amending a journal row with mood shows a single count in the mood metric (028 agg_sql exclusion, end to end)", async () => {
    const ctx = sessionToolCtx("agent:correct-mood-metric");
    await requestAndApproveTier2(ctx);
    const { id } = await insertJournal({
      entryMd: "Fictional same-day self-report about the hike.",
      mood: 1,
      at: new Date("2026-05-10T09:00:00Z"),
      createdBy: "human",
      source: "test:correct",
    });

    const beforeAmend = await queryMetric("mood", "2026-05-10", "2026-05-10", "day", "UTC");
    // Without the amend, the lone original value of 1 is the whole average.
    expect(beforeAmend.data.series).toEqual([{ period_start: "2026-05-10", value: 1 }]);

    expectOk(
      await correct(ctx, { type: "journal", action: "amend", id, mood: 5, entry_md: "Corrected." }),
    );

    const afterAmend = await queryMetric("mood", "2026-05-10", "2026-05-10", "day", "UTC");
    // If the superseded original still counted this would be round(avg(1, 5), 2) = 3 — the
    // agg_sql's `superseded_at is null` filter (028) must exclude it so only the corrected
    // successor's value counts.
    expect(afterAmend.data.series).toEqual([{ period_start: "2026-05-10", value: 5 }]);
  });
});
