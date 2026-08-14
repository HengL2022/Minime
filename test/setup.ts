// Test preload: each process owns one guarded loopback database. The application pool is
// imported only after DATABASE_URL points at that retained plan.

import { afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ProvisionedTestDatabase,
  type TestDatabasePlan,
  disposeTestDatabase,
  planTestDatabase,
  provisionTestDatabase,
} from "./support/test-database";

export type TestDatabaseCloser = () => Promise<void>;

function fixedCleanupError(): Error {
  return new Error("test_database_cleanup_failed");
}

export function createTestDatabaseCloserRegistry(): {
  register(closer: TestDatabaseCloser): () => void;
  drain(): Promise<void>;
} {
  const registered = new Set<{ closer: TestDatabaseCloser }>();
  let draining = false;
  let drainPromise: Promise<void> | undefined;

  return {
    register(closer) {
      if (typeof closer !== "function" || draining) throw fixedCleanupError();
      const registration = { closer };
      registered.add(registration);
      return () => {
        if (!draining) registered.delete(registration);
      };
    },
    drain() {
      if (drainPromise) return drainPromise;
      draining = true;
      const snapshot = [...registered];
      drainPromise = Promise.allSettled(
        snapshot.map(({ closer }) => Promise.resolve().then(() => closer())),
      ).then((results) => {
        if (results.some((result) => result.status === "rejected")) {
          throw fixedCleanupError();
        }
      });
      return drainPromise;
    },
  };
}

const testDatabaseCloserRegistry = createTestDatabaseCloserRegistry();

export function registerTestDatabaseCloser(closer: TestDatabaseCloser): () => void {
  return testDatabaseCloserRegistry.register(closer);
}

const DEFAULT_DATABASE_URL = "postgres://minime:minime@localhost:5432/minime";
const sourceDatabaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
// Verification can run inside install.sh after it has exported the selected live lifecycle and
// runtime-role state. Tests own their scratch endpoint and their fixture lifecycle choices, so
// scrub that installed state before application config is imported or child fixtures inherit it.
for (const name of [
  "MINIME_APP_DATABASE_URL",
  "MINIME_APP_PASSWORD",
  "MINIME_PG_BACKEND",
  "MINIME_PG_PORT",
  "MINIME_PG_INSTALL_PENDING",
  "BACKUP_CRON",
  "BRIEF_CRON",
  "NTFY_URL",
] as const) {
  Reflect.deleteProperty(process.env, name);
}
const explicitDatabaseUrl = process.env.MINIME_TEST_DATABASE_URL;
const runToken = `${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const retainedPlan: TestDatabasePlan = planTestDatabase(
  sourceDatabaseUrl,
  runToken,
  explicitDatabaseUrl,
);
const retainedHandle: ProvisionedTestDatabase = await provisionTestDatabase(retainedPlan);

type CloseDatabase = () => Promise<void>;
type DisposeDatabase = (handle: ProvisionedTestDatabase) => Promise<void>;
type DrainDatabaseClosers = () => Promise<void>;
const cleanupPromises = new WeakMap<object, Promise<void>>();
const noOpDrain = async (): Promise<void> => {};
const drainTestDatabaseClosers = (): Promise<void> => testDatabaseCloserRegistry.drain();

async function closeDatabasePool(): Promise<void> {
  const { closeDb } = await import("../src/db/client");
  await closeDb();
}

async function closeAndDispose(
  handle: ProvisionedTestDatabase,
  closeDatabase: CloseDatabase,
  disposeDatabase: DisposeDatabase,
  drainDatabaseClosers: DrainDatabaseClosers,
): Promise<void> {
  let cleanupFailed = false;
  try {
    await drainDatabaseClosers();
  } catch {
    cleanupFailed = true;
  }
  try {
    await closeDatabase();
  } catch {
    cleanupFailed = true;
  }
  if (process.env.MINIME_KEEP_TEST_DATABASE === "1" && handle.createdByThisProcess) {
    console.log(handle.plan.databaseName);
  } else {
    try {
      await disposeDatabase(handle);
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) throw fixedCleanupError();
}

function closeAndDisposeOnce(
  handle: ProvisionedTestDatabase,
  closeDatabase: CloseDatabase,
  disposeDatabase: DisposeDatabase,
  drainDatabaseClosers: DrainDatabaseClosers,
): Promise<void> {
  const existing = cleanupPromises.get(handle);
  if (existing) return existing;
  const cleanup = closeAndDispose(handle, closeDatabase, disposeDatabase, drainDatabaseClosers);
  cleanupPromises.set(handle, cleanup);
  return cleanup;
}

export async function bootstrapTestDatabase(
  handle: ProvisionedTestDatabase,
  bootstrap: () => Promise<void>,
  closeDatabase: CloseDatabase = closeDatabasePool,
  disposeDatabase: DisposeDatabase = disposeTestDatabase,
  drainDatabaseClosers: DrainDatabaseClosers = handle === retainedHandle
    ? drainTestDatabaseClosers
    : noOpDrain,
): Promise<void> {
  try {
    await bootstrap();
  } catch (error) {
    try {
      await closeAndDisposeOnce(handle, closeDatabase, disposeDatabase, drainDatabaseClosers);
    } catch {
      throw fixedCleanupError();
    }
    throw error;
  }
}

// disposeTestDatabase may wait TEARDOWN_BACKGROUND_MAX_CYCLES (300) *
// TEARDOWN_RECHECK_INTERVAL_MS (100ms) = 30s on a busy Docker Postgres.
// closeAndDispose also drains closers and closeDb (postgres.js end timeout 5s).
// Bun's 5s default hook timeout is too tight for that process-wide closer.
const SETUP_AFTER_ALL_TIMEOUT_MS = 40_000;

// biome-ignore format: isolation contract requires `afterAll(async () =>` on one line
afterAll(async () => {
  await closeAndDisposeOnce(
    retainedHandle,
    closeDatabasePool,
    disposeTestDatabase,
    drainTestDatabaseClosers,
  );
}, { timeout: SETUP_AFTER_ALL_TIMEOUT_MS });

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.once(signal, () => {
    let cleanupFailed = false;
    void closeAndDisposeOnce(
      retainedHandle,
      closeDatabasePool,
      disposeTestDatabase,
      drainTestDatabaseClosers,
    )
      .catch(() => {
        cleanupFailed = true;
        console.error("test_database_cleanup_failed");
      })
      .finally(() => {
        process.exit(cleanupFailed ? 1 : code);
      });
  });
}

export function testDatabaseUrl(): string {
  return retainedPlan.databaseUrl;
}

export function activeTestDatabaseName(): string {
  return retainedPlan.databaseName;
}

await bootstrapTestDatabase(
  retainedHandle,
  async () => {
    process.env.DATABASE_URL = retainedPlan.databaseUrl;
    process.env.MINIME_MOCK_OLLAMA = "1";
    process.env.TZ = "Asia/Singapore";
    process.env.NODE_ENV = "test";
    process.env.EMBED_PROVIDER = "ollama";
    process.env.CLASSIFY_PROVIDER = "ollama";
    Reflect.deleteProperty(process.env, "RERANK_URL");
    Reflect.deleteProperty(process.env, "RESTIC_REPOSITORY");
    Reflect.deleteProperty(process.env, "RESTIC_PASSWORD_FILE");
    process.env.MINIME_DATA_DIR = mkdtempSync(join(realpathSync(tmpdir()), "minime-test-"));

    const { migrate } = await import("../src/db/migrate");
    await migrate({ kind: "test" });
  },
  closeDatabasePool,
  disposeTestDatabase,
  drainTestDatabaseClosers,
);
