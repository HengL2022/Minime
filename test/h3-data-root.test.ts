import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  __setAfterDumpTempRegisterForTest,
  __setCommandRunnerForTest,
  __setDumpDirForTest,
  __setDumpTempRemoveForTest,
  __setInFlightForTest,
  dbSnapshot,
} from "../src/pipeline/backup";
import { DB_DUMP_DIR, config } from "../src/util/config";
import { activeTestDatabaseName, testDatabaseUrl } from "./setup";

const REPO = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const CONFIG_URL = pathToFileURL(join(REPO, "src/util/config.ts")).href;
const roots: string[] = [];

function foreignDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "minime-h3-cwd-")));
  roots.push(dir);
  return dir;
}

function readConfig(cwd: string, dataDir: string | undefined, configUrl = CONFIG_URL) {
  const script = `const m = await import(${JSON.stringify(configUrl)});console.log(JSON.stringify({repo:m.REPO_ROOT,dump:m.DB_DUMP_DIR,data:m.config.dataDir}));`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    MINIME_SKIP_REPO_DOTENV: "1",
  };
  if (dataDir === undefined) env.MINIME_DATA_DIR = undefined;
  else env.MINIME_DATA_DIR = dataDir;
  const proc = Bun.spawnSync(["bun", "-e", script], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.exitCode, proc.stderr.toString()).toBe(0);
  return JSON.parse(proc.stdout.toString().trim()) as {
    repo: string;
    dump: string;
    data: string;
  };
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("repository-stable roots", () => {
  test("foreign cwd does not change default archive or dump root", () => {
    const got = readConfig(foreignDir(), undefined);
    expect(got.repo).toBe(REPO);
    expect(got.data).toBe(join(REPO, "data"));
    expect(got.dump).toBe(join(REPO, "db-dump"));
  });

  test.each(["", " \t "])("empty override %p uses the repository default", (value) => {
    expect(readConfig(foreignDir(), value).data).toBe(join(REPO, "data"));
  });

  test("absolute override is normalized without cwd rebasing", () => {
    const absolute = `${foreignDir()}/a/../archive`;
    expect(readConfig(foreignDir(), absolute).data).toBe(resolve(absolute));
  });

  test("relative override is trimmed and resolved from the repository root", () => {
    expect(readConfig(foreignDir(), " owner-data/../archive ").data).toBe(join(REPO, "archive"));
  });

  test("symlinked import resolves to the same physical root as shell pwd -P", () => {
    const root = foreignDir();
    const link = join(root, "repo-link");
    symlinkSync(REPO, link, "dir");
    const got = readConfig(
      foreignDir(),
      undefined,
      pathToFileURL(join(link, "src/util/config.ts")).href,
    );
    const physical = Bun.spawnSync(["/bin/bash", "-c", 'CDPATH= cd -- "$1" && pwd -P', "_", link], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(physical.exitCode, physical.stderr.toString()).toBe(0);
    expect(got.repo).toBe(physical.stdout.toString().trim());
    expect(got.repo).toBe(REPO);
    expect(got.data).toBe(join(REPO, "data"));
    expect(got.dump).toBe(join(REPO, "db-dump"));
  });

  test("dbSnapshot stages only its private root and hands pg_dump a service lease", async () => {
    const root = foreignDir();
    const dumpDir = join(root, "db-dump");
    const seen: string[][] = [];
    const oldRepo = config.resticRepository;
    const oldPass = config.resticPasswordFile;
    config.resticRepository = "test:repo";
    config.resticPasswordFile = "/test/pass";
    __setDumpDirForTest(dumpDir);
    __setCommandRunnerForTest(async (cmd, env) => {
      seen.push(cmd);
      if (cmd[0] === "pg_dump") {
        const out = cmd[cmd.indexOf("-f") + 1]!;
        expect(env?.PGSERVICE).toBe("minime_ephemeral");
        expect(env?.PGSERVICEFILE).toBeTruthy();
        expect(statSync(env!.PGSERVICEFILE!).mode & 0o777).toBe(0o600);
        expect(cmd.join(" ")).not.toContain(config.databaseUrl);
        writeFileSync(
          out,
          [
            "-- fictional minime_test dump",
            "COPY public.schema_migrations (name) FROM stdin;",
            "021_runtime_app_role.sql",
            "\\.",
            ...["tasks", "people", "journal_entries", "chunks", "events"].flatMap((table) => [
              `COPY public.${table} (id) FROM stdin;`,
              "00000000-0000-0000-0000-000000000001",
              "\\.",
            ]),
            "",
          ].join("\n"),
        );
      }
      return { ok: true };
    });
    try {
      expect((await dbSnapshot()).ran).toBe(true);
    } finally {
      __setCommandRunnerForTest(undefined);
      __setDumpDirForTest(undefined);
      __setInFlightForTest(false);
      config.resticRepository = oldRepo;
      config.resticPasswordFile = oldPass;
    }
    expect(DB_DUMP_DIR).toBe(join(REPO, "db-dump"));
    expect(seen.some((cmd) => cmd[0] === "restic" && cmd.at(-1) === dumpDir)).toBe(true);
    expect(statSync(dumpDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dumpDir, "minime.sql")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dumpDir, "minime.sql"), "utf8")).toContain("minime_test");
    expect(readdirSync(dumpDir).filter((name) => name.startsWith(".minime.sql."))).toEqual([]);
    expect(new URL(testDatabaseUrl()).pathname).toBe(`/${activeTestDatabaseName()}`);
    expect(activeTestDatabaseName()).toMatch(/^minime_test_[a-z0-9_]+$/);
  });

  test("dbSnapshot refuses a dump-root symlink before any child command", async () => {
    const root = foreignDir();
    const outside = join(root, "outside");
    const dumpDir = join(root, "db-dump");
    mkdirSync(outside, { mode: 0o700 });
    writeFileSync(join(outside, "sentinel"), "foreign sentinel\n", { mode: 0o600 });
    symlinkSync(outside, dumpDir, "dir");
    const seen: string[][] = [];
    __setDumpDirForTest(dumpDir);
    __setCommandRunnerForTest(async (cmd) => {
      seen.push(cmd);
      return { ok: true };
    });
    try {
      expect((await dbSnapshot()).ran).toBe(false);
    } finally {
      __setCommandRunnerForTest(undefined);
      __setDumpDirForTest(undefined);
      __setInFlightForTest(false);
    }
    expect(seen).toEqual([]);
    expect(existsSync(join(outside, "sentinel"))).toBe(true);
  });

  test("dbSnapshot revalidates the dump root after staging before pg_dump", async () => {
    const root = foreignDir();
    const dumpDir = join(root, "db-dump");
    const seen: string[][] = [];
    const oldRepo = config.resticRepository;
    const oldPass = config.resticPasswordFile;
    config.resticRepository = "test:repo";
    config.resticPasswordFile = "/test/pass";
    __setDumpDirForTest(dumpDir);
    __setCommandRunnerForTest(async (cmd) => {
      seen.push(cmd);
      return { ok: true };
    });
    __setAfterDumpTempRegisterForTest(() => chmodSync(dumpDir, 0o755));
    try {
      expect((await dbSnapshot()).ran).toBe(false);
    } finally {
      __setCommandRunnerForTest(undefined);
      __setDumpDirForTest(undefined);
      __setAfterDumpTempRegisterForTest(undefined);
      __setInFlightForTest(false);
      config.resticRepository = oldRepo;
      config.resticPasswordFile = oldPass;
    }
    expect(seen.some((cmd) => cmd[0] === "pg_dump")).toBe(false);
    expect(readdirSync(dumpDir).filter((name) => name.startsWith(".minime.sql."))).toEqual([]);
    chmodSync(dumpDir, 0o700);
  });

  test("dbSnapshot treats a non-ENOENT sibling cleanup error as cleanup failure", async () => {
    const root = foreignDir();
    const dumpDir = join(root, "db-dump");
    const oldRepo = config.resticRepository;
    const oldPass = config.resticPasswordFile;
    config.resticRepository = "test:repo";
    config.resticPasswordFile = "/test/pass";
    __setDumpDirForTest(dumpDir);
    __setCommandRunnerForTest(async (cmd) => {
      if (cmd[0] === "pg_dump") {
        writeFileSync(cmd[cmd.indexOf("-f") + 1]!, "-- partial --\n", { mode: 0o600 });
        return { ok: false, failure: "exit_nonzero" };
      }
      return { ok: true };
    });
    __setDumpTempRemoveForTest(async () => {
      const error = new Error("masked");
      Object.assign(error, { code: "EACCES" });
      throw error;
    });
    try {
      expect(await dbSnapshot()).toEqual({
        ran: false,
        detail: "backup failed (dump_cleanup) — see data/logs/ops.log",
      });
    } finally {
      __setCommandRunnerForTest(undefined);
      __setDumpTempRemoveForTest(undefined);
      __setDumpDirForTest(undefined);
      __setInFlightForTest(false);
      config.resticRepository = oldRepo;
      config.resticPasswordFile = oldPass;
    }
    expect(readdirSync(dumpDir).filter((name) => name.startsWith(".minime.sql."))).toHaveLength(1);
  });

  test.each(["symlink", "directory", "regular"] as const)(
    "dbSnapshot rejects a pg_dump %s replacement without touching prior-good output",
    async (replacement) => {
      const root = foreignDir();
      const dumpDir = join(root, "db-dump");
      const priorGood = join(dumpDir, "minime.sql");
      const foreign = join(root, "foreign-target.sql");
      const oldRepo = config.resticRepository;
      const oldPass = config.resticPasswordFile;
      mkdirSync(dumpDir, { mode: 0o700 });
      writeFileSync(priorGood, "-- prior good dump --\n", { mode: 0o600 });
      writeFileSync(foreign, "-- foreign target --\n", { mode: 0o600 });
      config.resticRepository = "test:repo";
      config.resticPasswordFile = "/test/pass";
      __setDumpDirForTest(dumpDir);
      const seen: string[][] = [];
      __setCommandRunnerForTest(async (cmd) => {
        seen.push(cmd);
        if (cmd[0] === "pg_dump") {
          const out = cmd[cmd.indexOf("-f") + 1]!;
          rmSync(out, { force: true });
          if (replacement === "symlink") symlinkSync(foreign, out);
          else if (replacement === "directory") mkdirSync(out, { mode: 0o700 });
          else writeFileSync(out, "-- replacement dump --\n", { mode: 0o600 });
        }
        return { ok: true };
      });
      try {
        expect(await dbSnapshot()).toEqual({
          ran: false,
          detail: "backup failed (dump_cleanup) — see data/logs/ops.log",
        });
      } finally {
        __setCommandRunnerForTest(undefined);
        __setDumpDirForTest(undefined);
        __setInFlightForTest(false);
        config.resticRepository = oldRepo;
        config.resticPasswordFile = oldPass;
      }
      expect(seen.some((cmd) => cmd[0] === "restic")).toBe(false);
      expect(readFileSync(priorGood, "utf8")).toBe("-- prior good dump --\n");
      expect(readFileSync(foreign, "utf8")).toBe("-- foreign target --\n");
      const replacementPath = readdirSync(dumpDir).find((name) => name.startsWith(".minime.sql."));
      expect(replacementPath).toBeTruthy();
      const replacementStat = lstatSync(join(dumpDir, replacementPath!));
      if (replacement === "symlink") expect(replacementStat.isSymbolicLink()).toBe(true);
      if (replacement === "directory") expect(replacementStat.isDirectory()).toBe(true);
      if (replacement === "regular") expect(replacementStat.isFile()).toBe(true);
    },
  );
});

