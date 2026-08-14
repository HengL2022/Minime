import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type TestDatabaseAdmin,
  type TestDatabaseDeps,
  type TestDatabaseRetryClock,
  createDefaultTestDatabaseDeps,
  disposeTestDatabase,
  planTestDatabase,
  provisionTestDatabase,
} from "./support/test-database";

const base = "postgres://minime:minime@localhost:5432/minime";
const explicitScratch = "postgres://scratch:p%40ss@127.0.0.1:6544/minime_test_external_1";
const remoteUrl = "postgres://minime:minime@db.example.test:5432/minime";
const ownerUrl = "postgres://minime:minime@localhost:5432/minime";
const sharedUrl = "postgres://minime:minime@localhost:5432/minime_test";

const generatedPlan = planTestDatabase(base, "123_aaaaaaaaaaaa");

const repoRoot = resolve(import.meta.dir, "..");

async function ownedWrapper() {
  return import("../scripts/with-test-database");
}

type AdminBehavior = {
  exists?: boolean;
  templateIdleError?: Error;
  cloneError?: Error;
  assertExtensionsError?: Error;
  closeError?: Error;
  terminateError?: Error;
  dropError?: Error;
};

function sqlStateError(code: string): Error & { code: string } {
  return Object.assign(new Error(`server text for ${code}`), { code });
}

function mappedCloneError(error: Error & { code?: string }): Error {
  if (error.code === "55006") return new Error("test_database_template_busy");
  if (error.code === "42P04") return new Error("test_database_collision");
  return new Error("test_database_clone_failed");
}

function fakeAdmin(trace: string[], behavior: AdminBehavior = {}): TestDatabaseAdmin {
  return {
    async acquireTemplateCloneLock() {
      trace.push("lock_template");
    },
    async exists() {
      trace.push(`exists:${behavior.exists === true ? "true" : "false"}`);
      return behavior.exists === true;
    },
    async assertInstallerTemplateIdle() {
      trace.push(behavior.templateIdleError ? "template_idle:busy" : "template_idle");
      if (behavior.templateIdleError) throw behavior.templateIdleError;
    },
    async cloneFromInstallerTemplate(databaseName) {
      trace.push(
        behavior.cloneError
          ? `clone_template:error:${databaseName}`
          : `clone_template:${databaseName}`,
      );
      if (behavior.cloneError) {
        throw mappedCloneError(behavior.cloneError as Error & { code?: string });
      }
    },
    async assertExtensionsPresent(databaseUrl) {
      trace.push(
        behavior.assertExtensionsError
          ? `assert_extensions:fail:${databaseUrl}`
          : `assert_extensions:${databaseUrl}`,
      );
      if (behavior.assertExtensionsError) throw behavior.assertExtensionsError;
    },
    async terminate(databaseName) {
      trace.push(`terminate:${databaseName}`);
      if (behavior.terminateError) throw behavior.terminateError;
    },
    async drop(databaseName) {
      trace.push(`drop:${databaseName}`);
      if (behavior.dropError) throw behavior.dropError;
    },
    async close() {
      trace.push("close");
      if (behavior.closeError) throw behavior.closeError;
    },
  };
}

function fakeDeps(
  trace: string[],
  provisioning: AdminBehavior = {},
  cleanup?: AdminBehavior,
): TestDatabaseDeps {
  let connects = 0;
  return {
    observeLifecycle(event, plan) {
      trace.push(`${event}:${plan.databaseName}:${plan.databaseUrl}`);
    },
    async connectAdmin(url) {
      expect(url).toBe(generatedPlan.adminUrl);
      connects += 1;
      trace.push(connects === 1 ? "connect:provisioning" : "connect:cleanup");
      return fakeAdmin(trace, connects === 1 ? provisioning : cleanup);
    },
  };
}

function expectNoDestructiveMint(trace: string[]) {
  expect(trace.some((event) => event.startsWith("terminate:"))).toBe(false);
  expect(trace.some((event) => event.startsWith("drop:"))).toBe(false);
  expect(trace.some((event) => event.startsWith("mint"))).toBe(false);
}

describe("test database planning", () => {
  test("plans distinct guarded generated databases", () => {
    const a = planTestDatabase(base, "123_aaaaaaaaaaaa");
    const b = planTestDatabase(base, "124_bbbbbbbbbbbb");

    expect(a.databaseName).toBe("minime_test_123_aaaaaaaaaaaa");
    expect(a.databaseName).not.toBe(b.databaseName);
    expect(a.databaseName).toMatch(/^minime_test_[0-9]+_[a-f0-9]{12}$/);
    expect(a.mode).toBe("create");
    expect(a.databaseUrl).toBe(
      "postgres://minime:minime@localhost:5432/minime_test_123_aaaaaaaaaaaa",
    );
    expect(a.adminUrl).toBe("postgres://minime:minime@localhost:5432/postgres");
  });

  test("preserves generated URL credentials and port while replacing only the pathname", () => {
    const plan = planTestDatabase(
      "postgres://user:p%40ss@127.0.0.1:6544/minime",
      "123_aaaaaaaaaaaa",
    );

    expect(plan.databaseUrl).toBe(
      "postgres://user:p%40ss@127.0.0.1:6544/minime_test_123_aaaaaaaaaaaa",
    );
    expect(plan.adminUrl).toBe("postgres://user:p%40ss@127.0.0.1:6544/postgres");
  });

  test("accepts a guarded explicit loopback database without normalizing credentials or port", () => {
    const plan = planTestDatabase(base, "run", explicitScratch);

    expect(plan.mode).toBe("external");
    expect(plan.databaseName).toBe("minime_test_external_1");
    expect(plan.databaseUrl).toBe(explicitScratch);
    expect(plan.adminUrl).toBe("postgres://scratch:p%40ss@127.0.0.1:6544/postgres");
  });

  test("rejects non-loopback sources and explicit targets", () => {
    expect(() => planTestDatabase(remoteUrl, "run")).toThrow("test_database_loopback");
    expect(() => planTestDatabase(base, "run", remoteUrl)).toThrow("test_database_loopback");
  });

  test("rejects owner, shared, and unguarded explicit database names", () => {
    expect(() => planTestDatabase(base, "run", ownerUrl)).toThrow("test_database_guard");
    expect(() => planTestDatabase(base, "run", sharedUrl)).toThrow("test_database_guard");
    expect(() =>
      planTestDatabase(base, "run", "postgres://minime:minime@localhost:5432/minime_eval_1"),
    ).toThrow("test_database_guard");
    expect(() =>
      planTestDatabase(base, "run", "postgres://minime:minime@localhost:5432/minime_test_"),
    ).toThrow("test_database_guard");
  });

  test("rejects malformed or query-bearing URLs instead of silently normalizing them", () => {
    expect(() => planTestDatabase("not a postgres URL", "123_aaaaaaaaaaaa")).toThrow(
      "test_database_invalid",
    );
    expect(() => planTestDatabase(`${base}?sslmode=require`, "123_aaaaaaaaaaaa")).toThrow(
      "test_database_query_or_fragment",
    );
    expect(() => planTestDatabase(base, "run", `${explicitScratch}?sslmode=require`)).toThrow(
      "test_database_query_or_fragment",
    );
    expect(() => planTestDatabase(base, "run", `${explicitScratch}?`)).toThrow(
      "test_database_query_or_fragment",
    );
    expect(() => planTestDatabase(base, "run", `${explicitScratch}#fragment`)).toThrow(
      "test_database_query_or_fragment",
    );
    expect(() => planTestDatabase(base, "run", `${explicitScratch}#`)).toThrow(
      "test_database_query_or_fragment",
    );
  });

  test("rejects malformed generated tokens and encoded explicit names", () => {
    expect(() => planTestDatabase(base, "not-a-run-token")).toThrow("test_database_guard");
    expect(() =>
      planTestDatabase(base, "run", "postgres://minime:minime@localhost:5432/minime_test_%66oo"),
    ).toThrow("test_database_guard");
  });
});

