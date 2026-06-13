// M4 acceptance: importers are idempotent (run twice = identical counts), malformed rows
// are logged not fatal, and an inbox text file becomes a filed task end-to-end.

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { insertInboxItem } from "../src/db/repo";
import { importCalendar } from "../src/importers/calendar";
import { importEmailMeta } from "../src/importers/email-meta";
import { importHealth } from "../src/importers/health";
import { type TxProfile, importTransactions, parseCsv } from "../src/importers/transactions";
import { heuristicClassify } from "../src/pipeline/classify";
import { processInboxFile, startWatcher } from "../src/pipeline/watcher";
import { config } from "../src/util/config";
import { countEvents, resetDb, testSql as sql } from "./helpers";

const FIXTURES = join(import.meta.dir, "../fixtures");

// postgres.js returns `date` columns as JS Dates (UTC midnight) — compare as ISO days
const isoDay = (v: unknown) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

beforeAll(async () => {
  await resetDb();
});

describe("calendar importer", () => {
  test("idempotent; malformed events skipped not fatal", async () => {
    const ics = await Bun.file(join(FIXTURES, "calendar.ics")).text();
    const first = await importCalendar(ics);
    expect(first.inserted).toBe(5);
    expect(first.skipped).toBe(2);

    const second = await importCalendar(ics);
    expect(second.inserted).toBe(0);
    const [r] = await sql`select count(*)::int as n from calendar_events`;
    expect(r!.n).toBe(5);

    // folded line unfolded, attendees parsed
    const [folded] =
      await sql`select title from calendar_events where uid = 'evt-folded-20260613@fixture'`;
    expect(folded!.title).toContain("robotics startup and catch up");
    const [oneonone] =
      await sql`select attendees from calendar_events where uid = 'evt-1on1-20260609@fixture'`;
    expect(oneonone!.attendees).toContain("jordan.lee@lumenworks.example");
  });
});

describe("transactions importer", () => {
  test("idempotent; profile mapping; malformed rows skipped; provenance stamped", async () => {
    const csv = await Bun.file(join(FIXTURES, "transactions-dbs.csv")).text();
    const profile = (await Bun.file(
      join(import.meta.dir, "../config/tx-profiles/dbs.json"),
    ).json()) as TxProfile;
    const first = await importTransactions(csv, profile);
    expect(first.inserted).toBe(10);
    expect(first.skipped).toBe(2);

    const second = await importTransactions(csv, profile);
    expect(second.inserted).toBe(0);
    const [r] =
      await sql`select count(*)::int as n, min(amount_cents)::bigint as min from transactions`;
    expect(r!.n).toBe(10);

    const [salary] =
      await sql`select amount_cents, occurred_at, created_by from transactions where external_ref = 'FIX-0005'`;
    expect(Number(salary!.amount_cents)).toBe(620000);
    expect(salary!.created_by).toBe("importer:transactions");
    // DD/MM/YYYY parsed correctly
    expect(isoDay(salary!.occurred_at)).toBe("2026-06-04");
    // row-hash fallback used when Reference column empty
    const [pharmacy] =
      await sql`select external_ref from transactions where merchant = 'Guardian Pharmacy'`;
    expect(pharmacy!.external_ref).toMatch(/^[0-9a-f]{24}$/);
  });

  test("csv parser handles quoted fields with commas and escaped quotes", () => {
    const rows = parseCsv('a,"b,c","d""e"\n1,2,3');
    expect(rows[0]).toEqual(["a", "b,c", 'd"e']);
  });
});

describe("health importer", () => {
  test("idempotent; whitelist enforced; sleep duration computed; malformed logged", async () => {
    const before = await countEvents("import:malformed");
    const path = join(FIXTURES, "health-export.xml");
    const first = await importHealth(path);
    // 3 steps + 2 hr + 2 sleep-asleep + 1 body mass = 8 inserted;
    // skipped: distance (not whitelisted), in-bed sleep, bad date
    expect(first.inserted).toBe(8);
    expect(first.skipped).toBe(3);
    const second = await importHealth(path);
    expect(second.inserted).toBe(0);

    const [sleep] =
      await sql`select value from health_samples where kind = 'sleep_minutes' order by at limit 1`;
    expect(Number(sleep!.value)).toBe(410); // 23:40 -> 06:30
    expect(await countEvents("import:malformed")).toBeGreaterThan(before);
  });
});

