// W3-3 review remediation (high-severity finding, 2026-08-08): minime_timeline's per-kind LOCKED
// tier-2 count (repo.ts's timelineRows) used to run a plain `select count(*) ... where tier = 2`
// through the ordinary db() connection. In the real resident deployment that connection is always
// the restricted minime_app role, and journal_entries/interactions carry the standard tier_read
// RLS policy `USING (tier >= 1 and tier <= app_allowed_tier())` — which Postgres intersects with
// the query's own WHERE clause, so a genuinely locked session could never see the count it was
// trying to compute (`tier <= 1 AND tier = 2` is never satisfiable): the count was unconditionally
// 0 under real RLS no matter how many tier-2 rows existed in range. test/timeline.test.ts's own
// `locked: {journal: 1, interaction: 1}` assertions cannot catch this: ordinary `bun test` runs
// fall back to the owner DSN (src/db/client.ts) and bypass RLS entirely. This file exercises the
// fix (032_timeline_locked_count.sql's timeline_locked_count() SECURITY DEFINER function) through
// a genuine restricted role, the same mintTestAppRole/Bun.spawn patterns test/runtime-role.test.ts
// and test/entity-tier-provenance.test.ts already use for other tables.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  ensurePerson,
  insertInteraction,
  insertJournal,
  upsertCalendarEvent,
} from "../src/db/repo";
import { expectSqlReject, resetDb, testSql } from "./helpers";
import { type TrackedTestSqlPoolHandle, trackTestSqlPool } from "./setup";
import { type TestAppRoleLease, dropTestAppRole, mintTestAppRole } from "./support/app-role";

const FROM = "2021-07-01";
const TO = "2021-07-31";
const OUT_OF_WINDOW = "2021-06-15T09:00:00Z";
const JOURNAL_SENTINEL = "RESTRICTED-ROLE-JOURNAL-SENTINEL";
const INTERACTION_SENTINEL = "RESTRICTED-ROLE-INTERACTION-SENTINEL";

let app: ReturnType<typeof postgres>;
let appRole: TestAppRoleLease;
let appHeld: TrackedTestSqlPoolHandle | undefined;

async function readTimelineAsLockedApp(from: string, to: string): Promise<any> {
  const source = `
    import { closeDb } from "./src/db/client.ts";
    import { toolByName } from "./src/mcp/tools/index.ts";
    import { invokeTool } from "./src/mcp/tools/registry.ts";
    const result = await invokeTool(
      toolByName("minime_timeline"),
      { from: ${JSON.stringify(from)}, to: ${JSON.stringify(to)}, time_zone: "UTC" },
      { actor: "agent:timeline-restricted-fixture" },
    );
    process.stdout.write(JSON.stringify(result));
    await closeDb();
  `;
  const proc = Bun.spawn([process.execPath, "--eval", source], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: appRole.databaseUrl,
      MINIME_APP_DATABASE_URL: appRole.databaseUrl,
      MINIME_MOCK_OLLAMA: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`locked app timeline read failed: ${stderr.trim()}`);
  return JSON.parse(stdout);
}

beforeAll(async () => {
  await resetDb();
  appRole = await mintTestAppRole(process.env.DATABASE_URL!);
  app = postgres(appRole.databaseUrl, { max: 2, onnotice: () => {} });
  appHeld = trackTestSqlPool(app);

  // Tier-1 control row, so the surrounding read (not just the locked count) is proven correct
  // through the restricted role too.
  const calAt = new Date("2021-07-10T09:00:00Z");
  await upsertCalendarEvent({
    uid: "restricted-role-timeline-cal@minime",
    occurrenceStart: calAt,
    startsAt: calAt,
    title: "Restricted role timeline calendar",
  });

  // Two tier-2 journal rows and one tier-2 interaction row inside the window; one more journal
  // row OUTSIDE the window proves timeline_locked_count()'s date bound is not accidentally wide
  // open (a definer function that forgot its WHERE bound would leak a global count, not a
  // ranged one).
  await insertJournal({
    entryMd: `${JOURNAL_SENTINEL} one`,
    at: new Date("2021-07-05T09:00:00Z"),
    tier: 2,
    source: "test",
  });
  await insertJournal({
    entryMd: `${JOURNAL_SENTINEL} two`,
    at: new Date("2021-07-20T09:00:00Z"),
    tier: 2,
    source: "test",
  });
  await insertJournal({
    entryMd: `${JOURNAL_SENTINEL} out of window`,
    at: new Date(OUT_OF_WINDOW),
    tier: 2,
    source: "test",
  });

  const person = await ensurePerson("Restricted Role Timeline Person", "human", "test");
  await insertInteraction({
    personId: person.id,
    kind: "note",
    summary: INTERACTION_SENTINEL,
    occurredAt: new Date("2021-07-12T09:00:00Z"),
    tier: 2,
    source: "test",
  });
});