describe("test database provisioning ownership", () => {
  test("mints only after guarded clone and extension checks complete", async () => {
    const trace: string[] = [];
    const deps = fakeDeps(trace);
    let observedPlan: typeof generatedPlan | undefined;
    deps.observeLifecycle = (event, plan) => {
      observedPlan = plan;
      trace.push(`${event}:${plan.databaseName}:${plan.databaseUrl}`);
    };
    const handle = await provisionTestDatabase(generatedPlan, deps);

    expect(trace).toEqual([
      "connect:provisioning",
      "lock_template",
      "exists:false",
      "template_idle",
      `clone_template:${generatedPlan.databaseName}`,
      `assert_extensions:${generatedPlan.databaseUrl}`,
      "close",
      `mint:${generatedPlan.databaseName}:${generatedPlan.databaseUrl}`,
    ]);
    expect(handle.plan).toEqual(generatedPlan);
    expect(handle.createdByThisProcess).toBe(true);
    expect(observedPlan).toBe(handle.plan);
    expect(Object.isFrozen(observedPlan)).toBe(true);
    expect(trace.at(-1)).toBe(`mint:${generatedPlan.databaseName}:${generatedPlan.databaseUrl}`);
  });

  test("observer failure is contained after private registration and does not strand disposal", async () => {
    const trace: string[] = [];
    const deps = fakeDeps(trace);
    deps.observeLifecycle = (event, plan) => {
      trace.push(`${event}:${plan.databaseName}:${plan.databaseUrl}`);
      throw new Error("observer failure");
    };
    const handle = await provisionTestDatabase(generatedPlan, deps);

    expect(handle.createdByThisProcess).toBe(true);
    expect(trace).toContain(`mint:${generatedPlan.databaseName}:${generatedPlan.databaseUrl}`);
    await disposeTestDatabase(handle, deps);
    expect(trace).toContain(`drop:${generatedPlan.databaseName}`);
  });

  test("busy template closes without cloning, rollback, or minting", async () => {
    const trace: string[] = [];
    await expect(
      provisionTestDatabase(
        generatedPlan,
        fakeDeps(trace, { templateIdleError: new Error("test_database_template_busy") }),
      ),
    ).rejects.toThrow("test_database_template_busy");
    expect(trace).toEqual([
      "connect:provisioning",
      "lock_template",
      "exists:false",
      "template_idle:busy",
      "close",
    ]);
    expectNoDestructiveMint(trace);
  });

  test("clone rejection never grants ownership, even for SQLSTATE failures", async () => {
    for (const [error, expected] of [
      [sqlStateError("55006"), "test_database_template_busy"],
      [sqlStateError("42P04"), "test_database_collision"],
      [new Error("indeterminate clone result"), "test_database_clone_failed"],
    ] as const) {
      const trace: string[] = [];
      await expect(
        provisionTestDatabase(generatedPlan, fakeDeps(trace, { cloneError: error })),
      ).rejects.toThrow(expected);
      expect(trace).toEqual([
        "connect:provisioning",
        "lock_template",
        "exists:false",
        "template_idle",
        `clone_template:error:${generatedPlan.databaseName}`,
        "close",
      ]);
      expectNoDestructiveMint(trace);
    }
  });

  test("never infers ownership from a same-name database observed after clone rejection", async () => {
    const trace: string[] = [];
    const admin = fakeAdmin(trace, { cloneError: new Error("clone result unknown") });
    const racedAdmin: TestDatabaseAdmin = {
      ...admin,
      async close() {
        trace.push("exists:true:after-rejection");
        await admin.close();
      },
      async cloneFromInstallerTemplate(databaseName) {
        trace.push(`clone_template:error:${databaseName}`);
        throw new Error("test_database_clone_failed");
      },
    };
    const deps: TestDatabaseDeps = {
      observeLifecycle(event, plan) {
        trace.push(`${event}:${plan.databaseName}:${plan.databaseUrl}`);
      },
      connectAdmin: async () => racedAdmin,
    };

    await expect(provisionTestDatabase(generatedPlan, deps)).rejects.toThrow(
      "test_database_clone_failed",
    );
    expect(trace).toContain("exists:true:after-rejection");
    expectNoDestructiveMint(trace);
  });

  test("pre-existing collision is never adopted or dropped", async () => {
    const trace: string[] = [];
    await expect(
      provisionTestDatabase(generatedPlan, fakeDeps(trace, { exists: true })),
    ).rejects.toThrow("test_database_collision");
    expect(trace).toEqual(["connect:provisioning", "lock_template", "exists:true", "close"]);
    expectNoDestructiveMint(trace);
  });

  test("known clone success rolls back exactly the generated target on extension failure", async () => {
    const trace: string[] = [];
    await expect(
      provisionTestDatabase(
        generatedPlan,
        fakeDeps(trace, { assertExtensionsError: new Error("test_database_extensions_missing") }),
      ),
    ).rejects.toThrow("test_database_extensions_missing");
    expect(trace).toEqual([
      "connect:provisioning",
      "lock_template",
      "exists:false",
      "template_idle",
      `clone_template:${generatedPlan.databaseName}`,
      `assert_extensions:fail:${generatedPlan.databaseUrl}`,
      `terminate:${generatedPlan.databaseName}`,
      `drop:${generatedPlan.databaseName}`,
      "close",
    ]);
    expect(trace.filter((event) => event.startsWith("drop:")).length).toBe(1);
  });

  test("cleanup capability stays private and injected admins cannot bypass ordinary drop", async () => {
    const trace: string[] = [];
    const cleanupAdmin = Object.assign(fakeAdmin(trace), {
      async teardown(databaseName: string) {
        trace.push(`teardown:${databaseName}`);
      },
    }) as TestDatabaseAdmin;
    let connects = 0;
    const deps: TestDatabaseDeps = {
      async connectAdmin(url) {
        expect(url).toBe(generatedPlan.adminUrl);
        connects += 1;
        trace.push(connects === 1 ? "connect:provisioning" : "connect:cleanup");
        return connects === 1
          ? fakeAdmin(trace, {
              assertExtensionsError: new Error("test_database_extensions_missing"),
            })
          : cleanupAdmin;
      },
    };

    const source = await Bun.file(new URL("./support/test-database.ts", import.meta.url)).text();
    const adminInterface =
      source.match(/export interface TestDatabaseAdmin[\s\S]*?\n}/)?.[0] ?? source;
    expect(adminInterface).not.toMatch(/teardown\s*\?/);
    await expect(provisionTestDatabase(generatedPlan, deps)).rejects.toThrow(
      "test_database_extensions_missing",
    );
    expect(trace).toContain(`drop:${generatedPlan.databaseName}`);
    expect(trace).not.toContain(`teardown:${generatedPlan.databaseName}`);
  });

  test("default adapter lifecycle uses one private authoritative drop cycle", async () => {
    const statements: string[] = [];
    const deps = createDefaultTestDatabaseDeps((url) => {
      const isTarget = url === generatedPlan.databaseUrl;
      const reserved = Object.assign(
        async (strings: TemplateStringsArray) => {
          const query = strings.join(" ");
          statements.push(query);
          if (query.includes("select pid, usename, backend_type")) return [];
          return [];
        },
        {
          unsafe: async (statement: string) => {
            statements.push(statement);
            return [];
          },
          release: () => {},
        },
      );
      return Object.assign(
        async (strings: TemplateStringsArray) => {
          if (isTarget && strings.join(" ").includes("select extname")) {
            return [{ extname: "vector" }, { extname: "pgcrypto" }];
          }
          return [];
        },
        {
          unsafe: async (statement: string) => {
            statements.push(statement);
            return [];
          },
          end: async () => {},
          reserve: async () => reserved,
        },
      );
    });

    const handle = await provisionTestDatabase(generatedPlan, deps);
    await disposeTestDatabase(handle, deps);
    expect(statements.filter((statement) => statement.startsWith("drop database")).length).toBe(1);
    expect(statements.filter((statement) => statement.startsWith("alter database")).length).toBe(1);
    expect(
      statements.filter((statement) => statement.includes("pg_terminate_backend")).length,
    ).toBe(0);
  });

  test("extension rollback close failure has fixed cleanup precedence and never mints", async () => {
    const trace: string[] = [];
    await expect(
      provisionTestDatabase(
        generatedPlan,
        fakeDeps(trace, {
          assertExtensionsError: new Error("extensions failed"),
          closeError: new Error("close failed"),
        }),
      ),
    ).rejects.toThrow("test_database_cleanup_failed");
    expect(trace).toContain(`drop:${generatedPlan.databaseName}`);
    expect(trace.some((event) => event.startsWith("mint"))).toBe(false);
  });

  test("post-clone provisioning close failure reconnects only to roll back the guarded target", async () => {
    const trace: string[] = [];
    await expect(
      provisionTestDatabase(
        generatedPlan,
        fakeDeps(trace, { closeError: new Error("close failed") }),
      ),
    ).rejects.toThrow("close failed");
    expect(trace).toEqual([
      "connect:provisioning",
      "lock_template",
      "exists:false",
      "template_idle",
      `clone_template:${generatedPlan.databaseName}`,
      `assert_extensions:${generatedPlan.databaseUrl}`,
      "close",
      "connect:cleanup",
      `terminate:${generatedPlan.databaseName}`,
      `drop:${generatedPlan.databaseName}`,
      "close",
    ]);
  });

  test("snapshots plan scalars before awaits so async caller mutation cannot redirect extension checks", async () => {
    const mutablePlan = planTestDatabase(base, "125_cccccccccccc");
    const redirectedPlan = planTestDatabase(base, "126_dddddddddddd");
    const originalUrl = mutablePlan.databaseUrl;
    const trace: string[] = [];
    const baseAdmin = fakeAdmin(trace);
    const deps: TestDatabaseDeps = {
      observeLifecycle(event, plan) {
        trace.push(`${event}:${plan.databaseName}:${plan.databaseUrl}`);
      },
      async connectAdmin(url) {
        expect(url).toBe(generatedPlan.adminUrl);
        return {
          ...baseAdmin,
          async cloneFromInstallerTemplate(databaseName) {
            await baseAdmin.cloneFromInstallerTemplate(databaseName);
            Object.assign(mutablePlan, {
              databaseName: redirectedPlan.databaseName,
              databaseUrl: redirectedPlan.databaseUrl,
              adminUrl: redirectedPlan.adminUrl,
            });
          },
        };
      },
    };

    const handle = await provisionTestDatabase(mutablePlan, deps);
    expect(handle.plan.databaseName).toBe("minime_test_125_cccccccccccc");
    expect(trace).toContain(`assert_extensions:${originalUrl}`);
    expect(trace).not.toContain(`assert_extensions:${redirectedPlan.databaseUrl}`);
  });

  test("disposal uses private snapshot identity after caller mutates the returned plan", async () => {
    const mutablePlan = planTestDatabase(base, "127_eeeeeeeeeeee");
    const redirectedPlan = planTestDatabase(base, "128_ffffffffffff");
    const originalName = mutablePlan.databaseName;
    const trace: string[] = [];
    let connects = 0;
    const deps: TestDatabaseDeps = {
      async connectAdmin(url) {
        connects += 1;
        expect(url).toBe(generatedPlan.adminUrl);
        const admin = fakeAdmin(trace);
        return {
          ...admin,
          async close() {
            trace.push(connects === 1 ? "close:provision" : "close:dispose");
          },
        };
      },
    };

    const handle = await provisionTestDatabase(mutablePlan, deps);
    Object.assign(mutablePlan, {
      databaseName: redirectedPlan.databaseName,
      databaseUrl: redirectedPlan.databaseUrl,
      adminUrl: redirectedPlan.adminUrl,
    });
    await disposeTestDatabase(handle, deps);
    expect(trace).toContain(`drop:${originalName}`);
    expect(trace).not.toContain(`drop:${redirectedPlan.databaseName}`);
  });

  test("rollback failure is content-free and does not adopt a raced same-name database", async () => {
    const trace: string[] = [];
    await expect(
      provisionTestDatabase(
        generatedPlan,
        fakeDeps(trace, {
          assertExtensionsError: new Error("extensions failed"),
          dropError: new Error("drop failed"),
        }),
      ),
    ).rejects.toThrow("test_database_cleanup_failed");
    expect(trace).toContain(`drop:${generatedPlan.databaseName}`);
    expect(trace.some((event) => event.startsWith("mint"))).toBe(false);
  });

  test("external mode checks the operator-owned database without template lifecycle", async () => {
    const externalPlan = planTestDatabase(base, "run", explicitScratch);
    const trace: string[] = [];
    const deps: TestDatabaseDeps = {
      observeLifecycle(event, plan) {
        trace.push(`${event}:${plan.databaseName}:${plan.databaseUrl}`);
      },
      async connectAdmin(url) {
        expect(url).toBe(externalPlan.adminUrl);
        trace.push("connect:external");
        return fakeAdmin(trace, { exists: true });
      },
    };
    const handle = await provisionTestDatabase(externalPlan, deps);

    expect(trace).toEqual([
      "connect:external",
      "exists:true",
      `assert_extensions:${externalPlan.databaseUrl}`,
      "close",
      `mint_external:${externalPlan.databaseName}:${externalPlan.databaseUrl}`,
    ]);
    expect(handle.createdByThisProcess).toBe(false);
    expect(trace.at(-1)).toBe(
      `mint_external:${externalPlan.databaseName}:${externalPlan.databaseUrl}`,
    );
    await disposeTestDatabase(handle, deps);
    expect(trace).not.toContain("drop");
    expect(trace).not.toContain("terminate");
  });

  test("external missing database and extension failures never roll back", async () => {
    const externalPlan = planTestDatabase(base, "run", explicitScratch);
    for (const behavior of [
      { exists: false },
      { assertExtensionsError: new Error("test_database_extensions_missing") },
    ]) {
      const trace: string[] = [];
      const deps: TestDatabaseDeps = {
        observeLifecycle(event, plan) {
          trace.push(`${event}:${plan.databaseName}:${plan.databaseUrl}`);
        },
        async connectAdmin() {
          trace.push("connect:external");
          return fakeAdmin(trace, behavior);
        },
      };
      await expect(provisionTestDatabase(externalPlan, deps)).rejects.toBeDefined();
      expectNoDestructiveMint(trace);
      expect(trace).not.toContain("lock_template");
      expect(trace).not.toContain(`clone_template:${externalPlan.databaseName}`);
      expect(trace).toContain("close");
    }
  });

  test("external admin-close failure never rolls back the operator-owned database", async () => {
    const externalPlan = planTestDatabase(base, "run", explicitScratch);
    const trace: string[] = [];
    const deps: TestDatabaseDeps = {
      observeLifecycle(event, plan) {
        trace.push(`${event}:${plan.databaseName}:${plan.databaseUrl}`);
      },
      async connectAdmin() {
        trace.push("connect:external");
        return fakeAdmin(trace, { exists: true, closeError: new Error("close failed") });
      },
    };

    await expect(provisionTestDatabase(externalPlan, deps)).rejects.toThrow("close failed");
    expectNoDestructiveMint(trace);
  });

  test("serializes concurrent generated provisioners on the template lock", async () => {
    const secondPlan = planTestDatabase(base, "124_bbbbbbbbbbbb");
    const trace: string[] = [];
    let activeLocks = 0;
    let maximumLocks = 0;
    let nextUnlock: Promise<void> | undefined;
    let releaseLock: (() => void) | undefined;
    let connectionNumber = 0;
    const deps: TestDatabaseDeps = {
      async connectAdmin(url) {
        expect(url).toBe(generatedPlan.adminUrl);
        connectionNumber += 1;
        trace.push(`connect:generated:${connectionNumber}`);
        const admin = fakeAdmin(trace);
        return {
          ...admin,
          async acquireTemplateCloneLock() {
            if (nextUnlock) await nextUnlock;
            activeLocks += 1;
            maximumLocks = Math.max(maximumLocks, activeLocks);
            nextUnlock = new Promise<void>((resolve) => {
              releaseLock = resolve;
            });
            trace.push(`lock_template:${connectionNumber}`);
          },
          async close() {
            activeLocks -= 1;
            releaseLock?.();
            releaseLock = undefined;
            nextUnlock = undefined;
            await admin.close();
          },
        };
      },
    };

    const results = await Promise.all([
      provisionTestDatabase(generatedPlan, deps),
      provisionTestDatabase(secondPlan, deps),
    ]);
    expect(results[0]?.plan.databaseName).not.toBe(results[1]?.plan.databaseName);
    expect(maximumLocks).toBe(1);
    expect(trace.filter((event) => event.startsWith("connect:")).length).toBe(2);
    expect(trace).not.toContain("connect:source");
  });

  test("forged handles are rejected and double disposal is harmless", async () => {
    const trace: string[] = [];
    const deps = fakeDeps(trace);
    const forged = { plan: generatedPlan, createdByThisProcess: true } as never;
    await expect(disposeTestDatabase(forged, deps)).rejects.toThrow("test_database_invalid_handle");

    const handle = await provisionTestDatabase(generatedPlan, deps);
    await disposeTestDatabase(handle, deps);
    const afterFirstDispose = [...trace];
    await disposeTestDatabase(handle, deps);
    expect(trace).toEqual(afterFirstDispose);
    expect(trace).toContain(`drop:${generatedPlan.databaseName}`);
  });

  test("concurrent disposal shares one in-flight drop and retries after transient failure", async () => {
    const trace: string[] = [];
    let dropAttempts = 0;
    const deps: TestDatabaseDeps = {
      async connectAdmin() {
        const admin = fakeAdmin(trace);
        return {
          ...admin,
          async drop(databaseName: string) {
            dropAttempts += 1;
            trace.push(`drop:${databaseName}`);
            if (dropAttempts === 1) throw new Error("transient drop failure");
          },
        };
      },
    };
    const handle = await provisionTestDatabase(generatedPlan, deps);
    await expect(
      Promise.all([disposeTestDatabase(handle, deps), disposeTestDatabase(handle, deps)]),
    ).rejects.toBeDefined();
    expect(dropAttempts).toBe(1);
    await disposeTestDatabase(handle, deps);
    expect(dropAttempts).toBe(2);
  });

  test("successful drop is disposed before a close failure", async () => {
    const trace: string[] = [];
    let connects = 0;
    const deps: TestDatabaseDeps = {
      async connectAdmin() {
        connects += 1;
        return fakeAdmin(trace, connects === 1 ? {} : { closeError: new Error("close failed") });
      },
    };
    const handle = await provisionTestDatabase(generatedPlan, deps);
    await expect(disposeTestDatabase(handle, deps)).rejects.toThrow("test_database_cleanup_failed");
    const beforeRetry = [...trace];
    await disposeTestDatabase(handle, deps);
    expect(trace).toEqual(beforeRetry);
  });
});

