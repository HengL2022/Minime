import postgres from "postgres";

export interface TestDatabasePlan {
  readonly databaseUrl: string;
  readonly adminUrl: string;
  readonly databaseName: string;
  readonly mode: "create" | "external";
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const GENERATED_RUN_TOKEN = /^(?:[a-z][a-z0-9_]*_)?[0-9]+_[a-f0-9]{12}$/;
const GUARDED_DATABASE_NAME = /^minime_test_[a-z0-9_]+$/;
const INSTALLER_TEMPLATE = "minime_test";
const MINI_ADVISORY_KEY = 1296649801;
const TEST_ADVISORY_KEY = 1413829460;
const TEARDOWN_MAX_CYCLES = 20;
const TEARDOWN_RECHECK_INTERVAL_MS = 100;
const TERMINATE_TIMEOUT_MS = 1_000;

function fail(rule: "invalid" | "loopback" | "guard" | "query_or_fragment"): never {
  throw new Error(`test_database_${rule}`);
}

function parseDatabaseUrl(raw: string): URL {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control-byte rejection guards URL normalization.
  if (raw !== raw.trim() || /[\u0000-\u001f\u007f]/.test(raw)) fail("invalid");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail("invalid");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") fail("invalid");
  if (raw.includes("?") || raw.includes("#")) fail("query_or_fragment");
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) fail("loopback");
  return url;
}

function guardedNameFromUrl(url: URL): string {
  const name = url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname;
  if (!GUARDED_DATABASE_NAME.test(name)) fail("guard");
  return name;
}

function withDatabasePath(url: URL, pathname: string): string {
  const result = new URL(url.toString());
  result.pathname = pathname;
  return result.toString();
}

export function planTestDatabase(
  sourceUrl: string,
  runToken: string,
  explicitUrl?: string,
): TestDatabasePlan {
  if (explicitUrl !== undefined) {
    const target = parseDatabaseUrl(explicitUrl);
    const databaseName = guardedNameFromUrl(target);
    return {
      databaseUrl: target.toString(),
      adminUrl: withDatabasePath(target, "/postgres"),
      databaseName,
      mode: "external",
    };
  }

  const source = parseDatabaseUrl(sourceUrl);
  if (!GENERATED_RUN_TOKEN.test(runToken)) fail("guard");
  const databaseName = `minime_test_${runToken}`;
  return {
    databaseUrl: withDatabasePath(source, `/${databaseName}`),
    adminUrl: withDatabasePath(source, "/postgres"),
    databaseName,
    mode: "create",
  };
}

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

const authoritativeAdmins = new WeakSet<TestDatabaseAdmin>();

export interface TestDatabaseDeps {
  connectAdmin(adminUrl: string): Promise<TestDatabaseAdmin>;
  observeLifecycle?(event: "mint" | "mint_external", plan: TestDatabasePlan): void;
}

declare const provisionedTestDatabaseBrand: unique symbol;

export interface ProvisionedTestDatabase {
  readonly plan: TestDatabasePlan;
  readonly createdByThisProcess: boolean;
  readonly [provisionedTestDatabaseBrand]: true;
}

type Lifecycle = "live" | "disposing" | "disposed";

type HandleState = {
  lifecycle: Lifecycle;
  plan: TestDatabasePlan;
  createdByThisProcess: boolean;
  disposePromise?: Promise<void>;
};

const handleStates = new WeakMap<object, HandleState>();

function observeMint(
  deps: TestDatabaseDeps,
  event: "mint" | "mint_external",
  plan: TestDatabasePlan,
): void {
  try {
    deps.observeLifecycle?.(event, plan);
  } catch {
    // Observability cannot change ownership or mask a successful registration.
  }
}

function generatedName(name: string): void {
  if (!GUARDED_DATABASE_NAME.test(name)) fail("guard");
}

