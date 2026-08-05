# S1 Privacy Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make loopback storage, cloud tier ceilings, actor-scoped tier-2 access, runtime
least privilege, engineering reads, and content-free auditing structural guarantees.

**Architecture:** One shared PostgreSQL target validator protects every runtime and
operations entry point. Provider routing validates the final resolved provider. MCP handler
queries run inside actor-scoped database sessions, allowing the normal runtime to move from
the owner role to `minime_app`; content-bearing engineering tables then receive RLS or
sanitized views, and one closed event-payload registry prevents future audit-content leaks.

**Tech Stack:** Bun/TypeScript, postgres.js transactions and AsyncLocalStorage, PostgreSQL
roles/RLS/security-definer functions, numbered migrations 021-022, Bash installer fixtures,
and existing MCP/audit/provider tests.

## Global Constraints

- Tests remain offline. Domain/schema tests use the S0 per-process scratch database;
  cluster-global role mutation is permitted only inside Task 4's private temporary
  PostgreSQL cluster fixture.
- A rejected DSN/provider configuration fails before a socket, provider build, audit egress
  row, migration, dump, restore, or filesystem side effect.
- Error strings contain fixed rules only and never echo DSNs, hosts, credentials, prompts,
  titles, questions, paths, or model output.
- Tier 0 remains insert/aggregate-only. No runtime or engineering role gains tier-0 SELECT.
- MCP attempt/result/disposition audit remains outside handler transactions and survives a
  handler rollback.
- Existing installations are never silently credential-rewritten by `make update`.
- Runtime-role cutover for an existing installation is explicit, recoverable, and
  idempotent.
- Migration 021 may run only through an S0-approved migration context; a pre-S0 updater
  that fetched this branch must stop before applying it and succeed only after rerunning the
  new updater.
- Migration 021 must merge before migration 022.

---

### Task 1: Enforce one loopback-only PostgreSQL boundary

**Files:**

- Create: `src/util/postgres-url.ts`
- Create: `test/h6.postgres-loopback.test.ts`
- Modify: `src/util/config.ts`
- Modify: `src/db/client.ts`
- Modify: `src/util/libpq-service.ts`
- Modify: `scripts/libpq-service.ts`
- Modify: `test/h3-libpq-service.test.ts`
- Modify: `test/h3-restore-scripts.test.ts`
- Modify: `.env.example`
- Modify: `AGENTS.md`
- Modify: `docs/GUIDE.md`
- Modify: `DECISIONS.md`

**Interfaces:**

```ts
export type PostgresUrlRule =
  | "empty"
  | "scheme"
  | "syntax"
  | "multi_host"
  | "host_override"
  | "non_loopback_host";

export class PostgresUrlError extends Error {
  readonly rule: PostgresUrlRule;
}

export interface LocalPostgresDsn {
  readonly connectionString: string;
  readonly libpqParameters: ReadonlyMap<string, string>;
}

export function validateLocalPostgresDsn(raw: string): LocalPostgresDsn;
```

Accepted targets are literal `localhost`, canonical `127.0.0.0/8`, and bracketed `::1`.
`localhost` is normalized to a literal loopback connection target. Reject DNS aliases, LAN
or public addresses, comma-separated hosts, Unix sockets/no-host URIs, and query overrides
including `host`, `hostaddr`, `service`, and `servicefile`.

`parsePostgresUri()` remains the syntax parser. Every service-file writer consumes:

```ts
validateLocalPostgresDsn(raw).libpqParameters
```

with no bypass option.

- [ ] **Step 1: Write the shared corpus tests**

Cover accepted loopback spellings and reject:

```text
postgres://u:p@10.0.0.5:5432/minime
postgres://u:p@db.internal:5432/minime
postgres://u:p@localhost.evil:5432/minime
postgres://u:p@localhost,example.com:5432/minime
postgres://u:p@localhost:5432/minime?host=example.com
postgres://u:p@localhost:5432/minime?hostaddr=8.8.8.8
postgres:///minime?host=/var/run/postgresql
```

Assert errors expose only `PostgresUrlError.rule`.

- [ ] **Step 2: Write process and shell leak-wire tests**

A child importing config with a fictional remote DSN must exit before connection and omit
the password from stderr. The libpq bridge must create no file. Restore/promote fixtures must
reach no fake `psql` or `pg_dump`.

- [ ] **Step 3: Prove the tests are red**

```bash
bun test \
  test/h6.postgres-loopback.test.ts \
  test/h3-libpq-service.test.ts \
  test/h3-restore-scripts.test.ts
```

Expected: remote and override cases are currently accepted.

- [ ] **Step 4: Implement and apply the single validator**

Validate `config.databaseUrl` before `postgres()` is called. Apply the same validator inside
the libpq service boundary so backup, repair, drill, restore, and promotion inherit it.

- [ ] **Step 5: Run focused and environment gates**

```bash
bun test \
  test/h6.postgres-loopback.test.ts \
  test/h3-libpq-service.test.ts \
  test/h3-restore-scripts.test.ts \
  test/h3-data-root.test.ts
make verify-m0
```

- [ ] **Step 6: Record and commit**

Append the owner-approved I1 closure to `DECISIONS.md`.

```bash
git add \
  src/util/postgres-url.ts src/util/config.ts src/db/client.ts \
  src/util/libpq-service.ts scripts/libpq-service.ts \
  test/h6.postgres-loopback.test.ts test/h3-libpq-service.test.ts \
  test/h3-restore-scripts.test.ts .env.example AGENTS.md docs/GUIDE.md DECISIONS.md
git commit -m "fix: enforce loopback-only postgres targets"
```

---

### Task 2: Enforce `CLOUD_MAX_TIER` after fallback resolution

**Files:**

- Modify: `src/llm/index.ts`
- Modify: `test/m13.provider-routing.test.ts`
- Modify: `.env.example`
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`
- Modify: `DECISIONS.md`

**Interface contract:**

```ts
export function classifyRouteForTier(tier: 1 | 2): ProviderName;
export function validateProviderRoutes(): void;
```

Resolve first:

```ts
const resolved = route ?? config.classifyProvider;
```

Then validate `resolved` is known and reject it when it is cloud and
`tier > config.cloudMaxTier`. This happens before `build()`, egress audit, or network.

- [ ] **Step 1: Add fallback-ceiling RED cases**

Assert:

```ts
config.classifyProvider = "openrouter";
config.providerRouteTier2 = undefined;
config.cloudMaxTier = 1;
expect(() => classifyRouteForTier(2)).toThrow(/CLOUD_MAX_TIER/);
expect(() => validateProviderRoutes()).toThrow(/CLOUD_MAX_TIER/);
```

Also cover ceiling 0, invalid fallback provider, local fallback, and explicit local tier-2
override.

- [ ] **Step 2: Add the no-egress classification test**

Call `classify("PRIVATE_SENTINEL")` under the blocked configuration. Assert zero fake-fetch
calls, zero `egress:*` rows, and no sentinel in events.

- [ ] **Step 3: Prove the focused suite is red**

```bash
bun test test/m13.provider-routing.test.ts
```

- [ ] **Step 4: Validate the resolved provider**

Implement the contract without changing provider request shapes or embedding routing.

- [ ] **Step 5: Run dependent suites and commit**

```bash
bun test \
  test/m13.provider-routing.test.ts \
  test/h5-contradiction-scan.test.ts \
  test/h1-note-recovery.test.ts
make verify-m13
git add src/llm/index.ts test/m13.provider-routing.test.ts \
  .env.example CLAUDE.md AGENTS.md DECISIONS.md
git commit -m "fix: enforce tier ceiling on provider fallback"
```

Compatibility: configurations that used a cloud fallback above the declared ceiling must
set `PROVIDER_ROUTE_TIER2=ollama` or explicitly raise the ceiling. This deliberate refusal is
documented in the decision entry.

---

### Task 3: Scope database reads to the MCP actor

**Files:**

- Create: `test/db-actor-session.test.ts`
- Create: `src/mcp/unlock-capability.ts`
- Create: `test/unlock-capability.test.ts`
- Modify: `src/db/client.ts`
- Modify: `src/db/repo.ts`
- Modify: `src/mcp/tools/registry.ts`
- Modify: `test/privacy-hardening.test.ts`
- Modify: `test/m6.leak.test.ts`
- Modify: `test/h4-audit-state.test.ts`
- Modify: `test/h4-audit-transport.test.ts`

**Interfaces:**

```ts
import postgres from "postgres";

export type DbPool = postgres.Sql;
export type DbExecutor = postgres.ISql;
export type DbTransaction = postgres.TransactionSql;
export type DbReserved = postgres.ReservedSql;

export interface DbReservation {
  readonly executor: DbReserved;
  release(): Promise<void>;
}

export function db(): DbExecutor;
export function hasDbTransaction(): boolean;

export async function withDbTransaction<T>(
  work: (tx: DbTransaction) => Promise<T>,
): Promise<T>;

export async function withReservedDb<T>(
  work: (connection: DbReserved) => Promise<T>,
): Promise<T>;

export async function reserveDb(): Promise<DbReservation>;

