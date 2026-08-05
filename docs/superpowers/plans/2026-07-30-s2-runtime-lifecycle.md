# S2 Runtime Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow any number of stdio MCP clients while guaranteeing exactly one cleanly
managed inbox/brain watcher, dream scheduler, and backup scheduler.

**Architecture:** Session-level PostgreSQL advisory locks provide cross-process ownership.
The stdio MCP adapter and resident daemon become separate closeable components. A daemon
owns both file watchers and scheduled jobs. The public Dream operation owns the `"dream"`
lease, and the public backup operation owns the `"backup"` lease around its dump-only
child; manual CLI and scheduled callers therefore share the same ownership boundary and
never wrap either job in a second lease. The daemon releases resources in a fixed shutdown
order; a one-release compatibility flag preserves old co-host behavior during rollout.

**Tech Stack:** postgres.js reserved connections, PostgreSQL advisory locks, Bun,
Chokidar, Croner, existing watcher/dream/backup modules, and MCP stdio.

## Global Constraints

- SQL for advisory locks stays in `src/db/repo.ts`.
- No PID-file, IPC, service-manager, scheduler, or runtime dependency is added.
- The daemon runs under the S1 `minime_app` runtime role.
- Stdio MCP clients never migrate schema.
- Stop order is cron stop → await in-flight jobs → watcher flush/close → lease release → DB
  close.
- `stop()` and every individual handle's `close()` are idempotent.
- Startup failure unwinds every previously acquired resource.
- Each operation has exactly one advisory-lease owner. Callers of the public Dream or
  backup operations never acquire `"dream"` or `"backup"` themselves.
- Machine-facing statuses are fixed: `started`, `already_running`, `startup_failed`,
  `shutdown_failed`, `running`, `stopped`, `dream_skipped`, `backup_skipped`,
  `dream_failed`, and `backup_failed`.
- Paths, DSNs, child output, and secrets never appear in lifecycle errors.

---

### Task 1: Add cross-process runtime and job leases

**Files:**

- Create: `test/runtime-lease.test.ts`
- Modify: `src/db/repo.ts`
- Modify: `src/db/client.ts`
- Modify: `src/db/migrate.ts`
- Modify: `src/pipeline/backup.ts`
- Modify: `scripts/harden-runtime-role.ts`
- Modify: `test/runtime-role-cutover.test.ts`

**Interfaces:**

```ts
export type RuntimeLeaseName = "daemon" | "dream" | "backup" | "migrate";

export interface RuntimeLease {
  readonly name: RuntimeLeaseName;
  release(): Promise<void>;
}

export async function tryAcquireRuntimeLease(
  name: RuntimeLeaseName,
): Promise<RuntimeLease | null>;

export async function withRuntimeLease<T>(
  name: RuntimeLeaseName,
  work: () => Promise<T>,
): Promise<{ ran: false } | { ran: true; value: T }>;
```

Each lease holds a session-level advisory lock on a dedicated reserved connection until
`release()`. A transaction-level lock is not acceptable. Lock keys are deterministic,
namespace-prefixed, and distinct for all four names. Use S1's `reserveDb()` primitive:
the returned `DbReservation` owns the long-lived `postgres.ReservedSql`, while the
repository owns all advisory-lock SQL. Do not cast a `DbTransaction` to a reserved
connection or reach back to the pool from `repo.ts`.

- [ ] **Step 1: Write real two-connection lease tests**

Assert:

- only one connection acquires `"daemon"`;
- releasing the winner permits the loser;
- closing the reserved connection releases the lock;
- a thrown `withRuntimeLease` callback releases the lock;
- backup and migration locks do not collide with one another;
- a manual snapshot racing S1 hardening starts exactly one dump child; the losing hardening
  path reaches no role/schema/profile mutation and release works after every worker exit;
- two concurrent migrations produce one ledger entry per migration.

- [ ] **Step 2: Prove the focused test is red**

```bash
bun test test/runtime-lease.test.ts test/runtime-role-cutover.test.ts
```

- [ ] **Step 3: Implement deterministic lock acquisition over the S1 reservation**

Map the four literal lease names to four reviewed integer key pairs. Call `reserveDb()` once,
run `pg_try_advisory_lock` through its `executor`, release the `DbReservation` immediately
on a false result, and retain that same reservation inside the winning `RuntimeLease`.
Never accept an arbitrary key or expose the executor, connection, or key to callers.

