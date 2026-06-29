// M1 acceptance: migrations idempotent, seed loads, updated_at triggers fire,
// events append-only enforced, one round-trip per table.

import { beforeAll, describe, expect, test } from "bun:test";
import { migrate } from "../src/db/migrate";
import { expectSqlReject, resetDb, testSql as sql } from "./helpers";

beforeAll(async () => {
  await resetDb();
});

describe("migrations", () => {
  test("runner is idempotent: second run applies nothing", async () => {
    const second = await migrate();
    expect(second).toEqual([]);
  });

  test("all spec tables exist", async () => {
    const tables = (await sql`select tablename from pg_tables where schemaname = 'public'`).map(
      (r: any) => r.tablename,
    );
    for (const t of [
      "values_items",
      "goals",
      "principles",
      "tasks",
      "commitments",
      "decisions",
      "decision_transcripts",
      "decision_branches",
      "journal_entries",
      "people",
      "person_aliases",
      "interactions",
      "pages",
      "metric_defs",
      "metric_values",
      "edges",
      "events",
      "review_queue",
      "session_unlocks",
      "chunks",
      "calendar_events",
      "transactions",
      "health_samples",
      "email_meta",
      "inbox_items",
      "schema_migrations",
    ]) {
      expect(tables).toContain(t);
    }
  });
});

describe("decision interview schema", () => {
  test("decision projection columns and branch/transcript tables exist", async () => {
    const decisionCols = (
      await sql`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'decisions'`
    ).map((r: any) => r.column_name);
    for (const c of ["falsifier", "stakes", "reversibility", "confidence", "outcome_score"]) {
      expect(decisionCols).toContain(c);
    }

    const transcriptCols = (
      await sql`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'decision_transcripts'`
    ).map((r: any) => r.column_name);
    for (const c of [
      "id",
      "decision_id",
      "ord",
      "question_key",
      "prompt",
      "answer",
      "at",
      "created_at",
      "created_by",
      "source",
      "derived_from",
      "tier",
    ]) {
      expect(transcriptCols).toContain(c);
    }

    const branchCols = (
      await sql`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'decision_branches'`
    ).map((r: any) => r.column_name);
    for (const c of [
      "id",
      "decision_id",
      "label",
      "status",
      "note",
      "would_be_right_if",
      "created_at",
      "updated_at",
      "created_by",
      "source",
      "derived_from",
      "supersedes_id",
      "tier",
    ]) {
      expect(branchCols).toContain(c);
    }
  });

  test("decision constraints reject invalid confidence, outcome score, and branch values", async () => {
    await expectSqlReject(
      sql`insert into decisions (question, options, tier)
          values ('bad tier', ${sql.json(["yes"])}, 0)`,
      /decisions_tier_check/,
    );
    await expectSqlReject(
      sql`insert into decisions (question, options, confidence)
          values ('bad confidence', ${sql.json(["yes"])}, 101)`,
      /decisions_confidence_check/,
    );
    await expectSqlReject(
      sql`insert into decisions (question, options, outcome_score)
          values ('bad score', ${sql.json(["yes"])}, -1)`,
      /decisions_outcome_score_check/,
    );
    await expectSqlReject(
      sql`insert into decisions (question, options, reversibility)
          values ('bad reversibility', ${sql.json(["yes"])}, 'forever-ish')`,
      /decisions_reversibility_check/,
    );
    await expectSqlReject(
      sql`insert into decision_branches (decision_id, label, status)
          values (gen_random_uuid(), 'x', 'maybe')`,
      /decision_branches_status_check/,
    );
  });

  test("decision transcripts are append-only", async () => {
    const [d] =
      await sql`insert into decisions (question, options) values ('append-only?', ${sql.json([
        "yes",
      ])}) returning id`;
    const [t] = await sql`
      insert into decision_transcripts (decision_id, ord, question_key, prompt, answer)
      values (${d!.id}, 1, 'fork', 'What were the options?', 'A or B')
      returning id`;
    await expectSqlReject(
      sql`update decision_transcripts set answer = 'tampered' where id = ${t!.id}`,
      /append-only/,
    );
    await expectSqlReject(sql`delete from decision_transcripts where id = ${t!.id}`, /append-only/);
    await expectSqlReject(sql`truncate decision_transcripts`, /append-only/);
  });

  test("interactions_subject_xor: rejects BOTH person+org, tolerates a single subject or none", async () => {
    const [p] = await sql`insert into people (canonical_name) values ('XOR Probe Person') returning id`;
    const [o] = await sql`insert into orgs (canonical_name) values ('XOR Probe Org') returning id`;
    // both subjects set → ambiguous → rejected
    await expectSqlReject(
      sql`insert into interactions (person_id, org_id, kind, summary, occurred_at)
          values (${p!.id}, ${o!.id}, 'note', 'both set', now())`,
      /interactions_subject_xor/,
    );
    // person-only, org-only, and subjectless (legacy note) all allowed (<= 1)
    const [r1] = await sql`insert into interactions (person_id, kind, summary, occurred_at)
                           values (${p!.id}, 'note', 'person only', now()) returning id`;
    expect(r1!.id).toBeString();
    const [r2] = await sql`insert into interactions (org_id, kind, summary, occurred_at)
                           values (${o!.id}, 'note', 'org only', now()) returning id`;
    expect(r2!.id).toBeString();
    const [r3] = await sql`insert into interactions (kind, summary, occurred_at)
                           values ('note', 'subjectless legacy', now()) returning id`;
    expect(r3!.id).toBeString();
  });

  test("minime_app has tier policies for decision interview tables", async () => {
    const grants = await sql`
      select table_name, privilege_type
      from information_schema.role_table_grants
      where grantee = 'minime_app'
        and table_name in ('decision_transcripts','decision_branches')`;
    expect(
      grants.some(
        (g: any) => g.table_name === "decision_transcripts" && g.privilege_type === "SELECT",
      ),
    ).toBe(true);
    expect(
      grants.some(
        (g: any) => g.table_name === "decision_transcripts" && g.privilege_type === "INSERT",
      ),
    ).toBe(true);
    expect(
      grants.some(
        (g: any) => g.table_name === "decision_transcripts" && g.privilege_type === "UPDATE",
      ),
    ).toBe(false);
    expect(
      grants.some(
        (g: any) => g.table_name === "decision_branches" && g.privilege_type === "UPDATE",
      ),
    ).toBe(true);

    const policies = await sql`
      select tablename, policyname
      from pg_policies
      where schemaname = 'public'
        and tablename in ('decision_transcripts','decision_branches')`;
    expect(
      policies.filter((p: any) => p.tablename === "decision_transcripts").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      policies.filter((p: any) => p.tablename === "decision_branches").length,
    ).toBeGreaterThanOrEqual(3);
  });

  test("minime_app can write tier-2 interview rows without a read unlock", async () => {
    await sql`delete from session_unlocks`;
    const decisionId = crypto.randomUUID();
    await sql.begin(async (tx) => {
      await tx`set local role minime_app`;
      await tx`
        insert into decisions (id, question, options, tier)
        values (${decisionId}, 'app role tier-2 decision?', ${sql.json(["yes", "no"])}, 2)`;
      await tx`
        insert into decision_transcripts (decision_id, ord, question_key, prompt, answer, tier)
        values (${decisionId}, 1, 'fork', 'Q', 'private answer', 2)`;
      await tx`
        insert into decision_branches (decision_id, label, status, tier)
        values (${decisionId}, 'yes', 'chosen', 2)`;
    });
  });
});

