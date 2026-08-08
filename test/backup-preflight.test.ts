// W3-9: disk-headroom preflight before pg_dump, the weekly restic integrity check
// (resticCheck()), and serve's cron registration for it. Fully offline (I1): restic/pg_dump are
// never invoked -- __setStatfsForTest and __setCommandRunnerForTest (the same 11-hook pattern
// test/backup.test.ts already uses) replace both. test/backup.test.ts itself is left unchanged.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setCommandRunnerForTest,
  __setDumpDirForTest,
  __setStatfsForTest,
  dbSnapshot,
  resticCheck,
} from "../src/pipeline/backup";
import { type OwnerMaintenanceSchedule, startOwnerMaintenanceSchedule } from "../src/serve";
import { config } from "../src/util/config";
import { countEvents, testSql as sql } from "./helpers";

afterEach(() => {
  __setCommandRunnerForTest(undefined);
  __setStatfsForTest(undefined);
  __setDumpDirForTest(undefined);
  config.resticRepository = undefined;
  config.resticPasswordFile = undefined;
});

function withFixtureDumpDir(): { dir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "minime-backup-preflight-")));
  chmodSync(dir, 0o700);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const WHICH_CMD = ["sh", "-c", "command -v restic && command -v pg_dump"];

describe("disk headroom preflight (W3-9)", () => {
  test("below the flat floor fails closed and never spawns pg_dump", async () => {
    const { dir, cleanup } = withFixtureDumpDir();
    try {
      __setDumpDirForTest(dir);
      config.resticRepository = "test:repo";
      config.resticPasswordFile = "/test/pass";
      __setStatfsForTest(() => ({ bavail: 1, bsize: 1 })); // ~1 byte free -- far under any floor
      const calls: string[][] = [];
      __setCommandRunnerForTest(async (cmd) => {
        calls.push(cmd);
        return { ok: true };
      });

      await expect(dbSnapshot()).resolves.toEqual({
        ran: false,
        detail: "backup failed (disk_headroom) — see data/logs/ops.log",
      });
      // Only the preliminary binary-presence probe ran; pg_dump itself was never spawned, and no
      // temp dump file was left behind because the preflight runs before the temp is opened.
      expect(calls).toEqual([WHICH_CMD]);
      expect(calls.some((cmd) => cmd[0] === "pg_dump")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("above the flat floor with no prior dump proceeds through the normal flow", async () => {
    const { dir, cleanup } = withFixtureDumpDir();
    try {
      __setDumpDirForTest(dir);
      config.resticRepository = "test:repo";
      config.resticPasswordFile = "/test/pass";
      __setStatfsForTest(() => ({ bavail: 10_000, bsize: 1024 * 1024 })); // ~10GB free
      const fixtureDump = [
        "COPY public.schema_migrations (name) FROM stdin;",
        "020.sql",
        "\\.",
        "COPY public.tasks (id) FROM stdin;",
        "1",
        "\\.",
        "COPY public.people (id) FROM stdin;",
        "1",
        "\\.",
        "COPY public.journal_entries (id) FROM stdin;",
        "1",
        "\\.",
        "COPY public.chunks (id) FROM stdin;",
        "1",
        "\\.",
        "COPY public.events (id) FROM stdin;",
        "1",
        "\\.",
        "",
      ].join("\n");
      const calls: string[][] = [];
      __setCommandRunnerForTest(async (cmd) => {
        calls.push(cmd);
        if (cmd[0] === "pg_dump") {
          const output = cmd[cmd.indexOf("-f") + 1];
          writeFileSync(output!, fixtureDump, { mode: 0o600 });
        }
        return { ok: true };
      });

      const result = await dbSnapshot();
      expect(result.ran).toBe(true);
      expect(calls.some((cmd) => cmd[0] === "pg_dump")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("scales the requirement to twice the existing dump, not just the flat floor", async () => {
    const { dir, cleanup } = withFixtureDumpDir();
    try {
      __setDumpDirForTest(dir);
      config.resticRepository = "test:repo";
      config.resticPasswordFile = "/test/pass";
      // A sparse 200MB "existing" minime.sql (no real bytes written -- fs.truncateSync just
      // extends the logical size) pushes the requirement to 400MB, well above the flat 256MB
      // floor. 300MB free clears the floor but not the scaled requirement.
      const existing = join(dir, "minime.sql");
      writeFileSync(existing, "");
      truncateSync(existing, 200 * 1024 * 1024);
      __setStatfsForTest(() => ({ bavail: 300, bsize: 1024 * 1024 })); // 300MB free
      const calls: string[][] = [];
      __setCommandRunnerForTest(async (cmd) => {
        calls.push(cmd);
        return { ok: true };
      });

      await expect(dbSnapshot()).resolves.toEqual({
        ran: false,
        detail: "backup failed (disk_headroom) — see data/logs/ops.log",
      });
      expect(calls.some((cmd) => cmd[0] === "pg_dump")).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("resticCheck (W3-9)", () => {
  test("unconfigured returns without spawning restic or logging an event", async () => {
    const before = await countEvents("backup:restic-check");
    const calls: string[][] = [];
    __setCommandRunnerForTest(async (cmd) => {
      calls.push(cmd);
      return { ok: true };
    });

    const result = await resticCheck();
    expect(result.ran).toBe(false);
    expect(result.detail).toMatch(/not configured/i);
    expect(calls).toEqual([]);
    expect(await countEvents("backup:restic-check")).toBe(before);
  });

  test("success runs the read-data-subset check and logs a content-free {ok:true} event", async () => {
    config.resticRepository = "test:repo";
    config.resticPasswordFile = "/test/pass";
    const calls: string[][] = [];
    __setCommandRunnerForTest(async (cmd) => {
      calls.push(cmd);
      return { ok: true };
    });

    const result = await resticCheck();
    expect(result).toEqual({ ran: true, detail: "restic check complete" });
    expect(calls).toEqual([["restic", "check", "--read-data-subset=5%"]]);

    const [row] = await sql`
      select payload from events where verb = 'backup:restic-check' order by at desc limit 1`;
    expect(row!.payload).toEqual({ ok: true });
  });

  test("failure logs {ok:false} and never carries stderr/path content in the payload", async () => {
    config.resticRepository = "test:repo";
    config.resticPasswordFile = "/test/pass";
    __setCommandRunnerForTest(async () => ({
      ok: false,
      failure: "exit_nonzero",
      code: 1,
      stderrHead:
        "unable to open config file at /private/backups/config: repository is already locked\n",
    }));

    const result = await resticCheck();
    expect(result).toEqual({
      ran: false,
      detail: "backup failed (restic_check) — see data/logs/ops.log",
    });

    const [row] = await sql`
      select payload from events where verb = 'backup:restic-check' order by at desc limit 1`;
    expect(row!.payload).toEqual({ ok: false });
    expect(JSON.stringify(row!.payload)).not.toContain("/private/backups");
  });
});

describe("serve schedules the weekly restic check (W3-9)", () => {
  const original = {
    resticRepository: config.resticRepository,
    resticPasswordFile: config.resticPasswordFile,
    resticCheckCron: config.resticCheckCron,
    tz: config.tz,
  };
  const liveSchedules: OwnerMaintenanceSchedule[] = [];

  afterEach(async () => {
    await Promise.all(liveSchedules.splice(0).map((schedule) => schedule.close()));
    config.resticRepository = original.resticRepository;
    config.resticPasswordFile = original.resticPasswordFile;
    config.resticCheckCron = original.resticCheckCron;
    config.tz = original.tz;
  });

  interface FakeCronRegistration {
    pattern: string;
    fire: () => void;
  }

  // Same technique as test/maintenance-lock.test.ts's fakeCronFactory: record every cron the
  // scheduler tries to register instead of waiting out real cron intervals.
  function fakeCronFactory() {
    const registrations: FakeCronRegistration[] = [];
    const factory = (pattern: string, _options: { timezone: string }, callback: () => void) => {
      registrations.push({ pattern, fire: () => callback() });
      return { nextRun: () => null, stop: () => {} };
    };
    return { factory, registrations };
  }

  test("registers the restic-check cron only when restic is configured", async () => {
    config.tz = "Asia/Singapore";
    config.resticCheckCron = "0 4 * * 0";

    config.resticRepository = undefined;
    config.resticPasswordFile = undefined;
    const unconfigured = fakeCronFactory();
    const scheduleUnconfigured = await startOwnerMaintenanceSchedule(unconfigured.factory);
    try {
      expect(unconfigured.registrations.some((r) => r.pattern === "0 4 * * 0")).toBe(false);
    } finally {
      await scheduleUnconfigured.close();
    }

    config.resticRepository = "test:repo";
    config.resticPasswordFile = "/test/pass";
    const configured = fakeCronFactory();
    const scheduleConfigured = await startOwnerMaintenanceSchedule(configured.factory);
    liveSchedules.push(scheduleConfigured);
    expect(configured.registrations.some((r) => r.pattern === "0 4 * * 0")).toBe(true);
  });

  test("registers the restic-check cron only for the maintenance-lock winner", async () => {
    config.tz = "Asia/Singapore";
    config.resticCheckCron = "0 4 * * 0";
    config.resticRepository = "test:repo";
    config.resticPasswordFile = "/test/pass";

    const winner = fakeCronFactory();
    liveSchedules.push(await startOwnerMaintenanceSchedule(winner.factory));
    expect(winner.registrations.some((r) => r.pattern === "0 4 * * 0")).toBe(true);

    const loser = fakeCronFactory();
    liveSchedules.push(await startOwnerMaintenanceSchedule(loser.factory));
    expect(loser.registrations.some((r) => r.pattern === "0 4 * * 0")).toBe(false);
  });
});
