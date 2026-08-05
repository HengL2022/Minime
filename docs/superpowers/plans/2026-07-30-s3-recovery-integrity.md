# S3 Recovery Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make custom-port configuration, backup selection, restore validation, update
ordering, and promotion recovery truthful and fail closed.

**Architecture:** One non-evaluating repository-env wrapper supplies shell operations with
the same configuration as TypeScript. Restore commands distinguish real restic recovery from
an explicit live round trip, run every checked-out migration against the isolated restored
database, and then require an exact migration ledger plus invariant structure. S3 retains
the S0 first-hop refusal, replaces its bounded argument with a private update receipt, and
verifies new code before live migration. Promotion acknowledges every non-atomic rename,
persists each recoverable transition, and rechecks checked-out schema compatibility before
renaming or deleting rollback state.

**Tech Stack:** Bun/TypeScript configuration bridge, Bash 3.2 scripts, PostgreSQL service
files, pg_dump/psql, restic, private atomic files, Make, and GitHub Actions.

## Global Constraints

- `.env` is parsed as data and never sourced or evaluated.
- Caller-exported variables override `.env`.
- Existing `.env` files are never rewritten automatically.
- Default port 5432 remains compatible; custom ports survive install reruns and all daily
  operations.
- Restore defaults to an actual restic snapshot. A fresh live dump requires an explicitly
  different target.
- Replay uses `ON_ERROR_STOP=1`; any SQL or invariant failure prevents green status and
  promotion.
- Update never changes Git checkout or live schema after a configured snapshot failure or
  active backup lease.
- Update, direct live migration, runtime-role hardening/forward repair, restore into
  `minime_restore`, promotion, resume, rollback, and finalize share one admin-database
  topology lease; backup and migration use distinct nested leases.
- Application and advisory-lock SQL stays in `src/db/repo.ts` through S3. Connection
  construction/reservation stays in `src/db/client.ts`; S5 may move repository SQL behind
  the stable facade.
- S0 Tasks 4-5 are a prerequisite: their context-free migration refusal must be released
  before S1 migration 021. S3 must keep accepting the S0 safe update context for one
  compatibility release because an already-parsed S0/S1/S2 updater may fetch S3 code.
- Promotion is described as recoverable, not atomic.
- Plaintext dump/workspace/state files remain private and are removed according to existing
  fixed-diagnostic cleanup rules.
- A restored database is compatible only when checked-out migrations have run successfully
  in that isolated database and its `schema_migrations` ledger exactly equals the sorted
  checked-out `db/migrations/*.sql` filenames.

---

### Task 1: Canonicalize `.env`, port, and connection propagation

**Files:**

- Create: `scripts/with-repo-env.ts`
- Create: `scripts/ops-config.ts`
- Modify: `scripts/lib.sh`
- Modify: `scripts/install.sh`
- Modify: `scripts/setup-env.sh`
- Modify: `scripts/up.sh`
- Modify: `scripts/restore-drill.sh`
- Modify: `scripts/restore-pitr.sh`
- Modify: `scripts/promote-restore.sh`
- Modify: `src/util/libpq-service.ts`
- Modify: `scripts/libpq-service.ts`
- Modify: `Makefile`
- Modify: `.env.example`
- Modify: `test/config.dotenv.test.ts`
- Modify: `test/install.test.ts`
- Modify: `test/setup-env.test.ts`
- Modify: `test/h2.ollama-shell.test.ts`
- Modify: `test/h3-libpq-service.test.ts`
- Modify: `test/h3-restore-scripts.test.ts`

**Interfaces:**

```ts
// bun run scripts/with-repo-env.ts --profile runtime|admin|backup -- <exact argv...>
// Parse the permitted repo env files as data, spawn without a shell,
// and return the child's exact exit status.

export function resolvePgPort(input: {
  explicitPort?: string;
  databaseUrl?: string;
}): number;
```

Resolution order:

1. exported `MINIME_PG_PORT`;
2. the port in validated loopback `DATABASE_URL`;
3. 5432.

If explicit port and URL disagree, fail before Docker/service/database work with exit 40 and
a fixed repair command. Fresh install writes both matching keys. Existing files with only
`DATABASE_URL` work without modification.

Extend the service bridge:

```ts
export async function writeLibpqServiceFile(
  rawUrl: string,
  serviceFile: string,
  options?: {
    database?: "postgres" | "minime" | "minime_test" | "minime_drill" | "minime_restore";
  },
): Promise<void>;
```

Changing a database name happens in parsed libpq parameters, never through shell string
editing.

Profile precedence is fixed:

```text
caller-exported environment
  > selected profile file (`.env.admin` or `.env.backup`)
  > base `.env`
  > code default
```

`runtime` reads only `.env`; `admin` overlays only the approved admin DSN keys from
`.env.admin`; `backup` overlays only the approved backup DSN keys from `.env.backup`.
For `admin` and `backup`, “caller-exported” means the matching profile-specific key
(`MINIME_ADMIN_DATABASE_URL` or `MINIME_BACKUP_DATABASE_URL`), not a generic inherited
`DATABASE_URL`: after resolving that specific key, the wrapper overwrites the child's
`DATABASE_URL` and deletes both profile-specific source keys. Thus an inherited runtime
URL cannot defeat the selected privilege profile. Unrecognized keys in the profile files
are ignored. `up` uses runtime; restore/promotion use admin while retaining restic
variables from base `.env`. `make migrate`, the checked-out migration CLI, update's
migration child, `scripts/repair.ts`, restore, promotion, resume/rollback/finalize, and the
topology wrapper use `admin`; `up`, `serve`, daemon, and ordinary application commands use
`runtime`. S1's hardening/forward-repair commands retain their staged-credential state
machine rather than being flattened into one profile. `scripts/ops-config.ts` imports S1's
`readPrivateEnvKeys()` from `src/util/env-file.ts`; it must not implement or source a second
dotenv grammar. The owner-only `unlock:grant` path remains a signing-key-only read and is
not widened by these operational profiles.

- [ ] **Step 1: Write custom-port and hostile-dotenv tests**

Cover:

- old `.env` with only `DATABASE_URL=...:5433/minime`;
- explicit 5432 conflicting with `.env` 5433;
- caller override precedence;
- an inherited runtime `DATABASE_URL` being replaced by the selected admin/backup DSN,
  while the matching exported profile-specific key still overrides its file;
- `X=$(touch sentinel)` reaching a child literally without creating the sentinel;
- restore receiving restic credentials without printing them;
- database-name replacement preserving host/port/TLS/credentials.
- requested backup setup without `restic` or a compatible host `pg_dump`.

- [ ] **Step 2: Prove focused tests are red**

```bash
bun test \
  test/config.dotenv.test.ts \
  test/install.test.ts \
  test/setup-env.test.ts \
  test/h2.ollama-shell.test.ts \
  test/h3-libpq-service.test.ts \
  test/h3-restore-scripts.test.ts
```

- [ ] **Step 3: Implement the wrapper and port resolver**

`with-repo-env.ts` sets `MINIME_REPO_ENV_LOADED` to the exact selected literal
`runtime|admin|backup` to prevent recursive wrapping and make profile identity testable. It
calls `Bun.spawn()` with an argv array and never invokes a shell. `up`, restore, promotion,
the direct/receipt/compat migration CLI, repair, and their Make targets self-reexec through
the correct profile exactly once. A migration CLI reached from an already-running
S0/S1/S2 updater performs this profile reexec before it imports migration or opens a
topology connection. Task 5 also routes the S1 dump-only worker through
`--profile backup`; normal CLI, daemon, and Dream parents remain on the runtime profile.

- [ ] **Step 4: Disable placeholder backups by default**

Comment example repository/password values and set:

```dotenv
BACKUP_CRON=""
```

Only `make setup` enables backups. When backup setup is requested, both `restic` and a
compatible host `pg_dump` must exist. If either is unavailable, setup preserves the entered
repository settings but keeps `BACKUP_CRON=""`, reports a fixed installation command, and
never claims backups are active.