describe("test database adapter source contract", () => {
  function retryClock(options: { reject?: Error } = {}): TestDatabaseRetryClock & {
    delays: number[];
  } {
    const delays: number[] = [];
    return {
      delays,
      async delay(milliseconds) {
        delays.push(milliseconds);
        if (options.reject) throw options.reject;
      },
    };
  }

  function activityFactory(options: {
    snapshots: Array<Array<Record<string, unknown>> | Error>;
    termination?: Array<Record<string, unknown>> | Error;
    drops?: Array<Error | undefined>;
    trace?: string[];
  }) {
    let snapshotIndex = 0;
    let dropIndex = 0;
    const trace = options.trace ?? [];
    const factory = (_url: string, _options: { max: number; onnotice: () => void }) => {
      const reserved = Object.assign(
        async (strings: TemplateStringsArray) => {
          const query = strings.join(" ");
          if (query.includes("select pid, usename, backend_type")) {
            trace.push("snapshot");
            const snapshot =
              options.snapshots[Math.min(snapshotIndex++, options.snapshots.length - 1)];
            if (snapshot instanceof Error) throw snapshot;
            return snapshot ?? [];
          }
          return [];
        },
        {
          unsafe: async (statement: string) => {
            if (statement.startsWith("alter database")) trace.push("fence");
            if (statement.includes("pg_terminate_backend")) {
              trace.push("terminate");
              if (options.termination instanceof Error) throw options.termination;
              return options.termination ?? [];
            }
            if (statement.startsWith("drop database")) {
              trace.push("drop");
              const drop = options.drops?.[Math.min(dropIndex++, (options.drops?.length ?? 1) - 1)];
              if (drop) throw drop;
            }
            return [];
          },
          release: () => {},
        },
      );
      return Object.assign(async () => [], {
        unsafe: async () => [],
        end: async () => {},
        reserve: async () => reserved,
      });
    };
    return {
      factory,
      trace,
      get snapshotCount() {
        return snapshotIndex;
      },
      get dropCount() {
        return dropIndex;
      },
    };
  }

  test("rechecks a blocker after one injected delay before ordinary drop", async () => {
    const clock = retryClock();
    const scenario = activityFactory({
      snapshots: [[{ pid: 96460, usename: "minime_engineer_ro", backend_type: null }], []],
      trace: [],
    });
    const deps = createDefaultTestDatabaseDeps(scenario.factory, clock);
    const admin = await deps.connectAdmin(generatedPlan.adminUrl);
    await admin.drop(generatedPlan.databaseName);
    await admin.close();
    expect(clock.delays).toEqual([100]);
    expect(scenario.trace).toEqual(["fence", "snapshot", "snapshot", "drop"]);
  });

  test("persistent blockers exhaust twenty complete cycles and leave a retryable target", async () => {
    const clock = retryClock();
    const scenario = activityFactory({
      snapshots: Array.from({ length: 20 }, () => [
        { pid: 96460, usename: "minime_engineer_ro", backend_type: null },
      ]),
    });
    const deps = createDefaultTestDatabaseDeps(scenario.factory, clock);
    const admin = await deps.connectAdmin(generatedPlan.adminUrl);
    await expect(admin.drop(generatedPlan.databaseName)).rejects.toThrow(
      "test_database_cleanup_failed",
    );
    await admin.close();
    expect(scenario.snapshotCount).toBe(20);
    expect(clock.delays).toHaveLength(19);
    expect(scenario.dropCount).toBe(0);
  });

  test("persistent blocker leaves the same branded handle retryable for a later safe disposal", async () => {
    const clock = retryClock();
    const snapshots: Array<Array<Record<string, unknown>>> = [
      ...Array.from({ length: 20 }, () => [
        { pid: 96460, usename: "minime_engineer_ro", backend_type: null },
      ]),
      [],
    ];
    let snapshotIndex = 0;
    let dropCount = 0;
    const factory = (url: string, _options: { max: number; onnotice: () => void }) => {
      const isTarget = url === generatedPlan.databaseUrl;
      const reserved = Object.assign(
        async (strings: TemplateStringsArray) => {
          const query = strings.join(" ");
          if (query.includes("select pid, usename, backend_type")) {
            return snapshots[Math.min(snapshotIndex++, snapshots.length - 1)] ?? [];
          }
          if (query.includes("select 1 from pg_database")) return [];
          if (query.includes("select count(*)::int as count")) return [{ count: 0 }];
          return [];
        },
        {
          unsafe: async (statement: string) => {
            if (statement.startsWith("drop database")) dropCount += 1;
            return [];
          },
          release: () => {},
        },
      );
      return Object.assign(
        async (strings: TemplateStringsArray) => {
          if (isTarget && strings.join(" ").includes("pg_extension")) {
            return [{ extname: "pgcrypto" }, { extname: "vector" }];
          }
          return [];
        },
        {
          unsafe: async () => [],
          end: async () => {},
          reserve: async () => reserved,
        },
      );
    };
    const deps = createDefaultTestDatabaseDeps(factory, clock);
    const handle = await provisionTestDatabase(generatedPlan, deps);
    await expect(disposeTestDatabase(handle, deps)).rejects.toThrow("test_database_cleanup_failed");
    expect(snapshotIndex).toBe(20);
    expect(dropCount).toBe(0);
    await disposeTestDatabase(handle, deps);
    expect(snapshotIndex).toBe(21);
    expect(dropCount).toBe(1);
  });

  test("PID changes never inherit eligibility across blocker cycles", async () => {
    const clock = retryClock();
    const scenario = activityFactory({
      snapshots: [
        [{ pid: 96460, usename: "minime_engineer_ro", backend_type: null }],
        [{ pid: 96462, usename: null, backend_type: null }],
        [{ pid: 96463, usename: "minime", backend_type: "client backend" }],
      ],
      termination: [{ pid: 96463, terminated: false }],
    });
    const deps = createDefaultTestDatabaseDeps(scenario.factory, clock);
    const admin = await deps.connectAdmin(generatedPlan.adminUrl);
    await admin.drop(generatedPlan.databaseName);
    await admin.close();
    expect(clock.delays).toEqual([100, 100]);
    expect(scenario.trace).toEqual([
      "fence",
      "snapshot",
      "snapshot",
      "snapshot",
      "terminate",
      "drop",
    ]);
  });

  test("snapshot errors stop immediately before any later cycle or destructive call", async () => {
    for (const snapshots of [
      [new Error("classification sql failure")],
      [
        [{ pid: 96460, usename: "minime_engineer_ro", backend_type: null }],
        new Error("classification protocol failure"),
      ],
      [
        [{ pid: 96460, usename: "minime_engineer_ro", backend_type: null }],
        [{ pid: null, usename: "minime", backend_type: "client backend" }],
      ],
    ]) {
      const clock = retryClock();
      const scenario = activityFactory({ snapshots });
      const deps = createDefaultTestDatabaseDeps(scenario.factory, clock);
      const admin = await deps.connectAdmin(generatedPlan.adminUrl);
      await expect(admin.drop(generatedPlan.databaseName)).rejects.toThrow(
        "test_database_cleanup_failed",
      );
      await admin.close();
      expect(clock.delays).toEqual(snapshots.length === 1 ? [] : [100]);
      expect(scenario.dropCount).toBe(0);
      expect(scenario.trace).not.toContain("terminate");
    }
  });

  test("background workers remain blockers until a fresh empty snapshot", async () => {
    for (const backendType of ["autovacuum worker", "parallel worker"]) {
      const clock = retryClock();
      const scenario = activityFactory({
        snapshots: [[{ pid: 96460, usename: "minime", backend_type: backendType }], []],
      });
      const deps = createDefaultTestDatabaseDeps(scenario.factory, clock);
      const admin = await deps.connectAdmin(generatedPlan.adminUrl);
      await admin.drop(generatedPlan.databaseName);
      await admin.close();
      expect(clock.delays).toEqual([100]);
      expect(scenario.trace).toEqual(["fence", "snapshot", "snapshot", "drop"]);
    }
  });

  test("known maintenance workers receive a separate bounded grace beyond client blockers", async () => {
    for (const row of [
      { pid: 96460, usename: "minime", backend_type: "autovacuum worker" },
      { pid: 96460, usename: null, backend_type: "autovacuum worker" },
      { pid: 96460, usename: "minime", backend_type: "parallel worker" },
    ]) {
      const clock = retryClock();
      const scenario = activityFactory({
        snapshots: [...Array.from({ length: 25 }, () => [row]), []],
      });
      const deps = createDefaultTestDatabaseDeps(scenario.factory, clock);
      const admin = await deps.connectAdmin(generatedPlan.adminUrl);
      await admin.drop(generatedPlan.databaseName);
      await admin.close();
      expect(scenario.snapshotCount).toBe(26);
      expect(clock.delays).toHaveLength(25);
      expect(scenario.trace.filter((event) => event === "drop")).toHaveLength(1);
      expect(scenario.trace).not.toContain("terminate");
    }
  });

  test("persistent maintenance is bounded without extending mixed or hidden activity", async () => {
    const backgroundClock = retryClock();
    const background = activityFactory({
      snapshots: Array.from({ length: 300 }, () => [
        { pid: 96460, usename: "minime", backend_type: "autovacuum worker" },
      ]),
    });
    const backgroundDeps = createDefaultTestDatabaseDeps(background.factory, backgroundClock);
    const backgroundAdmin = await backgroundDeps.connectAdmin(generatedPlan.adminUrl);
    await expect(backgroundAdmin.drop(generatedPlan.databaseName)).rejects.toThrow(
      "test_database_cleanup_failed",
    );
    await backgroundAdmin.close();
    expect(background.snapshotCount).toBe(300);
    expect(backgroundClock.delays).toHaveLength(299);
    expect(background.dropCount).toBe(0);

    const mixedClock = retryClock();
    const mixed = activityFactory({
      snapshots: Array.from({ length: 20 }, () => [
        { pid: 96460, usename: "minime", backend_type: "autovacuum worker" },
        { pid: 96461, usename: "minime_engineer_ro", backend_type: null },
      ]),
    });
    const mixedDeps = createDefaultTestDatabaseDeps(mixed.factory, mixedClock);
    const mixedAdmin = await mixedDeps.connectAdmin(generatedPlan.adminUrl);
    await expect(mixedAdmin.drop(generatedPlan.databaseName)).rejects.toThrow(
      "test_database_cleanup_failed",
    );
    await mixedAdmin.close();
    expect(mixed.snapshotCount).toBe(20);
    expect(mixedClock.delays).toHaveLength(19);
    expect(mixed.dropCount).toBe(0);
  });

  test("55006 consumes the current cycle and requires a fresh safe snapshot", async () => {
    const clock = retryClock();
    const busy = Object.assign(new Error("busy"), { code: "55006" });
    const scenario = activityFactory({ snapshots: [[], []], drops: [busy, undefined] });
    const deps = createDefaultTestDatabaseDeps(scenario.factory, clock);
    const admin = await deps.connectAdmin(generatedPlan.adminUrl);
    await admin.drop(generatedPlan.databaseName);
    await admin.close();
    expect(clock.delays).toEqual([100]);
    expect(scenario.snapshotCount).toBe(2);
    expect(scenario.dropCount).toBe(2);
  });

  test("persistent 55006 is bounded to twenty cycles without a trailing delay", async () => {
    const clock = retryClock();
    const busy = Object.assign(new Error("busy"), { code: "55006" });
    const scenario = activityFactory({
      snapshots: Array.from({ length: 20 }, () => []),
      drops: Array.from({ length: 20 }, () => busy),
    });
    const deps = createDefaultTestDatabaseDeps(scenario.factory, clock);
    const admin = await deps.connectAdmin(generatedPlan.adminUrl);
    await expect(admin.drop(generatedPlan.databaseName)).rejects.toThrow(
      "test_database_cleanup_failed",
    );
    await admin.close();
    expect(scenario.snapshotCount).toBe(20);
    expect(scenario.dropCount).toBe(20);
    expect(clock.delays).toHaveLength(19);
  });

  test("logical, custom, unknown, and mixed blockers require a later complete safe snapshot", async () => {
    const blockers = [
      { pid: 96460, usename: "minime", backend_type: "logical replication worker" },
      { pid: 96461, usename: "minime", backend_type: "custom worker" },
      { pid: 96462, usename: "minime", backend_type: "unknown worker" },
      [
        { pid: 96463, usename: "minime", backend_type: "client backend" },
        { pid: 96464, usename: "foreign", backend_type: "client backend" },
      ],
    ] as const;
    for (const blocker of blockers) {
      const clock = retryClock();
      const rows = (Array.isArray(blocker) ? blocker : [blocker]) as Array<Record<string, unknown>>;
      const scenario = activityFactory({ snapshots: [rows, []] });
      const deps = createDefaultTestDatabaseDeps(scenario.factory, clock);
      const admin = await deps.connectAdmin(generatedPlan.adminUrl);
      await admin.drop(generatedPlan.databaseName);
      await admin.close();
      expect(clock.delays).toEqual([100]);
      expect(scenario.trace).toEqual(["fence", "snapshot", "snapshot", "drop"]);
      expect(scenario.trace).not.toContain("terminate");
    }
  });

  test("duplicate PID and termination result integrity failures stop before delay or drop", async () => {
    const cases: Array<{
      snapshots: Array<Array<Record<string, unknown>> | Error>;
      termination?: Array<Record<string, unknown>> | Error;
    }> = [
      {
        snapshots: [
          [
            { pid: 96463, usename: "minime", backend_type: "client backend" },
            { pid: 96463, usename: "minime", backend_type: "client backend" },
          ],
        ],
      },
      {
        snapshots: [[{ pid: 96463, usename: "minime", backend_type: "client backend" }]],
        termination: new Error("terminate sql failure"),
      },
      {
        snapshots: [[{ pid: 96463, usename: "minime", backend_type: "client backend" }]],
        termination: [],
      },
      {
        snapshots: [[{ pid: 96463, usename: "minime", backend_type: "client backend" }]],
        termination: [
          { pid: 96463, terminated: false },
          { pid: 96463, terminated: false },
        ],
      },
      {
        snapshots: [[{ pid: 96463, usename: "minime", backend_type: "client backend" }]],
        termination: [{ pid: 96464, terminated: false }],
      },
      {
        snapshots: [[{ pid: 96463, usename: "minime", backend_type: "client backend" }]],
        termination: [{ pid: 96463, terminated: "false" }],
      },
    ];
    for (const testCase of cases) {
      const clock = retryClock();
      const scenario = activityFactory({ ...testCase });
      const deps = createDefaultTestDatabaseDeps(scenario.factory, clock);
      const admin = await deps.connectAdmin(generatedPlan.adminUrl);
      await expect(admin.drop(generatedPlan.databaseName)).rejects.toThrow(
        "test_database_cleanup_failed",
      );
      await admin.close();
      expect(clock.delays).toEqual([]);
      expect(scenario.dropCount).toBe(0);
    }
  });

  test("clock rejection fails fixed after a blocker or 55006 without another cycle", async () => {
    const blockerClock = retryClock({ reject: new Error("clock blocker secret") });
    const blockerScenario = activityFactory({
      snapshots: [[{ pid: 96460, usename: "foreign", backend_type: "client backend" }]],
    });
    const blockerDeps = createDefaultTestDatabaseDeps(blockerScenario.factory, blockerClock);
    const blockerAdmin = await blockerDeps.connectAdmin(generatedPlan.adminUrl);
    await expect(blockerAdmin.drop(generatedPlan.databaseName)).rejects.toThrow(
      "test_database_cleanup_failed",
    );
    await blockerAdmin.close();
    expect(blockerScenario.snapshotCount).toBe(1);
    expect(blockerScenario.dropCount).toBe(0);

    const busy = Object.assign(new Error("busy"), { code: "55006" });
    const busyClock = retryClock({ reject: new Error("clock busy secret") });
    const busyScenario = activityFactory({ snapshots: [[]], drops: [busy] });
    const busyDeps = createDefaultTestDatabaseDeps(busyScenario.factory, busyClock);
    const busyAdmin = await busyDeps.connectAdmin(generatedPlan.adminUrl);
    await expect(busyAdmin.drop(generatedPlan.databaseName)).rejects.toThrow(
      "test_database_cleanup_failed",
    );
    await busyAdmin.close();
    expect(busyScenario.snapshotCount).toBe(1);
    expect(busyScenario.dropCount).toBe(1);
  });

  test("non-55006 ordinary drop failure is terminal after one safe cycle", async () => {
    const clock = retryClock();
    const scenario = activityFactory({
      snapshots: [[]],
      drops: [new Error("ordinary drop secret")],
    });
    const deps = createDefaultTestDatabaseDeps(scenario.factory, clock);
    const admin = await deps.connectAdmin(generatedPlan.adminUrl);
    await expect(admin.drop(generatedPlan.databaseName)).rejects.toThrow(
      "test_database_cleanup_failed",
    );
    await admin.close();
    expect(scenario.snapshotCount).toBe(1);
    expect(scenario.dropCount).toBe(1);
    expect(clock.delays).toEqual([]);
  });

  test("old all-activity polling is replaced by an authoritative ordinary drop", async () => {
    let dropAttempts = 0;
    const deps = createDefaultTestDatabaseDeps((_url, _options) => {
      const reserved = Object.assign(
        async (strings: TemplateStringsArray) => {
          const query = strings.join(" ");
          if (query.includes("select pid, usename, backend_type")) {
            return [{ pid: 4242, usename: "minime", backend_type: "client backend" }];
          }
          if (query.includes("pg_terminate_backend")) {
            return [{ pid: 4242, terminated: false }];
          }
          if (query.includes("select count(*)::int as count")) return [{ count: 1 }];
          return [];
        },
        {
          unsafe: async (statement: string) => {
            if (statement.startsWith("drop database")) dropAttempts += 1;
            if (statement.includes("pg_terminate_backend")) {
              return [{ pid: 4242, terminated: false }];
            }
            return [];
          },
          release: () => {},
        },
      );
      return Object.assign(async () => [], {
        unsafe: async () => [],
        end: async () => {},
        reserve: async () => reserved,
      });
    });

    const admin = await deps.connectAdmin(generatedPlan.adminUrl);
    await admin.terminate(generatedPlan.databaseName);
    await admin.drop(generatedPlan.databaseName);
    await admin.close();
    expect(dropAttempts).toBe(1);
  });

  test("fences, classifies, terminates eligible clients, and ordinarily drops in exact order", async () => {
    const trace: string[] = [];
    const deps = createDefaultTestDatabaseDeps((_url, _options) => {
      const reserved = Object.assign(
        async (strings: TemplateStringsArray) => {
          const query = strings.join(" ");
          if (query.includes("select pid, usename, backend_type")) {
            trace.push("classify");
            return [{ pid: 4242, usename: "minime", backend_type: "client backend" }];
          }
          return [];
        },
        {
          unsafe: async (statement: string) => {
            if (statement.startsWith("alter database")) trace.push("fence");
            else if (statement.includes("pg_terminate_backend")) {
              trace.push("terminate");
              return [{ pid: 4242, terminated: false }];
            } else if (statement.startsWith("drop database")) trace.push("ordinary drop");
            return [];
          },
          release: () => {},
        },
      );
      return Object.assign(async () => [], {
        unsafe: async () => [],
        end: async () => {},
        reserve: async () => reserved,
      });
    });
    const admin = await deps.connectAdmin(generatedPlan.adminUrl);
    await admin.drop(generatedPlan.databaseName);
    await admin.close();
    expect(trace).toEqual(["fence", "classify", "terminate", "ordinary drop"]);
  });

  test("known background workers remain blockers without explicit termination", async () => {
    for (const backendType of ["autovacuum worker", "parallel worker"]) {
      let ordinaryDrops = 0;
      let terminationCalls = 0;
      let classificationCalls = 0;
      const deps = createDefaultTestDatabaseDeps((_url, _options) => {
        const reserved = Object.assign(
          async (strings: TemplateStringsArray) => {
            const query = strings.join(" ");
            if (query.includes("select pid, usename, backend_type")) {
              classificationCalls += 1;
              return [{ pid: 4242, usename: "minime", backend_type: backendType }];
            }
            return [];
          },
          {
            unsafe: async (statement: string) => {
              if (statement.includes("pg_terminate_backend")) terminationCalls += 1;
              if (statement.startsWith("drop database")) ordinaryDrops += 1;
              return [];
            },
            release: () => {},
          },
        );
        return Object.assign(async () => [], {
          unsafe: async () => [],
          end: async () => {},
          reserve: async () => reserved,
        });
      }, retryClock());
      const admin = await deps.connectAdmin(generatedPlan.adminUrl);
      await expect(admin.drop(generatedPlan.databaseName)).rejects.toThrow(
        "test_database_cleanup_failed",
      );
      await admin.close();
      expect(classificationCalls).toBe(300);
      expect(terminationCalls).toBe(0);
      expect(ordinaryDrops).toBe(0);
    }
  });

  test("classification and termination integrity failures fail closed before ordinary drop", async () => {
    const cases: Array<{
      rows: Array<Record<string, unknown>>;
      terminationRows?: Array<Record<string, unknown>>;
    }> = [
      { rows: [{ pid: null, usename: "minime", backend_type: "client backend" }] },
      { rows: [{ pid: 4242, usename: "minime", backend_type: "logical replication worker" }] },
      { rows: [{ pid: 4242, usename: "minime", backend_type: "client backend", query: "hidden" }] },
      {
        rows: [{ pid: 4242, usename: "minime", backend_type: "client backend" }],
        terminationRows: [{ pid: 9999, terminated: false }],
      },
      {
        rows: [{ pid: 4242, usename: "minime", backend_type: "client backend" }],
        terminationRows: [{ pid: 4242, terminated: "false" }],
      },
    ];
    for (const testCase of cases) {
      let ordinaryDrops = 0;
      let terminationCalls = 0;
      const deps = createDefaultTestDatabaseDeps((_url, _options) => {
        const reserved = Object.assign(
          async (strings: TemplateStringsArray) => {
            const query = strings.join(" ");
            if (query.includes("select pid, usename, backend_type")) return testCase.rows;
            return [];
          },
          {
            unsafe: async (statement: string) => {
              if (statement.includes("pg_terminate_backend")) {
                terminationCalls += 1;
                return testCase.terminationRows ?? [];
              }
              if (statement.startsWith("drop database")) ordinaryDrops += 1;
              return [];
            },
            release: () => {},
          },
        );
        return Object.assign(async () => [], {
          unsafe: async () => [],
          end: async () => {},
          reserve: async () => reserved,
        });
      }, retryClock());
      const admin = await deps.connectAdmin(generatedPlan.adminUrl);
      await expect(admin.drop(generatedPlan.databaseName)).rejects.toThrow(
        "test_database_cleanup_failed",
      );
      await admin.close();
      expect(terminationCalls).toBe(testCase.terminationRows ? 1 : 0);
      expect(ordinaryDrops).toBe(0);
    }
  });

  test("classification SQL/protocol failure is fixed and ordinary drop is unreachable", async () => {
    let ordinaryDrops = 0;
    const deps = createDefaultTestDatabaseDeps((_url, _options) => {
      const reserved = Object.assign(
        async (strings: TemplateStringsArray) => {
          if (strings.join(" ").includes("select pid, usename, backend_type")) {
            throw new Error("server text must not escape");
          }
          return [];
        },
        {
          unsafe: async (statement: string) => {
            if (statement.startsWith("drop database")) ordinaryDrops += 1;
            return [];
          },
          release: () => {},
        },
      );
      return Object.assign(async () => [], {
        unsafe: async () => [],
        end: async () => {},
        reserve: async () => reserved,
      });
    });
    const admin = await deps.connectAdmin(generatedPlan.adminUrl);
    await expect(admin.drop(generatedPlan.databaseName)).rejects.toThrow(
      "test_database_cleanup_failed",
    );
    await admin.close();
    expect(ordinaryDrops).toBe(0);
  });

  test("adapter has no force-drop SQL path", async () => {
    const source = await Bun.file(new URL("./support/test-database.ts", import.meta.url)).text();
    expect(source).not.toMatch(/drop\s+database[^\n]*with\s*\(force\)/i);
  });

  test("injected default adapter maps each clone SQLSTATE once without leaking server text", async () => {
    const errors = [
      [sqlStateError("55006"), "test_database_template_busy"],
      [sqlStateError("42P04"), "test_database_collision"],
      [new Error("raw server text"), "test_database_clone_failed"],
    ] as const;
    for (const [cloneError, expected] of errors) {
      const unsafeStatements: string[] = [];
      const optionsSeen: Array<{ max?: number }> = [];
      const deps = createDefaultTestDatabaseDeps((url, options) => {
        optionsSeen.push(options);
        let released = 0;
        const reserved = Object.assign(async () => [], {
          unsafe: async (statement: string) => {
            unsafeStatements.push(statement);
            if (statement.startsWith("create database")) throw cloneError;
            return [];
          },
          release: () => {
            released += 1;
          },
        });
        const sql = Object.assign(
          async () => {
            throw new Error("pool-level query used");
          },
          {
            unsafe: async () => {
              throw new Error("pool-level unsafe used");
            },
            end: async () => {},
            reserve: async () => reserved,
          },
        );
        void url;
        void released;
        return sql;
      });
      const admin = await deps.connectAdmin(generatedPlan.adminUrl);
      await expect(admin.cloneFromInstallerTemplate(generatedPlan.databaseName)).rejects.toThrow(
        expected,
      );
      await admin.close();
      expect(optionsSeen[0]?.max).toBe(1);
      expect(unsafeStatements[0]).toBe(
        `create database "${generatedPlan.databaseName}" with owner = minime template = minime_test`,
      );
      expect(unsafeStatements[0]).not.toContain("raw server text");
    }
  });

  test("injected default adapter reserves one admin connection for the exact advisory key pair", async () => {
    let lockTemplate = "";
    let lockValues: unknown[] = [];
    const deps = createDefaultTestDatabaseDeps((_url, _options) => {
      const reserved = Object.assign(
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
          lockTemplate = strings.join("?");
          lockValues = values;
          return [];
        },
        {
          unsafe: async () => [],
          release: () => {},
        },
      );
      const sql = Object.assign(
        async () => {
          throw new Error("pool-level query used");
        },
        {
          unsafe: async () => {
            throw new Error("pool-level unsafe used");
          },
          end: async () => {},
          reserve: async () => reserved,
        },
      );
      return sql;
    });
    const admin = await deps.connectAdmin(generatedPlan.adminUrl);
    await admin.acquireTemplateCloneLock();
    expect(lockTemplate).toContain("pg_advisory_lock");
    expect(lockValues).toEqual([1296649801, 1413829460]);
    await admin.close();
  });

  test("routes every admin operation through one reserved client and closes it once", async () => {
    const reservedCalls: string[] = [];
    let releases = 0;
    let poolEnds = 0;
    let activityChecks = 0;
    const deps = createDefaultTestDatabaseDeps((_url, _options) => {
      const reserved = Object.assign(
        async (strings: TemplateStringsArray) => {
          const query = strings.join(" ");
          reservedCalls.push(query);
          if (query.includes("select pid, usename, backend_type")) {
            activityChecks += 1;
            return [{ pid: 4242, usename: "minime", backend_type: "client backend" }];
          }
          return [];
        },
        {
          unsafe: async (statement: string) => {
            reservedCalls.push(statement);
            if (statement.includes("pg_terminate_backend")) {
              return [{ pid: 4242, terminated: false }];
            }
            return [];
          },
          release: () => {
            releases += 1;
          },
        },
      );
      return Object.assign(
        async () => {
          throw new Error("pool-level query used");
        },
        {
          unsafe: async () => {
            throw new Error("pool-level unsafe used");
          },
          end: async () => {
            poolEnds += 1;
          },
          reserve: async () => reserved,
        },
      );
    });

    const admin = await deps.connectAdmin(generatedPlan.adminUrl);
    await admin.acquireTemplateCloneLock();
    expect(await admin.exists(generatedPlan.databaseName)).toBe(false);
    await admin.assertInstallerTemplateIdle();
    await admin.cloneFromInstallerTemplate(generatedPlan.databaseName);
    await admin.terminate(generatedPlan.databaseName);
    await admin.drop(generatedPlan.databaseName);
    await admin.close();
    await admin.close();

    expect(reservedCalls.some((query) => query.includes("pg_advisory_lock"))).toBe(true);
    expect(reservedCalls.some((query) => query.includes("pg_database"))).toBe(true);
    expect(reservedCalls.some((query) => query.includes("select pid, usename, backend_type"))).toBe(
      true,
    );
    expect(reservedCalls.some((query) => query.startsWith("create database"))).toBe(true);
    expect(reservedCalls.some((query) => query.includes("pg_terminate_backend"))).toBe(true);
    expect(reservedCalls.some((query) => query.startsWith("drop database"))).toBe(true);
    expect(releases).toBe(1);
    expect(poolEnds).toBe(1);
  });

  test("default adapter terminates only current-role client backends", async () => {
    const reservedQueries: string[] = [];
    let activityChecks = 0;
    const deps = createDefaultTestDatabaseDeps((_url, _options) => {
      const reserved = Object.assign(
        async (strings: TemplateStringsArray) => {
          const query = strings.join(" ");
          reservedQueries.push(query);
          if (query.includes("select pid, usename, backend_type")) {
            activityChecks += 1;
            return activityChecks === 1
              ? [{ pid: 4242, usename: "minime", backend_type: "client backend" }]
              : [];
          }
          return [];
        },
        {
          unsafe: async (statement: string) => {
            reservedQueries.push(statement);
            if (statement.includes("pg_terminate_backend")) {
              return [{ pid: 4242, terminated: false }];
            }
            return [];
          },
          release: () => {},
        },
      );
      return Object.assign(async () => [], {
        unsafe: async () => [],
        end: async () => {},
        reserve: async () => reserved,
      });
    });

    const admin = await deps.connectAdmin(generatedPlan.adminUrl);
    await admin.terminate(generatedPlan.databaseName);
    await admin.close();

    expect(activityChecks).toBe(1);
    const terminateQuery = reservedQueries.find((query) => query.includes("pg_terminate_backend"));
    expect(terminateQuery).toContain("usename = current_user");
    expect(terminateQuery).toContain("backend_type = 'client backend'");
  });

  test("default adapter fails fixed when ineligible target activity never clears", async () => {
    const reservedQueries: string[] = [];
    let activityChecks = 0;
    let fences = 0;
    let ordinaryDrops = 0;
    const clock = retryClock();
    const deps = createDefaultTestDatabaseDeps((_url, _options) => {
      const reserved = Object.assign(
        async (strings: TemplateStringsArray) => {
          const query = strings.join(" ");
          reservedQueries.push(query);
          if (query.includes("select pid, usename, backend_type")) {
            activityChecks += 1;
            return [{ pid: 4242, usename: "foreign_role", backend_type: "client backend" }];
          }
          return [];
        },
        {
          unsafe: async (statement: string) => {
            reservedQueries.push(statement);
            if (statement.startsWith("alter database")) fences += 1;
            if (statement.startsWith("drop database")) ordinaryDrops += 1;
            return [];
          },
          release: () => {},
        },
      );
      return Object.assign(async () => [], {
        unsafe: async () => [],
        end: async () => {},
        reserve: async () => reserved,
      });
    }, clock);

    const admin = await deps.connectAdmin(generatedPlan.adminUrl);
    await expect(admin.drop(generatedPlan.databaseName)).rejects.toThrow(
      "test_database_cleanup_failed",
    );
    await admin.close();
    expect(activityChecks).toBe(20);
    expect(fences).toBe(1);
    expect(ordinaryDrops).toBe(0);
    expect(reservedQueries.some((query) => query.includes("pg_terminate_backend"))).toBe(false);
  });

  test("default adapter retries a zero-to-drop busy race and maps a persistent race", async () => {
    let dropAttempts = 0;
    let activityChecks = 0;
    const deps = createDefaultTestDatabaseDeps((_url, _options) => {
      const reserved = Object.assign(
        async (strings: TemplateStringsArray) => {
          const query = strings.join(" ");
          if (query.includes("select pid, usename, backend_type")) {
            activityChecks += 1;
            return [];
          }
          return [];
        },
        {
          unsafe: async (statement: string) => {
            if (statement.startsWith("drop database")) {
              dropAttempts += 1;
              if (dropAttempts === 1) throw Object.assign(new Error("busy"), { code: "55006" });
            }
            return [];
          },
          release: () => {},
        },
      );
      return Object.assign(async () => [], {
        unsafe: async () => [],
        end: async () => {},
        reserve: async () => reserved,
      });
    }, retryClock());

    const admin = await deps.connectAdmin(generatedPlan.adminUrl);
    await admin.drop(generatedPlan.databaseName);
    await admin.close();
    expect(dropAttempts).toBe(2);
    expect(activityChecks).toBe(2);

    dropAttempts = 0;
    let failingActivityChecks = 0;
    const failingDeps = createDefaultTestDatabaseDeps((_url, _options) => {
      const reserved = Object.assign(
        async (strings: TemplateStringsArray) => {
          const query = strings.join(" ");
          if (query.includes("select pid, usename, backend_type")) {
            failingActivityChecks += 1;
            return [];
          }
          return [];
        },
        {
          unsafe: async (statement: string) => {
            if (statement.startsWith("drop database")) {
              dropAttempts += 1;
              throw Object.assign(new Error("busy"), { code: "55006" });
            }
            return [];
          },
          release: () => {},
        },
      );
      return Object.assign(async () => [], {
        unsafe: async () => [],
        end: async () => {},
        reserve: async () => reserved,
      });
    }, retryClock());
    const failingAdmin = await failingDeps.connectAdmin(generatedPlan.adminUrl);
    await expect(failingAdmin.drop(generatedPlan.databaseName)).rejects.toThrow(
      "test_database_cleanup_failed",
    );
    await failingAdmin.close();
    expect(dropAttempts).toBe(20);
    expect(failingActivityChecks).toBe(20);
  });

  test("reserve failure ends the pool and never returns an admin capability", async () => {
    let poolEnds = 0;
    const deps = createDefaultTestDatabaseDeps((_url, _options) =>
      Object.assign(async () => [], {
        unsafe: async () => [],
        end: async () => {
          poolEnds += 1;
        },
        reserve: async () => {
          throw new Error("reserve failed");
        },
      }),
    );

    await expect(deps.connectAdmin(generatedPlan.adminUrl)).rejects.toThrow("reserve failed");
    expect(poolEnds).toBe(1);
  });

  test("malformed encoded admin usernames fail before pool reservation", async () => {
    let factoryCalls = 0;
    let reserveCalls = 0;
    let poolEnds = 0;
    const deps = createDefaultTestDatabaseDeps((_url, _options) => {
      factoryCalls += 1;
      const reserved = Object.assign(async () => [], {
        unsafe: async () => [],
        release: () => {},
      });
      return Object.assign(async () => [], {
        unsafe: async () => [],
        reserve: async () => {
          reserveCalls += 1;
          return reserved;
        },
        end: async () => {
          poolEnds += 1;
        },
      });
    });

    await expect(
      deps.connectAdmin("postgres://minime%ZZ:minime@localhost:5432/postgres"),
    ).rejects.toThrow("test_database_invalid");
    expect(factoryCalls).toBe(0);
    expect(reserveCalls).toBe(0);
    expect(poolEnds).toBe(0);
  });

  test("injected adapter closes target connection before fixed extension failure", async () => {
    let targetUrl = "";
    let targetClosed = 0;
    const deps = createDefaultTestDatabaseDeps((url) => {
      const isTarget = url === generatedPlan.databaseUrl;
      if (isTarget) targetUrl = url;
      const reserved = Object.assign(async () => [], {
        unsafe: async () => [],
        release: () => {},
      });
      const sql = Object.assign(async () => (isTarget ? [] : []), {
        unsafe: async () => [],
        end: async () => {
          if (isTarget) targetClosed += 1;
        },
        reserve: async () => reserved,
      });
      return sql;
    });
    const admin = await deps.connectAdmin(generatedPlan.adminUrl);
    await expect(admin.assertExtensionsPresent(generatedPlan.databaseUrl)).rejects.toThrow(
      "test_database_extensions_missing",
    );
    expect(targetUrl).toBe(generatedPlan.databaseUrl);
    expect(targetClosed).toBe(1);
  });

  test("keeps the ownership capability narrow and create path source-private", async () => {
    const source = await Bun.file(new URL("./support/test-database.ts", import.meta.url)).text();
    const adminInterface =
      source.match(/export interface TestDatabaseAdmin[\s\S]*?\n}/)?.[0] ?? source;
    expect(adminInterface).not.toMatch(/template\s*[:?]/i);
    expect(source).toContain('const INSTALLER_TEMPLATE = "minime_test"');
    expect(source).not.toMatch(/CREATE\s+EXTENSION/i);
    expect(source).toMatch(/ALTER\s+DATABASE/i);
    expect(source).not.toMatch(/datistemplate/i);
    expect(source).not.toMatch(/process\.env[^\n]*template/i);
    expect(source).not.toMatch(/pg_terminate_backend[^\n]*minime_test/i);
    expect(source).toContain("1296649801");
    expect(source).toContain("1413829460");
    expect(source).toContain("factory(adminUrl, { max: 1");
    expect(source).toContain('create database "${databaseName}"');
    expect(source).toContain("generatedName(databaseName)");
    expect(source).toContain("reserved.unsafe(");
  });

  test("keeps fixed SQLSTATE failure mappings content-free", async () => {
    const source = await Bun.file(new URL("./support/test-database.ts", import.meta.url)).text();
    expect(source).toContain('code === "55006"');
    expect(source).toContain('code === "42P04"');
    expect(source).toContain("test_database_template_busy");
    expect(source).toContain("test_database_collision");
    expect(source).toContain("test_database_clone_failed");
  });
});

