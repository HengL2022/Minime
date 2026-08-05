# S0 Pipeline Baseline Implementation Plan

> For agentic workers: use the subagent-driven-development or executing-plans skill. Steps use checkbox syntax.

Goal: establish one green, offline, isolated, non-mutating local/CI acceptance gate before privacy or runtime changes.

Architecture: repair the M14 transport seam, plan and own a guarded PostgreSQL database for each process, bootstrap explicit migration contexts before the first post-S0 migration, prove the already-parsed updater transition with a minimal behavioral harness, and make one unscoped full suite plus lint, typecheck, subsystem check, and retrieval eval the authoritative pipeline.

Tech Stack: Bun test preload, PostgreSQL scratch databases, TypeScript 5.9.3, Biome, Make, and the existing provider FetchFn seam.

## Global Constraints

- Every Bun test process, offline-M0 process, and database-reset eval process connects only to a loopback database matching ^minime_test_[a-z0-9_]+$.
- The pre-isolation Task 1 focused exception may use the existing supported unique
  minime_h4_disposition_* bootstrap cloned from the constant minime_test template exactly as
  specified; it may never use shared minime_test,
  live minime, legacy minime_eval*, or a non-loopback host.
- Shared minime_test, live minime, and legacy minime_eval* are never automated test, offline-M0, or database-reset eval targets. No test or database-reset eval may fall back to a shared database. Non-destructive owner-run evals are outside this S0 reset-ownership conversion and must remain non-destructive.
- minime_test is a constant installer/CI provisioning template only. Automated tests, offline
  M0, and eval children never connect to it. Generated databases are cloned server-side from
  that constant under the minime role's CREATEDB privilege and then checked for vector and
  pgcrypto; callers cannot select a template and runtime provisioning never creates extensions
  or requires superuser.
- No provisioner terminates, disconnects, alters, migrates, or drops minime_test. A source
  connection makes cloning fail closed with test_database_template_busy. Compliant concurrent
  clone attempts serialize on one module-private session advisory lock; the lock is released
  by closing the reserved admin connection.
- Ollama/model/provider traffic is injected or mocked; external sockets are forbidden.
- MigrationContext has only install, direct, test, restore, and bounded update; an eval context does not exist. Eval and offline-M0 children use API-only migrate({ kind: "test" }).
- Context and database-name validation precede the first socket, ledger creation, migration read, or future lease.
- The module-private ownership brand and WeakMap in test/support/test-database.ts remain the only authority for terminating or dropping an owned scratch database.
- A parent may hand its owned URL to one child process. The parent retains the branded handle, waits for the child, then disposes through that handle; the child never creates, adopts, terminates, or drops the database.
- verify-m0 remains a standalone live-capable owner environment probe. verify-m0-offline is separately named, wrapper-owned, mocked, and is the only M0 form used by verify-offline and CI.
- Before Task 4 completes, no unscoped suite or milestone target may run. Static checks and the explicitly guarded Task 1 focused suite are the only pre-isolation execution evidence.
- No tracked db/migrations/021_*.sql may exist anywhere in S0. The updater transition test creates a transactional no-op 021 only inside its temporary two-commit repository.
- lint is non-mutating; formatting is a separate explicit command. Existing focused milestone targets remain available, but the unscoped suite is the authoritative test prerequisite.
- Only Task 7 may modify package.json or bun.lock, solely for exact typescript@5.9.3.
- The migration-context refusal and safe updater rerun protocol must merge before S1 adds db/migrations/021_*.sql.
- No other product behavior, migration, dependency, provider, search weight, privacy rule, or
  runtime topology is amended by S0.

---

### Task 1: Repair the M14 offline transport seam

Files:
- Modify: src/pipeline/validate-edges.ts
- Modify: test/m14.extract-validate.test.ts

Interfaces:

~~~ts
import type { FetchFn } from "../llm/types";

export interface ValidateEdgesOptions {
  fetchFn?: FetchFn;
}

export interface ValidateEdgesStats {
  checked: number;
  confirmed: number;
  denied: number;
  unsure: number;
  flagged: number;
  byRule: Record<string, { checked: number; denied: number }>;
}

export async function validateEdges(
  budget?: number,
  options?: ValidateEdgesOptions,
): Promise<ValidateEdgesStats>;
~~~

Retain the default budget 200, passed unchanged to edgesForValidation(RECENT_HOURS, budget). It is a candidate-row limit: ceiling-skipped or provider-failed candidates consume a selected slot without incrementing checked, and the batch is not refilled. modelVerdict receives options.fetchFn and calls classifyProviderForTier(tier, options.fetchFn).

Stats semantics remain binding: checked counts ledger writes and equals confirmed + denied + unsure; denied includes explicit deny or non-unsure entity-type mismatch; flagged counts only newly deduplicated review items and also includes a second unsure; byRule retains only checked and denied under rel@confidence.

Caller contracts remain unchanged:
- src/pipeline/dream.ts calls validateEdges() and stores complete stats under 3c_validate_edges.
- scripts/eval-graph-hygiene.ts reads all five counters and byRule.
- test/m14.extract-validate.test.ts keeps seven no-argument calls plus validateEdges(1).
Only the provider-routing regression injects a local canned FetchFn. Production, live evaluator, dream tests, and deterministic mocks continue to omit it. rg -n 'validateEdges\(' src scripts test must show no unreviewed caller.

- [ ] Step 1: Write the failing regression. Set the provider-routing fixture to OLLAMA_URL=http://127.0.0.1:9, route tier 2 to Ollama, call validateEdges(200, { fetchFn: cannedOllamaFetch }), and assert:
~~~ts
expect(result).toEqual({
  checked: 1,
  confirmed: 0,
  denied: 1,
  unsure: 0,
  flagged: 1,
  byRule: { "mentions@0.8": { checked: 1, denied: 1 } },
});
expect(globalThis.fetch).toBe(originalFetch);
expect(cloudCalls).toEqual([]);
~~~
Save and restore config.ollamaUrl alongside the other patched fields.

- [ ] Step 2: Prove RED using a guarded bootstrap. The setup, expected RED, and cleanup statuses are distinct; a setup or drop failure is BLOCKED and never reported as a test result.
~~~bash
set +e
S0_TASK1_DB="minime_h4_disposition_s0_task1_red_$$"
S0_TASK1_ADMIN_URL="postgres://minime:minime@127.0.0.1:${MINIME_PG_PORT:-5432}/postgres"
S0_TASK1_URL="postgres://minime:minime@127.0.0.1:${MINIME_PG_PORT:-5432}/${S0_TASK1_DB}"
case "$S0_TASK1_ADMIN_URL:$S0_TASK1_URL" in *'$'*|*'{'*) echo "BLOCKED: URL expansion sanity failed" >&2; exit 125;; esac
case "$S0_TASK1_ADMIN_URL" in postgres://minime:minime@127.0.0.1:*'/postgres') ;; *) echo "BLOCKED: admin URL sanity failed" >&2; exit 125;; esac
S0_TASK1_ACTIVE=0
s0_task1_cleanup() {
  if [ "$S0_TASK1_ACTIVE" -eq 1 ]; then
    dropdb --if-exists --maintenance-db="$S0_TASK1_ADMIN_URL" "$S0_TASK1_DB"
    S0_TASK1_DROP_STATUS=$?
    S0_TASK1_ACTIVE=0
    if [ "$S0_TASK1_DROP_STATUS" -ne 0 ]; then
      echo "BLOCKED: Task 1 RED database drop failed" >&2
      return 125
    fi
    echo "Task 1 RED database drop succeeded"
  fi
  return 0
}
trap 'S0_TASK1_EXIT=$?; if ! s0_task1_cleanup; then exit 125; fi; exit "$S0_TASK1_EXIT"' EXIT INT TERM
S0_TASK1_TEMPLATE_CONNECTIONS="$(
  psql "$S0_TASK1_ADMIN_URL" -X -qAt -v ON_ERROR_STOP=1 \
    -c "select count(*)::int from pg_stat_activity where datname = 'minime_test'"
)"
if [ "$?" -ne 0 ]; then
  echo "BLOCKED: Task 1 RED template preflight failed" >&2
  exit 125
fi
if [ "$S0_TASK1_TEMPLATE_CONNECTIONS" != "0" ]; then
  echo "BLOCKED: Task 1 RED template is busy" >&2
  exit 125
fi
createdb --maintenance-db="$S0_TASK1_ADMIN_URL" \
  --owner=minime --template=minime_test "$S0_TASK1_DB"
if [ "$?" -ne 0 ]; then
  echo "BLOCKED: Task 1 RED template clone failed" >&2
  exit 125
fi
S0_TASK1_ACTIVE=1
S0_TASK1_EXTENSION_COUNT="$(
  psql "$S0_TASK1_URL" -X -qAt -v ON_ERROR_STOP=1 \
    -c "select count(*)::int from pg_extension where extname in ('vector', 'pgcrypto')"
)"
if [ "$?" -ne 0 ] || [ "$S0_TASK1_EXTENSION_COUNT" != "2" ]; then
  echo "BLOCKED: Task 1 RED extension assertion failed" >&2
  exit 125
fi
MINIME_SCRATCH_TEST_DATABASE_URL="$S0_TASK1_URL" OLLAMA_URL=http://127.0.0.1:9 \
  bun test test/m14.extract-validate.test.ts --test-name-pattern "tier-2 edge"
S0_TASK1_STATUS=$?
if [ "$S0_TASK1_STATUS" -eq 0 ] || [ "$S0_TASK1_STATUS" -eq 125 ]; then
  echo "BLOCKED: expected RED was not a nonzero test result" >&2
  exit 125
fi
exit "$S0_TASK1_STATUS"
~~~
The expected RED is nonzero because checked is 0 before transport injection. The EXIT/signal trap must report a successful drop; setup or drop failure exits 125 (BLOCKED), never the expected test status.

- [ ] Step 3: Thread the explicit transport through the validator. Keep validateEdges(1) unchanged, default options to {}, pass only options.fetchFn into modelVerdict, return the complete stats object, and do not restore ambient-fetch behavior or increase timeout.

- [ ] Step 4: Run GREEN and neighboring suites in a separately created, fully initialized database. Do not reuse the RED database.
~~~bash
set +e
S0_TASK1_DB="minime_h4_disposition_s0_task1_green_$$"
S0_TASK1_ADMIN_URL="postgres://minime:minime@127.0.0.1:${MINIME_PG_PORT:-5432}/postgres"
S0_TASK1_URL="postgres://minime:minime@127.0.0.1:${MINIME_PG_PORT:-5432}/${S0_TASK1_DB}"
case "$S0_TASK1_ADMIN_URL:$S0_TASK1_URL" in *'$'*|*'{'*) echo "BLOCKED: URL expansion sanity failed" >&2; exit 125;; esac
case "$S0_TASK1_ADMIN_URL" in postgres://minime:minime@127.0.0.1:*'/postgres') ;; *) echo "BLOCKED: admin URL sanity failed" >&2; exit 125;; esac
S0_TASK1_ACTIVE=0
s0_task1_green_cleanup() {
  if [ "$S0_TASK1_ACTIVE" -eq 1 ]; then
    dropdb --if-exists --maintenance-db="$S0_TASK1_ADMIN_URL" "$S0_TASK1_DB"
    S0_TASK1_DROP_STATUS=$?
    S0_TASK1_ACTIVE=0
    if [ "$S0_TASK1_DROP_STATUS" -ne 0 ]; then
      echo "BLOCKED: Task 1 GREEN database drop failed" >&2
      return 125
    fi
    echo "Task 1 GREEN database drop succeeded"
  fi
  return 0
}
trap 'S0_TASK1_EXIT=$?; if ! s0_task1_green_cleanup; then exit 125; fi; exit "$S0_TASK1_EXIT"' EXIT INT TERM
S0_TASK1_TEMPLATE_CONNECTIONS="$(
  psql "$S0_TASK1_ADMIN_URL" -X -qAt -v ON_ERROR_STOP=1 \
    -c "select count(*)::int from pg_stat_activity where datname = 'minime_test'"
)"
if [ "$?" -ne 0 ]; then
  echo "BLOCKED: Task 1 GREEN template preflight failed" >&2
  exit 125
fi
if [ "$S0_TASK1_TEMPLATE_CONNECTIONS" != "0" ]; then
  echo "BLOCKED: Task 1 GREEN template is busy" >&2
  exit 125
fi
createdb --maintenance-db="$S0_TASK1_ADMIN_URL" \
  --owner=minime --template=minime_test "$S0_TASK1_DB"
if [ "$?" -ne 0 ]; then
  echo "BLOCKED: Task 1 GREEN template clone failed" >&2
  exit 125
fi
S0_TASK1_ACTIVE=1
S0_TASK1_EXTENSION_COUNT="$(
  psql "$S0_TASK1_URL" -X -qAt -v ON_ERROR_STOP=1 \
    -c "select count(*)::int from pg_extension where extname in ('vector', 'pgcrypto')"
)"
if [ "$?" -ne 0 ] || [ "$S0_TASK1_EXTENSION_COUNT" != "2" ]; then
  echo "BLOCKED: Task 1 GREEN extension assertion failed" >&2
  exit 125
fi
MINIME_SCRATCH_TEST_DATABASE_URL="$S0_TASK1_URL" OLLAMA_URL=http://127.0.0.1:9 \
  bun test test/m14.extract-validate.test.ts \
    test/m13.provider-routing.test.ts test/h5-contradiction-scan.test.ts
S0_TASK1_STATUS=$?
if [ "$S0_TASK1_STATUS" -ne 0 ]; then echo "BLOCKED: Task 1 GREEN/neighbors failed" >&2; exit 125; fi
exit 0
~~~
The exact result object must pass; globalThis.fetch retains identity and cloudCalls is empty. The independent GREEN lifecycle has its own template clone, extension assertion, test, trap cleanup, and drop status.

Task 1 evidence commands:

~~~bash
git diff -- test/m14.extract-validate.test.ts
# Run the amended Step 2 shell exactly.
# Expected: nonzero test assertion status, not 125; target drop succeeds.
git status --short
# Expected: only " M test/m14.extract-validate.test.ts".

# After src/pipeline/validate-edges.ts is implemented, run amended Step 4 exactly.
# Expected: test status 0 and the independent GREEN target drop succeeds.
~~~