- [ ] **Step 5: Run shell/config gates and commit**

```bash
bun test \
  test/config.dotenv.test.ts test/install.test.ts test/setup-env.test.ts \
  test/h2.ollama-shell.test.ts test/h3-libpq-service.test.ts \
  test/h3-restore-scripts.test.ts
bash -n scripts/*.sh
make -n up restore-drill promote-restore
git add \
  scripts/with-repo-env.ts scripts/ops-config.ts scripts/lib.sh \
  scripts/install.sh scripts/setup-env.sh scripts/up.sh scripts/restore-drill.sh \
  scripts/restore-pitr.sh scripts/promote-restore.sh \
  src/util/libpq-service.ts scripts/libpq-service.ts Makefile .env.example \
  test/config.dotenv.test.ts test/install.test.ts test/setup-env.test.ts \
  test/h2.ollama-shell.test.ts \
  test/h3-libpq-service.test.ts test/h3-restore-scripts.test.ts
git commit -m "fix: propagate repository ops configuration safely"
```

---

### Task 2: Select a real snapshot and fail closed on replay

**Files:**

- Modify: `scripts/pick-snapshot.ts`
- Modify: `scripts/restore-drill.sh`
- Modify: `scripts/restore-pitr.sh`
- Modify: `Makefile`
- Modify: `test/h3-restore-scripts.test.ts`

**Command contract:**

```text
make restore-drill
  Restore latest db-snap/dream restic snapshot into minime_drill.

make restore-drill-live
  Explicitly pg_dump the live database and replay it into minime_drill.

make restore-snapshot TIME="2026-06-12 14:30"
  Restore latest db-snap/dream snapshot at or before TIME into minime_restore.

make restore-pitr TIME="..."
  One-release alias that states this is logical snapshot restore, not WAL PITR.
```

Snapshot picker CLI:

```text
bun run scripts/pick-snapshot.ts --latest
bun run scripts/pick-snapshot.ts --at "2026-06-12 14:30"
```

It accepts only snapshots containing `db-snap` or `dream`, ignores `pre-promote`, sorts by
snapshot time rather than JSON order, and returns only an opaque restic snapshot ID.

- [ ] **Step 1: Write snapshot-selection tests**

Provide out-of-order restic JSON containing a newest `pre-promote`, an older `db-snap`, and
an even older `dream`. Assert `--latest` selects `db-snap`; `--at` selects the newest
eligible item at or before the bound; no eligible item exits 2 without invoking restore.

- [ ] **Step 2: Write replay-failure tests**

Plant fake `psql` behavior that emits `ERROR:` but exits zero. Both restore scripts must use
`ON_ERROR_STOP=1`, exit 4, emit no green/complete line, and remove the private workspace.
Unconfigured `restore-drill` exits 2 and never invokes `pg_dump`; only
`restore-drill-live` may create a fresh dump.

- [ ] **Step 3: Prove selection and replay tests are red**

```bash
bun test test/h3-restore-scripts.test.ts \
  --test-name-pattern "snapshot selection|replay"
```

- [ ] **Step 4: Implement selection and strict replay**

Pass the selected ID to `restic restore <id>` as one argv element. Replay with
`-v ON_ERROR_STOP=1`; remove stderr-content heuristics and never downgrade a nonzero replay
status.

- [ ] **Step 5: Run and commit the replay boundary**

```bash
bun test test/h3-restore-scripts.test.ts
bash -n scripts/restore-drill.sh scripts/restore-pitr.sh
git add \
  scripts/pick-snapshot.ts scripts/restore-drill.sh scripts/restore-pitr.sh \
  Makefile test/h3-restore-scripts.test.ts
git commit -m "fix: restore only selected snapshots with strict replay"
```

---

### Task 3: Prove checked-out schema compatibility in the isolated restore

**Files:**

- Create: `scripts/restore-schema-gate.ts`
- Create: `db/restore-validation.sql`
- Create: `test/migration-ledger.test.ts`
- Modify: `src/db/migrate.ts`
- Modify: `scripts/restore-drill.sh`
- Modify: `scripts/restore-pitr.sh`
- Modify: `test/h3-restore-scripts.test.ts`

**Interfaces:**

This task consumes the S0 `MigrationContext`, `inspectSchemaPosture()`, and
`migrate({ kind: "restore" })` interfaces.

```ts
export type RestoreDatabaseName = "minime_drill" | "minime_restore";

export type RestoreSchemaGateInput = {
  database: RestoreDatabaseName;
  mode: "migrate-and-check" | "check-only";
};

export async function runRestoreSchemaGate(
  input: RestoreSchemaGateInput,
): Promise<void>;
```

CLI:

```text
bun run scripts/restore-schema-gate.ts \
  --database minime_drill|minime_restore \
  --mode migrate-and-check|check-only
```

The script derives the isolated URL by parsing the admin-profile DSN and replacing only the
database pathname. It rejects every other database name, assigns the derived URL to
`process.env.DATABASE_URL`, and only then dynamically imports `src/db/client` and
`src/db/migrate`. Its first query requires `current_database()` to equal the allowlisted
input. `migrate-and-check` calls `migrate({ kind: "restore" })`; both modes then call
`inspectSchemaPosture()` and require:

```ts
posture.missing.length === 0 &&
posture.unexpected.length === 0 &&
posture.applied.length === posture.expected.length
```

Only after that gate succeeds does the shell run read-only `db/restore-validation.sql`,
which proves the core `events`, `pages`, `chunks`, `transactions`, and `health_samples`
tables, `vector` and `pgcrypto`, and append-only event triggers. A nonempty ledger is not
sufficient. That `psql` invocation uses the same target-specific mode-0600 service file
created by `writeLibpqServiceFile(..., { database: input.database })`; it never inherits a
default database and never receives a URL on argv.

- [ ] **Step 1: Write exact-ledger unit tests**

Use the real sorted checked-out filenames as `expected`. Cover exact, extra, duplicate, and
missing cases. The binding regression removes the latest filename:

```ts
const expected = await checkedOutMigrationNames();
const applied = expected.slice(0, -1);
const posture = compareMigrationLedger(expected, applied);
expect(posture.missing).toEqual([expected.at(-1)]);
expect(() => assertSchemaPostureCurrent(posture)).toThrow("migration_ledger_mismatch");
```

The public failure is fixed and does not print filenames or DSNs.

- [ ] **Step 2: Write isolated upgrade-order tests**

Build a dump whose ledger ends at the penultimate checked-out migration. Assert the trace:

```ts
expect(trace).toEqual([
  "replay",
  `migrate:${latestMigration}`,
  "ledger:exact",
  "structure:valid",
]);
```

Then make the migration runner skip that latest file and assert the ledger gate exits 4
before structural validation. Make the latest migration body fail and assert the same
refusal. Cleanup policy is command-specific: `minime_drill` is always dropped on success or
failure; a failed `minime_restore` is left locally for owner inspection with no success
marker, and the next `restore-snapshot` drops/recreates it before replay. Promotion's
check-only ledger and structural gates refuse that failed candidate.

- [ ] **Step 3: Prove ledger and order tests are red**

```bash
bun test \
  test/migration-ledger.test.ts \
  test/h3-restore-scripts.test.ts \
  --test-name-pattern "schema gate|ledger"
```

- [ ] **Step 4: Implement the isolated migration gate**

In both restore scripts, the post-replay sequence is exactly:

```text
derive target URL and service file for the same allowlisted database
set DATABASE_URL; dynamic-import client; assert current_database()
migrate({ kind: "restore" }) and exact-ledger assertion in restore-schema-gate
PGSERVICEFILE=<target file> psql -v ON_ERROR_STOP=1 -f db/restore-validation.sql
success output
```

Do not run current migrations against `minime`. The TypeScript gate closes its target pool
before returning so promotion/cleanup can rename or drop the database.

- [ ] **Step 5: Add the promotion check-only seam**

`--mode check-only` performs no migration and initially accepts only the isolated
`minime_drill`/`minime_restore` allowlist; Task 7 uses it for immediate promotion preflight.
Test that `--database minime` and any arbitrary name fail before a socket or filesystem side
effect. Task 10 later adds the narrowly state-bound live-finalization union member.

