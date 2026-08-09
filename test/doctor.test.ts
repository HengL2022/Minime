// W3-7: minime doctor CLI + ops_health in stateSnapshot + ops_failure review kind (migration
// 033). Covers repo.ts's opsHealth/recentEventsByVerb, serve.ts's persistent-failure detector,
// stateSnapshot's ops_health block (no tier leak), src/ops/doctor.ts's PASS/WARN/FAIL grading via
// injected probes, and the review_queue kind constraint itself.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAdminDbTransaction } from "../src/db/client";
import {
  type MaintenanceLockHandle,
  allowedTier,
  approveTier2UnlockRequest,
  insertReviewItem,
  openReviewItems,
  opsHealth,
  releaseMaintenanceLock,
  requestTier2Unlock,
  stateSnapshot,
  tryAcquireMaintenanceLock,
  withActorDbSession,
} from "../src/db/repo";
import { runDoctorChecks } from "../src/ops/doctor";
import { flagPersistentDreamFailure } from "../src/serve";
import { config } from "../src/util/config";
import { expectSqlReject, resetDb, testSql as sql } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

async function seedDreamSummary(at: Date, failedSteps: string[]): Promise<void> {
  await sql`insert into events (at, actor, verb, payload) values
    (${at}, 'system:dream', 'dream:summary', ${sql.json({ failed_steps: failedSteps })})`;
}

async function seedResticCheck(at: Date, ok: boolean): Promise<void> {
  await sql`insert into events (at, actor, verb, payload) values
    (${at}, 'system:backup', 'backup:restic-check', ${sql.json({ ok })})`;
}

const HOUR = 3_600_000;

describe("opsHealth (repo.ts)", () => {
  test("reflects nulls/empty/zero on a database with no dream history", async () => {
    expect(await opsHealth()).toEqual({
      dream_last_at: null,
      failed_steps: [],
      ops_failure_open: 0,
    });
  });

  test("reflects the most recent dream:summary event's failed steps and the open ops_failure count", async () => {
    await seedDreamSummary(new Date(Date.now() - 2 * HOUR), ["3_contradictions"]);
    const latestAt = new Date(Date.now() - HOUR);
    await seedDreamSummary(latestAt, ["4_stale", "5_rollups"]);
    await insertReviewItem("ops_failure", {
      failed_steps: ["4_stale", "5_rollups"],
      since: latestAt,
    });

    const health = await opsHealth();
    expect(health.dream_last_at?.getTime()).toBe(latestAt.getTime());
    expect(health.failed_steps).toEqual(["4_stale", "5_rollups"]);
    expect(health.ops_failure_open).toBe(1);
  });

  test("a clean latest run reports no failed steps even if an earlier run failed", async () => {
    await seedDreamSummary(new Date(Date.now() - 2 * HOUR), ["3_contradictions"]);
    await seedDreamSummary(new Date(Date.now() - HOUR), []);
    expect((await opsHealth()).failed_steps).toEqual([]);
  });
});