Stop immediately if source connections are nonzero, clone/assert/drop fails, the RED
command returns 0 or 125, the GREEN command is nonzero, or status shows another tracked edit
before the Task 1 production change.

- [ ] Step 5: Commit with test: restore offline edge validation seam.

---

### Task 2: Plan guarded per-process databases

Files:
- Create: test/support/test-database.ts
- Create: test/test-database-isolation.test.ts

~~~ts
export interface TestDatabasePlan {
  readonly databaseUrl: string;
  readonly adminUrl: string;
  readonly databaseName: string;
  readonly mode: "create" | "external";
}

export function planTestDatabase(
  sourceUrl: string,
  runToken: string,
  explicitUrl?: string,
): TestDatabasePlan;
~~~

Generated names match ^minime_test_[a-z0-9_]+$. The generated run token is exactly ${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)} (process.pid, an underscore, and twelve lowercase hexadecimal characters). Generated plans use mode create. An explicit MINIME_TEST_DATABASE_URL plan uses mode external and is accepted only when loopback, query/fragment-free, prefix-guarded, and neither minime nor shared minime_test.

This task is pure: tests inject only strings and never invoke the default PostgreSQL adapter.

- [ ] Step 1: Write pure planning RED tests.
~~~ts
const a = planTestDatabase(base, "123_aaaaaaaaaaaa");
const b = planTestDatabase(base, "124_bbbbbbbbbbbb");
expect(a.databaseName).toBe("minime_test_123_aaaaaaaaaaaa");
expect(a.databaseName).not.toBe(b.databaseName);
expect(a.databaseName).toMatch(/^minime_test_[0-9]+_[a-f0-9]{12}$/);
expect(a.mode).toBe("create");
expect(planTestDatabase(base, "run", explicitScratch).mode).toBe("external");
expect(() => planTestDatabase(remoteUrl, "run")).toThrow("test_database_loopback");
expect(() => planTestDatabase(base, "run", ownerUrl)).toThrow("test_database_guard");
expect(() => planTestDatabase(base, "run", sharedUrl)).toThrow("test_database_guard");
~~~
- [ ] Step 2: Prove RED.
~~~bash
bun test test/test-database-isolation.test.ts --test-name-pattern "plans"
~~~
Expected RED is missing module/export; do not run an unscoped suite.
- [ ] Step 3: Implement only URL planning and guards. Parse with URL, replace only pathname, preserve credentials/port, derive adminUrl with pathname /postgres, and do not connect/create/migrate/register cleanup.
- [ ] Step 4: Run and commit with test: plan guarded per-run databases.

---

### Task 3: Provision/dispose through one ownership capability

Files:
- Modify: test/support/test-database.ts
- Modify: test/test-database-isolation.test.ts

~~~ts
export interface TestDatabaseAdmin {
  acquireTemplateCloneLock(): Promise<void>;
  exists(databaseName: string): Promise<boolean>;
  assertInstallerTemplateIdle(): Promise<void>;
  cloneFromInstallerTemplate(databaseName: string): Promise<void>;
  assertExtensionsPresent(databaseUrl: string): Promise<void>;
  terminate(databaseName: string): Promise<void>;
  drop(databaseName: string): Promise<void>;
  close(): Promise<void>;
}
export interface TestDatabaseDeps {
  connectAdmin(adminUrl: string): Promise<TestDatabaseAdmin>;
}
declare const provisionedTestDatabaseBrand: unique symbol;
export interface ProvisionedTestDatabase {
  readonly plan: TestDatabasePlan;
  readonly createdByThisProcess: boolean;
  readonly [provisionedTestDatabaseBrand]: true;
}
export async function provisionTestDatabase(plan: TestDatabasePlan, deps?: TestDatabaseDeps): Promise<ProvisionedTestDatabase>;
export async function disposeTestDatabase(provisioned: ProvisionedTestDatabase, deps?: TestDatabaseDeps): Promise<void>;
~~~

Transitions are exact: revalidate create plan -> connect admin -> lock_template -> require
absent -> template_idle -> clone_template:minime_test -> assert_extensions -> close
provisioning admin -> mint branded handle.

The brand is module-private at runtime; every minted object is recorded in a module-private WeakMap with live, disposing, or disposed lifecycle. Disposal accepts only a map handle. A local `cloneSucceeded` ownership fact becomes true only after `cloneFromInstallerTemplate()` resolves successfully for this generated plan. Only while that fact is true may a subsequent target-extension assertion failure or provisioning-admin close failure terminate/drop that generated target before rethrowing. A clone error of any kind—including SQLSTATE `55006`, SQLSTATE `42P04`, another pre-success clone failure, or an indeterminate clone result—closes the provisioning admin without terminate/drop and never mints. Pre-clone failure, collision, and every external-mode failure likewise close without terminate/drop and without minting a generated handle. A pre-existing collision is never adopted or dropped. External provisioning asserts extensions, closes admin, and mints createdByThisProcess false; disposing it marks disposed with no drop.

- `exists:true` before clone is a collision. It is never adopted or dropped.
- `cloneFromInstallerTemplate()` rejection never grants ownership. Do not reconnect and infer
  ownership from a later `exists()` result.
- Known clone success followed by `assertExtensionsPresent()` failure may roll back exactly the
  generated target.
- Known clone success followed by successful extension assertion but failed admin close may
  reconnect and roll back exactly the generated target.
- External mode always has `createdByThisProcess === false`; missing DB, extension assertion
  failure, admin-close failure, and disposal never terminate/drop.
- If post-clone rollback fails, return fixed `test_database_cleanup_failed`; this does not
  broaden the rollback eligibility rule.

Default adapter contract:

- Hold all admin operations on one reserved postgres.js connection to plan.adminUrl.
- acquireTemplateCloneLock() takes the session advisory lock
  pg_advisory_lock(1296649801, 1413829460) (`MINI`, `TEST`). The numeric pair and
  minime_test literal are module-private constants, not dependency/caller inputs.
- assertInstallerTemplateIdle() counts all pg_stat_activity rows whose datname is exactly
  minime_test; nonzero throws fixed test_database_template_busy.
- cloneFromInstallerTemplate(databaseName) first revalidates the guarded generated target,
  then executes one non-transactional statement equivalent to:

~~~sql
create database "<validated-target>"
  with owner = minime template = minime_test;
~~~

- Only the regex-validated target identifier is interpolated/quoted. Template and owner are
  constants. No connection URL, arbitrary SQL, owner, or template crosses this interface.
- Map PostgreSQL SQLSTATE 55006 from clone to fixed test_database_template_busy; map 42P04
  to fixed test_database_collision. Other clone errors use fixed test_database_clone_failed;
  do not expose server text or a URL.
- assertExtensionsPresent() opens the target, requires exactly one row for each of vector and
  pgcrypto, and closes that target connection before returning or throwing fixed
  test_database_extensions_missing.
- close() releases the reserved admin connection and therefore the advisory lock.
- Do not use CREATE EXTENSION, ALTER DATABASE, datistemplate, connection termination, or
  superuser-role inspection in the create path.

- [ ] Step 1: Write fake-admin traces:
~~~text
lock_template, exists:false, template_idle, clone_template:minime_test,
assert_extensions, close, mint

lock_template, exists:false, template_idle:busy, close

lock_template, exists:false, template_idle, clone_template:busy, close

lock_template, exists:false, template_idle, clone_template:minime_test,
assert_extensions:fail, terminate, drop, close

lock_template, exists:false, template_idle, clone_template:minime_test,
assert_extensions, close:fail, connect:cleanup, terminate, drop, close:cleanup

lock_template, exists:false, template_idle, clone_template:collision, close

lock_template, exists:false, template_idle, clone_template:fail, close

exists:true, assert_extensions:fail, close

exists:true, assert_extensions, close:fail
~~~
Assertions:

- Busy/pre-clone failure never calls clone/drop/terminate and never mints.
- A collision is never adopted or dropped.
- Once clone success is known, extension assertion failure rolls back the guarded target and
  never mints.
- Once clone success is known, provisioning-admin close failure reconnects,
  terminates/drops only that guarded target, closes cleanup admin, and rethrows.
- Rollback failure remains fixed test_database_cleanup_failed.
- Concurrent generated provisioners serialize at lock_template; each receives a distinct
  name and neither connects to the source.
- For the four pre-clone/clone-rejection traces and the two external-mode traces, assert:

~~~ts
expect(trace).not.toContain("terminate");
expect(trace).not.toContain("drop");
expect(trace).not.toContain("mint");
~~~

- For the two post-clone traces, assert terminate/drop occurs only for the exact guarded target
  whose clone promise resolved. Add a forged/raced same-name case proving a collision or
  post-rejection existence observation cannot set `cloneSucceeded`.

Also test forged handles, double disposal, concurrent disposal sharing one in-flight promise,
retry after transient drop failure, and successful drop marked disposed before close failure.

Generated-mode transition:

~~~text
revalidate create plan
connect admin
lock_template
exists:false
template_idle
clone_template:minime_test
assert_extensions
close
mint
~~~

External mode remains supported but is not a template-clone path:

~~~text
exists:true, assert_extensions, close, mint_external
~~~

- It still accepts only the already-approved unique loopback guarded
  MINIME_TEST_DATABASE_URL, never minime or minime_test.
- It does not acquire the template lock, inspect source sessions, clone, create extensions,
  terminate, or drop.
- Missing external DB uses fixed test_database_external_missing.
- Missing required extension uses fixed test_database_extensions_missing.
- Disposal marks the handle disposed without dropping because
  createdByThisProcess === false.
- The operator owns exclusivity and lifecycle for external mode. Task 6's wrapper must not
  use external mode: it always plans a generated parent-owned database and rejects an
  inherited MINIME_TEST_DATABASE_URL with fixed owned_database_external_forbidden.

- [ ] Step 2: Prove RED.
~~~bash
bun test test/test-database-isolation.test.ts \
  --test-name-pattern "provision|dispose|template|external|rollback"
~~~
RED must show the current broad rollback behavior/contract. GREEN must prove the known-success
ownership boundary with fake admins and opens no real database.

- [ ] Step 3: Implement guarded clone/rollback using the existing PostgreSQL dependency only in the default adapter; quote only regex-validated names.
- [ ] Step 4: Implement guarded disposal. Set disposing before connecting, share concurrent calls, restore live on terminate/drop failure, set disposed immediately after successful drop, and close in finally.
- [ ] Step 5: Run and commit with test: add guarded test database lifecycle.

Add source-shape assertions in test/test-database-isolation.test.ts:

- the public interface has no template parameter;
- the default create path contains the one literal minime_test;
- no create extension, template environment read, ALTER DATABASE, or source termination
  appears;
- synthetic SQLSTATE 55006 and 42P04 map to the fixed failures above;
- extension failure and admin-close failure use the rollback traces exactly.

---

### Task 4: Bootstrap migration contexts on the owned test database

This is one integration task because neither half can independently meet its green gate.

Files:
- Create: src/db/migration-context.ts
- Create: test/migration-context.test.ts
- Modify: src/db/migrate.ts
- Modify: src/cli.ts
- Modify: scripts/install.sh
- Modify: Makefile
- Modify: test/setup.ts
- Modify: test/helpers.ts
- Modify: test/m1.schema.test.ts
- Modify: test/install.test.ts
- Modify: test/access-boost.test.ts
- Modify: test/h3-data-root.test.ts
- Modify: test/h3-libpq-service.test.ts
- Modify: test/test-database-isolation.test.ts

Interfaces:
~~~ts
export type MigrationContext =
  | { kind: "install" }
  | { kind: "direct" }
  | { kind: "test" }
  | { kind: "restore" }
  | { kind: "update"; snapshot: "taken" | "unconfigured" };

export interface SchemaPosture {
  expected: readonly string[];
  applied: readonly string[];
  missing: readonly string[];
  unexpected: readonly string[];
}
export function assertMigrationContextForDatabase(context: MigrationContext | undefined, databaseName: string): asserts context is MigrationContext;
export function parseMigrationCliContext(argv: readonly string[]): MigrationContext;
export function compareMigrationLedger(expected: readonly string[], applied: readonly string[]): SchemaPosture;
export async function checkedOutMigrationNames(): Promise<readonly string[]>;
export function assertSchemaPostureCurrent(posture: SchemaPosture): void;
export async function inspectSchemaPosture(): Promise<SchemaPosture>;
export async function assertSchemaCurrent(): Promise<void>;
export async function migrate(context: MigrationContext): Promise<string[]>;
~~~

Target matrix:
- install, direct, update -> minime
- test -> ^minime_test_[a-z0-9_]+$
- restore -> minime_drill or minime_restore

Use one exhaustive switch. Public failures are fixed migration_context_required, migration_context_invalid, and migration_context_target, with no URL/path/database value. migrate validates before schema_migrations, migration body, or lease. assertSchemaCurrent compares sorted checked-out names with the ledger exactly and never applies one.

Preload order:
~~~text
plan generated or explicit guarded DB
-> provision and retain branded handle
-> set DATABASE_URL
-> set hermetic test env
-> dynamic import migrate
-> migrate({kind:"test"})
-> run tests
-> afterAll: dynamic import closeDb
-> await closeDb()
-> dispose only retained branded handle
~~~

test/setup.ts may statically import bun:test, Node built-ins, and test/support/test-database.ts only before assigning DATABASE_URL. Generated plans derive from DATABASE_URL or documented localhost default. MINIME_TEST_DATABASE_URL is passed only as a unique guarded explicit URL. testDatabaseUrl() and activeTestDatabaseName() return retained plan values and never reread environment. Task 4 adds normal afterAll only; signal-safe shared cleanup and keep-forensics belong to Task 6.

resetDb and M1 idempotency call migrate({ kind: "test" }). M1 asserts active name matches the guarded regex, is not minime_test, and equals select current_database(). access-boost makes the same assertion. H3 uses active guarded name while still rejecting /minime and nonmatching names.

Sanctioned callers:
- Make migrate -> CLI --context direct
- installer -> CLI --context install
- test helpers/preload -> migrate({ kind: "test" })
- S3 restore gate -> migrate({ kind: "restore" })
- S0/S3 updater -> bounded update context
- CLI seed/onboard/serve/runtime -> assertSchemaCurrent and FIX: make migrate
- pre-S0 updater -> bare CLI deliberately refused

