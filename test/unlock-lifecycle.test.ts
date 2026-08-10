// W4-12: the rest of the unlock lifecycle beyond W1-6's unlock:approve --latest --
// repo.pendingAndActiveUnlocks/revokeTier2Unlock, the unlock:status/unlock:revoke CLI commands,
// the fixed unlock:tier2:revoked audit payload, and the resident serve supervisor's
// pending-request surfacing (src/serve.ts's formatPendingUnlockLine + its ~5s poll cron). The
// central risk this file guards (see the task's own risk note): revoke must fail closed --
// 023_session_unlock_approval.sql's app_allowed_tier() re-checks expires_at on every single
// statement rather than caching anything per transaction/connection, so a revoked approval must
// deny the very next read, even mid-transaction elsewhere. No MCP-side surface can approve or
// revoke here — everything in this file is owner-DSN/CLI-only, matching unlock:approve's own
// established boundary.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { withAdminDbTransaction } from "../src/db/client";
import {
  type PendingTier2UnlockRequest,
  allowedTier,
  approveTier2UnlockRequest,
  pendingAndActiveUnlocks,
  pendingTier2UnlockRequests,
  requestTier2Unlock,
  revokeTier2Unlock,
  withActorDbSession,
} from "../src/db/repo";
import { formatPendingUnlockLine, startOwnerMaintenanceSchedule } from "../src/serve";
import { resetDb, testSql } from "./helpers";
import { dropTestAppRole, mintTestAppRole } from "./support/app-role";

beforeAll(async () => {
  await resetDb();
});

// Every test below mints its own fresh-UUID requests and reads them back by id, but
// pendingAndActiveUnlocks/revokeTier2Unlock('s --all path) scan the whole table -- a clean slate
// per test keeps those scans exact instead of accumulating leftovers across tests in this file.
beforeEach(async () => {
  await testSql`delete from session_unlocks`;
});

async function spawnCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, "--no-env-file", "run", "src/cli.ts", ...args], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("pendingAndActiveUnlocks", () => {
  test("lists a pending request and an active approval with remaining minutes, excluding an expired one", async () => {
    const pendingSession = crypto.randomUUID();
    const pending = await withActorDbSession(
      "agent:status-pending",
      () => requestTier2Unlock(5),
      pendingSession,
    );

    const activeSession = crypto.randomUUID();
    const activeRequest = await withActorDbSession(
      "agent:status-active",
      () => requestTier2Unlock(10),
      activeSession,
    );
    await withAdminDbTransaction(() => approveTier2UnlockRequest(activeRequest.id, "owner:test"));

    const expiredSession = crypto.randomUUID();
    const expiredRequest = await withActorDbSession(
      "agent:status-expired",
      () => requestTier2Unlock(5),
      expiredSession,
    );
    await withAdminDbTransaction(() => approveTier2UnlockRequest(expiredRequest.id, "owner:test"));
    // Move both approved_at and expires_at into the past together (not just expires_at alone):
    // the approval_consistency_check constraint requires expires_at > approved_at, and
    // approved_at was itself only just set moments ago by the approve call above, so shifting
    // expires_at alone into the past could -- and did, before this fix -- land it before its own
    // approved_at and fail the constraint.
    await testSql`
      update session_unlocks
      set approved_at = clock_timestamp() - interval '10 minutes',
          expires_at = clock_timestamp() - interval '5 minutes'
      where id = ${expiredRequest.id}::uuid`;

    const unlocks = await withAdminDbTransaction(() => pendingAndActiveUnlocks());
    const byId = new Map(unlocks.map((u) => [u.id, u]));

    const pendingRow = byId.get(pending.id);
    expect(pendingRow?.status).toBe("pending");
    expect(pendingRow).toMatchObject({
      requestedBy: "agent:status-pending",
      requestedMinutes: 5,
    });

    const activeRow = byId.get(activeRequest.id);
    expect(activeRow?.status).toBe("active");
    if (activeRow?.status !== "active") throw new Error("expected an active row");
    expect(activeRow.requestedBy).toBe("agent:status-active");
    expect(activeRow.remainingMinutes).toBeGreaterThan(0);
    expect(activeRow.remainingMinutes).toBeLessThanOrEqual(10);
    expect(activeRow.expiresAt.getTime()).toBeGreaterThan(Date.now());

    expect(byId.has(expiredRequest.id)).toBe(false);
  });
});

