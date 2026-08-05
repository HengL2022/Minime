// Test preload: each process owns one guarded loopback database. The application pool is
// imported only after DATABASE_URL points at that retained plan.

import { afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
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
// Never let a harness-provided live runtime endpoint win when this preload retargets the owner
// database to its private scratch clone. The replacement is installed before importing config
// (and therefore before src/db/client constructs either pool).
Reflect.deleteProperty(process.env, "MINIME_APP_DATABASE_URL");
const sourceDatabaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
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

afterAll(async () => {
  await closeAndDisposeOnce(
    retainedHandle,
    closeDatabasePool,
    disposeTestDatabase,
    drainTestDatabaseClosers,
  );
});

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
    process.env.MINIME_DATA_DIR = mkdtempSync(join(tmpdir(), "minime-test-"));

    const { migrate } = await import("../src/db/migrate");
    await migrate({ kind: "test" });
  },
  closeDatabasePool,
  disposeTestDatabase,
  drainTestDatabaseClosers,
);
