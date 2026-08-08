// M1 acceptance: migrations idempotent, seed loads, updated_at triggers fire,
// events append-only enforced, one round-trip per table.

import { beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { migrate } from "../src/db/migrate";
import { logEvent } from "../src/db/repo";
import { eventAuditSink } from "../src/mcp/audit";
import { auditPayload } from "../src/util/audit-payload";
import { expectSqlReject, resetDb, testSql as sql } from "./helpers";
import { activeTestDatabaseName, testDatabaseUrl } from "./setup";
import { dropTestAppRole, mintTestAppRole } from "./support/app-role";

beforeAll(async () => {
  const [current] = await sql`select current_database() as name`;
  expect(current!.name).toMatch(/^minime_test_[a-z0-9_]+$/);
  expect(current!.name).not.toBe("minime_test");
  expect(current!.name).toBe(activeTestDatabaseName());
  await resetDb();
});

describe("migrations", () => {
  test("runner is idempotent: second run applies nothing", async () => {
    const second = await migrate({ kind: "test" });
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

  test("preload retains one guarded database selection", () => {
    expect(testDatabaseUrl()).toMatch(/\/minime_test_[a-z0-9_]+$/);
    expect(activeTestDatabaseName()).toMatch(/^minime_test_[a-z0-9_]+$/);
    expect(activeTestDatabaseName()).not.toBe("minime_test");
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
    const [p] =
      await sql`insert into people (canonical_name) values ('XOR Probe Person') returning id`;
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

  test("unique scratch app role can write tier-2 interview rows without a read unlock", async () => {
    await sql`delete from session_unlocks`;
    const decisionId = crypto.randomUUID();
    const role = await mintTestAppRole(testDatabaseUrl());
    const app = postgres(role.databaseUrl, { max: 1, onnotice: () => {} });
    try {
      await app.begin(async (tx) => {
        await tx`select set_config('minime.actor', 'agent:m1', true)`;
        await tx`
          insert into decisions (id, question, options, tier)
          values (${decisionId}, 'app role tier-2 decision?', ${app.json(["yes", "no"])}, 2)`;
        await tx`
          insert into decision_transcripts (decision_id, ord, question_key, prompt, answer, tier)
          values (${decisionId}, 1, 'fork', 'Q', 'private answer', 2)`;
        await tx`
          insert into decision_branches (decision_id, label, status, tier)
          values (${decisionId}, 'yes', 'chosen', 2)`;
      });
    } finally {
      await app.end({ timeout: 2 });
      await dropTestAppRole(role);
    }
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

  test("logEvent exposes lossless decimal text IDs and disposition rows are unique", async () => {
    const emptyOnboard = auditPayload.onboardComplete({
      profile: 0,
      values: 0,
      goals: 0,
      principles: 0,
      people: 0,
      tasks: 0,
      journal: 0,
    });
    const eventId = await logEvent({
      actor: "human",
      verb: "onboard:complete",
      payload: emptyOnboard,
    });
    expect(typeof eventId).toBe("string");
    const [row] = await sql`select id::text as id from events where id = ${eventId}`;
    expect(row!.id).toBe(eventId);

    await sql.unsafe(
      "select setval(pg_get_serial_sequence('events', 'id'), 9007199254740991, true)",
    );
    const largeId = await logEvent({
      actor: "human",
      verb: "onboard:complete",
      payload: emptyOnboard,
    });
    expect(largeId).toBe("9007199254740992");
    const [largeRow] = await sql`select id::text as id from events where id = ${largeId}`;
    expect(largeRow!.id).toBe(largeId);

    const result = await eventAuditSink.result("agent:test", "minime_get_context", "a".repeat(16), {
      returnedIds: [crypto.randomUUID()],
      returnedCount: 1,
      delivery: "transport",
    });
    expect(result.eventId).toBeString();
    await eventAuditSink.disposition("agent:test", "minime_get_context", result.eventId, {
      status: "released",
    });
    await expectSqlReject(
      eventAuditSink.disposition("agent:test", "minime_get_context", result.eventId, {
        status: "send_uncertain",
      }),
      /events_tool_disposition_result_event_uidx/,
    );

    const indexes = await sql`
      select c.relname as name, i.indisunique as is_unique,
             pg_get_expr(i.indpred, i.indrelid) as predicate
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where c.relname in (
        'events_tool_disposition_result_event_uidx',
        'events_get_context_released_disposition_idx'
      )
      order by c.relname`;
    expect(
      indexes.map((row: any) => ({
        name: row.name,
        is_unique: row.is_unique,
        predicate: row.predicate,
      })),
    ).toEqual([
      {
        name: "events_get_context_released_disposition_idx",
        is_unique: false,
        predicate:
          "((verb = 'tool:minime_get_context:disposition'::text) AND ((payload ->> 'status'::text) = 'released'::text))",
      },
      {
        name: "events_tool_disposition_result_event_uidx",
        is_unique: true,
        predicate: "((verb ~~ 'tool:%:disposition'::text) AND (payload ? 'result_event_id'::text))",
      },
    ]);
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

describe("W2-1 correction/supersede columns", () => {
  // The 12 PARENTS-map content tables (src/db/repo.ts) that migration 028 extends uniformly.
  const SUPERSEDE_TABLES = [
    "pages",
    "journal_entries",
    "interactions",
    "decisions",
    "decision_branches",
    "tasks",
    "goals",
    "values_items",
    "principles",
    "people",
    "orgs",
    "commitments",
  ];
  // 021_runtime_app_role.sql already grants full table-level UPDATE on these six; migration 028
  // adds nothing further there since the existing grant already covers new columns.
  const ALREADY_FULL_UPDATE = new Set([
    "tasks",
    "decisions",
    "people",
    "pages",
    "orgs",
    "decision_branches",
  ]);
  const COLUMN_LIMITED_UPDATE = SUPERSEDE_TABLES.filter((t) => !ALREADY_FULL_UPDATE.has(t));

  test("superseded_by/superseded_at exist, correctly typed, on all twelve content tables", async () => {
    for (const t of SUPERSEDE_TABLES) {
      const cols = (
        await sql`
          select column_name, data_type from information_schema.columns
          where table_schema = 'public' and table_name = ${t}
            and column_name in ('superseded_by', 'superseded_at')`
      ).map((r: any) => ({ column_name: r.column_name, data_type: r.data_type }));
      expect(cols, `table ${t}`).toContainEqual({
        column_name: "superseded_by",
        data_type: "uuid",
      });
      expect(cols, `table ${t}`).toContainEqual({
        column_name: "superseded_at",
        data_type: "timestamp with time zone",
      });
    }
  });

  test("a <table>_supersede_check constraint exists on all twelve content tables", async () => {
    for (const t of SUPERSEDE_TABLES) {
      const [row] = await sql`
        select constraint_name from information_schema.table_constraints
        where table_schema = 'public' and table_name = ${t}
          and constraint_name = ${`${t}_supersede_check`} and constraint_type = 'CHECK'`;
      expect(row, `table ${t} missing its supersede check constraint`).toBeDefined();
    }
  });

  test("the check constraint rejects a successor with no timestamp; retraction and full supersession are both allowed (journal_entries)", async () => {
    const [row] =
      await sql`insert into journal_entries (entry_md) values ('constraint probe') returning id`;
    await expectSqlReject(
      sql`update journal_entries set superseded_by = gen_random_uuid() where id = ${row!.id}`,
      /journal_entries_supersede_check/,
    );
    // retracted: superseded_at alone is a legal soft-delete with no successor
    await sql`update journal_entries set superseded_at = now() where id = ${row!.id}`;
    const [retracted] = await sql`
      select superseded_by, superseded_at from journal_entries where id = ${row!.id}`;
    expect(retracted!.superseded_by).toBeNull();
    expect(retracted!.superseded_at).not.toBeNull();
    // superseded: both columns set once a successor exists
    const [successor] =
      await sql`insert into journal_entries (entry_md) values ('successor') returning id`;
    await sql`update journal_entries set superseded_by = ${successor!.id} where id = ${row!.id}`;
    const [superseded] = await sql`
      select superseded_by, superseded_at from journal_entries where id = ${row!.id}`;
    expect(superseded!.superseded_by).toBe(successor!.id);
    expect(superseded!.superseded_at).not.toBeNull();
  });

  test("the check constraint rejects a successor with no timestamp (people)", async () => {
    const [row] = await sql`
      insert into people (canonical_name) values ('Constraint Probe Person') returning id`;
    await expectSqlReject(
      sql`update people set superseded_by = gen_random_uuid() where id = ${row!.id}`,
      /people_supersede_check/,
    );
  });

  test("minime_app gets column-limited UPDATE on the six previously write-locked tables, never table-wide", async () => {
    for (const t of COLUMN_LIMITED_UPDATE) {
      const tableGrant = await sql`
        select privilege_type from information_schema.role_table_grants
        where grantee = 'minime_app' and table_name = ${t} and privilege_type = 'UPDATE'`;
      expect(tableGrant.length, `table ${t} must not have table-wide UPDATE`).toBe(0);

      const columnGrants = (
        await sql`
          select column_name from information_schema.column_privileges
          where grantee = 'minime_app' and table_name = ${t} and privilege_type = 'UPDATE'
          order by column_name`
      ).map((r: any) => r.column_name);
      expect(columnGrants, `table ${t}`).toEqual(["superseded_at", "superseded_by"]);
    }
  });

  test("the six tables with pre-existing full UPDATE keep it, unaffected by the new column grant", async () => {
    for (const t of ALREADY_FULL_UPDATE) {
      const [row] = await sql`
        select 1 as ok from information_schema.role_table_grants
        where grantee = 'minime_app' and table_name = ${t} and privilege_type = 'UPDATE'`;
      expect(row, `table ${t} should retain full UPDATE`).toBeDefined();
    }
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
      "mood",
      "energy",
      "body_mass",
      "hr_resting",
      "habit_streak",
    ]) {
      expect(defs).toContain(m);
    }
  });
});
