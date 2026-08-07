#!/usr/bin/env bun

import { randomInt } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const REPO_ROOT = realpathSync(resolve(import.meta.dir, ".."));
const SOURCE_DATABASE = "minime";
const TEMPLATE_DATABASE = "minime_test";
const FIXED_PROCESS_ENV = { LC_ALL: "C", LANG: "C" } as const;

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function physicalBinary(name: string): string | undefined {
  const candidate = Bun.which(name);
  if (!candidate || !candidate.startsWith("/")) return undefined;
  try {
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}

function run(argv: readonly string[], env: Readonly<Record<string, string>> = {}): CommandResult {
  const result = Bun.spawnSync([...argv], {
    cwd: REPO_ROOT,
    env: { ...FIXED_PROCESS_ENV, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function requireSuccess(label: string, result: CommandResult): void {
  if (result.exitCode !== 0) throw new Error(`restore_roundtrip_${label}`);
}

const pgDump = physicalBinary("pg_dump");
const restic = physicalBinary("restic");
const bun = realpathSync(process.execPath);
const pgBin = pgDump ? dirname(pgDump) : undefined;
const initdb = pgBin ? join(pgBin, "initdb") : undefined;
const pgCtl = pgBin ? join(pgBin, "pg_ctl") : undefined;
const createdb = pgBin ? join(pgBin, "createdb") : undefined;
const createuser = pgBin ? join(pgBin, "createuser") : undefined;

if (!pgDump || !restic || !pgBin || !initdb || !pgCtl || !createdb || !createuser) {
  console.error("restore restic round trip failed (dependencies)");
  process.exit(2);
}
const trustedPgDump = pgDump;
const trustedRestic = restic;
const trustedPgBin = pgBin;
const trustedInitdb = initdb;
const trustedPgCtl = pgCtl;
const trustedCreatedb = createdb;
const trustedCreateuser = createuser;

// PostgreSQL's Unix-socket path limit is small on macOS. Keep this owned workspace under the
// physical /tmp root so the random socket filename cannot exceed that platform boundary.
const root = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "minime-rte-")));
chmodSync(root, 0o700);
const cluster = join(root, "postgres");
const socketDir = join(root, "socket");
const privateTmp = join(root, "tmp");
const archiveDir = join(root, "archive");
const dumpDir = join(archiveDir, "db-dump");
const resticRepo = join(root, "restic");
const resticPassword = join(root, "restic.pass");
const serverLog = join(root, "postgres.log");
const isolatedHome = join(root, "home");
const cacheDir = join(root, "cache");
for (const directory of [socketDir, privateTmp, archiveDir, dumpDir, isolatedHome, cacheDir]) {
  mkdirSync(directory, { mode: 0o700 });
}
writeFileSync(resticPassword, "fictional-roundtrip-password\n", { mode: 0o600 });
writeFileSync(serverLog, "", { mode: 0o600 });

let serverStarted = false;
let cleanupStarted = false;
let port = 0;

function stopAndClean(): void {
  if (cleanupStarted) return;
  cleanupStarted = true;
  if (serverStarted) {
    run([trustedPgCtl, "-D", cluster, "-m", "fast", "-w", "stop"]);
    serverStarted = false;
  }
  rmSync(root, { recursive: true, force: true });
}

for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.once(signal, () => {
    stopAndClean();
    process.exit(exitCode);
  });
}

try {
  requireSuccess(
    "initdb",
    run([
      trustedInitdb,
      "-D",
      cluster,
      "--username=postgres",
      "--auth-local=trust",
      "--auth-host=trust",
      "--encoding=UTF8",
      "--no-locale",
      "--no-sync",
    ]),
  );

  for (let attempt = 0; attempt < 12 && !serverStarted; attempt += 1) {
    port = randomInt(20_000, 55_000);
    const started = run([
      trustedPgCtl,
      "-D",
      cluster,
      "-l",
      serverLog,
      "-o",
      `-h 127.0.0.1 -p ${port} -k ${socketDir} -F`,
      "-w",
      "start",
    ]);
    serverStarted = started.exitCode === 0;
  }
  if (!serverStarted) throw new Error("restore_roundtrip_postgres_start");

  const bootstrapEnv = {
    PGHOST: "127.0.0.1",
    PGPORT: String(port),
    PGUSER: "postgres",
    HOME: isolatedHome,
    XDG_CACHE_HOME: cacheDir,
  };
  requireSuccess(
    "owner_create",
    run(
      [trustedCreateuser, "--superuser", "--createdb", "--createrole", "--inherit", "minime"],
      bootstrapEnv,
    ),
  );
  requireSuccess(
    "source_create",
    run([trustedCreatedb, "--owner=minime", SOURCE_DATABASE], bootstrapEnv),
  );
  const sourceUrl = `postgres://minime@127.0.0.1:${port}/${SOURCE_DATABASE}`;
  const ownerEnv = {
    ...bootstrapEnv,
    PGUSER: "minime",
    DATABASE_URL: sourceUrl,
    MINIME_SKIP_REPO_DOTENV: "1",
    MINIME_DATA_DIR: archiveDir,
    MINIME_MOCK_OLLAMA: "1",
    NODE_ENV: "test",
    OLLAMA_URL: "http://localhost:11434",
  };
  requireSuccess(
    "migrate",
    run(
      [
        bun,
        "--no-env-file",
        "run",
        join(REPO_ROOT, "src", "cli.ts"),
        "migrate",
        "--context",
        "direct",
      ],
      ownerEnv,
    ),
  );
  requireSuccess(
    "seed",
    run([bun, "--no-env-file", "run", join(REPO_ROOT, "src", "cli.ts"), "seed"], ownerEnv),
  );
  requireSuccess(
    "template_create",
    run(
      [trustedCreatedb, "--owner=minime", "--template", SOURCE_DATABASE, TEMPLATE_DATABASE],
      bootstrapEnv,
    ),
  );

  const baseEnv = {
    ...bootstrapEnv,
    PGUSER: "minime",
  };

  const dumpPath = join(dumpDir, "minime.sql");
  writeFileSync(dumpPath, "", { mode: 0o600 });
  requireSuccess(
    "dump",
    run([trustedPgDump, "--no-password", "--no-owner", "--no-comments", "-f", dumpPath], {
      ...baseEnv,
      PGDATABASE: SOURCE_DATABASE,
    }),
  );
  chmodSync(dumpPath, 0o600);
  requireSuccess(
    "manifest",
    run(
      [
        bun,
        "--no-env-file",
        "run",
        join(REPO_ROOT, "scripts", "snapshot-manifest.ts"),
        "write",
        dumpPath,
        join(dumpDir, "minime.manifest.json"),
      ],
      { MINIME_SKIP_REPO_DOTENV: "1" },
    ),
  );

  const resticEnv = {
    RESTIC_REPOSITORY: resticRepo,
    RESTIC_PASSWORD_FILE: resticPassword,
    HOME: isolatedHome,
    XDG_CACHE_HOME: cacheDir,
  };
  requireSuccess("restic_init", run([trustedRestic, "init"], resticEnv));
  requireSuccess(
    "restic_backup",
    run([trustedRestic, "backup", "--tag", "db-snap", archiveDir], resticEnv),
  );

  const endpoint = (database: string) => `postgres://minime@127.0.0.1:${port}/${database}`;
  const bunInstall = dirname(dirname(bun));
  if (basename(dirname(bun)) !== "bin") throw new Error("restore_roundtrip_bun_layout");
  const drill = run([join(REPO_ROOT, "scripts", "restore-drill.sh")], {
    DATABASE_URL: sourceUrl,
    ADMIN_URL: endpoint("postgres"),
    DRILL_URL: endpoint("minime_drill"),
    LIVE_URL: endpoint("minime"),
    RESTORE_URL: endpoint("minime_restore"),
    RESTIC_REPOSITORY: resticRepo,
    RESTIC_PASSWORD_FILE: resticPassword,
    RESTIC_BIN: trustedRestic,
    PGBIN: trustedPgBin,
    BUN_INSTALL: bunInstall,
    TMPDIR: privateTmp,
    HOME: isolatedHome,
    XDG_CACHE_HOME: cacheDir,
  });
  requireSuccess("drill", drill);
  if (!drill.stdout.includes("restore source: restic")) {
    throw new Error("restore_roundtrip_source_label");
  }
  if (!drill.stdout.includes("==> restore drill green")) {
    throw new Error("restore_roundtrip_validation");
  }
  if (drill.stderr !== "") throw new Error("restore_roundtrip_stderr");

  console.log("restore restic round trip passed (isolated fictional cluster)");
} catch (error) {
  const label = error instanceof Error ? error.message : "restore_roundtrip_unknown";
  console.error(label.startsWith("restore_roundtrip_") ? label : "restore_roundtrip_failed");
  process.exitCode = 1;
} finally {
  stopAndClean();
}
