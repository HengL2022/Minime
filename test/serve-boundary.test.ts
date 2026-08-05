import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { buildServer } from "../src/mcp/server";
import { assertRuntimeChildBoundary, runtimeChildEnvironment } from "../src/serve";

const APP_URL = "postgres://minime_app:fictional_runtime_password_20260805@127.0.0.1:5432/minime";
const OWNER_URL = "postgres://minime:fictional_owner_password@localhost:5432/minime";

function runServe(env: Record<string, string>) {
  const proc = Bun.spawnSync(["bun", "run", "src/cli.ts", "serve"], {
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
      [OWNER_URL, APP_URL.replace("127.0.0.1:5432", "127.0.0.1:5433")],
      [OWNER_URL, APP_URL.replace("/minime", "/minime_test")],
      ["postgres://minime:fictional@database.example.test:5432/minime", APP_URL],
      ["postgres://minime_app:fictional@localhost:5432/minime", APP_URL],
    ] as const) {
      const result = runServe({ DATABASE_URL: owner, MINIME_APP_DATABASE_URL: runtime });
      expect(result.code).toBe(40);
      expect(result.out).toContain("ERROR: restricted runtime app role is not configured");
      expect(result.out).not.toContain("fictional");
    }
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
        OPENAI_API_KEY: "provider-key",
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
    ]) {
      expect(child[name]).toBeUndefined();
    }
    expect(JSON.stringify(child)).not.toContain("owner-secret");
    expect(JSON.stringify(child)).not.toContain("backup-secret-key");
    expect(() => assertRuntimeChildBoundary(child)).not.toThrow();
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
    ).toThrow("runtime_bedrock_credentials_required");
  });

  test("private runtime command fails closed without the supervisor marker and exact app DSN", () => {
    const valid = runtimeChildEnvironment({}, APP_URL);
    const invalid = [
      { ...valid, MINIME_RUNTIME_CHILD: undefined },
      { ...valid, DATABASE_URL: "postgres://minime:minime@127.0.0.1:5432/minime" },
      { ...valid, MINIME_APP_PASSWORD: "duplicate-secret" },
      { ...valid, RESTIC_REPOSITORY: "/private/backups" },
      {
        ...valid,
        DATABASE_URL: APP_URL.replace("127.0.0.1", "database.example.test"),
        MINIME_APP_DATABASE_URL: APP_URL.replace("127.0.0.1", "database.example.test"),
      },
    ];
    for (const env of invalid) {
      expect(() => assertRuntimeChildBoundary(env)).toThrow("runtime_child_boundary_invalid");
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
    expect(serve).toContain('run("dream", () => withAdminDbScope(() => dream()))');
    expect(serve).toContain('run("db snapshot", dbSnapshot)');
  });
});