describe("owned child wrapper contract", () => {
  async function injectedBootstrap(
    trace: string[],
    plan: ReturnType<typeof planTestDatabase>,
    options: { migrateError?: Error; closeError?: Error } = {},
  ): Promise<void> {
    expect(process.env.DATABASE_URL).toBe(plan.databaseUrl);
    trace.push("set:DATABASE_URL");
    let migrateFailure: unknown;
    try {
      trace.push(options.migrateError ? "bootstrap:migrate:test:fail" : "bootstrap:migrate:test");
      if (options.migrateError) throw options.migrateError;
    } catch (error) {
      migrateFailure = error;
    }
    trace.push("bootstrap:closeDb");
    if (options.closeError) throw options.closeError;
    if (migrateFailure) throw migrateFailure;
  }

  test("parses only the approved labels, aliases, and command grammar", async () => {
    const { parseOwnedCommandArgs, OWNED_DATABASE_ENV_NAMES } = await ownedWrapper();
    expect(OWNED_DATABASE_ENV_NAMES).toEqual([
      "EVAL_DATABASE_URL",
      "EVAL_PMB_DATABASE_URL",
      "EVAL_SKILLS_DATABASE_URL",
    ]);
    expect(
      parseOwnedCommandArgs([
        "--label",
        "eval_skills",
        "--database-env",
        "EVAL_SKILLS_DATABASE_URL",
        "--",
        "bun",
        "run",
        "scripts/eval-skills.ts",
        "--round",
        "r1",
      ]),
    ).toEqual({
      label: "eval_skills",
      databaseEnv: "EVAL_SKILLS_DATABASE_URL",
      argv: ["bun", "run", "scripts/eval-skills.ts", "--round", "r1"],
    });
    expect(
      parseOwnedCommandArgs([
        "--label",
        "eval_skill_optimize",
        "--database-env",
        "EVAL_SKILLS_DATABASE_URL",
        "--",
        "bun",
        "run",
        "scripts/optimize-skill.ts",
        "--suite",
        "query",
      ]).label,
    ).toBe("eval_skill_optimize");
    expect(
      parseOwnedCommandArgs(["--label", "eval_skills", "--", "bun", "run", "child.ts"]).databaseEnv,
    ).toBeUndefined();
    for (const bad of [
      ["--label", "eval-skills", "--", "bun", "run", "child.ts"],
      ["--label", "eval_skills", "--database-env", "DATABASE_URL", "--", "bun"],
      ["--label", "eval_skills", "--label", "eval_skills", "--", "bun"],
      ["--label", "eval_skills", "--"],
    ]) {
      expect(() => parseOwnedCommandArgs(bad)).toThrow("owned_database_args_invalid");
    }
  });

  test("proves the owned bootstrap, close, child, and disposal order", async () => {
    const { runWithOwnedTestDatabase } = await ownedWrapper();
    const trace: string[] = [];
    const plan = planTestDatabase(base, "321_aaaaaaaaaaaa");
    const handle = { plan, createdByThisProcess: true } as never;
    const command = {
      label: "eval_skills",
      databaseEnv: "EVAL_SKILLS_DATABASE_URL",
      argv: ["bun", "run", "child.ts"],
    } as const;
    const result = await runWithOwnedTestDatabase(command, {
      provision: async (received) => {
        trace.push("plan", "provision");
        expect(received.mode).toBe("create");
        return handle;
      },
      dispose: async (received) => {
        trace.push("dispose");
        expect(received).toBe(handle);
      },
      bootstrapOwnedDatabase: () => injectedBootstrap(trace, plan),
      spawn: async (argv, env) => {
        trace.push("spawn");
        expect(argv).toEqual(command.argv);
        expect(env.DATABASE_URL).toMatch(/^postgres:\/\//);
        expect(env.DATABASE_URL).toBe(env.EVAL_SKILLS_DATABASE_URL);
        expect(env.DATABASE_URL).toBe(plan.databaseUrl);
        expect(env.MINIME_APP_DATABASE_URL).toBe(plan.databaseUrl);
        await Promise.resolve();
        trace.push("child:0");
        return 0;
      },
    });
    expect(result).toBe(0);
    expect(trace).toEqual([
      "plan",
      "provision",
      "set:DATABASE_URL",
      "bootstrap:migrate:test",
      "bootstrap:closeDb",
      "spawn",
      "child:0",
      "dispose",
    ]);
  });

  test("bootstrap failure closes before disposal and never spawns", async () => {
    const { runWithOwnedTestDatabase } = await ownedWrapper();
    const plan = planTestDatabase(base, "322_bbbbbbbbbbbb");
    const handle = { plan, createdByThisProcess: true } as never;
    const trace: string[] = ["plan"];
    await expect(
      runWithOwnedTestDatabase(
        {
          label: "verify_m0",
          argv: ["bun", "run", "src/verify/m0.ts"],
        },
        {
          provision: async () => {
            trace.push("provision");
            return handle;
          },
          dispose: async () => {
            trace.push("dispose");
          },
          bootstrapOwnedDatabase: () =>
            injectedBootstrap(trace, plan, { migrateError: new Error("bootstrap failed") }),
          spawn: async () => {
            trace.push("spawn");
            return 0;
          },
        },
      ),
    ).rejects.toThrow("bootstrap failed");
    expect(trace).toEqual([
      "plan",
      "provision",
      "set:DATABASE_URL",
      "bootstrap:migrate:test:fail",
      "bootstrap:closeDb",
      "dispose",
    ]);
    expect(trace).not.toContain("spawn");
  });

  test("close failure still disposes once and remains the primary error", async () => {
    const { runWithOwnedTestDatabase } = await ownedWrapper();
    const plan = planTestDatabase(base, "323_cccccccccccc");
    const handle = { plan, createdByThisProcess: true } as never;
    const trace: string[] = ["plan"];
    await expect(
      runWithOwnedTestDatabase(
        { label: "verify_m0", argv: ["bun", "run", "src/verify/m0.ts"] },
        {
          provision: async () => {
            trace.push("provision");
            return handle;
          },
          dispose: async () => {
            trace.push("dispose");
          },
          bootstrapOwnedDatabase: () =>
            injectedBootstrap(trace, plan, { closeError: new Error("close failed") }),
          spawn: async () => {
            trace.push("spawn");
            return 0;
          },
        },
      ),
    ).rejects.toThrow("close failed");
    expect(trace).toEqual([
      "plan",
      "provision",
      "set:DATABASE_URL",
      "bootstrap:migrate:test",
      "bootstrap:closeDb",
      "dispose",
    ]);
    expect(trace.filter((item) => item === "dispose")).toHaveLength(1);
    expect(trace).not.toContain("spawn");
  });

  test("close plus disposal failure has fixed cleanup precedence and no spawn", async () => {
    const { runWithOwnedTestDatabase } = await ownedWrapper();
    const plan = planTestDatabase(base, "324_dddddddddddd");
    const handle = { plan, createdByThisProcess: true } as never;
    const trace: string[] = ["plan"];
    await expect(
      runWithOwnedTestDatabase(
        { label: "verify_m0", argv: ["bun", "run", "src/verify/m0.ts"] },
        {
          provision: async () => {
            trace.push("provision");
            return handle;
          },
          dispose: async () => {
            trace.push("dispose");
            throw new Error("dispose failed");
          },
          bootstrapOwnedDatabase: () =>
            injectedBootstrap(trace, plan, { closeError: new Error("close failed") }),
          spawn: async () => {
            trace.push("spawn");
            return 0;
          },
        },
      ),
    ).rejects.toThrow("test_database_cleanup_failed");
    expect(trace).toEqual([
      "plan",
      "provision",
      "set:DATABASE_URL",
      "bootstrap:migrate:test",
      "bootstrap:closeDb",
      "dispose",
    ]);
    expect(trace.filter((item) => item === "dispose")).toHaveLength(1);
    expect(trace).not.toContain("spawn");
  });

  test("restores parent-owned environment after success and every wrapper failure", async () => {
    const { runWithOwnedTestDatabase } = await ownedWrapper();
    const envNames = [
      "DATABASE_URL",
      "EVAL_DATABASE_URL",
      "EVAL_PMB_DATABASE_URL",
      "EVAL_SKILLS_DATABASE_URL",
      "MINIME_TEST_DATABASE_URL",
    ] as const;
    const original = Object.fromEntries(
      envNames.map((name) => [name, process.env[name]]),
    ) as Record<(typeof envNames)[number], string | undefined>;
    const parentEnv = {
      DATABASE_URL: "postgres://parent:parent@localhost:5432/minime",
      EVAL_DATABASE_URL: "postgres://parent:parent@localhost:5432/minime_test_parent_eval",
      EVAL_PMB_DATABASE_URL: "postgres://parent:parent@localhost:5432/minime_test_parent_pmb",
      EVAL_SKILLS_DATABASE_URL: "postgres://parent:parent@localhost:5432/minime_test_parent_skills",
    };
    const plan = planTestDatabase(base, "323_cccccccccccc");
    const handle = { plan, createdByThisProcess: true } as never;

    try {
      for (const phase of ["success", "child", "bootstrap", "spawn", "dispose"] as const) {
        for (const name of envNames) {
          if (name === "MINIME_TEST_DATABASE_URL") Reflect.deleteProperty(process.env, name);
          else process.env[name] = parentEnv[name as keyof typeof parentEnv];
        }
        const trace: string[] = [];
        const outcome = runWithOwnedTestDatabase(
          {
            label: "eval_skills",
            databaseEnv: "EVAL_SKILLS_DATABASE_URL",
            argv: ["bun", "run", "child.ts"],
          },
          {
            provision: async () => handle,
            dispose: async () => {
              trace.push("dispose");
              if (phase === "dispose") throw new Error("dispose failed");
            },
            bootstrapOwnedDatabase: async () => {
              trace.push("bootstrap");
              if (phase === "bootstrap") throw new Error("bootstrap failed");
            },
            spawn: async () => {
              trace.push("spawn");
              if (phase === "spawn") throw new Error("spawn failed");
              return phase === "child" ? 7 : 0;
            },
          },
        );
        if (phase === "success" || phase === "child") {
          await expect(outcome).resolves.toBe(phase === "child" ? 7 : 0);
        } else {
          await expect(outcome).rejects.toThrow(
            phase === "dispose" ? "test_database_cleanup_failed" : `${phase} failed`,
          );
        }
        for (const name of envNames) {
          expect(process.env[name]).toBe(
            name === "MINIME_TEST_DATABASE_URL" ? undefined : parentEnv[name],
          );
        }
      }
    } finally {
      for (const name of envNames) {
        if (original[name] === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = original[name];
      }
    }
  });

  test("rejects inherited external test database before planning or provisioning", async () => {
    const { runWithOwnedTestDatabase } = await ownedWrapper();
    const previous = process.env.MINIME_TEST_DATABASE_URL;
    process.env.MINIME_TEST_DATABASE_URL = explicitScratch;
    let provisioned = false;
    try {
      await expect(
        runWithOwnedTestDatabase(
          { label: "verify_m0", argv: ["bun", "run", "src/verify/m0.ts"] },
          {
            provision: async () => {
              provisioned = true;
              throw new Error("must not provision");
            },
            dispose: async () => {},
            bootstrapOwnedDatabase: async () => {},
            spawn: async () => 0,
          },
        ),
      ).rejects.toThrow("owned_database_external_forbidden");
      expect(provisioned).toBe(false);
      expect(process.env.MINIME_TEST_DATABASE_URL).toBe(explicitScratch);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "MINIME_TEST_DATABASE_URL");
      else process.env.MINIME_TEST_DATABASE_URL = previous;
    }
  });

  test("wrapper source dynamically imports application code only after assigning the owned URL", () => {
    const source = readFileSync(resolve(repoRoot, "scripts/with-test-database.ts"), "utf8");
    expect(source).not.toMatch(/from ['"]\.\.\/src\//);
    expect(source.indexOf("process.env.DATABASE_URL")).toBeLessThan(
      source.indexOf('import("../src/db/migrate")'),
    );
    expect(source).toContain('migrate({ kind: "test" })');
    expect(source).toContain("closeDb()");
  });
});

describe("setup cleanup contract", () => {
  test("preload scrubs installed lifecycle state before importing application config", () => {
    const source = readFileSync(resolve(repoRoot, "test/setup.ts"), "utf8");
    const applicationImport = 'import("../src/db/migrate")';

    for (const name of [
      "MINIME_APP_DATABASE_URL",
      "MINIME_APP_PASSWORD",
      "MINIME_PG_BACKEND",
      "MINIME_PG_PORT",
      "MINIME_PG_INSTALL_PENDING",
      "BACKUP_CRON",
    ]) {
      expect(source).toContain(`"${name}"`);
      expect(source.indexOf(`"${name}"`)).toBeLessThan(source.indexOf(applicationImport));
    }
  });

  test("identical closer registrations remain distinct and independently removable", async () => {
    const { createTestDatabaseCloserRegistry } = await import("./setup");
    const registry = createTestDatabaseCloserRegistry();
    let calls = 0;
    const closer = async () => {
      calls += 1;
    };
    const unregisterFirst = registry.register(closer);
    registry.register(closer);
    unregisterFirst();
    await registry.drain();
    expect(calls).toBe(1);
  });

  test("closer registry snapshots, settles every closer, and shares drain work", async () => {
    const { createTestDatabaseCloserRegistry } = await import("./setup");
    expect(typeof createTestDatabaseCloserRegistry).toBe("function");
    const registry = createTestDatabaseCloserRegistry();
    const trace: string[] = [];
    registry.register(() => {
      trace.push("sync");
      throw new Error("secret sync failure");
    });
    registry.register(async () => {
      trace.push("async");
      throw new Error("secret async failure");
    });
    const first = registry.drain();
    const second = registry.drain();
    expect(first).toBe(second);
    await expect(first).rejects.toThrow("test_database_cleanup_failed");
    expect(trace).toEqual(["sync", "async"]);
    await expect(registry.drain()).rejects.toThrow("test_database_cleanup_failed");
  });

  test("closer registry unregisters before snapshot, freezes after start, and rejects late registration", async () => {
    const { createTestDatabaseCloserRegistry } = await import("./setup");
    expect(typeof createTestDatabaseCloserRegistry).toBe("function");
    const registry = createTestDatabaseCloserRegistry();
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    let removedCalls = 0;
    const unregisterBefore = registry.register(async () => {
      removedCalls += 1;
    });
    unregisterBefore();
    registry.register(async () => {
      started();
      await releasePromise;
    });
    const draining = registry.drain();
    await startedPromise;
    expect(() => registry.register(async () => {})).toThrow("test_database_cleanup_failed");
    release();
    await draining;
    expect(removedCalls).toBe(0);
  });

  test("drain waits for every snapshotted closer before exposing a fixed failure", async () => {
    const { createTestDatabaseCloserRegistry } = await import("./setup");
    const registry = createTestDatabaseCloserRegistry();
    let release!: () => void;
    let slowFinished = false;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    registry.register(() => {
      throw new Error("secret sync failure");
    });
    registry.register(async () => {
      await slow;
      slowFinished = true;
    });
    const draining = registry.drain();
    let exposedFailure = false;
    draining.catch(() => {
      exposedFailure = true;
    });
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(exposedFailure).toBe(false);
    expect(slowFinished).toBe(false);
    release();
    await expect(draining).rejects.toThrow("test_database_cleanup_failed");
    expect(slowFinished).toBe(true);
  });

  test("fake bootstrap cleanup does not consume the process closer registry", async () => {
    const { bootstrapTestDatabase, registerTestDatabaseCloser } = await import("./setup");
    const trace: string[] = [];
    const handle = await provisionTestDatabase(generatedPlan, fakeDeps(trace));
    trace.length = 0;
    const unregister = registerTestDatabaseCloser(async () => {
      trace.push("registered_close");
    });
    let unregisterLate: (() => void) | undefined;
    try {
      await expect(
        bootstrapTestDatabase(
          handle,
          async () => {
            trace.push("bootstrap");
            throw new Error("bootstrap failed");
          },
          async () => {
            trace.push("close_db");
          },
          async () => {
            trace.push("dispose");
          },
        ),
      ).rejects.toThrow("bootstrap failed");
      expect(trace).toEqual(["bootstrap", "close_db", "dispose"]);
      expect(() => {
        unregisterLate = registerTestDatabaseCloser(async () => {});
      }).not.toThrow();
    } finally {
      unregisterLate?.();
      unregister();
    }
  });

  test("shares one idempotent cleanup promise across afterAll and terminal signals", () => {
    const source = readFileSync(resolve(repoRoot, "test/setup.ts"), "utf8");
    expect(source).toContain("SIGINT");
    expect(source).toContain("SIGTERM");
    expect(source).toContain("cleanupPromises");
    expect(source).toContain("closeDb");
    expect(source).toContain("MINIME_KEEP_TEST_DATABASE");
    expect(source).toContain("testDatabaseCloserRegistry.drain");
    expect(source).toContain("const drainTestDatabaseClosers");
    expect(source).toMatch(
      /closeAndDisposeOnce\(\s*retainedHandle,[\s\S]*drainTestDatabaseClosers/,
    );
    expect(source).toMatch(/afterAll\(async \(\) =>[\s\S]*closeAndDisposeOnce/);
  });

  test("trackTestSqlPool registers an idempotent closer on the process registry", async () => {
    const { trackTestSqlPool } = await import("./setup");
    let ended = 0;
    const held = trackTestSqlPool({
      async end() {
        ended += 1;
      },
    });
    try {
      await held.close();
      await held.close();
      expect(ended).toBe(1);
    } finally {
      held.unregister();
    }
  });

  test("beforeAll app-role pools register a process closer", () => {
    for (const file of [
      "test/entity-tier-split.test.ts",
      "test/log-expense.test.ts",
      "test/m15.roles.test.ts",
      "test/person-dates.test.ts",
      "test/runtime-role.test.ts",
      "test/suppressed-hits.test.ts",
      "test/timeline-restricted-role.test.ts",
      "test/entity-tier-provenance.test.ts",
      "test/unlock-approval.test.ts",
      "test/unlock-lifecycle.test.ts",
    ]) {
      const source = readFileSync(resolve(repoRoot, file), "utf8");
      expect(source).toMatch(/trackTestSqlPool|registerTestDatabaseCloser/);
    }
  });
});