Remove automatic migration from seed/onboard/runtime-start. Bare migration exits 50 before a DB write with:
~~~text
ERROR: migration context required
FIX: run make migrate, or rerun make update
~~~

- [ ] Step 1: Write pure parser/ledger RED tests. Table-drive direct/install/update(taken|unconfigured), reject missing/duplicate/unknown/trailing/API-only test context flags, assert target matrix and no-side-effect refusal, and prove closed-port child returns fixed context error instead of connection error.
~~~bash
bun test test/migration-context.test.ts --test-name-pattern "parses|compares"
~~~
No DB query is attempted in RED.
- [ ] Step 2: Implement guard and explicit callers.
- [ ] Step 3: Wire normal preload with top-level await; failures abort with no shared fallback; retain branded handle until disposal.
- [ ] Step 4: Run integration gates:
~~~bash
bun test test/migration-context.test.ts test/m1.schema.test.ts
bun test test/h3-data-root.test.ts test/h3-libpq-service.test.ts test/access-boost.test.ts test/install.test.ts
make -n migrate
bash -n scripts/install.sh
bun test
~~~
Expected every process reports a guarded name, CLI/Make/install contexts exact, full unscoped baseline passes, and afterAll leaves no owned database. Stop and ask the human about baseline failures not caused by Task 4.
- [ ] Step 5: Commit with fix: bootstrap isolated migration contexts.

---

### Task 5: Add the safe first-hop updater rerun

Files:
- Create: test/update-bootstrap.test.ts
- Modify: src/pipeline/backup.ts
- Modify: src/cli.ts
- Modify: scripts/update.sh
- Modify: test/backup.test.ts
- Modify: test/update.test.ts
- Modify: AGENTS.md

Do not create test/fixtures/update-before-s0.sh.

Interfaces:
~~~ts
export type PreUpdateSnapshotOutcome =
  | { kind: "taken" }
  | { kind: "unconfigured" }
  | { kind: "failed" };
export async function preUpdateSnapshot(): Promise<PreUpdateSnapshotOutcome>;
~~~

backup:pre-update exits 0 for taken, 3 only when both restic repository and password-file settings are absent, and 1 for partial configuration or configured failure. It emits one fixed content-free status line. The updater order is clean preflight -> backup with checked-out code -> stop unless 0/3 -> fetch/fast-forward -> frozen dependency install -> migrate --context update --snapshot-outcome taken|unconfigured -> existing verify/summary.

The transition test creates a temporary bare origin and clone with two commits. Commit A writes a minimal behavioral scripts/update.sh generated by the test containing only real fetch, real fast-forward pull, frozen install, a backup call whose nonzero status is ignored, and bare bun run src/cli.ts migrate. It contains no installer grammar, summary, helper, comments, production snapshots, or copied production logic. Commit B installs the Task 4 guard/CLI plus a transactional test-only no-op 021_runtime_app_role.sql inside the temporary repository. Controlled git records/delegates fetch/pull, controlled bun records install/backup, and migration delegates to checked-out commit-B CLI.

Binding first trace:
~~~text
fetch, pull, install, backup_failed, migrate_refused
~~~
First exits 50 and leaves 021 unapplied. Checked-out rerun traces preflight, backup, fetch, pull, install, migrate:update:taken, verify; 021 applies once and a third invocation leaves ledger count one.

- [ ] Step 1: Write transition/outcome RED tests. Backup exit 1 prevents fetch/pull/install/migrate; 0 supplies taken; 3 supplies unconfigured. Reuse the temporary two-commit driver and do not add a frozen shell fixture.
~~~bash
bun test test/update-bootstrap.test.ts test/update.test.ts test/backup.test.ts
~~~
- [ ] Step 2: Implement the minimal outcome/order. Both restic settings absent is unconfigured, either one present is configured-invalid, and dbSnapshot().ran false under full config is failed. Map only 0 -> taken and 3 -> unconfigured, failing every other code before Git; do not parse child text. Invoke:
~~~bash
bun run src/cli.ts migrate --context update --snapshot-outcome "$SNAPSHOT_OUTCOME"
~~~
Keep Bash 3.2 syntax.
- [ ] Step 3: Run bridge tests, bash -n scripts/update.sh, stage owned files, and commit with fix: bootstrap fail-closed updates before migration 021.

---

### Task 6: Complete cleanup and isolate eval/offline-M0 children

Files:
- Create: test/fixtures/test-db-probe.test.ts
- Create: test/fixtures/owned-db-child.ts
- Create: test/eval-database-isolation.test.ts
- Create: scripts/with-test-database.ts
- Modify: test/setup.ts
- Modify: test/support/test-database.ts
- Modify: test/test-database-isolation.test.ts
- Modify: Makefile
- Modify: .github/workflows/eval.yml
- Modify: scripts/eval-pmb.sh

No eval script receives a new migration context. Existing resetDb calls continue to use kind test.

Direct destructive eval callers:
- scripts/eval-search.ts -> resetDb()
- scripts/eval-graph-hygiene.ts -> resetDb()
- scripts/eval-precisionmembench.ts -> resetDb()
- scripts/pmb-server.ts -> resetDb()

Transitive destructive eval callers:
- scripts/eval-skills.ts -> seedCorpus()
- scripts/optimize-skill.ts -> seedCorpus()
- scripts/skill-eval-lib.ts seedCorpus() -> resetAndSeed()
- test/helpers.ts resetAndSeed() -> resetDb()
- test/helpers.ts resetDb() -> migrate({ kind: "test" })

Excluded after static proof:
- scripts/eval-longmemeval.ts imports/calls none of resetDb, resetAndSeed, seedCorpus, or
  migrate; it contains no DROP TABLE, DROP DATABASE, or TRUNCATE operation. It remains an
  owner-run incremental ingest/search benchmark and is not a database-reset eval.

Wrapper interfaces:
~~~ts
export const OWNED_DATABASE_ENV_NAMES = [
  "EVAL_DATABASE_URL",
  "EVAL_PMB_DATABASE_URL",
  "EVAL_SKILLS_DATABASE_URL",
] as const;
export type OwnedDatabaseEnv = (typeof OWNED_DATABASE_ENV_NAMES)[number];
export interface OwnedCommand {
  readonly label:
    | "verify_m0"
    | "eval_search"
    | "eval_search_live"
    | "eval_snapshot"
    | "eval_graph_hygiene"
    | "eval_pmb"
    | "eval_pmb_official"
    | "eval_skills"
    | "eval_skill_optimize";
  readonly databaseEnv?: OwnedDatabaseEnv;
  readonly argv: readonly [string, ...string[]];
}
export interface OwnedCommandDeps {
  readonly provision: typeof provisionTestDatabase;
  readonly dispose: typeof disposeTestDatabase;
  bootstrapOwnedDatabase(): Promise<void>;
  spawn(argv: readonly string[], env: Readonly<Record<string, string>>): Promise<number>;
}
export function parseOwnedCommandArgs(argv: readonly string[]): OwnedCommand;
export async function runWithOwnedTestDatabase(command: OwnedCommand, deps?: OwnedCommandDeps): Promise<number>;
~~~

CLI grammar:
~~~text
bun run scripts/with-test-database.ts --label <allowed-label> [--database-env EVAL_DATABASE_URL|EVAL_PMB_DATABASE_URL|EVAL_SKILLS_DATABASE_URL] -- <command> [args...]
~~~
Reject unknown/duplicate/missing flags, empty child argv, unknown labels, arbitrary database-env names, trailing wrapper arguments with fixed owned_database_args_invalid. Plan with label_pid_uuid12, provision/retain branded handle, set child DATABASE_URL and optional approved alias, spawn/wait, dispose retained handle, and return child exit code. It overwrites inherited aliases when selected and never allows child disposal. The wrapper always requests generated mode, regardless of inherited environment, and rejects an inherited MINIME_TEST_DATABASE_URL with fixed owned_database_external_forbidden before planning or any socket.

Task 6 extends the Task 2 planner's generated run-token grammar from `pid_uuid12` to
`label_pid_uuid12` for this wrapper. The optional label prefix matches
`[a-z][a-z0-9_]*`; the wrapper parser remains the authority that restricts it to the exact
`OwnedCommand.label` union above. The original `pid_uuid12` form remains valid for Bun test
preloads. This is a planner grammar change only: guarded loopback URL validation, generated
mode, the module-private ownership brand, clone source/owner constants, and disposal rules are
unchanged.

Executable migration bootstrap:

scripts/with-test-database.ts never statically imports src/. Before provisioning it may
import only Node/Bun APIs and test/support/test-database.ts; that support module must not
import src/ or load Minime config.

After provisioning, the parent:
1. retains the branded handle;
2. assigns the owned loopback URL to process.env.DATABASE_URL;
3. assigns the same URL to the selected approved eval alias, if any;
4. dynamically imports src/db/migrate.ts and src/db/client.ts;
5. calls migrate({ kind: "test" });
6. awaits closeDb() to release the parent migration pool;
7. only then constructs/spawns the child with DATABASE_URL and the selected alias fixed to
   that same owned URL;
8. waits for the child;
9. disposes only through the retained branded handle.

The default bootstrapOwnedDatabase() implementation is defined inside
scripts/with-test-database.ts as:

~~~ts
async function bootstrapOwnedDatabase(): Promise<void> {
  const { migrate } = await import("../src/db/migrate");
  const { closeDb } = await import("../src/db/client");
  try {
    await migrate({ kind: "test" });
  } finally {
    await closeDb();
  }
}
~~~

The call site, not the helper, assigns process.env.DATABASE_URL first. Tests inject
bootstrapOwnedDatabase through OwnedCommandDeps to trace order without opening a real
database.

Bootstrap invariants:

- The dynamic import occurs after the owned URL assignment, so src/util/config.ts and the
  singleton pool can bind only to the empty owned scratch database.
- Repository dotenv fallback cannot replace the explicit owned DATABASE_URL.
- Standalone src/verify/m0.ts is unchanged and never migrates a live database.
- The wrapper bootstraps every allowed child, including evals; a reset eval may subsequently
  call resetDb() and reapply migrations under the same API-only test context.
- Migration or parent-pool-close failure prevents child spawn.
- Success, migration failure, pool-close failure, child nonzero exit, and signal paths all
  attempt branded disposal. A disposal/cleanup failure uses the existing fixed
  test_database_cleanup_failed outcome and may not be hidden by the primary error.
- The child never receives a brand and never creates, adopts, terminates, or drops the DB.

Required trace assertions in test/test-database-isolation.test.ts:

~~~ts
expect(successTrace).toEqual([
  "plan",
  "provision",
  "set:DATABASE_URL",
  "bootstrap:migrate:test",
  "bootstrap:closeDb",
  "spawn",
  "child:0",
  "dispose",
]);

expect(bootstrapFailureTrace).toEqual([
  "plan",
  "provision",
  "set:DATABASE_URL",
  "bootstrap:migrate:test:fail",
  "bootstrap:closeDb",
  "dispose",
]);
expect(bootstrapFailureTrace).not.toContain("spawn");
~~~

Also cover closeDb rejection: no spawn, one branded disposal attempt, fixed cleanup
failure if disposal also fails.

The real test/fixtures/owned-db-child.ts probe must query:

~~~sql
select current_database() as name;
select count(*)::int as n from schema_migrations;
~~~

and assert in its parent test that the name matches ^minime_test_[a-z0-9_]+$, the ledger
count equals the sorted checked-out migration count, and the owned database no longer exists
after wrapper completion.

Task 6's real child test also proves:

- the child DATABASE_URL and approved eval alias name the generated target;
- the source name never appears in child env/argv;
- the target has vector and pgcrypto;
- the target is dropped after normal, nonzero-child, bootstrap-failure, and signal outcomes.

The existing two-simultaneous-process gate is also the real advisory-lock acceptance test:
both commands must complete against distinct generated targets and leave neither target. Do
not add a real test that connects to minime_test to manufacture busy state; the fake
trace/SQLSTATE test covers fail-closed source contention without violating the shared-source
rule.

Refactor setup cleanup to one idempotent async function used by afterAll, SIGINT, and SIGTERM. Always await closeDb before disposal; concurrent callers share one promise. MINIME_KEEP_TEST_DATABASE=1 skips disposal only for process-created DB and prints only its guarded name.

Make contracts:
~~~make
TEST_DB_RUNNER := $(BUN) run scripts/with-test-database.ts

verify-m0-offline:
	@MINIME_MOCK_OLLAMA=1 $(TEST_DB_RUNNER) --label verify_m0 -- \
		$(BUN) run src/verify/m0.ts

eval-search:
	@MINIME_MOCK_OLLAMA=1 $(TEST_DB_RUNNER) \
		--label eval_search --database-env EVAL_DATABASE_URL -- \
		$(BUN) run scripts/eval-search.ts --mode mock --round mock

eval-snapshot:
	@test -n "$(ROUND)" || { echo "usage: make eval-snapshot ROUND=<release-tag>"; exit 2; }
	@MINIME_MOCK_OLLAMA=1 $(TEST_DB_RUNNER) \
		--label eval_snapshot --database-env EVAL_DATABASE_URL -- \
		$(BUN) run scripts/eval-search.ts --mode mock --round release-$(ROUND)
~~~

`eval-snapshot` retains `MINIME_MOCK_OLLAMA=1` and the exact child argv
`bun run scripts/eval-search.ts --mode mock --round release-$(ROUND)` through label
`eval_snapshot` and alias `EVAL_DATABASE_URL`.

Use the wrapper without mock mode only for genuinely live targets:
- eval-search-live: eval_search_live / EVAL_DATABASE_URL
- eval-graph-hygiene: eval_graph_hygiene / EVAL_DATABASE_URL
- eval-pmb: eval_pmb / EVAL_PMB_DATABASE_URL
- eval-pmb-official: eval_pmb_official / EVAL_PMB_DATABASE_URL

| Target | Label | Child database env |
|---|---|---|
| `eval-skills` | `eval_skills` | `EVAL_SKILLS_DATABASE_URL` |
| `optimize-skill` | `eval_skill_optimize` | `EVAL_SKILLS_DATABASE_URL` |

The generated names contain `eval`, satisfy existing eval guards, and match
^minime_test_[a-z0-9_]+$.

The amended Task 6 Make contracts are exact:

~~~make
optimize-skill:
	@test -n "$(SUITE)" || { echo "usage: make optimize-skill SUITE=<suite> [START_FROM=...]"; exit 2; }
	@$(TEST_DB_RUNNER) \
		--label eval_skill_optimize --database-env EVAL_SKILLS_DATABASE_URL -- \
		$(BUN) run scripts/optimize-skill.ts \
		--suite $(SUITE) --round $(or $(ROUND),r1) \
		$(if $(START_FROM),--start-from $(START_FROM),)

eval-skills:
	@$(TEST_DB_RUNNER) \
		--label eval_skills --database-env EVAL_SKILLS_DATABASE_URL -- \
		$(BUN) run scripts/eval-skills.ts --round $(ROUND)
~~~

Remove from these targets:

- EVAL_SKILLS_DATABASE_URL ?= .../minime_eval_skills;
- createdb;
- direct psql extension creation;
- direct DATABASE_URL=$(EVAL_SKILLS_DATABASE_URL) child launch.

Preserve the SUITE refusal before wrapper invocation and every existing optimizer argv,
including optional START_FROM.

Remove createdb, direct extension SQL, and hard-coded minime_eval* recipes from covered targets. scripts/eval-pmb.sh requires wrapper-provided matching DATABASE_URL/EVAL_PMB_DATABASE_URL and never creates databases/extensions. LongMemEval remains unchanged only while the static non-destructive assertion below passes. If that assertion ever detects a reset helper or destructive DDL, LongMemEval must join wrapper ownership before implementation can continue.

S0 provisioning code requires and uses only `CREATEDB`: it must not inspect, branch on,
request, or use `rolsuper`. Native macOS/Linux already supplies
`minime = NOSUPERUSER, CREATEDB, CREATEROLE`; fresh CI must reproduce that exact three-bit
posture for all child gates. Existing local Docker installations deliberately retain their
pre-S1 image-owner `minime = SUPERUSER` posture. S0 does not claim to harden that role and
does not change it; S1 Task 4 owns the transition to `minime_app`.

This makes the portability claim exact:

- native proof: clone succeeds as `minime` with `f|t|t`;
- fresh CI proof: clone and the authoritative gates succeed as `minime` with `f|t|t`;
- existing local Docker: code follows the identical `CREATEDB` path but the incidental owner
  superuser bit remains unchanged until S1;
- no S0 code path branches on those environments or on the superuser bit.

The exact `.github/workflows/eval.yml` service identity, job environment, bootstrap, posture,
and authoritative gate contract is:

~~~yaml
jobs:
  minimebench:
    runs-on: ubuntu-24.04
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: postgres
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres" --health-interval 5s
          --health-timeout 5s --health-retries 10
    env:
      PGHOST: localhost
      PGUSER: minime
      PGPASSWORD: minime
      DATABASE_URL: postgres://minime:minime@localhost:5432/minime
      MINIME_MOCK_OLLAMA: "1"
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - name: bootstrap Minime databases as service administrator
        env:
          PGUSER: postgres
          PGPASSWORD: postgres
        run: |
          psql -X -v ON_ERROR_STOP=1 --dbname=postgres \
            -c "create role minime login password 'minime' nosuperuser createdb createrole"
          createdb --owner=minime minime
          createdb --owner=minime minime_test
          psql -X -v ON_ERROR_STOP=1 --dbname=minime_test \
            -c "create extension if not exists vector" \
            -c "create extension if not exists pgcrypto"
      - name: assert child database role posture
        run: |
          test "$(psql -X -qAt -v ON_ERROR_STOP=1 --dbname=postgres \
            -c "select current_user")" = "minime"
          test "$(psql -X -qAt -v ON_ERROR_STOP=1 --dbname=postgres \
            -c "select rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname = current_user")" = "f|t|t"
      - name: authoritative offline gate
        run: make verify
~~~

Keep the existing scorecard upload after the authoritative gate as required by Task 7.
Task 7 may refine the gate composition only as already specified; it may not change these
role identities or reintroduce separate unwrapped test/eval commands.

Exact privilege rules:

- POSTGRES_USER, the service health command, and the bootstrap step use postgres.
- PGUSER=postgres and PGPASSWORD=postgres are step-scoped to the bootstrap only.
- Job-level PGUSER, PGPASSWORD, and DATABASE_URL name minime.
- The posture step and make verify therefore run as minime.
- No later step may set PGUSER=postgres, use a postgres DSN, or receive the service-admin
  password.
- minime is created with explicit NOSUPERUSER CREATEDB CREATEROLE; do not rely on role
  defaults.
- The CI service is fresh, so CREATE ROLE/createdb are strict and have no `|| true`.
- The bootstrap creates only minime and minime_test; it does not create minime_eval*.
- Extensions are installed only in the template by the service administrator. Provisioning
  children clone them and never execute CREATE EXTENSION.

- [ ] Step 1: Write cleanup/signal/wrapper/Make RED tests.
~~~bash
bun test test/test-database-isolation.test.ts \
  --test-name-pattern "signal cleanup|owned child|bootstrap|template|external|rollback"
bun test test/eval-database-isolation.test.ts
~~~
Expected RED: signaled child strands DB, wrapper missing, and Make dry-runs contain createdb/minime_eval. The transitive source inventory assertion must cover:

~~~text
eval-skills.ts -> seedCorpus
optimize-skill.ts -> seedCorpus
skill-eval-lib.ts -> resetAndSeed
test/helpers.ts resetAndSeed -> resetDb
test/helpers.ts resetDb -> migrate({ kind: "test" })
~~~

The LongMemEval exclusion assertion must verify that scripts/eval-longmemeval.ts contains
none of:

~~~regex
\bresetDb\b|\bresetAndSeed\b|\bseedCorpus\b|
\bdrop\s+table\b|\bdrop\s+database\b|\btruncate\b|\bmigrate\s*\(
~~~

Also add parser tests accepting exactly eval_skills, eval_skill_optimize, and
EVAL_SKILLS_DATABASE_URL, rejecting near-miss labels and aliases; a fake-wrapper trace
proving DATABASE_URL and EVAL_SKILLS_DATABASE_URL are identical and fixed before
bootstrap/spawn; and these Make dry-runs:

~~~bash
make -n eval-skills ROUND=r1
make -n optimize-skill SUITE=query ROUND=r1
make -n optimize-skill SUITE=query ROUND=r1 START_FROM=fixtures/skill-tasks/deficient-query.md
make -n eval-snapshot ROUND=
make -n eval-snapshot ROUND=v0.9
~~~

Expected: wrapper labels and EVAL_SKILLS_DATABASE_URL appear; exact child argv and optional
--start-from are preserved; no createdb, direct extension SQL, shared minime_test, or
minime_eval_skills appears. The eval-snapshot dry-run must include
`MINIME_MOCK_OLLAMA=1`, `--label eval_snapshot --database-env EVAL_DATABASE_URL`, and the
exact mock argv with `release-v0.9`, while containing no createdb, direct extension SQL,
shared minime_test, or legacy minime_eval* database.
The missing-`ROUND` Make assertion must return exit 2 before invoking the wrapper, while
`ROUND=v0.9` preserves that exact mocked child argv. A recording-wrapper test invokes
`make eval-snapshot ROUND=`, requires status 2 and the usage line, and requires zero wrapper
invocations.

Task 6 focused commands:

~~~bash
bun test test/test-database-isolation.test.ts \
  --test-name-pattern "signal cleanup|owned child|bootstrap|template|external|rollback"
bun test test/eval-database-isolation.test.ts
make -n verify-m0-offline eval-search eval-snapshot ROUND=v0.9 \
  eval-search-live eval-graph-hygiene eval-pmb eval-pmb-official
make -n eval-skills ROUND=r1
make -n optimize-skill SUITE=query ROUND=r1
make verify-m0-offline
bun test
~~~

Expected evidence:

- wrapper and Make dry-runs contain no createdb, create extension, shared DB URL, or
  minime_eval*;
- only .github/workflows/eval.yml and installer/up bootstrap may establish the constant
  source;
- all generated children use the cloned extensions under the ordinary runtime login;
- no child connects to or drops minime_test;
- concurrent processes serialize provisioning without sharing targets;
- source busy, clone failure, missing target extensions, bootstrap failure, and cleanup
  failure are distinguishable fixed outcomes.

Task 6's `test/eval-database-isolation.test.ts` also reads `.github/workflows/eval.yml` and
proves:

~~~text
service POSTGRES_USER = postgres
service POSTGRES_DB = postgres
service health user = postgres
job PGUSER = minime
job DATABASE_URL user = minime
bootstrap step PGUSER = postgres
bootstrap creates minime as LOGIN NOSUPERUSER CREATEDB CREATEROLE
bootstrap creates minime and minime_test databases only
bootstrap installs vector and pgcrypto in minime_test only
posture step expects current_user=minime
posture step expects f|t|t
authoritative gate is make verify
~~~

The test must also assert:

- only the named bootstrap step contains `PGUSER: postgres`, `PGPASSWORD: postgres`,
  `createdb`, or `create extension`;
- no job-level or post-bootstrap child step contains admin credentials;
- no `minime_eval` database is created;
- the runtime/eval wrapper source contains none of `rolsuper`, `usesuper`, `is_superuser`,
  `alter role`, `set role`, or a superuser-specific branch;
- `cloneFromInstallerTemplate()` continues to depend only on the reserved `minime` admin
  connection, guarded target, constant source/owner, and `CREATEDB`-valid SQL.

Do not add a runtime assertion that universally requires `rolsuper=false`; that would make S0
silently harden/reject the pre-S1 local Docker posture. The exact `f|t|t` proof belongs in:

1. the workflow posture step;
2. the workflow static contract test; and
3. native acceptance evidence on the current native workstation.

Native acceptance command:

~~~bash
test "$(
  PGPASSWORD=minime psql \
    "postgres://minime@127.0.0.1:${MINIME_PG_PORT:-5432}/postgres" \
    -X -qAt -v ON_ERROR_STOP=1 \
    -c "select rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname = current_user"
)" = "f|t|t"
~~~

Then run the Task 1 clone RED/GREEN and Task 6 real owned-child/concurrency gates under that
same native role. Expected: clone succeeds without extension creation or superuser.

- [ ] Step 2: Implement shared cleanup and wrapper. Provision in parent, close source pool first, dispose on success/failure/signals except explicit keep-forensics. The wrapper dynamically bootstraps migrate({ kind: "test" }) and closes the parent migration pool before every child spawn.
- [ ] Step 3: Wire Make, eval scripts, and CI with approved labels/aliases. verify-m0-offline includes MINIME_MOCK_OLLAMA=1 and no eval alias; standalone make -n verify-m0 remains exactly bun run src/verify/m0.ts.
- [ ] Step 4: Run concurrent/wrapper gates:
~~~bash
bun test test/m1.schema.test.ts &
S0_PID_A=$!
bun test test/m14.extract-validate.test.ts &
S0_PID_B=$!
wait "$S0_PID_A"
wait "$S0_PID_B"
bun test test/test-database-isolation.test.ts test/eval-database-isolation.test.ts
make -n verify-m0-offline eval-search eval-snapshot ROUND=v0.9 eval-search-live eval-graph-hygiene eval-pmb eval-pmb-official
bun test test/test-database-isolation.test.ts test/eval-database-isolation.test.ts
make -n verify-m0
make -n verify-m0-offline
make -n eval-skills ROUND=r1
make -n optimize-skill SUITE=query ROUND=r1
make -n eval-snapshot ROUND=
make -n eval-snapshot ROUND=v0.9
make verify-m0-offline
bun test
~~~
Assert distinct guarded names; no owned DB after normal/failure/SIGINT/SIGTERM; identical child URL/selected alias; wrapper disposal after nonzero child; bootstrap migration and parent close precede every spawn; migration/close failures do not spawn and still dispose; and covered dry-runs contain wrapper/allowed labels with no createdb, extension SQL, shared minime_test, or minime_eval*. The real offline M0 must pass against the fully migrated scratch schema. Do not run live eval-skills or optimize-skill in S0 acceptance: they intentionally use configured models. Static/fake wrapper evidence and Make dry-runs prove database ownership without provider egress.

Run the unscoped suite and record its result. If every failure is in the unchanged
`test/h3-restore-scripts.test.ts` file and each failure says exactly
`timed out after 5000ms`, commit Task 6 only as a not-yet-accepted checkpoint and proceed
only through the reviewed Task 6.5 amendment below. Any other failure remains a Task 6
blocker. Do not waive, relabel, or omit the red unscoped gate.
- [ ] Step 5: Commit with test: isolate automated database processes.

---

### Task 6.5: Bound the H3 subprocess integration harness

Task 6.5 begins from a clean, committed Task 6 checkpoint whose focused isolation/eval
gates pass and whose sole outstanding acceptance failure is the fully classified,
unchanged-H3 5000 ms timeout set. The checkpoint is not acceptance and must not be recorded
as PASS. `TASK6_CHECKPOINT` is the exact checkpoint SHA; Task 6.5 exists to satisfy Task 6's
deferred unscoped acceptance, so neither task may close alone.

Files:
- Modify: `test/h3-restore-scripts.test.ts`
- Create: `.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-6.5-report.md`

The only implementation interface is:

~~~ts
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

const H3_SUBPROCESS_INTEGRATION_TIMEOUT_MS = 30_000;
setDefaultTimeout(H3_SUBPROCESS_INTEGRATION_TIMEOUT_MS);
~~~

Place the named constant and call after imports and before the first test or fixture
execution. The installed Bun type contract scopes `setDefaultTimeout()` to the current
file. Do not add retries/repeats, change a CLI/global timeout, or modify assertions,
fixtures, shell scripts, production code, `bunfig.toml`, package manifests, Make, workflow,
preload, or test concurrency.

- [ ] Step 1: Bind the timing-only RED.

Preserve the completed Task 6 raw `bun test` log as the regression RED. Record its exact
exit/status/count, the unchanged pre-amendment H3 SHA-256, and the standalone 126/126 H3
evidence. Every classified failure must say exactly `timed out after 5000ms`; no assertion,
privacy, cleanup, residue, or correctness failure may be reclassified as timing. Do not
manufacture another RED or use retries.

- [ ] Step 2: Implement only the file-local bounded timeout above.

