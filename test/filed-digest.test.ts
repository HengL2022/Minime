// W2-8: minime_state's filed_today digest turns the evening review into a 30-second classifier
// audit — every capture the classifier (or minime_refile) routed into a typed row TODAY, with
// its kind/confidence guess (always visible — inbox_items is tier 1 until a real destination
// exists) plus the destination's title/tier. Titles resolve ONLY through the tier-filtered
// parentMeta (repo.ts), never classifier_output, so a journal-grade capture can never leak its
// content into a tier-1 snapshot just because it happened to be filed today.

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { toolByName } from "../src/mcp/tools";
import { type ToolCtx, invokeTool } from "../src/mcp/tools/registry";
import { processInboxFile } from "../src/pipeline/watcher";
import { setNow } from "../src/util/clock";
import { config } from "../src/util/config";
import { resetDb, testSql } from "./helpers";
import { requestAndApproveTier2, sessionToolCtx } from "./support/unlock";

const HIDDEN = "[above current tier]";
const RETRACTED = "[retracted]";
const inboxDir = join(config.dataDir, "inbox");

beforeAll(async () => {
  await resetDb();
  await mkdir(inboxDir, { recursive: true });
});

/** File a capture through the real classifier pipeline and look up where it landed. */
async function fileCapture(
  name: string,
  text: string,
): Promise<{ inboxId: string; filedTable: string; filedId: string }> {
  const path = join(inboxDir, name);
  await Bun.write(path, text);
  const { inboxId, filed } = await processInboxFile(path);
  expect(filed).toBe(true);
  const [row] = await testSql`
    select filed_table, filed_id from inbox_items where id = ${inboxId}::uuid`;
  return { inboxId, filedTable: row!.filed_table as string, filedId: row!.filed_id as string };
}

async function state(ctx: ToolCtx, params: Record<string, unknown> = {}) {
  const result = await invokeTool(toolByName("minime_state"), params, ctx);
  if (!result.ok)
    throw new Error(`minime_state failed: ${result.error.code} ${result.error.message}`);
  return result.envelope;
}

