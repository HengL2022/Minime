// Classifier guardrails (fictional regression cases for the classifier bugs):
//   1. date anchor   — the classify prompt must tell the model today's date so relative
//                       phrases ("tomorrow") don't resolve to a wrong (past) year.
//   2. date guardrail — the watcher must drop a past due date instead of storing it, and
//                       leave a trail so the owner can set the real date at review.
//   3. dedup          — a re-mentioned task must be routed to review_queue('duplicate'),
//                       not inserted as a second row (the classifier has no row memory).

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  buildPrompt,
  completionSignal,
  completionTitle,
  splitActionDecision,
} from "../src/pipeline/classify";
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
    const t = tokens("Attend Tomasz's Fjordsonics Founder's Day event");
    expect(t.has("tomasz")).toBe(true);
    expect(t.has("fjordsonics")).toBe(true);
    expect(t.has("event")).toBe(false); // stopword
    expect(t.has("day")).toBe(false); // stopword
  });

  test("re-mention of the same event scores as a duplicate", () => {
    const a = "Attend Tomasz's Fjordsonics Founder's Day event at Pirsenteret";
    const b = "Attend Tomasz Fjordsonics Founder's Day event (arrive 2.15pm, bring safety shoes)";
    expect(titleSimilarity(a, b)).toBeGreaterThan(0.5);
  });

  test("different tasks do NOT collide", () => {
    expect(
      titleSimilarity(
        "Calibrate the six hydrophone nodes before deployment",
        "Update beamforming firmware",
      ),
    ).toBeLessThan(0.5);
  });

  test("findDuplicate respects the due-date window (recurring chore is not a dup)", () => {
    const open = [{ id: "x", title: "Inspect calibration rig connectors", due: "2026-06-19" }];
    // same title, far-apart date → not a duplicate
    expect(findDuplicate("Inspect calibration rig connectors", "2026-07-19", open)).toBeNull();
    // same title, same date → duplicate
    expect(findDuplicate("Inspect calibration rig connectors", "2026-06-20", open)?.match.id).toBe(
      "x",
    );
  });
});

describe("watcher date guardrail (e2e, classifier mocked)", () => {
  test("a past due date is dropped and the task is flagged, not corrupted", async () => {
    const inbox = join(config.dataDir, "inbox");
    await mkdir(inbox, { recursive: true });
    const path = join(inbox, "past-date-task.md");
    // heuristic classifier emits the `by YYYY-MM-DD` date; this one is in the past
    await Bun.write(path, "todo: submit the SILDRE field report by 2020-01-01");

    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);

    const [item] = await sql`select filed_id from inbox_items where id = ${result.inboxId}`;
    const [task] = await sql`select due, body from tasks where id = ${item!.filed_id}`;
    expect(task!.due).toBeNull(); // past date dropped, not stored
    expect(String(task!.body)).toContain("date guardrail"); // trail left for review
  });
});

describe("split mixed captures — completion detection (unit)", () => {
  test("completionSignal detects finished-work phrasing", () => {
    expect(completionSignal("array calibration done, beamforming works")).toBe(true);
    expect(completionSignal("sensor readings confirmed, wet test finished")).toBe(true);
    expect(completionSignal("got it working; succeeded today")).toBe(true);
  });

  test("completionSignal is false for purely forward-looking text", () => {
    expect(completionSignal("Should we use spare hydrophone nodes? need to think further")).toBe(
      false,
    );
    expect(
      completionSignal("Deciding whether to order more Bluefin wet-mate connectors next week"),
    ).toBe(false);
  });

  test("completionTitle extracts a concise done-task title", () => {
    const title = completionTitle(
      "Array calibration done, sensor readings good, beamforming works. Note: need spare hydrophone nodes, think further.",
    );
    expect(title.length).toBeGreaterThan(0);
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.toLowerCase()).toContain("array calibration");
  });
});

