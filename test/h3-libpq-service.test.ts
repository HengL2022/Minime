import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  LIBPQ_SERVICE_NAME,
  __setServiceAbsenceProbeForTest,
  createLibpqService,
  parsePostgresUri,
  renderLibpqService,
  writeLibpqServiceFile,
} from "../src/util/libpq-service";
import { __setAfterServiceOpenForTest } from "../src/util/libpq-service";
import { activeTestDatabaseName, testDatabaseUrl } from "./setup";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("private libpq service handoff", () => {
  test("URI structural/query fields become individual parameters with last query value", () => {
    const parsed = parsePostgresUri(
      "postgresql://user:p%40ss@host1:5432,host2:5433/db%2Dname" +
        "?sslmode=require&application_name=first&application_name=last",
    );
    expect(Object.fromEntries(parsed)).toEqual({
      host: "host1,host2",
      port: "5432,5433",
      user: "user",
      password: "p@ss",
      dbname: "db-name",
      sslmode: "require",
      application_name: "last",
    });
    expect(renderLibpqService(parsed)).toContain(
      "[minime_ephemeral]\nhost=host1,host2\nport=5432,5433\n",
    );
  });

  test("ssl=true normalizes to libpq sslmode=require with source-order last wins", () => {
    const first = parsePostgresUri("postgresql://user:pass@localhost/db?ssl=true");
    expect(Object.fromEntries(first)).toMatchObject({ sslmode: "require" });
    expect(first.has("ssl")).toBe(false);
    expect(renderLibpqService(first)).toContain("sslmode=require\n");
    expect(renderLibpqService(first)).not.toContain("ssl=require\n");

    expect(
      Object.fromEntries(
        parsePostgresUri("postgresql://user:pass@localhost/db?ssl=true&sslmode=verify-full"),
      ),
    ).toMatchObject({ sslmode: "verify-full" });
    expect(
      Object.fromEntries(
        parsePostgresUri("postgresql://user:pass@localhost/db?sslmode=verify-full&ssl=true"),
      ),
    ).toMatchObject({ sslmode: "require" });
    expect(renderLibpqService(new Map([["ssl", "true"]]))).toContain("sslmode=require\n");
  });

  test("ssl=true service handoff is pg_dump-compatible without a URL option", async () => {
    const lease = await createLibpqService(`${testDatabaseUrl()}?ssl=true`);
    try {
      const service = readFileSync(lease.serviceFile, "utf8");
      expect(service).toContain("sslmode=require\n");
      expect(service).not.toContain("ssl=require\n");
      expect(service).not.toContain("postgres://");
    } finally {
      await lease.dispose();
    }
  });

  test("empty-authority libpq URIs retain dbname and decoded Unix-socket host", () => {
    expect(
      Object.fromEntries(parsePostgresUri("postgresql:///db?host=%2Fvar%2Frun%2Fpostgresql")),
    ).toEqual({ dbname: "db", host: "/var/run/postgresql" });
    expect(Object.fromEntries(parsePostgresUri("postgresql:///db"))).toEqual({ dbname: "db" });
    expect(() => parsePostgresUri("postgresql://:5432/db")).toThrow(
      expect.objectContaining({ rule: "syntax" }),
    );
  });

  test.each([
    { name: "scheme", raw: "mysql://user:pass@localhost/db" },
    { name: "nested service", raw: "postgres://user:pass@localhost/db?service=other" },
    {
      name: "nested servicefile",
      raw: "postgres://user:pass@localhost/db?servicefile=%2Ftmp%2Fx",
    },
    { name: "decoded newline", raw: "postgres://user:pass%0Ahost=remote@localhost/db" },
    { name: "edge whitespace", raw: "postgres://user:pass@localhost/%20db" },
    {
      name: "decoded tab",
      raw: "postgres://user:pass@localhost/db?application_name=%09bad",
    },
  ])("rejects $name URI without echoing it", ({ raw }) => {
    let message = "";
    try {
      parsePostgresUri(raw);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBeTruthy();
    expect(message).not.toContain(raw);
    expect(message).not.toContain("pass");
  });

  test("exclusive service-file writer creates mode 0600 beneath a private directory", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-h3-service-write-")));
    roots.push(root);
    const serviceFile = join(root, "pg_service.conf");
    await writeLibpqServiceFile(
      "postgres://fictional:secret@localhost:5432/minime_test",
      serviceFile,
    );
    expect(statSync(serviceFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(serviceFile, "utf8")).toContain(`[${LIBPQ_SERVICE_NAME}]`);
    expect(readFileSync(serviceFile, "utf8")).not.toContain("postgres://");
    await expect(
      writeLibpqServiceFile("postgres://fictional:secret@localhost:5432/minime_test", serviceFile),
    ).rejects.toThrow();
  });

  test("exclusive writer preserves a foreign regular-file collision", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-h3-service-collision-file-")));
    roots.push(root);
    const serviceFile = join(root, "pg_service.conf");
    writeFileSync(serviceFile, "foreign sentinel\n", { mode: 0o640 });
    const before = statSync(serviceFile).mode & 0o777;
    await expect(
      writeLibpqServiceFile("postgres://user:pass@localhost/db", serviceFile),
    ).rejects.toThrow();
    expect(readFileSync(serviceFile, "utf8")).toBe("foreign sentinel\n");
    expect(statSync(serviceFile).mode & 0o777).toBe(before);
  });

  test("exclusive writer preserves a foreign symlink collision and its target", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-h3-service-collision-link-")));
    roots.push(root);
    const target = join(root, "target");
    const serviceFile = join(root, "pg_service.conf");
    writeFileSync(target, "foreign target\n", { mode: 0o640 });
    symlinkSync(target, serviceFile);
    await expect(
      writeLibpqServiceFile("postgres://user:pass@localhost/db", serviceFile),
    ).rejects.toThrow();
    expect(readFileSync(serviceFile, "utf8")).toBe("foreign target\n");
    expect(readFileSync(target, "utf8")).toBe("foreign target\n");
    expect(statSync(target).mode & 0o777).toBe(0o640);
  });

  test("post-open write failure removes only the newly owned partial file", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-h3-service-post-open-")));
    roots.push(root);
    const serviceFile = join(root, "pg_service.conf");
    const neighbor = join(root, "neighbor");
    writeFileSync(neighbor, "foreign neighbor\n", { mode: 0o640 });
    __setAfterServiceOpenForTest(() => {
      throw new Error("injected write failure");
    });
    try {
      await expect(
        writeLibpqServiceFile("postgres://user:pass@localhost/db", serviceFile),
      ).rejects.toThrow();
    } finally {
      __setAfterServiceOpenForTest(undefined);
    }
    expect(existsSync(serviceFile)).toBe(false);
    expect(readFileSync(neighbor, "utf8")).toBe("foreign neighbor\n");
  });

  test("query keys normalize case before validation and nested services remain rejected", () => {
    expect(
      Object.fromEntries(parsePostgresUri("postgres://u:p@localhost/db?SSLMODE=require")),
    ).toEqual({
      host: "localhost",
      user: "u",
      password: "p",
      dbname: "db",
      sslmode: "require",
    });
    expect(() => parsePostgresUri("postgres://u:p@localhost/db?SERVICE=other")).toThrow(
      expect.objectContaining({ rule: "nested_service" }),
    );
    expect(() => parsePostgresUri("postgres://u:p@localhost/db?SERVICEFILE=/tmp/x")).toThrow(
      expect.objectContaining({ rule: "nested_service" }),
    );
    expect(renderLibpqService(new Map([["SSLMODE", "require"]]))).toContain("sslmode=require\n");
    expect(() => renderLibpqService(new Map([["SERVICE", "other"]]))).toThrow(
      expect.objectContaining({ rule: "nested_service" }),
    );
  });

  test("rendered service lines enforce libpq's exact UTF-8 byte boundary", () => {
    const key = "application_name";
    const fixedBytes = Buffer.byteLength(`${key}=\n`, "utf8");
    const acceptedValue = "x".repeat(1022 - fixedBytes);
    const acceptedLine = `${key}=${acceptedValue}\n`;
    expect(Buffer.byteLength(acceptedLine, "utf8")).toBe(1022);
    expect(renderLibpqService(new Map([[key, acceptedValue]]))).toContain(acceptedLine);
    const rejectedValue = `${acceptedValue}x`;
    expect(Buffer.byteLength(`${key}=${rejectedValue}\n`, "utf8")).toBe(1023);
    expect(() => renderLibpqService(new Map([[key, rejectedValue]]))).toThrow(
      expect.objectContaining({ rule: "line_too_long" }),
    );
    const multibyte = "é".repeat(Math.ceil((1023 - fixedBytes) / 2));
    expect(Buffer.byteLength(`${key}=${multibyte}\n`, "utf8")).toBeGreaterThan(1022);
    expect(() => renderLibpqService(new Map([[key, multibyte]]))).toThrow(
      expect.objectContaining({ rule: "line_too_long" }),
    );
  });

  test("real pg_dump selects PGSERVICEFILE and succeeds with hostile PGDATABASE", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-h3-real-pgdump-")));
    roots.push(root);
    const out = join(root, "schema.sql");
    const isolatedTestUrl = testDatabaseUrl();
    const isolated = new URL(isolatedTestUrl);
    if (isolated.pathname === "/minime" || isolated.pathname !== `/${activeTestDatabaseName()}`) {
      throw new Error("real pg_dump fixture refused unguarded database");
    }
    expect(isolated.pathname).toBe(`/${activeTestDatabaseName()}`);
    const lease = await createLibpqService(isolatedTestUrl);
    const serviceText = readFileSync(lease.serviceFile, "utf8");
    expect(serviceText).toContain(`dbname=${activeTestDatabaseName()}\n`);
    expect(serviceText).not.toContain("dbname=minime\n");
    const argv = ["pg_dump", "--schema-only", "--no-owner", "--no-password", "-f", out];
    expect(argv.join(" ")).not.toContain(isolatedTestUrl);
    expect(statSync(lease.directory).mode & 0o777).toBe(0o700);
    expect(statSync(lease.serviceFile).mode & 0o777).toBe(0o600);
    try {
      const proc = Bun.spawnSync(argv, {
        env: lease.env({
          ...process.env,
          PGDATABASE: "postgres://invalid:invalid@127.0.0.1:1/not_a_database",
          PGHOST: "203.0.113.10",
          PGPORT: "1",
          PGUSER: "invalid-user",
          PGPASSWORD: "invalid-password",
        }),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);
      expect(readFileSync(out, "utf8")).toContain("PostgreSQL database dump");
    } finally {
      await lease.dispose();
    }
    expect(existsSync(lease.directory)).toBe(false);
  });

  test("lease creation failure and explicit disposal leave no service directory", async () => {
    const before = new Set(
      readdirSync(tmpdir()).filter((name) => name.startsWith("minime-libpq-")),
    );
    await expect(createLibpqService("postgres://bad%0Auser@localhost/db")).rejects.toThrow();
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("minime-libpq-"));
    expect(after.filter((name) => !before.has(name))).toEqual([]);
  });

  test("registers the physicalized lease before validation and the first await", () => {
    const source = readFileSync(join(import.meta.dir, "../src/util/libpq-service.ts"), "utf8");
    const createStart = source.indexOf("export async function createLibpqService");
    expect(createStart).toBeGreaterThanOrEqual(0);
    const createBody = source.slice(createStart);
    const physicalize = createBody.indexOf(
      'directory = realpathSync(mkdtempSync(join(tmpdir(), "minime-libpq-")));',
    );
    const register = createBody.indexOf("unregistered = registerEphemeralCleanup(directory");
    const hook = createBody.indexOf("afterLeaseRegisterForTest?.(directory)");
    const chmod = createBody.indexOf("chmodSync(directory, 0o700);");
    const stat = createBody.indexOf("const info = statSync(directory);");
    const firstAwait = createBody.indexOf("await ", physicalize);

    expect(physicalize).toBeGreaterThanOrEqual(0);
    expect(register).toBeGreaterThan(physicalize);
    expect(register).toBeLessThan(hook);
    expect(hook).toBeLessThan(chmod);
    expect(chmod).toBeLessThan(stat);
    expect(register).toBeLessThan(firstAwait);
  });

  test("non-ENOENT absence verification keeps a lease registered", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-h3-service-mask-")));
    roots.push(root);
    const lease = await createLibpqService("postgres://user:pass@localhost/minime_test");
    __setServiceAbsenceProbeForTest(() => {
      const error = new Error("masked");
      Object.assign(error, { code: "EACCES" });
      throw error;
    });
    try {
      await expect(lease.dispose()).rejects.toThrow();
      expect(existsSync(lease.directory)).toBe(false);
    } finally {
      __setServiceAbsenceProbeForTest(undefined);
      await lease.dispose();
    }
  });

  test("SIGTERM synchronously removes active credentials then preserves exit 143", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-h3-signal-")));
    roots.push(root);
    const ready = join(root, "ready");
    const raw = "postgres://signal-user:credential-sentinel@localhost:5432/minime_test";
    const moduleUrl = pathToFileURL(join(import.meta.dir, "../src/util/libpq-service.ts")).href;
    const childScript = `
      import { writeFileSync } from "node:fs";
      const mod = await import(${JSON.stringify(moduleUrl)});
      const lease = await mod.createLibpqService(process.env.H3_DATABASE_URL);
      writeFileSync(process.env.H3_READY, lease.directory, { mode: 0o600 });
      setInterval(() => {}, 1_000);
    `;
    const proc = Bun.spawn(["bun", "-e", childScript], {
      env: { ...process.env, H3_DATABASE_URL: raw, H3_READY: ready },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(proc.stdout).text();
    const stderr = new Response(proc.stderr).text();
    try {
      for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt += 1) await Bun.sleep(10);
      expect(existsSync(ready)).toBe(true);
      const leaseDir = readFileSync(ready, "utf8");
      expect(statSync(leaseDir).mode & 0o777).toBe(0o700);
      expect(existsSync(join(leaseDir, "pg_service.conf"))).toBe(true);
      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(143);
      expect(existsSync(leaseDir)).toBe(false);
    } finally {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }
    const output = `${await stdout}\n${await stderr}`;
    expect(output).not.toContain(raw);
    expect(output).not.toContain("credential-sentinel");
  });

  test("SIGTERM at the first post-create hook removes the empty directory and exits 143", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-h3-lease-register-signal-")));
    const ready = join(root, "ready");
    const moduleUrl = pathToFileURL(join(import.meta.dir, "../src/util/libpq-service.ts")).href;
    const childScript = `
      import { writeFileSync } from "node:fs";
      const mod = await import(${JSON.stringify(moduleUrl)});
      mod.__setAfterLeaseRegisterForTest((directory) => {
        writeFileSync(process.env.H3_READY, directory, { mode: 0o600 });
        process.kill(process.pid, "SIGTERM");
      });
      await mod.createLibpqService("postgres://signal-user:credential-sentinel@localhost/minime_test");
    `;
    const proc = Bun.spawn(["bun", "-e", childScript], {
      cwd: root,
      env: { ...process.env, H3_READY: ready },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      expect(await Promise.race([proc.exited, Bun.sleep(5_000).then(() => -1)])).toBe(143);
      expect(existsSync(ready)).toBe(true);
      const leaseDir = readFileSync(ready, "utf8");
      expect(leaseDir).toMatch(/\/minime-libpq-[^/]+$/);
      expect(existsSync(leaseDir)).toBe(false);
    } finally {
      if (proc.exitCode === null) proc.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function invokeBridge(
    output: string,
  ): Promise<{ code: number | null; out: string; err: string }> {
    const proc = Bun.spawn(
      ["bun", "run", join(import.meta.dir, "../scripts/libpq-service.ts"), output],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    proc.stdin.write("postgres://bridge-user:bridge-credential@localhost/minime_test");
    proc.stdin.end();
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out, err };
  }

  test("public bridge rejects a symlinked output parent before stdin/temp/link", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-h3-bridge-parent-link-")));
    roots.push(root);
    const physical = join(root, "physical");
    const alias = join(root, "alias");
    mkdirSync(physical, { mode: 0o700 });
    symlinkSync(physical, alias, "dir");
    const result = await invokeBridge(join(alias, "service.conf"));
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toBe(
      "ERROR: could not create private PostgreSQL service file (output_parent).\n",
    );
    expect(readdirSync(physical)).toEqual([]);
    expect(result.err).not.toContain("bridge-credential");
  });

  test("public bridge rejects a world-readable output parent before stdin/temp/link", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-h3-bridge-parent-mode-")));
    roots.push(root);
    const parent = join(root, "world-readable");
    mkdirSync(parent, { mode: 0o755 });
    chmodSync(parent, 0o755);
    const result = await invokeBridge(join(parent, "service.conf"));
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toBe(
      "ERROR: could not create private PostgreSQL service file (output_parent).\n",
    );
    expect(readdirSync(parent)).toEqual([]);
    expect(result.err).not.toContain("bridge-credential");
  });
});
