// Backup module — fully offline (I1): restic/pg_dump are never invoked. The unconfigured
// path returns { ran: false } without touching binaries; the overlap guard short-circuits
// on the module-level in-flight flag before any config/binary check.

import { afterEach, describe, expect, test } from "bun:test";
import { Cron } from "croner";
import {
  __setInFlightForTest,
  __setProbeHookForTest,
  backup,
  dbSnapshot,
} from "../src/pipeline/backup";
import { config } from "../src/util/config";

afterEach(() => {
  __setInFlightForTest(false);
  __setProbeHookForTest(undefined);
});

describe("graceful degradation when restic is unconfigured", () => {
  test("dbSnapshot() resolves { ran: false } and detail mentions configuration", async () => {
    // setup.ts leaves RESTIC_REPOSITORY unset; config reads it at import.
    expect(config.resticRepository).toBeUndefined();
    const r = await dbSnapshot();
    expect(r.ran).toBe(false);
    expect(r.detail).toMatch(/not configured/i);
  });

  test("backup() resolves { ran: false } and detail mentions configuration", async () => {
    const r = await backup();
    expect(r.ran).toBe(false);
    expect(r.detail).toMatch(/not configured/i);
  });
});

describe("in-flight overlap guard", () => {
  test("dbSnapshot() skips while a backup is in flight", async () => {
    __setInFlightForTest(true);
    const r = await dbSnapshot();
    expect(r.ran).toBe(false);
    expect(r.detail).toMatch(/in flight/i);
  });

  test("backup() skips while a snapshot is in flight", async () => {
    __setInFlightForTest(true);
    const r = await backup();
    expect(r.ran).toBe(false);
    expect(r.detail).toMatch(/in flight/i);
  });

  test("concurrent invocations: the flag is claimed before any await, so the second skips (B2)", async () => {
    // The probe hook fires immediately after inFlight is claimed, BEFORE the config/binary
    // checks — opening a held-flag await window without ever touching restic/pg_dump (I1).
    // The pre-fix code claimed the flag only AFTER awaiting the binary probe, so two callers
    // entering in the same tick both passed the `if (inFlight)` gate and raced into pg_dump.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let hookFired = false;
    __setProbeHookForTest(() => {
      hookFired = true;
      return gate; // the admitted caller parks here, holding inFlight = true
    });

    const admittedP = backup(); // claims the flag synchronously, then parks in the hook
    await Promise.resolve(); // let the admitted call reach the hook's await
    expect(hookFired).toBe(true);

    // Second caller enters now, with the flag held by the parked admitted call: must skip.
    const second = await dbSnapshot();
    expect(second.ran).toBe(false);
    expect(second.detail).toMatch(/in flight/i);

    release(); // unpark the admitted call; offline it stops at the unconfigured check
    const admitted = await admittedP;
    expect(admitted.ran).toBe(false);
    expect(admitted.detail).toMatch(/not configured/i);
  });
});

describe("BACKUP_CRON scheduling", () => {
  test("the default expression is a valid cron", () => {
    expect(config.backupCron).toBe("*/15 * * * *");
    const c = new Cron(config.backupCron, { paused: true });
    expect(c.nextRun()).toBeInstanceOf(Date);
    c.stop();
  });
});