export async function withActorDbSession<T>(
  actor: string,
  work: () => Promise<T>,
): Promise<T>;
```

`src/db/client.ts` owns `AsyncLocalStorage<DbTransaction>`, the `DbPool`, transaction
lifetime, and connection reservation, but contains no SQL. `db()` returns only the common
query surface (`postgres.ISql`): the scoped `TransactionSql` when present, otherwise the
pool. `withDbTransaction()` reuses an active transaction without calling `begin()` again;
otherwise it calls pool `begin()` and installs the returned `TransactionSql` for the
callback. `reserveDb()` always calls `reserve()` on the pool—not on the scoped
transaction—and returns an idempotent reservation handle for S2's long-lived advisory
leases. `withReservedDb()` is its bounded `try/finally` convenience.

`withActorDbSession()` lives in `src/db/repo.ts`, not `client.ts`, so the repository remains
the only application-SQL owner. It rejects an already-active transaction with fixed
`nested_actor_scope`, opens one outer transaction, and executes:

```sql
select set_config('minime.actor', $1, true)
```

All registered MCP handlers pass through one internal wrapper that calls
`withActorDbSession(ctx.actor, handler)`. Attempt/result/disposition audit stays outside that
transaction.

Tier-2 consent becomes an owner-issued capability rather than an agent policy convention:

```ts
export interface UnlockCapabilityClaims {
  actor: string;
  minutes: number;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
}

export function issueUnlockCapability(
  claims: UnlockCapabilityClaims,
  privateKeyPem: string,
): string;

export function verifyUnlockCapability(
  token: string,
  expected: { actor: string; minutes: number; now: Date },
  publicKeyPem: string,
): UnlockCapabilityClaims;
```

The owner runs:

```text
bun run src/cli.ts unlock:grant --actor agent:<client-name> --minutes 5
```

Task 3 implements and unit-tests the capability codec but does not activate it yet; Task 4
adds the one-use database field, provisions the key pair, adds the owner CLI, and changes
`minime_unlock` atomically. This avoids shipping a handler that claims replay protection
before its schema exists.

- [ ] **Step 1: Write actor-session concurrency tests**

Run actors A and B concurrently. Assert each reads its own
`current_setting('minime.actor', true)`, cancellation clears the setting, and a reused pool
connection sees no prior actor. Add compile-time assignments proving a `TransactionSql`
callback is accepted without `begin()`/`reserve()`, and a `ReservedSql` callback exposes
`release()`.

- [ ] **Step 2: Prove the actor-session tests are red**

```bash
bun test test/db-actor-session.test.ts
```

- [ ] **Step 3: Add the typed scoped-client primitive**

Add the four exact type aliases and one `AsyncLocalStorage<DbTransaction>` in
`src/db/client.ts`. Implement `db()`, `hasDbTransaction()`, and
`withDbTransaction()`. Test nested reuse by comparing callback transaction identity; no
savepoint is implied.

- [ ] **Step 4: Add the reserved-connection primitives**

Implement `reserveDb()` directly over the pool with one memoized idempotent release, then
implement `withReservedDb()` over that handle. Test explicit long-lived release plus bounded
success, throw, and cancellation. From inside `withDbTransaction()`, reserve and prove it
receives a separate `ReservedSql`; never cast a `TransactionSql` or expose the pool.

- [ ] **Step 5: Convert privacy, audit, and unlock repository calls**

Replace the module-fixed SQL client with `db()` from `allowedTier()` through the event and
unlock functions. Run:

```bash
bun run typecheck
bun test test/privacy-hardening.test.ts test/h4-audit-state.test.ts
```

- [ ] **Step 6: Convert search, graph, and decision reads**

Convert the search/context, entity/edge, decision, page, and state query sections without
changing SQL text or return shapes.

```bash
bun run typecheck
bun test test/m2.tools.test.ts test/m3.search.test.ts test/m7.graph.test.ts
```

- [ ] **Step 7: Convert capture, task, importer, and metric writes**

Convert the remaining repository functions, then run the write/import/dream suites:

```bash
bun run typecheck
bun test \
  test/m2.tools.test.ts \
  test/m4.importers.test.ts \
  test/m5.decisions.test.ts \
  test/m9.notes.test.ts
```

- [ ] **Step 8: Convert advisory leases and add a fixed-client assertion**

Change bounded repository `sql.reserve()` use to `withReservedDb(connection => ...)`; S2's
returned runtime lease uses `reserveDb()` so its handle owns the connection until explicit
release. Advisory SQL remains in `repo.ts`. Pass plain typed lease inputs into the callback
and construct any `hashtextextended` fragment with that reserved connection; never build a
fragment from `db()` and execute it on another connection. Scan `repo.ts` for direct
use/import of the original pool. The test allows `db()`, `reserveDb()`,
`withReservedDb()`, and explicit callback executors, and rejects direct
`.begin()`/`.reserve()` there.

- [ ] **Step 9: Implement the repository-owned actor session**

In `repo.ts`, reject `hasDbTransaction()`, call `withDbTransaction()`, and run the
parameterized `set_config` SQL on its `DbTransaction` before invoking `work()`. Test same
actor success, nested refusal, rollback, cancellation, and local-setting cleanup.

- [ ] **Step 10: Wrap the MCP handler boundary**

Add one registry-level wrapper that calls `withActorDbSession(ctx.actor, handler)`. Do not
wrap attempt/result/disposition audit. Add a test that enumerates every registered tool,
invokes its handler through the wrapper, and observes the matching actor setting.

- [ ] **Step 11: Write rollback/audit tests**

A throwing handler rolls back its domain write while attempt and terminal audit events
remain. A structural test invokes every registered tool through the single actor wrapper.

Run a cancellation case after `set_config` and prove a later handler on the same physical
pool connection starts locked.

- [ ] **Step 12: Implement and unit-test the capability codec**

```bash
bun test test/unlock-capability.test.ts
```

Use versioned canonical JSON plus Ed25519 from Bun/Node crypto. The owner CLI holds the
private key; MCP receives only the public verification key, so protocol access to runtime
cannot mint a capability. Bind actor, minutes, `issuedAt`, `expiresAt`, and a 256-bit nonce.
Reject an issue time more than 30 seconds in the future, a lifetime over two minutes,
non-canonical encoding, and an invalid signature. This is a pure codec test; database replay
and handler behavior land in Task 4.

- [ ] **Step 13: Run privacy and audit gates**

```bash
bun test \
  test/db-actor-session.test.ts \
  test/unlock-capability.test.ts \
  test/privacy-hardening.test.ts \
  test/m6.leak.test.ts \
  test/h4-audit-state.test.ts \
  test/h4-audit-transport.test.ts
make verify-m2
make verify-m6
```

- [ ] **Step 14: Commit**

```bash
git add src/db/client.ts src/db/repo.ts src/mcp/tools/registry.ts \
  src/mcp/unlock-capability.ts \
  test/db-actor-session.test.ts test/unlock-capability.test.ts \
  test/privacy-hardening.test.ts \
  test/m6.leak.test.ts test/h4-audit-state.test.ts test/h4-audit-transport.test.ts
git commit -m "feat: scope database sessions to mcp actors"
```

---

### Task 4: Cut the normal runtime over to `minime_app`

**Files:**

- Create: `db/migrations/021_runtime_app_role.sql`
- Create: `scripts/harden-runtime-role.ts`
- Create: `test/runtime-role.test.ts`
- Create: `test/runtime-role-install.test.ts`
- Create: `test/runtime-role-cutover.test.ts`
- Create: `test/support/role-cluster.ts`
- Create: `test/unlock-capability-integration.test.ts`
- Create: `src/util/env-file.ts`
- Create: `scripts/run-backup-worker.ts`
- Create: `test/private-env-profile.test.ts`
- Modify: `test/setup.ts`
- Modify: `test/support/test-database.ts`
- Modify: `test/update.test.ts`
- Modify: `test/update-bootstrap.test.ts`
- Modify: `test/migration-context.test.ts`
- Modify: `scripts/lib.sh`
- Modify: `scripts/install.sh`
- Modify: `scripts/update.sh`
- Modify: `scripts/up.sh`
- Modify: `docker-compose.yml`
- Modify: `src/db/repo.ts`
- Modify: `src/db/migrate.ts`
- Modify: `src/pipeline/backup.ts`
- Modify: `src/mcp/tools/unlock.ts`
- Modify: `src/cli.ts`
- Modify: `src/util/config.ts`
- Modify: `test/backup.test.ts`
- Modify: `Makefile`
- Modify: `.env.example`
- Modify: `AGENTS.md`
- Modify: `docs/GUIDE.md`
- Modify: `DECISIONS.md`

**Runtime posture:**

```ts
export interface RuntimeRolePosture {
  currentUser: string;
  superuser: boolean;
  createDb: boolean;
  createRole: boolean;
  bypassRls: boolean;
}