describe("revokeTier2Unlock fails closed", () => {
  let appRole: Awaited<ReturnType<typeof mintTestAppRole>>;
  let app: ReturnType<typeof postgres>;

  beforeAll(async () => {
    appRole = await mintTestAppRole(process.env.DATABASE_URL!);
    app = postgres(appRole.databaseUrl, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await app?.end({ timeout: 2 });
    if (appRole) await dropTestAppRole(appRole);
  });

  // The mandatory guard test (task risk note): proves revoke isn't merely a future-expiry write
  // that a session sitting mid-transaction could ride out. Same technique as
  // unlock-approval.test.ts's "an approval expires between statements in the same actor
  // transaction" -- one held-open transaction on the restricted app role, two statements, with
  // the mutation happening on a completely separate (admin) connection in the gap between them.
  test("revoking mid-transaction denies the very next statement in that same open transaction", async () => {
    const actor = "agent:mid-session-revoke";
    const sessionId = crypto.randomUUID();
    const request = await withActorDbSession(actor, () => requestTier2Unlock(5), sessionId);
    await withAdminDbTransaction(() => approveTier2UnlockRequest(request.id, "owner:test"));

    const tiers = await app.begin(async (tx) => {
      await tx`select set_config('minime.actor', ${actor}, true)`;
      await tx`select set_config('minime.session_id', ${sessionId}, true)`;
      const [before] = await tx`select app_allowed_tier()::int as tier`;
      await withAdminDbTransaction(() => revokeTier2Unlock(request.id));
      const [after] = await tx`select app_allowed_tier()::int as tier`;
      return [Number(before?.tier), Number(after?.tier)];
    });
    expect(tiers).toEqual([2, 1]);
  });

  test("revoking also denies a fresh, separate read afterward", async () => {
    const actor = "agent:post-revoke-fresh-read";
    const sessionId = crypto.randomUUID();
    const request = await withActorDbSession(actor, () => requestTier2Unlock(5), sessionId);
    await withAdminDbTransaction(() => approveTier2UnlockRequest(request.id, "owner:test"));
    expect(await allowedTier(actor, sessionId)).toBe(2);

    const revoked = await withAdminDbTransaction(() => revokeTier2Unlock(request.id));
    expect(revoked).toEqual([{ id: request.id, requestedBy: actor, minutes: 5 }]);

    expect(await allowedTier(actor, sessionId)).toBe(1);
  });

  test("revoking a still-pending, never-approved request does nothing", async () => {
    const sessionId = crypto.randomUUID();
    const request = await withActorDbSession(
      "agent:revoke-still-pending",
      () => requestTier2Unlock(5),
      sessionId,
    );
    const revoked = await withAdminDbTransaction(() => revokeTier2Unlock(request.id));
    expect(revoked).toEqual([]);
    expect(await allowedTier("agent:revoke-still-pending", sessionId)).toBe(1);
  });

  test("revoke writes one unlock:tier2:revoked event per row, same fixed payload shape as approval, and never the session id", async () => {
    const sessionId = crypto.randomUUID();
    const request = await withActorDbSession(
      "agent:revoke-audit",
      () => requestTier2Unlock(7),
      sessionId,
    );
    await withAdminDbTransaction(() => approveTier2UnlockRequest(request.id, "owner:test"));
    await withAdminDbTransaction(() => revokeTier2Unlock(request.id, "owner:test"));

    const [event] = await testSql`
      select payload from events
      where verb = 'unlock:tier2:revoked' and entity_id = ${request.id}::uuid`;
    expect(event?.payload).toEqual({ request_id: request.id, minutes: 7 });
    expect(JSON.stringify(event)).not.toContain(sessionId);
  });

  test("revoke with no id closes every active approval and leaves a still-pending request alone", async () => {
    const sessionA = crypto.randomUUID();
    const requestA = await withActorDbSession(
      "agent:revoke-all-a",
      () => requestTier2Unlock(5),
      sessionA,
    );
    await withAdminDbTransaction(() => approveTier2UnlockRequest(requestA.id, "owner:test"));

    const sessionB = crypto.randomUUID();
    const requestB = await withActorDbSession(
      "agent:revoke-all-b",
      () => requestTier2Unlock(5),
      sessionB,
    );
    await withAdminDbTransaction(() => approveTier2UnlockRequest(requestB.id, "owner:test"));

    const stillPendingSession = crypto.randomUUID();
    const stillPending = await withActorDbSession(
      "agent:revoke-all-pending",
      () => requestTier2Unlock(5),
      stillPendingSession,
    );

    const revoked = await withAdminDbTransaction(() => revokeTier2Unlock());
    expect(revoked.map((r) => r.id).sort()).toEqual([requestA.id, requestB.id].sort());
    expect(await allowedTier("agent:revoke-all-a", sessionA)).toBe(1);
    expect(await allowedTier("agent:revoke-all-b", sessionB)).toBe(1);
    expect(await allowedTier("agent:revoke-all-pending", stillPendingSession)).toBe(1);

    const pending = await withAdminDbTransaction(() => pendingTier2UnlockRequests());
    expect(pending.map((p) => p.id)).toContain(stillPending.id);
  });
});

describe("formatPendingUnlockLine (resident supervisor line, pure)", () => {
  const request: PendingTier2UnlockRequest = {
    id: "11111111-1111-4111-8111-111111111111",
    requestedBy: "agent:should-never-appear-in-the-resident-line",
    requestedMinutes: 5,
    requestedAt: new Date("2026-08-10T12:00:00.000Z"),
  };

  test("formats request id, requested minutes, and the approval window's own close time -- never the requesting actor or a raw timestamp", () => {
    const line = formatPendingUnlockLine(request, 10, "Asia/Singapore");
    expect(line).toBe(
      "tier-2 unlock requested (5min): bun run src/cli.ts unlock:approve " +
        "11111111-1111-4111-8111-111111111111 — expires 20:10",
    );
    expect(line).not.toContain(request.requestedBy);
    expect(line).not.toContain(request.requestedAt.toISOString());
    expect(line).not.toContain(String(request.requestedAt.getTime()));
  });

  test("derives HH:MM from the configured owner time zone, not UTC and not the process's own local zone", () => {
    // 2026-08-10T12:00:00Z + 10min = 12:10Z. Singapore is UTC+8 year-round; Los Angeles is
    // UTC-7 in August (PDT) -- two different, both non-UTC zones from the exact same instant.
    const singapore = formatPendingUnlockLine(request, 10, "Asia/Singapore");
    const losAngeles = formatPendingUnlockLine(request, 10, "America/Los_Angeles");
    expect(singapore).toContain("expires 20:10");
    expect(losAngeles).toContain("expires 05:10");
    expect(singapore).not.toBe(losAngeles);
  });

  test("defaults to the configured owner time zone (config.tz) when none is passed", () => {
    // test/setup.ts pins TZ=Asia/Singapore for the whole run, so config.tz's default matches.
    expect(formatPendingUnlockLine(request, 10)).toBe(
      formatPendingUnlockLine(request, 10, "Asia/Singapore"),
    );
  });
});

describe("resident pending-unlock watch (serve.ts, integration)", () => {
  interface FakeCronRegistration {
    pattern: string;
    fire: () => void;
  }

  // Same technique as test/maintenance-lock.test.ts's fakeCronFactory: record every cron the
  // scheduler tries to register and let the test fire the one it cares about directly, instead
  // of waiting out a real ~5s interval.
  function fakeCronFactory() {
    const registrations: FakeCronRegistration[] = [];
    const factory = (pattern: string, _options: { timezone: string }, callback: () => void) => {
      registrations.push({ pattern, fire: () => callback() });
      return { nextRun: () => null, stop: () => {} };
    };
    return { factory, registrations };
  }

  // scheduleUnlockWatch's own run() wrapper is fire-and-forget (matches every other cron
  // callback in serve.ts) -- there is no promise to await back from a fired registration, so
  // this polls for the expected side effect the same way maintenance-lock.test.ts's own
  // "a failing cron job writes..." test polls ops.log for a fired brief cron's effect.
  async function waitUntil(predicate: () => boolean, attempts = 40, delayMs = 50): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  test("prints one line per newly-seen pending request, deduplicates on the next tick, and never prints the requesting actor or session id", async () => {
    const sessionId = crypto.randomUUID();
    const request = await withActorDbSession(
      "agent:resident-watch-sensitive-actor-name",
      () => requestTier2Unlock(6),
      sessionId,
    );

    const { factory, registrations } = fakeCronFactory();
    const schedule = await startOwnerMaintenanceSchedule(factory);
    const lines: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      const watch = registrations.find((r) => r.pattern === "*/5 * * * * *");
      expect(watch).toBeDefined();

      watch!.fire();
      await waitUntil(() => lines.some((line) => line.includes(request.id)));
      const firstPass = lines.filter((line) => line.includes(request.id));
      expect(firstPass).toHaveLength(1);
      expect(firstPass[0]).toContain("tier-2 unlock requested (6min)");
      expect(firstPass[0]).toContain(`unlock:approve ${request.id}`);
      expect(firstPass[0]).not.toContain("agent:resident-watch-sensitive-actor-name");
      expect(firstPass[0]).not.toContain(sessionId);

      watch!.fire(); // a second tick with nothing new must not reprint
      await new Promise((resolve) => setTimeout(resolve, 200));
      const secondPass = lines.filter((line) => line.includes(request.id));
      expect(secondPass).toHaveLength(1);
    } finally {
      console.error = originalError;
      await schedule.close();
    }
  });
});

