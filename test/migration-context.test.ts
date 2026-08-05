import { describe, expect, test } from "bun:test";
import {
  type MigrationContext,
  assertMigrationContextForDatabase,
  compareMigrationLedger,
  parseMigrationCliContext,
} from "../src/db/migration-context";
import { bootstrapTestDatabase } from "./setup";
import {
  type TestDatabaseAdmin,
  type TestDatabaseDeps,
  disposeTestDatabase,
  planTestDatabase,
  provisionTestDatabase,
} from "./support/test-database";

describe("migration CLI context parser", () => {
  test.each([
    ["direct", ["--context", "direct"], { kind: "direct" }],
    ["install", ["--context", "install"], { kind: "install" }],
    ["restore", ["--context", "restore"], { kind: "restore" }],
    [
      "update with snapshot",
      ["--context", "update", "--snapshot-outcome", "taken"],
      { kind: "update", snapshot: "taken" },
    ],
    [
      "update without snapshot",
      ["--context", "update", "--snapshot-outcome", "unconfigured"],
      { kind: "update", snapshot: "unconfigured" },
    ],
  ] as const)("parses %s", (_name, argv, expected) => {
    expect(parseMigrationCliContext(argv)).toEqual(expected satisfies MigrationContext);
  });

  test.each([
    ["missing context", []],
    ["duplicate context", ["--context", "direct", "--context", "install"]],
    ["unknown context", ["--context", "test"]],
    ["unknown flag", ["--context", "direct", "--bogus"]],
    ["trailing value", ["--context", "direct", "extra"]],
    ["missing context value", ["--context"]],
    ["missing update snapshot", ["--context", "update"]],
    [
      "duplicate update snapshot",
      ["--context", "update", "--snapshot-outcome", "taken", "--snapshot-outcome", "unconfigured"],
    ],
    ["invalid update snapshot", ["--context", "update", "--snapshot-outcome", "failed"]],
    ["snapshot on direct", ["--context", "direct", "--snapshot-outcome", "taken"]],
    ["API-only test context", ["--context", "test"]],
  ] as const)("rejects %s with a fixed parser error", (_name, argv) => {
    expect(() => parseMigrationCliContext(argv)).toThrow(/migration_context_(required|invalid)/);
  });
});

describe("migration ledger comparison", () => {
  test("compares sorted checked-out and applied names", () => {
    expect(
      compareMigrationLedger(["003_c.sql", "001_a.sql", "002_b.sql"], ["002_b.sql", "001_a.sql"]),
    ).toEqual({
      expected: ["001_a.sql", "002_b.sql", "003_c.sql"],
      applied: ["001_a.sql", "002_b.sql"],
      missing: ["003_c.sql"],
      unexpected: [],
    });
  });

  test("compares unexpected and duplicate ledger entries exactly", () => {
    expect(
      compareMigrationLedger(["001_a.sql"], ["001_a.sql", "000_old.sql", "001_a.sql"]),
    ).toEqual({
      expected: ["001_a.sql"],
      applied: ["000_old.sql", "001_a.sql", "001_a.sql"],
      missing: [],
      unexpected: ["000_old.sql", "001_a.sql", "001_a.sql"],
    });
  });
});