describe("split compound action+decision captures (unit)", () => {
  test("splitActionDecision peels a decision clause off an action", () => {
    const s = splitActionDecision(
      "Run array calibration for six hydrophone nodes and decide on Munkholmen deployment",
    );
    expect(s).not.toBeNull();
    expect(s!.action.toLowerCase()).toContain("array calibration");
    expect(s!.action.toLowerCase()).not.toContain("decide");
    expect(s!.decision.toLowerCase()).toContain("munkholmen deployment");
    expect(s!.decision.toLowerCase()).toMatch(/^decide/);
  });

  test("splitActionDecision strips a leading task:/todo: prefix from the action", () => {
    const s = splitActionDecision("task: Run the wet test and decide whether to repeat it");
    expect(s).not.toBeNull();
    expect(s!.action.toLowerCase()).toBe("run the wet test");
    expect(s!.decision.toLowerCase()).toContain("whether to repeat");
  });

  test("splitActionDecision returns null for a plain action task", () => {
    expect(splitActionDecision("Refresh the hydrophone node firmware")).toBeNull();
  });

  test("splitActionDecision does not fire on a pure decision (no leading action)", () => {
    expect(splitActionDecision("decide on Munkholmen deployment")).toBeNull();
  });
});

describe("compound action+decision split (e2e, classifier mocked)", () => {
  test("a 'do X and decide on Y' task splits into an action task + companion decision", async () => {
    const inbox = join(config.dataDir, "inbox");
    await mkdir(inbox, { recursive: true });
    const path = join(inbox, "compound-task.md");
    // The calibration-and-deployment umbrella bug: a single combined task that no later single
    // capture fully closes. The action half must file as a task (without the decision
    // clause in its title) AND a companion decision must be created from the same item.
    await Bun.write(
      path,
      "task: Run array calibration for six hydrophone nodes and decide on Munkholmen deployment",
    );
    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);

    const [item] = await sql`select filed_id from inbox_items where id = ${result.inboxId}`;
    const [task] = await sql`select title, status from tasks where id = ${item!.filed_id}`;
    expect(task!.title.toLowerCase()).toContain("array calibration");
    expect(task!.title.toLowerCase()).not.toContain("decide");

    const [dec] =
      await sql`select id, question from decisions where derived_from = ${result.inboxId}`;
    expect(dec).toBeTruthy();
    expect(dec!.question.toLowerCase()).toContain("munkholmen deployment");
  });

  test("a compound capture that REPORTS the action done does not spawn a decision", async () => {
    const inbox = join(config.dataDir, "inbox");
    await mkdir(inbox, { recursive: true });
    const path = join(inbox, "compound-done.md");
    await Bun.write(
      path,
      "task: Ran the array calibration and decided on Munkholmen deployment — done",
    );
    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);
    const [dec] =
      await sql`select count(*)::int as n from decisions where derived_from = ${result.inboxId}`;
    expect(dec!.n).toBe(0);
  });
});

describe("split mixed captures (e2e, classifier mocked)", () => {
  test("a decision capture that reports finished work ALSO yields a done-task", async () => {
    const inbox = join(config.dataDir, "inbox");
    await mkdir(inbox, { recursive: true });
    const path = join(inbox, "mixed-capture.md");
    // heuristic classifier sees "decided"/"decision" → decision_note; the body also
    // reports completed work, which must surface as a done-task (else it vanishes from
    // the evening review's "what moved today").
    await Bun.write(
      path,
      "decision: Array calibration done and beamforming works, but need to decide whether to use spare hydrophone nodes",
    );

    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);

    // the decision was filed
    const [dec] = await sql`select count(*)::int as n from decisions`;
    expect(dec!.n).toBeGreaterThan(0);

    // AND a done-task was created for the accomplishment, derived from the same inbox item
    const [doneTask] = await sql`
      select id, status, completed_at from tasks
      where derived_from = ${result.inboxId} and status = 'done'`;
    expect(doneTask).toBeTruthy();
    expect(doneTask!.status).toBe("done");
    expect(doneTask!.completed_at).not.toBeNull(); // stamped so it shows under "moved today"
  });

  test("a plain forward-looking decision does NOT spawn a done-task", async () => {
    const inbox = join(config.dataDir, "inbox");
    await mkdir(inbox, { recursive: true });
    const path = join(inbox, "plain-decision.md");
    await Bun.write(
      path,
      "decision: should we switch the acoustic release vendor or stay with the current one",
    );

    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);

    const [doneTask] = await sql`
      select count(*)::int as n from tasks
      where derived_from = ${result.inboxId} and status = 'done'`;
    expect(doneTask!.n).toBe(0);
  });
});