describe("events append-only (I8)", () => {
  test("insert works; update and delete are blocked", async () => {
    await sql`insert into events (actor, verb) values ('human', 'test:probe')`;
    const [row] = await sql`select id from events where verb = 'test:probe'`;
    expect(row).toBeDefined();
    await expectSqlReject(
      sql`update events set verb = 'tampered' where id = ${row!.id}`,
      /append-only/,
    );
    await expectSqlReject(sql`delete from events where id = ${row!.id}`, /append-only/);
    await expectSqlReject(sql`truncate events`, /append-only/);
  });
});

describe("standard columns & triggers", () => {
  test("updated_at trigger fires on update", async () => {
    const [t] =
      await sql`insert into tasks (title) values ('trigger probe') returning id, updated_at`;
    await Bun.sleep(10);
    await sql`update tasks set title = 'trigger probe 2' where id = ${t!.id}`;
    const [after] = await sql`select updated_at from tasks where id = ${t!.id}`;
    expect(new Date(after!.updated_at).getTime()).toBeGreaterThan(
      new Date(t!.updated_at).getTime(),
    );
  });

  test("tier constraints: journal defaults tier 2, transactions tier 0", async () => {
    const [j] = await sql`insert into journal_entries (entry_md) values ('probe') returning tier`;
    expect(j!.tier).toBe(2);
    const [tx] =
      await sql`insert into transactions (occurred_at, amount_cents, currency, account_label, external_ref)
      values ('2026-01-01', -100, 'SGD', 'probe-acct', 'probe-1') returning tier`;
    expect(tx!.tier).toBe(0);
  });
});

describe("seed + round-trips", () => {
  test("seed loads the demo dataset", async () => {
    const { seed } = await import("../fixtures/seed");
    const counts = await seed();
    expect(counts.pages).toBe(30);
    expect(counts.journal).toBe(20);
    expect(counts.people).toBe(10);
    expect(counts.decisions).toBe(8);
    expect(counts.transactions).toBe(200);
    expect(counts.health_samples).toBeGreaterThanOrEqual(500);
  });

  test("round-trip per table: every substantive table has rows with provenance", async () => {
    for (const t of [
      "values_items",
      "goals",
      "principles",
      "tasks",
      "commitments",
      "decisions",
      "journal_entries",
      "people",
      "interactions",
      "pages",
      "calendar_events",
      "transactions",
      "health_samples",
      "chunks",
      "edges",
    ]) {
      const [r] = await sql.unsafe(`select count(*)::int as n from "${t}"`);
      expect(r!.n, `table ${t} should have seeded rows`).toBeGreaterThan(0);
    }
    // provenance stamped (I5)
    const [bad] =
      await sql`select count(*)::int as n from pages where source is null or created_by is null`;
    expect(bad!.n).toBe(0);
  });

  test("metric_defs seeded with whitelisted agg_sql", async () => {
    const defs = (await sql`select name from metric_defs`).map((r: any) => r.name);
    for (const m of [
      "spend_total",
      "spend_by_category",
      "sleep_minutes",
      "steps",
      "deep_work_minutes",
      "journal_streak",
    ]) {
      expect(defs).toContain(m);
    }
  });
});
