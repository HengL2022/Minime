import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { buildServer } from "../src/mcp/server";
import {
  assertRuntimeChildBoundary,
  runtimeChildEnvironment,
  startOwnerMaintenanceSchedule,
} from "../src/serve";
import { config } from "../src/util/config";

const APP_URL = "postgres://minime_app:fictional_runtime_password_20260805@localhost:5432/minime";
const OWNER_URL = "postgres://minime:fictional_owner_password@localhost:5432/minime";

function runServe(env: Record<string, string>) {
  const proc = Bun.spawnSync([process.execPath, "--no-env-file", "run", "src/cli.ts", "serve"], {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      MINIME_SKIP_REPO_DOTENV: "1",
      OLLAMA_URL: "http://localhost:11434",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

describe("resident serve authority split", () => {
  test("serve requires owner and runtime to share the exact loopback endpoint/database", () => {
    for (const [owner, runtime] of [
      [OWNER_URL, APP_URL.replace("localhost:5432", "localhost:5433")],
      [OWNER_URL, APP_URL.replace("localhost", "127.0.0.1")],
      [OWNER_URL, APP_URL.replace(":5432/minime", ":5432/minime_test")],
      ["postgres://minime:fictional@database.example.test:5432/minime", APP_URL],
    ] as const) {
      const result = runServe({ DATABASE_URL: owner, MINIME_APP_DATABASE_URL: runtime });
      expect(result.code).not.toBe(0);
      expect(result.out).toContain("database_endpoint_invalid");
      expect(result.out).not.toContain("fictional");
    }
    const wrongOwner = runServe({
      DATABASE_URL: "postgres://minime_app:fictional@localhost:5432/minime",
      MINIME_APP_DATABASE_URL: APP_URL,
    });
    expect(wrongOwner.code).toBe(40);
    expect(wrongOwner.out).toContain("ERROR: restricted runtime app role is not configured");
    expect(wrongOwner.out).not.toContain("fictional");
  });

  test("transport self-close notifies the runtime lifecycle", async () => {
    let closed = 0;
    let resolveClosed!: () => void;
    const observed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const transport: Transport = {
      onclose: undefined,
      onerror: undefined,
      onmessage: undefined,
      start: async () => {},
      send: async () => {},
      close: async () => {},
    };
    const server = buildServer({
      tools: [],
      onClosed: () => {
        closed += 1;
        resolveClosed();
      },
    });
    await server.connect(transport);
    transport.onclose?.();
    await observed;
    expect(closed).toBe(1);
    await server.close();
  });

  test("runtime child receives the app DSN but no owner, libpq, or backup credential", () => {
    const child = runtimeChildEnvironment(
      {
        DATABASE_URL: "postgres://owner:owner-secret@127.0.0.1:5432/minime",
        EVAL_DATABASE_URL: "postgres://owner:owner-secret@127.0.0.1:5432/minime",
        MINIME_APP_DATABASE_URL: APP_URL,
        MINIME_APP_PASSWORD: "duplicate-secret",
        PGPASSWORD: "owner-secret",
        PGSERVICEFILE: "/private/owner-service",
        AWS_ACCESS_KEY_ID: "backup-access-key",
        AWS_SECRET_ACCESS_KEY: "backup-secret-key",
        B2_ACCOUNT_ID: "backup-account",
        B2_ACCOUNT_KEY: "backup-key",
        RESTIC_REPOSITORY: "/private/backups",
        RESTIC_PASSWORD_FILE: "/private/restic-password",
        EMBED_PROVIDER: "openai",
        OPENAI_API_KEY: "provider-key",
        ANTHROPIC_API_KEY: "unused-provider-key",
        AMBIENT_TOKEN: "ambient-secret",
        NODE_OPTIONS: "--require=/private/ambient-hook.js",
        HTTP_PROXY: "http://proxy.example.test",
        HTTPS_PROXY: "http://proxy.example.test",
        ALL_PROXY: "socks5://proxy.example.test",
        NO_PROXY: "localhost",
        RERANK_DEBUG: "query-content",
        PATH: "/usr/bin",
      },
      APP_URL,
    );

    expect(child.DATABASE_URL).toBe(APP_URL);
    expect(child.MINIME_APP_DATABASE_URL).toBe(APP_URL);
    expect(child.MINIME_RUNTIME_CHILD).toBe("1");
    expect(child.MINIME_SKIP_REPO_DOTENV).toBe("1");
    expect(child.OPENAI_API_KEY).toBe("provider-key");
    expect(child.PATH).toBe("/usr/bin");
    for (const name of [
      "MINIME_APP_PASSWORD",
      "EVAL_DATABASE_URL",
      "PGPASSWORD",
      "PGSERVICEFILE",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "B2_ACCOUNT_ID",
      "B2_ACCOUNT_KEY",
      "RESTIC_REPOSITORY",
      "RESTIC_PASSWORD_FILE",
      "ANTHROPIC_API_KEY",
      "AMBIENT_TOKEN",
      "NODE_OPTIONS",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "RERANK_DEBUG",
    ]) {
      expect(child[name]).toBeUndefined();
    }
    expect(JSON.stringify(child)).not.toContain("owner-secret");
    expect(JSON.stringify(child)).not.toContain("backup-secret-key");
    expect(JSON.stringify(child)).not.toContain("ambient-secret");
    expect(() => assertRuntimeChildBoundary(child)).not.toThrow();
  });

  test("test-only runtime knobs are admitted only as the exact test pair", () => {
    const testChild = runtimeChildEnvironment(
      { NODE_ENV: "test", MINIME_MOCK_OLLAMA: "1" },
      APP_URL,
    );
    expect(testChild.NODE_ENV).toBe("test");
    expect(testChild.MINIME_MOCK_OLLAMA).toBe("1");
    expect(() => assertRuntimeChildBoundary(testChild)).not.toThrow();

    const production = runtimeChildEnvironment(
      { NODE_ENV: "production", MINIME_MOCK_OLLAMA: "1" },
      APP_URL,
    );
    expect(production.NODE_ENV).toBeUndefined();
    expect(production.MINIME_MOCK_OLLAMA).toBeUndefined();
    const invalidMock = runtimeChildEnvironment(
      { NODE_ENV: "test", MINIME_MOCK_OLLAMA: "0" },
      APP_URL,
    );
    expect(invalidMock.NODE_ENV).toBe("test");
    expect(invalidMock.MINIME_MOCK_OLLAMA).toBeUndefined();
    const unpaired = runtimeChildEnvironment({ MINIME_MOCK_OLLAMA: "1" }, APP_URL);
    expect(unpaired.NODE_ENV).toBeUndefined();
    expect(unpaired.MINIME_MOCK_OLLAMA).toBeUndefined();
  });

  test("exact mock mode strips cloud credentials even when cloud routes are configured", () => {
    const child = runtimeChildEnvironment(
      {
        NODE_ENV: "test",
        MINIME_MOCK_OLLAMA: "1",
        EMBED_PROVIDER: "openai",
        CLASSIFY_PROVIDER: "bedrock",
        PROVIDER_ROUTE_TIER2: "anthropic",
        OPENAI_API_KEY: "unused-openai-key",
        ANTHROPIC_API_KEY: "unused-anthropic-key",
        BEDROCK_AWS_ACCESS_KEY_ID: "unused-bedrock-id",
        BEDROCK_AWS_SECRET_ACCESS_KEY: "unused-bedrock-secret",
        BEDROCK_AWS_REGION: "unused-bedrock-region",
      },
      APP_URL,
    );
    expect(child.OPENAI_API_KEY).toBeUndefined();
    expect(child.ANTHROPIC_API_KEY).toBeUndefined();
    expect(child.BEDROCK_AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(child.BEDROCK_AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(child.BEDROCK_AWS_REGION).toBeUndefined();
    expect(() => assertRuntimeChildBoundary(child)).not.toThrow();
  });

  test("a Bun child started with the closed environment does not gain ambient variables", () => {
    const child = runtimeChildEnvironment({ NODE_ENV: "test" }, APP_URL);
    const proc = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        'import { assertRuntimeChildBoundary } from "./src/serve"; assertRuntimeChildBoundary();',
      ],
      {
        cwd: resolve(import.meta.dir, ".."),
        env: child,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(proc.exitCode).toBe(0);
    expect(proc.stderr.toString()).toBe("");
  });

  test("Bedrock IAM is forwarded only when the runtime model route explicitly needs it", () => {
    const child = runtimeChildEnvironment(
      {
        CLASSIFY_PROVIDER: "bedrock",
        BEDROCK_MODEL: "fictional.model-v1",
        BEDROCK_AWS_ACCESS_KEY_ID: "bedrock-access-key",
        BEDROCK_AWS_SECRET_ACCESS_KEY: "bedrock-secret-key",
        BEDROCK_AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "backup-access-key",
        AWS_SECRET_ACCESS_KEY: "backup-secret-key",
        B2_ACCOUNT_KEY: "backup-only-key",
      },
      APP_URL,
    );
    expect(child.BEDROCK_AWS_ACCESS_KEY_ID).toBe("bedrock-access-key");
    expect(child.BEDROCK_AWS_SECRET_ACCESS_KEY).toBe("bedrock-secret-key");
    expect(child.BEDROCK_AWS_REGION).toBe("us-east-1");
    expect(child.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(child.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(child.B2_ACCOUNT_KEY).toBeUndefined();
    expect(() => assertRuntimeChildBoundary(child)).not.toThrow();
  });

  test("Bedrock route refuses shared or ambient AWS backup credentials", () => {
    expect(() =>
      runtimeChildEnvironment(
        {
          CLASSIFY_PROVIDER: "bedrock",
          AWS_ACCESS_KEY_ID: "shared-access-key",
          AWS_SECRET_ACCESS_KEY: "shared-secret-key",
          AWS_REGION: "us-east-1",
        },
        APP_URL,
      ),
    ).toThrow("runtime_provider_credentials_required");
  });

  test("tier-2 local routing excludes cloud fallback and tier-1 dream credentials", () => {
    const routes = {
      CLASSIFY_PROVIDER: "anthropic",
      PROVIDER_ROUTE_TIER1: "openai",
      PROVIDER_ROUTE_TIER2: "ollama",
    };
    expect(() => runtimeChildEnvironment(routes, APP_URL)).not.toThrow();

    const child = runtimeChildEnvironment(
      {
        ...routes,
        OPENAI_API_KEY: "owner-dream-key",
        ANTHROPIC_API_KEY: "unreachable-fallback-key",
      },
      APP_URL,
    );

    expect(child.OPENAI_API_KEY).toBeUndefined();
    expect(child.ANTHROPIC_API_KEY).toBeUndefined();
    expect(() => assertRuntimeChildBoundary(child)).not.toThrow();
    expect(() =>
      assertRuntimeChildBoundary({
        ...child,
        ANTHROPIC_API_KEY: "injected-unreachable-key",
      }),
    ).toThrow("runtime_child_boundary_invalid");
  });

  test("cloud ceiling excludes an implicit fallback that no runtime classify job can reach", () => {
    const child = runtimeChildEnvironment(
      {
        CLASSIFY_PROVIDER: "bedrock",
        CLOUD_MAX_TIER: "1",
        PROVIDER_ROUTE_TIER1: "ollama",
        BEDROCK_AWS_ACCESS_KEY_ID: "unreachable-access-key",
        BEDROCK_AWS_SECRET_ACCESS_KEY: "unreachable-secret-key",
        BEDROCK_AWS_REGION: "us-east-1",
      },
      APP_URL,
    );

    expect(child.BEDROCK_AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(child.BEDROCK_AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(child.BEDROCK_AWS_REGION).toBeUndefined();
    expect(() => assertRuntimeChildBoundary(child)).not.toThrow();
  });

  test("reachable classify fallback still requires its dedicated credential", () => {
    expect(() =>
      runtimeChildEnvironment(
        {
          CLASSIFY_PROVIDER: "anthropic",
          CLOUD_MAX_TIER: "2",
          PROVIDER_ROUTE_TIER1: "ollama",
        },
        APP_URL,
      ),
    ).toThrow("runtime_provider_credentials_required");
  });

  test("embedding credentials remain independent of classify reachability and cloud ceiling", () => {
    expect(() =>
      runtimeChildEnvironment(
        {
          EMBED_PROVIDER: "openai",
          CLASSIFY_PROVIDER: "anthropic",
          CLOUD_MAX_TIER: "0",
        },
        APP_URL,
      ),
    ).toThrow("runtime_provider_credentials_required");

    const child = runtimeChildEnvironment(
      {
        EMBED_PROVIDER: "openai",
        CLASSIFY_PROVIDER: "anthropic",
        CLOUD_MAX_TIER: "0",
        OPENAI_API_KEY: "embed-key",
        ANTHROPIC_API_KEY: "blocked-classify-key",
      },
      APP_URL,
    );
    expect(child.OPENAI_API_KEY).toBe("embed-key");
    expect(child.ANTHROPIC_API_KEY).toBeUndefined();
    expect(() => assertRuntimeChildBoundary(child)).not.toThrow();
  });

  test("an explicit cloud classify route above the ceiling fails closed", () => {
    expect(() =>
      runtimeChildEnvironment(
        {
          CLOUD_MAX_TIER: "1",
          PROVIDER_ROUTE_TIER2: "openrouter",
          OPENROUTER_API_KEY: "must-not-be-forwarded",
        },
        APP_URL,
      ),
    ).toThrow("runtime_child_boundary_invalid");
  });

  test("malformed provider names are rejected before credentials can enter the child", () => {
    for (const source of [
      { EMBED_PROVIDER: "OpenAI", OPENAI_API_KEY: "must-not-forward" },
      { EMBED_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "must-not-forward" },
      {
        EMBED_PROVIDER: "bedrock",
        BEDROCK_AWS_ACCESS_KEY_ID: "must-not-forward",
        BEDROCK_AWS_SECRET_ACCESS_KEY: "must-not-forward",
        BEDROCK_AWS_REGION: "must-not-forward",
      },
      {
        CLASSIFY_PROVIDER: "openai ",
        PROVIDER_ROUTE_TIER2: "ollama",
        OPENAI_API_KEY: "must-not-forward",
      },
      { PROVIDER_ROUTE_TIER1: " openai", OPENAI_API_KEY: "must-not-forward" },
      { PROVIDER_ROUTE_TIER2: "OPENAI", OPENAI_API_KEY: "must-not-forward" },
      { PROVIDER_ROUTE_TIER2: "", OPENAI_API_KEY: "must-not-forward" },
    ]) {
      let error: unknown;
      try {
        runtimeChildEnvironment(source, APP_URL);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("runtime_child_boundary_invalid");
      expect((error as Error).message).not.toContain("must-not-forward");
    }
  });

  test("private runtime command fails closed without the supervisor marker and exact app DSN", () => {
    const valid = runtimeChildEnvironment({}, APP_URL);
    const invalid = [
      { ...valid, MINIME_RUNTIME_CHILD: undefined },
      { ...valid, DATABASE_URL: "postgres://minime:minime@127.0.0.1:5432/minime" },
      { ...valid, MINIME_APP_PASSWORD: "duplicate-secret" },
      { ...valid, RESTIC_REPOSITORY: "/private/backups" },
      { ...valid, AMBIENT_TOKEN: "ambient-secret" },
      { ...valid, NODE_OPTIONS: "--require=/private/ambient-hook.js" },
      { ...valid, HTTP_PROXY: "http://proxy.example.test" },
      { ...valid, HTTPS_PROXY: "http://proxy.example.test" },
      { ...valid, ALL_PROXY: "socks5://proxy.example.test" },
      { ...valid, NO_PROXY: "localhost" },
      { ...valid, RERANK_DEBUG: "query-content" },
      { ...valid, NODE_ENV: "production" },
      { ...valid, MINIME_MOCK_OLLAMA: "1" },
      { ...valid, NODE_ENV: "test", MINIME_MOCK_OLLAMA: "0" },
      {
        ...valid,
        DATABASE_URL: APP_URL.replace("localhost", "database.example.test"),
        MINIME_APP_DATABASE_URL: APP_URL.replace("localhost", "database.example.test"),
      },
    ];
    for (const env of invalid) {
      expect(() => assertRuntimeChildBoundary(env)).toThrow("runtime_child_boundary_invalid");
    }
  });

  test("supervisor wires both maintenance jobs to the configured timezone", async () => {
    const original = {
      processTz: process.env.TZ,
      configTz: config.tz,
      dreamCron: config.dreamCron,
      backupCron: config.backupCron,
      resticRepository: config.resticRepository,
      resticPasswordFile: config.resticPasswordFile,
    };
    const registrations: Array<{ pattern: string; timezone: string }> = [];
    let schedule: ReturnType<typeof startOwnerMaintenanceSchedule> | undefined;
    try {
      process.env.TZ = "Etc/UTC";
      config.tz = "Asia/Singapore";
      config.dreamCron = "1 2 * * *";
      config.backupCron = "3 4 * * *";
      config.resticRepository = "test:repository";
      config.resticPasswordFile = "/test/restic-password";

      schedule = startOwnerMaintenanceSchedule((pattern, options) => {
        registrations.push({ pattern, timezone: options.timezone });
        return { nextRun: () => null, stop: () => {} };
      });

      expect(process.env.TZ).toBe("Etc/UTC");
      expect(registrations).toEqual([
        { pattern: "1 2 * * *", timezone: "Asia/Singapore" },
        { pattern: "3 4 * * *", timezone: "Asia/Singapore" },
      ]);
    } finally {
      await schedule?.close();
      if (original.processTz === undefined) process.env.TZ = undefined;
      else process.env.TZ = original.processTz;
      config.tz = original.configTz;
      config.dreamCron = original.dreamCron;
      config.backupCron = original.backupCron;
      config.resticRepository = original.resticRepository;
      config.resticPasswordFile = original.resticPasswordFile;
    }
  });

  test("MCP-reachable child has no cron while its non-MCP supervisor owns maintenance", () => {
    const cli = readFileSync(resolve(import.meta.dir, "..", "src", "cli.ts"), "utf8");
    const serve = readFileSync(resolve(import.meta.dir, "..", "src", "serve.ts"), "utf8");
    expect(cli).toContain('case "serve:runtime"');
    expect(cli).toContain("server.closed.then(() => stop(0))");
    expect(cli).toContain("runtimeChildEnvironment(process.env, config.runtimeDatabaseUrl)");
    expect(cli).toContain("spawnRuntimeChild(config.runtimeDatabaseUrl)");
    const runtimeBlock = cli.split('case "serve:runtime"')[1]?.split('case "audit"')[0] ?? "";
    expect(runtimeBlock).not.toContain("new Cron");
    expect(runtimeBlock).not.toContain("dbSnapshot");
    expect(runtimeBlock).not.toContain("dream(");
    expect(serve).toContain("startOwnerMaintenanceSchedule");
    expect(serve).toContain('"--no-env-file"');
    expect(serve).toContain('run("dream", () => withAdminDbScope(() => dream()))');
    expect(serve).toContain('run("db snapshot", dbSnapshot)');
  });
});