describe("flagPersistentDreamFailure (serve.ts)", () => {
  test("does nothing with fewer than 3 dream:summary events", async () => {
    await seedDreamSummary(new Date(Date.now() - 2 * HOUR), ["3_contradictions"]);
    await seedDreamSummary(new Date(Date.now() - HOUR), ["3_contradictions"]);
    await flagPersistentDreamFailure();
    expect(await openReviewItems("ops_failure")).toEqual([]);
  });

  test("does nothing when the 3 most recent runs are not ALL failing", async () => {
    await seedDreamSummary(new Date(Date.now() - 3 * HOUR), ["3_contradictions"]);
    await seedDreamSummary(new Date(Date.now() - 2 * HOUR), []); // one clean run in the window
    await seedDreamSummary(new Date(Date.now() - HOUR), ["3_contradictions"]);
    await flagPersistentDreamFailure();
    expect(await openReviewItems("ops_failure")).toEqual([]);
  });

  test("enqueues exactly one ops_failure item when the 3 most recent runs all failed", async () => {
    const oldest = new Date(Date.now() - 3 * HOUR);
    await seedDreamSummary(oldest, ["2_entity_link"]);
    await seedDreamSummary(new Date(Date.now() - 2 * HOUR), ["3_contradictions"]);
    await seedDreamSummary(new Date(Date.now() - HOUR), ["4_stale", "5_rollups"]);

    await flagPersistentDreamFailure();

    const items = await openReviewItems("ops_failure");
    expect(items).toHaveLength(1);
    expect(items[0]!.payload).toEqual({
      failed_steps: ["4_stale", "5_rollups"], // the most recent run's failed steps
      since: expect.any(String), // jsonb round-trips the Date as an ISO string
    });
    expect(new Date(items[0]!.payload.since).getTime()).toBe(oldest.getTime());
  });

  test("stays deduped while an ops_failure item is already open", async () => {
    await seedDreamSummary(new Date(Date.now() - 3 * HOUR), ["2_entity_link"]);
    await seedDreamSummary(new Date(Date.now() - 2 * HOUR), ["3_contradictions"]);
    await seedDreamSummary(new Date(Date.now() - HOUR), ["4_stale"]);
    await insertReviewItem("ops_failure", { failed_steps: ["pre_existing"], since: new Date() });

    await flagPersistentDreamFailure();

    expect(await openReviewItems("ops_failure")).toHaveLength(1);
  });

  test("a fourth failing run does not create a second item once the first is resolved", async () => {
    await seedDreamSummary(new Date(Date.now() - 3 * HOUR), ["2_entity_link"]);
    await seedDreamSummary(new Date(Date.now() - 2 * HOUR), ["3_contradictions"]);
    await seedDreamSummary(new Date(Date.now() - HOUR), ["4_stale"]);
    await flagPersistentDreamFailure();
    const [first] = await openReviewItems("ops_failure");
    expect(first).toBeDefined();

    await sql`update review_queue set status = 'resolved', resolved_at = now() where id = ${first!.id}`;
    await seedDreamSummary(new Date(), ["5_rollups"]);
    await flagPersistentDreamFailure();

    const open = await openReviewItems("ops_failure");
    expect(open).toHaveLength(1);
    expect(open[0]!.id).not.toBe(first!.id);
  });
});

describe("stateSnapshot ops_health (no tier leak)", () => {
  test("is identical for a tier-1 (locked) and a tier-2 (unlocked) actor", async () => {
    const latestAt = new Date(Date.now() - HOUR);
    await seedDreamSummary(latestAt, ["3_contradictions"]);
    await insertReviewItem("ops_failure", { failed_steps: ["3_contradictions"], since: latestAt });

    const lockedActor = "agent:doctor-test-locked";
    expect(await allowedTier(lockedActor)).toBe(1);
    const lockedSnapshot = await stateSnapshot(lockedActor, "UTC");

    const unlockedActor = "agent:doctor-test-unlocked";
    const sessionId = crypto.randomUUID();
    const request = await withActorDbSession(unlockedActor, () => requestTier2Unlock(5), sessionId);
    await withAdminDbTransaction(() => approveTier2UnlockRequest(request.id, "owner:test"));
    const unlockedSnapshot = await withActorDbSession(
      unlockedActor,
      () => stateSnapshot(unlockedActor, "UTC"),
      sessionId,
    );
    expect(await allowedTier(unlockedActor, sessionId)).toBe(2);

    expect(lockedSnapshot.ops_health).toEqual(unlockedSnapshot.ops_health);
    expect(lockedSnapshot.ops_health).toEqual({
      dream_last_at: expect.any(Date),
      failed_steps: ["3_contradictions"],
      ops_failure_open: 1,
    });
  });
});

async function withTempDumpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "minime-doctor-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const HEALTHY_STATFS = () => ({ bavail: 900, bsize: 4096, blocks: 1000 }); // 90% free
const CRITICAL_STATFS = () => ({ bavail: 10, bsize: 4096, blocks: 1000 }); // 1% free
// A path guaranteed not to exist, so checkDumpFreshness deterministically WARNs instead of
// reading whatever the real repo's db-dump/ happens to contain right now.
const NO_DUMP_DIR = "/private/tmp/minime-doctor-test-no-such-dump-dir";