- [ ] **Step 4: Implement idempotent release and callback cleanup**

`release()` runs the matching unlock once through the retained executor and calls the
reservation's idempotent `release()` in `finally`. `withRuntimeLease()` wraps the callback
in `try/finally`, including a rejected promise and cancellation test.

- [ ] **Step 5: Serialize migration discovery and application**

Wrap the entire migration critical section—from directory read through final ledger
insert—with `"migrate"`. Re-run the two-connection migration test and prove one ledger row
per filename.

- [ ] **Step 6: Replace the backup process-local flag**

Replace the shared `backup()`/`dbSnapshot()` `inFlight` boolean with one
`withRuntimeLease("backup", ...)` boundary around the complete S1 dump-only child lifetime.
Both tags call that shared owner exactly once. Preserve current return/error semantics in
this task; a losing lease maps to the existing fixed skip, and S3 makes the outcome union
explicit. Task 2 gives the public Dream operation the parallel single-owner boundary; the
scheduler acquires neither job lease.

Route S1's guarded `cutover-owner` pre-image through that same public backup-lease helper
while retaining its special credential source. `scripts/harden-runtime-role.ts` may invoke
the raw worker only inside the winning callback; a busy lease stops hardening before role
bootstrap, migration, password rotation, or publication. Make the losing result
fixed/content-free and release on worker success, failure, signal, and malformed output.

- [ ] **Step 7: Run focused gates and commit**

```bash
bun test \
  test/runtime-lease.test.ts \
  test/backup.test.ts \
  test/runtime-role-cutover.test.ts \
  test/m1.schema.test.ts
git add src/db/repo.ts src/db/client.ts src/db/migrate.ts \
  src/pipeline/backup.ts scripts/harden-runtime-role.ts \
  test/runtime-lease.test.ts test/runtime-role-cutover.test.ts
git commit -m "feat: add database-backed runtime leases"
```

Rollback requires no schema change; releasing/closing the runtime pool drops all advisory
locks.

---

### Task 2: Build one closeable daemon with inbox and brain watchers

**Files:**

- Create: `src/runtime/daemon.ts`
- Create: `src/pipeline/brain-watcher.ts`
- Create: `test/runtime-daemon.test.ts`
- Create: `test/brain-watcher.test.ts`
- Modify: `src/pipeline/watcher.ts`
- Modify: `src/pipeline/dream.ts`
- Modify: `src/pipeline/backup.ts`
- Modify: `docs/SUBSYSTEMS.md`

**Interfaces:**

```ts
export interface BackgroundHandle {
  close(): Promise<void>;
}

export interface ScheduledJob {
  stop(): void;
}

export interface BrainWatcherHandle extends BackgroundHandle {
  flush(): Promise<void>;
}

export async function startBrainWatcher(options?: {
  debounceMs?: number;
}): Promise<BrainWatcherHandle>;

export interface DaemonHandle {
  readonly stopped: Promise<void>;
  stop(reason?: string): Promise<void>;
}

export type DaemonStartResult =
  | { status: "started"; handle: DaemonHandle }
  | { status: "already_running" };

export type DreamRunResult =
  | { ran: false }
  | { ran: true; summary: Record<string, unknown> };

export interface DaemonDeps {
  acquireLease(): Promise<RuntimeLease | null>;
  startInboxWatcher(): Promise<BackgroundHandle>;
  startBrainWatcher(): Promise<BrainWatcherHandle>;
  schedule(expression: string, job: () => Promise<void>): ScheduledJob;
  runDream(): Promise<DreamRunResult>;
  runBackup(): Promise<{ ran: boolean; detail: string }>;
}

export async function startDaemon(
  deps?: DaemonDeps,
): Promise<DaemonStartResult>;
```

The brain watcher watches `data/brain`, ignores dot/temp/editor files, debounces bursts, calls
the existing `brainSync()`, and flushes before close. Scheduled Dream and backup ticks call
their public operations directly. Those operations are the sole owners of `"dream"` and
`"backup"` respectively and return fixed skips when another process owns the same job.

- [ ] **Step 1: Write daemon ownership/lifecycle tests**

Assert two starts produce one `started` and one `already_running`; the loser creates no
watcher or cron. Test idempotent stop, reverse-order unwind on partial startup, one in-flight
job awaited during stop, and lease release after success/failure. Race a manual Dream CLI
fixture against a scheduled tick and require one full job plus one `{ ran:false }`; neither
path may enter raw Dream work without the public lease.