- [ ] **Step 6: Run and commit the compatibility gate**

```bash
bun test test/migration-ledger.test.ts test/h3-restore-scripts.test.ts
bash -n scripts/restore-drill.sh scripts/restore-pitr.sh
git add \
  scripts/restore-schema-gate.ts db/restore-validation.sql \
  test/migration-ledger.test.ts src/db/migrate.ts \
  scripts/restore-drill.sh scripts/restore-pitr.sh \
  test/h3-restore-scripts.test.ts
git commit -m "fix: require checked-out schema on restored databases"
```

---

### Task 4: Prove a genuine restic round trip

**Files:**

- Create: `test/restore-integration.test.ts`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/GUIDE.md`
- Modify: `docs/SUBSYSTEMS.md`
- Modify: `DECISIONS.md`

- [ ] **Step 1: Write the gated local-restic test**

With `MINIME_RESTORE_E2E=1`, create an isolated source DB and temporary local restic repo,
snapshot a fictional dump whose ledger lacks the checked-out latest migration, run
`make restore-drill`, and assert the latest migration is applied before exact-ledger and
structural validation.

- [ ] **Step 2: Add corrupt and cleanup cases**

Corrupt SQL, a missing latest migration after the gate, a missing append-only trigger, and
an unexpected ledger filename each exit nonzero with no green line. Every case removes
plaintext workspaces and service files; the drill scratch DB is dropped on success and
failure.

- [ ] **Step 3: Run the genuine gate**

```bash
MINIME_RESTORE_E2E=1 bun test test/restore-integration.test.ts
```

- [ ] **Step 4: Record truthful semantics and commit**

Document logical-snapshot naming, isolated upgrade-before-validation, and the exact checked-
out ledger requirement.

```bash
git add \
  test/restore-integration.test.ts README.md AGENTS.md docs/GUIDE.md \
  docs/SUBSYSTEMS.md DECISIONS.md
git commit -m "test: prove checked-out restore compatibility end to end"
```

---

### Task 5: Finish backup outcomes and bind migration to an update receipt

**Files:**

- Modify: `src/pipeline/backup.ts`
- Modify: `src/pipeline/dream.ts`
- Modify: `src/runtime/daemon.ts`
- Modify: `src/cli.ts`
- Modify: `src/db/client.ts`
- Modify: `src/db/repo.ts`
- Create: `src/util/update-receipt.ts`
- Create: `scripts/with-ops-lease.ts`
- Create: `scripts/update-receipt.ts`
- Modify: `scripts/run-backup-worker.ts`
- Modify: `scripts/with-repo-env.ts`
- Modify: `scripts/harden-runtime-role.ts`
- Modify: `scripts/update.sh`
- Modify: `scripts/restore-pitr.sh`
- Modify: `Makefile`
- Modify: `test/backup.test.ts`
- Modify: `test/runtime-daemon.test.ts`
- Modify: `test/runtime-role-cutover.test.ts`
- Modify: `test/h3-data-root.test.ts`
- Modify: `test/m5.decisions.test.ts`
- Modify: `test/update.test.ts`
- Modify: `test/update-bootstrap.test.ts`
- Modify: `test/h3-restore-scripts.test.ts`
- Create: `test/update-receipt.test.ts`
- Create: `test/ops-locking.test.ts`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/GUIDE.md`

**Backup and operations contracts:**

```ts
export type BackupOutcome =
  | { kind: "taken"; detail: string }
  | { kind: "unconfigured"; detail: string }
  | { kind: "busy"; detail: string }
  | { kind: "failed"; detail: string };

export interface DreamBackupSummary {
  backup_status: BackupOutcome["kind"];
}

export function summarizeBackupOutcome(
  outcome: BackupOutcome,
): DreamBackupSummary;

export interface UpdateReceipt {
  version: 1;
  phase: "snapshotted" | "fetched";
  oldHead: string;
  newHead?: string;
  snapshot: "taken" | "unconfigured";
  nonce: string;
  createdAt: string;
}

export async function readUpdateReceipt(path: string): Promise<UpdateReceipt>;
export async function writeUpdateReceipt(
  path: string,
  receipt: UpdateReceipt,
): Promise<void>;

export async function validateUpdateReceipt(
  path: string,
  currentHead: string,
  isAncestor: (oldHead: string, newHead: string) => Promise<boolean>,
): Promise<"taken" | "unconfigured">;

export type UpdateCliContextInput =
  | { kind: "receipt"; path: string; currentHead: string }
  | { kind: "s0_compat"; snapshot: "taken" | "unconfigured" };

export async function migrationContextFromUpdateCli(
  input: UpdateCliContextInput,
): Promise<MigrationContext>;

export type AdminOpsLeaseName = "topology";

export async function reserveLocalDb(input: {
  databaseUrl: string;
  database: "postgres";
}): Promise<DbReservation>;

export interface AdminOpsLeaseCapability {
  version: 1;
  name: AdminOpsLeaseName;
  admissionBackendPid: number;
  continuityBackendPid: number;
  nonceHash: string;
  createdAt: string;
}

export interface InheritedAdminOpsLease {
  capabilityPath: string;
  nonce: string;
}

export async function withAdminOpsLease<T>(
  name: AdminOpsLeaseName,
  work: () => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }>;

export async function runUnderAdminOpsLease<T>(
  name: AdminOpsLeaseName,
  inherited: InheritedAdminOpsLease | undefined,
  work: () => Promise<T>,
): Promise<T>;
```

S2's outer `DreamRunResult` stays unchanged. Only its winning `summary` content changes:
step `7_backup` is the `DreamBackupSummary` above, while `{ ran:false }` still means another
Dream owner and performs no backup or audit work.

`reserveLocalDb()` lives in `src/db/client.ts`. It validates the DSN with S1's loopback-only
validator, creates a private one-connection postgres.js pool with the database override,
reserves its one connection, and makes `DbReservation.release()` release the connection and
close that private pool exactly once. It contains no SQL. `withAdminOpsLease()` and
`runUnderAdminOpsLease()` live in `src/db/repo.ts`, which owns every advisory-lock,
`pg_backend_pid()`, and `pg_locks` query. They use `reserveLocalDb()` against the
admin-profile URL with database `postgres`; they never call S1's singleton-runtime
`reserveDb()` and never connect topology locking to the live `minime` database.

Before pg_dump/restic is spawned, backup validates `RESTIC_PASSWORD_FILE` as an owner-owned,
regular, non-symlink file with mode 0600. Any violation returns a fixed configured failure
without opening or printing the path.

Every normal backup entry point—manual CLI, 15-minute daemon tick, nightly Dream, and
pre-update snapshot—calls S2's public `backup()`/`dbSnapshot()` parent. That parent alone
owns the `"backup"` lease and, while holding it, spawns this exact argv without a shell:

```text
bun run scripts/with-repo-env.ts --profile backup --
  bun run scripts/run-backup-worker.ts --tag dream|db-snap --source backup-profile
```

For `--source backup-profile`, `scripts/run-backup-worker.ts`, introduced in S1, now refuses
unless `MINIME_REPO_ENV_LOADED=backup`, deletes the profile-only source key after
`MINIME_BACKUP_DATABASE_URL` has been mapped to `DATABASE_URL`, dynamically imports the raw
dump implementation, and emits exactly one bounded versioned result record. The runtime
parent captures at most 1 KiB, rejects extra/malformed output as `failed`, and maps only the
fixed result enum; it never receives the backup DSN or raw child output. `make backup`
continues to invoke the ordinary runtime CLI because the public operation performs this
delegation internally. The daemon scheduler must not wrap the call in another `"backup"`
lease.