function revalidatePlan(plan: TestDatabasePlan): void {
  if (!plan || (plan.mode !== "create" && plan.mode !== "external")) fail("invalid");
  const target = parseDatabaseUrl(plan.databaseUrl);
  const admin = parseDatabaseUrl(plan.adminUrl);
  const targetName = guardedNameFromUrl(target);
  if (targetName !== plan.databaseName || admin.pathname !== "/postgres") fail("guard");
  if (admin.toString() !== withDatabasePath(target, "/postgres")) fail("guard");
  if (plan.mode === "create") generatedName(plan.databaseName);
}

function snapshotPlan(plan: TestDatabasePlan): TestDatabasePlan {
  return Object.freeze({
    databaseUrl: plan.databaseUrl,
    adminUrl: plan.adminUrl,
    databaseName: plan.databaseName,
    mode: plan.mode,
  });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function fixedCloneError(error: unknown): Error {
  const code = errorCode(error);
  if (code === "55006") return new Error("test_database_template_busy");
  if (code === "42P04") return new Error("test_database_collision");
  return new Error("test_database_clone_failed");
}

function fixedCleanupError(): Error {
  return new Error("test_database_cleanup_failed");
}

async function closeQuietly(admin: TestDatabaseAdmin | undefined): Promise<void> {
  if (!admin) return;
  try {
    await admin.close();
  } catch {
    // The operation which caused cleanup is the useful error before ownership exists.
  }
}

async function teardownWithAdmin(admin: TestDatabaseAdmin, plan: TestDatabasePlan): Promise<void> {
  revalidatePlan(plan);
  if (plan.mode !== "create") throw fixedCleanupError();
  if (authoritativeAdmins.has(admin)) {
    await admin.drop(plan.databaseName);
    return;
  }
  await admin.terminate(plan.databaseName);
  await admin.drop(plan.databaseName);
}

async function rollbackOnAdmin(
  admin: TestDatabaseAdmin,
  plan: TestDatabasePlan,
  cloneSucceeded: boolean,
): Promise<void> {
  if (!cloneSucceeded) throw fixedCleanupError();
  try {
    await teardownWithAdmin(admin, plan);
  } catch {
    throw fixedCleanupError();
  }
}

async function rollbackWithReconnect(
  deps: TestDatabaseDeps,
  plan: TestDatabasePlan,
  cloneSucceeded: boolean,
): Promise<void> {
  let cleanupAdmin: TestDatabaseAdmin | undefined;
  let cleanupError: Error | undefined;
  try {
    cleanupAdmin = await deps.connectAdmin(plan.adminUrl);
    await rollbackOnAdmin(cleanupAdmin, plan, cloneSucceeded);
  } catch {
    cleanupError = fixedCleanupError();
  } finally {
    if (cleanupAdmin) {
      try {
        await cleanupAdmin.close();
      } catch {
        cleanupError ??= fixedCleanupError();
      }
    }
  }
  if (cleanupError) throw cleanupError;
}

async function provisionGenerated(
  plan: TestDatabasePlan,
  deps: TestDatabaseDeps,
): Promise<ProvisionedTestDatabase> {
  let admin: TestDatabaseAdmin | undefined;
  let adminClosed = false;
  let cloneSucceeded = false;
  try {
    admin = await deps.connectAdmin(plan.adminUrl);
    await admin.acquireTemplateCloneLock();
    if (await admin.exists(plan.databaseName)) throw new Error("test_database_collision");
    await admin.assertInstallerTemplateIdle();
    await admin.cloneFromInstallerTemplate(plan.databaseName);
    cloneSucceeded = true;
    try {
      await admin.assertExtensionsPresent(plan.databaseUrl);
    } catch (error) {
      let rollbackFailed = false;
      try {
        await rollbackOnAdmin(admin, plan, cloneSucceeded);
      } catch {
        rollbackFailed = true;
      }
      try {
        await admin.close();
      } catch {
        rollbackFailed = true;
      }
      adminClosed = true;
      if (rollbackFailed) throw fixedCleanupError();
      throw error;
    }
    try {
      await admin.close();
      adminClosed = true;
    } catch (error) {
      adminClosed = true;
      await rollbackWithReconnect(deps, plan, cloneSucceeded);
      throw error;
    }
    const handle = Object.freeze({ plan, createdByThisProcess: true }) as ProvisionedTestDatabase;
    handleStates.set(handle, { lifecycle: "live", plan, createdByThisProcess: true });
    observeMint(deps, "mint", plan);
    return handle;
  } catch (error) {
    if (!cloneSucceeded && !adminClosed) await closeQuietly(admin);
    throw error;
  }
}

async function provisionExternal(
  plan: TestDatabasePlan,
  deps: TestDatabaseDeps,
): Promise<ProvisionedTestDatabase> {
  let admin: TestDatabaseAdmin | undefined;
  let adminClosed = false;
  try {
    admin = await deps.connectAdmin(plan.adminUrl);
    if (!(await admin.exists(plan.databaseName))) {
      throw new Error("test_database_external_missing");
    }
    await admin.assertExtensionsPresent(plan.databaseUrl);
    adminClosed = true;
    await admin.close();
    const handle = Object.freeze({ plan, createdByThisProcess: false }) as ProvisionedTestDatabase;
    handleStates.set(handle, { lifecycle: "live", plan, createdByThisProcess: false });
    observeMint(deps, "mint_external", plan);
    return handle;
  } catch (error) {
    if (!adminClosed) await closeQuietly(admin);
    throw error;
  }
}

type AdapterRow = Record<string, unknown>;

type ReservedAdapterConnection = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<AdapterRow[]>;
  unsafe(statement: string): Promise<AdapterRow[]>;
  release(): void;
};