- [ ] **Step 2: Write brain watcher tests**

Create a temporary brain tree. Assert a burst becomes one `brainSync()`, temp files are
ignored, a final pending change flushes during close, and no callback fires after close.

- [ ] **Step 3: Prove both suites are red**

```bash
bun test test/runtime-daemon.test.ts test/brain-watcher.test.ts
```

- [ ] **Step 4: Implement the closeable brain watcher**

Implement filtering and debounce first. Add `flush()` that awaits the one pending sync, then
make `close()` idempotently stop new events, flush, and close Chokidar.

- [ ] **Step 5: Put each job lease in its public operation**

Wrap the complete raw Dream sequence inside the public `dream()` operation's single
`withRuntimeLease("dream", ...)` call and return `DreamRunResult`; the manual CLI and daemon
both call it. S1's Dream summary/audit is produced only inside the winning callback. The
daemon tick wrappers acquire no job lease. Track every tick promise in one
`Set<Promise<void>>`, call `runDream()`/`runBackup()` once, and map `{ ran:false }` to fixed
`dream_skipped`/`backup_skipped` lifecycle statuses without parsing or printing result
detail. Catch thrown job failure at the scheduler boundary and expose `stopScheduling()`
plus `awaitInFlight()`. Add real scheduled-job tests that reach raw Dream and the dump child,
plus concurrent manual/scheduled and two-daemon cases that produce exactly one owner and one
skip for each job. Any nested second `"dream"` or `"backup"` acquisition is a test failure.

- [ ] **Step 6: Implement daemon startup and unwind**

Acquire the daemon lease, then start inbox watcher, brain watcher, dream schedule, and backup
schedule in that order. Push each close action immediately after creation. An injected
failure pops and awaits the stack in reverse order and returns only `startup_failed`.

- [ ] **Step 7: Implement one idempotent stop promise**

The first `stop()` call memoizes: stop both schedules, await in-flight ticks, flush/close
brain, close inbox, release daemon lease, resolve `stopped`. Later calls await the same
promise. Aggregate cleanup failures internally and emit only `shutdown_failed` after every
cleanup was attempted.

- [ ] **Step 8: Register the resident runtime owner**

Add a `docs/SUBSYSTEMS.md` row for `src/runtime/` backed by daemon/lease lifecycle tests,
with no new external dependency, and state that it replaces scheduler/watcher ownership
embedded in `src/cli.ts`. Run `bun run scripts/check-subsystems.ts` before committing the
new top-level directory.

- [ ] **Step 9: Run neighboring watcher/dream tests**

```bash
bun test \
  test/runtime-daemon.test.ts \
  test/brain-watcher.test.ts \
  test/h1-brain-sync.test.ts \
  test/backup.test.ts \
  test/h5-contradiction-scan.test.ts
bun run scripts/check-subsystems.ts
```

- [ ] **Step 10: Commit**

```bash
git add \
  src/runtime/daemon.ts src/pipeline/brain-watcher.ts \
  src/pipeline/watcher.ts src/pipeline/dream.ts src/pipeline/backup.ts \
  test/runtime-daemon.test.ts test/brain-watcher.test.ts docs/SUBSYSTEMS.md
git commit -m "feat: centralize resident services in one daemon"
```

---

### Task 3: Separate CLI/MCP lifetimes and provide a compatible rollout

**Files:**

- Create: `test/cli-runtime.test.ts`
- Create: `test/product-runtime-contract.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/mcp/server.ts`
- Modify: `Makefile`
- Modify: `.mcp.json`
- Modify: `.env.example`
- Modify: `scripts/install.sh`
- Modify: `scripts/setup-env.sh`
- Modify: `scripts/update.sh`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/GUIDE.md`
- Modify: `docs/SUBSYSTEMS.md`
- Modify: `DECISIONS.md`

**MCP handle:**

```ts
export interface McpServerHandle {
  readonly stopped: Promise<void>;
  close(): Promise<void>;
}

export async function startMcpServer(): Promise<McpServerHandle>;
```

**CLI contract:**

```text
minime serve          stdio MCP only
minime daemon         singleton watchers + dream + backup
minime run            foreground MCP + daemon convenience mode
minime daemon:status  prints exactly running|stopped
```

Make targets:

```make
serve:
	@$(BUN) run src/cli.ts serve