- [ ] Step 3: Run the Task 6.5 and joint acceptance gates:

~~~bash
bun test test/h3-restore-scripts.test.ts
bun test test/test-database-isolation.test.ts test/eval-database-isolation.test.ts
bun test test/eval-database-isolation.test.ts
bun test
bunx biome check test/h3-restore-scripts.test.ts test/eval-database-isolation.test.ts
git diff --check
~~~

Expected: H3 remains exactly 126 pass / 0 fail; Task 6 focused gates remain green; the
fresh raw unscoped suite has zero failures; Biome applies no fix; and the diff check is
clean. Capture exact final pass/skip/assertion/file counts rather than predeclaring them.

Prove the Task 6.5 implementation scope from the exact binding-approved
`TASK65_PLAN_SHA`:

~~~bash
git diff --name-only "$TASK65_PLAN_SHA"..HEAD
git diff "$TASK65_PLAN_SHA"..HEAD -- \
  bunfig.toml package.json bun.lock Makefile .github/workflows/eval.yml src scripts db/migrations
~~~

The first output may contain only `test/h3-restore-scripts.test.ts` and the Task 6.5
report. The second output must be empty. The H3 implementation diff is exactly the import
addition plus the named 30,000 ms constant/call.

Separately preserve the checkpoint-to-candidate history proof used by the joint review:

~~~bash
git diff --name-only "$TASK6_CHECKPOINT"..HEAD
~~~

That historical range is not subject to the two-path Task 6.5 implementation allowlist;
it must contain only the already-reviewed Task 6 checkpoint, the binding plan/decision/
brief history, the H3 test change, and the Task 6.5 report.

After the unscoped run, observe through the sanctioned read-only engineering role that the
generated guarded database count and source-template activity count are both zero. Task 6.5
performs no database write or recovery.

- [ ] Step 4: Commit with `test: bound H3 subprocess integration timeout`.

- [ ] Step 5: Close Tasks 6 and 6.5 jointly.

At one exact descendant candidate HEAD, fresh Luna reviews the Task 6 implementation range
`72f7c198763278ad83d0ffbc51681d1c4ae66f02..TASK6_CHECKPOINT`, the Task 6.5
implementation range `TASK65_PLAN_SHA..HEAD`, and the combined runtime evidence. Independent
Sol then performs the binding joint review against both plans at that exact HEAD. The
verdict must explicitly state `Task 6 PASS`, `Task 6.5 PASS`, combined acceptance PASS, and
Critical 0 / Important 0 / Minor 0. Findings in either range require a task-labeled fix,
all combined gates, and both reviews again. A Luna Critical still requires separate Sol
Critical adjudication before binding.

Only after joint binding PASS may a closure-only ledger/review-artifact commit record the
checkpoint, plan SHA, final candidate SHA, exact gates, and verdicts. Task 7 starts from
that clean closure commit.

If joint review finds a Task 6 defect after Task 6.5 has already passed at
`e210235ea9ab7b6c368420ad25e82b3f24d6d81b`, do not reinterpret the Task 6.5
`TASK65_PLAN_SHA..HEAD` allowlist and do not rewrite history. Freeze the accepted Task 6.5
implementation proof as:

~~~text
TASK65_PLAN_SHA =
  4520380f9f41a8507982d7783668f3155013a020
TASK65_IMPLEMENTATION_SHA =
  e210235ea9ab7b6c368420ad25e82b3f24d6d81b
Task 6.5 implementation range =
  TASK65_PLAN_SHA..TASK65_IMPLEMENTATION_SHA
~~~

That frozen range must still contain only `test/h3-restore-scripts.test.ts` and the Task
6.5 report, with the protected-path diff empty. A later binding-approved Task 6 remediation
uses its own range below; it does not retroactively become Task 6.5 implementation.

Stop and replan if the Task 6 checkpoint is dirty or misclassified; the H3 hash changes
before implementation; any RED failure is not solely Bun's 5000 ms timeout; any H3 case
exceeds 30,000 ms; any child/temp/database artifact remains; the fresh unscoped run fails
outside this timeout issue; implementation needs a script/production/config/package/Make/
workflow edit; or protected `.env*`, `data/`, `db-dump/`, `backups/`, or any live/shared/
legacy database would be touched. Never raise the bound again inside this task—diagnose
instead. Do not require Task 6 binding PASS before Task 6.5, do not claim Task 6 PASS at
the checkpoint, and do not start Task 7 before the joint binding verdict and closure ledger.

---

### Task 6 I-1 binding remediation: prove bootstrap/close/disposal order

This append-only remediation exists because the first joint Sol review at
`e210235ea9ab7b6c368420ad25e82b3f24d6d81b` passed Task 6.5 but rejected Task 6
with Critical 0 / Important 1 / Minor 0. `TASK6_I1_PLAN_SHA` is the exact binding-approved
commit containing this remediation plan.

Files:
- Modify: `test/test-database-isolation.test.ts`
- Modify: `test/eval-database-isolation.test.ts`
- Create:
  `.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-6-binding-fix-report.md`

The Task 6 I-1 implementation range is `TASK6_I1_PLAN_SHA..NEW_HEAD`. Only the two test
files and dedicated report above may appear in that range. The protected diff across
`bunfig.toml`, package manifests/lock, Make, workflow, `src`, `scripts`, and migrations
must be empty. The plan-only history
`e210235ea9ab7b6c368420ad25e82b3f24d6d81b..TASK6_I1_PLAN_SHA` is listed
separately and is not subject to the three-path implementation allowlist.

- [ ] Step 1: Add exact executable trace coverage.

The success trace must be exactly:

~~~text
plan
provision
set:DATABASE_URL
bootstrap:migrate:test
bootstrap:closeDb
spawn
child:0
dispose
~~~

The bootstrap-failure trace must be exactly:

~~~text
plan
provision
set:DATABASE_URL
bootstrap:migrate:test:fail
bootstrap:closeDb
dispose
~~~

Use injected test dependencies to observe migration and close separately while preserving
the production wrapper. Prove that owned `DATABASE_URL` assignment is observable before
migration, close completes before spawn, child result is observed before disposal, and
bootstrap failure never spawns.

- [ ] Step 2: Add cleanup-precedence coverage.

Inject migration success followed by `closeDb` rejection, then make branded disposal reject.
Require no child spawn, exactly one disposal attempt, and fixed
`test_database_cleanup_failed` precedence over the close error. Also retain the close-only
failure case proving disposal still occurs once.

- [ ] Step 3: Add real generated-target bootstrap-failure coverage.

Provision one real guarded target through `provisionTestDatabase`, retain its branded
handle in the parent, inject bootstrap failure before spawn, and use
`disposeTestDatabase` for cleanup. Prove the exact generated target exists before the
failure path, no child spawns, the wrapper returns the primary bootstrap error when cleanup
succeeds, and that exact target is absent afterward. Do not touch, busy, migrate, terminate,
or drop the shared source template; do not manufacture a cleanup failure in this real case.

- [ ] Step 4: Run the complete joint gates:

~~~bash
bun test test/test-database-isolation.test.ts test/eval-database-isolation.test.ts
bun test test/eval-database-isolation.test.ts
bun test test/h3-restore-scripts.test.ts
bun test
bunx biome check \
  test/test-database-isolation.test.ts \
  test/eval-database-isolation.test.ts \
  test/h3-restore-scripts.test.ts
bash -n scripts/eval-pmb.sh
git diff --check
~~~

Capture exact counts and prove native role `f|t|t`, generated guarded database count 0,
source-template activity 0, and no wrapper/owned-child/test process. No provider-capable
eval or egress path may run.

- [ ] Step 5: Commit with `test: prove owned bootstrap cleanup order`.

Write the dedicated binding-fix report with RED cause, exact trace assertions, fake
cleanup-precedence evidence, real target lifecycle evidence, full gate counts, range/scope
proof, protected empty diff, residue, and commit note.

At `NEW_HEAD`, fresh Luna and independent Sol jointly bind four evidence sets:

1. original Task 6 range
   `72f7c198763278ad83d0ffbc51681d1c4ae66f02..3c3f196e71d3eec977a3d7c451da85f6282e78be`;
2. frozen Task 6.5 range
   `4520380f9f41a8507982d7783668f3155013a020..e210235ea9ab7b6c368420ad25e82b3f24d6d81b`;
3. Task 6 I-1 fix range `TASK6_I1_PLAN_SHA..NEW_HEAD`; and
4. combined runtime evidence at exact `NEW_HEAD`.

Task 6's verdict covers its original and I-1 fix ranges. Task 6.5's verdict covers only
its frozen range. Joint PASS still requires explicit `Task 6 PASS`, `Task 6.5 PASS`,
combined acceptance PASS, and Critical 0 / Important 0 / Minor 0 before a closure-only
ledger commit or Task 7.

Stop and replan if the exact traces cannot be proved through tests alone; production
wrapper/application code must change; the real target is not parent-owned/generated,
survives the test, or touches the source template; cleanup precedence is not fixed; a
protected path changes; any complete gate fails; or database/process residue remains.

---

### Task 6.75: Make the S0 harnesses strict-typecheck ready

This append-only remediation exists because the fresh joint Luna rereview at
`fa8ecc3e7f8025439ebbfbb7ef969a7e66064aac` closed Task 6's prior runtime/evidence
finding but found that the exact future compiler reports 26 diagnostics. Eighteen are in
Task 6 paths and eight are the pre-existing Task 5 updater-test baseline. Task 7's current
allowlist cannot fix either set, so `TASK675_PLAN_SHA` is the exact binding-approved plan
commit for one atomic pre-Task-7 correction.

Files:
- Modify: `scripts/with-test-database.ts`
- Modify: `test/eval-database-isolation.test.ts`
- Modify: `test/fixtures/owned-db-child.ts`
- Modify: `test/fixtures/test-db-probe.test.ts`
- Modify: `test/update-bootstrap.test.ts`
- Create:
  `.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-6.75-typecheck-readiness-report.md`

The plan-only range is
`fa8ecc3e7f8025439ebbfbb7ef969a7e66064aac..TASK675_PLAN_SHA`. The Task 6.75
implementation range is `TASK675_PLAN_SHA..TASK675_IMPLEMENTATION_SHA`, and only the six
paths above may appear in it. Package manifests/lock, `tsconfig.json`, Make, workflow,
`src`, migrations, `scripts/eval-pmb.sh`, protected data/settings, and all previously
frozen ranges remain unchanged. TypeScript is still added and pinned only by Task 7.

- [ ] Step 1: Preserve the exact compiler RED and add the timeout-position RED.

Run:

~~~bash
bunx --package typescript@5.9.3 tsc --noEmit --pretty false
~~~

Require exactly the classified 26 diagnostics: one wrapper argument-narrowing error,
thirteen eval-isolation errors, four fixture-row errors, and eight updater-test stream
errors. Verify `package.json` and `bun.lock` remain unchanged.

Before moving any timeout option, strengthen the existing static timeout-contract test to
enumerate all nine real integration cases, isolate each test block, and require the
documented third-position ending:

~~~text
    { timeout: REAL_INTEGRATION_TIMEOUT_MS },
  );
~~~

Run that test by exact name and require RED against the current second-position calls. Do
not replace the per-case proof with a global occurrence count or a file/global timeout.

- [ ] Step 2: Make only semantics-preserving type corrections.

In `scripts/with-test-database.ts`, explicitly reject an undefined `--database-env`
candidate before the existing allowlist check. Preserve the fixed
`owned_database_args_invalid` result for missing, sparse, or invalid input.

In `test/eval-database-isolation.test.ts`:

- type `waitForHarnessReady` from `ReturnType<typeof runWrapperHarness>` so its piped stderr
  is narrowed without a cast;
- move each of the nine existing 30-second options to Bun's declared third argument while
  preserving every independent bound and test body; and
- use `createDefaultTestDatabaseDeps()` for both real cases, retaining the module's same
  internal postgres adapter without an incompatible public call-site factory.

In both fixture files, express the two one-row SQL results as tuple generics so
`noUncheckedIndexedAccess` proves the destructures. In `test/update-bootstrap.test.ts`,
narrow only `Driver.run()` to `Bun.SyncSubprocess<"pipe", "pipe">`; each implementation
already fixes stdout and stderr to `"pipe"`. Do not use `any`, broad casts, non-null
assertions that conceal an invariant, `@ts-ignore`, `@ts-nocheck`, exclusions, or compiler
weakening.

- [ ] Step 3: Prove compiler GREEN and focused behavior.

~~~bash
bun test test/eval-database-isolation.test.ts \
  --test-name-pattern "real wrapper integration cases declare an explicit bounded timeout"
bunx --package typescript@5.9.3 tsc --noEmit --pretty false
bun test test/update-bootstrap.test.ts test/update.test.ts test/backup.test.ts
bun test test/test-database-isolation.test.ts test/eval-database-isolation.test.ts
bun test test/eval-database-isolation.test.ts
bun test test/h3-restore-scripts.test.ts
~~~

The timeout contract and compiler must exit zero with no diagnostics. Verify again that
`package.json`, `bun.lock`, and `tsconfig.json` are unchanged. Preserve the established
isolation/eval, eval-only, H3, and updater/backup behavior; record fresh counts instead of
copying prior evidence.

- [ ] Step 4: Run complete pipeline and safety gates.

~~~bash
bun test test/m1.schema.test.ts &
S0_PID_A=$!
bun test test/m14.extract-validate.test.ts &
S0_PID_B=$!
wait "$S0_PID_A"
wait "$S0_PID_B"

make -n verify-m0
make -n verify-m0-offline
make -n eval-skills ROUND=r1
make -n optimize-skill SUITE=query ROUND=r1
make -n eval-snapshot ROUND=
make -n eval-snapshot ROUND=v0.9
make verify-m0-offline

bun test
bunx --package typescript@5.9.3 tsc --noEmit --pretty false
bunx biome check \
  scripts/with-test-database.ts \
  test/eval-database-isolation.test.ts \
  test/fixtures/owned-db-child.ts \
  test/fixtures/test-db-probe.test.ts \
  test/update-bootstrap.test.ts
bash -n scripts/eval-pmb.sh
git diff --check
~~~

Require no provider-capable eval or egress. Through `make psql-ro`, prove native role
`f|t|t`, generated guarded database count zero, and source-template activity zero. Prove
no attributable wrapper, owned-child, or test process remains. The protected diff must be
empty:

