// Deterministic multi-entity inbox split (fictional regression for the
// classifier-collapses-several-entities-into-one-row bug).

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { heuristicClassify } from "../src/pipeline/classify";
import { processInboxFile } from "../src/pipeline/watcher";
import { config } from "../src/util/config";
import { resetDb, testSql as sql } from "./helpers";

const REPRO = `I emailed three fictional suppliers about calibration gel for Project SILDRE:
Northstar Reagents AS (Bergen), Bluefin Labs AS (Oslo), and Aster Bio AS (Trondheim).
Nadia Rossi, the sales lead at Corvid Biotech, was asked to help.`;

const INTERACTION =
  "met Nadia Rossi about Northstar Reagents AS, Bluefin Labs AS, and Aster Bio AS calibration gel";

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

async function orgNames(): Promise<string[]> {
  const rows = await sql`select canonical_name from orgs order by canonical_name`;
  return rows.map((r) => String(r.canonical_name));
}

describe("multi-entity capture split (e2e, classifier mocked)", () => {
  test("the supplier repro files a note and mints each named org plus Nadia Rossi", async () => {
    expect(heuristicClassify(REPRO).type).toBe("note");
    const path = await writeInbox("multi-suppliers.md", REPRO);
    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);

    const [item] = await sql`
      select filed_table, filed_id from inbox_items where id = ${result.inboxId}`;
    expect(item!.filed_table).toBe("pages");

    const names = await orgNames();
    expect(names).toEqual(
      expect.arrayContaining([
        "Northstar Reagents AS",
        "Bluefin Labs AS",
        "Aster Bio AS",
        "Corvid Biotech",
      ]),
    );
    const orgs = await sql`
      select canonical_name, tier, derived_from from orgs
      where canonical_name in (
        'Northstar Reagents AS', 'Bluefin Labs AS', 'Aster Bio AS', 'Corvid Biotech'
      )`;
    expect(orgs).toHaveLength(4);
    for (const org of orgs) {
      expect(org.tier).toBe(1);
      // Extract-edges may mint the org first and stamp derived_from with the page
      // id; the page itself carries derived_from = inbox_item.id.
      expect(org.derived_from).toBeTruthy();
    }

    const people = await sql`
      select canonical_name, tier from people where canonical_name = 'Nadia Rossi'`;
    expect(people).toHaveLength(1);
    expect(people[0]!.tier).toBe(1);

    const [split] = await sql`
      select payload from events
      where verb = 'inbox:split-entities' and entity_id = ${result.inboxId}`;
    expect(split).toBeTruthy();
    const payload = split!.payload as {
      org_count: number;
      person_count: number;
      org_ids: string[];
      person_ids: string[];
    };
    expect(payload.org_count).toBe(4);
    expect(payload.person_count).toBe(1);
    expect(payload.org_ids).toHaveLength(4);
    expect(payload.person_ids).toHaveLength(1);

    const chunks = await sql`
      select parent_type, text from chunks
      where parent_type in ('org', 'person')
        and (
          text ilike '%Northstar Reagents AS%'
          or text ilike '%Bluefin Labs AS%'
          or text ilike '%Aster Bio AS%'
          or text ilike '%Corvid Biotech%'
          or text ilike '%Nadia Rossi%'
        )`;
    expect(chunks.length).toBeGreaterThanOrEqual(5);
  });

  test("an interaction subject is not minted twice; companion orgs still are", async () => {
    expect(heuristicClassify(INTERACTION).type).toBe("interaction");
    const path = await writeInbox("multi-met.md", INTERACTION);
    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);

    const [item] = await sql`select filed_id from inbox_items where id = ${result.inboxId}`;
    const [row] =
      await sql`select person_id, org_id from interactions where id = ${item!.filed_id}`;
    expect(row!.person_id).not.toBeNull();
    expect(row!.org_id).toBeNull();

    const people = await sql`select canonical_name from people`;
    expect(people.map((p) => p.canonical_name)).toEqual(["Nadia Rossi"]);

    const names = await orgNames();
    expect(names).toEqual(
      expect.arrayContaining(["Northstar Reagents AS", "Bluefin Labs AS", "Aster Bio AS"]),
    );

    const [split] = await sql`
      select payload from events
      where verb = 'inbox:split-entities' and entity_id = ${result.inboxId}`;
    const payload = split!.payload as { org_count: number; person_count: number };
    expect(payload.org_count).toBe(3);
    expect(payload.person_count).toBe(0);
  });

  test("a single-entity capture still files one row and does not split", async () => {
    const path = await writeInbox("single.md", "todo: renew passport by 2026-08-01");
    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);
    const [tasks] = await sql`select count(*)::int as n from tasks`;
    expect(tasks!.n).toBe(1);
    const [orgs] = await sql`select count(*)::int as n from orgs`;
    expect(orgs!.n).toBe(0);
    const [people] = await sql`select count(*)::int as n from people`;
    expect(people!.n).toBe(0);
    const [splits] = await sql`
      select count(*)::int as n from events where verb = 'inbox:split-entities'`;
    expect(splits!.n).toBe(0);
  });

  test("an enumeration without names is unfiled for review, not guessed", async () => {
    const path = await writeInbox(
      "unnamed.md",
      "I emailed three suppliers about calibration gel but I forgot their names.",
    );
    const result = await processInboxFile(path);
    expect(result.filed).toBe(false);

    const [item] = await sql`
      select status, classifier_output from inbox_items where id = ${result.inboxId}`;
    expect(item!.status).toBe("pending");
    const plan = item!.classifier_output as { confidence: number; reason: string };
    expect(plan.confidence).toBeLessThanOrEqual(0.4);
    expect(plan.reason).toContain("enumerated companies or people");

    const [unfiled] = await sql`
      select count(*)::int as n from review_queue
      where kind = 'inbox_unfiled' and status = 'open'
        and payload->>'inbox_item_id' = ${result.inboxId}`;
    expect(unfiled!.n).toBe(1);
    const [orgs] = await sql`select count(*)::int as n from orgs`;
    expect(orgs!.n).toBe(0);
  });

  test("replay of a filed multi-entity capture is idempotent", async () => {
    const path = await writeInbox("replay.md", REPRO);
    const first = await processInboxFile(path);
    expect(first.filed).toBe(true);
    const replay = await processInboxFile(path);
    expect(replay).toEqual({ inboxId: first.inboxId, filed: true });

    const [orgs] = await sql`select count(*)::int as n from orgs`;
    expect(orgs!.n).toBe(4);
    const [people] = await sql`select count(*)::int as n from people`;
    expect(people!.n).toBe(1);
    const [splits] = await sql`
      select count(*)::int as n from events
      where verb = 'inbox:split-entities' and entity_id = ${first.inboxId}`;
    expect(splits!.n).toBe(1);
  });
});