S1's `--source cutover-owner` mode remains a separate, binding compatibility path for an
owner upgrading directly from an unhardened pre-S1 installation to S3 or later. It does not
use the backup profile because `minime_backup` does not exist yet. It retains S1's stopped
runtime, staged-generation, legacy-owner-posture, pending-021, and no-public-CLI guards;
accepts the owner DSN only through the hardening child's scrubbed environment; and becomes
unreachable once 021 or profile publication completes. The S3 wrapper must not rewrite this
mode to `backup-profile` or require `MINIME_REPO_ENV_LOADED=backup`.

The 15-minute snapshot path performs dump, restic backup, and lightweight snapshot selection
without `restic prune`. Prune runs once in nightly dream maintenance under the same backup
lease. This removes the existing 96-prunes-per-day repository lock/I/O pattern while
preserving snapshot cadence.

CLI exits:

```text
0 snapshot taken
3 genuinely unconfigured
4 another process owns the backup lease
1 configured backup failed
```

Make exposes the same contract:

```make
backup:
	@$(BUN) run src/cli.ts backup
```

Update order:

1. Parse flags; validate checkout and clean tracked tree.
2. Run the old, known-working backup command before fetch.
3. Continue only for exit 0 or exit 3; write a private `snapshotted` receipt containing full
   `oldHead` and the exhaustive outcome.
4. Fetch and fast-forward; rewrite the receipt as `fetched` with full `newHead`.
5. Install frozen dependencies.
6. Run `make verify-offline` against isolated scratch databases unless `--skip-verify`.
7. Validate that the mode-0600, owner-owned, regular, non-symlink receipt is `fetched`, its
   `newHead` equals current `HEAD`, and `oldHead` is an ancestor; then run locked migrations
   with the S0 `{ kind: "update", snapshot }` context.
8. Remove the receipt on success, failure, and signal; print restart/daemon reminder and
   summary.

The receipt lives in a validated mode-0700 temporary directory under `data/tmp/update/`, is
published by fsync plus sibling rename, contains no DSN/path/content, and is never printed.
`scripts/update-receipt.ts` accepts values as separate argv elements and emits only fixed
status. For `--receipt`, `src/cli.ts` parses args, reads current HEAD, calls
`migrationContextFromUpdateCli()`, and only after it returns enters
`runUnderAdminOpsLease("topology", inherited, work)`. Inside `work` it dynamically imports
`src/db/migrate` and calls `migrate({ kind: "update", snapshot })`. The one-release legacy
branch maps the exact S0 `--snapshot-outcome` argument to the same context, then enters the
same topology helper before the dynamic import. `--context direct` also enters that helper;
the S0 no-context refusal still occurs before lease acquisition or a socket. `migrate()`
itself never reads a path, receipt, or topology capability.

`bun run scripts/with-ops-lease.ts topology -- <exact argv...>` holds one shared topology
advisory lock on the admin `postgres` database while the child runs. It never uses a
live-`minime` connection (which would block promotion rename), never invokes a shell, and
returns exit 4 without spawning the child when busy. `scripts/update.sh`,
`restore-snapshot`, S1's runtime-role hardening/forward repair, and, in Tasks 7-10,
promotion/recovery self-reexec through it exactly once. Backup and migration retain their
distinct nested S2 leases.

Hardening resolves its current owner credential read-only before entering topology because
an unhardened direct upgrade has no `.env.admin` yet, and a crash-resume may require the
staged owner credential. It uses S1's existing validated state selector—published admin,
valid staged admin, or legacy owner `.env` only for the exact unhardened posture—then passes
the selected URL only in the wrapper child's environment. No role, schema, password, stage,
or final file changes during this pre-lock selection. The outer topology connection is to
database `postgres`; it remains valid while the child rotates the owner password. The
wrapped child receives the inherited capability and executes the full stopped-runtime
preflight → S2-leased cutover snapshot → role bootstrap → 021 → password/profile
publication sequence. Forward repair uses the same entry. Busy topology returns fixed exit
4 before the backup lease or any mutation.

Like S2's runtime/migration lease contract, `withAdminOpsLease()` reserves one concrete
admin connection, runs `pg_try_advisory_lock`, `pg_backend_pid()`, the callback, and unlock
on that same session, and does not release it to a pool until cleanup completes. Topology
uses two fixed advisory keys: an outer `admission` key and an inherited-child `continuity`
key. Every top-level operation acquires `admission`, probes and immediately releases
`continuity` before doing work, and retains `admission`; a busy continuity probe releases
admission and returns busy. Tests record the backend PID for acquire, capability
publication, work, and unlock and require one identity throughout.

All SQL in that paragraph is implemented in `src/db/repo.ts`. The repository receives only
the reserved executor returned by `reserveLocalDb()`; it neither constructs an ops pool nor
imports postgres.js directly. S5 later moves these functions and their private SQL helpers
verbatim into `src/db/repos/runtime.ts` behind the same facade.

To avoid self-deadlock while also protecting every wrapped shell child, not only migration,
`scripts/with-ops-lease.ts` has an internal supervisor mode. The outer process reserves
admission and opens a liveness pipe. Before spawning the requested argv, its supervisor
reserves a second admin session, acquires continuity, verifies that the outer
`admissionBackendPid` still owns the exact admission key, and atomically publishes a
mode-0600, owner-owned, regular, non-symlink capability in the wrapper's private mode-0700
workspace. The record contains the lease name, both backend PIDs, SHA-256 of a 256-bit
nonce, and a timestamp. Only then does the supervisor spawn the requested argv in its own
dedicated process group, whose PGID the outer knows before work begins, with scrubbed
`MINIME_ADMIN_OPS_CAPABILITY` and
`MINIME_ADMIN_OPS_NONCE` variables.

`runUnderAdminOpsLease()` treats that pair as inherited only after validating path, owner,
mode, inode stability, name, nonce hash, and that the two recorded backends currently hold
the exact admission and continuity keys in `pg_locks`. It does not acquire a third lock.
A partial or invalid pair fails closed and never falls back to an unlocked migration. With
no inherited pair, the helper is a top-level operation: it acquires admission, probes
continuity, and keeps admission open through `migrate()`.

The outer wrapper owns the liveness pipe's write end; only the supervisor reads it. On
INT/TERM/HUP, the outer forwards the signal and waits. The supervisor forwards it to the
requested child's whole process group, waits for every child to exit, removes the
capability, releases continuity, and exits; only then does the outer release admission. On
abrupt outer death, pipe EOF drives the same supervisor kill-and-wait path. Admission may
already be free, but every new topology operation fails its continuity probe until the old
child is gone. If outer death occurs before continuity/validation, the supervisor never
spawns the requested argv. If the supervisor itself exits unexpectedly while the outer is
alive, the outer kills the known dedicated child process group and waits for it to become
empty before releasing admission. Normal success uses the same child wait → capability
removal → continuity unlock → supervisor exit → admission unlock order. Thus update,
restore, promotion, recovery, and nested migration all share the same crash-safe lifetime
boundary.

Cross-version compatibility is binding:

- A pre-S0 updater that fetched this code still supplies no context and remains refused by
  S0's first-transition guard.
- An already-parsed S0/S1/S2 updater supplies
  `--context update --snapshot-outcome taken|unconfigured`; S3 accepts that bounded legacy
  form for one release because that updater already performed the S0 safe pre-fetch check.
  Because it did not execute S3's wrapper, the checked-out CLI acquires topology itself
  before dynamically importing the migration code.
- The checked-out S3 updater uses only `--context update --receipt <private-file>`.

- [ ] **Step 1: Write backup outcome and lease tests**

Assert two independent backup attempts yield one owner and one busy outcome; release occurs
after success, throw, child failure, and signal. Invoke a real scheduled backup and prove it
reaches one dump-only child while the parent holds exactly one `"backup"` lease; fail on a
nested acquisition. Run manual, daemon, Dream, and pre-update entry points with sentinel
runtime/admin/backup usernames and require only the dedicated child to observe
`minime_backup`. Reject a worker launched without the exact `backup` profile marker,
malformed/oversize/extra result output, and any worker environment containing the admin DSN
or signing key. No parent output or argv may contain any DSN.