export async function runtimeRolePosture(): Promise<RuntimeRolePosture>;
export function assertRuntimeRolePosture(posture: RuntimeRolePosture): void;
```

Before migration 021, the installer/hardening command must provision the three fixed cluster
roles through the platform PostgreSQL superuser. PostgreSQL 16 permits only a superuser or
an existing `BYPASSRLS` role to grant `BYPASSRLS`; the current native `minime` owner has
only `CREATEROLE`, so ordinary migration SQL cannot safely create the backup posture.
The privileged bootstrap performs role attributes only—never application data or schema.
For a newly created/unhardened live cutover, the two application roles begin `NOLOGIN`:

```text
minime         LOGIN, NOINHERIT, CREATEDB, CREATEROLE, BYPASSRLS
               Docker: SUPERUSER (the image's cluster owner); native: NOSUPERUSER
minime_app     NOLOGIN, NOINHERIT, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOBYPASSRLS
minime_backup  NOLOGIN, NOINHERIT, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, BYPASSRLS
```

It grants `minime` `ADMIN TRUE, INHERIT FALSE, SET FALSE` on the two application roles, so
the admin profile can rotate their passwords but cannot inherit or `SET ROLE` into the
backup role. The broad owner credential remains confined to `.env.admin`; no runtime,
engineering, MCP, import, or Dream process receives it. Docker executes the bootstrap
through the image's existing `minime` cluster owner; native macOS/Linux uses the platform-superuser path
(`psql` as the Homebrew cluster owner or `sudo -u postgres`). Missing native authority
fails with exit 4 before backup, migration, password rotation, or file publication.

The permanent cluster posture is every attribute/membership above except `LOGIN`:
`minime_app` and `minime_backup` become `LOGIN` only after their grants and passwords are
ready, and remain login roles while migration 021 is replayed into later scratch,
drill, or restore databases. Privileged bootstrap is state-aware: it creates missing roles
as `NOLOGIN`, verifies stable attributes on existing roles, and never resets a published
role from `LOGIN` to `NOLOGIN`.

Migration 021 begins by asserting the permanent attributes and exact admin-option matrix,
deliberately ignoring `rolcanlogin`. It creates no role and changes no role attribute; a
missing/wrong permanent attribute causes the transaction to fail before any schema or
ledger write. Separately, `migrate()`'s fresh-live `install`/`role_cutover` preflight
requires both application roles to be `NOLOGIN` before it opens 021; disposable
test/drill/restore contexts allow their already-published `LOGIN` state. It then grants
`minime_app` only:

- CONNECT and schema usage;
- explicit tiered table SELECT/INSERT/UPDATE;
- DELETE on `chunks` and `edges` only where existing workflows require replacement;
- INSERT-only access to `transactions` and `health_samples`;
- required sequence/function access;
- no DDL, database/role creation, TRUNCATE, BYPASSRLS, tier-0 SELECT, or event mutation.

Database-level CONNECT grants target the safely quoted `current_database()` inside the
migration transaction; migration 021 never hardcodes `minime`. The same applies to
`minime_backup`, so replay into an S0 scratch database or S3 drill/restore database grants
only that current database and leaves the live database untouched.

It also adds `session_unlocks.approval_nonce_hash text`. Inside the migration transaction:

1. add the column nullable;
2. delete every legacy session unlock (the rows are ephemeral capabilities, not owner data);
3. set the column `NOT NULL`;
4. create a unique index over the nonce hash;
5. replace `app_allowed_tier()` so a tier-2 match also requires a non-null approval hash.

An old handler that omits the new column therefore fails closed even if it was loaded before
the migration. New `insertUnlock(minutes, actor, approvalNonceHash)` inserts the consumed
nonce hash and unlock in one statement; a unique violation maps to fixed
`OWNER_APPROVAL_REQUIRED`, never a raw database error.

Credential provisioning sets application-role passwords and enables LOGIN only after the
migration transaction succeeds. The `minime_backup` role is read-only. It has
`BYPASSRLS` plus CONNECT/USAGE/SELECT sufficient for a complete `pg_dump`,
including tier-0 tables, but no INSERT/UPDATE/DELETE/TRUNCATE, DDL, role/database creation,
replication, function execution beyond catalog access, or event mutation. This narrowly
powerful read credential exists only to produce the encrypted backup and is never loaded by
MCP, imports, search, dream analysis, or engineering sessions.

`app_allowed_tier()` uses `current_setting('minime.actor', true)`:

- an MCP actor gets tier 2 only with that actor's live unlock;
- trusted background runtime with no actor may process tier 2;
- `minime_engineer_ro` defaults to tier 1 unless an explicitly tested actor setting maps to a
  valid unlock.

Fresh install generates separate 256-bit runtime, backup, and owner database secrets plus
an Ed25519 unlock-approval key pair. Database secrets are unpadded 43-character base64url
strings, so their accepted alphabet is fixed before DSN encoding or native bootstrap. The
exact persistent contract is:

```text
.env
  DATABASE_URL=<minime_app DSN>
  MINIME_UNLOCK_VERIFY_KEY_FILE=<data-root>/keys/unlock-approval-public.pem

.env.admin
  MINIME_ADMIN_DATABASE_URL=<owner DSN>
  MINIME_UNLOCK_SIGNING_KEY_FILE=<data-root>/keys/unlock-approval-private.pem

.env.backup
  MINIME_BACKUP_DATABASE_URL=<minime_backup DSN>

<resolved MINIME_DATA_DIR>/keys/
  unlock-approval-public.pem   owner-owned regular file, mode 0600
  unlock-approval-private.pem  owner-owned regular file, mode 0600
```

The key directory is mode 0700 and every existing path component must be non-symlink.
Repository-relative key paths are resolved from the physical repository root; a custom
absolute `MINIME_DATA_DIR` remains absolute. Admin profile loading maps
`MINIME_ADMIN_DATABASE_URL` to the migration child's `DATABASE_URL`; backup profile loading
maps `MINIME_BACKUP_DATABASE_URL` only for dump creation. Normal `serve`, daemon, imports,
watcher, search, and dream use `.env` and receive no private key, backup DSN, or owner DSN.
Until S3 consolidates profile loading, `make migrate`, the S0 safe-update migration
subprocess, and `make repair-runtime-role` parse only `MINIME_ADMIN_DATABASE_URL` from
`.env.admin` as data and pass its DSN only to that child. `unlock:grant` parses only
`MINIME_UNLOCK_SIGNING_KEY_FILE`; it never loads or exports the admin DSN. None of these
paths source a profile as shell code. S3's profile wrapper must import this same parser
rather than introduce a second dotenv grammar.

The backup credential has an executable boundary in this same stage; the runtime cutover is
not allowed to merge with backups silently broken. `src/pipeline/backup.ts` keeps the public
`backup()` and `dbSnapshot()` signatures, but those parent functions spawn this fixed
no-shell child instead of running `pg_dump` in the runtime process:

```text
bun run scripts/run-backup-worker.ts --tag dream|db-snap --source backup-profile
```

For `backup-profile`, the worker is the only process that calls
`readPrivateEnvKeys(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env.backup"),
["MINIME_BACKUP_DATABASE_URL"])`; it derives the physical repository root from its own
module URL and never imports runtime config or uses launch cwd to find the profile. It validates the
loopback DSN and fixed `minime_backup` username. An explicitly exported
`MINIME_BACKUP_DATABASE_URL` takes precedence over the parsed file; an inherited generic
`DATABASE_URL` never does. The worker maps the resolved profile value to `DATABASE_URL`,
deletes `MINIME_BACKUP_DATABASE_URL`, `MINIME_ADMIN_DATABASE_URL`, and
`MINIME_UNLOCK_SIGNING_KEY_FILE` from its environment, and only then dynamically imports
the raw dump implementation. It prints exactly one JSON line:

```ts
export interface BackupWorkerRecord {
  version: 1;
  tag: "dream" | "db-snap";
  code:
    | "taken"
    | "unconfigured"
    | "dependency_unavailable"
    | "connection_failed"
    | "dump_failed"
    | "repository_failed"
    | "cleanup_failed";
}
```

Every code maps to an existing fixed `{ ran, detail }` result. The parent accepts one line
no larger than 1 KiB, rejects an unexpected exit, extra bytes, a wrong tag/version/code, or
malformed JSON as a fixed failure, and never relays child stdout/stderr. Manual CLI,
scheduled, Dream, and update-triggered backups all reach this same parent boundary. Thus
the runtime and Dream analysis process never parse or receive the dump credential, while
the dedicated child can still dump tier 0.

Existing-install hardening needs a snapshot before the backup role exists. Its stopped,
verified `unhardened` branch is the sole exception: `scripts/harden-runtime-role.ts` spawns
the same dedicated worker with fixed `--source cutover-owner`, passing the already-retained
legacy owner DSN only in the child's environment. The worker deletes that handoff before
the dynamic import. This mode has no public CLI command, refuses unless the fixed cutover
stage is `staged` and the live runtime posture is still the legacy owner, and becomes
unreachable after migration 021 or profile publication. Fresh install never uses it.
Hardening proceeds only on `taken` or a positively identified `unconfigured` result; any
other skip, configured failure, or malformed worker record stops before role bootstrap,
migration, password rotation, or publication.
S3 removes the worker's direct profile parsing in favor of the shared
`with-repo-env --profile backup` wrapper, without changing the public backup boundary or
wire record.

`src/util/env-file.ts` is the shared non-evaluating parser:

```ts
export async function readPrivateEnvKeys<const K extends readonly string[]>(
  path: string,
  allowed: K,
): Promise<Partial<Record<K[number], string>>>;
```

It accepts a mode-0600, owner-owned, regular, non-symlink file no larger than 64 KiB;
supports only `KEY=value` plus blank/comment lines; rejects duplicate approved keys, NUL,
invalid UTF-8, interpolation, command syntax, and malformed approved-key lines; and ignores
unrecognized well-formed keys. It returns strings without mutating `process.env`.

The S0 test harness is also updated here: local tests obtain their database-creation source
from `MINIME_TEST_ADMIN_URL`, then safely parsed `.env.admin`, then CI's existing
`DATABASE_URL`, in that order. They still connect only to their disposable guarded database;
the live database name is rejected before provisioning. This keeps `make verify` working
after `.env` becomes a non-CREATEDB runtime DSN without exposing admin credentials to normal
runtime code.

`scripts/harden-runtime-role.ts` exports testable orchestration seams:

```ts
export interface RuntimeCredentialPaths {
  runtimeEnv: string;
  adminEnv: string;
  backupEnv: string;
  publicKey: string;
  privateKey: string;
  stageRoot: string;
}

export interface RuntimeRoleSecrets {
  ownerPassword: string;
  runtimePassword: string;
  backupPassword: string;
}

export type RuntimeCredentialStagePhase =
  | "staged"
  | "application_roles_provisioned"
  | "owner_rotated"
  | "published";

export interface RuntimeCredentialStage {
  readonly generationId: string;
  readonly root: string;
  readonly manifestPath: string;
  readonly manifestHash: string;
  readonly phase: RuntimeCredentialStagePhase;
}

export interface ResidentRuntimeState {
  cliProcesses: number;
  ownerDatabaseSessions: number;
}

export type ClusterBootstrapBackend = "docker" | "macos-native" | "linux-native";

export async function assertRuntimeStopped(): Promise<ResidentRuntimeState>;
export async function provisionClusterRolePosture(
  backend: ClusterBootstrapBackend,
  ownerPassword: string | undefined,
  expectedApplicationLogin: "disabled" | "published",
): Promise<void>;
export async function stageRuntimeCredentialBundle(
  paths: RuntimeCredentialPaths,
  secrets: RuntimeRoleSecrets,
): Promise<RuntimeCredentialStage>;
export async function loadRuntimeCredentialStage(
  paths: RuntimeCredentialPaths,
): Promise<RuntimeCredentialStage | null>;
export async function advanceRuntimeCredentialStage(
  stage: RuntimeCredentialStage,
  phase: RuntimeCredentialStagePhase,
): Promise<RuntimeCredentialStage>;
export async function installApplicationRolePasswords(
  adminUrl: string,
  runtimePassword: string,
  backupPassword: string,
): Promise<void>;
export async function rotateOwnerRolePassword(
  adminUrl: string,
  nextOwnerPassword: string,
): Promise<void>;
export async function publishRuntimeCredentialBundle(
  paths: RuntimeCredentialPaths,
): Promise<void>;
export async function probePublishedRuntime(): Promise<RuntimeRolePosture>;
```

There is exactly one discoverable staging location:

```text
<resolved MINIME_DATA_DIR>/ops/runtime-role-cutover/
  manifest.json
  runtime.env
  admin.env
  backup.env
  unlock-public.pem
  unlock-private.pem
```

The directory is owner-owned mode 0700; all six files are regular, owner-owned,
non-symlink mode 0600. `manifest.json` contains only version `1`, a UUID
`generation_id`, one phase from `RuntimeCredentialStagePhase`, creation timestamp, and
SHA-256 for each of the other five files—never a path, DSN, password, or key. Each data
file and each monotonic phase update is fsynced and published by same-directory rename.
Only one generation may exist. `loadRuntimeCredentialStage()` resolves this fixed location,
opens every component without following symlinks, verifies ownership/mode/size, hashes,
key-pair match, DSN role names, and generation/phase, and otherwise returns fixed
`credential_stage_invalid`; it never silently deletes or replaces an invalid stage.

`provisionClusterRolePosture()` executes only the fixed role/attribute/membership statements
above through the selected platform-superuser runner. `ownerPassword` is required only when
creating the fresh owner role and is sent via Docker child environment or native `psql`
stdin, never argv; existing-install bootstrap preserves the current owner password. It
queries `pg_roles`/`pg_auth_members` afterward and refuses unless attributes and
`ADMIN TRUE, INHERIT FALSE, SET FALSE` match exactly. Its catalog expectation is
phase-sensitive: newly created live roles must be `NOLOGIN`, while an already-published
installation must preserve and verify `LOGIN`. `"disabled"` may create/repair only the
pre-cutover `NOLOGIN` posture; `"published"` is verification-only and rejects any requested
attribute mutation.

Staging writes those five exclusive data files plus the manifest, validates the bundle, and
changes no live config. Publication copies each validated staged value to an exclusive
`<target-basename>.minime-cutover-<generation_id>` sibling beside its final target,
revalidates hash/inode, then performs the declared
same-directory target renames. `installApplicationRolePasswords()` accepts only
the two fixed application role names internally. In one admin transaction covering both
roles, it binds both secrets with `set_config(..., true)` and runs fixed `DO` blocks whose
`format('%L', ...)` calls quote each setting for `ALTER ROLE ... LOGIN`; it never
interpolates a secret into source text, argv, diagnostics, or an event. Both role changes
commit or neither does. `rotateOwnerRolePassword()` uses the same mechanism for the one
fixed owner role and keeps the already-authenticated admin session open until the staged
owner DSN has been probed. The staged DSNs then perform all three role probes before
publication.
Advance to `application_roles_provisioned` only after migration, application passwords, and
their probes succeed; advance to `owner_rotated` only after the new owner DSN connects and
the legacy password no longer opens a new session.
On resume from manifest phase `staged`, inspect the 021 ledger and both application roles
before rerunning bootstrap: no ledger plus two `NOLOGIN` roles resumes before migration;
ledger present plus two `NOLOGIN` roles resumes password installation; ledger present plus
two `LOGIN` roles must authenticate with both staged passwords and then advances the
manifest. A mixed LOGIN state, ledger/role mismatch, or failed staged probe is
`credential_cutover_inconsistent`. This handles process death after either atomic database
commit but before its manifest fsync without resetting a published login role.
Publication writes key files first, then
`.env.admin`, then `.env.backup`, and publishes `.env` last as the commit point. Each target
uses same-directory rename and parent-directory fsync. A failure before the `.env` rename
leaves the stopped installation with either the old admin credential or a validated private
staged admin bundle; it must not claim the old owner-role `.env` is restartable after owner
password rotation. `make repair-runtime-role` tries a published admin profile, then the
validated staged admin sibling, then the legacy owner-role `.env`, and resumes forward.
A failure after `.env` publication is handled by the same tested forward-repair path.
Fixed diagnostics never print a path, DSN, password, or key.

Cutover state selection occurs before any secret generation:

| Observed state | Required action |
|---|---|
| Unhardened: runtime `.env` connects as owner, no published admin profile, no stage | Generate one bundle and retain its generation ID through completion |
| Staged after crash: valid manifest phase is not `published` | Reuse that exact generation; try staged admin DSN, then published admin DSN, then legacy owner `.env`, accepting the first credential whose catalog posture matches the manifest phase; never generate |
| Published hardened: runtime `.env` is `minime_app`, published admin/runtime/backup profiles all probe correctly, and no incomplete stage exists | Preserve every credential/key byte and run posture checks only |
| Inconsistent: invalid/tampered stage, multiple stage generations, app runtime plus divergent incomplete stage, no matching admin credential, or role/config phase mismatch | Refuse with fixed `credential_cutover_inconsistent`; mutate nothing |

The ordinary recovery path may try both legacy and staged owner credentials because a crash
can occur between the database password change and the `owner_rotated` manifest fsync.
Exactly one successful posture is selected; no credential or failure detail is printed.
After successful publication and posture verification, advance the manifest to `published`,
fsync it, then remove the whole staging directory with the existing validated private-tree
cleanup. A cleanup refusal leaves the validated `published` manifest for an idempotent
rerun and never triggers credential rotation.

Fresh-install ordering is binding:

1. generate the three database secrets and key pair in memory and fsync the five staged
   files;
2. bootstrap the owner role/database and exact three-role posture through
   `provisionClusterRolePosture(..., "disabled")`—Docker receives
   `MINIME_PG_OWNER_PASSWORD` only in the
   `docker compose` child environment through `${MINIME_PG_OWNER_PASSWORD:?}`, while native
   `ensure_pg_objects` sends the base64url secret only over `psql` stdin;
3. connect with the staged owner DSN and apply all migrations with S0
   `{ kind: "install" }`, so migration 021 has verified the pre-created roles and granted
   their object privileges;
4. install the runtime and backup passwords, probe owner/runtime/backup posture through the
   three staged DSNs, then publish with `.env` last;
5. continue seed/verification only through the published least-privilege runtime profile.

`pg_provisioned()` and installer rerun detection use the same state table: a valid active
stage first, then the published admin profile, then the legacy `.env` only for the
unhardened state. This lets a fresh install resume after owner bootstrap but before profile
publication. No probe may retain the literal
`postgres://minime:minime@...`. `scripts/up.sh` similarly passes only the parsed owner
password to the Docker Compose child when container creation needs it; normal Minime
runtime children receive only `.env`.

The S1 update boundary is explicit. Extend S0's `MigrationContext` with:

```ts
type RuntimeRoleCutoverMigrationContext = {
  kind: "role_cutover";
  generationId: string;
  manifestHash: string;
};
```

When 021 is pending on the live `minime` database, `migrate()` accepts only a verified fresh
`install` target or `role_cutover`. The latter loads the fixed staging manifest, requires
the same generation and manifest SHA-256, verifies phase `staged`, and confirms the platform
role posture—including `NOLOGIN` for both application roles—before opening the migration
transaction. Live `update` and `direct` contexts
may apply later migrations but return fixed `runtime_role_cutover_required` before
executing 021. S0-guarded disposable `test` databases and S3-guarded
`minime_drill|minime_restore` targets may apply 021 only after the cluster-role posture
assertion over permanent attributes/membership; they explicitly accept the cluster-global
roles' published `LOGIN` state, never publish runtime credentials, and never touch the live
database.

After fetch/install/verification but before migration, the checked-out updater detects a
pending 021 plus unhardened posture and exits 50 with fixed
`FIX: stop Minime and run make harden-runtime-role`; it does not invoke migration. An
already-parsed S0 updater can still reach the new migration CLI, but its bounded `update`
context hits the same guard before SQL. Migration 021 independently asserts the permanent
role attributes/membership (not `rolcanlogin`) as its first statement group.
`make harden-runtime-role` is the only existing-data
transition path: stopped-runtime preflight → snapshot → platform role bootstrap →
`migrate({kind:"role_cutover", ...})` → credential cutover/probe. The owner then reruns
`make update`, which observes 021 applied and completes normally. Tests cover checked-out,
frozen-S0, direct, restore, and tampered-stage paths.

- [ ] **Step 1: Write role and legacy-unlock migration RED tests**

Plant an active legacy `session_unlocks` row with expiry one hour in the future and no
approval hash. After migration 021, assert it is gone, the hash column is `NOT NULL`, and an
old two-argument insert fails. Assert the app role is not superuser, CREATEDB, CREATEROLE,
or BYPASSRLS. Test representative writes plus denials for tier-0 SELECT, DDL, role/database
creation, TRUNCATE, and event mutation. Assert the backup role can complete a full scratch
`pg_dump` but cannot perform any write or runtime query.

Before privileged role bootstrap, run migration 021 and assert the transaction/ledger/schema
remain unchanged. Bootstrap the exact attributes/memberships, rerun, and assert success.
Apply 021 to a second disposable database after both roles are `LOGIN` and require success.
Present each wrong permanent attribute and membership option independently and require the
same pre-schema refusal; flip `rolcanlogin` alone and require migration SQL to remain
replayable while the fresh-live context preflight still rejects `LOGIN`.

Role-fault cases never touch the shared development/test cluster. Add
`test/support/role-cluster.ts`, a special cluster-level fixture for this one suite. It starts
one private temporary supported PostgreSQL cluster per test process: use the installed
native `initdb`/`postgres` (PG16 on Linux or PG17 on macOS) when Minime is in native mode,
otherwise use the already-available
`pgvector/pgvector:pg16` image with a unique container name, loopback ephemeral port, and
private temporary data volume. It never pulls an image, never uses the live port/database,
generates random credentials, validates the resolved target before connecting, and removes
the process/container/data directory on success, failure, and signal.

Within that isolated cluster, exercise missing roles, every permanent attribute/membership
fault (including superuser-only changes), initial `NOLOGIN`, post-publication `LOGIN`, and
021 replay into a second database with the same cluster-global roles. Pure table-driven
posture cases remain as fast unit coverage. Add a two-simultaneous-test-command regression:
each command must report a distinct cluster identity/port and both must pass while ordinary
S0 scratch-database tests run. If neither the already-installed native server binaries nor
the already-present Docker image is available, the test fails with a fixed prerequisite
message rather than skipping or mutating the shared cluster.

- [ ] **Step 2: Write one-use approval integration RED tests**

Test tampered signature, expiry, future issue time, wrong actor/minutes, malformed encoding,
and exact success. Race two transactions with one capability: exactly one inserts its hash.
No capability, a used capability, or another actor's capability returns
`OWNER_APPROVAL_REQUIRED`. Assert token, raw nonce, and private key never enter events or
console output.

- [ ] **Step 3: Prove the database suites are red**

```bash
bun test \
  test/runtime-role.test.ts \
  test/runtime-role-install.test.ts \
  test/unlock-capability-integration.test.ts \
  test/migration-context.test.ts
```

- [ ] **Step 4: Provision/assert cluster roles, then add grants**

Implement the fixed Docker/macOS/Linux platform-superuser runners and exact role posture,
including non-inheritable/non-settable admin memberships. In migration 021, assert the
permanent posture while ignoring `rolcanlogin`, apply the exact object grants, then replace
public/grant-all defaults. Query catalogs after each layer. In `migrate()`, add the stricter
fresh-live `NOLOGIN` check before 021 and the replayable test/drill/restore check. Add the
pending-021 live-target context guard and verified
`role_cutover` manifest binding in `src/db/migrate.ts`; refusal precedes the migration file
transaction. Run only the migration-context/posture/privilege tests. Prove native missing
sudo/platform authority exits 4 without a database or filesystem mutation.

- [ ] **Step 5: Invalidate legacy unlocks in the migration**

Add the nullable column, delete all session unlocks, set it `NOT NULL`, create the unique
index, and update `app_allowed_tier()` with the approval-hash predicate. Re-run the migration
twice. The planted future legacy row and old insert must remain unable to unlock.

- [ ] **Step 6: Activate owner-signed unlock**

Add required `capability` to the MCP schema. Verify it with
`MINIME_UNLOCK_VERIFY_KEY_FILE`, hash the nonce, and atomically call
`insertUnlock(minutes, actor, nonceHash)`. Add
`unlock:grant --actor ... --minutes ...`. Before importing normal runtime configuration,
that CLI calls `readPrivateEnvKeys(".env.admin",
["MINIME_UNLOCK_SIGNING_KEY_FILE"] as const)`, validates the returned key path, and prints
the capability once. It neither reads nor exports `MINIME_ADMIN_DATABASE_URL`; only that
owner CLI reads the signing key. Add a subprocess test with a sentinel admin DSN and prove
the signing child/environment/output cannot observe it.

This protects an MCP-only client, not arbitrary code running as the owner's OS account.
Record the same-UID limitation in `DECISIONS.md` and S5's contract; OS-mediated
human-presence proof remains separate work.

- [ ] **Step 7: Write exact credential/key filesystem RED tests**

Assert the five file targets and five approved config keys above. Reject missing, symlinked,
non-owner-owned, over-permissive, mismatched, or out-of-root keys. Fresh install never writes
`minime:minime`; DSNs/keys/passwords never appear in argv/stdout/stderr. Cover both Docker
and native owner bootstrap, migration-before-application-role-password ordering, a hardened
installer rerun, and failure before/after every owner/runtime/backup credential transition.
Assert `pg_provisioned()` succeeds from the admin profile without a literal credential.
Assert verification succeeds with the public key and signing is impossible with it.
Table-drive the four cutover states above. SIGKILL after each manifest/database/publication
transition, rerun, and assert the generation ID and every staged secret hash are unchanged.
A fresh-install crash immediately after Docker/native owner bootstrap must resume from the
fixed stage without a published `.env.admin`. Tamper, extra stage entries, wrong phase, or
hash/key/role mismatch must refuse before PostgreSQL or final-target mutation.
Run both the checked-out S1 updater and frozen S0 updater against a pending 021 without
bootstrap; each must leave migration ledger and schema unchanged and print only the fixed
hardening instruction.

In `test/private-env-profile.test.ts`, prove command syntax is returned literally or
rejected without execution, duplicate approved keys fail, unapproved keys never enter the
result, and the signing-key-only read cannot observe `MINIME_ADMIN_DATABASE_URL`.

In `test/backup.test.ts`, run every public backup caller with distinct sentinel
runtime/admin/backup usernames. Require the dump child to connect as `minime_backup` and
prove its parent never receives the backup DSN. Reject a symlinked/wrong-mode profile,
wrong-role or remote DSN, malformed/oversize/extra worker output, a direct raw-worker import
without its internal marker, and any admin/signing secret in the worker environment, argv,
or output. Exercise the stopped `cutover-owner` mode before 021, then prove it is rejected
after 021 and after profile publication.

- [ ] **Step 8: Implement fresh-install role provisioning, staging, and publication**

Implement the five-step fresh-install ordering above. Generate the database secrets and
Ed25519 pair before PostgreSQL bootstrap, stage all five files, bootstrap the owner,
apply migration 021 and all predecessors through the staged admin DSN, install the two
application-role passwords through the fixed admin transaction, connect through all three
staged DSNs to prove passwords and grants, then publish in the declared order with `.env`
last. Change `docker-compose.yml`, native `ensure_pg_objects()`, `pg_provisioned()`, and
`scripts/up.sh` together so first install and hardened rerun use one contract. Use
`atomicWritePrivate()` for data-root keys and equivalent exclusive/fsync/sibling-rename
operations for repository env files. `scripts/install.sh` calls these functions only for a
fresh install; `make update` never calls them.

Move the raw dump body behind the worker-only marker and make both public backup functions
spawn the bounded `backup-profile` worker. Implement the exact record parser and fixed
result mapping in the parent. Do not change Dream, daemon, CLI, or update call sites: their
existing public call now delegates automatically.

- [ ] **Step 9: Write the live-old-pool cutover RED test**

Open a real owner-role pool that represents a resident pre-S1 process. Run
`make harden-runtime-role`; expect fixed `runtime_still_running` before backup, migration,
key generation, or config staging. Close it, rerun, and assert migration/publication may
proceed. Also inject an OS-process probe for `src/cli.ts serve|daemon|run` and require the
same refusal.

- [ ] **Step 10: Implement the stopped-runtime preflight**

`assertRuntimeStopped()` combines the fixed CLI-process probe with an admin
`pg_stat_activity` catalog query for other owner sessions on the live database, excluding
its own backend. It reports counts only. Run it before backup and again immediately before
publication; it never terminates a process automatically.

- [ ] **Step 11: Implement existing-install staging**

Apply the state table before generating anything. Only the unhardened branch creates fresh
owner/app/backup passwords and a key pair; the staged branch reloads the same generation,
and the published branch returns after posture checks. For a new unhardened generation,
take the pre-image snapshot through the one-purpose `cutover-owner` worker, call
`provisionClusterRolePosture(..., "disabled")`, verify the exact catalogs,
apply migration 021 with the stage generation/hash `role_cutover` context, then
install the two application passwords and prove their staged connections/grants. Keep the
authenticated legacy admin session open, rotate the owner password, and immediately prove
the staged admin DSN.
On an ordinary probe failure, use the retained session to restore the legacy owner password;
on process death, preserve the fsynced staged bundle so an idempotent forward repair can
authenticate with the new owner credential. Never publish `.env` or restart service until
all three staged connections pass.

- [ ] **Step 12: Publish, launch the reviewed probe, and close cutover**

Publish with `.env` last, then spawn the checked-out S1
`bun run src/cli.ts runtime:posture` under the new `.env`. Require `minime_app`, no privileged
role bits, and zero remaining owner sessions before success. The command then prints fixed
instructions to start one reviewed daemon and restart MCP clients. The upgrade is not
complete—and old binaries must not restart—until that probe passes.

- [ ] **Step 13: Define idempotence and explicit key rotation**

Rerunning hardening follows the state table: it resumes an incomplete generation or
preserves a published matching bundle byte-for-byte; it never rotates silently. Add
`make rotate-unlock-key`, which requires the
same stopped-runtime preflight, stages a fresh pair, deletes all ephemeral
`session_unlocks`, publishes private then public while stopped, verifies the pair, and
requires reviewed-process restart. Inject failure before/after each rename and prove rerun
either completes forward or refuses with fixed recovery instructions.

- [ ] **Step 14: Enforce posture on every resident entry point**

Existing `.env*` files are never rewritten by update. `serve`, `daemon`, and `run` all
refuse owner posture with:

```text
ERROR: runtime database role is over-privileged
FIX: make harden-runtime-role
```

The cutover integration test starts the reviewed posture child under `.env`, observes the
app role, and proves the old owner pool cannot remain connected.

- [ ] **Step 15: Run the cutover gate**

```bash
bun test \
  test/runtime-role.test.ts \
  test/runtime-role-install.test.ts \
  test/runtime-role-cutover.test.ts \
  test/unlock-capability-integration.test.ts \
  test/private-env-profile.test.ts \
  test/update.test.ts \
  test/update-bootstrap.test.ts \
  test/migration-context.test.ts \
  test/backup.test.ts \
  test/db-actor-session.test.ts \
  test/test-database-isolation.test.ts \
  test/m2.tools.test.ts \
  test/m4.importers.test.ts \
  test/m6.leak.test.ts \
  test/m15.roles.test.ts
make verify
```

- [ ] **Step 16: Record and commit**

```bash
git add \
  db/migrations/021_runtime_app_role.sql scripts/harden-runtime-role.ts \
  test/runtime-role.test.ts test/runtime-role-install.test.ts \
  test/runtime-role-cutover.test.ts test/support/role-cluster.ts \
  test/unlock-capability-integration.test.ts \
  src/util/env-file.ts test/private-env-profile.test.ts \
  scripts/run-backup-worker.ts src/pipeline/backup.ts test/backup.test.ts \
  test/setup.ts test/support/test-database.ts \
  test/update.test.ts test/update-bootstrap.test.ts test/migration-context.test.ts \
  scripts/lib.sh scripts/install.sh scripts/update.sh scripts/up.sh \
  docker-compose.yml src/db/repo.ts src/db/migrate.ts \
  src/mcp/tools/unlock.ts src/cli.ts \
  src/util/config.ts Makefile .env.example AGENTS.md docs/GUIDE.md DECISIONS.md
git commit -m "feat: run minime with a least-privilege database role"
```

Rollback is forward repair, not an owner-role escape hatch:

1. Stop MCP and daemon processes.
2. Run `make repair-runtime-role` through `.env.admin`; it reapplies the idempotent grants,
   validates `minime_app`, and republishes a fresh runtime credential only after the probe
   passes.
3. Restart the reviewed S1 binary with the `minime_app` DSN and run
   `bun test test/runtime-role.test.ts --test-name-pattern recovery`.
4. If application code itself must be backed out, use the S1 compatibility tag produced by
   this task, which retains actor sessions, capability verification, and posture refusal;
   do not start an S0/pre-actor binary against migration 021.

Test the stopped → repair → validated restart sequence with injected grant and publication
failures. Retain `.env.backup` until one post-repair backup is proven. Migration 021 stays
applied; owner credentials remain admin-only and never restore normal service.

---

### Task 5: Tier-gate every engineering-readable content carrier

**Files:**

- Create: `db/migrations/022_engineer_content_rls.sql`
- Modify: `src/db/repo.ts`
- Modify: `src/pipeline/dream.ts`
- Modify: `src/pipeline/watcher.ts`
- Modify: `src/pipeline/validate-edges.ts`
- Modify: `src/mcp/tools/review-queue.ts`
- Modify: `test/m15.roles.test.ts`
- Modify: `test/privacy-hardening.test.ts`
- Modify: `test/m14.extract-validate.test.ts`
- Modify: `test/m7.graph.test.ts`

**Repository interfaces:**

```ts
export async function insertReviewItem(
  kind: string,
  payload: unknown,
  tier: 1 | 2,
): Promise<{ id: string }>;

export async function openReviewItems(
  kind: string | undefined,
  actor: string,
): Promise<unknown[]>;

export async function insertEdgeValidation(input: {
  edgeId: string;
  verdict: "confirm" | "deny" | "unsure";
  entityType: "person" | "org" | "neither";
  reason: string;
  model: string;
  ruleKey: string;
  tier: 1 | 2;
}): Promise<void>;
```

Migration 022:

- enables parent-derived RLS on `person_aliases` and `org_aliases`;
- adds `review_queue.tier smallint NOT NULL DEFAULT 2`, conservatively backfills, and enables
  shared tier RLS;
- adds `edge_validations.tier smallint NOT NULL DEFAULT 2` and enables tier RLS;
- revokes engineer SELECT on base `events`;
- creates a security-barrier `engineer_events` view containing only event identity,
  timestamps, actor/verb/entity IDs, approved counts, statuses, and codes;
- removes the grant-all default privilege and replaces it with explicit reviewed grants.

- [ ] **Step 1: Add locked/unlocked role tests**

Plant unique sentinels in tier-2 person/org aliases, queue payloads, edge-validation reasons,
and event payloads. Assert locked engineering reads see none; tier-1 rows remain visible;
valid actor unlock reveals permitted tier-2 rows; tier 0 never appears.

- [ ] **Step 2: Add schema-inventory enforcement**

The test enumerates every table/view selectable by `minime_engineer_ro`. A base table with a
text/json column must have applicable tier RLS or be absent from direct grants.

- [ ] **Step 3: Prove the focused suites are red**

```bash
bun test test/m15.roles.test.ts test/privacy-hardening.test.ts
```

- [ ] **Step 4: Apply the alias/event privilege half of migration 022**

Add parent-derived alias policies, revoke base-event SELECT, create the security-barrier
view, and replace blanket default privileges. Run only the role inventory assertions before
adding queue columns.

- [ ] **Step 5: Add queue/validation tiers and update every caller**

Unknown and inbox-unfiled review payloads default to tier 2. Queue listing omits an entire
invisible item; it does not rely on a field-name blocklist.

Use this checked call-site ledger; `bun run typecheck` must prove it stays complete:

```text
src/pipeline/dream.ts
src/pipeline/watcher.ts
src/pipeline/validate-edges.ts
test/m14.extract-validate.test.ts
test/m7.graph.test.ts
```

Dream callers propagate the maximum source-row tier. Watcher duplicate/unfiled items are
tier 2 while raw captures remain unclassified. Edge validation uses the maximum edge and
anchor tier already computed by the validator. Fixture-only calls pass explicit tier 1 or 2
matching the planted row; no overload/default preserves a two-argument production call.

- [ ] **Step 6: Prove compile-time and behavioral propagation**

```bash
bun run typecheck
bun test \
  test/m7.graph.test.ts \
  test/m14.extract-validate.test.ts \
  test/m15.roles.test.ts \
  test/privacy-hardening.test.ts
```

- [ ] **Step 7: Run role/graph/privacy gates and commit**

```bash
bun test \
  test/m15.roles.test.ts \
  test/privacy-hardening.test.ts \
  test/m14.extract-validate.test.ts \
  test/m7.graph.test.ts
make verify-m6
make verify-m14
make verify-m15
git add \
  db/migrations/022_engineer_content_rls.sql src/db/repo.ts \
  src/pipeline/dream.ts src/pipeline/watcher.ts src/pipeline/validate-edges.ts \
  src/mcp/tools/review-queue.ts test/m15.roles.test.ts \
  test/privacy-hardening.test.ts test/m14.extract-validate.test.ts \
  test/m7.graph.test.ts
git commit -m "fix: tier-gate engineering content carriers"
```

---

### Task 6: Make audit payloads content-free by construction

**Files:**

- Create: `src/util/event-payload.ts`
- Create: `test/audit-content.test.ts`
- Modify: `src/db/repo.ts`
- Modify: `src/util/config.ts`
- Modify: `src/importers/calendar.ts`
- Modify: `src/importers/email-meta.ts`
- Modify: `src/importers/health.ts`
- Modify: `src/pipeline/watcher.ts`
- Modify: `src/pipeline/dream.ts`
- Modify: `src/llm/index.ts`
- Modify: `src/mcp/audit.ts`
- Modify: `src/mcp/tools/unlock.ts`
- Modify: `src/onboard.ts`
- Modify: `scripts/repair.ts`
- Modify: `docs/SUBSYSTEMS.md`
- Modify: `test/m6.leak.test.ts`
- Modify: `test/m13.provider-routing.test.ts`
- Modify: `test/m15.roles.test.ts`
- Modify: `test/m4.importers.test.ts`
- Modify: `test/onboard.test.ts`
- Modify: `test/m2.tools.test.ts`
- Modify: `test/h4-audit-state.test.ts`
- Modify: `test/h4-audit-transport.test.ts`

**Interfaces:**

```ts
export type EventPayload = Readonly<Record<string, unknown>>;

export class UnsafeEventPayloadError extends Error {
  readonly code: "unsafe_event_payload";
}

export function assertContentFreeEventPayload(
  verb: string,
  payload: unknown,
): asserts payload is EventPayload;
```

The validator uses a closed verb/field registry. Every object must have
`Object.getPrototypeOf(value) === Object.prototype`; every listed field is required unless
marked `?`; extra keys and arbitrary nested objects are rejected. The sole nested-object
exception is the exact two-key optional `counts` object in the repair schema below; arrays
are accepted only by their named decoders. These reusable decoders are exact:

| Decoder | Accepted value |
|---|---|
| `count` | safe integer `0..2_147_483_647` |
| `id` | ASCII string matching `^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$` |
| `ids` | array of at most 100 `id` values |
| `hash16` | lowercase hex matching `^[0-9a-f]{16}$` |
| `timestamp` | canonical UTC ISO-8601 `YYYY-MM-DDTHH:mm:ss.sssZ`, exactly 24 characters |
| `score` | finite number in `0..1` |
| `error_code` | one of `BAD_INPUT`, `NOT_FOUND`, `UNKNOWN_METRIC`, `UNLOCK_TOO_LONG`, `OWNER_APPROVAL_REQUIRED`, `INTERNAL`, `SDK_REFUSAL`, `UNKNOWN_TOOL`, `DUPLICATE_REQUEST_ID`, `AUDIT_UNAVAILABLE`, `TIER_LOCKED`, `INBOX_BUSY`, `INVALID_METRIC_ROLLUP` |
| `classification_type` | one of `task`, `journal`, `interaction`, `note`, `decision_note`, `unknown` |
| `filed_table` | one of `tasks`, `journal_entries`, `interactions`, `decisions`, `pages` |

`src/util/config.ts` rejects configured model identifiers that do not match
`^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$`. Egress payloads accept only provider
`anthropic|openai|openrouter|bedrock`, and the model must equal that provider's resolved
configured classify/embed model: Anthropic classify; OpenAI classify or embed; OpenRouter
classify or embed; Bedrock classify. This is an exact runtime allowlist, not merely the
identifier regex. `items` is a `count` greater than zero, and classify requires exactly
`1`.

The literal registry is binding:

| Verb/family | Exact payload schema |
|---|---|
| `import:calendar`, `import:email-meta`, `import:health` | `{total, inserted, updated, skipped}`; all four are `count` |
| `import:malformed` | `{malformed_code, kind?}`; code is `missing_required_fields|missing_required_headers|invalid_start_date|invalid_numeric_value`; `kind`, when present, is `steps|hr_resting|hr|body_mass|sleep_minutes` and is valid only for the two health codes |
| `onboard:complete` | exactly seven `count` fields: `profile`, `values`, `goals`, `principles`, `people`, `tasks`, `journal` |
| `unlock:tier2` | `{minutes, expires_at}`; minutes is integer `1..min(TIER2_UNLOCK_MAX_MINUTES,1440)`, expiry is `timestamp`; startup rejects a max outside `1..1440` |
| `inbox:closed-existing-task` | `{task_id:id, score:score}` |
| `inbox:duplicate` | `{existing_task_id:id, score:score}` |
| `inbox:split-decision` | `{task_id:id, decision_id:id}` |
| `inbox:split-done-task` | `{decision_id:id, task_id:id}` |
| `inbox:filed` | `{type:classification_type, confidence:score, filed_table, filed_id:id}` |
| `inbox:unfiled` | `{type:classification_type, confidence:score}` |
| `inbox:orphaned` | `{code:"source_missing"}` |
| `egress:embed` | `{provider, model, items}` with the provider/model rule above |
| `egress:classify` | `{provider, model, items:1, route_tier?}`; tier is `1|2` |
| `repair:invalid`, `repair:retype-org-to-person`, `repair:requeue-stale-inbox-filings` | `{phase, code, counts, ids}`; phase is `failed|complete`; code is `repair_not_committed|repair_uncommitted_tree|repair_module_failed|repair_cleanup_failed|repair_backup_failed|repair_invalid_summary|repair_complete`; `complete` requires `repair_complete`, every other code requires `failed`; counts has only optional `edges_repointed` and `requeued` `count` fields; ids uses `ids`; every failed event and every `repair:invalid` event requires `counts:{}` and `ids:[]` |

Before any repair validation, `scripts/repair.ts` maps the requested script through this
literal audit-name table:

```ts
const REPAIR_AUDIT_NAMES = {
  "retype-org-to-person": "repair:retype-org-to-person",
  "requeue-stale-inbox-filings": "repair:requeue-stale-inbox-filings",
} as const;

function repairAuditVerb(name: string): string {
  return REPAIR_AUDIT_NAMES[name as keyof typeof REPAIR_AUDIT_NAMES] ?? "repair:invalid";
}
```

This mapping runs even for syntactically valid but absent/uncommitted names, so every such
failure reaches the registered `repair:invalid` schema. Adding a repair requires adding the
literal name, payload count keys, and tests in the same commit.

The exact MCP tool-name set is
`minime_search|minime_get_context|minime_state|minime_query_metric|minime_capture|minime_journal|minime_log_decision|minime_review_decision|minime_upsert_task|minime_agenda|minime_log_interaction|minime_review_queue|minime_unlock`,
plus the raw-wire sentinel `unknown`. For each name:

| Family | Exact payload schema |
|---|---|
| `tool:<name>:attempt` | `{params_hash:hash16, requested_name_hash?:hash16}` |
| `tool:<name>` | `{params_hash:hash16, returned_ids:ids, returned_count:count, error_code?:error_code, requested_name_hash?:hash16, delivery:"transport"|"direct"}` |
| `tool:<name>:disposition` | released/send-uncertain: `{result_event_id:id, status:"released"|"send_uncertain"}`; suppressed: `{result_event_id:id, status:"suppressed", returned_ids:[], returned_count:0, outcome?}` where outcome is `cancelled_before_execution|transport_closed_before_execution|completed_not_released|completed_after_disconnect` |

`dream:summary` is flattened before insertion. Its only fields are optional `count` values
`embed_backlog`, `entity_links`, `note_candidates`, `note_created`, `note_updated`,
`note_repaired`, `note_unchanged`, `note_failed`, `digest_candidates`, `digest_compiled`,
`digest_skipped`, `contradictions`, `phantom_people`, `edge_checked`, `edge_confirmed`,
`edge_denied`, `edge_unsure`, `edge_flagged`, `stale_items`, `metric_values`, and
`decision_reviews`; required
`backup_status:"taken"|"unconfigured"|"busy"|"failed"`; and required
`failed_steps`, a duplicate-free array drawn from the eleven literal dream step names
`1_embed_backlog|2_entity_link|2b_compile_notes|2c_compile_decision_digests|3_contradictions|3b_phantom_persons|3c_validate_edges|4_stale|5_rollups|6_decision_reviews|7_backup`.
It never retains note/digest result arrays, `byRule`, paths, labels, questions, model output,
backup detail, or exception messages.

Normalization is exhaustive across both release shapes. In S1, initialize
`backup_status = "failed"` before step execution; `{ran:true}` becomes `"taken"`, while
`{ran:false}` or a thrown step remains `"failed"` and adds `7_backup` to `failed_steps`.
No S1 detail-string parsing may produce a more benign status. When S3 replaces that result
with `BackupOutcome`, map `taken|unconfigured|busy` to the same literal status without a
failed step, map `failed` to `"failed"` plus `7_backup`, and map a throw identically to
failed. There is no `not_taken` state.

Reject arbitrary nested objects and keys such as `title`, `question`, `text`, `body`,
`reason`, `summary`, and `raw_path` before event insertion.

Keep the validator in existing audited utility plumbing (`src/util/`), rather than creating
an uncovered top-level `src/audit/` subsystem or making the database layer import upward
from `src/mcp/`. It is enforced at the repository door, so non-MCP producers cannot bypass
it. Extend the existing MCP/audit subsystem row with `src/util/event-payload.ts`, cite
`test/audit-content.test.ts`, and state that the registry replaces ad hoc payload
sanitization without adding a runtime dependency or subsystem.

The repair runner's committed-code gate is closed in the same task: before backup or module
load, it requires the entire tracked worktree to match `HEAD`, not only the named wrapper
file. A dirty transitive dependency such as `src/db/repo.ts` returns fixed
`repair_uncommitted_tree`; untracked ignored owner files do not block it.

- [ ] **Step 1: Write payload-unit and sentinel tests**

Forbidden top-level and nested fields throw a fixed error that does not stringify the value.
Watcher, dream-error, import, provider, repair, and MCP flows leave no sentinel in
`events::text` or captured console output.

- [ ] **Step 2: Add the exact producer inventory**

Statically enumerate every `logEvent` import/call and assert each verb has a registered
schema. The starting production ledger is:

```text
scripts/repair.ts
src/importers/calendar.ts
src/importers/email-meta.ts
src/importers/health.ts
src/llm/index.ts
src/mcp/audit.ts
src/mcp/tools/unlock.ts
src/onboard.ts
src/pipeline/dream.ts
src/pipeline/watcher.ts
```

`src/db/repo.ts` is the enforcing sink, not a producer. The inventory test fails if a new
producer or literal verb lacks a schema. Computed tool verbs accept either a current
registered tool name or the one exact raw-wire sentinel `unknown`; explicitly test
`tool:unknown`, `tool:unknown:attempt`, and `tool:unknown:disposition`.
Repair verbs accept only the three literal entries in the table. Assert a valid-looking
unknown name such as `future-repair` maps to `repair:invalid`, inserts one failure event,
and never reaches backup/module load.

- [ ] **Step 3: Prove tests are red**

```bash
bun test test/audit-content.test.ts
```

- [ ] **Step 4: Implement the pure registry**

Implement the decoder table, literal registry, tool set, provider/model mapping, repair
schemas, and flattened Dream schema exactly as declared above—no inferred keys or generic
“safe string” escape hatch. Errors expose only `unsafe_event_payload` plus the verb family;
they never stringify the rejected key/value. Unit-test every table row plus nested
arrays/objects, oversized strings, NaN/infinity, configured-model mismatches,
prototype-bearing objects, all registered tool verbs, and the three exact `unknown`
sentinel verbs.

- [ ] **Step 5: Convert importer events**

Replace importer `reason` text with fixed codes:

```text
calendar → malformed_code: missing_required_fields
email-meta → malformed_code: missing_required_headers
health → malformed_code: invalid_start_date | invalid_numeric_value
```

Retain only the whitelisted health record kind alongside its code. Import summary events
use the four integer counters. Run:

```bash
bun test test/m4.importers.test.ts
```

- [ ] **Step 6: Convert onboarding events**

Allow only the seven named integer section counts in `onboard:complete`; reject arbitrary
count keys and non-integers.

```bash
bun test test/onboard.test.ts test/audit-content.test.ts -t "onboard"
```

- [ ] **Step 7: Convert watcher events**

Replace watcher titles/questions/paths with the exact ID/score schemas above;
`inbox:orphaned` carries only `code: "source_missing"`. Run watcher,
archive, and sentinel tests before continuing.

```bash
bun test test/audit-content.test.ts -t "watcher" test/m10.classify-guardrails.test.ts
```

- [ ] **Step 8: Convert MCP audit and unlock events**

MCP result events carry a fixed `error_code`, never an exception message; unlock carries
duration and `expires_at.toISOString()` only. Drive a malformed/unknown raw JSON-RPC call through
`audited-transport.ts` and prove attempt/result/disposition use only the registered
`tool:unknown*` schemas.

```bash
bun test \
  test/h4-audit-state.test.ts \
  test/h4-audit-transport.test.ts \
  test/m2.tools.test.ts
```

- [ ] **Step 9: Convert provider and dream events**

Provider events use the exact resolved-provider/model allowlist, item counts, and route
tier above. Flatten Dream results into the named counters, required backup status, and
literal failed-step enum using the exhaustive S1/S3 backup mapping above; discard result
arrays, nested maps, backup detail, and exception messages.

```bash
bun test \
  test/m13.provider-routing.test.ts \
  test/h5-contradiction-scan.test.ts \
  test/audit-content.test.ts -t "provider|dream"
```

- [ ] **Step 10: Enforce the registry at the repository door**

`logEvent()` calls `assertContentFreeEventPayload()` before SQL. No overload, script path,
or direct repository call can skip validation; the exact converted producer payloads above
must reach GREEN unchanged.

- [ ] **Step 11: Convert repair events and close the transitive-code gap**

Before backup or dynamic import, compare every tracked path to `HEAD` using Git's indexed
tree, including staged and unstaged differences. A dirty `src/db/repo.ts` must reach neither
pg_dump nor module load. Ignored/untracked owner data remains outside the comparison.
Call `repairAuditVerb()` before name/commit validation, so an unknown or uncommitted name
always logs through `repair:invalid`. Repair events retain only registered
phase/code/counts/IDs. Add tests proving a dirty
tracked dependency reaches neither pg_dump nor module load, while the exact clean committed
tree proceeds.

- [ ] **Step 12: Update the existing subsystem row**

Add `src/util/event-payload.ts` and `test/audit-content.test.ts` to the MCP/audit row with
the replacement/no-new-dependency statement above, then run
`bun run scripts/check-subsystems.ts`.

- [ ] **Step 13: Run the complete privacy branch gate**

```bash
bun test \
  test/audit-content.test.ts \
  test/m6.leak.test.ts \
  test/m13.provider-routing.test.ts \
  test/m15.roles.test.ts \
  test/m4.importers.test.ts \
  test/onboard.test.ts \
  test/m2.tools.test.ts \
  test/h4-audit-state.test.ts \
  test/h4-audit-transport.test.ts
make verify
```

- [ ] **Step 14: Commit**

```bash
git add src/util/event-payload.ts test/audit-content.test.ts \
  src/db/repo.ts src/util/config.ts src/pipeline/watcher.ts src/pipeline/dream.ts \
  src/importers/calendar.ts src/importers/email-meta.ts src/importers/health.ts \
  src/llm/index.ts src/mcp/audit.ts src/mcp/tools/unlock.ts src/onboard.ts \
  scripts/repair.ts docs/SUBSYSTEMS.md \
  test/m6.leak.test.ts test/m13.provider-routing.test.ts \
  test/m15.roles.test.ts test/m4.importers.test.ts \
  test/onboard.test.ts test/m2.tools.test.ts \
  test/h4-audit-state.test.ts test/h4-audit-transport.test.ts
git commit -m "fix: enforce content-free audit payloads"
```

Historical append-only events are not rewritten. Migration 022 prevents direct engineering
access to their old payloads.

---

## S1 Acceptance and Rollback

Acceptance:

- Remote/multi-host/override PostgreSQL targets fail before connection everywhere.
- A resolved cloud provider above its tier ceiling cannot be built or called.
- Concurrent MCP actors cannot share tier-2 access.
- Tier-2 approval is actor-bound, signed by an owner-held private key, and consumed once.
- Migration 021 invalidates active legacy unlocks, and a pre-S1 insert cannot create another.
- Existing-install cutover refuses every live owner session/process and completes only after
  the reviewed S1 posture probe connects as `minime_app`.
- Fresh and existing credential cutovers resume the same validated stage generation after
  every injected crash; a hardened rerun preserves credentials byte-for-byte.
- Normal runtime posture is non-owner and RLS-enforced.
- Engineering reads expose no locked content carrier.
- New event payloads are content-free by construction.
- Raw unknown-tool audit uses its explicit fixed sentinel schema.
- Unknown repair names audit as `repair:invalid`, and every Dream backup outcome has one
  explicit content-free status.
- `make verify` is green fully offline.

Rollback:

- Tasks 1-3 and 6 may be reverted only to the tested S1 compatibility tag; never cross back
  to a binary that lacks actor-scoped database sessions or capability verification.
- Migration 021 remains applied. Operational recovery repairs and continues using
  `minime_app`; the owner DSN remains admin-only and is never a normal-runtime fallback.
- Migration 022 remains applied; old binaries insert new queue/validation rows at fail-closed
  tier 2, but only the tested S1 compatibility tag is eligible to run.
- Never roll back by granting the engineer role direct access to base events or tier-0 data.
