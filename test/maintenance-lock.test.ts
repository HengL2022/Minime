// W3-5: single-maintenance-owner advisory lock in serve + dream missed-run catch-up. Exercises
// startOwnerMaintenanceSchedule directly (in-process, with an injected fake cron factory) so
// lock takeover and catch-up firing are deterministic without waiting out real cron intervals
// (a 5-minute retry, a 30-90s catch-up delay) or a real 3am dream schedule.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "../src/db/client";
import { type OwnerMaintenanceSchedule, startOwnerMaintenanceSchedule } from "../src/serve";
import { config } from "../src/util/config";
import { resetDb } from "./helpers";

interface FakeCronRegistration {
  pattern: string;
  timezone: string;
  fire: () => void;
  stopped: boolean;
}

// Records every cron the scheduler tries to register and lets the test fire (or never fire) each
// one's callback directly -- the same technique the existing serve-boundary.test.ts timezone
// test uses, applied here to the takeover retry and the catch-up one-shot too.
function fakeCronFactory() {
  const registrations: FakeCronRegistration[] = [];
  const factory = (pattern: string, options: { timezone: string }, callback: () => void) => {
    const entry: FakeCronRegistration = {
      pattern,
      timezone: options.timezone,
      fire: () => callback(),
      stopped: false,
    };
    registrations.push(entry);
    return {
      nextRun: () => null,
      stop: () => {
        entry.stopped = true;
      },
    };
  };
  return { factory, registrations };
}