describe("minime_state: filed_today digest", () => {
  test("at tier 1, the task filing shows its title while the journal filing shows kind/confidence with a masked title", async () => {
    const taskText = "todo: ZQX-FILED-DIGEST-TASK fictional lens pickup";
    const task = await fileCapture("zqx-filed-digest-task.md", taskText);
    expect(task.filedTable).toBe("tasks");

    const journalText = "Feeling grateful today about my fictional ZQX-FILED-DIGEST-JOURNAL notes";
    const journal = await fileCapture("zqx-filed-digest-journal.md", journalText);
    expect(journal.filedTable).toBe("journal_entries");

    const env = await state(sessionToolCtx("agent:filed-digest-locked"));
    const filedToday = (env.data as any).filed_today as any[];

    const taskEntry = filedToday.find((f) => f.id === task.inboxId);
    expect(taskEntry).toMatchObject({
      type: "task",
      filed_table: "tasks",
      filed_id: task.filedId,
      kind: "task",
      confidence: 0.9,
      title: "ZQX-FILED-DIGEST-TASK fictional lens pickup",
      tier: 1,
    });

    const journalEntry = filedToday.find((f) => f.id === journal.inboxId);
    expect(journalEntry).toMatchObject({
      type: "journal",
      filed_table: "journal_entries",
      filed_id: journal.filedId,
      kind: "journal",
      confidence: 0.8,
      title: HIDDEN,
      tier: null,
    });

    // sources carry the same masked title through — never the raw journal text, whether via
    // filed_today itself or the citation trail (I3: tier-2 content never enters a tier-1
    // snapshot, and classifier_output is never the source of a title either way).
    const journalSource = env.sources.find((s) => s.id === journal.filedId);
    expect(journalSource?.title).toBe(HIDDEN);
    expect(JSON.stringify(env)).not.toContain("ZQX-FILED-DIGEST-JOURNAL");
  });

  test("an approved tier-2 unlock reveals the journal filing's title and tier", async () => {
    const journalText =
      "Feeling grateful today about my fictional ZQX-FILED-DIGEST-JOURNAL-UNLOCK notes";
    const journal = await fileCapture("zqx-filed-digest-journal-unlock.md", journalText);

    const ctx = sessionToolCtx("agent:filed-digest-unlocked");
    await requestAndApproveTier2(ctx);
    const env = await state(ctx);
    const filedToday = (env.data as any).filed_today as any[];
    const journalEntry = filedToday.find((f) => f.id === journal.inboxId);
    expect(journalEntry.title).toBe(journalText);
    expect(journalEntry.tier).toBe(2);
  });

  test("a same-day filing whose destination was retracted reads [retracted] with its real tier, not the tier-hidden sentinel (W2-8 review finding)", async () => {
    // Long-form text, no task/interaction/journal/decision cue -> heuristicClassify files it as
    // type=note (kind), which watcher.fileRow routes to `pages` at tier 1 (noteHintTier's
    // ordinary-text default) — the same "tier-1 pages row" shape the review finding reproduced.
    const noteText =
      "Reference notes about the fictional ZQX-FILED-DIGEST-RETRACT archival project: tape " +
      "rotation schedule and storage bin labeling plan for the annex.";
    const note = await fileCapture("zqx-filed-digest-retract.md", noteText);
    expect(note.filedTable).toBe("pages");

    const ctx = sessionToolCtx("agent:filed-digest-retract");
    const retractResult = await invokeTool(
      toolByName("minime_correct"),
      { type: "note", action: "retract", id: note.filedId },
      ctx,
    );
    if (!retractResult.ok) {
      throw new Error(
        `minime_correct retract failed: ${retractResult.error.code} ${retractResult.error.message}`,
      );
    }

    const env = await state(ctx);
    const filedToday = (env.data as any).filed_today as any[];
    const noteEntry = filedToday.find((f) => f.id === note.inboxId);
    // parentMeta excludes retracted rows for every caller regardless of tier, so a naive miss
    // check would render this identically to a genuine tier-2 gate (HIDDEN, tier null) even
    // though the page is tier 1 and fully readable by id (minime_get_context) — exactly the
    // ambiguity review-queue.ts's visibleTitle already resolves for the sibling case.
    expect(noteEntry).toMatchObject({
      type: "page",
      filed_table: "pages",
      filed_id: note.filedId,
      kind: "note",
      confidence: 0.75,
      title: RETRACTED,
      tier: 1,
    });
    expect(noteEntry.title).not.toBe(HIDDEN);
  });

  test("a capture filed near the UTC boundary lands on the caller's local calendar day, not UTC's", async () => {
    // Direct insert (mirrors the moved_today tz regression, metric-time-semantics.test.ts):
    // inbox_items.updated_at is trigger-maintained on UPDATE, not INSERT, so this is the only
    // way to pin an exact filed instant under a mocked clock.
    const [task] = await testSql`
      insert into tasks (title, status, tier)
      values ('ZQX-FILED-DIGEST-TZ fictional task', 'active', 1)
      returning id`;
    const [inboxRow] = await testSql`
      insert into inbox_items
        (raw_path, mime, status, filed_table, filed_id, classifier_output, updated_at,
         created_by, source, tier)
      values ('inbox/zqx-filed-digest-tz.md', 'text/plain', 'filed', 'tasks', ${task!.id}::uuid,
              ${testSql.json({ type: "task", confidence: 0.9 })}, '2026-01-02T02:00:00Z',
              'fixture', 'test:filed-digest-tz', 1)
      returning id`;

    // 2026-01-02T03:00:00Z is 2026-01-01T19:00 in America/Los_Angeles (UTC-8): the caller's
    // local calendar day is still Jan 1 while UTC's has already rolled to Jan 2 — the same
    // boundary moved_today's own regression guards, applied here to filed_today's identical
    // (updated_at at time zone effectiveTimeZone)::date predicate.
    setNow(new Date("2026-01-02T03:00:00Z"));
    try {
      const env = await state(sessionToolCtx("agent:filed-digest-tz"), {
        time_zone: "America/Los_Angeles",
      });
      const filedToday = (env.data as any).filed_today as any[];
      expect(filedToday.map((f) => f.id)).toContain(inboxRow!.id);
    } finally {
      setNow(null);
    }
  });
});