test("every persistent archive/dump consumer uses the canonical roots", () => {
  const source = (path: string) => readFileSync(join(REPO, path), "utf8");
  const archiveConsumers = [
    "src/pipeline/watcher.ts",
    "src/pipeline/brain-sync.ts",
    "src/pipeline/notes.ts",
    "src/mcp/tools/capture.ts",
  ].map(source);
  const backup = source("src/pipeline/backup.ts");
  const repair = source("scripts/repair.ts");
  const promote = source("scripts/promote-restore.sh");

  for (const text of archiveConsumers) expect(text).toContain("config.dataDir");
  expect(backup).toContain("config.dataDir");
  expect(backup).toContain("DB_DUMP_DIR");
  expect(backup).toContain("await completed.sync()");
  expect(backup).toContain("await rename(temp, out)");
  expect(backup).toContain('stdout: "ignore"');
  // W3-8: backup.ts's own child stderr is no longer blindly discarded -- it is captured
  // bounded (never unbounded/raw) and funneled through the fixed allowlist classifier before
  // any of it can reach the local ops log; console/audit stay exactly as content-free as
  // before. repair.ts (below) is untouched by W3-8 and still discards stderr outright.
  expect(backup).toContain('stderr: "pipe"');
  expect(backup).toContain("STDERR_CAP_BYTES");
  expect(backup).toContain("classifyStderrLine");
  expect(repair).toContain("DB_DUMP_DIR");
  expect(repair).toContain("resolveRepairDumpDir(opts.dumpDir)");
  expect(repair).toContain('stdout: "ignore"');
  expect(repair).toContain('stderr: "ignore"');
  expect(promote).toContain('SCRIPT_DIR="$(CDPATH= cd --');
  expect(promote).toContain('DUMP_ROOT="$REPO_ROOT/db-dump"');

  const persistentSources = [...archiveConsumers, backup, repair, promote].join("\n");
  expect(persistentSources).not.toContain('join(process.cwd(), "data")');
  expect(persistentSources).not.toContain('join(process.cwd(), "db-dump")');
  expect(promote).not.toContain('DUMP="db-dump/');
});