Run a direct-upgrade fixture from an unhardened pre-S1 install into the checked-out S3 code:
the hardening command must take its pre-image through `cutover-owner`, apply 021, publish
the three profiles, and thereafter reject that mode. A `backup-profile` invocation without
the exact profile marker must still fail. Hold topology before hardening and require fixed
exit 4 with no backup/role/schema/stage mutation. SIGKILL the hardening launcher after the
supervisor starts its cutover backup and prove the child group exits before continuity
unlocks; rerun then resumes the same S1 generation under the selected staged credential.

Table-drive the daemon backup tick across all four `BackupOutcome` variants and a throw;
assert it never parses `detail`, never acquires a second lease, and emits only fixed
lifecycle statuses.

Run two topology wrappers and assert one child trace and one fixed busy exit. Assert update
versus promotion and restore-snapshot versus promotion contend on the same topology key;
backup and migration keys remain distinct from topology and from each other so nested
operations do not self-deadlock. Reserve topology through a URL whose path names `minime`
and prove the actual reserved backend is the admin role on database `postgres`; assert the
singleton runtime pool was never touched. Reject a non-loopback alternate reservation
before a socket. Direct, receipt, and compatibility migration invocations beginning under
the runtime profile must open their first database session only after one admin-profile
reexec.

Hold topology in one process and invoke the checked-out migration CLI directly with
`--context direct`; assert fixed exit 4/`ops_topology_busy`, an unchanged ledger/schema
fingerprint, and no import of `src/db/migrate`. Under a real wrapper capability, assert
direct/receipt migration validates both inherited holders and does not attempt a third
advisory lock. Reject missing-half, symlink, wrong-mode/owner, nonce-mismatch,
stale-admission, stale-continuity, swapped-backend, and wrong-lock-key capabilities before
the migration connection.

For INT/TERM/HUP, assert the exact wrapper trace is `signal:forward`,
`supervisor:signal:forward`, `child:exited`, `capability:removed`,
`continuity:unlocked`, `admission:unlocked`; a child sentinel after `child:exited` must
remain absent. For the crash boundary, park both (a) an inherited transactional migration
and (b) a non-migration restore/promotion fixture after the supervisor holds continuity,
then SIGKILL the outer wrapper. In both cases assert pipe EOF terminates the whole child
group and a second topology operation cannot pass its continuity probe until every old
child and DB session has exited. The migration transaction leaves no ledger/schema change;
the non-migration fixture never writes its post-crash sentinel or performs a restore/rename.
Also SIGKILL before continuity acquisition and prove the supervisor never spawns the
requested argv. Separately SIGKILL the supervisor while the outer remains alive and prove
the outer kills the known child process group before admission unlock. These are
subprocess/PostgreSQL tests, not mocked ordering assertions.

Add password-file cases for missing, symlinked, wrong-owner/mode, and regular 0600 files.
Simulate one day of 15-minute snapshots and assert no prune; invoke nightly retention and
assert exactly one prune.

Table-drive `summarizeBackupOutcome()` across all four union members and require the exact
content-free objects `{ backup_status: "taken" | "unconfigured" | "busy" | "failed" }`.
The dream step `7_backup` stores only that summary: it never carries `detail`, child output,
paths, or exception text into the dream summary or S1 audit payload. In S1's flattened
audit summary, `taken|unconfigured|busy` do not add a failed step; `failed` or a thrown
backup adds `7_backup` to `failed_steps`. Assert all five cases.

- [ ] **Step 2: Write receipt parser/filesystem tests**

Reject a symlink, wrong owner/mode, corrupt version/phase, invalid commit IDs, missing
`newHead`, current-HEAD mismatch, non-ancestor old head, and changed inode between validation
and read. Assert no rejected case reaches the migration connection.

```bash
bun test test/update-receipt.test.ts
```

- [ ] **Step 3: Write update and cross-version trace tests**

Use command sentinels. Backup exit 1 or 4 must prevent fetch, pull, install, verify, and
migrate. Exit 3 emits a SKIP and proceeds. A successful trace is exactly:

```text
preflight, backup, receipt:snapshotted, fetch, pull, receipt:fetched,
install, verify, receipt:validated, migrate, receipt:removed
```

Configured failure output contains no child text. Reuse S0's minimal pre-S0 transition harness contract
and assert migration refusal with an absent context. Generate another minimal commit-A driver
inside S3's own temporary bare-origin/clone repository; no updater fixture file is copied,
shared, or required. Assert that generated driver's bounded legacy context remains accepted
during the stated compatibility release after a successful/unconfigured snapshot. Run the
already-parsed generated driver from commit A, let it fast-forward to commit B containing the
S3 CLI, and hold topology when it reaches B's legacy migration branch. Assert B's CLI returns fixed
exit 4/`ops_topology_busy` before importing migration code; the frozen outer updater maps
that failed migration to its documented exit 50. The ledger count and schema fingerprint
remain unchanged and the pending migration is absent. Releasing the lease and rerunning the
checked-out S3 updater applies it exactly once. This is a live
process/checked-out-binary test, not a source grep or a wholly stubbed updater.

- [ ] **Step 4: Prove tests are red**

```bash
bun test \
  test/backup.test.ts test/runtime-daemon.test.ts test/ops-locking.test.ts \
  test/runtime-role-cutover.test.ts \
  test/m5.decisions.test.ts \
  test/update-receipt.test.ts test/update.test.ts \
  test/update-bootstrap.test.ts test/h3-restore-scripts.test.ts
```

- [ ] **Step 5: Implement exhaustive outcomes and update receipts**

Remove ambiguous string parsing from update. All backup/dream/CLI consumers switch
exhaustively on `BackupOutcome`; this includes `src/runtime/daemon.ts`, whose S2
`DaemonDeps.runBackup` signature changes to `Promise<BackupOutcome>`. `dream.ts` maps it through
`summarizeBackupOutcome()` to the fixed `backup_status` enum and discards `detail`. Keep
S0's `backup:pre-update` exit-code contract while backing it with the new union.
Replace S1's private backup-profile loader with the exact `with-repo-env --profile backup`
worker argv above; all four normal parent entry points share that one implementation.
Preserve the guarded `cutover-owner` branch unchanged for direct upgrades. Add
`reserveLocalDb()` to `src/db/client.ts`, and implement the topology functions plus all of
their advisory/catalog SQL in `src/db/repo.ts`.
Create/advance the receipt only after the preceding operation succeeds; an EXIT/signal trap
removes the validated owned file. Add the one-time topology self-reexec to update and
`restore-pitr.sh`/`restore-snapshot`, and add the read-only credential-selection plus
topology self-reexec to S1 hardening/forward repair; Tasks 7-10 add it to every promotion
action. Route
both update CLI forms and `--context direct` through
`runUnderAdminOpsLease()`: validate a real inherited capability when wrapped, otherwise
acquire the topology admission lease locally and refuse busy before the migration import.
Implement the continuity-key supervisor handoff, outer-to-supervisor liveness pipe,
process-group signal forwarding, child wait, and cleanup order exactly as specified above.

- [ ] **Step 6: Run update/backup/full gates and commit**

```bash
bun test \
  test/backup.test.ts \
  test/runtime-daemon.test.ts \
  test/runtime-role-cutover.test.ts \
  test/h3-data-root.test.ts \
  test/m5.decisions.test.ts \
  test/ops-locking.test.ts \
  test/update-receipt.test.ts \
  test/update.test.ts \
  test/update-bootstrap.test.ts \
  test/h3-restore-scripts.test.ts
bash -n scripts/update.sh
make verify
git add \
  src/pipeline/backup.ts src/pipeline/dream.ts src/runtime/daemon.ts src/cli.ts \
  src/db/client.ts src/db/repo.ts src/util/update-receipt.ts \
  scripts/run-backup-worker.ts scripts/with-repo-env.ts scripts/with-ops-lease.ts \
  scripts/harden-runtime-role.ts \
  scripts/update-receipt.ts scripts/update.sh scripts/restore-pitr.sh Makefile \
  test/backup.test.ts test/runtime-daemon.test.ts \
  test/runtime-role-cutover.test.ts \
  test/h3-data-root.test.ts test/m5.decisions.test.ts \
  test/ops-locking.test.ts \
  test/update-receipt.test.ts \
  test/update.test.ts test/update-bootstrap.test.ts \
  test/h3-restore-scripts.test.ts \
  README.md AGENTS.md docs/GUIDE.md
git commit -m "fix: bind live migration to a verified update receipt"
```