describe("minime doctor (src/ops/doctor.ts)", () => {
  let lock: MaintenanceLockHandle | null = null;

  afterEach(async () => {
    if (lock) {
      await releaseMaintenanceLock(lock);
      lock = null;
    }
  });

  test("PASSes every check and exits 0 under healthy probes", async () => {
    lock = await tryAcquireMaintenanceLock();
    expect(lock).not.toBeNull();
    await seedDreamSummary(new Date(), []); // fresh, clean run
    await seedResticCheck(new Date(), true); // fresh, clean restic check

    const original = {
      resticRepository: config.resticRepository,
      resticPasswordFile: config.resticPasswordFile,
    };
    config.resticRepository = "test:repository";
    config.resticPasswordFile = "/test/restic-password";
    try {
      await withTempDumpDir(async (dumpDir) => {
        await writeFile(join(dumpDir, "minime.sql"), "-- fixture dump\n");
        await writeFile(join(dumpDir, "minime.manifest.json"), "{}");
        const result = await runDoctorChecks({
          statfs: HEALTHY_STATFS,
          fetchOllamaTags: async () => ["nomic-embed-text", "llama3.1:8b"],
          dumpDir,
        });
        expect(result.exitCode).toBe(0);
        expect(result.checks.map((c) => c.status)).toEqual([
          "PASS",
          "PASS",
          "PASS",
          "PASS",
          "PASS",
          "PASS",
          "PASS",
          "PASS",
        ]);
      });
    } finally {
      config.resticRepository = original.resticRepository;
      config.resticPasswordFile = original.resticPasswordFile;
    }
  });

  test("restic check WARNs (not FAILs) when restic is unconfigured", async () => {
    await seedDreamSummary(new Date(), []);
    // config.resticRepository/resticPasswordFile are left at their ambient (unconfigured) value
    // here -- this exercises doctor.ts's "not configured" return specifically (doctor.ts:154-156),
    // distinct from the "configured but has never run" branch covered just below.
    const result = await runDoctorChecks({
      statfs: HEALTHY_STATFS,
      fetchOllamaTags: async () => [],
      dumpDir: NO_DUMP_DIR,
    });
    const resticCheck = result.checks.find((c) => c.name === "restic check");
    expect(resticCheck).toEqual({
      name: "restic check",
      status: "WARN",
      detail: "restic not configured",
    });
    expect(result.exitCode).toBe(0);
  });

  // Review fix: a prior version of this test was titled to also cover "has never run", but never
  // configured restic, so it only ever exercised the "not configured" branch above -- the "has
  // never run" branch (doctor.ts:163, reachable only when restic IS configured but zero
  // backup:restic-check events exist yet, e.g. right after an owner enables restic, before the
  // first Sunday) had no coverage anywhere. This test configures restic and deliberately does not
  // seed a backup:restic-check event.
  test("restic check WARNs when restic is configured but has never run", async () => {
    await seedDreamSummary(new Date(), []); // no seedResticCheck() at all

    const original = {
      resticRepository: config.resticRepository,
      resticPasswordFile: config.resticPasswordFile,
    };
    config.resticRepository = "test:repository";
    config.resticPasswordFile = "/test/restic-password";
    try {
      const result = await runDoctorChecks({
        statfs: HEALTHY_STATFS,
        fetchOllamaTags: async () => [],
        dumpDir: NO_DUMP_DIR,
      });
      const resticCheck = result.checks.find((c) => c.name === "restic check");
      expect(resticCheck).toEqual({
        name: "restic check",
        status: "WARN",
        detail: "has never run",
      });
      expect(result.exitCode).toBe(0);
    } finally {
      config.resticRepository = original.resticRepository;
      config.resticPasswordFile = original.resticPasswordFile;
    }
  });

  // Review fix: the staleness branch (doctor.ts:169-171) -- a *successful* last check that is
  // older than RESTIC_CHECK_STALE_HOURS (192h, doctor.ts) -- had no coverage. This matters more
  // than a typical missing branch: staleness is the safety net meant to surface a silently
  // not-firing weekly cron (see the shipped-defaults collision regression test in
  // test/backup-preflight.test.ts) to the owner via `minime doctor`, so a regression in the
  // threshold, the comparison direction, or the message format here would ship undetected.
  test("WARNs when the last restic check succeeded but is older than the staleness threshold", async () => {
    await seedDreamSummary(new Date(), []);
    // One hour past the 192h threshold, with ok:true, isolates staleness from the separate
    // last-attempt-failed branch covered below.
    await seedResticCheck(new Date(Date.now() - 193 * HOUR), true);

    const original = {
      resticRepository: config.resticRepository,
      resticPasswordFile: config.resticPasswordFile,
    };
    config.resticRepository = "test:repository";
    config.resticPasswordFile = "/test/restic-password";
    try {
      const result = await runDoctorChecks({
        statfs: HEALTHY_STATFS,
        fetchOllamaTags: async () => [],
        dumpDir: NO_DUMP_DIR,
      });
      const resticCheck = result.checks.find((c) => c.name === "restic check");
      expect(resticCheck).toEqual({
        name: "restic check",
        status: "WARN",
        detail: "last run 193h ago",
      });
      expect(result.exitCode).toBe(0);
    } finally {
      config.resticRepository = original.resticRepository;
      config.resticPasswordFile = original.resticPasswordFile;
    }
  });

  // Review fix: checkResticCheck used to grade PASS purely from the audit event's recency, so a
  // repository that fails its integrity check on every run still read PASS as long as an attempt
  // happened recently. It now inspects the logged payload.ok (see doctor.ts:144-152), same as
  // sibling checkDream inspects opsHealth's failed_steps/ops_failure_open instead of only a
  // timestamp.
  test("WARNs (not PASS) when the last restic check attempt failed, even though it just ran", async () => {
    await seedDreamSummary(new Date(), []);
    await seedResticCheck(new Date(), false); // recent, but the check itself failed

    const original = {
      resticRepository: config.resticRepository,
      resticPasswordFile: config.resticPasswordFile,
    };
    config.resticRepository = "test:repository";
    config.resticPasswordFile = "/test/restic-password";
    try {
      const result = await runDoctorChecks({
        statfs: HEALTHY_STATFS,
        fetchOllamaTags: async () => [],
        dumpDir: NO_DUMP_DIR,
      });
      const resticCheck = result.checks.find((c) => c.name === "restic check");
      expect(resticCheck).toEqual({
        name: "restic check",
        status: "WARN",
        detail: "last check failed",
      });
      // Non-fatal, same as every other restic-check outcome (a bad week is recoverable; W3-7's
      // ops_failure counter is deliberately not wired to this verb -- see backup.ts:623-625).
      expect(result.exitCode).toBe(0);
    } finally {
      config.resticRepository = original.resticRepository;
      config.resticPasswordFile = original.resticPasswordFile;
    }
  });

  test("FAILs (nonzero exit) when dream has never run", async () => {
    const result = await runDoctorChecks({
      statfs: HEALTHY_STATFS,
      fetchOllamaTags: async () => [],
      dumpDir: NO_DUMP_DIR,
    });
    const dream = result.checks.find((c) => c.name === "dream");
    expect(dream).toEqual({ name: "dream", status: "FAIL", detail: "has never run" });
    expect(result.exitCode).toBe(1);
  });

  test("WARNs, and does not by itself force a nonzero exit, when Ollama is unreachable", async () => {
    await seedDreamSummary(new Date(), []);
    const result = await runDoctorChecks({
      statfs: HEALTHY_STATFS,
      fetchOllamaTags: async () => {
        throw new Error("connection refused");
      },
      dumpDir: NO_DUMP_DIR,
    });
    const ollama = result.checks.find((c) => c.name === "ollama");
    expect(ollama).toEqual({ name: "ollama", status: "WARN", detail: "not reachable" });
    expect(result.exitCode).toBe(0);
  });

  test("FAILs (nonzero exit) on critically low disk headroom", async () => {
    await seedDreamSummary(new Date(), []);
    const result = await runDoctorChecks({
      statfs: CRITICAL_STATFS,
      fetchOllamaTags: async () => [],
      dumpDir: NO_DUMP_DIR,
    });
    expect(
      result.checks.filter((c) => c.name.startsWith("disk:")).every((c) => c.status === "FAIL"),
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  test("every check detail is content-free: no secrets, URLs, or filesystem paths", async () => {
    const dumpDir = "/private/should/never/be/printed";
    const result = await runDoctorChecks({
      statfs: CRITICAL_STATFS,
      fetchOllamaTags: async () => {
        throw new Error("connection refused to http://127.0.0.1:11434 with secret token abc123");
      },
      dumpDir,
    });
    const rendered = JSON.stringify(result.checks);
    expect(rendered).not.toContain("http://");
    expect(rendered).not.toContain(dumpDir);
    expect(rendered).not.toContain("abc123");
  });
});

describe("migration 033: review_queue kind constraint", () => {
  test("accepts ops_failure and rejects an unknown kind", async () => {
    await sql`insert into review_queue (kind, payload) values ('ops_failure', '{}'::jsonb)`;
    await expectSqlReject(
      sql`insert into review_queue (kind, payload) values ('not_a_real_kind', '{}'::jsonb)`,
      /review_queue_kind_check/,
    );
  });
});
