import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const realGit = Bun.which("git")!;
const realBun = process.execPath;
const roots: string[] = [];
const scratchDatabaseUrl = process.env.DATABASE_URL!;
const psqlBinary = Bun.which("psql") ?? "psql";

function normalizeLoopbackHost(hostname: string): string | undefined {
  const normalized = hostname === "[::1]" ? "::1" : hostname;
  return ["localhost", "127.0.0.1", "::1"].includes(normalized) ? normalized : undefined;
}

function scratchPsql(statement: string): string {
  const url = new URL(scratchDatabaseUrl);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  const host = normalizeLoopbackHost(url.hostname);
  if (!host || !/^minime_test_[a-z0-9_]+$/.test(databaseName)) {
    throw new Error("test_database_target");
  }
  const result = spawnSync(psqlBinary, ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"], {
    env: {
      PATH: "/usr/bin:/bin",
      LC_ALL: "C",
      LANG: "C",
      PGCONNECT_TIMEOUT: "3",
      PGHOST: host,
      PGPORT: url.port || "5432",
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: databaseName,
    },
    input: `do $$ begin if current_database() <> '${databaseName}' then raise exception 'test_database_target'; end if; end $$;\n${statement}`,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error("test_database_sql");
  }
  return result.stdout;
}

function resetScratchMigration(): void {
  scratchPsql("delete from schema_migrations where name = '021_runtime_app_role.sql';\n");
}

function scratchMigrationCount(): number {
  return Number(
    scratchPsql(
      "select count(*)::int from schema_migrations where name = '021_runtime_app_role.sql';\n",
    ).trim(),
  );
}

type Driver = {
  clone: string;
  trace: string;
  setBackupExit(code: 0 | 1 | 3): void;
  run(): Bun.SyncSubprocess<"pipe", "pipe">;
};

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync([realGit, "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git failed: ${args.join(" ")}\n${result.stderr.toString()}`);
  }
  return result;
}

function commit(cwd: string, message: string): string {
  git(cwd, "add", ".");
  git(
    cwd,
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=Test",
    "commit",
    "-qm",
    message,
  );
  return git(cwd, "rev-parse", "HEAD").stdout.toString().trim();
}