describe("task-branch completion (e2e, classifier mocked)", () => {
  test("a plain task capture that reports finished work is filed as DONE, not inbox", async () => {
    const inbox = join(config.dataDir, "inbox");
    await mkdir(inbox, { recursive: true });
    const path = join(inbox, "task-done.md");
    // heuristic classifier sees "task:" → type=task; the body says it's done, so it must
    // be stamped done (else it stays open and vanishes from "what moved today").
    await Bun.write(
      path,
      "task: check returned sensor readings & re-label the 5 hydrophone nodes correctly — done",
    );

    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);

    const [item] = await sql`select filed_id from inbox_items where id = ${result.inboxId}`;
    const [task] = await sql`select status, completed_at from tasks where id = ${item!.filed_id}`;
    expect(task!.status).toBe("done");
    expect(task!.completed_at).not.toBeNull();
  });

  test("a completion capture CLOSES a matching existing open task instead of duplicating it", async () => {
    const inbox = join(config.dataDir, "inbox");
    await mkdir(inbox, { recursive: true });

    // first: an open task exists
    const p1 = join(inbox, "calibration-open.md");
    await Bun.write(p1, "task: calibrate all hydrophone nodes before deployment");
    const r1 = await processInboxFile(p1);
    expect(r1.filed).toBe(true);
    const [item1] = await sql`select filed_id from inbox_items where id = ${r1.inboxId}`;
    const openId = item1!.filed_id;

    // then: a completion report for the same task must CLOSE it, not queue a duplicate
    const p2 = join(inbox, "calibration-done.md");
    await Bun.write(p2, "task: calibrate all hydrophone nodes before deployment — done");
    const r2 = await processInboxFile(p2);

    // the original task is now done
    const [closed] = await sql`select status, completed_at from tasks where id = ${openId}`;
    expect(closed!.status).toBe("done");
    expect(closed!.completed_at).not.toBeNull();

    // and we did NOT spawn a second open row for the same work
    const [cnt] =
      await sql`select count(*)::int as n from tasks where title ilike '%calibrate all hydrophone nodes%'`;
    expect(cnt!.n).toBe(1);

    // nor leave it stuck in the duplicate review queue
    const [dupq] = await sql`
      select count(*)::int as n from review_queue
      where kind = 'duplicate' and status = 'open'
        and payload->>'inbox_item_id' = ${r2.inboxId}`;
    expect(dupq!.n).toBe(0);
  });
});

describe("watcher dedup (e2e, classifier mocked)", () => {
  test("a re-mentioned task is queued as duplicate, not inserted twice", async () => {
    const inbox = join(config.dataDir, "inbox");
    await mkdir(inbox, { recursive: true });

    // first capture files a normal task
    const p1 = join(inbox, "dedup-first.md");
    await Bun.write(
      p1,
      "todo: order Bluefin wet-mate connectors for the calibration rig by 2026-12-01",
    );
    const r1 = await processInboxFile(p1);
    expect(r1.filed).toBe(true);

    // near-identical second capture must NOT create a second task
    const p2 = join(inbox, "dedup-second.md");
    await Bun.write(
      p2,
      "todo: order Bluefin wet-mate connectors for the calibration rig by 2026-12-02",
    );
    const r2 = await processInboxFile(p2);
    expect(r2.filed).toBe(false); // routed to review, not filed

    const [tasks] =
      await sql`select count(*)::int as n from tasks where title ilike '%bluefin wet-mate connectors for the calibration rig%'`;
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