describe("single maintenance owner (W3-5)", () => {
  const original = {
    dreamCron: config.dreamCron,
    backupCron: config.backupCron,
    resticRepository: config.resticRepository,
    resticPasswordFile: config.resticPasswordFile,
    tz: config.tz,
  };
  const liveSchedules: OwnerMaintenanceSchedule[] = [];

  beforeEach(async () => {
    // events is append-only (I8), so a clean table via resetDb() is the only way to make
    // lastEventAt() -- and therefore the catch-up decision -- deterministic, independent of
    // what other test files in this shared scratch database have already written.
    await resetDb();
    config.tz = "Asia/Singapore";
    config.dreamCron = "0 3 * * *";
    config.backupCron = "*/15 * * * *";
    config.resticRepository = "test:repository";
    config.resticPasswordFile = "/test/restic-password";
  });

  afterEach(async () => {
    await Promise.all(liveSchedules.splice(0).map((schedule) => schedule.close()));
    config.tz = original.tz;
    config.dreamCron = original.dreamCron;
    config.backupCron = original.backupCron;
    config.resticRepository = original.resticRepository;
    config.resticPasswordFile = original.resticPasswordFile;
  });

  function track(schedule: OwnerMaintenanceSchedule): OwnerMaintenanceSchedule {
    liveSchedules.push(schedule);
    return schedule;
  }

  test("a failing cron job writes the fixed label and error class to ops.log — never the message (W3-8 review gap)", async () => {
    // Drives run()'s .catch() branch for real: the brief cron's work fn rejects with an error
    // whose message carries sentinel prose, and only {step, class} may reach the ops log.
    const { __setDeliverForTest } = await import("../src/ops/push");
    const { mkdtempSync, realpathSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const originalDataDir = config.dataDir;
    const originalBriefCron = config.briefCron;
    config.dataDir = realpathSync(mkdtempSync(join(tmpdir(), "minime-runcatch-test-")));
    config.briefCron = "30 7 * * *";
    class FixtureBriefBoom extends Error {}
    __setDeliverForTest(async () => {
      throw new FixtureBriefBoom("SENTINEL-private-prose should never reach ops.log");
    });

    try {
      const f = fakeCronFactory();
      track(await startOwnerMaintenanceSchedule(f.factory));
      const brief = f.registrations.find((r) => r.pattern === "30 7 * * *");
      expect(brief).toBeDefined();
      brief!.fire();

      const opsPath = join(config.dataDir, "logs", "ops.log");
      let content = "";
      for (let i = 0; i < 40; i++) {
        try {
          content = readFileSync(opsPath, "utf8");
          if (content.includes("push brief")) break;
        } catch {
          /* not written yet */
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(content).toContain("push brief");
      expect(content).toContain("class=FixtureBriefBoom");
      expect(content).not.toContain("SENTINEL-private-prose");
    } finally {
      __setDeliverForTest(undefined);
      config.dataDir = originalDataDir;
      config.briefCron = originalBriefCron;
    }
  });

  test("a second scheduler gets no dream/backup crons while the first holds the lock, and takes over once it closes", async () => {
    const a = fakeCronFactory();
    const scheduleA = track(await startOwnerMaintenanceSchedule(a.factory));
    expect(a.registrations.map((r) => r.pattern)).toEqual([
      config.dreamCron,
      config.backupCron,
      config.resticCheckCron,
    ]);

    const b = fakeCronFactory();
    const scheduleB = track(await startOwnerMaintenanceSchedule(b.factory));
    // The loser gets exactly one cron: its own takeover retry. No dream, no backup.
    expect(b.registrations.length).toBe(1);
    const retry = b.registrations[0]!;
    expect(retry.pattern).toBe("*/5 * * * *");

    await scheduleA.close(); // releases the lock

    retry.fire(); // simulate the 5-minute retry tick instead of waiting for it
    await scheduleB.close(); // waits for the in-flight takeover, and anything it schedules

    expect(b.registrations.map((r) => r.pattern)).toEqual([
      retry.pattern,
      config.dreamCron,
      config.backupCron,
      config.resticCheckCron,
    ]);
  });

  test("the lock is released on close(), so the next scheduler acquires it on its first attempt", async () => {
    const a = fakeCronFactory();
    const scheduleA = track(await startOwnerMaintenanceSchedule(a.factory));
    await scheduleA.close();

    const b = fakeCronFactory();
    const scheduleB = track(await startOwnerMaintenanceSchedule(b.factory));
    expect(b.registrations.map((r) => r.pattern)).toEqual([
      config.dreamCron,
      config.backupCron,
      config.resticCheckCron,
    ]);
    await scheduleB.close();
  });

  test("backup is scheduled only for the winner", async () => {
    const a = fakeCronFactory();
    track(await startOwnerMaintenanceSchedule(a.factory));
    const b = fakeCronFactory();
    track(await startOwnerMaintenanceSchedule(b.factory));

    const backupRegistrations = (regs: FakeCronRegistration[]) =>
      regs.filter((r) => r.pattern === config.backupCron).length;
    expect(backupRegistrations(a.registrations)).toBe(1);
    expect(backupRegistrations(b.registrations)).toBe(0);
  });

  test("catch-up runs dream exactly once when the last dream predates the previous scheduled fire", async () => {
    await sql`insert into events (at, actor, verb, payload)
      values (now() - interval '2 days', 'system:dream', 'dream:summary', ${sql.json({})})`;

    const { factory, registrations } = fakeCronFactory();
    const schedule = track(await startOwnerMaintenanceSchedule(factory));
    expect(registrations.map((r) => r.pattern).slice(0, 3)).toEqual([
      config.dreamCron,
      config.backupCron,
      config.resticCheckCron,
    ]);
    expect(registrations.length).toBe(4); // + one dream catch-up run
    const catchUp = registrations[3]!;
    expect(catchUp.pattern).not.toBe(config.dreamCron);

    catchUp.fire();
    await schedule.close(); // waits for the fired dream() run to fully settle

    const [count] = await sql`select count(*)::int as n from events where verb = 'dream:summary'`;
    expect(count!.n).toBe(2); // the stale fixture, plus exactly one catch-up run
  });

  test("catch-up does not run when the last dream is fresh", async () => {
    await sql`insert into events (at, actor, verb, payload)
      values (now(), 'system:dream', 'dream:summary', ${sql.json({})})`;

    const { factory, registrations } = fakeCronFactory();
    const schedule = track(await startOwnerMaintenanceSchedule(factory));
    expect(registrations.map((r) => r.pattern)).toEqual([
      config.dreamCron,
      config.backupCron,
      config.resticCheckCron,
    ]);
    await schedule.close();

    const [count] = await sql`select count(*)::int as n from events where verb = 'dream:summary'`;
    expect(count!.n).toBe(1); // only the fixture -- no catch-up run added a second
  });

  test("catch-up does not run on a fresh database with no prior events at all", async () => {
    // beforeEach's resetDb() already leaves a fresh, event-free database.
    const { factory, registrations } = fakeCronFactory();
    const schedule = track(await startOwnerMaintenanceSchedule(factory));
    expect(registrations.map((r) => r.pattern)).toEqual([
      config.dreamCron,
      config.backupCron,
      config.resticCheckCron,
    ]);
    await schedule.close();

    const [count] = await sql`select count(*)::int as n from events where verb = 'dream:summary'`;
    expect(count!.n).toBe(0);
  });
});