~~~bash
git diff --exit-code "$TASK675_PLAN_SHA"..HEAD -- \
  bunfig.toml package.json bun.lock tsconfig.json Makefile \
  .github/workflows/eval.yml src db/migrations scripts/eval-pmb.sh
~~~

- [ ] Step 5: Commit with `test: make S0 harnesses typecheck-ready`.

Write the dedicated report with the exact RED classification, timeout-contract RED,
semantics-preserving corrections, compiler GREEN, fresh test/gate counts, scope and
protected-path proofs, database/process residue, and commit note.

At exact `TASK675_IMPLEMENTATION_SHA`, fresh Luna and independent Sol bind these evidence
sets separately:

1. original Task 6:
   `72f7c198763278ad83d0ffbc51681d1c4ae66f02..3c3f196e71d3eec977a3d7c451da85f6282e78be`;
2. frozen Task 6.5:
   `4520380f9f41a8507982d7783668f3155013a020..e210235ea9ab7b6c368420ad25e82b3f24d6d81b`;
3. frozen Task 6 I-1:
   `4e685e06127e2ed2a5efded951cc933cabe8b6c1..fa8ecc3e7f8025439ebbfbb7ef969a7e66064aac`;
4. Task 6.75: `TASK675_PLAN_SHA..TASK675_IMPLEMENTATION_SHA`; and
5. combined runtime/typecheck evidence at exact `TASK675_IMPLEMENTATION_SHA`.

The final verdict must explicitly state `Task 5 updater bridge PASS`, `Task 6 PASS`,
`Task 6.5 PASS`, `Task 6.75/typecheck readiness PASS`, combined acceptance PASS, and
Critical 0 / Important 0 / Minor 0 before the closure-only ledger/review-artifact commit
or Task 7.

Stop and replan if any correction requires application-source or behavior changes, changes
an error/output contract, weakens or excludes the compiler graph, changes package/lock/
config/Make/workflow, alters database ownership or cleanup, touches protected paths, opens
provider/network egress, leaves residue, or produces a diagnostic outside the classified
26.

---

### Task 6 R2 binding remediation: make owned teardown authoritative

This append-only remediation exists because the independent joint Sol review at
`161602601ae3695af9b1af91b06d530cb205d9c5` passed all 1050 named tests but rejected
the process cleanup: `terminateTarget()` exhausted its eight activity polls before
`drop()`, raised one unnamed `test_database_cleanup_failed`, and left the exact guarded
database `minime_test_78356_d9cc0c26add6` idle after process exit. That target was
validated read-only, recovered through the guarded test-database admin adapter, and the
current guarded/source activity counts are zero.

The structural defect is that cleanup counts every backend class, explicitly terminates
only same-role client backends, and can abort before the authoritative drop attempt. A
read-only monitored rerun passed 1050/1/0 and observed the normal postgres.js clients drain,
so the historical survivor remains intermittent and unclassified. This remediation fixes
the deterministic lifecycle mismatch; it does not merely increase the polling window.
`TASK6_R2_BLOCKER_RECHECK_PLAN_SHA` is the exact final binding-approved teardown-plan
commit. The earlier lifecycle plan ends at
`85427bd45e7a255eb6ba06825b8ae21d8bb5b4b3` and is not a valid implementation base.
Before implementation resumes, the ledger and both fresh review verdicts must resolve
`TASK6_R2_BLOCKER_RECHECK_PLAN_SHA` to the same exact reviewed HEAD.

Files:
- Modify: `test/support/test-database.ts`
- Modify: `test/test-database-isolation.test.ts`
- Modify: `test/eval-database-isolation.test.ts`
- Modify: `test/fixtures/owned-db-child.ts`
- Modify: `test/setup.ts`
- Modify: `test/m15.roles.test.ts`
- Create:
  `.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-6-r2-cleanup-race-report.md`

The initial/corrected R2 plan-only history is
`161602601ae3695af9b1af91b06d530cb205d9c5..4d40e9b4a01d0d7042da15ca36c7e63aa5cdb833`.
The finalized lifecycle-plan history is
`4d40e9b4a01d0d7042da15ca36c7e63aa5cdb833..85427bd45e7a255eb6ba06825b8ae21d8bb5b4b3`.
The blocker-recheck amendment range is
`85427bd45e7a255eb6ba06825b8ae21d8bb5b4b3..TASK6_R2_BLOCKER_RECHECK_PLAN_SHA`.
The Task 6 R2 implementation range is
`TASK6_R2_BLOCKER_RECHECK_PLAN_SHA..TASK6_R2_IMPLEMENTATION_SHA`; only the seven paths above
may appear in it. The implementation work already begun under the prior binding plan stays
uncommitted and may resume only after this blocker-recheck amendment receives fresh Luna and
independent Sol binding PASS. `src`, migrations, scripts, Make, workflow, `bunfig.toml`,
package manifests/lock, `tsconfig.json`, protected data/settings, and every prior frozen
range remain unchanged.

The paused implementation's authoritative full-suite RED is:

~~~text
1056 pass / 1 skip / 3 fail / 9647 assertions / 1060 tests / 51 files
abrupt owned child: wrapper exit 1
two simultaneous wrappers: wrapper exit 1
global afterAll: test_database_cleanup_failed
~~~

The fail-closed classifier observed a real foreign-role shape
`{ pid: number, usename: "minime_engineer_ro", backend_type: null }`. PostgreSQL hides
another role's backend details from this non-superuser posture; the NULL is not permission
to force the session. Five fenced generated targets were recovered through the approved
adapter and final guarded/source/process residue was zero. The classifier must remain
unchanged and fail closed for this row.

The first lifecycle-focused gate exposed a separate test-runner constraint. On Bun 1.3.13,
`--rerun-each` reloads only the test entrypoint in the same VM; preload and imported
database modules remain cached, while preload hooks run for each repeat. The first M15
repeat passed, setup then correctly drained/closed/disposed its process-owned resources,
and later repeats encountered those closed cached resources. Bun exposes no supported JS
API for the final repeat count. An experimental own-process `ps` command-line inspection
made the single-file case pass 230/0/1050, but is rejected: it is OS-coupled, misses
bunfig-driven repeats, and cleans at the wrong point for multi-file repeats. No command-line
introspection, hardcoded repeat count, deferred process cleanup, or per-test pool churn may
enter the implementation.

The corrected lifecycle registry then passed focused tests, migration-context tests, and
ten fresh M15 processes, but repeated real gates exposed a deeper teardown race. The first
foreign disposal saw its expected named foreign PID; after awaited client shutdown, retry
saw a distinct positive PID whose `usename` and `backend_type` were both hidden/NULL.
Abrupt, simultaneous, bootstrap-failure, SIGINT, and SIGTERM paths intermittently returned
the same fixed cleanup failure. Under least privilege the row cannot be distinguished from
server-owned background activity. The classifier correctly blocked it, but the former plan
simultaneously forbade blocker rechecks and required immediate retry success. Binding Sol
therefore stopped implementation with Critical 1. Diagnostic fields/output were removed;
all guarded leftovers were recovered through the approved adapter and current
guarded/source activity is zero.

This amendment preserves classification and removes `WITH (FORCE)` completely. A fenced
target receives bounded, condition-based complete reclassification. Ordinary
`DROP DATABASE` is attempted only after a safe snapshot. If background activity appears
after that snapshot, ordinary drop returns busy rather than terminating an unclassified
process, and a fresh bounded cycle reclassifies from scratch.

- [ ] Step 1: Add deterministic teardown REDs.

Add an injected test clock:

~~~ts
export interface TestDatabaseRetryClock {
  delay(milliseconds: number): Promise<void>;
}

export function createDefaultTestDatabaseDeps(
  factory: AdapterFactory = postgresFactory,
  clock: TestDatabaseRetryClock = systemRetryClock,
): TestDatabaseDeps;
~~~

Bind these exact constants:

~~~ts
const TEARDOWN_MAX_CYCLES = 20;
const TEARDOWN_RECHECK_INTERVAL_MS = 100;
const TERMINATE_TIMEOUT_MS = 1_000;
~~~

This is exactly 20 complete snapshots and at most 19 scheduled waits / 1.9 seconds. Fake
tests use an injected zero-wall-clock clock. Add these fail-first cases:

1. blocker snapshot → `delay:100` → empty snapshot → ordinary drop;
2. a persistent complete blocker produces 20 snapshots, 19 delays, zero termination/drop,
   fixed failure, and leaves the same branded handle fenced/retryable for a later successful
   disposal;
3. PID `96460` foreign/hidden → PID `96462` fully hidden → PID `96463` positively eligible
   proves PID change grants no identity continuity, delays twice, terminates only `96463`,
   then ordinarily drops;
4. first-snapshot and blocker→delay→second-snapshot SQL/protocol/malformed errors stop
   immediately with no later delay or destructive call;
5. visible autovacuum and parallel workers remain blockers, are never terminated, and must
   disappear before ordinary drop;
6. safe snapshot → ordinary drop SQLSTATE `55006` consumes one shared cycle, delays once,
   and requires a completely fresh snapshot; persistent `55006` yields 20 snapshots/drop
   attempts and 19 delays, with no final trailing delay;
7. logical-replication, custom, unknown, and mixed eligible-plus-blocker snapshots each
   perform zero termination/drop while blocked and require a later complete safe snapshot;
8. duplicate PID rows and every termination SQL/protocol/missing/duplicate/unexpected-PID/
   non-boolean result fixed-fail immediately after the one complete safe snapshot, with
   zero delay and zero ordinary-drop call;
9. blocker → injected clock rejection fixed-fails after one snapshot with zero termination/
   drop and no later snapshot; `55006` → injected clock rejection records only the already
   attempted ordinary drop and performs no later snapshot/destructive call;
10. a non-`55006` ordinary-drop error fixed-fails after one safe snapshot and one ordinary
    drop attempt, with zero delay and no later snapshot/termination/drop;
11. post-clone extension-assertion and provisioning-admin-close rollback use the same
   fence/reclassify/ordinary-drop contract, preserve cleanup-error precedence, and never
   mint or forge a public handle; and
12. clone rejection/collision never establishes rollback ownership, fences, terminates, or
   drops a target.

Trace assertions must prove:

~~~text
fence exact generated target
complete snapshot
blocker → delay → fresh complete snapshot
OR zero blockers → terminate only eligible same-role clients → ordinary drop
~~~

No SQL may contain `WITH (FORCE)`. Any blocker snapshot must make termination and drop
behaviorally unreachable in that cycle.

- [ ] Step 1.5: Register and drain test-owned auxiliary database pools.

In `test/setup.ts`, add a pure closer-registry factory plus the singleton registration
interface:

~~~ts
export type TestDatabaseCloser = () => Promise<void>;

export function createTestDatabaseCloserRegistry(): {
  register(closer: TestDatabaseCloser): () => void;
  drain(): Promise<void>;
};

export function registerTestDatabaseCloser(
  closer: TestDatabaseCloser,
): () => void;
~~~

Registration is synchronous. Drain snapshots the registered closers and invokes every
registration in that snapshot exactly once. Each invocation must be deferred/wrapped so a
nominal Promise closer that throws synchronously cannot abort invocation of the remaining
closers. Drain uses `Promise.allSettled` to settle every invocation, shares one promise
across concurrent/repeated calls, and exposes only `test_database_cleanup_failed` if any
closer throws or rejects.
Registrations are distinct records/tokens: registering the same closer function twice
creates two registrations, each independently removable and each invoked once if present
in the snapshot. A `Set<TestDatabaseCloser>` that deduplicates by function identity is not
compliant.
Unregister before the drain snapshot removes that registration; unregister at or after
drain start is an idempotent no-op against the frozen snapshot. Registration after drain
begins fails fixed/content-free.

In `test/m15.roles.test.ts`, register the `minime_engineer_ro` pool immediately after
construction and before its first query. Wrap `ro.end({ timeout: 5 })` in one memoized
`closeRoOnce()` promise. Both the local `afterAll` and the setup registry invoke that same
function; the underlying `ro.end({ timeout: 5 })` operation executes once even if both paths
invoke the memoized wrapper. `closeRoOnce()` or the local hook must map every synchronous
throw or rejection to `test_database_cleanup_failed`, so no Bun hook ordering can expose a
raw or secret-bearing close error. Local `afterAll` unregisters only after successful
closure. One pool remains shared by all tests in that file/process. Each fresh-process
repeat naturally receives fresh module, registry, application-pool, database, and M15-pool
state; do not attempt to support Bun's same-VM `--rerun-each` replay by deferring process
cleanup or reopening per test. Do not change the role, credentials, application name,
grants, RLS, database policy, query bodies, or shared-pool test semantics.

The setup cleanup order is exactly:

~~~text
drain registered test-owned pools
close application pool
dispose retained branded database
~~~

Both pool-close phases must be attempted even if either fails; on every non-keep path,
disposal must still be attempted afterward. Any auxiliary-closer/application-pool/disposal
failure combination exposes only `test_database_cleanup_failed`, including through M15's
local hook. When bootstrap itself fails, preserve the original bootstrap error only if all
cleanup phases succeed; otherwise the fixed cleanup error takes precedence.

The frozen forensic exception remains exact: when `MINIME_KEEP_TEST_DATABASE=1` and the
retained database was created by this process, drain registered pools and attempt the
application-pool close, then skip disposal and print only the validated guarded name. This
is the only exception to the final disposal phase. Close failure on this path is still
fixed/content-free and cannot reveal its cause.

These rules apply to normal `afterAll`, bootstrap failure, SIGINT, and SIGTERM through the
existing once-only cleanup path. Do not rely on Bun hook registration order, file ordering,
auxiliary-pool close waits/retries, foreign termination, or broader stats permissions. The
only teardown wait is the injected 20-cycle database blocker/`55006` budget in Step 3.

`bootstrapTestDatabase()` is also an exported fake-handle test seam used by
`test/migration-context.test.ts`. Do not make every injected fake-handle cleanup drain the
process singleton: that would permanently close registration mid-suite and reintroduce file
order dependence. Add an injected drain dependency whose default is a fresh/no-op test
drain for those existing fake callers. The top-level retained production bootstrap, normal
`afterAll`, and signal path must explicitly receive the singleton registry drain. Prove the
fake seam cannot consume singleton state and the retained production path cannot omit it.
Do not modify `test/migration-context.test.ts`.