type AdapterConnection = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<AdapterRow[]>;
  unsafe(statement: string): Promise<AdapterRow[]>;
  end(options?: { timeout?: number }): Promise<void>;
  reserve(): Promise<ReservedAdapterConnection>;
};

type AdapterFactory = (
  adminUrl: string,
  options: { max: number; onnotice: () => void },
) => AdapterConnection;

export interface TestDatabaseRetryClock {
  delay(milliseconds: number): Promise<void>;
}

const systemRetryClock: TestDatabaseRetryClock = {
  delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  },
};

const postgresFactory = postgres as unknown as AdapterFactory;

export function createDefaultTestDatabaseDeps(
  factory: AdapterFactory = postgresFactory,
  clock: TestDatabaseRetryClock = systemRetryClock,
): TestDatabaseDeps {
  return {
    async connectAdmin(adminUrl) {
      const parsedAdminUrl = parseDatabaseUrl(adminUrl);
      let currentRole: string;
      try {
        currentRole = decodeURIComponent(parsedAdminUrl.username);
      } catch {
        fail("invalid");
      }
      const pool = factory(adminUrl, { max: 1, onnotice: () => {} });
      let reserved: ReservedAdapterConnection;
      try {
        reserved = await pool.reserve();
      } catch (error) {
        try {
          await pool.end({ timeout: 5 });
        } catch {
          // Preserve the reservation failure while still ending the pool.
        }
        throw error;
      }
      let closed = false;
      const fencedTargets = new Set<string>();
      const exactKeys = (row: AdapterRow, keys: readonly string[]): boolean =>
        Object.keys(row).sort().join(",") === [...keys].sort().join(",");
      const fenceTarget = async (databaseName: string): Promise<void> => {
        generatedName(databaseName);
        if (fencedTargets.has(databaseName)) return;
        try {
          await reserved.unsafe(`alter database "${databaseName}" with allow_connections false`);
        } catch {
          throw fixedCleanupError();
        }
        fencedTargets.add(databaseName);
      };
      const classifySnapshot = async (
        databaseName: string,
      ): Promise<{ eligiblePids: number[]; blocked: boolean }> => {
        generatedName(databaseName);
        let activityRows: AdapterRow[];
        try {
          activityRows =
            await reserved`select pid, usename, backend_type from pg_stat_activity where datname = ${databaseName} and pid <> pg_backend_pid()`;
        } catch {
          throw fixedCleanupError();
        }
        if (!Array.isArray(activityRows)) throw fixedCleanupError();
        const eligiblePids: number[] = [];
        const seenPids = new Set<number>();
        let blocked = false;
        for (const row of activityRows) {
          if (!row || !exactKeys(row, ["backend_type", "pid", "usename"])) {
            throw fixedCleanupError();
          }
          if (typeof row.pid !== "number" || !Number.isInteger(row.pid) || row.pid <= 0) {
            throw fixedCleanupError();
          }
          if (
            row.usename !== null &&
            (typeof row.usename !== "string" || row.usename.length === 0)
          ) {
            throw fixedCleanupError();
          }
          if (
            row.backend_type !== null &&
            (typeof row.backend_type !== "string" || row.backend_type.length === 0)
          ) {
            throw fixedCleanupError();
          }
          if (seenPids.has(row.pid)) throw fixedCleanupError();
          seenPids.add(row.pid);
          if (row.backend_type === "client backend" && row.usename === currentRole) {
            eligiblePids.push(row.pid);
          } else {
            blocked = true;
          }
        }
        return { eligiblePids, blocked };
      };
      const terminateEligible = async (
        databaseName: string,
        eligiblePids: number[],
      ): Promise<void> => {
        generatedName(databaseName);
        if (eligiblePids.length === 0) return;
        const expectedPidValues = eligiblePids.map((pid) => `(${pid})`).join(",");
        let terminationRows: AdapterRow[];
        try {
          terminationRows = await reserved.unsafe(
            `select expected.pid, case when activity.pid is null then false else pg_terminate_backend(activity.pid, ${TERMINATE_TIMEOUT_MS}) end as terminated from (values ${expectedPidValues}) as expected(pid) left join pg_stat_activity activity on activity.pid = expected.pid and activity.datname = '${databaseName}' and activity.usename = current_user and activity.backend_type = 'client backend'`,
          );
        } catch {
          throw fixedCleanupError();
        }
        if (!Array.isArray(terminationRows) || terminationRows.length !== eligiblePids.length) {
          throw fixedCleanupError();
        }
        const expected = new Set(eligiblePids);
        const seen = new Set<number>();
        for (const row of terminationRows) {
          if (!row || !exactKeys(row, ["pid", "terminated"])) throw fixedCleanupError();
          if (
            typeof row.pid !== "number" ||
            !Number.isInteger(row.pid) ||
            !expected.has(row.pid) ||
            seen.has(row.pid) ||
            typeof row.terminated !== "boolean"
          ) {
            throw fixedCleanupError();
          }
          seen.add(row.pid);
        }
        if (seen.size !== expected.size) throw fixedCleanupError();
      };
      const dropTarget = async (databaseName: string): Promise<void> => {
        generatedName(databaseName);
        await fenceTarget(databaseName);
        const delayNextCycle = async (): Promise<void> => {
          try {
            await clock.delay(TEARDOWN_RECHECK_INTERVAL_MS);
          } catch {
            throw fixedCleanupError();
          }
        };
        for (let cycle = 0; cycle < TEARDOWN_MAX_CYCLES; cycle += 1) {
          const { eligiblePids, blocked } = await classifySnapshot(databaseName);
          if (blocked) {
            if (cycle + 1 >= TEARDOWN_MAX_CYCLES) throw fixedCleanupError();
            await delayNextCycle();
            continue;
          }
          await terminateEligible(databaseName, eligiblePids);
          try {
            await reserved.unsafe(`drop database "${databaseName}"`);
            fencedTargets.delete(databaseName);
            return;
          } catch (error) {
            if (errorCode(error) !== "55006") {
              throw fixedCleanupError();
            }
            if (cycle + 1 >= TEARDOWN_MAX_CYCLES) throw fixedCleanupError();
            await delayNextCycle();
          }
        }
        throw fixedCleanupError();
      };
      const terminateTarget = async (databaseName: string): Promise<void> => {
        generatedName(databaseName);
        await fenceTarget(databaseName);
        const { eligiblePids, blocked } = await classifySnapshot(databaseName);
        if (blocked) throw fixedCleanupError();
        await terminateEligible(databaseName, eligiblePids);
      };
      const admin = {
        async acquireTemplateCloneLock() {
          await reserved`select pg_advisory_lock(${MINI_ADVISORY_KEY}, ${TEST_ADVISORY_KEY})`;
        },
        async exists(databaseName) {
          generatedName(databaseName);
          const rows = await reserved`select 1 from pg_database where datname = ${databaseName}`;
          return rows.length > 0;
        },
        async assertInstallerTemplateIdle() {
          const rows =
            await reserved`select count(*)::int as count from pg_stat_activity where datname = ${INSTALLER_TEMPLATE}`;
          if (Number(rows[0]?.count ?? 0) !== 0) throw new Error("test_database_template_busy");
        },
        async cloneFromInstallerTemplate(databaseName) {
          generatedName(databaseName);
          try {
            await reserved.unsafe(
              `create database "${databaseName}" with owner = minime template = ${INSTALLER_TEMPLATE}`,
            );
          } catch (error) {
            throw fixedCloneError(error);
          }
        },
        async assertExtensionsPresent(databaseUrl) {
          const target = factory(databaseUrl, { max: 1, onnotice: () => {} });
          let assertionError: Error | undefined;
          try {
            const rows =
              await target`select extname from pg_extension where extname in ('vector', 'pgcrypto')`;
            const names = rows.map((row) => String(row.extname));
            if (
              rows.length !== 2 ||
              new Set(names).size !== 2 ||
              !names.includes("vector") ||
              !names.includes("pgcrypto")
            ) {
              assertionError = new Error("test_database_extensions_missing");
            }
          } catch {
            assertionError = new Error("test_database_extensions_missing");
          } finally {
            try {
              await target.end({ timeout: 5 });
            } catch {
              assertionError ??= new Error("test_database_extensions_missing");
            }
          }
          if (assertionError) throw assertionError;
        },
        async terminate(databaseName) {
          await terminateTarget(databaseName);
        },
        async drop(databaseName) {
          await dropTarget(databaseName);
        },
        async close() {
          if (closed) return;
          closed = true;
          let closeError: unknown;
          try {
            reserved.release();
          } catch (error) {
            closeError = error;
          }
          try {
            await pool.end({ timeout: 5 });
          } catch (error) {
            closeError ??= error;
          }
          if (closeError) throw closeError;
        },
      } satisfies TestDatabaseAdmin;
      authoritativeAdmins.add(admin);
      return admin;
    },
  };
}