describe("unlock:status and unlock:revoke (CLI, ahead of the Ollama preflight)", () => {
  test("unlock:status lists a pending request and an active approval with remaining minutes, without needing Ollama", async () => {
    const pendingSession = crypto.randomUUID();
    const pending = await withActorDbSession(
      "agent:status-cli-pending",
      () => requestTier2Unlock(5),
      pendingSession,
    );
    const activeSession = crypto.randomUUID();
    const activeRequest = await withActorDbSession(
      "agent:status-cli-active",
      () => requestTier2Unlock(20),
      activeSession,
    );
    await withAdminDbTransaction(() => approveTier2UnlockRequest(activeRequest.id, "owner:test"));

    const { code, stdout, stderr } = await spawnCli(["unlock:status"], {
      OLLAMA_URL: "http://example.test:11434",
    });
    expect(code).toBe(0);
    expect(stdout).toContain(pending.id);
    expect(stdout).toContain(activeRequest.id);
    expect(stdout).toContain("active");
    expect(stdout).toContain("min remaining");
    expect(stdout).toContain("-- 2 pending/active tier-2 unlock(s)");
    const combined = `${stdout}\n${stderr}`;
    expect(combined).not.toContain("OLLAMA_URL");
    expect(combined).not.toContain(pendingSession);
    expect(combined).not.toContain(activeSession);
  });

  test("unlock:status reports an empty ceremony plainly", async () => {
    const { code, stdout } = await spawnCli(["unlock:status"], {
      OLLAMA_URL: "http://example.test:11434",
    });
    expect(code).toBe(0);
    expect(stdout).toContain("no pending or active tier-2 unlocks");
  });

  test("unlock:revoke closes an active approval, audits it, and reports it without needing Ollama", async () => {
    const sessionId = crypto.randomUUID();
    const request = await withActorDbSession(
      "agent:revoke-cli",
      () => requestTier2Unlock(15),
      sessionId,
    );
    await withAdminDbTransaction(() => approveTier2UnlockRequest(request.id, "owner:test"));
    expect(await allowedTier("agent:revoke-cli", sessionId)).toBe(2);

    const { code, stdout, stderr } = await spawnCli(["unlock:revoke", request.id], {
      OLLAMA_URL: "http://example.test:11434",
    });
    expect(code).toBe(0);
    expect(stdout).toContain(`revoked tier-2 request ${request.id}`);
    expect(stdout).toContain("15min");
    const combined = `${stdout}\n${stderr}`;
    expect(combined).not.toContain("OLLAMA_URL");
    expect(combined).not.toContain(sessionId);
    expect(await allowedTier("agent:revoke-cli", sessionId)).toBe(1);

    const [event] = await testSql`
      select payload from events
      where verb = 'unlock:tier2:revoked' and entity_id = ${request.id}::uuid`;
    expect(event?.payload).toEqual({ request_id: request.id, minutes: 15 });
  });

  test("unlock:revoke --all reports nothing to revoke when no unlock is active, without needing Ollama", async () => {
    const { code, stdout, stderr } = await spawnCli(["unlock:revoke", "--all"], {
      OLLAMA_URL: "http://example.test:11434",
    });
    expect(code).toBe(0);
    expect(stdout).toContain("no active tier-2 unlocks to revoke");
    expect(`${stdout}\n${stderr}`).not.toContain("OLLAMA_URL");
  });

  test("unlock:revoke rejects an id with no active approval", async () => {
    const { code, stdout, stderr } = await spawnCli(["unlock:revoke", crypto.randomUUID()], {
      OLLAMA_URL: "http://example.test:11434",
    });
    expect(code).toBe(1);
    expect(`${stdout}\n${stderr}`).toContain("no active tier-2 unlock to revoke");
  });

  test("unlock:revoke rejects a malformed argument", async () => {
    const { code, stdout, stderr } = await spawnCli(["unlock:revoke", "not-a-uuid"], {
      OLLAMA_URL: "http://example.test:11434",
    });
    expect(code).toBe(2);
    expect(`${stdout}\n${stderr}`).toContain("requires exactly one <request-id>, or --all");
  });
});
