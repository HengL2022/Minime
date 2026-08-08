import { AsyncLocalStorage } from "node:async_hooks";
import postgres from "postgres";
import { config } from "../util/config";

export type DbPool = postgres.Sql;
export type DbExecutor = postgres.ISql;
export type DbTransaction = postgres.TransactionSql;
export type DbReserved = postgres.ReservedSql;

export interface DbReservation {
  readonly executor: DbReserved;
  release(): Promise<void>;
}

// The pool remains process-private. MCP handlers run in an AsyncLocalStorage transaction so
// actor identity is scoped to one request and cannot leak through pooled connections.
const runtimePool: DbPool = postgres(config.runtimeDatabaseUrl, {
  max: 5,
  onnotice: () => {},
});
// Durable egress audit must never compete with the actor transaction pool: if five handlers
// each held one runtime slot and then requested a sixth, all could wait forever. This separate
// app-role pool is intentionally single-purpose and single-connection.
const runtimeAuditPool: DbPool = postgres(config.runtimeDatabaseUrl, {
  max: 1,
  onnotice: () => {},
});
// Capture identity must commit before its source file becomes visible, independently of the
// enclosing actor transaction. Keep that work off both the actor and durable-audit pools so an
// ambient transaction can neither absorb its commit nor exhaust the connection it needs.
const runtimeDurabilityPool: DbPool = postgres(config.runtimeDatabaseUrl, {
  max: 1,
  onnotice: () => {},
});
// Administrative work (migrations and test/database lifecycle) must stay on the owner DSN;
// it is never reachable through the MCP actor scope. The client object is constructed for the
// explicit control-plane path. Resident `serve` retains it only in the non-MCP supervisor;
// the MCP child receives the restricted URL for both configured pools.
//
// max must stay above 1: repo.ts's reserved-connection leases (withCompiledNotesLease,
// withCompiledNoteTargetLease) check out one connection from whatever pool db() currently
// resolves to and hold it for their whole callback, while that callback's own nested db() calls
// (and dream step 2b's compileNotes nests a *second* per-candidate target lease inside the
// first) need further connections from the very same pool. Under admin scope that pool is this
// one, so max:1 made every admin-scoped compileNotes call -- i.e. every real nightly dream() run,
// which always executes under withAdminDbScope -- deadlock waiting on a connection its own outer
// reservation was holding. 5 matches runtimePool's headroom and was verified against the deepest
// observed nesting (outer lease + inner target lease + one in-flight ambient query).
export const adminSql: DbPool = postgres(config.databaseUrl, {
  max: 5,
  onnotice: () => {},
});
let adminDisabled = false;
// Compatibility export follows the runtime boundary. In ordinary CLI/test processes the
// runtime URL falls back to the owner URL, while resident MCP and evaluator children receive
// only the restricted app URL. Keep control-plane callers on the explicit admin helpers.
export const sql: DbPool = runtimePool;
const transactionScope = new AsyncLocalStorage<DbTransaction>();
const executorScope = new AsyncLocalStorage<"admin">();

export function db(): DbExecutor {
  // Runtime/application work must use the restricted pool by default.  The owner pool is
  // available only through the explicit adminSql export and admin transaction helpers below.
  return (
    transactionScope.getStore() ?? (executorScope.getStore() === "admin" ? adminSql : runtimePool)
  );
}

export function hasDbTransaction(): boolean {
  return transactionScope.getStore() !== undefined;
}

export async function withDbTransaction<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> {
  const active = transactionScope.getStore();
  if (active) return work(active);
  const pool = executorScope.getStore() === "admin" ? adminSql : runtimePool;
  return (await pool.begin((tx) => transactionScope.run(tx, () => work(tx)))) as T;
}

/** Run trusted supervisor maintenance through the owner pool without holding one long transaction. */
export async function withAdminDbScope<T>(work: () => Promise<T>): Promise<T> {
  if (adminDisabled) throw new Error("admin_db_disabled");
  if (transactionScope.getStore()) return work();
  return executorScope.run("admin", work);
}

export function isAdminDbScope(): boolean {
  return executorScope.getStore() === "admin";
}

/** Explicit owner/control-plane transaction for migrations, onboarding, and test setup. */
export async function withAdminDbTransaction<T>(
  work: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  if (adminDisabled) throw new Error("admin_db_disabled");
  const active = transactionScope.getStore();
  if (active) return work(active);
  return (await adminSql.begin((tx) => transactionScope.run(tx, () => work(tx)))) as T;
}

/** Close and permanently disable owner SQL for the lifetime of a resident serve process. */
export async function disableAdminDb(): Promise<void> {
  adminDisabled = true;
  await adminSql.end({ timeout: 5 });
}

export function isAdminDbDisabled(): boolean {
  return adminDisabled;
}

/** Start an actor transaction on the restricted runtime pool. */
export async function withRuntimeDbTransaction<T>(
  work: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  const active = transactionScope.getStore();
  if (active) return work(active);
  return (await runtimePool.begin((tx) => transactionScope.run(tx, () => work(tx)))) as T;
}

export async function reserveDb(): Promise<DbReservation> {
  const pool = executorScope.getStore() === "admin" ? adminSql : runtimePool;
  const executor = await pool.reserve();
  let releasePromise: Promise<void> | undefined;
  return {
    executor,
    release: () => {
      releasePromise ??= Promise.resolve().then(() => executor.release());
      return releasePromise;
    },
  };
}

export async function withReservedDb<T>(work: (connection: DbReserved) => Promise<T>): Promise<T> {
  const reservation = await reserveDb();
  try {
    return await work(reservation.executor);
  } finally {
    await reservation.release();
  }
}

/**
 * Reserve an autocommit connection from the restricted runtime pool even when the caller is
 * inside an actor/admin transaction. Used for audit intent that must survive caller rollback.
 */
export async function withRuntimeReservedDb<T>(
  work: (connection: DbReserved) => Promise<T>,
): Promise<T> {
  const executor = await runtimeAuditPool.reserve();
  try {
    return await work(executor);
  } finally {
    await executor.release();
  }
}

/** Commit restricted-runtime durability work independently of any ambient transaction. */
export async function withDurableRuntimeDbTransaction<T>(
  work: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  return (await runtimeDurabilityPool.begin((tx) => transactionScope.run(tx, () => work(tx)))) as T;
}

export async function closeDb(): Promise<void> {
  const adminClose = adminDisabled ? Promise.resolve() : adminSql.end({ timeout: 5 });
  await Promise.all([
    runtimePool.end({ timeout: 5 }),
    runtimeAuditPool.end({ timeout: 5 }),
    runtimeDurabilityPool.end({ timeout: 5 }),
    adminClose,
  ]);
}