Rollback keeps the S0 migration-context guard and legacy bounded form. Reverting the receipt
implementation therefore fails closed rather than re-enabling context-free migration.

---

### Task 6: Add a private promotion manifest and pure catalog model

**Files:**

- Create: `src/util/promotion-state.ts`
- Create: `test/promotion-state.test.ts`

**Interfaces:**

```ts
export type PromotionPhase =
  | "prepared"
  | "live_renamed"
  | "promoted"
  | "rollback_live_renamed";

export interface PromotionState {
  version: 1;
  phase: PromotionPhase;
  live: "minime";
  restore: "minime_restore";
  rollback: "minime_replaced";
  dumpBasename: string;
  createdAt: string;
}

export interface PromotionCatalog {
  live: boolean;
  restore: boolean;
  rollback: boolean;
}

export async function readPromotionState(path: string): Promise<PromotionState | null>;
export async function writePromotionState(
  path: string,
  state: PromotionState,
): Promise<void>;
export function catalogKey(catalog: PromotionCatalog): string;
```

The canonical manifest is `db-dump/promotion-state.json`, mode 0600 beneath the already
validated mode-0700 dump root. Writes use a private sibling, fsync file and directory, then
atomic rename. Reads reject a symlink, wrong owner/mode, noncanonical path, corrupt
version/phase, unsafe dump basename, and unknown keys before any database command.

- [ ] **Step 1: Write pure codec tests**

Round-trip every phase. Reject `version: 2`, an unknown phase/key, database-name changes,
path separators/`..` in `dumpBasename`, invalid timestamp, and missing fields.

- [ ] **Step 2: Write filesystem publication tests**

Inject failure before fsync, after file fsync, and before rename. Assert the old manifest is
unchanged, no partial canonical file is visible, and cleanup removes only the owned sibling.

- [ ] **Step 3: Prove manifest tests are red**

```bash
bun test test/promotion-state.test.ts \
  --test-name-pattern "codec|publication"
```

- [ ] **Step 4: Implement only state persistence and catalog formatting**

`catalogKey()` returns exactly `L1R1B0`-style keys in live/restore/rollback order. Do not
invoke `psql`, rename a database, or implement a recovery action in this task.

- [ ] **Step 5: Run and commit the manifest primitive**

```bash
bun test test/promotion-state.test.ts
git add src/util/promotion-state.ts test/promotion-state.test.ts
git commit -m "feat: add private promotion manifest"
```

---

### Task 7: Implement the checked forward promotion transitions

**Files:**

- Modify: `src/util/promotion-state.ts`
- Create: `scripts/promotion-state.ts`
- Modify: `scripts/promote-restore.sh`
- Modify: `test/promotion-state.test.ts`
- Modify: `test/h3-restore-scripts.test.ts`

**Forward transition contract:**

```ts
export type ForwardPromotionAction =
  | { kind: "prepare"; requires: "no_manifest+L1R1B0" }
  | { kind: "validate_restore"; requires: "prepared+L1R1B0" | "live_renamed+L0R1B1" }
  | { kind: "rename_live_to_rollback"; requires: "prepared+L1R1B0" }
  | { kind: "record_live_renamed"; requires: "L0R1B1" }
  | { kind: "rename_restore_to_live"; requires: "live_renamed+L0R1B1" }
  | { kind: "record_promoted"; requires: "L1R0B1" }
  | { kind: "done"; code: "promoted" }
  | { kind: "refuse"; code: string };

export function planForwardTransition(
  state: PromotionState | null,
  catalog: PromotionCatalog,
): readonly ForwardPromotionAction[];
```

`prepare` is the bounded executor operation “schema gate, structural gate, safety dump,
write `prepared`”; it returns before any rename. All rename and state-record variants name
one legal edge and carry their required phase/catalog.

```text
no manifest + L1R1B0
  -> checked-out ledger check on minime_restore
  -> restore-validation.sql on minime_restore
  -> pre-promote safety dump complete
  -> write prepared + L1R1B0
  -> ALTER DATABASE minime RENAME TO minime_replaced
  -> verify L0R1B1; write live_renamed
  -> re-run check-only ledger + structural gate on minime_restore
  -> ALTER DATABASE minime_restore RENAME TO minime
  -> verify L1R0B1; write promoted
```

Each `ALTER DATABASE` is one `psql -v ON_ERROR_STOP=1 -c` invocation. Never put both renames
in one invocation. A manifest or `minime_replaced` present at entry blocks a new promotion
and prints only fixed recovery commands. The whole shell command self-reexecs once through
Task 5's `with-ops-lease.ts topology`; a second topology operation exits 4 before validation, dump,
manifest, or rename.

- [ ] **Step 1: Write pure forward-transition tests**

Assert the next legal actions for `no manifest + L1R1B0`, `prepared + L1R1B0`,
`prepared + L0R1B1`, `live_renamed + L0R1B1`, `live_renamed + L1R0B1`, and
`promoted + L1R0B1`. Every other combination returns one `refuse` and no rename action.

- [ ] **Step 2: Write the prepared-transition shell test**

With catalog `L1R1B0`, assert schema gate and structural validation precede the safety dump,
the completed dump precedes `write:prepared`, and no rename runs if any of those steps
fails. A restore ledger missing the latest checked-out migration must refuse here. Two
concurrent promote fixtures produce one transition trace and one fixed busy result.

- [ ] **Step 3: Write one test for each forward boundary**

Inject failure/TERM:

```text
after write:prepared, before rename 1       -> prepared + L1R1B0
after rename 1, before state write         -> prepared + L0R1B1
after write:live_renamed, before gate 2     -> live_renamed + L0R1B1
after rename 2, before state write         -> live_renamed + L1R0B1
after write:promoted                        -> promoted + L1R0B1
```

Every case emits no final success and preserves the rollback dump and manifest.

- [ ] **Step 4: Prove forward tests are red**

```bash
bun test test/promotion-state.test.ts test/h3-restore-scripts.test.ts \
  --test-name-pattern "promotion forward"
```

- [ ] **Step 5: Implement prepare and rename 1**

Call Task 3's `restore-schema-gate --database minime_restore --mode check-only`, then the
structural SQL, then create the safety dump. Persist `prepared` before the first rename;
query the catalog after the rename before writing `live_renamed`.

- [ ] **Step 6: Implement the final pre-rename gate and rename 2**

Re-run both compatibility gates after any interruption window and immediately before the
second rename. Persist `promoted`; retain `minime_replaced`, the dump, and the manifest.
Success text says `promotion staged; run make recover-promotion ACTION=finalize`.

- [ ] **Step 7: Run and commit forward promotion**

```bash
bun test test/promotion-state.test.ts test/h3-restore-scripts.test.ts
bash -n scripts/promote-restore.sh
git add \
  src/util/promotion-state.ts scripts/promotion-state.ts \
  scripts/promote-restore.sh test/promotion-state.test.ts \
  test/h3-restore-scripts.test.ts
git commit -m "fix: persist each forward promotion rename"
```

---

### Task 8: Implement exact forward-resume transitions

**Files:**

- Create: `scripts/recover-promotion.sh`
- Modify: `src/util/promotion-state.ts`
- Modify: `scripts/promotion-state.ts`
- Modify: `Makefile`
- Modify: `test/promotion-state.test.ts`
- Modify: `test/h3-restore-scripts.test.ts`

**Commands:**

```text
make recover-promotion ACTION=resume
```

