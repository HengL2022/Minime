# W4 — Structural agent/live-data separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or
> superpowers:executing-plans. Parent contract: `improve-2026-07-program.md`. Independent of
> W3/W1 (parallel-safe, wave 1).

**Goal:** Engineering sessions can no longer write the live DB by accident: a SELECT-only
`minime_engineer_ro` login role becomes the default engineering DSN, and every sanctioned live
write goes through (a) MCP tools, (b) `make migrate`, or (c) a new `scripts/repair.ts` runner
that requires a named committed repair script, takes a pre-image backup automatically, and logs
`repair:*` events.

**Architecture:** Role + grants live in migration `018_engineer_role.sql` (precedent: 007 creates
`minime_app` in-migration; `minime` has CREATEROLE). **Two deliberate tightenings vs the
improvement doc** (record in DECISIONS):
1. `minime_engineer_ro` is **not** BYPASSRLS — impossible anyway (BYPASSRLS needs superuser,
   migrations run as `minime`) and undesirable: engineering sessions are *agent* sessions, so RLS
   gives them the same tier-gating as the MCP door (tier ≤ 1 by default, tier 2 during a standing
   `session_unlocks` window). The owner's raw escape hatch remains `psql` as `minime`.
2. **No tier-0 SELECT**: `transactions`/`health_samples` stay revoked (mirrors 007's
   `minime_app` posture) — I3 says tier-0 never enters agent context, and an engineering session
   is agent context. Aggregates via the existing `metric_agg()` EXECUTE grant.

**Tech stack:** existing; `pg_dump` for pre-image backups (already a dependency of
backup/restore tooling).

## Global constraints

- SQL only in `repo.ts`/migrations (`scripts/repair.ts` orchestrates via imports from repo/backup
  modules and `Bun.spawn` of `pg_dump` — it must not carry inline SQL; repair *scripts* call
  existing repo functions like `retypeOrgToPerson`).