Add deterministic tests proving every snapshotted registration is invoked exactly once even
when another synchronously throws or asynchronously rejects; concurrent/repeated drains
share work; the M15 underlying close executes once even if its memoized wrapper is invoked
from both hooks; unregister works at both sides of the snapshot boundary; and late
registration plus secret-bearing close errors remain fixed/content-free. Prove cleanup
error precedence over a bootstrap error and source/trace order
registered-pool drain → `closeDb` → disposal on non-keep paths. Retain the keep-forensics
test and prove registered-pool drain → `closeDb` → skip disposal → print only the guarded
name. Prove fake-handle bootstrap cleanup leaves the singleton open for later registration
while retained production bootstrap uses the singleton drain. Add the exact hidden
foreign-row fixture above and prove zero termination and zero ordinary-drop calls while it
remains present.

- [ ] Step 2: Implement the ownership-safe connection fence and classification.

This path is permitted only after `generatedName(databaseName)` succeeds and one of two
module-private ownership proofs exists:

1. a retained module-branded handle with `createdByThisProcess === true`; or
2. an immutable, revalidated generated plan plus the local
   `cloneSucceeded === true` fact set immediately after the same invocation's successful
   `cloneFromInstallerTemplate()` call.

The second proof exists only for internal post-clone rollback before handle mint. Its
helper must share the exact fence/reclassify/terminate/ordinary-drop implementation, remain
module-private, accept no public handle or arbitrary name, mint or forge no brand, and
never infer ownership from a later `exists()` result. Extension-assertion failure may use
it on the still-open provisioning admin; provisioning-admin-close failure may use it only
through the existing reconnect rollback with the same immutable plan/provenance. A clone
rejection/collision never sets `cloneSucceeded` and can only close the admin connection.

External handles/plans, `minime`, `minime_test`, unguarded names, forged handles, and
post-hoc catalog existence never enter the teardown path.

On the reserved admin connection, first fence only the exact validated target:

~~~sql
ALTER DATABASE "<validated_generated_name>" WITH ALLOW_CONNECTIONS false
~~~

Then query only `pid`, `usename`, and `backend_type` for that exact database. Do not
retrieve query text, client addresses, application names, URLs, credentials, or application
data. A structurally valid row has exactly those three keys, a unique positive integer PID,
and `usename` / `backend_type` values that are either NULL or non-empty strings. NULL is
valid blocker evidence under least-privilege visibility; it is not malformed protocol.

Only `backend_type = 'client backend' AND usename = current_user` is eligible. Everything
else is a blocker: visible foreign clients, hidden/NULL fields, autovacuum and parallel
workers, logical/custom/unknown workers, and mixed snapshots containing eligible clients
plus any blocker. Classify the complete snapshot before acting. A disappearing or changed
PID grants no continuity, ownership, or eligibility.

- [ ] Step 3: Make bounded ordinary drop the authoritative operation.

Hold one reserved admin connection from the exact-target fence through every snapshot,
termination attempt, ordinary drop, delay, and final close. Fence once; a later caller may
re-fence the same retained handle idempotently. For each of exactly 20 cycles:

1. revalidate the immutable generated target and ownership proof;
2. query and validate one complete activity snapshot;
3. if any blocker exists, issue neither termination nor drop, then call
   `clock.delay(100)` unless this is cycle 20;
4. if zero blockers exist, call positive-timeout `pg_terminate_backend` only for every
   positively classified same-role client PID and validate the complete result; then issue
   ordinary `DROP DATABASE "<validated_generated_name>"`.

A well-formed termination boolean false is a known-safe delivery timeout: the target is
fenced and ordinary drop will return busy rather than force an unclassified session. A
termination SQL/protocol error, missing/duplicate/unexpected PID, or non-boolean result
fails immediately before drop.

Successful ordinary drop alone marks disposal. SQLSTATE `55006` consumes the current shared
cycle; unless it was cycle 20, delay 100 ms and begin a completely fresh snapshot cycle.
Never cache a safe classification across termination, drop, delay, or a new admin
connection. A cycle-20 blocker or `55006` has no trailing delay. Persistent blocker/busy
state, prepared transactions, logical slots/subscriptions, permissions, clock rejection,
unexpected server error, or close failure before deletion exposes only
`test_database_cleanup_failed` and leaves a minted handle live, fenced, and retryable.

If admin close fails after successful drop, the handle remains disposed and only the fixed
cleanup error escapes. Post-clone/pre-mint rollback may hold the template advisory lock
through at most 1.9 seconds of clock delay; persistent blockage returns the fixed cleanup
error, mints no handle, and leaves the exact target fenced. Extension-assertion rollback
preserves its original error only when teardown and close succeed. Provisioning-admin-close
rollback preserves the original close error only when reconnect teardown succeeds.

Remove the prior force-drop retry constants/state and every `WITH (FORCE)` path. Do not
broadly suppress errors, broaden eligibility, terminate any blocker, add caller sleeps, or
rely on client polling as proof of deletion. Prove PostgreSQL 16 compatibility for
`ALLOW_CONNECTIONS`, positive-timeout termination, ordinary `DROP DATABASE`, and SQLSTATE
`55006`.

- [ ] Step 4: Add real foreign-client and abrupt-child lifecycle proofs.

For the foreign-client proof, provision one real generated target, connect
`minime_engineer_ro` to that exact target, and prove the first disposal fences and retains
the target, returns only the fixed cleanup error, and does not terminate the foreign
session. The deliberate first failure consumes 20 snapshots and 19 real 100 ms waits; do
not assert wall-clock time. Prove the still-connected foreign session answers one
identity-only PID query with its original PID. Then await its close, retry the same branded
handle through a fresh admin connection, re-fence idempotently, and prove any distinct
anonymous PID remains a blocker until it disappears; the exact target is removed only after
a safe snapshot. Stop if the engineering role cannot connect as expected; never change
grants to make the test pass.

Extend `owned-db-child.ts` with a test-only abrupt mode whose postgres.js options set:

~~~ts
connection: { application_name: "minime-test-abrupt-owned-child" }
~~~

It may report only its own PID, `current_user`, `backend_type`, the fixed application name,
guarded database name, and migration/extension facts, then call `process.exit(0)` without
`sql.end()`. Do not report query text, URLs, credentials, source names, or row content.

Run the real wrapper case repeatedly with independent existing 30-second bounds and prove:
the identity is `minime` / `client backend` / the fixed application name; the wrapper
observes child exit before disposal; every exact generated target is absent afterward;
source-template ownership/activity is unchanged; and stdout/stderr remain source/content
free. Include abrupt, two-simultaneous, bootstrap-failure, SIGINT, and SIGTERM cases in the
focused real gate. The historical binding failures are process-level REDs; deterministic
fakes must fail on old code even when an intermittent real case passes.

- [ ] Step 5: Run complete gates and commit.

~~~bash
bun test test/test-database-isolation.test.ts \
  --test-name-pattern "blocker|ordinary drop|classification|55006|clock rejection|termination result|rollback|cleanup|registered database closers|setup cleanup contract"
(
  set -e
  for run in {1..10}
  do
    bun test test/m15.roles.test.ts
  done
)
bun test test/eval-database-isolation.test.ts \
  --test-name-pattern "abrupt owned child|two simultaneous wrappers|real bootstrap failure|real SIGTERM|real SIGINT|foreign engineer"
bun test test/m15.roles.test.ts \
  test/test-database-isolation.test.ts \
  test/eval-database-isolation.test.ts
bun test test/test-database-isolation.test.ts test/eval-database-isolation.test.ts
bun test test/eval-database-isolation.test.ts
bun test test/h3-restore-scripts.test.ts
bun test test/update-bootstrap.test.ts test/update.test.ts test/backup.test.ts
make verify-m0-offline
bunx --package typescript@5.9.3 tsc --noEmit --pretty false
bun test
bunx biome check \
  test/setup.ts \
  test/m15.roles.test.ts \
  test/support/test-database.ts \
  test/test-database-isolation.test.ts \
  test/eval-database-isolation.test.ts \
  test/fixtures/owned-db-child.ts
bash -n scripts/eval-pmb.sh
rg -n -i 'with\s*\(\s*force\s*\)|pg_read_all_stats|client_addr|application_name|select .*query' \
  test/support/test-database.ts
git diff --check
~~~

The static safety `rg` must return no matches. After every real/full gate require guarded
database count zero, source-template activity zero, no wrapper/owned-child/test process,
native role `f|t|t`, and no provider-capable eval or egress. Do not delete residue to make
an acceptance check pass; any residue is a failed gate.

The implementation report must replace every stale force-drop claim and record the
historical REDs, deterministic cycle RED/GREEN counts, foreign-client and anonymous-PID
evidence, abrupt/simultaneous/bootstrap/signal evidence, exact
fence/reclassification/termination/ordinary-drop semantics, PostgreSQL 16 compatibility,
fresh gate counts, fixed-output proof, protected empty diff, residue, and commit note.
Commit exact message
`test: make owned database teardown authoritative`.

At exact `TASK6_R2_IMPLEMENTATION_SHA`, the executor, fresh Luna, and independent Sol must
each supply a separate full-suite run, giving at least three independent exact-HEAD runs.
Fresh Luna and Sol jointly bind:

1. Task 5 updater bridge:
   `09fcdb459a6dbba86478acc77fc9c6ded3612802..06e1e1fc5fc81d96e9078decf31224a543a5880d`;
2. original Task 6:
   `72f7c198763278ad83d0ffbc51681d1c4ae66f02..3c3f196e71d3eec977a3d7c451da85f6282e78be`;
3. frozen Task 6.5:
   `4520380f9f41a8507982d7783668f3155013a020..e210235ea9ab7b6c368420ad25e82b3f24d6d81b`;
4. frozen Task 6 I-1:
   `4e685e06127e2ed2a5efded951cc933cabe8b6c1..fa8ecc3e7f8025439ebbfbb7ef969a7e66064aac`;
5. frozen Task 6.75:
   `39d42b9d9ebdee8bc56f96b90542aed42336d8ab..161602601ae3695af9b1af91b06d530cb205d9c5`;
6. Task 6 R2:
   `TASK6_R2_BLOCKER_RECHECK_PLAN_SHA..TASK6_R2_IMPLEMENTATION_SHA`; and
7. combined runtime/typecheck evidence at exact `TASK6_R2_IMPLEMENTATION_SHA`.

The final verdict must explicitly state `Task 5 updater bridge PASS`, `Task 6 PASS`,
`Task 6.5 PASS`, `Task 6.75/typecheck readiness PASS`, combined acceptance PASS, and
Critical 0 / Important 0 / Minor 0 before the closure-only ledger/review-artifact commit
or Task 7.

Stop and replan if a blocker persists through 20 cycles in a required real gate, or evidence
identifies a prepared transaction, logical slot/subscription, or need to change
grants/application behavior; if any `WITH (FORCE)` path exists; if a blocker snapshot can
reach termination/drop; if fixed content-free failures or PostgreSQL 16 compatibility
cannot be proved; if any protected path changes, provider egress opens, full gate fails, or
residue remains;
if lifecycle correctness requires inspecting the OS command line, detecting/hardcoding a
runner repeat count, deferring normal process teardown, or reopening M15 per test;
or if the proof requires user data, query text, URLs, credentials, or other sensitive
content.

---

### Task 7: Make the local and CI gate authoritative

Task 7 starts only after Task 6 R2 and the joint Task 5/6/6.5/6.75/R2 closure pass at one
exact candidate and the closure-only ledger/review-artifact commit is recorded.

Files:
- Create: test/verify-contract.test.ts
- Modify: package.json
- Modify: bun.lock
- Modify: tsconfig.json
- Modify: Makefile
- Modify: .github/workflows/eval.yml
- Modify: CLAUDE.md
- Modify: AGENTS.md
- Modify: README.md

Package scripts and exact TypeScript pin:
~~~json
{
  "scripts": {
    "minime": "bun run src/cli.ts",
    "test": "bun test",
    "lint": "biome check .",
    "format": "biome check --write .",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.4",
    "@types/bun": "^1.2.0",
    "typescript": "5.9.3"
  }
}
~~~

Make contract:
~~~make
.PHONY: format typecheck verify-m0-offline verify-offline
lint:
	@bun run lint
format:
	@bun run format
typecheck:
	@bun run typecheck
verify-offline: verify-m0-offline test lint typecheck check-subsystems
verify: verify-offline eval-search
~~~

Focused verify-m0 through verify-m15 remain available but are not prerequisites of full verify because one unscoped test includes them. The dry-run contract asserts exactly one unscoped bun test; no scoped milestone command; wrapper-owned verify_m0 before src/verify/m0.ts; mock mode for offline M0; standalone live-capable verify-m0; biome check . never --write; tsc --noEmit; scripts/check-subsystems.ts; wrapped scripts/eval-search.ts; and no createdb/shared minime_test/legacy minime_eval.

- [ ] Step 1: Write dry-run RED test.
~~~bash
bun test test/verify-contract.test.ts
~~~
Expected RED: scoped milestone prerequisites, mutating lint, and missing TypeScript.
- [ ] Step 2: Apply exact package/Make contracts.
~~~bash
bun add --dev --exact typescript@5.9.3
bun install --frozen-lockfile
~~~
Keep tsconfig scoped to src, test, and fixtures in S0; S5 decides whether operational scripts enter compiler gate. Do not weaken strict or noUncheckedIndexedAccess.
- [ ] Step 3: Align CI/documentation. Eval workflow invokes one make verify; docs call verify-offline fast merge gate and verify final gate.
- [ ] Step 4: Run complete gate and commit.
~~~bash
bun install --frozen-lockfile
make verify-offline
make verify
git diff --check
~~~
Expected all gates pass; Biome changes no file; no provider socket opens in verify-offline; manifests add only exact TypeScript 5.9.3. Commit with ci: make full offline verification authoritative.

### Task 7.5: Stabilize the redaction assertion exposed by the binding gate

Task 7.5 is a review-gate amendment, not a production redaction change. It starts only after
the independent Sol final review records the exact `a79be392b11f26d7a4f54de7a5961e4a1aa4eaaf`
failure and fresh Luna advisory plus independent Sol binding review PASS this amendment at one
exact plan SHA.

