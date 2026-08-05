// W4 role separation (improve-w4-roles.md). Probes run through a second postgres.js pool
// connected as minime_engineer_ro against the same minime_test database.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import {
  __safeRepairSummaryForTest,
  __setAfterPreImageRegisterForTest,
  __setRepairModuleForTest,
  runRepair,
} from "../scripts/repair";
import { config } from "../src/util/config";
import { expectSqlReject, resetDb, testSql } from "./helpers";
import { registerTestDatabaseCloser } from "./setup";
import { type TestAppRoleLease, dropTestAppRole, mintTestAppRole } from "./support/app-role";

const roUrl = config.databaseUrl.replace(/\/\/[^@]+@/, "//minime_engineer_ro:minime@");
let ro: ReturnType<typeof postgres>;
let app: ReturnType<typeof postgres>;
let appRole: TestAppRoleLease;
let roClosePromise: Promise<void> | undefined;
let unregisterRo: (() => void) | undefined;

function fixedCleanupError(): Error {
  return new Error("test_database_cleanup_failed");
}

function closeRoOnce(): Promise<void> {
  if (!roClosePromise) {
    const pool = ro;
    roClosePromise = Promise.resolve()
      .then(() => {
        return pool.end({ timeout: 5 });
      })
      .catch(() => {
        throw fixedCleanupError();
      });
  }
  return roClosePromise;
}

function openRoPool(): void {
  ro = postgres(roUrl, { max: 1, onnotice: () => {} });
  roClosePromise = undefined;
  unregisterRo = registerTestDatabaseCloser(closeRoOnce);
}

