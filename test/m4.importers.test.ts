// M4 acceptance: importers are idempotent (run twice = identical counts), malformed rows
// are logged not fatal, and an inbox text file becomes a filed task end-to-end.

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertInboxItem } from "../src/db/repo";
import { importCalendar, parseIcs, parseIcsDate } from "../src/importers/calendar";
import { importEmailMeta } from "../src/importers/email-meta";
import { importHealth } from "../src/importers/health";
import { type TxProfile, importTransactions, parseCsv } from "../src/importers/transactions";
import { heuristicClassify } from "../src/pipeline/classify";
import { processInboxFile, startWatcher } from "../src/pipeline/watcher";
import { setNow } from "../src/util/clock";
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
  test("preserves normalized date parameters and rejects normalized calendar overflow", () => {
    const [event] = parseIcs(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:parameter-shape@fixture
DTSTART;value=date-time;tzid=America/New_York:20261101T013000
SUMMARY:Parameter shape
END:VEVENT
END:VCALENDAR`);
    expect(event!.dtstart).toEqual({
      value: "20261101T013000",
      params: { VALUE: "DATE-TIME", TZID: "America/New_York" },
    });
    expect(parseIcsDate("20260229T090000Z")).toBeNull();
    expect(parseIcsDate("20260610T246000Z")).toBeNull();
  });

  test("idempotent; malformed events skipped not fatal", async () => {
    const ics = await Bun.file(join(FIXTURES, "calendar.ics")).text();
    const first = await importCalendar(ics);
    expect(first).toEqual({ total: 11, inserted: 6, updated: 0, skipped: 5 });

    const second = await importCalendar(ics);
    expect(second.inserted).toBe(0);
    const [r] = await sql`select count(*)::int as n from calendar_events`;
    expect(r!.n).toBe(6);

    // Folded line unfolded, attendees parsed.
    const [folded] =
      await sql`select title from calendar_events where uid = 'evt-folded-20260613@fixture'`;
    expect(folded!.title).toContain("robotics startup and catch up");
    const [oneonone] =
      await sql`select starts_at, attendees from calendar_events where uid = 'evt-1on1-20260609@fixture'`;
    expect(oneonone!.starts_at.toISOString()).toBe("2026-06-09T06:00:00.000Z");
    expect(oneonone!.attendees).toContain("jordan.lee@lumenworks.example");

    // UTC stays UTC; floating values and DATE midnights use config.tz. A missing all-day
    // DTEND becomes the exclusive next local midnight, not a fixed 24-hour duration.
    const [utc] =
      await sql`select starts_at from calendar_events where uid = 'evt-standup-20260608@fixture'`;
    expect(utc!.starts_at.toISOString()).toBe("2026-06-08T09:30:00.000Z");
    const [floating] =
      await sql`select starts_at from calendar_events where uid = 'evt-floating-20260611@fixture'`;
    expect(floating!.starts_at.toISOString()).toBe("2026-06-11T00:30:00.000Z");
    const [allDay] = await sql`
      select starts_at, ends_at from calendar_events
      where uid = 'evt-allday-20260612@fixture'`;
    expect(allDay!.starts_at.toISOString()).toBe("2026-06-11T16:00:00.000Z");
    expect(allDay!.ends_at.toISOString()).toBe("2026-06-12T16:00:00.000Z");
    const invalidRows = await sql`
      select uid from calendar_events
      where uid in (
        'evt-badend-20260616@fixture',
        'evt-unknown-zone-20260617@fixture',
        'evt-mismatched-types-20260618@fixture'
      )`;
    expect(invalidRows).toHaveLength(0);

    const malformed = await sql`
      select payload from events
      where actor = 'importer:calendar' and verb = 'import:malformed'
      order by id`;
    expect(malformed).toHaveLength(10);
    expect(malformed.map((event) => event.payload.record_number)).toEqual([
      7, 8, 9, 10, 11, 7, 8, 9, 10, 11,
    ]);
    for (const event of malformed) {
      expect(event.payload).toEqual({
        importer: "calendar",
        reason: "missing_required_fields",
        record_number: expect.any(Number),
      });
      expect(JSON.stringify(event.payload)).not.toContain("Malformed DTEND");
      expect(JSON.stringify(event.payload)).not.toContain("Mars/Olympus");
    }
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

  test("a mismatched header fails without echoing a tier-zero transaction row", async () => {
    const sentinel = "TIER0-PRIVATE-TRANSACTION-SENTINEL";
    const profile: TxProfile = {
      account_label: "fixture",
      currency: "SGD",
      columns: { date: "Date", amount: "Amount" },
      date_format: "YYYY-MM-DD",
      sign_convention: "negative_is_spend",
    };
    let message = "";
    try {
      await importTransactions(`2026-08-06,-12.34,${sentinel}\n`, profile);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("profile columns not found in CSV header");
    expect(message).not.toContain(sentinel);
  });

  test("the CLI resolves built-in profiles from the repository, not the caller cwd", async () => {
    const unrelatedCwd = await mkdtemp(join(tmpdir(), "minime-cli-cwd-"));
    const cli = join(import.meta.dir, "../src/cli.ts");
    const csv = join(FIXTURES, "transactions-dbs.csv");
    const env = {
      ...process.env,
      MINIME_SKIP_REPO_DOTENV: "1",
      NODE_ENV: "test",
      MINIME_MOCK_OLLAMA: "1",
    };
    Reflect.deleteProperty(env, "MINIME_APP_DATABASE_URL");
    try {
      const result = Bun.spawnSync(
        [
          process.execPath,
          "--no-env-file",
          "run",
          cli,
          "import:transactions",
          csv,
          "--profile",
          "dbs",
        ],
        { cwd: unrelatedCwd, env, stdout: "pipe", stderr: "pipe" },
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toMatchObject({ total: 12, skipped: 2 });

      const missingTarget = join(unrelatedCwd, "PRIVATE-MISSING-TRANSACTIONS.csv");
      const invalidProfile = "../PRIVATE-PROFILE";
      const rejected = Bun.spawnSync(
        [
          process.execPath,
          "--no-env-file",
          "run",
          cli,
          "import:transactions",
          missingTarget,
          "--profile",
          invalidProfile,
        ],
        { cwd: unrelatedCwd, env, stdout: "pipe", stderr: "pipe" },
      );
      const output = rejected.stdout.toString() + rejected.stderr.toString();
      expect(rejected.exitCode).toBe(2);
      expect(output).toContain("transaction profile name is invalid");
      expect(output).not.toContain(missingTarget);
      expect(output).not.toContain(invalidProfile);
    } finally {
      await rm(unrelatedCwd, { recursive: true, force: true });
    }
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
  beforeEach(() => setNow(new Date("2026-07-01T12:00:00.000Z")));
  afterEach(() => setNow(null));

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
    const rows = await sql`
      select payload from review_queue
      where kind = 'inbox_unfiled' and status = 'open'`;
    expect(rows.length).toBeGreaterThan(0);
    const payload = rows.find((row) => row.payload?.inbox_item_id === result.inboxId)?.payload;
    expect(payload).toEqual({ inbox_item_id: result.inboxId });
    expect(JSON.stringify(payload)).not.toContain(config.dataDir);
    expect(JSON.stringify(payload)).not.toContain("classifier");
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

  test("orphaned pending rows (raw_path missing on this host) are rejected, not retried forever", async () => {
    // A row synced from another machine: classifier_output IS NULL and raw_path points at a
    // file that never existed here (e.g. macOS /Users/... path). drainStartup used to skip
    // these silently, so they sat 'pending' forever and inflated the review queue.
    const ghostPath = "/fictional-owner/.hermes/data/inbox/capture-ghost.md";
    const { id } = await insertInboxItem({
      rawPath: ghostPath,
      mime: "text/markdown",
      createdBy: "agent:mcp",
    });
    const [before] = await sql`select status, classifier_output from inbox_items where id = ${id}`;
    expect(before!.status).toBe("pending");
    expect(before!.classifier_output).toBeNull();

    const w = await startWatcher();
    try {
      const [item] = await sql`select status, classifier_output from inbox_items where id = ${id}`;
      expect(item!.status).toBe("rejected");
      expect(item!.classifier_output?.rejected).toBe(true);
      const [ev] =
        await sql`select count(*)::int as n from events where verb = 'inbox:orphaned' and entity_id = ${id}`;
      expect(ev!.n).toBe(1);
    } finally {
      await w.close();
    }
  });
});
