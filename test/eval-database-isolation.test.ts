import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { runWithOwnedTestDatabase } from "../scripts/with-test-database";
import { expectSqlReject } from "./helpers";
import { testDatabaseUrl } from "./setup";
import { dropTestAppRole, mintTestAppRole } from "./support/app-role";
import {
  createDefaultTestDatabaseDeps,
  disposeTestDatabase,
  planTestDatabase,
  provisionTestDatabase,
} from "./support/test-database";

const repoRoot = resolve(import.meta.dir, "..");
const REAL_INTEGRATION_TIMEOUT_MS = 30_000;
const TARGET_IDLE_POLL_INTERVAL_MS = 50;
const TARGET_IDLE_POLL_ATTEMPTS = 200;

function makeDryRun(target: string, ...args: string[]): string {
  const result = Bun.spawnSync(["make", "-n", target, ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  return `${result.stdout.toString()}${result.stderr.toString()}`;
}

function adminUrlFromTestDatabase(): string {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/postgres";
  return url.toString();
}

async function databaseNames(): Promise<string[]> {
  const sql = postgres(adminUrlFromTestDatabase(), { max: 1 });
  try {
    const rows = await sql<{ datname: string }[]>`
      select datname from pg_database where datname like 'minime_test_%' order by datname`;
    return rows.map((row) => row.datname);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function databaseExists(name: string): Promise<boolean> {
  const sql = postgres(adminUrlFromTestDatabase(), { max: 1 });
  try {
    const rows = await sql<
      { exists: boolean }[]
    >`select exists(select 1 from pg_database where datname = ${name})`;
    return Boolean(rows[0]?.exists);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function databaseOwnershipAndSessions(
  name: string,
): Promise<{ owner: string; sessions: number } | undefined> {
  const sql = postgres(adminUrlFromTestDatabase(), { max: 1 });
  try {
    const rows = await sql<{ owner: string; sessions: number }[]>`
      select d.datdba::regrole::text as owner,
        (select count(*)::int from pg_stat_activity where datname = d.datname and pid <> pg_backend_pid()) as sessions
      from pg_database d where d.datname = ${name}`;
    return rows[0];
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function waitForOwnedDatabaseIdle(
  name: string,
): Promise<{ owner: string; sessions: number } | undefined> {
  let latest: { owner: string; sessions: number } | undefined;
  for (let attempt = 0; attempt < TARGET_IDLE_POLL_ATTEMPTS; attempt += 1) {
    latest = await databaseOwnershipAndSessions(name);
    if (latest?.owner === "minime" && latest.sessions === 0) return latest;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, TARGET_IDLE_POLL_INTERVAL_MS));
  }
  return latest;
}

function runOwnedChild(childArgv: string[], extraEnv: Record<string, string> = {}) {
  return Bun.spawnSync(
    [
      "bun",
      "run",
      "scripts/with-test-database.ts",
      "--label",
      "eval_search",
      "--database-env",
      "EVAL_DATABASE_URL",
      "--",
      ...childArgv,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, MINIME_MOCK_OLLAMA: "1", ...extraEnv },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

const WRAPPER_HARNESS = `
  const { runWithOwnedTestDatabase } = await import(${JSON.stringify(
    resolve(repoRoot, "scripts/with-test-database.ts"),
  )});
  const { planTestDatabase } = await import(${JSON.stringify(
    resolve(repoRoot, "test/support/test-database.ts"),
  )});
  const phase = process.env.WRAPPER_HARNESS_PHASE;
  const source = {
    DATABASE_URL: process.env.DATABASE_URL,
    MINIME_APP_DATABASE_URL: process.env.MINIME_APP_DATABASE_URL,
    EVAL_DATABASE_URL: process.env.EVAL_DATABASE_URL,
    EVAL_PMB_DATABASE_URL: process.env.EVAL_PMB_DATABASE_URL,
    EVAL_SKILLS_DATABASE_URL: process.env.EVAL_SKILLS_DATABASE_URL,
  };
  const plan = planTestDatabase(source.DATABASE_URL, \`harness_\${process.pid}_aaaaaaaaaaaa\`);
  const handle = { plan, createdByThisProcess: true };
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const deps = {
    provision: async () => handle,
    dispose: async () => {
      if (phase === "dispose-failure" || phase === "spawn-dispose-failure") {
        throw new Error("dispose failed");
      }
    },
    bootstrapOwnedDatabase: async (appOnly) => {
      if (process.env.DATABASE_URL !== plan.databaseUrl) {
        throw new Error("bootstrap_scratch_database_not_installed");
      }
      if (process.env.MINIME_APP_DATABASE_URL !== plan.databaseUrl) {
        throw new Error("bootstrap_scratch_app_alias_not_installed");
      }
      if (phase === "bootstrap-failure") throw new Error("bootstrap failed");
      if (phase === "bootstrap-signal") {
        console.error("READY");
        await wait(1000);
      }
      if (!appOnly) return;
      const appUrl = new URL(plan.databaseUrl);
      appUrl.username = "minime_test_app_harness";
      appUrl.password = "minime_test_app_harness_password_20260805";
      return {
        roleName: "minime_test_app_harness",
        password: "minime_test_app_harness_password_20260805",
        databaseName: plan.databaseName,
        databaseUrl: appUrl.toString(),
      };
    },
    spawn: async () => {
      if (phase === "spawn-failure" || phase === "spawn-dispose-failure") {
        throw new Error("spawn failed");
      }
      if (phase === "spawn-signal") {
        console.error("READY");
        await wait(1000);
      }
      return 0;
    },
  };
  const restored = () =>
    process.env.DATABASE_URL === source.DATABASE_URL &&
    process.env.MINIME_APP_DATABASE_URL === source.MINIME_APP_DATABASE_URL &&
    process.env.EVAL_DATABASE_URL === source.EVAL_DATABASE_URL &&
    process.env.EVAL_PMB_DATABASE_URL === source.EVAL_PMB_DATABASE_URL &&
    process.env.EVAL_SKILLS_DATABASE_URL === source.EVAL_SKILLS_DATABASE_URL;
  try {
    const result = await runWithOwnedTestDatabase(
      { label: "eval_search", databaseEnv: "EVAL_DATABASE_URL", argv: ["bun", "-e", "0"] },
      deps,
    );
    console.log(JSON.stringify({ result, restored: restored() }));
    process.exitCode = result;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "wrapper_harness_failed");
    console.log(JSON.stringify({ error: error instanceof Error ? error.message : "unknown", restored: restored() }));
    process.exitCode = 1;
  }
`;

function runWrapperHarness(phase: string) {
  return Bun.spawn(["bun", "-e", WRAPPER_HARNESS], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATABASE_URL: "postgres://minime:minime@localhost:5432/minime",
      MINIME_APP_DATABASE_URL: "postgres://minime_app:installed-runtime@localhost:5432/minime",
      EVAL_DATABASE_URL: "postgres://source:source@localhost:5432/minime_test_source_eval",
      EVAL_PMB_DATABASE_URL: "postgres://source:source@localhost:5432/minime_test_source_pmb",
      EVAL_SKILLS_DATABASE_URL: "postgres://source:source@localhost:5432/minime_test_source_skills",
      WRAPPER_HARNESS_PHASE: phase,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitForHarnessReady(child: ReturnType<typeof runWrapperHarness>): Promise<void> {
  const reader = child.stderr.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes("READY\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("wrapper_harness_ready_missing");
    output += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
}

async function waitForNewDatabase(before: string[], prefix?: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = await databaseNames();
    const created = current.find(
      (name) => !before.includes(name) && (prefix === undefined || name.startsWith(prefix)),
    );
    if (created) return created;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return undefined;
}

describe("database-reset eval isolation", () => {
  test(
    "real owned child sees a migrated guarded target and it is dropped after success",
    async () => {
      const before = await databaseNames();
      const result = runOwnedChild(["bun", "run", "test/fixtures/owned-db-child.ts", "probe"]);
      const stdout = result.stdout.toString();
      expect(result.exitCode).toBe(0);
      const child = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
      expect(child.name).toMatch(/^minime_test_[a-z0-9_]+$/);
      expect(child.name).not.toBe("minime_test");
      expect(child.extensions).toEqual(["pgcrypto", "vector"]);
      expect(child.sourceAbsent).toBe(true);
      expect(child.argvSourceAbsent).toBe(true);
      expect(child.aliasRole).toMatch(/^minime_test_app_[a-z0-9_]+$/);
      expect(child.aliasDatabase).toBe(child.name);
      expect(child.role).toMatch(/^minime_test_app_[a-z0-9_]+$/);
      expect(child.ddlDenied).toBe(true);
      expect(child.argv).toEqual(["probe"]);
      expect(Number(child.migrations)).toBe(
        readdirSync(resolve(repoRoot, "db/migrations")).filter((name) => name.endsWith(".sql"))
          .length,
      );
      expect(await databaseExists(child.name)).toBe(false);
      for (const sourceName of before) expect(stdout).not.toContain(sourceName);
    },
    { timeout: REAL_INTEGRATION_TIMEOUT_MS },
  );

  test(
    "abrupt owned child reports bounded identity and is dropped after process exit",
    async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const sourceBefore = await databaseOwnershipAndSessions("minime_test");
        const result = runOwnedChild(["bun", "run", "test/fixtures/owned-db-child.ts", "abrupt"]);
        const stdout = result.stdout.toString();
        const stderr = result.stderr.toString();
        expect(result.exitCode).toBe(0);
        expect(stderr).toBe("");
        const child = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
        expect(child.role).toMatch(/^minime_test_app_[a-z0-9_]+$/);
        expect(child.ddlDenied).toBe(true);
        expect(child.backendType).toBe("client backend");
        expect(child.applicationName).toBe("minime-test-abrupt-owned-child");
        expect(child.name).toMatch(/^minime_test_[a-z0-9_]+$/);
        expect(child.extensions).toEqual(["pgcrypto", "vector"]);
        expect(Number(child.pid)).toBeGreaterThan(0);
        expect(stdout).not.toMatch(/postgres(?:ql)?:\/\//);
        expect(stdout).not.toMatch(/select|password|secret|query/i);
        expect(await databaseExists(child.name)).toBe(false);
        expect(await databaseOwnershipAndSessions("minime_test")).toEqual(sourceBefore);
      }
    },
    { timeout: REAL_INTEGRATION_TIMEOUT_MS },
  );

  test(
    "foreign engineer client fences and blocks first disposal, then retry removes exact target",
    async () => {
      const deps = createDefaultTestDatabaseDeps();
      const handle = await provisionTestDatabase(
        planTestDatabase(testDatabaseUrl(), `foreign_${process.pid}_aaaaaaaaaaaa`),
        deps,
      );
      const target = handle.plan.databaseName;
      const sourceBefore = await databaseOwnershipAndSessions("minime_test");
      const foreignUrl = handle.plan.databaseUrl.replace(
        "postgres://minime:minime@",
        "postgres://minime_engineer_ro:minime@",
      );
      const foreign = postgres(foreignUrl, {
        max: 1,
        connection: { application_name: "minime-r2-foreign" },
      });
      let firstError: unknown;
      let foreignCloseError: unknown;
      try {
        try {
          const [identity] = await foreign`
            select current_user as role, pg_backend_pid() as pid`;
          expect(identity?.role).toBe("minime_engineer_ro");
          const originalForeignPid = Number(identity?.pid);
          expect(originalForeignPid).toBeGreaterThan(0);
          await expect(disposeTestDatabase(handle, deps)).rejects.toThrow(
            "test_database_cleanup_failed",
          );
          expect(await databaseExists(target)).toBe(true);
          const [stillOpen] = await foreign`select pg_backend_pid() as pid`;
          expect(Number(stillOpen?.pid)).toBe(originalForeignPid);
        } catch (error) {
          firstError = error;
        }
      } finally {
        try {
          await foreign.end({ timeout: 5 });
        } catch (error) {
          foreignCloseError = error;
        }
      }
      let retryError: unknown;
      try {
        await disposeTestDatabase(handle, deps);
      } catch (error) {
        retryError = error;
      }
      expect(retryError).toBeUndefined();
      expect(await databaseExists(target)).toBe(false);
      expect(await databaseOwnershipAndSessions("minime_test")).toEqual(sourceBefore);
      if (firstError) throw firstError;
      if (foreignCloseError) throw foreignCloseError;
    },
    { timeout: REAL_INTEGRATION_TIMEOUT_MS },
  );

  test(
    "real bootstrap failure disposes the exact generated target and preserves its primary error",
    async () => {
      const deps = createDefaultTestDatabaseDeps();
      // A prior suite or sibling file clone can leave autovacuum/client residue on
      // the installer template. Wait for idle instead of treating that as failure.
      const sourceBefore = await waitForOwnedDatabaseIdle("minime_test");
      expect(sourceBefore).toEqual({ owner: "minime", sessions: 0 });
      let generatedName: string | undefined;
      let spawnCalls = 0;

      await expect(
        runWithOwnedTestDatabase(
          {
            label: "eval_search",
            databaseEnv: "EVAL_DATABASE_URL",
            argv: ["bun", "run", "test/fixtures/owned-db-child.ts", "probe"],
          },
          {
            provision: async (plan) => {
              const handle = await provisionTestDatabase(plan, deps);
              generatedName = handle.plan.databaseName;
              expect(await databaseExists(generatedName)).toBe(true);
              return handle;
            },
            dispose: (handle) => disposeTestDatabase(handle, deps),
            bootstrapOwnedDatabase: async () => {
              throw new Error("bootstrap injected");
            },
            spawn: async () => {
              spawnCalls += 1;
              return 0;
            },
          },
        ),
      ).rejects.toThrow("bootstrap injected");

      expect(generatedName).toBeDefined();
      expect(spawnCalls).toBe(0);
      expect(await databaseExists(generatedName!)).toBe(false);
      expect(await waitForOwnedDatabaseIdle("minime_test")).toEqual(sourceBefore);
    },
    { timeout: REAL_INTEGRATION_TIMEOUT_MS },
  );

  test(
    "real wrapper filters source URLs and failure output stays content-free",
    async () => {
      const sourceSentinel =
        "postgres://source-user:source-secret@localhost:5432/minime_test_source";
      const result = runOwnedChild(["bun", "run", "test/fixtures/owned-db-child.ts", "sentinel"], {
        SOURCE_URL_SENTINEL: sourceSentinel,
        EVAL_PMB_DATABASE_URL: sourceSentinel,
        EVAL_SKILLS_DATABASE_URL: sourceSentinel,
      });
      const stdout = result.stdout.toString();
      const stderr = result.stderr.toString();
      expect(result.exitCode).toBe(0);
      expect(stdout).not.toContain(sourceSentinel);
      expect(stderr).not.toContain(sourceSentinel);
      const child = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
      expect(child.sourceAbsent).toBe(true);
      expect(child.argvSourceAbsent).toBe(true);

      const failed = Bun.spawnSync(
        ["bun", "run", "scripts/with-test-database.ts", "--label", "invalid", "--", "bun"],
        {
          cwd: repoRoot,
          env: { ...process.env, EVAL_PMB_DATABASE_URL: sourceSentinel },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(failed.exitCode).not.toBe(0);
      expect(`${failed.stdout.toString()}${failed.stderr.toString()}`).not.toContain(
        sourceSentinel,
      );
    },
    { timeout: REAL_INTEGRATION_TIMEOUT_MS },
  );

  test(
    "real owned child disposal runs after a nonzero child",
    async () => {
      const before = await databaseNames();
      const child = Bun.spawn(
        [
          "bun",
          "run",
          "scripts/with-test-database.ts",
          "--label",
          "eval_search",
          "--database-env",
          "EVAL_DATABASE_URL",
          "--",
          "bun",
          "-e",
          "setTimeout(() => process.exit(7), 300)",
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, MINIME_MOCK_OLLAMA: "1" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const target = await waitForNewDatabase(before, `minime_test_eval_search_${child.pid}_`);
      expect(target).toBeDefined();
      expect(await child.exited).toBe(7);
      expect(await databaseExists(target!)).toBe(false);
    },
    { timeout: REAL_INTEGRATION_TIMEOUT_MS },
  );

  test(
    "real SIGTERM child path disposes the generated target",
    async () => {
      const before = await databaseNames();
      const child = Bun.spawn(
        [
          "bun",
          "run",
          "scripts/with-test-database.ts",
          "--label",
          "eval_search",
          "--database-env",
          "EVAL_DATABASE_URL",
          "--",
          "bun",
          "-e",
          "setTimeout(() => {}, 30000)",
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, MINIME_MOCK_OLLAMA: "1" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const target = await waitForNewDatabase(before, `minime_test_eval_search_${child.pid}_`);
      expect(target).toBeDefined();
      child.kill("SIGTERM");
      const exitCode = await child.exited;
      expect(exitCode).toBe(143);
      expect(await databaseExists(target!)).toBe(false);
    },
    { timeout: REAL_INTEGRATION_TIMEOUT_MS },
  );

  test(
    "real SIGINT child path disposes the generated target",
    async () => {
      const before = await databaseNames();
      const child = Bun.spawn(
        [
          "bun",
          "run",
          "scripts/with-test-database.ts",
          "--label",
          "eval_search",
          "--database-env",
          "EVAL_DATABASE_URL",
          "--",
          "bun",
          "-e",
          "setTimeout(() => {}, 30000)",
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, MINIME_MOCK_OLLAMA: "1" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const target = await waitForNewDatabase(before, `minime_test_eval_search_${child.pid}_`);
      expect(target).toBeDefined();
      child.kill("SIGINT");
      const exitCode = await child.exited;
      expect(exitCode).toBe(130);
      expect(await databaseExists(target!)).toBe(false);
    },
    { timeout: REAL_INTEGRATION_TIMEOUT_MS },
  );

  test(
    "keep-forensics prints one exact owned target for validated recovery",
    async () => {
      const sourceSentinel = "postgres://source-user:source-secret@localhost:5432/minime";
      const result = runOwnedChild(["bun", "run", "test/fixtures/owned-db-child.ts", "forensics"], {
        MINIME_KEEP_TEST_DATABASE: "1",
        SOURCE_URL_SENTINEL: sourceSentinel,
        EVAL_PMB_DATABASE_URL: sourceSentinel,
        EVAL_SKILLS_DATABASE_URL: sourceSentinel,
      });
      const stdout = result.stdout.toString();
      expect(result.exitCode).toBe(0);
      expect(stdout).not.toContain(sourceSentinel);
      const target = stdout
        .trim()
        .split("\n")
        .find((line) => /^minime_test_[a-z0-9_]+$/.test(line));
      expect(target).toBeDefined();
      expect(await waitForOwnedDatabaseIdle(target!)).toEqual({ owner: "minime", sessions: 0 });
      const deps = createDefaultTestDatabaseDeps();
      const admin = await deps.connectAdmin(adminUrlFromTestDatabase());
      try {
        await admin.terminate(target!);
        await admin.drop(target!);
      } finally {
        await admin.close();
      }
      expect(await databaseExists(target!)).toBe(false);
    },
    { timeout: REAL_INTEGRATION_TIMEOUT_MS },
  );

  test(
    "executable wrapper harness replaces live app endpoint and restores it after success, failures, and signals",
    async () => {
      const succeeded = runWrapperHarness("success");
      const successExitCode = await succeeded.exited;
      const successStdout = await new Response(succeeded.stdout).text();
      expect(successExitCode).toBe(0);
      const successReport = JSON.parse(successStdout.trim().split("\n").at(-1) ?? "{}");
      expect(successReport.result).toBe(0);
      expect(successReport.restored).toBe(true);

      const failures = [
        ["bootstrap-failure", "bootstrap failed"],
        ["spawn-failure", "spawn failed"],
        ["dispose-failure", "test_database_cleanup_failed"],
        ["spawn-dispose-failure", "test_database_cleanup_failed"],
      ] as const;
      for (const [phase, message] of failures) {
        const child = runWrapperHarness(phase);
        const exitCode = await child.exited;
        const [stdout, stderr] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(exitCode).toBe(1);
        expect(stderr).toContain(message);
        const report = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
        expect(report.error).toBe(message);
        expect(report.restored).toBe(true);
      }

      for (const [phase, signal, expected] of [
        ["bootstrap-signal", "SIGINT", 130],
        ["spawn-signal", "SIGTERM", 143],
      ] as const) {
        const child = runWrapperHarness(phase);
        await waitForHarnessReady(child);
        child.kill(signal);
        const exitCode = await child.exited;
        const stdout = await new Response(child.stdout).text();
        expect(exitCode).toBe(expected);
        const report = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
        expect(report.result).toBe(expected);
        expect(report.restored).toBe(true);
      }
    },
    { timeout: REAL_INTEGRATION_TIMEOUT_MS },
  );

  test(
    "two simultaneous wrappers serialize cloning and leave distinct targets",
    async () => {
      // The installer template can still show autovacuum/client residue after a
      // prior suite or the install re-run. Clone fails closed on that; wait first.
      expect(await waitForOwnedDatabaseIdle("minime_test")).toEqual({
        owner: "minime",
        sessions: 0,
      });
      const spawn = () =>
        Bun.spawn(
          [
            "bun",
            "run",
            "scripts/with-test-database.ts",
            "--label",
            "eval_search",
            "--database-env",
            "EVAL_DATABASE_URL",
            "--",
            "bun",
            "run",
            "test/fixtures/owned-db-child.ts",
          ],
          {
            cwd: repoRoot,
            env: { ...process.env, MINIME_MOCK_OLLAMA: "1" },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
      const [first, second] = [spawn(), spawn()];
      const [firstCode, secondCode] = await Promise.all([first.exited, second.exited]);
      const [firstOutput, secondOutput, firstErr, secondErr] = await Promise.all([
        new Response(first.stdout).text(),
        new Response(second.stdout).text(),
        new Response(first.stderr).text(),
        new Response(second.stderr).text(),
      ]);
      expect(firstCode, firstErr || firstOutput).toBe(0);
      expect(secondCode, secondErr || secondOutput).toBe(0);
      const firstChild = JSON.parse(firstOutput.trim().split("\n").at(-1) ?? "{}");
      const secondChild = JSON.parse(secondOutput.trim().split("\n").at(-1) ?? "{}");
      expect(firstChild.name).not.toBe(secondChild.name);
      expect(firstChild.name).toMatch(/^minime_test_[a-z0-9_]+$/);
      expect(secondChild.name).toMatch(/^minime_test_[a-z0-9_]+$/);
      expect(await databaseExists(firstChild.name)).toBe(false);
      expect(await databaseExists(secondChild.name)).toBe(false);
    },
    { timeout: REAL_INTEGRATION_TIMEOUT_MS },
  );

  test("direct and transitive destructive eval callers are wrapper-covered", () => {
    const sources = new Map([
      ["eval-search.ts", readFileSync(resolve(repoRoot, "scripts/eval-search.ts"), "utf8")],
      [
        "eval-graph-hygiene.ts",
        readFileSync(resolve(repoRoot, "scripts/eval-graph-hygiene.ts"), "utf8"),
      ],
      [
        "eval-precisionmembench.ts",
        readFileSync(resolve(repoRoot, "scripts/eval-precisionmembench.ts"), "utf8"),
      ],
      ["pmb-server.ts", readFileSync(resolve(repoRoot, "scripts/pmb-server.ts"), "utf8")],
      ["eval-skills.ts", readFileSync(resolve(repoRoot, "scripts/eval-skills.ts"), "utf8")],
      ["optimize-skill.ts", readFileSync(resolve(repoRoot, "scripts/optimize-skill.ts"), "utf8")],
      ["skill-eval-lib.ts", readFileSync(resolve(repoRoot, "scripts/skill-eval-lib.ts"), "utf8")],
      ["helpers.ts", readFileSync(resolve(repoRoot, "test/helpers.ts"), "utf8")],
    ]);
    expect(sources.get("eval-search.ts")).not.toContain("resetDb()");
    expect(sources.get("eval-search.ts")).toContain("eval-search-worker.ts");
    expect(sources.get("eval-search.ts")).toContain('"eval_search"');
    expect(readFileSync(resolve(repoRoot, "scripts/eval-search-worker.ts"), "utf8")).not.toMatch(
      /\bresetDb\b|\bresetAndSeed\b|\bdrop\s+table\b|\bdrop\s+database\b|\btruncate\b|\bmigrate\s*\(/i,
    );
    expect(sources.get("eval-graph-hygiene.ts")).toContain("resetDb()");
    expect(sources.get("eval-precisionmembench.ts")).toContain("resetDb()");
    expect(sources.get("pmb-server.ts")).toContain("resetDb()");
    expect(sources.get("eval-skills.ts")).toContain("seedCorpus()");
    expect(sources.get("optimize-skill.ts")).toContain("seedCorpus()");
    expect(sources.get("skill-eval-lib.ts")).toContain("resetAndSeed()");
    expect(sources.get("helpers.ts")).toContain("resetDb()");
    expect(sources.get("helpers.ts")).toContain('migrate({ kind: "test" })');

    const longMem = readFileSync(resolve(repoRoot, "scripts/eval-longmemeval.ts"), "utf8");
    expect(longMem).not.toMatch(
      /\bresetDb\b|\bresetAndSeed\b|\bseedCorpus\b|\bdrop\s+table\b|\bdrop\s+database\b|\btruncate\b|\bmigrate\s*\(/i,
    );
    const wrapper = readFileSync(resolve(repoRoot, "scripts/with-test-database.ts"), "utf8");
    expect(wrapper).toContain("eval_search");
    expect(wrapper).toContain("eval_graph_hygiene");
    expect(wrapper).toContain("eval_pmb");
    expect(wrapper).toContain("eval_skills");
    expect(wrapper).toContain("eval_skill_optimize");
  });

  test("skill Make targets preserve exact wrapper labels and child argv", () => {
    const skills = makeDryRun("eval-skills", "ROUND=r1");
    expect(skills).toContain("--label eval_skills --database-env EVAL_SKILLS_DATABASE_URL --");
    expect(skills).toContain("scripts/eval-skills.ts --round r1");
    expect(skills).not.toMatch(/createdb|create extension|minime_eval|minime_test\b/);

    const optimize = makeDryRun("optimize-skill", "SUITE=query", "ROUND=r1");
    expect(optimize).toContain(
      "--label eval_skill_optimize --database-env EVAL_SKILLS_DATABASE_URL --",
    );
    expect(optimize).toContain("scripts/optimize-skill.ts --suite query --round r1");
    expect(optimize).not.toMatch(/createdb|create extension|minime_eval|minime_test\b/);

    const startFrom = makeDryRun(
      "optimize-skill",
      "SUITE=query",
      "ROUND=r1",
      "START_FROM=fixtures/skill-tasks/deficient-query.md",
    );
    expect(startFrom).toContain("--start-from fixtures/skill-tasks/deficient-query.md");
  });

  test("LongMemEval keeps the runtime alias on its guarded scratch database", () => {
    const longMem = makeDryRun("eval-longmemeval");
    expect(longMem).toContain(
      "DATABASE_URL=postgres://minime:minime@localhost:5432/minime_eval_lme1 MINIME_APP_DATABASE_URL=postgres://minime:minime@localhost:5432/minime_eval_lme1",
    );
  });

  test("mock snapshot and offline M0 dry-runs use the approved wrapper", () => {
    const snapshot = makeDryRun("eval-snapshot", "ROUND=v0.9");
    expect(snapshot).toContain("MINIME_MOCK_OLLAMA=1");
    expect(snapshot).toContain("scripts/eval-search.ts --mode mock --round release-v0.9");
    expect(snapshot).not.toMatch(/createdb|create extension|minime_eval|minime_test\b/);

    const offline = makeDryRun("verify-m0-offline");
    expect(offline).toContain("MINIME_MOCK_OLLAMA=1");
    expect(offline).toContain("--label verify_m0 --");
    expect(offline).toContain("src/verify/m0.ts");
  });

  test("all covered live targets use the wrapper and PMB shell does not create databases", () => {
    for (const target of [
      "eval-search-live",
      "eval-graph-hygiene",
      "eval-pmb",
      "eval-pmb-official",
    ]) {
      const output = makeDryRun(target);
      if (target === "eval-search-live") {
        expect(output).toContain("scripts/eval-search.ts");
      } else {
        expect(output).toContain("with-test-database.ts");
      }
      expect(output).not.toMatch(/createdb|create extension|minime_eval/);
    }
    const pmb = readFileSync(resolve(repoRoot, "scripts/eval-pmb.sh"), "utf8");
    expect(pmb).toContain('DATABASE_URL="$EVAL_PMB_DATABASE_URL"');
    expect(pmb).not.toMatch(/\bcreatedb\b|create\s+extension|minime_eval/i);
  });

  test("real wrapper integration cases declare an explicit bounded timeout", () => {
    const source = readFileSync(resolve(repoRoot, "test/eval-database-isolation.test.ts"), "utf8");
    expect(source).toContain("const REAL_INTEGRATION_TIMEOUT_MS = 30_000;");
    for (const name of [
      "real owned child sees a migrated guarded target and it is dropped after success",
      "real bootstrap failure disposes the exact generated target and preserves its primary error",
      "real wrapper filters source URLs and failure output stays content-free",
      "real owned child disposal runs after a nonzero child",
      "real SIGTERM child path disposes the generated target",
      "real SIGINT child path disposes the generated target",
      "keep-forensics prints one exact owned target for validated recovery",
      "executable wrapper harness replaces live app endpoint and restores it after success, failures, and signals",
      "two simultaneous wrappers serialize cloning and leave distinct targets",
    ]) {
      const start = source.indexOf(`\n    \"${name}\",`);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = source.indexOf("\n  );", start);
      expect(end).toBeGreaterThan(start);
      const block = source.slice(start, end + "\n  );".length);
      expect(block).toMatch(/\n {4}\{ timeout: REAL_INTEGRATION_TIMEOUT_MS \},\n {2}\);$/);
    }
  });
});

describe("eval workflow privilege and template contract", () => {
  const workflow = readFileSync(resolve(repoRoot, ".github/workflows/eval.yml"), "utf8");

  test("uses postgres service/bootstrap and minime for the authoritative gate", () => {
    expect(workflow).toContain("POSTGRES_USER: postgres");
    expect(workflow).toContain("POSTGRES_DB: postgres");
    expect(workflow).toContain("pg_isready -U postgres");
    expect(workflow).toContain("PGUSER: minime");
    expect(workflow).toContain("DATABASE_URL: postgres://minime:minime@localhost:5432/minime");
    expect(workflow).toContain("PGUSER: postgres");
    expect(workflow).toContain(
      "create role minime login password 'minime' nosuperuser createdb createrole",
    );
    expect(workflow).toContain("createdb --owner=minime minime");
    expect(workflow).toContain("createdb --owner=minime minime_test");
    expect(workflow).toContain("create extension if not exists vector");
    expect(workflow).toContain("create extension if not exists pgcrypto");
    expect(workflow).toContain("select rolsuper, rolcreatedb, rolcreaterole");
    expect(workflow).toContain('"f|t|t"');
    expect(workflow).toContain("run: make verify");
    expect(workflow).not.toContain("minime_eval");
  });

  test("keeps admin credentials and source creation confined to the named bootstrap step", () => {
    const bootstrap =
      workflow
        .split("- name: bootstrap Minime databases as service administrator")[1]
        ?.split("- name:")[0] ?? "";
    expect(bootstrap).toContain("PGUSER: postgres");
    expect(bootstrap).toContain("PGPASSWORD: postgres");
    expect(bootstrap).toMatch(/createdb|create extension/);
    const remainder = workflow.replace(bootstrap, "");
    expect(remainder).not.toContain("PGPASSWORD: postgres");
    expect(remainder).not.toContain("PGUSER: postgres");
  });

  test("runtime provisioning never branches on superuser posture", () => {
    const wrapper = readFileSync(resolve(repoRoot, "scripts/with-test-database.ts"), "utf8");
    const support = readFileSync(resolve(repoRoot, "test/support/test-database.ts"), "utf8");
    expect(`${wrapper}\n${support}`).not.toMatch(
      /rolsuper|usesuper|is_superuser|alter role|set role/i,
    );
  });

  test("app-only wrapper and preload never mutate the cluster-global minime_app role", () => {
    const wrapper = readFileSync(resolve(repoRoot, "scripts/with-test-database.ts"), "utf8");
    const setup = readFileSync(resolve(repoRoot, "test/setup.ts"), "utf8");
    expect(`${wrapper}\n${setup}`).not.toMatch(/alter\s+role\s+minime_app|password\s+minime_app/i);
    expect(setup).not.toMatch(/process\.env\.MINIME_APP_PASSWORD\s*=/);
  });

  test("app-only cleanup drops the unique role after its scratch database", () => {
    const wrapper = readFileSync(resolve(repoRoot, "scripts/with-test-database.ts"), "utf8");
    expect(wrapper.indexOf("await deps.dispose(handle!)")).toBeLessThan(
      wrapper.indexOf("await dropTestAppRole(appLease)"),
    );
  });

  test("worker accepts only unique scratch app roles", () => {
    const worker = readFileSync(resolve(repoRoot, "scripts/eval-search-worker.ts"), "utf8");
    expect(worker).toContain("minime_test_app_");
    expect(worker).not.toMatch(/parsed\.username\s*!==\s*[\"']minime_app/);
  });

  test("app-only scratch roles are unique and cannot retarget the live database", async () => {
    const lease = await mintTestAppRole(testDatabaseUrl());
    try {
      expect(lease.roleName).toMatch(/^minime_test_app_[a-z0-9_]+$/);
      expect(lease.databaseName).toMatch(/^minime_test_[a-z0-9_]+$/);
      const liveUrl = new URL(lease.databaseUrl);
      liveUrl.pathname = "/minime";
      const live = postgres(liveUrl.toString(), { max: 1, onnotice: () => {} });
      try {
        await expectSqlReject(live`select * from pages`, /permission denied/);
      } finally {
        await live.end({ timeout: 2 });
      }
    } finally {
      await dropTestAppRole(lease);
    }
  });
});
