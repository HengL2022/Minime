// Conservative mixed-intent inbox companions. A prefixed dump that is a task
// and an interaction and a note files leftover typed rows; inbox_items still
// has one primary. Fixtures are fictional.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { processInboxFile } from "../src/pipeline/watcher";
import { config } from "../src/util/config";
import { resetDb, testSql as sql } from "./helpers";

const MIXED = `todo: send the SILDRE contract
met Nadia Rossi about the Q3 quote
note: they want a written redline`;

const TWO_TODOS = `todo: send the SILDRE contract
todo: book the wet-lab bench`;

const NARRATIVE = `Need to send the SILDRE contract by Friday.

Had coffee with Nadia Rossi about the Q3 quote.

They want a written redline before the wet-lab booking.`;

const SUPPLIER = `I emailed three fictional suppliers about calibration gel for Project SILDRE:
Northstar Reagents AS (Bergen), Bluefin Labs AS (Oslo), and Aster Bio AS (Trondheim).
Nadia Rossi, the sales lead at Corvid Biotech, was asked to help.`;

beforeEach(async () => {
  await resetDb();
});

async function writeInbox(name: string, body: string): Promise<string> {
  const inbox = join(config.dataDir, "inbox");
  await mkdir(inbox, { recursive: true });
  const path = join(inbox, name);
  await Bun.write(path, body);
  return path;
}

describe("mixed-intent capture split (e2e, classifier mocked)", () => {
  test("a prefixed dump files a task primary plus interaction and note companions", async () => {
    const path = await writeInbox("mixed-intents.md", MIXED);
    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);

    const [item] = await sql`
      select filed_table, status from inbox_items where id = ${result.inboxId}`;
    expect(item!.status).toBe("filed");
    expect(item!.filed_table).toBe("tasks");

    const tasks = await sql`select title, body, derived_from from tasks`;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toContain("send the SILDRE contract");
    expect(String(tasks[0]!.body)).not.toContain("written redline");
    expect(tasks[0]!.derived_from).toBe(result.inboxId);

    const interactions = await sql`select summary, derived_from, tier from interactions`;
    expect(interactions).toHaveLength(1);
    expect(String(interactions[0]!.summary)).toContain("Nadia Rossi");
    expect(interactions[0]!.derived_from).toBe(result.inboxId);
    expect(interactions[0]!.tier).toBe(2);

    const pages = await sql`select title, body_md, path, derived_from from pages`;
    expect(pages).toHaveLength(1);
    expect(String(pages[0]!.title)).toContain("they want a written redline");
    expect(pages[0]!.derived_from).toBe(result.inboxId);
    const projected = await readFile(join(config.dataDir, "brain", String(pages[0]!.path)), "utf8");
    expect(projected).toContain("written redline");

    const [split] = await sql`
      select payload from events
      where verb = 'inbox:split-intents' and entity_id = ${result.inboxId}`;
    expect(split).toBeTruthy();
    const payload = split!.payload as {
      extra_count: number;
      extra_types: string[];
      extra_tables: string[];
      extra_ids: string[];
    };
    expect(payload.extra_count).toBe(2);
    expect(payload.extra_types).toEqual(["interaction", "note"]);
    expect(payload.extra_tables).toEqual(["interactions", "pages"]);
    expect(payload.extra_ids).toHaveLength(2);
    expect(JSON.stringify(payload)).not.toContain("SILDRE");
    expect(JSON.stringify(payload)).not.toContain("Nadia");
  });

  test("two todo lines stay one task and do not emit an intent split", async () => {
    const path = await writeInbox("two-todos.md", TWO_TODOS);
    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);
    const tasks = await sql`select body from tasks`;
    expect(tasks).toHaveLength(1);
    expect(String(tasks[0]!.body)).toContain("book the wet-lab bench");
    const [split] = await sql`
      select id from events
      where verb = 'inbox:split-intents' and entity_id = ${result.inboxId}`;
    expect(split).toBeUndefined();
  });

  test("a narrative dump without prefixes files leftover typed companions", async () => {
    const path = await writeInbox("narrative-intents.md", NARRATIVE);
    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);
    const [item] = await sql`
      select filed_table, status from inbox_items where id = ${result.inboxId}`;
    expect(item!.status).toBe("filed");
    expect(item!.filed_table).toBe("tasks");
    expect(await sql`select id from tasks`).toHaveLength(1);
    expect(await sql`select id from interactions`).toHaveLength(1);
    expect(await sql`select id from pages`).toHaveLength(1);
    const [split] = await sql`
      select payload from events
      where verb = 'inbox:split-intents' and entity_id = ${result.inboxId}`;
    expect(split).toBeTruthy();
    const payload = split!.payload as { extra_count: number; extra_types: string[] };
    expect(payload.extra_count).toBe(2);
    expect(payload.extra_types).toEqual(["interaction", "note"]);
    expect(JSON.stringify(payload)).not.toContain("SILDRE");
    expect(JSON.stringify(payload)).not.toContain("Nadia");
  });

  test("the supplier repro still files entities, not mixed-intent extras", async () => {
    const path = await writeInbox("suppliers.md", SUPPLIER);
    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);
    const [item] = await sql`select filed_table from inbox_items where id = ${result.inboxId}`;
    expect(item!.filed_table).toBe("pages");
    const [intents] = await sql`
      select id from events
      where verb = 'inbox:split-intents' and entity_id = ${result.inboxId}`;
    expect(intents).toBeUndefined();
    const [entities] = await sql`
      select id from events
      where verb = 'inbox:split-entities' and entity_id = ${result.inboxId}`;
    expect(entities).toBeTruthy();
  });

  test("replay of a filed mixed dump does not mint a second task", async () => {
    const path = await writeInbox("mixed-replay.md", MIXED);
    const first = await processInboxFile(path);
    expect(first.filed).toBe(true);
    const replay = await processInboxFile(path);
    expect(replay.inboxId).toBe(first.inboxId);
    const tasks = await sql`select id from tasks`;
    expect(tasks).toHaveLength(1);
    const interactions = await sql`select id from interactions`;
    expect(interactions).toHaveLength(1);
  });
});