describe("migration context targets", () => {
  test.each([
    [{ kind: "install" }, "minime"],
    [{ kind: "direct" }, "minime"],
    [{ kind: "update", snapshot: "taken" }, "minime"],
    [{ kind: "update", snapshot: "unconfigured" }, "minime"],
    [{ kind: "test" }, "minime_test_123_abcd"],
    [{ kind: "restore" }, "minime_drill"],
    [{ kind: "restore" }, "minime_restore"],
  ] as const)("accepts %j on %s", (context, databaseName) => {
    expect(() => assertMigrationContextForDatabase(context, databaseName)).not.toThrow();
  });

  test.each([
    [{ kind: "install" }, "minime_test_123_abcd"],
    [{ kind: "direct" }, "minime_restore"],
    [{ kind: "update", snapshot: "taken" }, "minime_test_123_abcd"],
    [{ kind: "test" }, "minime_test"],
    [{ kind: "test" }, "minime_test_"],
    [{ kind: "test" }, "minime_test_123_abcd\n"],
    [{ kind: "restore" }, "minime"],
  ] as const)("rejects %j on %s without naming the target", (context, databaseName) => {
    expect(() => assertMigrationContextForDatabase(context, databaseName)).toThrow(
      "migration_context_target",
    );
  });

  test("missing context is refused before a closed database port is touched", () => {
    const proc = Bun.spawnSync(["bun", "run", "src/cli.ts", "migrate"], {
      cwd: `${import.meta.dir}/..`,
      env: {
        ...process.env,
        DATABASE_URL: "postgres://minime:minime@127.0.0.1:1/minime",
        OLLAMA_URL: "http://127.0.0.1:1",
        MINIME_SKIP_REPO_DOTENV: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
    expect(proc.exitCode).toBe(50);
    expect(output).toContain(
      "ERROR: migration context required\nFIX: run make migrate, or rerun make update",
    );
    expect(output).not.toContain("ECONNREFUSED");
    expect(output).not.toContain("127.0.0.1:1");
  });
});

function bootstrapCleanupAdmin(trace: string[], exists: boolean): TestDatabaseAdmin {
  return {
    async acquireTemplateCloneLock() {},
    async exists(databaseName) {
      trace.push(`exists:${databaseName}`);
      return exists;
    },
    async assertInstallerTemplateIdle() {},
    async cloneFromInstallerTemplate(databaseName) {
      trace.push(`clone:${databaseName}`);
    },
    async assertExtensionsPresent(databaseUrl) {
      trace.push(`extensions:${databaseUrl}`);
    },
    async terminate(databaseName) {
      trace.push(`terminate:${databaseName}`);
    },
    async drop(databaseName) {
      trace.push(`drop:${databaseName}`);
    },
    async close() {
      trace.push("admin_close");
    },
  };
}

function bootstrapCleanupDeps(trace: string[], exists: boolean): TestDatabaseDeps {
  let connections = 0;
  return {
    async connectAdmin() {
      connections += 1;
      trace.push(`connect:${connections}`);
      return bootstrapCleanupAdmin(trace, exists);
    },
  };
}

test("bootstrap failure closes before disposing only the retained owned handle", async () => {
  const ownedTrace: string[] = [];
  const ownedPlan = planTestDatabase(
    "postgres://minime:minime@localhost:5432/minime",
    "999_aaaaaaaaaaaa",
  );
  const ownedDeps = bootstrapCleanupDeps(ownedTrace, false);
  const ownedHandle = await provisionTestDatabase(ownedPlan, ownedDeps);
  ownedTrace.length = 0;

  await expect(
    bootstrapTestDatabase(
      ownedHandle,
      async () => {
        ownedTrace.push("bootstrap_failed");
        throw new Error("bootstrap failed");
      },
      async () => {
        ownedTrace.push("close_db");
      },
      (handle) => disposeTestDatabase(handle, ownedDeps),
    ),
  ).rejects.toThrow("bootstrap failed");

  expect(ownedTrace.indexOf("close_db")).toBeGreaterThanOrEqual(0);
  expect(ownedTrace.indexOf("terminate:minime_test_999_aaaaaaaaaaaa")).toBeGreaterThan(
    ownedTrace.indexOf("close_db"),
  );
  expect(ownedTrace).toContain("drop:minime_test_999_aaaaaaaaaaaa");

  await expect(
    bootstrapTestDatabase(
      ownedHandle,
      async () => {
        ownedTrace.push("bootstrap_failed_again");
        throw new Error("bootstrap failed again");
      },
      async () => {
        ownedTrace.push("close_db");
      },
      (handle) => disposeTestDatabase(handle, ownedDeps),
    ),
  ).rejects.toThrow("bootstrap failed again");

  expect(ownedTrace.filter((event) => event === "close_db")).toHaveLength(1);
  expect(ownedTrace.filter((event) => event.startsWith("terminate:")).length).toBe(1);
  expect(ownedTrace.filter((event) => event.startsWith("drop:")).length).toBe(1);

  const externalTrace: string[] = [];
  const externalPlan = planTestDatabase(
    "postgres://minime:minime@localhost:5432/minime",
    "999_bbbbbbbbbbbb",
    "postgres://scratch:p%40ss@127.0.0.1:6544/minime_test_external_bootstrap",
  );
  const externalDeps = bootstrapCleanupDeps(externalTrace, true);
  const externalHandle = await provisionTestDatabase(externalPlan, externalDeps);
  externalTrace.length = 0;

  await expect(
    bootstrapTestDatabase(
      externalHandle,
      async () => {
        externalTrace.push("bootstrap_failed");
        throw new Error("bootstrap failed");
      },
      async () => {
        externalTrace.push("close_db");
      },
      (handle) => disposeTestDatabase(handle, externalDeps),
    ),
  ).rejects.toThrow("bootstrap failed");

  expect(externalTrace).toEqual(["bootstrap_failed", "close_db"]);

  await expect(
    bootstrapTestDatabase(
      externalHandle,
      async () => {
        externalTrace.push("bootstrap_failed_again");
        throw new Error("bootstrap failed again");
      },
      async () => {
        externalTrace.push("close_db");
      },
      (handle) => disposeTestDatabase(handle, externalDeps),
    ),
  ).rejects.toThrow("bootstrap failed again");

  expect(externalTrace).toEqual(["bootstrap_failed", "close_db", "bootstrap_failed_again"]);
});