daemon:
	@$(BUN) run src/cli.ts daemon

run:
	@$(BUN) run src/cli.ts run

daemon-status:
	@$(BUN) run src/cli.ts daemon:status
```

For one compatibility release only,
`MINIME_LEGACY_SERVE_DAEMON=1` allows `serve` to attempt the daemon lease. It can never start
background work without winning that lease. The removal release/date is recorded in
`DECISIONS.md`.

- [ ] **Step 1: Write command-boundary tests**

Inject spies and assert:

- `serve` starts MCP but no watcher/scheduler;
- `daemon` starts no stdio transport;
- `run` starts each component and closes both;
- `daemon:status` acquires/releases a probe lease without starting work;
- `dream` calls the public leased operation, prints the winning summary, and maps
  `{ran:false}` to one fixed busy status;
- legacy mode still starts at most one daemon across two serve processes;
- `SIGINT` and `SIGTERM` call the same idempotent cleanup path.

- [ ] **Step 2: Add architecture import tests**

Assert `src/mcp/**` imports no Croner, watcher, dream, or backup module; only
`src/runtime/daemon.ts` schedules background work.

- [ ] **Step 3: Prove tests are red**

```bash
bun test test/cli-runtime.test.ts test/product-runtime-contract.test.ts
```

- [ ] **Step 4: Return a closeable MCP handle**

Make `startMcpServer()` expose its stopped promise and idempotent transport close. Preserve
the stdio request/audit contract and prove an injected transport close resolves the handle.

- [ ] **Step 5: Implement `serve` and `daemon` boundaries**

Remove `migrate()`, watcher, and Croner ownership from normal `serve`. `serve` runs the S1
schema-posture check and fails closed if migrations are pending. `daemon` starts only
`startDaemon()` and maps `already_running` to a fixed successful status. Update the manual
`dream` command for `DreamRunResult`; it must not call an unleased raw implementation.

- [ ] **Step 6: Implement `run`, status, and signal ownership**

`run` starts daemon then MCP, unwinds daemon if MCP fails, and on either SIGINT/SIGTERM
closes MCP then daemon through one memoized cleanup promise. `daemon:status` probes and
releases the daemon lease without starting a resource.

- [ ] **Step 7: Add the upgrade cutover procedure**

The update summary emits:

```text
next: start one `make daemon`, then restart MCP clients
compatibility: set MINIME_LEGACY_SERVE_DAEMON=1 for one release only
```

Do not automatically terminate existing processes. The owner verifies `make daemon-status`
before disabling compatibility mode.

- [ ] **Step 8: Update every command/topology document**

Update Make targets, installer summary, `.mcp.json`, `.env.example`, README, AGENTS, guide,
subsystem row, and decision record together. Remove the guide's false claim that `serve`
alone watches brain pages. Set and test the compatibility removal release/date.

- [ ] **Step 9: Run two-process integration and full gate**

```bash
bun test \
  test/cli-runtime.test.ts \
  test/product-runtime-contract.test.ts \
  test/runtime-daemon.test.ts \
  test/runtime-lease.test.ts
make verify
```

The integration test starts two stdio fixtures and one daemon, proves one watcher/job owner,
stops the daemon, and proves a replacement can immediately acquire the lease.

- [ ] **Step 10: Record and commit**

```bash
git add \
  test/cli-runtime.test.ts test/product-runtime-contract.test.ts \
  src/cli.ts src/mcp/server.ts Makefile .mcp.json .env.example \
  scripts/install.sh scripts/setup-env.sh scripts/update.sh \
  README.md AGENTS.md docs/GUIDE.md docs/SUBSYSTEMS.md DECISIONS.md
git commit -m "feat: separate mcp and daemon lifecycles"
```

---

## S2 Acceptance and Rollback

Acceptance:

- Any number of MCP clients may coexist.
- Exactly one daemon lease and one leased instance of each job exists.
- Brain edits and inbox additions are watched by the daemon.
- Every resource is closed exactly once in the declared order.
- Two migrations, two backups, or two Dream jobs cannot overlap across processes. The
  three distinct lease names do not serialize unrelated kinds of work.
- Documentation and installer summaries name the actual process topology.

Rollback:

- Set `MINIME_LEGACY_SERVE_DAEMON=1` and restart MCP clients.
- Advisory locks require no migration rollback.
- Do not revert to unleased background work.