function makeDriver(migrationBody = "select 1;\n"): Driver {
  resetScratchMigration();
  const root = mkdtempSync(join(tmpdir(), "minime-update-bootstrap-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  git(root, "init", "--bare", "-q", origin);
  git(seed, "remote", "add", "origin", origin);

  const commitAScript = `#!/bin/bash
set -eu
git fetch origin --quiet
git pull --ff-only --quiet
bun install --frozen-lockfile
bun run src/cli.ts backup:pre-update || true
bun run src/cli.ts migrate
`;
  mkdirSync(join(seed, "scripts"), { recursive: true });
  writeFileSync(join(seed, "scripts", "update.sh"), commitAScript, { mode: 0o700 });
  writeFileSync(join(seed, "tracked.txt"), "commit-a\n");
  const commitA = commit(seed, "commit A");
  git(seed, "push", "-q", "-u", "origin", "main");

  writeFileSync(join(seed, "scripts", "update.sh"), readFileSync(join(REPO, "scripts/update.sh")), {
    mode: 0o700,
  });
  mkdirSync(join(seed, "src", "db"), { recursive: true });
  writeFileSync(
    join(seed, "src", "db", "migration-context.ts"),
    readFileSync(join(REPO, "src/db/migration-context.ts")),
  );
  writeFileSync(
    join(seed, "src", "cli.ts"),
    `import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseMigrationCliContext } from "./db/migration-context";
const cmd = process.argv[2];
if (cmd !== "migrate") process.exit(0);
let context;
try { context = parseMigrationCliContext(process.argv.slice(3)); } catch { process.exit(50); }
if (context.kind !== "update") process.exit(50);
const migration = "021_runtime_app_role.sql";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) process.exit(50);
const url = new URL(databaseUrl);
const databaseName = decodeURIComponent(url.pathname.slice(1));
const host = url.hostname === "[::1]" ? "::1" : url.hostname;
if (!["localhost", "127.0.0.1", "::1"].includes(host) || !/^minime_test_[a-z0-9_]+$/.test(databaseName)) process.exit(50);
const psqlEnv = {
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  LANG: "C",
  PGCONNECT_TIMEOUT: "3",
  PGHOST: host,
  PGPORT: url.port || "5432",
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: databaseName,
};
const psqlBinary = process.env.MINIME_TEST_PSQL || "psql";
const sql = (statement) => spawnSync(psqlBinary, ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"], { env: psqlEnv, input: "do $$ begin if current_database() <> '" + databaseName + "' then raise exception 'test_database_target'; end if; end $$;\\n" + statement, encoding: "utf8" });
const existing = sql("select count(*)::int from schema_migrations where name = '021_runtime_app_role.sql';\\n");
if (existing.status !== 0) process.exit(50);
const existingCount = existing.stdout.trim();
if (existingCount === "1") process.exit(0);
if (existingCount !== "0") process.exit(50);
const body = readFileSync(join(process.cwd(), "db", "migrations", migration), "utf8");
const applied = sql("begin;\\n" + body + "\\ninsert into schema_migrations (name) values ('021_runtime_app_role.sql');\\ncommit;\\n");
if (applied.status !== 0) process.exit(50);
process.exit(0);
`,
  );
  mkdirSync(join(seed, "db", "migrations"), { recursive: true });
  writeFileSync(join(seed, "db", "migrations", "021_runtime_app_role.sql"), migrationBody);
  writeFileSync(join(seed, "tracked.txt"), "commit-b\n");
  const commitB = commit(seed, "commit B");
  git(seed, "push", "-q", "origin", "main");

  git(root, "clone", "-q", "-b", "main", origin, clone);
  git(clone, "reset", "--hard", "-q", commitA);
  expect(commitB).not.toBe(commitA);

  const trace = join(root, "trace");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const homeBunBin = join(root, "home", ".bun", "bin");
  mkdirSync(homeBunBin, { recursive: true });
  const state = join(root, "backup-exit");
  writeFileSync(state, "1\n");
  writeFileSync(
    join(bin, "git"),
    `#!/bin/bash
set -eu
if [ "\${1:-}" = status ]; then echo preflight >> "$TRACE_FILE"; fi
if [ "\${1:-}" = fetch ]; then echo fetch >> "$TRACE_FILE"; fi
if [ "\${1:-}" = pull ]; then echo pull >> "$TRACE_FILE"; fi
exec "$REAL_GIT" "$@"
`,
    { mode: 0o700 },
  );
  const bunWrapper = `#!/bin/bash
set -eu
if [ "\${1:-}" = install ]; then echo install >> "$TRACE_FILE"; exit 0; fi
if [ "\${1:-}" = test ]; then echo verify >> "$TRACE_FILE"; exit 0; fi
if [ "\${1:-}" = run ] && [ "\${2:-}" = src/cli.ts ]; then
  case "\${3:-}" in
    backup:pre-update)
      code=$(cat "$BACKUP_EXIT_FILE")
      if [ "$code" -eq 1 ]; then echo backup_failed >> "$TRACE_FILE"; else echo backup >> "$TRACE_FILE"; fi
      exit "$code"
      ;;
    migrate)
      if [ "\${4:-}" = "--context" ]; then echo "migrate:update:\${7:-}" >> "$TRACE_FILE"; else echo migrate_refused >> "$TRACE_FILE"; fi
      exec "$REAL_BUN" run src/cli.ts "\${@:3}"
      ;;
  esac
fi
exec "$REAL_BUN" "$@"
`;
  writeFileSync(join(bin, "bun"), bunWrapper, { mode: 0o700 });
  writeFileSync(join(homeBunBin, "bun"), bunWrapper, { mode: 0o700 });
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: join(root, "home"),
    TRACE_FILE: trace,
    REAL_GIT: realGit,
    REAL_BUN: realBun,
    BACKUP_EXIT_FILE: state,
    MINIME_TEST_PSQL: psqlBinary,
    MINIME_SKIP_REPO_DOTENV: "1",
  };

  return {
    clone,
    trace,
    setBackupExit(code) {
      writeFileSync(state, `${code}\n`);
    },
    run() {
      return Bun.spawnSync(["bash", "scripts/update.sh"], {
        cwd: clone,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
    },
  };
}

afterEach(() => {
  try {
    resetScratchMigration();
  } finally {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

function trace(driver: Driver): string[] {
  return readFileSync(driver.trace, "utf8").trim().split("\n").filter(Boolean);
}

describe("safe first-hop updater rerun", () => {
  test("normalizes bracketed IPv6 loopback before libpq", () => {
    expect(normalizeLoopbackHost("[::1]")).toBe("::1");
  });

  test("ignores inherited libpq service and host-address poisoning", () => {
    const poisonRoot = mkdtempSync(join(tmpdir(), "minime-update-poison-"));
    const serviceFile = join(poisonRoot, "pg_service.conf");
    writeFileSync(
      serviceFile,
      "[task5_poison]\nhost=127.0.0.1\nport=1\ndbname=postgres\nuser=minime\n",
      { mode: 0o600 },
    );
    const savedService = process.env.PGSERVICE;
    const savedServiceFile = process.env.PGSERVICEFILE;
    const savedHostAddr = process.env.PGHOSTADDR;
    process.env.PGSERVICE = "task5_poison";
    process.env.PGSERVICEFILE = serviceFile;
    process.env.PGHOSTADDR = "127.0.0.1";
    try {
      const driver = makeDriver();
      expect(driver.run().exitCode).toBe(50);
      driver.setBackupExit(0);
      expect(driver.run().exitCode).toBe(0);
      expect(scratchMigrationCount()).toBe(1);
    } finally {
      if (savedService === undefined) Reflect.deleteProperty(process.env, "PGSERVICE");
      else process.env.PGSERVICE = savedService;
      if (savedServiceFile === undefined) Reflect.deleteProperty(process.env, "PGSERVICEFILE");
      else process.env.PGSERVICEFILE = savedServiceFile;
      if (savedHostAddr === undefined) Reflect.deleteProperty(process.env, "PGHOSTADDR");
      else process.env.PGHOSTADDR = savedHostAddr;
      rmSync(poisonRoot, { recursive: true, force: true });
    }
  });

  test("backup failure stops the checked-out updater before Git, install, or migration", () => {
    const driver = makeDriver();
    const first = driver.run();
    expect(first.exitCode, `${first.stdout.toString()}${first.stderr.toString()}`).toBe(50);
    driver.setBackupExit(1);
    const before = trace(driver).length;
    const result = driver.run();
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toMatch(
      /ERROR: pre-update db snapshot failed\nFIX: fix RESTIC_REPOSITORY and RESTIC_PASSWORD_FILE, then re-run\n$/,
    );
    expect(result.stdout.toString().match(/ERROR:/g)).toHaveLength(1);
    expect(result.stdout.toString().match(/FIX:/g)).toHaveLength(1);
    expect(trace(driver).slice(before)).toEqual(["preflight", "backup_failed"]);
  });

  test.each([
    [0, "taken"],
    [3, "unconfigured"],
  ] as const)("backup exit %d supplies %s to the checked-out migration", (exit, snapshot) => {
    const driver = makeDriver();
    const first = driver.run();
    expect(first.exitCode, `${first.stdout.toString()}${first.stderr.toString()}`).toBe(50);
    driver.setBackupExit(exit);
    const before = trace(driver).length;
    const result = driver.run();
    expect(result.exitCode).toBe(0);
    expect(trace(driver).slice(before)).toEqual([
      "preflight",
      "backup",
      "fetch",
      "pull",
      "install",
      `migrate:update:${snapshot}`,
      "verify",
    ]);
  });

  test("legacy first hop records the refusal and leaves 021 unapplied", () => {
    const driver = makeDriver();
    const first = driver.run();
    expect(first.exitCode).toBe(50);
    expect(trace(driver)).toEqual(["fetch", "pull", "install", "backup_failed", "migrate_refused"]);
    expect(scratchMigrationCount()).toBe(0);
  });

  test("the checked-out rerun applies 021 once and remains idempotent", () => {
    const driver = makeDriver();
    expect(driver.run().exitCode).toBe(50);
    driver.setBackupExit(0);
    expect(driver.run().exitCode).toBe(0);
    expect(scratchMigrationCount()).toBe(1);
    expect(driver.run().exitCode).toBe(0);
    expect(scratchMigrationCount()).toBe(1);
  });

  test("a failed 021 transaction leaves its ledger row absent", () => {
    const driver = makeDriver("select definitely_missing_task5_function();\n");
    expect(driver.run().exitCode).toBe(50);
    driver.setBackupExit(0);
    const before = trace(driver).length;
    const result = driver.run();
    expect(result.exitCode).toBe(50);
    expect(trace(driver).slice(before)).toEqual([
      "preflight",
      "backup",
      "fetch",
      "pull",
      "install",
      "migrate:update:taken",
    ]);
    expect(scratchMigrationCount()).toBe(0);
  });
});