- No backup ⇒ no repair: the runner hard-refuses when the pre-image dump fails (this encodes the
  owner's manual discipline from the 2026-06-16 retype cleanup).
- Repair event payloads carry script name/args/backup path/summary **counts** — never row
  contents (tier-0 rule).
- `.env.engineering` is committed and non-secret (the DSN's password posture matches the
  committed `password 'minime'` in `scripts/lib.sh:40` — localhost-only box).

## Files

- Create: `db/migrations/018_engineer_role.sql` (renumber at merge if taken)
- Create: `.env.engineering`, `scripts/repair.ts`, `scripts/repairs/retype-org-to-person.ts`
- Create: `test/m15.roles.test.ts`
- Modify: `.gitignore` (`!.env.engineering`), `.claude/hooks/protect-secrets.sh` +
  `.codex/hooks/protect-secrets.sh` (allow the new file), `Makefile` (`psql-ro`, `verify-m15`),
  `CLAUDE.md`, `AGENTS.md`, `.claude/agents/invariant-reviewer.md` (checklist item 10)
- Append: `DECISIONS.md`

**Interfaces produced:**

```ts
// scripts/repair.ts
export interface RepairModule {
  name: string;                       // must equal the file basename
  description: string;
  run(args: string[]): Promise<Record<string, number | string>>;  // returns read-back summary
}
export function runRepair(scriptName: string, args: string[], opts?: { dumpDir?: string }): Promise<number>; // exit code
```

---

### Task 1: Migration 018 — role, grants, revokes

- [ ] **Step 1.1: Failing tests** — create `test/m15.roles.test.ts`:

```ts
// W4 role separation (improve-w4-roles.md). Probes run through a second postgres.js pool
// connected as minime_engineer_ro against the same minime_test database.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { expectSqlReject, resetDb, testSql } from "./helpers";
import { config } from "../src/util/config";

const roUrl = config.databaseUrl.replace(/\/\/[^@]+@/, "//minime_engineer_ro:minime@");
let ro: ReturnType<typeof postgres>;

beforeAll(async () => {
  await resetDb();
  ro = postgres(roUrl, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  await ro.end({ timeout: 5 });
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

  test("tier-0 tables are not selectable at all (I3)", async () => {
    await expectSqlReject(ro`select * from transactions`, /permission denied/);
    await expectSqlReject(ro`select * from health_samples`, /permission denied/);
  });

  test("every write verb is denied: INSERT / UPDATE / DELETE / TRUNCATE", async () => {
    await expectSqlReject(ro`insert into tasks (title) values ('nope')`, /permission denied/);
    await expectSqlReject(ro`update tasks set title = 'nope'`, /permission denied/);
    await expectSqlReject(ro`delete from tasks`, /permission denied/);
    await expectSqlReject(ro`truncate tasks`, /permission denied/);
    await expectSqlReject(ro`insert into events (actor, verb) values ('x', 'y')`, /permission denied/);
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
});
```

- [ ] **Step 1.2: Run** — `bun test test/m15.roles.test.ts`
Expected: FAIL — `role "minime_engineer_ro" does not exist`.

- [ ] **Step 1.3: Create `db/migrations/018_engineer_role.sql`**

```sql
-- 018_engineer_role.sql
-- W4 (improve-w4-roles.md): SELECT-only login role for engineering sessions. Deliberately
-- NOT BYPASSRLS (engineering sessions are agent sessions — RLS tier-gates them exactly like
-- the MCP door; the owner's raw path stays `psql` as minime). Tier-0 content tables are
-- revoked outright, mirroring minime_app (I3: tier-0 never enters agent context).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'minime_engineer_ro') then
    create role minime_engineer_ro login password 'minime';   -- localhost box; same posture as scripts/lib.sh
  end if;
end $$;

-- grant connect is per-database; format() so test/scratch DBs applying this migration work too
do $$ begin
  execute format('grant connect on database %I to minime_engineer_ro', current_database());
end $$;

grant usage on schema public to minime_engineer_ro;
grant select on all tables in schema public to minime_engineer_ro;
-- I3: tier-0 content is never agent-readable; aggregates only via metric_agg().
revoke select on transactions, health_samples from minime_engineer_ro;
grant execute on function app_allowed_tier() to minime_engineer_ro;
grant execute on function metric_agg(text, date, date) to minime_engineer_ro;

-- Future tables created by the migration role get SELECT automatically. NOTE for future
-- migrations: a NEW tier-0 table must add its own explicit revoke (checklist in CLAUDE.md).
alter default privileges in schema public grant select on tables to minime_engineer_ro;
```

*(Verify the `metric_agg` signature against `007_rls.sql`/`013_privacy_hardening.sql:93-122`
before committing — match the exact argument list; adjust the `grant execute` line accordingly.)*

- [ ] **Step 1.4: RLS coverage check** — before trusting the tier-2 test, verify which tables have
RLS enabled: `psql minime_test -c "select relname from pg_class where relrowsecurity"` (via a
temporary test assertion or manual run). Required: `journal_entries`, `interactions`, `chunks`,
`email_meta`, `edges` must be in the list (spec §12 + 007/013). **If `chunks` is missing**, add to
018:

```sql
alter table chunks enable row level security;
create policy tier_read on chunks for select using (tier <= app_allowed_tier());
```

(and the m15 test gains: `ro` sees only tier ≤ 1 chunks. If it IS covered, add that same test
assertion anyway — it's the highest-value probe in the file, since chunk text is where tier-2
content actually lives.)

- [ ] **Step 1.5: Run** — m15 suite PASS. Full `bun test` PASS (the new role must not break
existing suites — it is additive).

- [ ] **Step 1.6: Commit** — `git add db/migrations/018_engineer_role.sql test/m15.roles.test.ts && git commit -m "feat(db): minime_engineer_ro SELECT-only role, RLS-gated, no tier-0 (W4)"`

---

### Task 2: `.env.engineering` + hooks + convenience target

- [ ] **Step 2.1: Create `.env.engineering`**

```bash
# Engineering-session DSN (W4): SELECT-only role, RLS tier-gated, no tier-0 access.
# Agents: use this for ANY ad-hoc DB access (`source`-style or `make psql-ro`). Live writes
# go through the MCP tools, `make migrate`, or `bun run scripts/repair.ts <script>` — never
# a raw connection as `minime`. This file is committed and contains no secret (localhost).
DATABASE_URL=postgres://minime_engineer_ro:minime@localhost:5432/minime
```

- [ ] **Step 2.2: `.gitignore`** — the env block currently ignores `.env` / `.env.*` except
`.env.example`; add `!.env.engineering` beside the existing `!.env.example` exception.

- [ ] **Step 2.3: Hooks** — `.claude/hooks/protect-secrets.sh` blocks edits to `.env*` except
`.env.example`; extend the allow-condition to also pass `.env.engineering` (one-line change to
the filename test; add a comment: committed non-secret engineering DSN). Apply the **identical**
edit to `.codex/hooks/protect-secrets.sh` (byte-identical mirror convention).

- [ ] **Step 2.4: Makefile** — add:

```makefile
# Read-only psql for engineering sessions (W4): SELECT-only role, RLS tier-gated.
psql-ro:
	@psql "$$(grep '^DATABASE_URL=' .env.engineering | cut -d= -f2-)"
```

- [ ] **Step 2.5: Verify by hand** — `make psql-ro` connects; `insert` fails with permission
denied. Commit: `git add .env.engineering .gitignore .claude/hooks/protect-secrets.sh .codex/hooks/protect-secrets.sh Makefile && git commit -m "feat(ops): committed engineering DSN + psql-ro + hook allowance (W4)"`

---

### Task 3: Repair runner + first repair script

- [ ] **Step 3.1: Failing tests** (append to m15)

```ts
import { runRepair } from "../scripts/repair";

describe("repair runner", () => {
  const dumpDir = `${process.cwd()}/db-dump/test-repairs`;

  test("refuses an unknown/uncommitted script name", async () => {
    expect(await runRepair("no-such-repair", [], { dumpDir })).toBe(2);
  });

  test("refuses when the backup cannot be written (no backup ⇒ no repair)", async () => {
    const orgId = (await testSql`insert into orgs (canonical_name, tier) values ('Retypable Ltd', 1) returning id`)[0]!.id;
    const code = await runRepair("retype-org-to-person", [`--org-id=${orgId}`],
      { dumpDir: "/nonexistent-dir/deny" });
    expect(code).toBe(2);
    const [org] = await testSql`select retired_at from orgs where id = ${orgId}`;
    expect(org!.retired_at).toBeNull();               // nothing ran
  });

  test("happy path: backup taken, repair applied, repair:* events logged, summary counts only", async () => {
    if (!Bun.which("pg_dump")) return;                 // environment without client tools
    const orgId = (await testSql`insert into orgs (canonical_name, tier) values ('Quill Marbury', 1) returning id`)[0]!.id;
    const code = await runRepair("retype-org-to-person", [`--org-id=${orgId}`, "--relation=friend"], { dumpDir });
    expect(code).toBe(0);
    const [org] = await testSql`select retired_at from orgs where id = ${orgId}`;
    expect(org!.retired_at).not.toBeNull();            // retired, not deleted (reversible-repair contract)
    const [person] = await testSql`select id from people where canonical_name = 'Quill Marbury'`;
    expect(person).toBeTruthy();
    const events = await testSql`select verb, payload from events where verb like 'repair:%' order by id`;
    expect(events.map((e) => e.verb)).toEqual(["repair:retype-org-to-person", "repair:retype-org-to-person"]);
    expect(events[0]!.payload.backup).toContain("repair-retype-org-to-person");
    expect(JSON.stringify(events)).not.toContain("Quill Marbury"); // counts/ids only, never contents
    const backups = [...new Bun.Glob("repair-retype-org-to-person-*.sql").scanSync(dumpDir)];
    expect(backups.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3.2: Run** — FAIL: `scripts/repair.ts` missing.

- [ ] **Step 3.3: Create `scripts/repairs/retype-org-to-person.ts`**

```ts
// Sanctioned repair: org mistyped as… actually a person (or vice-versa cleanup entry point).
// Wraps repo.retypeOrgToPerson — reversible by design (org is retired, never deleted).
import { retypeOrgToPerson } from "../../src/db/repo";
import type { RepairModule } from "../repair";

function argOf(args: string[], key: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${key}=`));
  return hit?.slice(key.length + 3);
}

const mod: RepairModule = {
  name: "retype-org-to-person",
  description: "Retype a mistyped org row into a person: repoint edges, retire the org (reversible).",
  async run(args) {
    const orgId = argOf(args, "org-id");
    if (!orgId) throw new Error("usage: --org-id=<uuid> [--relation=<r>] [--reason=<text>]");
    const res = await retypeOrgToPerson(orgId, {
      relation: argOf(args, "relation") ?? null,
      reason: argOf(args, "reason") ?? "repair:retype-org-to-person",
    });
    // read-back verification is the summary: counts and ids only
    return { person_id: res.personId, org_id: res.orgId, created: String(res.created),
      edges_repointed: res.edgesRepointed };
  },
};
export default mod;
```

- [ ] **Step 3.4: Create `scripts/repair.ts`**

```ts
// W4 repair runner (improve-w4-roles.md): the ONLY sanctioned ad-hoc write path to the live
// DB besides MCP tools and `make migrate`. Contract: named COMMITTED repair script → automatic
// pre-image pg_dump (no backup ⇒ no repair) → run as the owner role → repair:* audit events
// with counts only. Formalizes the manual backup→fix→read-back discipline from DECISIONS.md
// 2026-06-16.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { logEvent } from "../src/db/repo";
import { config } from "../src/util/config";

export interface RepairModule {
  name: string;
  description: string;
  run(args: string[]): Promise<Record<string, number | string>>;
}

async function committed(scriptName: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "ls-files", `scripts/repairs/${scriptName}.ts`], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  return out.trim().length > 0;
}

async function preImageDump(scriptName: string, dumpDir: string): Promise<string | null> {
  await mkdir(dumpDir, { recursive: true }).catch(() => {});
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dumpDir, `repair-${scriptName}-${ts}.sql`);
  const proc = Bun.spawn(["pg_dump", "--no-owner", "-f", file, config.databaseUrl], { stderr: "pipe" });
  if ((await proc.exited) !== 0) return null;
  const size = (await Bun.file(file).exists()) ? Bun.file(file).size : 0;
  return size > 0 ? file : null;
}

export async function runRepair(scriptName: string, args: string[],
  opts: { dumpDir?: string } = {}): Promise<number> {
  if (!/^[a-z0-9-]+$/.test(scriptName)) { console.error("invalid repair name"); return 2; }
  if (!(await committed(scriptName))) {
    console.error(`refusing: scripts/repairs/${scriptName}.ts is not a committed repair script`);
    return 2;
  }
  const mod = (await import(`./repairs/${scriptName}.ts`)).default as RepairModule;
  if (mod.name !== scriptName) { console.error("repair module name mismatch"); return 2; }
  const backup = await preImageDump(scriptName, opts.dumpDir ?? join(process.cwd(), "db-dump"));
  if (!backup) { console.error("refusing: pre-image backup failed (no backup ⇒ no repair)"); return 2; }
  await logEvent({ actor: "system:repair", verb: `repair:${scriptName}`,
    payload: { phase: "start", args_count: args.length, backup } });
  try {
    const summary = await mod.run(args);
    await logEvent({ actor: "system:repair", verb: `repair:${scriptName}`,
      payload: { phase: "done", backup, ...summary } });
    console.log(`repair ${scriptName} done — backup: ${backup}`);
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  } catch (e) {
    await logEvent({ actor: "system:repair", verb: `repair:${scriptName}`,
      payload: { phase: "failed", backup, error: e instanceof Error ? e.message : String(e) } });
    console.error(`repair failed (pre-image backup at ${backup}): ${e instanceof Error ? e.message : e}`);
    return 1;
  }
}

if (import.meta.main) {
  const [name, ...args] = process.argv.slice(2);
  if (!name) { console.error("usage: bun run scripts/repair.ts <script> [--k=v ...]"); process.exit(2); }
  process.exit(await runRepair(name, args));
}
```

*(Summary values must stay counts/ids — the runner trusts repair modules on this; the m15 test
and invariant-reviewer enforce it. `Quill Marbury` appearing in an event payload fails the test.)*

Note: the happy-path test asserts `person_id`/ids in payload are fine but names are not — the
`retype-org-to-person` summary returns ids only, satisfying this.

- [ ] **Step 3.5: Run** — m15 suite PASS (pg_dump-dependent test auto-skips where absent).
`bunx tsc --noEmit` clean.

- [ ] **Step 3.6: Commit** — `git add scripts/repair.ts scripts/repairs/ test/m15.roles.test.ts && git commit -m "feat(ops): committed-script repair runner with mandatory pre-image backup (W4)"`

---

### Task 4: Guardrail docs + verify target + DECISIONS

- [ ] **Step 4.1: CLAUDE.md** — add under "Code conventions":

```markdown
- **Engineering sessions never write the live DB directly.** Ad-hoc DB access uses the
  SELECT-only DSN in `.env.engineering` (`make psql-ro`). Live writes go through the MCP
  tools, `make migrate`, or `bun run scripts/repair.ts <committed-script>` (auto pre-image
  backup + `repair:*` audit). New tier-0 tables must add an explicit
  `revoke select ... from minime_engineer_ro` in their migration.
```

- [ ] **Step 4.2: AGENTS.md** — add a short "Engineering access (W4)" section after the MCP
registration section documenting the role, `psql-ro`, and the repair-runner contract (3 sanctioned
write paths; no-backup-no-repair).

- [ ] **Step 4.3: invariant-reviewer** — append checklist item to
`.claude/agents/invariant-reviewer.md`:

```markdown
10. **Engineering write path (W4)**: no code/scripts/docs introduce a raw full-rights DB
    connection for engineering use; ad-hoc writes appear only as committed repair scripts
    under `scripts/repairs/` run via `scripts/repair.ts`; repair event payloads carry counts
    and ids, never row contents.
```

- [ ] **Step 4.4: Makefile** — `verify-m15` target (`@$(BUN) test test/m15.*.test.ts`), chain into
`verify`, `.PHONY`.

- [ ] **Step 4.5: Full gates** — `bun test`, `tsc`, `biome`, `make verify`, `make eval-search` all
green (this workstream cannot move retrieval numbers; the gate is a tripwire).

- [ ] **Step 4.6: DECISIONS.md entry**

```markdown
## 2026-07-XX — W4: engineer read-only role + committed-script repair runner

- **Context:** The eval-runner incident got a structural guard for benchmark runners, but
  engineering sessions still connected as the full-rights owner role. Manual remediations
  (retype cleanup, edge deletes) relied on discipline, not structure.
- **Decision:** Migration 018 creates SELECT-only login role minime_engineer_ro; committed
  .env.engineering is the engineering DSN (make psql-ro). Tightened vs the proposal: the
  role is NOT BYPASSRLS (engineering sessions are agent sessions — RLS tier-gates them like
  the MCP door) and tier-0 tables stay revoked per I3; the owner's raw path remains psql as
  minime. Writes during engineering: MCP tools, make migrate, or scripts/repair.ts — which
  requires a committed scripts/repairs/<name>.ts, takes a mandatory pre-image pg_dump
  (no backup ⇒ no repair), and logs repair:* events (counts only). First repair script wraps
  retypeOrgToPerson, giving the dormant sanctioned-repair library its audited entry point.
- **Why:** "Agents were careful" becomes "agents could not have done otherwise" — the
  eval-guard philosophy extended to the highest-blast-radius surface.
- **Approved by:** human (owner, 2026-07-18 improvement plan §5).
```

- [ ] **Step 4.7: Commit + review** — `git add CLAUDE.md AGENTS.md .claude/agents/invariant-reviewer.md Makefile DECISIONS.md && git commit -m "chore(guardrails): engineering-access rules, verify-m15, W4 decision"` — Sonnet first-pass, then invariant-reviewer.

## Acceptance gates (workstream-level)

1. `verify-m15` green: every write verb denied for the engineer role; tier-2 hidden without
   unlock; tier-0 not selectable; future-table SELECT coverage proven.
2. Repair runner: refuses uncommitted scripts and unwritable backup destinations; happy path
   leaves a pre-image dump + two `repair:*` events with counts only.
3. `make verify` + `make eval-search` green; invariant-reviewer PASS.
4. CLAUDE.md/AGENTS.md/invariant-reviewer updated (the guardrail is doc + role + runner together).