beforeAll(async () => {
  await resetDb();
  openRoPool();
  appRole = await mintTestAppRole(config.databaseUrl);
  app = postgres(appRole.databaseUrl, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  if (!roClosePromise && !unregisterRo) return;
  try {
    await closeRoOnce();
    unregisterRo?.();
    unregisterRo = undefined;
    await app?.end({ timeout: 5 });
    await dropTestAppRole(appRole);
  } catch {
    throw fixedCleanupError();
  }
});

describe("minime_engineer_ro", () => {
  test("can SELECT tier-1 content", async () => {
    await testSql`insert into tasks (title, tier) values ('visible task', 1)`;
    const rows = await ro`select title from tasks`;
    expect(rows.map((r) => r.title)).toContain("visible task");
  });

  test("RLS hides tier-2 content without an unlock (engineering sessions are agent sessions)", async () => {
    await testSql`insert into journal_entries (entry_md, tier) values ('secret diary', 2)`;
    const rows = await ro`select entry_md from journal_entries`;
    expect(rows.length).toBe(0);
  });

  // Highest-value probe in the file: chunk text is where tier-2 content actually lives
  // (chunks feed search/context assembly). Proves RLS does real tier filtering here, not
  // just a blanket allow/deny.
  test("RLS scopes chunks by tier (chunk text is where tier-2 content actually lives)", async () => {
    await testSql`insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('journal', gen_random_uuid(), 0, 'visible chunk', 1)`;
    await testSql`insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('journal', gen_random_uuid(), 0, 'secret chunk', 2)`;
    const rows = await ro`select text from chunks`;
    expect(rows.map((r) => r.text)).toContain("visible chunk");
    expect(rows.map((r) => r.text)).not.toContain("secret chunk");
  });

  test("shared agent policies hide tier-zero generic prose from both app and engineering roles", async () => {
    await testSql`
      insert into pages (path, title, body_md, content_hash, tier)
      values
        ('roles/tier-zero.md', 'tier zero', 'TIER0-ROLE-SENTINEL', 'tier-zero-role', 0),
        ('roles/tier-one.md', 'tier one', 'TIER1-ROLE-SENTINEL', 'tier-one-role', 1)`;
    await testSql`
      insert into chunks (parent_type, parent_id, ord, text, tier)
      select 'page', id, 0, body_md, tier from pages
      where path in ('roles/tier-zero.md', 'roles/tier-one.md')`;

    const engineerPages = await ro`
      select body_md from pages where path like 'roles/tier-%' order by path`;
    const engineerChunks = await ro`
      select text from chunks where text like 'TIER%-ROLE-SENTINEL' order by text`;
    expect(engineerPages.map((row) => row.body_md)).toEqual(["TIER1-ROLE-SENTINEL"]);
    expect(engineerChunks.map((row) => row.text)).toEqual(["TIER1-ROLE-SENTINEL"]);

    const appRows = await app`
      select body_md from pages where path like 'roles/tier-%' order by path`;
    expect(appRows.map((row) => row.body_md)).toEqual(["TIER1-ROLE-SENTINEL"]);
  });

  test("tier-0 tables are not selectable at all (I3)", async () => {
    await expectSqlReject(ro`select * from transactions`, /permission denied/);
    await expectSqlReject(ro`select * from health_samples`, /permission denied/);
  });

  test("every write verb is denied: INSERT / UPDATE / DELETE / TRUNCATE", async () => {
    await expectSqlReject(ro`insert into tasks (title) values ('nope')`, /permission denied/);
    await expectSqlReject(ro`update tasks set title = 'nope'`, /permission denied/);
    await expectSqlReject(ro`delete from tasks`, /permission denied/);
    await expectSqlReject(ro`truncate tasks`, /permission denied/);
    await expectSqlReject(
      ro`insert into events (actor, verb) values ('x', 'y')`,
      /permission denied/,
    );
  });

  test("future tables are covered by default privileges (SELECT only)", async () => {
    await testSql`create table zz_probe (id int, tier smallint not null default 1)`;
    try {
      await testSql`insert into zz_probe (id) values (1)`;
      const rows = await ro`select id from zz_probe`;
      expect(rows.length).toBe(1);
      await expectSqlReject(ro`insert into zz_probe (id) values (2)`, /permission denied/);
    } finally {
      await testSql`drop table zz_probe`;
    }
  });

  // Guard against the exact gap found while building 018: Postgres RLS policy TO-lists are
  // role-scoped, so `grant select` alone is NOT sufficient for a role that isn't named in an
  // applicable policy — it silently gets zero rows at every tier, not just tier-2 (verified
  // against a live instance before writing the fix). If a future migration adds a tier_read
  // policy "to minime_app" on a new table and forgets to also extend it to
  // minime_engineer_ro, this test fails immediately instead of quietly over-hiding tier-1
  // content from engineering sessions.
  test("every tier_read policy scoped to minime_app also covers minime_engineer_ro", async () => {
    const gaps = await testSql`
      select tablename from pg_policies
      where schemaname = 'public' and policyname = 'tier_read'
        and 'minime_app' = any(roles) and not ('minime_engineer_ro' = any(roles))`;
    expect(gaps.map((g) => g.tablename)).toEqual([]);
  });

  test("tier_read lower bounds preserve the exact shared roles and tier-zero table revokes", async () => {
    const expectedTables = [
      "calendar_events",
      "chunks",
      "commitments",
      "decision_branches",
      "decision_transcripts",
      "decisions",
      "edges",
      "email_meta",
      "goals",
      "inbox_items",
      "interactions",
      "journal_entries",
      "orgs",
      "pages",
      "people",
      "principles",
      "tasks",
      "values_items",
    ];
    const policies = await testSql`
      select tablename, roles, qual
      from pg_policies
      where schemaname = 'public' and policyname = 'tier_read'
      order by tablename`;
    expect(policies.map((row) => row.tablename)).toEqual(expectedTables);
    for (const policy of policies) {
      expect([...policy.roles].sort()).toEqual(["minime_app", "minime_engineer_ro"]);
      expect(policy.qual.replaceAll(/[()]/g, "")).toContain("tier >= 1");
      expect(policy.qual.replaceAll(/[()]/g, "")).toContain("tier <= app_allowed_tier");
    }
    const engineerPrivileges = await testSql`
      select table_name, privilege_type
      from information_schema.role_table_grants
      where grantee = 'minime_engineer_ro'
        and table_name in ('pages', 'transactions', 'health_samples')
      order by table_name, privilege_type`;
    expect(
      engineerPrivileges.map((row) => ({
        table_name: row.table_name,
        privilege_type: row.privilege_type,
      })),
    ).toEqual([{ table_name: "pages", privilege_type: "SELECT" }]);
  });
});

describe("repair runner", () => {
  let dumpScratch: string;
  let dumpDir: string;

  beforeAll(() => {
    dumpScratch = realpathSync(mkdtempSync(join(tmpdir(), "minime-m15-repairs-")));
    dumpDir = join(dumpScratch, "db-dump");
  });
  afterAll(() => {
    rmSync(dumpScratch, { recursive: true, force: true });
  });

  test("refuses an unknown/uncommitted script name", async () => {
    expect(await runRepair("no-such-repair", [], { dumpDir })).toBe(1);
  });

  test("repair module override is reset after every exit", async () => {
    __setRepairModuleForTest({
      name: "fixture",
      description: "fixture",
      run: async () => ({ counts: {}, ids: [] }),
    });
    expect(await runRepair("no-such-repair", [], { dumpDir })).toBe(1);
    // A subsequent committed run must import the real module rather than retaining the seam.
    expect(await runRepair("retype-org-to-person", [], { dumpDir })).toBe(1);
  });

  test.each([Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "legacy repair summary rejects invalid edge count %p",
    (count) => {
      expect(
        __safeRepairSummaryForTest({ person_id: "person", edges_repointed: count }),
      ).toBeUndefined();
    },
  );

  test("repair revalidates the private root after pre-image registration", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-m15-revalidate-")));
    const privateRoot = join(root, "db-dump");
    __setAfterPreImageRegisterForTest(() => chmodSync(privateRoot, 0o755));
    try {
      expect(await runRepair("retype-org-to-person", [], { dumpDir: privateRoot })).toBe(1);
    } finally {
      __setAfterPreImageRegisterForTest(undefined);
      chmodSync(privateRoot, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a committed script whose working-tree file differs from HEAD", async () => {
    const path = `${process.cwd()}/scripts/repairs/retype-org-to-person.ts`;
    const saved = readFileSync(path); // restored via fs below, never via git commands
    const [prev] = await testSql`select coalesce(max(id), 0)::int as max_id from events`;
    try {
      writeFileSync(path, Buffer.concat([saved, Buffer.from("\n// dirty")]));
      expect(await runRepair("retype-org-to-person", [], { dumpDir })).toBe(1);
      const events = await testSql`
        select id from events where verb like 'repair:%' and id > ${prev!.max_id}`;
      expect(events.length).toBe(1);
    } finally {
      writeFileSync(path, saved);
    }
    expect(readFileSync(path).equals(saved)).toBe(true); // original bytes back in place
  });

  test("refuses when the backup cannot be written (no backup ⇒ no repair)", async () => {
    if (!Bun.which("pg_dump")) return; // environment without client tools
    const orgId = (
      await testSql`insert into orgs (canonical_name, tier) values ('Retypable Ltd', 1) returning id`
    )[0]!.id;
    const code = await runRepair("retype-org-to-person", [`--org-id=${orgId}`], {
      dumpDir: "/nonexistent-dir/deny",
    });
    expect(code).toBe(1);
    const [org] = await testSql`select retired_at from orgs where id = ${orgId}`;
    expect(org!.retired_at).toBeNull(); // nothing ran
  });

  test("happy path: backup taken, repair applied, repair:* events logged, payload ids/counts only", async () => {
    if (!Bun.which("pg_dump")) return; // environment without client tools
    const orgId = (
      await testSql`insert into orgs (canonical_name, tier) values ('Quill Marbury', 1) returning id`
    )[0]!.id;
    const [prev] = await testSql`select coalesce(max(id), 0)::int as max_id from events`;
    const code = await runRepair(
      "retype-org-to-person",
      [`--org-id=${orgId}`, "--relation=friend"],
      { dumpDir },
    );
    expect(code).toBe(0);
    const [org] = await testSql`select retired_at from orgs where id = ${orgId}`;
    expect(org!.retired_at).not.toBeNull(); // retired, not deleted (reversible-repair contract)
    const [person] = await testSql`select id from people where canonical_name = 'Quill Marbury'`;
    expect(person).toBeTruthy();
    const events = await testSql`select verb, payload from events
      where verb like 'repair:%' and id > ${prev!.max_id} order by id`;
    expect(events.map((e) => e.verb)).toEqual(["repair:retype-org-to-person"]);
    expect(events[0]!.payload).toMatchObject({ phase: "complete", code: "repair_complete" });
    expect(events[0]!.payload).not.toHaveProperty("backup");
    expect(JSON.stringify(events)).not.toContain("Quill Marbury"); // counts/ids only, never contents
    const backups = [...new Bun.Glob("repair-retype-org-to-person-*.sql").scanSync(dumpDir)];
    expect(backups.length).toBeGreaterThan(0);
  });

  test("failure path: backup precedes run, failed event content-free, exit 1", async () => {
    if (!Bun.which("pg_dump")) return; // environment without client tools
    const fakeId = crypto.randomUUID(); // well-formed, matches no org
    // events accumulate across this file — scope to this invocation via the identity pk
    const [prev] = await testSql`select coalesce(max(id), 0)::int as max_id from events`;
    const glob = new Bun.Glob("repair-retype-org-to-person-*.sql");
    const backupsBefore = [...glob.scanSync(dumpDir)].length;
    const code = await runRepair("retype-org-to-person", [`--org-id=${fakeId}`], { dumpDir });
    expect(code).toBe(1); // repair threw AFTER the backup gate — not a refusal (2)
    const events = await testSql`select verb, payload from events
      where verb like 'repair:%' and id > ${prev!.max_id} order by id`;
    expect(events.length).toBe(1);
    expect(events[0]!.payload.phase).toBe("failed");
    const dump = JSON.stringify(events);
    expect(dump).not.toContain(fakeId);
    expect(dump).not.toContain("Quill Marbury"); // …never row contents
    expect(dump).not.toContain("Retypable");
    const backupsAfter = [...glob.scanSync(dumpDir)].length;
    expect(backupsAfter).toBe(backupsBefore + 1); // backup precedes run by design
  });

  test.each(["symlink", "directory", "regular"] as const)(
    "repair rejects a post-pg_dump %s pre-image replacement and retains it",
    async (replacement) => {
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), `minime-m15-replacement-${replacement}-`)),
      );
      const privateRoot = join(root, "db-dump");
      const foreign = join(root, "foreign-target.sql");
      mkdirSync(privateRoot, { mode: 0o700 });
      writeFileSync(foreign, "-- foreign target --\n", { mode: 0o600 });
      const fakeBin = join(root, "bin");
      mkdirSync(fakeBin, { mode: 0o700 });
      const fakePgDump = join(fakeBin, "pg_dump");
      writeFileSync(
        fakePgDump,
        `#!/bin/sh
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = -f ]; then out="$2"; shift 2; else shift; fi
done
printf '%s\\n' '-- initial dump --' > "$out"
/bin/rm -f -- "$out"
if [ "${replacement}" = symlink ]; then
  /bin/ln -s "${foreign}" "$out"
elif [ "${replacement}" = directory ]; then
  /bin/mkdir "$out"
else
  printf '%s\\n' '-- replacement dump --' > "$out"
fi
exit 0
`,
        { mode: 0o700 },
      );
      chmodSync(fakePgDump, 0o700);
      const oldPath = process.env.PATH;
      process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;
      __setRepairModuleForTest({
        name: "fixture",
        description: "fixture",
        run: async () => ({ counts: {}, ids: [] }),
      });
      try {
        expect(await runRepair("retype-org-to-person", [], { dumpDir: privateRoot })).toBe(1);
      } finally {
        process.env.PATH = oldPath;
        __setRepairModuleForTest(undefined);
      }
      expect(readFileSync(foreign, "utf8")).toBe("-- foreign target --\n");
      const replacementName = readdirSync(privateRoot).find((name) => name.startsWith("repair-"));
      expect(replacementName).toBeTruthy();
      const replacementStat = lstatSync(join(privateRoot, replacementName!));
      if (replacement === "symlink") expect(replacementStat.isSymbolicLink()).toBe(true);
      if (replacement === "directory") expect(replacementStat.isDirectory()).toBe(true);
      if (replacement === "regular") expect(replacementStat.isFile()).toBe(true);
      rmSync(root, { recursive: true, force: true });
    },
  );
});
