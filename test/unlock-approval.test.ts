import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import postgres from "postgres";
import { withAdminDbTransaction } from "../src/db/client";
import {
  allowedTier,
  approveTier2UnlockRequest,
  requestTier2Unlock,
  withActorDbSession,
} from "../src/db/repo";
import type { AuditSink } from "../src/mcp/audit";
import { envelope } from "../src/mcp/envelope";
import { buildServer } from "../src/mcp/server";
import type { ToolDef } from "../src/mcp/tools/registry";
import { unlockTool } from "../src/mcp/tools/unlock";
import { resetDb, testSql } from "./helpers";
import { type TrackedTestSqlPoolHandle, trackTestSqlPool } from "./setup";
import { dropTestAppRole, mintTestAppRole } from "./support/app-role";

let app: ReturnType<typeof postgres>;
let appRole: Awaited<ReturnType<typeof mintTestAppRole>>;
let appHeld: TrackedTestSqlPoolHandle | undefined;

beforeAll(async () => {
  await resetDb();
  appRole = await mintTestAppRole(process.env.DATABASE_URL!);
  app = postgres(appRole.databaseUrl, { max: 1, onnotice: () => {} });
  appHeld = trackTestSqlPool(app);
});

afterAll(async () => {
  await appHeld?.close();
  appHeld?.unregister();
  if (appRole) await dropTestAppRole(appRole);
});