afterAll(async () => {
  await appHeld?.close();
  appHeld?.unregister();
  if (appRole) await dropTestAppRole(appRole);
});

describe("minime_timeline locked count under real RLS (restricted minime_app-shaped role)", () => {
  test("a plain count(*) under the restricted role is silently 0 — the trap this fix closes", async () => {
    // Documents the exact bug empirically, the same way the review finding verified it: RLS's
    // own tier_read policy (tier <= app_allowed_tier() = 1 while locked) intersects with this
    // query's own `tier = 2` and is never satisfiable.
    const rows = await app`
      select count(*)::int as n from journal_entries
      where tier = 2
        and (at at time zone 'UTC')::date between ${FROM}::date and ${TO}::date
        and superseded_at is null`;
    expect(Number(rows[0]!.n)).toBe(0);
  });

  test("timeline_locked_count() returns the real ranged count despite RLS", async () => {
    const journalRows = await app`
      select timeline_locked_count('journal', ${FROM}, ${TO}, 'UTC') as n`;
    expect(Number(journalRows[0]!.n)).toBe(2); // the third journal row is out of window

    const interactionRows = await app`
      select timeline_locked_count('interaction', ${FROM}, ${TO}, 'UTC') as n`;
    expect(Number(interactionRows[0]!.n)).toBe(1);

    // Never discloses content — only ever a bare integer.
    expect(JSON.stringify(journalRows)).not.toContain(JOURNAL_SENTINEL);
  });

  test("timeline_locked_count() rejects an unrecognized source and an invalid time zone", async () => {
    await expectSqlReject(
      app`select timeline_locked_count('bogus', ${FROM}, ${TO}, 'UTC')`,
      /UNKNOWN_TIMELINE_LOCKED_SOURCE/,
    );
    await expectSqlReject(
      app`select timeline_locked_count('journal', ${FROM}, ${TO}, 'not/a-zone')`,
      /INVALID_TIME_ZONE/,
    );
  });

  test("timeline_locked_count() is minime_app-only: public and the engineering role cannot call it", async () => {
    const [privileges] = await testSql`
      select
        has_function_privilege('public', 'public.timeline_locked_count(text,date,date,text)', 'EXECUTE') as public_execute,
        has_function_privilege('minime_engineer_ro', 'public.timeline_locked_count(text,date,date,text)', 'EXECUTE') as engineer_execute,
        has_function_privilege(${appRole.roleName}, 'public.timeline_locked_count(text,date,date,text)', 'EXECUTE') as app_execute`;
    expect(privileges).toEqual({
      public_execute: false,
      engineer_execute: false,
      app_execute: true,
    });

    const [posture] = await testSql`
      select prosecdef as security_definer, provolatile
      from pg_proc where oid = 'public.timeline_locked_count(text,date,date,text)'::regprocedure`;
    expect(posture).toEqual({ security_definer: true, provolatile: "s" });
  });

  test("minime_timeline (end to end, through the real restricted role) reports the correct locked count while genuinely locked", async () => {
    const result = await readTimelineAsLockedApp(FROM, TO);
    expect(result.ok).toBe(true);
    expect(result.envelope.data.locked).toEqual({ journal: 2, interaction: 1 });
    expect(result.envelope.data.rows.map((r: any) => r.title)).toEqual([
      "Restricted role timeline calendar",
    ]);
    expect(result.envelope.gaps).toEqual([
      "3 tier-2 entries in range are locked (2 journal, 1 interaction) — an owner-approved unlock (minime_unlock) would include them",
    ]);
    // Content never leaks alongside the count, whichever way this test fails.
    const dump = JSON.stringify(result);
    expect(dump).not.toContain(JOURNAL_SENTINEL);
    expect(dump).not.toContain(INTERACTION_SENTINEL);
  });
});