describe("email-meta importer", () => {
  test("headers only, bodies never stored, idempotent", async () => {
    const dir = join(FIXTURES, "maildir");
    const first = await importEmailMeta(dir);
    expect(first.inserted).toBe(3);
    expect(first.skipped).toBe(1);
    const second = await importEmailMeta(dir);
    expect(second.inserted).toBe(0);

    const rows = await sql`select * from email_meta`;
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(JSON.stringify(r)).not.toContain("never be stored");
      expect(r.tier).toBe(2);
    }
    const [threaded] =
      await sql`select thread_id from email_meta where message_id = 'a1b2c3d4@lumenworks.example'`;
    expect(threaded!.thread_id).toBe("weekly-1@lumenworks.example");
  });
});

describe("inbox e2e (watcher pipeline, classifier mocked)", () => {
  test("a text capture becomes a filed task with provenance + archive copy", async () => {
    const inbox = join(config.dataDir, "inbox");
    await mkdir(inbox, { recursive: true });
    const path = join(inbox, "capture-task.md");
    await Bun.write(path, "todo: book Tokyo accommodation by 2026-08-01");

    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);

    const [item] =
      await sql`select status, filed_table, filed_id from inbox_items where id = ${result.inboxId}`;
    expect(item!.status).toBe("filed");
    expect(item!.filed_table).toBe("tasks");
    const [task] =
      await sql`select title, due, created_by, derived_from, source from tasks where id = ${item!.filed_id}`;
    expect(task!.title).toContain("book Tokyo accommodation");
    expect(isoDay(task!.due)).toBe("2026-08-01");
    expect(task!.created_by).toBe("agent:classifier");
    expect(task!.derived_from).toBe(result.inboxId);
    expect(task!.source).toBe("capture");

    // archived copy exists
    const { readdir } = await import("node:fs/promises");
    const year = String(new Date().getFullYear());
    const archived = await readdir(join(config.dataDir, "archive", year), { recursive: true });
    expect(archived.some((f) => String(f).includes("capture-task.md"))).toBe(true);

    // idempotent: reprocessing the same file does not double-file
    const again = await processInboxFile(path);
    expect(again.inboxId).toBe(result.inboxId);
    const [n] =
      await sql`select count(*)::int as n from tasks where derived_from = ${result.inboxId}`;
    expect(n!.n).toBe(1);
  });

  test("low-confidence capture goes to the review queue, not a guessed table", async () => {
    const inbox = join(config.dataDir, "inbox");
    const path = join(inbox, "capture-unclear.md");
    await Bun.write(path, "unclear: zzz");
    const result = await processInboxFile(path);
    expect(result.filed).toBe(false);
    const [q] =
      await sql`select count(*)::int as n from review_queue where kind = 'inbox_unfiled' and status = 'open'`;
    expect(q!.n).toBeGreaterThan(0);
  });

  test("heuristic classifier covers the capture taxonomy", () => {
    expect(heuristicClassify("todo: water the plants by 2026-07-01").type).toBe("task");
    expect(heuristicClassify("Met Priya for coffee, talked careers").type).toBe("interaction");
    expect(heuristicClassify("Today I felt grateful for the quiet morning").type).toBe("journal");
    expect(heuristicClassify("Decided: renew the lease for one year").type).toBe("decision_note");
    expect(
      heuristicClassify(
        "The dutch oven method gives better crust because steam stays in the pot for the first twenty minutes",
      ).type,
    ).toBe("note");
    expect(heuristicClassify("???").type).toBe("unknown");
  });
});

describe("inbox startup drain (watcher recovery)", () => {
  test("startup creates the inbox dir and drains pending capture rows", async () => {
    // Simulate a capture that landed before the watcher was running: file on disk + a
    // pending inbox_items row that was never classified (the dir-didn't-exist bug).
    const inbox = join(config.dataDir, "inbox");
    await mkdir(inbox, { recursive: true });
    const path = join(inbox, "drain-task.md");
    await Bun.write(path, "todo: renew passport by 2026-09-01");
    const { id } = await insertInboxItem({
      rawPath: path,
      mime: "text/markdown",
      createdBy: "human",
    });

    const [before] = await sql`select status, classifier_output from inbox_items where id = ${id}`;
    expect(before!.status).toBe("pending");
    expect(before!.classifier_output).toBeNull();

    const w = await startWatcher();
    try {
      const [item] =
        await sql`select status, filed_table, filed_id from inbox_items where id = ${id}`;
      expect(item!.status).toBe("filed");
      expect(item!.filed_table).toBe("tasks");
      const [task] = await sql`select title from tasks where id = ${item!.filed_id}`;
      expect(task!.title).toContain("renew passport");
    } finally {
      await w.close();
    }
  });
});