const defaultDeps: TestDatabaseDeps = createDefaultTestDatabaseDeps();

export async function provisionTestDatabase(
  plan: TestDatabasePlan,
  deps: TestDatabaseDeps = defaultDeps,
): Promise<ProvisionedTestDatabase> {
  revalidatePlan(plan);
  const snapshot = snapshotPlan(plan);
  return snapshot.mode === "external"
    ? provisionExternal(snapshot, deps)
    : provisionGenerated(snapshot, deps);
}

async function disposeOwned(state: HandleState, deps: TestDatabaseDeps): Promise<void> {
  let admin: TestDatabaseAdmin | undefined;
  let operationError: unknown;
  try {
    admin = await deps.connectAdmin(state.plan.adminUrl);
    await teardownWithAdmin(admin, state.plan);
    state.lifecycle = "disposed";
  } catch (error) {
    state.lifecycle = "live";
    operationError =
      error instanceof Error && error.message === "test_database_cleanup_failed"
        ? error
        : fixedCleanupError();
  } finally {
    try {
      await admin?.close();
    } catch (error) {
      operationError ??= fixedCleanupError();
    }
  }
  if (operationError) throw operationError;
}

export async function disposeTestDatabase(
  provisioned: ProvisionedTestDatabase,
  deps: TestDatabaseDeps = defaultDeps,
): Promise<void> {
  if (typeof provisioned !== "object" || provisioned === null) {
    throw new Error("test_database_invalid_handle");
  }
  const state = handleStates.get(provisioned);
  if (!state) throw new Error("test_database_invalid_handle");
  if (state.lifecycle === "disposed") return;
  if (state.lifecycle === "disposing") return state.disposePromise;
  if (!state.createdByThisProcess) {
    state.lifecycle = "disposed";
    return;
  }
  state.lifecycle = "disposing";
  state.disposePromise = disposeOwned(state, deps);
  return state.disposePromise;
}