The exact final `make verify` failure is:

```text
test/m2.tools.test.ts:232
expect(raw).not.toContain("4111")
```

The card payload was correctly redacted. A separately seeded page UUID
`40f475e9-7ebe-450c-a22b-fdb294111fcd` happened to contain the unrelated four-digit substring
`4111`. The focused wrapper-owned M2 rerun passed, proving the gate is sensitive to random UUID
text rather than leaked card content. The current assertion is therefore broader than the secret
it claims to protect and makes the new authoritative gate nondeterministic.

Files:
- Modify: `test/m2.tools.test.ts`
- Update:
  `.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-7-report.md`
- Create:
  `.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-7.5-redaction-flake-brief.md`
- Create:
  `.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-7.5-redaction-flake-report.md`

The implementation is exactly one semantic assertion change: require the raw MCP response not
to contain the complete planted card secret `4111 1111 1111 1111`, matching the existing full
IBAN and account-number assertions. Keep the positive `[REDACTED:card]` and
`[REDACTED:iban]` assertions. Do not change `src/mcp/redact.ts`, product behavior, fixtures,
seed generation, UUID preservation, database harnesses, packages, Make, TypeScript, workflow,
documentation outside the named report, or any other test.

This Task 7.5 contract explicitly supersedes only the failure artifact's suggestion to add a
fixed/legal UUID case and “all three redaction markers.” The baseline integration test has two
positive marker assertions (`card`, `iban`) plus the complete account-number absence assertion;
it has no account-marker assertion to retain. `test/redact.test.ts` already proves UUID
preservation, the saved failed raw response proves that a legal UUID can contain `4111`, and
testing the complete PAN is logically immune to an unrelated four-digit UUID substring. Do not
add a marker, fixture, fixed UUID, helper, or second test change. The failure artifact remains
historical evidence; this reviewed amendment is the implementation authority.

- [ ] Step 1: Preserve the exact binding failure above as RED evidence and write the brief.
- [ ] Step 2: Apply only the complete-card assertion change.
- [ ] Step 3: Run this exact pre-commit acceptance sequence:
  ```bash
  bun install --frozen-lockfile
  (
    set -e
    for run in {1..20}
    do
      MINIME_MOCK_OLLAMA=1 bun test test/m2.tools.test.ts \
        --test-name-pattern \
        'redaction: card numbers, IBANs, long account numbers never leave the server'
    done
  )
  MINIME_MOCK_OLLAMA=1 bun test test/m2.tools.test.ts
  /usr/bin/time -p make verify
  ```
  This must create exactly 20 independent Bun processes. Each process receives the normal
  `bunfig.toml` preload and its own guarded database, passes the one named case once, and exits
  naturally (`20/20`, zero failure); the isolated `set -e` subshell exits on the first nonzero
  run. The complete M2 file must pass `12/0/67`. Record exact full-gate counts and duration.
- [ ] Step 4: Commit with `test: make card redaction assertion exact`.
- [ ] Step 5: Run this exact immutable-candidate sequence:
  ```bash
  git rev-parse HEAD
  /usr/bin/time -p make verify
  git diff --check
  git status --short
  ```
  The recorded SHA must be the single implementation commit from Step 4. The second full gate
  must be a separate natural-exit command, not a retry substitution, and must exit 0 with
  Biome, exact TypeScript 5.9.3, subsystem, and MinimeBench gates green. Prove zero guarded
  database/source/process/provider residue, unchanged `minime` `f|t|t` posture, unchanged
  dependency manifests, and no path outside the four-entry ledger above.
- [ ] Step 6: Obtain a fresh Luna implementation rereview and independent Sol final binding
  review at the same exact candidate SHA. Any Critical or Important finding reopens the
  fix/re-review loop; final closure requires Critical 0 / Important 0 / Minor 0.

Stop if the exact failure cannot be reproduced from the saved binding output, if the complete
card value appears in the raw response, if any production redaction path changes, if the focused
case fails after the assertion correction, if any additional test is edited, or if plan review
requires a broader flake-hardening sweep. Also stop on a competing gate process, an early loop
failure, any focused/full gate failure, or database/source/provider/process residue. Do not weaken
the full-secret, IBAN, account-number, or existing positive redaction-marker assertions.

## Acceptance and Rollback

Acceptance:
- Full bun test is green in a fresh process and every automated process uses a disposable guarded database.
- Two simultaneous test commands use distinct databases; success, failure, and signal paths leave no owned database.
- The minimal pre-S0 updater can fetch new code but cannot apply 021 without context; rerunning supplies context only after taken or genuinely unconfigured.
- verify-offline runs wrapper-owned mocked M0 plus every test file through one unscoped run; standalone verify-m0 remains live-capable; verify adds retrieval regression.
- CI and local development execute the same gate, lint is non-mutating, and strict typecheck is enforced.

Rollback:
- Task 1 is code/test only.
- Tasks 2–4 may roll back only before any post-S0 numbered migration is applied.
- Tasks 5–6 own only disposable guarded databases and temporary transition repositories.
- Task 6.5 is one file-local test-harness timeout plus evidence; it changes no production
  script, global test policy, database, package, or configuration.
- Task 7 may be reverted as one dependency/gate commit; no production schema/data change occurs.

## Stop Conditions

Stop before implementation if the docs amendment path ledger differs, binding plan review does not PASS, the worktree does not start at the new plan SHA, or a new ledger identifies another plan/commit. Stop during implementation on any live/shared/legacy database connection, pre-isolation unscoped test, Task 1 create/extension/drop failure, Task 2/3 real DB connection, missing normal cleanup, deferred baseline failure, tracked 021 migration, eval context, child-owned drop, copied updater logic, backup failure followed by fetch/migrate, wrapper/cleanup failure, offline M0 without unique DB plus mock mode, package edits before Task 7, dependency changes beyond TypeScript 5.9.3, or unresolved plan-mandated review conflict. Also stop on any direct or transitive reset caller missing from wrapper coverage; eval-skills or optimize-skill retaining createdb, direct extension SQL, or minime_eval_skills; LongMemEval matching the destructive exclusion regex while remaining unwrapped; any static src/ import in scripts/with-test-database.ts; migration import/call before owned DATABASE_URL assignment; child spawn before successful test-context migration and parent closeDb(); child spawn after migration/bootstrap/close failure; failure to attempt branded disposal on any bootstrap outcome; or any change to standalone src/verify/m0.ts or make verify-m0. After capped review round 5, stop for owner direction if any load-bearing spec gap or Important/Critical finding remains unresolved.

Task 6.5 is the sole exception to the original Task 6 path ledger and only after its
plan-only amendment receives fresh Luna advisory and independent Sol binding PASS at the
exact plan SHA. It authorizes only the file-local H3 timeout interface and report above.
No owner waiver, global timeout, retry, production/script change, or Task 7 work may be
substituted for the joint green acceptance.

Stop and report BLOCKED if any of these occurs:

- minime_test is absent, not loopback-local, not owned/readable by the configured Minime
  installation, or lacks either required extension;
- any source connection exists when cloning starts; do not terminate it or retry in a loop;
- the runtime role cannot clone from the source with CREATEDB;
- a caller can choose the template, owner, advisory key, or arbitrary database name;
- provisioning creates extensions, requires superuser, alters the source, marks it as a
  template, or connects any test/eval/M0 child to it;
- the implementation assumes minime_test is schema-empty, copies/asserts row contents, or
  attempts to sanitize the source;
- advisory serialization does not use one reserved session, or closing that session does not
  release the lock;
- busy/collision/extension/cleanup outcomes expose a URL, SQL, server detail, or secret;
- external mode is adopted or dropped, or Task 6 inherits external mode;
- Task 1 setup/drop failure is reported as test RED/GREEN;
- CI removes the sole template bootstrap without replacing it with an equivalent
  environment-owned template guarantee;
- the preserved test/m14.extract-validate.test.ts edit is reverted, reformatted beyond its
  Task 1 regression, or mixed into a plan-only commit;
- any file outside the exact S0 plan changes while amending this contract.

If the clone probe stops working on any supported PostgreSQL 16/17 install after source
connections are zero, stop for owner direction. Do not fall back to superuser extension
creation, shared minime_test, template0, minime, legacy minime_eval*, or a caller-supplied
template.

Additional Task 6 and final stop conditions:

- Any pre-clone, collision, clone-rejection, indeterminate-clone, or external-mode path calls
  terminate/drop.
- Any post-clone rollback targets a name other than the exact known-successful generated clone.
- More than the one reviewed CI environment-bootstrap step creates/connects to minime_test or
  creates extensions.
- A Make/runtime/test/eval/M0 child creates, targets, connects to, migrates, terminates, or
  drops minime_test.
- Fresh CI minime posture is not exactly f|t|t.
- Any CI child gate authenticates as postgres or receives the service-admin password/DSN.
- Runtime provisioning reads or branches on rolsuper, invokes role mutation, or requires a
  superuser-only operation.
- S0 modifies docker-compose.yml, scripts/lib.sh, .env*, the S1 plan, or an existing local
  Docker role attribute.
- scripts/install.sh may change only in Task 4 for the already-bound exact
  `migrate --context install` caller wiring; it must not change under Task 6 role-posture,
  template-bootstrap, or demotion work.
- S0 claims that local Docker minime is demoted or already least-privilege runtime.
- The workflow creates a legacy minime_eval* database.

If a fresh binding reviewer requires S0 to demote the existing local Docker minime role, stop
with BLOCK and cite the direct conflict with binding S1 lines 524-543 and Task 4's owned
minime_app cutover. Do not invent a Docker-hardening step in S0.

Protected throughout: .env*, data/, db-dump/, backups, live minime, unrelated untracked files, sibling worktrees, and every other plan's SDD workspace.

## Downstream and Execution Protocol

After this amendment receives binding PASS, create the implementation worktree at its exact PLAN_SHA, install frozen dependencies, and generate a fresh worktree-local SDD ledger whose first line names this plan path and second line records Plan commit: <PLAN_SHA>. Do not reuse the old main-worktree preflight ledger. The pre-isolation baseline is exactly:
~~~bash
git status --short --branch
git diff --check
make -n verify
make -n migrate
bash -n scripts/install.sh
bash -n scripts/update.sh
~~~
Do not run bun test, milestone/verify/install/update/migrate/restore/promotion, or a live DB command as baseline evidence. For every task:

1. Record BASE and generate the task brief.
2. Dispatch one fresh implementer with an explicit model and report path.
3. Require RED/GREEN command output and one task commit.
4. Generate the exact BASE..HEAD review package.
5. Dispatch an independent task reviewer for both spec and quality verdicts.
6. If a spec gap or Important/Critical finding is reported, block the next task, fix only the
   approved finding scope, regenerate the exact package, and obtain a fresh independent
   re-review. Cap this SDD fix/re-review loop at five rounds.
7. Append the exact commit range and review result to the ledger only after findings close.

Tasks run sequentially; the controller never fixes findings or reviews its own work. An
unresolved load-bearing finding after round 5 stops the train for owner direction.

After Task 7 require advisory code/behavior review, Minime invariant review, and binding final review of the exact branch SHA before finishing the branch.

## Final Acceptance Evidence

~~~bash
rg -n 'validateEdges\(' src scripts test
rg -n 'migrate\(|resetDb\(|resetAndSeed\(|seedCorpus\(' \
  src scripts test Makefile
rg -n 'createdb|create extension|minime_eval' \
  Makefile scripts/with-test-database.ts scripts/eval-pmb.sh .github/workflows/eval.yml
rg -n 'minime_test' \
  test/support/test-database.ts scripts/with-test-database.ts \
  Makefile .github/workflows/eval.yml
make -n eval-skills ROUND=r1
make -n optimize-skill SUITE=query ROUND=r1
make -n verify-m0
make -n verify-m0-offline
bun install --frozen-lockfile
make verify-offline
make verify
git diff --check
git status --short
~~~

The create/extension search may match only the one named CI environment-bootstrap step and
existing installer/up establishment outside the searched runtime files. The `minime_test`
search may additionally match the module-private source literal and guarded refusal tests.
No Make/runtime/child match is accepted.

Acceptance requires all validateEdges callers reviewed with only the provider-routing
regression injecting; every migrate caller has an explicit sanctioned context or a
schema-current assertion; every direct or transitive database-reset eval child—including
eval-search, eval-graph-hygiene, eval-pmb, eval-pmb-official, eval-skills, and
optimize-skill—is parent-provisioned under the branded minime_test_* capability, receives
only API test context, and has no createdb/direct-extension/minime_eval* Make path; no covered
Make target, runtime script, test process, offline-M0 child, or eval child creates, targets,
connects to, migrates, terminates, or drops shared `minime_test` or any `minime_eval*`; the
sole exemption is the exact reviewed `.github/workflows/eval.yml` environment-bootstrap step,
running as the CI `postgres` service administrator, which creates `minime_test`, installs its
two extensions, and then exits before any child gate runs. Standalone M0 remains
live-capable while offline M0 is mocked and uniquely isolated; the legacy updater refuses
pending 021 and the checked-out rerun applies it once; all owned databases are gone after
success/failure/signal tests; the one unscoped suite, lint, strict typecheck, subsystem check,
and retrieval eval pass; and only Task 7 changes dependency manifests for exact TypeScript
5.9.3.

The CI exemption does not include Makefile, scripts/with-test-database.ts,
scripts/eval-pmb.sh, any test/eval/M0 child, minime_eval*, a second workflow step, a runtime
fallback, or local installer/up behavior beyond its already-existing reviewed template
establishment.

S0's provisioning implementation requires and exercises only the `CREATEDB` capability. It
is proven with `minime = NOSUPERUSER, CREATEDB, CREATEROLE` on native PostgreSQL and the
fresh CI PostgreSQL service. The exact reviewed CI administrator bootstrap is the sole
`minime_test` source-creation/extension exception. Existing local Docker owner posture is
unchanged and explicitly handed to S1; no S0 runtime code observes or relies on its
superuser bit.

Offline M0 runs only after its parent wrapper sets the owned URL, dynamically imports the
migration API, completes migrate({ kind: "test" }), closes the parent pool, and only then
spawns the unchanged mocked M0 child. Standalone verify-m0 remains unchanged.
