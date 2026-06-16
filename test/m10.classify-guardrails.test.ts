// Classifier guardrails (regression for the two real-world classifier bugs):
//   1. date anchor   — the classify prompt must tell the model today's date so relative
//                       phrases ("tomorrow") don't resolve to a wrong (past) year.
//   2. date guardrail — the watcher must drop a past due date instead of storing it, and
//                       leave a trail so the owner can set the real date at review.
//   3. dedup          — a re-mentioned task must be routed to review_queue('duplicate'),
//                       not inserted as a second row (the classifier has no row memory).

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildPrompt } from "../src/pipeline/classify";
import { findDuplicate, titleSimilarity, tokens } from "../src/pipeline/dedup";
import { processInboxFile } from "../src/pipeline/watcher";
import { setNow, todayStr } from "../src/util/clock";
import { config } from "../src/util/config";
import { resetDb, testSql as sql } from "./helpers";

beforeAll(async () => {
  await resetDb();
});

describe("classify prompt date anchor", () => {
  test("prompt embeds today's date and forbids past due dates", () => {
    const p = buildPrompt("2026-06-16");
    expect(p).toContain("2026-06-16");
    expect(p.toLowerCase()).toContain("never output a due date in the past");
    // relative-date guidance is present so the model resolves "tomorrow" correctly
    expect(p.toLowerCase()).toContain("tomorrow");
  });

  test("prompt date tracks the injectable clock", () => {
    setNow(new Date("2027-01-02T08:00:00+08:00"));
    expect(buildPrompt(todayStr())).toContain(todayStr());
    setNow(null);
  });
});

describe("dedup similarity (unit)", () => {
  test("tokens strips possessives, punctuation, and stopwords", () => {
    const t = tokens("Attend Mia's KiddieWinkie Father's Day event");
    expect(t.has("mia")).toBe(true);
    expect(t.has("kiddiewinkie")).toBe(true);
    expect(t.has("event")).toBe(false); // stopword
    expect(t.has("day")).toBe(false); // stopword
  });

  test("re-mention of the same event scores as a duplicate", () => {
    const a = "Attend Mia's KiddieWinkie Father's Day event at SAFRA Mount Faber";
    const b = "Attend Mia KiddieWinkie Father's Day event (arrive 2.15pm, covered shoes)";
    expect(titleSimilarity(a, b)).toBeGreaterThan(0.5);
  });

  test("different tasks do NOT collide", () => {
    expect(
      titleSimilarity("Freeze down all cells before leave", "Refresh Jurkat cell media"),
    ).toBeLessThan(0.5);
  });

  test("findDuplicate respects the due-date window (recurring chore is not a dup)", () => {
    const open = [{ id: "x", title: "Refresh Jurkat cell media", due: "2026-06-19" }];
    // same title, far-apart date → not a duplicate
    expect(findDuplicate("Refresh Jurkat cell media", "2026-07-19", open)).toBeNull();
    // same title, same date → duplicate
    expect(findDuplicate("Refresh Jurkat cell media", "2026-06-20", open)?.match.id).toBe("x");
  });
});

describe("watcher date guardrail (e2e, classifier mocked)", () => {
  test("a past due date is dropped and the task is flagged, not corrupted", async () => {
    const inbox = join(config.dataDir, "inbox");
    await mkdir(inbox, { recursive: true });
    const path = join(inbox, "past-date-task.md");
    // heuristic classifier emits the `by YYYY-MM-DD` date; this one is in the past
    await Bun.write(path, "todo: submit grant renewal by 2020-01-01");

    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);

    const [item] = await sql`select filed_id from inbox_items where id = ${result.inboxId}`;
    const [task] = await sql`select due, body from tasks where id = ${item!.filed_id}`;
    expect(task!.due).toBeNull(); // past date dropped, not stored
    expect(String(task!.body)).toContain("date guardrail"); // trail left for review
  });
});

describe("watcher dedup (e2e, classifier mocked)", () => {
  test("a re-mentioned task is queued as duplicate, not inserted twice", async () => {
    const inbox = join(config.dataDir, "inbox");
    await mkdir(inbox, { recursive: true });

    // first capture files a normal task
    const p1 = join(inbox, "dedup-first.md");
    await Bun.write(p1, "todo: order lysis buffer membranes for the assay by 2026-12-01");
    const r1 = await processInboxFile(p1);
    expect(r1.filed).toBe(true);

    // near-identical second capture must NOT create a second task
    const p2 = join(inbox, "dedup-second.md");
    await Bun.write(p2, "todo: order lysis buffer membranes for the assay by 2026-12-02");
    const r2 = await processInboxFile(p2);
    expect(r2.filed).toBe(false); // routed to review, not filed

    const [tasks] =
      await sql`select count(*)::int as n from tasks where title ilike '%lysis buffer membranes%'`;
    expect(tasks!.n).toBe(1); // still only one task

    const [dupq] =
      await sql`select count(*)::int as n from review_queue where kind = 'duplicate' and status = 'open'`;
    expect(dupq!.n).toBeGreaterThan(0);

    // and it did NOT also queue an inbox_unfiled item for the same capture
    const [unfiled] = await sql`
      select count(*)::int as n from review_queue
      where kind = 'inbox_unfiled' and status = 'open'
        and payload->>'inbox_item_id' = ${r2.inboxId}`;
    expect(unfiled!.n).toBe(0);
  });
});