```ts
export type PromotionAction =
  | { kind: "validate_restore"; requires: "L0R1B1" | "L1R1B0" }
  | { kind: "rename_live_to_rollback"; requires: "prepared+L1R1B0" }
  | { kind: "rename_restore_to_live"; requires: "live_renamed+L0R1B1" }
  | { kind: "rename_live_to_restore"; requires: "promoted+L1R0B1" }
  | { kind: "rename_rollback_to_live"; requires: "live_renamed+L0R1B1" | "rollback_live_renamed+L0R1B1" }
  | { kind: "record_live_renamed"; requires: "L0R1B1" }
  | { kind: "record_promoted"; requires: "L1R0B1" }
  | { kind: "record_rollback_live_renamed"; requires: "L0R1B1" }
  | { kind: "clear_prepared"; requires: "prepared+L1R1B0" }
  | { kind: "clear_rolled_back"; requires: "rollback_live_renamed+L1R1B0" | "live_renamed+L1R1B0" }
  | { kind: "done"; code: string }
  | { kind: "refuse"; code: string };

export function planResumeTransition(
  state: PromotionState,
  catalog: PromotionCatalog,
): readonly PromotionAction[];
```

Recovery self-reexecs through the same `topology` admin lease before reading state. A
concurrent promote/resume attempt exits busy and performs no transition.

The resume table is exact:

| Phase | Catalog | Resume transition |
|---|---|---|
| `prepared` | `L1R1B0` | recheck restore; rename live→rollback; verify; write `live_renamed`; continue |
| `prepared` | `L0R1B1` | adopt `live_renamed`; continue |
| `live_renamed` | `L0R1B1` | recheck restore; rename restore→live; verify; write `promoted` |
| `live_renamed` | `L1R0B1` | adopt `promoted` |
| `promoted` | `L1R0B1` | fixed `already_promoted` |
| `rollback_live_renamed` | any | fixed refusal: use rollback |

Every unlisted phase/catalog refuses `promotion_catalog_ambiguous` before `psql`.

- [ ] **Step 1: Write pure resume-table tests**

Represent the six rows as fixtures and assert the exact action decision. Generate every
unlisted phase/catalog combination and assert refusal.

- [ ] **Step 2: Write rename-1 resume tests**

For `prepared + L1R1B0`, assert exact-ledger and structural checks occur before
live→rollback, then inject TERM immediately before/after that rename and before/after the
`live_renamed` state write. A rerun must either perform rename 1 once or adopt its observed
catalog.

- [ ] **Step 3: Write rename-2 resume tests**

For `live_renamed + L0R1B1`, prove exact-ledger and structural checks precede
restore→live. Inject TERM before/after the rename and state write; rerun either performs it
once or adopts `promoted`.

- [ ] **Step 4: Prove resume tests are red**

```bash
bun test \
  test/promotion-state.test.ts \
  test/h3-restore-scripts.test.ts \
  --test-name-pattern "resume"
```

- [ ] **Step 5: Implement only resume**

After each rename, query the catalog before writing/adopting the next phase. Before forward
rename 2, rerun the check-only exact-ledger and structural gates. `ACTION=rollback` and
`ACTION=finalize` remain fixed unsupported actions until Tasks 9-10.

- [ ] **Step 6: Run and commit resume**

```bash
bun test test/promotion-state.test.ts test/h3-restore-scripts.test.ts
bash -n scripts/promote-restore.sh scripts/recover-promotion.sh
git add \
  src/util/promotion-state.ts scripts/recover-promotion.sh \
  scripts/promotion-state.ts Makefile \
  test/promotion-state.test.ts test/h3-restore-scripts.test.ts
git commit -m "fix: make promotion resume deterministic"
```

---

### Task 9: Implement exact rollback transitions

**Files:**

- Modify: `src/util/promotion-state.ts`
- Modify: `scripts/recover-promotion.sh`
- Modify: `scripts/promotion-state.ts`
- Modify: `Makefile`
- Modify: `test/promotion-state.test.ts`
- Modify: `test/h3-restore-scripts.test.ts`

```text
make recover-promotion ACTION=rollback
```

```ts
export function planRollbackTransition(
  state: PromotionState,
  catalog: PromotionCatalog,
): readonly PromotionAction[];
```

Rollback runs under the same `topology` admin lease. Its table is exact:

| Phase | Catalog | Rollback transition |
|---|---|---|
| `prepared` | `L1R1B0` | clear manifest; no rename |
| `prepared` | `L0R1B1` | adopt `live_renamed`; rename rollback→live; verify `L1R1B0`; clear |
| `live_renamed` | `L0R1B1` | rename rollback→live; verify `L1R1B0`; clear |
| `live_renamed` | `L1R0B1` | adopt `promoted`; continue as promoted |
| `promoted` | `L1R0B1` | rename live→restore; verify `L0R1B1`; write `rollback_live_renamed`; continue |
| `promoted` | `L0R1B1` | adopt `rollback_live_renamed`; continue |
| `rollback_live_renamed` | `L0R1B1` | rename rollback→live; verify `L1R1B0`; clear |
| `rollback_live_renamed` | `L1R1B0` | clear manifest; already rolled back |

Every unlisted combination refuses `promotion_catalog_ambiguous` before `psql`. A legacy
`minime_replaced` without a valid manifest always refuses with fixed owner inspection
commands and is never adopted or deleted automatically.

- [ ] **Step 1: Write pure rollback-table tests**

Assert the exact action list for all eight rows and refusal for every unlisted combination.

- [ ] **Step 2: Write pre-promotion rollback tests**

Cover `prepared` before rename 1, `prepared` after an unrecorded rename 1, and
`live_renamed`. The old live database returns to `minime`, the candidate remains
`minime_restore`, and the result is `L1R1B0` with no manifest.

- [ ] **Step 3: Write promoted two-rename rollback tests**

Inject TERM before/after live→restore, before/after `rollback_live_renamed`, before/after
rollback→live, and before manifest cleanup. Each rerun makes at most one next transition and
ends `L1R1B0` with both old live and restored candidate preserved.

- [ ] **Step 4: Prove rollback tests are red**

```bash
bun test \
  test/promotion-state.test.ts \
  test/h3-restore-scripts.test.ts \
  --test-name-pattern "rollback"
```

- [ ] **Step 5: Implement rollback table and fixed legacy refusal**

Query the catalog after every rename and before every state write/clear. Use the shared
idempotent signal/EXIT cleanup path; it never removes the canonical manifest.

- [ ] **Step 6: Run and commit rollback**

```bash
bun test test/promotion-state.test.ts test/h3-restore-scripts.test.ts
bash -n scripts/recover-promotion.sh
git add \
  src/util/promotion-state.ts scripts/recover-promotion.sh \
  scripts/promotion-state.ts Makefile \
  test/promotion-state.test.ts test/h3-restore-scripts.test.ts
git commit -m "fix: make promotion rollback deterministic"
```

---

### Task 10: Gate and finalize the promoted live database

**Files:**

- Modify: `src/util/promotion-state.ts`
- Modify: `scripts/restore-schema-gate.ts`
- Modify: `scripts/promotion-state.ts`
- Modify: `scripts/recover-promotion.sh`
- Modify: `Makefile`
- Modify: `test/migration-ledger.test.ts`
- Modify: `test/promotion-state.test.ts`
- Modify: `test/h3-restore-scripts.test.ts`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/GUIDE.md`
- Modify: `DECISIONS.md`

`make recover-promotion ACTION=finalize` is the only command allowed to drop
`minime_replaced`. The canonical manifest may also be removed after Task 9 verifies a
rollback reached `L1R1B0`, or when cancelling `prepared + L1R1B0` before any rename; no
other path clears it.

Task 3's named input type becomes this complete discriminated union:

```ts
export type RestoreSchemaGateInput =
  | {
      database: RestoreDatabaseName;
      mode: "migrate-and-check" | "check-only";
    }
  | {
      database: "minime";
      mode: "check-only";
      purpose: "promotion-finalize";
      statePath: string;
    };
```

It accepts live `minime` only after validating the canonical manifest is mode 0600, phase
`promoted`, and the catalog is `L1R0B1`. It never applies migrations to live.
The CLI grammar for this member is exact:

```text
bun run scripts/restore-schema-gate.ts \
  --database minime \
  --mode check-only \
  --purpose promotion-finalize \
  --state-path <ABS_REPO_PATH>/db-dump/promotion-state.json