describe("owner-approved session unlock", () => {
  test("pending requests remain locked and approval is exact-session and one-use", async () => {
    const actor = "agent:approval-flow";
    const sessionId = crypto.randomUUID();
    const request = await withActorDbSession(actor, () => requestTier2Unlock(5), sessionId);

    expect(await allowedTier(actor, sessionId)).toBe(1);
    const approved = await withAdminDbTransaction(() =>
      approveTier2UnlockRequest(request.id, "owner:test"),
    );
    expect(approved).toMatchObject({ id: request.id, minutes: 5 });
    expect(approved.expires_at.getTime()).toBeGreaterThan(Date.now());
    expect(await allowedTier(actor, sessionId)).toBe(2);
    expect(await allowedTier(actor, crypto.randomUUID())).toBe(1);
    expect(await allowedTier("agent:other", sessionId)).toBe(1);
    expect(await allowedTier(actor)).toBe(1);

    await expect(
      withAdminDbTransaction(() => approveTier2UnlockRequest(request.id, "owner:test")),
    ).rejects.toThrow("unlock_request_not_approvable");

    const [event] = await testSql`
      select payload from events
      where verb = 'unlock:tier2:approved' and entity_id = ${request.id}::uuid`;
    expect(event?.payload).toEqual({
      request_id: request.id,
      minutes: 5,
    });
    expect(JSON.stringify(event)).not.toContain(sessionId);
  });

  test("configured approval ceiling rejects an otherwise valid pending request", async () => {
    const request = await withActorDbSession(
      "agent:over-limit",
      () => requestTier2Unlock(61),
      crypto.randomUUID(),
    );
    await expect(
      withAdminDbTransaction(() => approveTier2UnlockRequest(request.id, "owner:test")),
    ).rejects.toThrow("unlock_request_not_approvable");
    const [stored] = await testSql`
      select approved_at, approved_by, expires_at
      from session_unlocks where id = ${request.id}::uuid`;
    expect(stored).toEqual({ approved_at: null, approved_by: null, expires_at: null });
  });

  test("a pending request cannot be approved after its short approval window", async () => {
    const request = await withActorDbSession(
      "agent:stale-request",
      () => requestTier2Unlock(5),
      crypto.randomUUID(),
    );
    await testSql`
      update session_unlocks set requested_at = clock_timestamp() - interval '11 minutes'
      where id = ${request.id}::uuid`;
    await expect(
      withAdminDbTransaction(() => approveTier2UnlockRequest(request.id, "owner:test")),
    ).rejects.toThrow("unlock_request_not_approvable");
    const [stored] = await testSql`
      select approved_at, approved_by, expires_at
      from session_unlocks where id = ${request.id}::uuid`;
    expect(stored).toEqual({ approved_at: null, approved_by: null, expires_at: null });
  });

  test("missing and malformed session settings fail closed", async () => {
    const actor = "agent:malformed-session";
    const sessionId = crypto.randomUUID();
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('minime.actor', ${actor}, true)`;
        await tx`select set_config('minime.session_id', 'not-a-uuid', true)`;
        await tx`select app_request_tier2_unlock(5::smallint)`;
      }),
    ).rejects.toThrow("unlock_session_required");
    const [request] = await app.begin(async (tx) => {
      await tx`select set_config('minime.actor', ${actor}, true)`;
      await tx`select set_config('minime.session_id', ${sessionId}, true)`;
      return tx`select app_request_tier2_unlock(5::smallint)::text as id`;
    });
    await testSql`
      update session_unlocks
      set approved_at = clock_timestamp(), approved_by = 'owner:test',
          expires_at = clock_timestamp() + interval '5 minutes'
      where id = ${request!.id}::uuid`;

    for (const malformed of ["", "not-a-uuid", "00000000-0000-0000-0000-00000000000z"]) {
      const [tier] = await app.begin(async (tx) => {
        await tx`select set_config('minime.actor', ${actor}, true)`;
        await tx`select set_config('minime.session_id', ${malformed}, true)`;
        return tx`select app_allowed_tier()::int as tier`;
      });
      expect(Number(tier?.tier)).toBe(1);
    }
  });

  test("an approval expires between statements in the same actor transaction", async () => {
    const actor = "agent:in-transaction-expiry";
    const sessionId = crypto.randomUUID();
    const request = await withActorDbSession(actor, () => requestTier2Unlock(5), sessionId);
    await testSql`
      update session_unlocks
      set approved_at = clock_timestamp(), approved_by = 'owner:test',
          expires_at = clock_timestamp() + interval '1 second'
      where id = ${request.id}::uuid`;

    const tiers = await app.begin(async (tx) => {
      await tx`select set_config('minime.actor', ${actor}, true)`;
      await tx`select set_config('minime.session_id', ${sessionId}, true)`;
      const [before] = await tx`select app_allowed_tier()::int as tier`;
      await Bun.sleep(1_100);
      const [after] = await tx`select app_allowed_tier()::int as tier`;
      return [Number(before?.tier), Number(after?.tier)];
    });
    expect(tiers).toEqual([2, 1]);
  });

  test("a reconnect with the same client name receives a fresh locked session", async () => {
    const seenSessions: string[] = [];
    const observedUnlock: ToolDef = {
      ...unlockTool,
      handler: async (params, ctx) => {
        if (ctx.sessionId) seenSessions.push(ctx.sessionId);
        return unlockTool.handler(params, ctx);
      },
    };
    const tierProbe: ToolDef = {
      name: "tier_probe",
      description: "Test-only access probe.",
      schema: {},
      handler: async () => envelope({ tier: await allowedTier() }),
    };
    let auditId = 0;
    const testAuditSink: AuditSink = {
      async attempt() {
        return "0".repeat(16);
      },
      async result() {
        auditId++;
        return { eventId: String(auditId) };
      },
      async disposition() {},
    };
    const server = buildServer({ tools: [observedUnlock, tierProbe], auditSink: testAuditSink });

    async function connect(): Promise<{
      client: Client;
      call(name: string, args?: Record<string, unknown>): Promise<string>;
    }> {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "same-client", version: "1.0.0" });
      await client.connect(clientTransport);
      return {
        client,
        async call(name, args = {}) {
          const response: any = await client.callTool({ name, arguments: args });
          return String(response.content?.[0]?.text ?? "");
        },
      };
    }

    const first = await connect();
    const unlockText = await first.call("minime_unlock", { minutes: 5 });
    const unlock = JSON.parse(unlockText);
    expect(unlock.data.status).toBe("pending");
    expect(unlockText).not.toContain(seenSessions[0]!);
    await withAdminDbTransaction(() =>
      approveTier2UnlockRequest(unlock.data.request_id, "owner:test"),
    );
    expect(JSON.parse(await first.call("tier_probe")).data.tier).toBe(2);
    await first.client.close();
    await server.close();

    const second = await connect();
    expect(JSON.parse(await second.call("tier_probe")).data.tier).toBe(1);
    const secondUnlockText = await second.call("minime_unlock", { minutes: 5 });
    const rejectedText = await second.call("minime_unlock", { minutes: 999 });
    expect(seenSessions).toHaveLength(3);
    expect(seenSessions[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(seenSessions[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(seenSessions[1]).not.toBe(seenSessions[0]);
    expect(seenSessions[2]).toBe(seenSessions[1]);
    expect(secondUnlockText).not.toContain(seenSessions[0]!);
    expect(secondUnlockText).not.toContain(seenSessions[1]!);
    expect(rejectedText).not.toContain(seenSessions[0]!);
    expect(rejectedText).not.toContain(seenSessions[1]!);
    const leaked = await testSql`
      select count(*)::int as n from events
      where payload::text like ${`%${seenSessions[0]}%`}
         or payload::text like ${`%${seenSessions[1]}%`}`;
    expect(Number(leaked[0]?.n)).toBe(0);
    await second.client.close();
    await server.close();
  });

  test("CLI approval runs before the Ollama preflight", async () => {
    const sessionId = crypto.randomUUID();
    const request = await withActorDbSession(
      "agent:cli-order",
      () => requestTier2Unlock(5),
      sessionId,
    );
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "run", "src/cli.ts", "unlock:approve", request.id],
      {
        cwd: new URL("..", import.meta.url).pathname,
        env: {
          ...process.env,
          OLLAMA_URL: "http://example.test:11434",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain(`approved tier-2 request ${request.id}`);
    expect(`${stdout}\n${stderr}`).not.toContain("OLLAMA_URL");
    expect(`${stdout}\n${stderr}`).not.toContain(sessionId);
    expect(await allowedTier("agent:cli-order", sessionId)).toBe(2);
  });
});

async function spawnUnlockApprove(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "run", "src/cli.ts", "unlock:approve", ...args],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("unlock:approve --latest", () => {
  // --latest lists every pending request regardless of actor, so leftover rows from earlier
  // tests in this shared scratch database would make these counts nondeterministic.
  beforeEach(async () => {
    await testSql`delete from session_unlocks`;
  });

  test("approves the single pending request and prints who requested it", async () => {
    const sessionId = crypto.randomUUID();
    const request = await withActorDbSession(
      "agent:cli-latest-single",
      () => requestTier2Unlock(5),
      sessionId,
    );
    const { code, stdout, stderr } = await spawnUnlockApprove(["--latest"]);
    expect(code).toBe(0);
    expect(stdout).toContain(`approved tier-2 request ${request.id}`);
    expect(stdout).toContain("agent:cli-latest-single");
    expect(`${stdout}\n${stderr}`).not.toContain(sessionId);
    expect(await allowedTier("agent:cli-latest-single", sessionId)).toBe(2);
  });

  test("refuses and lists every pending id when more than one request is pending", async () => {
    const sessionA = crypto.randomUUID();
    const sessionB = crypto.randomUUID();
    const requestA = await withActorDbSession(
      "agent:cli-latest-multi-a",
      () => requestTier2Unlock(5),
      sessionA,
    );
    const requestB = await withActorDbSession(
      "agent:cli-latest-multi-b",
      () => requestTier2Unlock(5),
      sessionB,
    );
    const { code, stdout, stderr } = await spawnUnlockApprove(["--latest"]);
    expect(code).toBe(1);
    const combined = `${stdout}\n${stderr}`;
    expect(combined).toContain(requestA.id);
    expect(combined).toContain(requestB.id);
    expect(combined).toContain("agent:cli-latest-multi-a");
    expect(combined).toContain("agent:cli-latest-multi-b");
    expect(combined).not.toContain(sessionA);
    expect(combined).not.toContain(sessionB);
    expect(await allowedTier("agent:cli-latest-multi-a", sessionA)).toBe(1);
    expect(await allowedTier("agent:cli-latest-multi-b", sessionB)).toBe(1);
  });

  test("refuses when no request is pending", async () => {
    const { code, stdout, stderr } = await spawnUnlockApprove(["--latest"]);
    expect(code).toBe(1);
    expect(`${stdout}\n${stderr}`).toContain(
      "no pending unlock request within the approval window",
    );
  });

  test("TIER2_UNLOCK_APPROVAL_WINDOW_MINUTES honors a narrower or wider window end-to-end", async () => {
    const sessionId = crypto.randomUUID();
    const request = await withActorDbSession(
      "agent:cli-window-override",
      () => requestTier2Unlock(5),
      sessionId,
    );
    await testSql`
      update session_unlocks set requested_at = clock_timestamp() - interval '2 minutes'
      where id = ${request.id}::uuid`;

    const tooNarrow = await spawnUnlockApprove([request.id], {
      TIER2_UNLOCK_APPROVAL_WINDOW_MINUTES: "1",
    });
    expect(tooNarrow.code).toBe(1);
    expect(`${tooNarrow.stdout}\n${tooNarrow.stderr}`).toContain(
      "unlock request is not pending and eligible",
    );
    expect(await allowedTier("agent:cli-window-override", sessionId)).toBe(1);

    const wideEnough = await spawnUnlockApprove([request.id], {
      TIER2_UNLOCK_APPROVAL_WINDOW_MINUTES: "60",
    });
    expect(wideEnough.code).toBe(0);
    expect(wideEnough.stdout).toContain(`approved tier-2 request ${request.id}`);
    expect(await allowedTier("agent:cli-window-override", sessionId)).toBe(2);
  });
});
