// Phantom-org root-cause fix (regression). Three layers, one bug:
//   1. classifier — an interaction with a company counterparty emits subject_type:"org"
//      (heuristic uses orgCue); a human counterparty stays subject_type:"person".
//   2. watcher    — the interaction branch routes to an ORG row (never a phantom person)
//      when subject_type is "org", an org of that name already exists, or (subject_type
//      absent) the name carries a company cue. A plain person still files as a person.
//   3. watchdog   — the nightly phantomPersonScan flags person rows that look like an org
//      (name matches an existing org, or company-cue name with zero human signal), as a
//      flag-only review_queue('phantom_person') item — it never auto-retypes.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { heuristicClassify, orgCue } from "../src/pipeline/classify";
import { phantomPersonScan } from "../src/pipeline/dream";
import { processInboxFile } from "../src/pipeline/watcher";
import { config } from "../src/util/config";
import { resetDb, testSql as sql } from "./helpers";

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

describe("orgCue (unit)", () => {
  test("fires on company/vendor/institution descriptors", () => {
    expect(orgCue("BioTree, a metabolomics company")).toBe(true);
    expect(orgCue("Vazyme Biotech")).toBe(true);
    expect(orgCue("Acme Pte Ltd")).toBe(true);
    expect(orgCue("Huashan Hospital")).toBe(true);
  });
  test("does NOT fire on a plain person name", () => {
    expect(orgCue("Daniel")).toBe(false);
    expect(orgCue("Mercia Yoong")).toBe(false);
  });
});

describe("classifier subject_type (unit, heuristic)", () => {
  test("a company counterparty is typed subject_type=org", () => {
    const c = heuristicClassify("met Vazyme Biotech, discussed the enzyme order");
    expect(c.type).toBe("interaction");
    expect(c.fields.subject_type).toBe("org");
  });
  test("a human counterparty is typed subject_type=person", () => {
    const c = heuristicClassify("met Daniel, discussed the sorting run");
    expect(c.type).toBe("interaction");
    expect(c.fields.subject_type).toBe("person");
  });
});

describe("watcher interaction routing (e2e, classifier mocked)", () => {
  test("a vendor interaction attaches to an ORG and mints NO person row", async () => {
    const path = await writeInbox("vendor.md", "met Vazyme Biotech, discussed the enzyme order");
    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);

    const [item] = await sql`select filed_id from inbox_items where id = ${result.inboxId}`;
    const [row] =
      await sql`select person_id, org_id from interactions where id = ${item!.filed_id}`;
    expect(row!.org_id).not.toBeNull();
    expect(row!.person_id).toBeNull();

    // no phantom person was created
    const [people] = await sql`select count(*)::int as n from people`;
    expect(people!.n).toBe(0);
    const [org] = await sql`select canonical_name from orgs where id = ${row!.org_id}`;
    expect(org!.canonical_name.toLowerCase()).toContain("vazyme");
  });

  test("a human interaction still attaches to a PERSON", async () => {
    const path = await writeInbox("human.md", "met Daniel about the sorting run");
    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);

    const [item] = await sql`select filed_id from inbox_items where id = ${result.inboxId}`;
    const [row] =
      await sql`select person_id, org_id from interactions where id = ${item!.filed_id}`;
    expect(row!.person_id).not.toBeNull();
    expect(row!.org_id).toBeNull();
    const [orgs] = await sql`select count(*)::int as n from orgs`;
    expect(orgs!.n).toBe(0);
  });

  test("an interaction whose name matches an EXISTING org reuses it (no new row)", async () => {
    // pre-create the org, as the sanctioned vendor-precreate workaround would
    const [org] = await sql`
      insert into orgs (canonical_name, created_by, source) values ('BioTree','test','manual')
      returning id`;
    await sql`insert into org_aliases (org_id, alias) values (${org!.id}, 'BioTree')`;

    const path = await writeInbox("reuse.md", "met BioTree, discussed metabolomics pricing");
    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);

    const [item] = await sql`select filed_id from inbox_items where id = ${result.inboxId}`;
    const [row] = await sql`select org_id from interactions where id = ${item!.filed_id}`;
    expect(row!.org_id).toBe(org!.id); // reused, not duplicated
    const [orgs] = await sql`select count(*)::int as n from orgs`;
    expect(orgs!.n).toBe(1);
    const [people] = await sql`select count(*)::int as n from people`;
    expect(people!.n).toBe(0);
  });
});

describe("phantom-person watchdog (dream step 3b)", () => {
  test("flags a person that shares a name with an existing org", async () => {
    const [org] = await sql`
      insert into orgs (canonical_name, created_by, source) values ('Vazyme','test','manual')
      returning id`;
    const [person] = await sql`
      insert into people (canonical_name, created_by, source) values ('Vazyme','test','manual')
      returning id`;

    const flagged = await phantomPersonScan();
    expect(flagged).toBe(1);

    const [q] = await sql`
      select payload from review_queue where kind = 'phantom_person' and status = 'open'`;
    expect(q!.payload.person_id).toBe(person!.id);
    expect(q!.payload.reason).toContain("organisation");
    // org existence is irrelevant to the flag beyond the name match
    expect(org!.id).toBeTruthy();
  });

  test("flags a company-cue person with zero human signal", async () => {
    await sql`
      insert into people (canonical_name, created_by, source)
      values ('BioTree Biotech','test','manual')`;
    const flagged = await phantomPersonScan();
    expect(flagged).toBe(1);
    const [q] = await sql`
      select payload from review_queue where kind = 'phantom_person' and status = 'open'`;
    expect(q!.payload.reason).toContain("no human");
  });

  test("does NOT flag a real person (no org name, no cue)", async () => {
    await sql`
      insert into people (canonical_name, relation, created_by, source)
      values ('Mercia Yoong','colleague','test','manual')`;
    const flagged = await phantomPersonScan();
    expect(flagged).toBe(0);
  });

  test("does NOT flag a company-cue person who HAS human signal (has interactions)", async () => {
    const [p] = await sql`
      insert into people (canonical_name, created_by, source)
      values ('Acme Consulting','test','manual') returning id`;
    await sql`
      insert into interactions (person_id, kind, summary, occurred_at, created_by, source)
      values (${p!.id}, 'meeting', 'lunch with the Acme lead', now(), 'test', 'manual')`;
    const flagged = await phantomPersonScan();
    expect(flagged).toBe(0);
  });

  test("is idempotent — a second scan does not double-flag", async () => {
    await sql`
      insert into orgs (canonical_name, created_by, source) values ('Vazyme','test','manual')`;
    await sql`
      insert into people (canonical_name, created_by, source) values ('Vazyme','test','manual')`;
    expect(await phantomPersonScan()).toBe(1);
    expect(await phantomPersonScan()).toBe(0);
    const [n] = await sql`
      select count(*)::int as n from review_queue where kind = 'phantom_person'`;
    expect(n!.n).toBe(1);
  });
});