```

Both `--purpose` and `--state-path` are required for `minime` and forbidden for the two
isolated members. The script canonicalizes `statePath` and accepts only the repository's
canonical manifest path before importing any database module or opening a socket.

Finalization is also a pure, bite-sized state machine:

```ts
export type FinalizeEvidence =
  | "unchecked"
  | "ledger_exact"
  | "structure_valid"
  | "connections_clear";

export type FinalizePromotionAction =
  | {
      kind: "validate_live_ledger";
      requires: "promoted+L1R0B1+unchecked";
    }
  | {
      kind: "validate_live_structure";
      requires: "promoted+L1R0B1+ledger_exact";
    }
  | {
      kind: "assert_no_live_connections";
      requires: "promoted+L1R0B1+structure_valid";
    }
  | {
      kind: "drop_rollback";
      requires: "promoted+L1R0B1+connections_clear";
    }
  | { kind: "clear_finalized"; requires: "promoted+L1R0B0" }
  | { kind: "refuse"; code: string };

export function planFinalizeTransition(
  state: PromotionState | null,
  catalog: PromotionCatalog,
  evidence: FinalizeEvidence,
): FinalizePromotionAction;
```

The executor runs under the shared `topology` lease and replans after every action. Evidence
is process-local and advances only after that action succeeds; an interruption resets it to
`unchecked`, safely repeating the read-only gates. The transition table is exact:

| State | Catalog | Evidence | Sole next action |
|---|---|---|---|
| `promoted` | `L1R0B1` | `unchecked` | `validate_live_ledger` |
| `promoted` | `L1R0B1` | `ledger_exact` | `validate_live_structure` |
| `promoted` | `L1R0B1` | `structure_valid` | `assert_no_live_connections` |
| `promoted` | `L1R0B1` | `connections_clear` | `drop_rollback` |
| `promoted` | `L1R0B0` | any | `clear_finalized` |

Every other state/catalog/evidence combination returns `refuse` before `psql`. After
`drop_rollback`, the executor re-queries the catalog and must observe `L1R0B0` before a new
planner call can return `clear_finalized`.

- [ ] **Step 1: Write the missing-latest final-gate regression**

Starting from `promoted + L1R0B1`, delete only the latest ledger row from live `minime`.
Assert:

```ts
expect(finalize.exitCode).toBe(4);
expect(finalize.trace).toEqual(["ledger:mismatch"]);
expect(catalog).toEqual("L1R0B1");
expect(manifest.phase).toBe("promoted");
```

The rollback database and manifest remain; neither `DROP DATABASE` nor state cleanup runs.

- [ ] **Step 2: Write structural and success finalization tests**

A missing append-only trigger fails with the same preservation. Plant a session connected
to `minime_replaced` (the retired live database) and assert finalization refuses before
DROP, preserving the session, database, and manifest. On success, the exact trace is:

```text
ledger:exact, structure:valid, no-live-connections,
drop:minime_replaced, catalog:L1R0B0, clear:manifest
```

If DROP succeeds but manifest cleanup is interrupted, `promoted + L1R0B0` is the sole extra
recognized finalize state; rerunning `finalize` clears the manifest without another drop.
No resume/rollback action accepts `L1R0B0`.

Table-drive `planFinalizeTransition()` across the five listed rows, all other promotion
phases, all eight catalog combinations, and all evidence values. Assert each permitted row
returns exactly one named action and every unlisted row returns only `refuse`.

- [ ] **Step 3: Prove finalization tests are red**

```bash
bun test \
  test/migration-ledger.test.ts \
  test/promotion-state.test.ts \
  test/h3-restore-scripts.test.ts \
  --test-name-pattern "finalize|final gate"
```

- [ ] **Step 4: Implement the live check-only gate**

Run exact checked-out ledger comparison, then read-only `db/restore-validation.sql`, then
the no-live-connections query as the three distinct planner actions above. Here “live”
means sessions inherited from the former live database: query `pg_stat_activity` for
`datname = 'minime_replaced'`, excluding the admin gate session. Invoke the schema gate with
the exact `--purpose promotion-finalize --state-path "$PROMOTION_STATE_PATH"` arguments.
Any failure exits 4 and leaves all recovery assets.

- [ ] **Step 5: Implement drop and manifest cleanup**

Drop only canonical `minime_replaced`, verify `L1R0B0`, and atomically remove only the
validated canonical manifest. Repeated finalize is either the recognized cleanup completion
or a fixed no-state refusal.

- [ ] **Step 6: Run, document, and commit finalization**

```bash
bun test \
  test/migration-ledger.test.ts \
  test/promotion-state.test.ts \
  test/h3-restore-scripts.test.ts
bash -n scripts/promote-restore.sh scripts/recover-promotion.sh
git add \
  src/util/promotion-state.ts scripts/restore-schema-gate.ts scripts/promotion-state.ts \
  scripts/recover-promotion.sh Makefile \
  test/migration-ledger.test.ts test/promotion-state.test.ts \
  test/h3-restore-scripts.test.ts \
  README.md AGENTS.md docs/GUIDE.md DECISIONS.md
git commit -m "fix: require live schema gate before promotion finalize"
```

Do not roll code back while a promotion manifest is active. Resume, roll back, or finalize
under the checked-out code first.

---

### Task 11: Put genuine recovery evidence in CI

**Files:**

- Create: `.github/workflows/recovery.yml`
- Create: `test/recovery-workflow-contract.test.ts`
- Modify: `docs/SUBSYSTEMS.md`
- Modify: `README.md`

**Workflow contract:**

- Runs on changes to backup/restore/update/promotion paths, weekly schedule, and manual
  dispatch.
- Uses Ubuntu 24.04, local pgvector Postgres, compatible pg client, and local restic.
- Runs `make verify-offline`, then `MINIME_RESTORE_E2E=1 bun test
  test/restore-integration.test.ts`.
- Never has cloud credentials or external repository configuration.
- Uploads only fixed status logs; no dump, database content, password file, or restored
  workspace becomes an artifact.

- [ ] **Step 1: Write static workflow-contract tests**

Assert path triggers, local restic setup, E2E command, absence of cloud secret references,
and absence of dump/workspace artifact globs.

- [ ] **Step 2: Prove the test is red**

```bash
bun test test/recovery-workflow-contract.test.ts
```

- [ ] **Step 3: Create the workflow and update evidence inventory**

Record the real restore test—not the shell fixture—as the Backup/Recovery subsystem's
acceptance evidence.

- [ ] **Step 4: Run local equivalents and commit**

```bash
bun test test/recovery-workflow-contract.test.ts
MINIME_RESTORE_E2E=1 bun test test/restore-integration.test.ts
make verify-offline
git add .github/workflows/recovery.yml \
  test/recovery-workflow-contract.test.ts docs/SUBSYSTEMS.md README.md
git commit -m "ci: prove backup restoration end to end"
```

---

## S3 Acceptance and Rollback

Acceptance:

- Custom ports survive install reruns, up, backup, restore, and promotion.
- Restore drill never substitutes a live dump, upgrades only the isolated restored DB, and
  fails unless its ledger exactly matches every checked-out migration before structural
  validation.
- A pre-S0 updater cannot apply migration 021 without context; an S0 updater can cross into
  S3 once; an S3 updater snapshots before fetch, verifies before migration, and supplies a
  private HEAD-bound receipt.
- Every partial forward or rollback rename has one exact tested recovery transition.
- Promotion preflight and finalization both require checked-out ledger and structural
  compatibility; a missing latest live migration preserves rollback state.
- Weekly CI restores a genuine local-restic snapshot.

Rollback:

- Config bridge changes preserve old `DATABASE_URL`.
- Restore changes operate only on scratch DBs.
- S0 bounded update context and backup outcome codes remain supported for one compatibility
  release; the context-free refusal is never rolled back.
- Promotion code cannot be rolled back while its state manifest exists.
