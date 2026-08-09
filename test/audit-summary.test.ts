// W4-11: `audit --summary` (per-actor/verb, egress, and unlock rollups) plus the raw per-line
// mode's new --verb/--actor filters. Function-level assertions exercise auditSummarySince/
// eventsSince directly against seeded fictional events (I8: read-only, nothing here writes
// through anything but the same repo.ts paths minime_unlock/the LLM provider layer already use);
// CLI-subprocess assertions exercise src/cli.ts's own flag parsing, glob translation, and
// renderer end to end, the same Bun.spawn pattern test/tier0-cli-read.test.ts uses for its own
// owner-CLI-only commands.

import { beforeAll, describe, expect, test } from "bun:test";
import { withAdminDbTransaction } from "../src/db/client";
import {
  approveTier2UnlockRequest,
  auditSummarySince,
  logEgressIntent,
  logEgressOutcome,
  logEvent,
  requestTier2Unlock,
  withActorDbSession,
} from "../src/db/repo";
import { auditPayload } from "../src/util/audit-payload";
import { resetDb } from "./helpers";

const ACTOR_ALPHA = "agent:audit-summary-alpha";
const ACTOR_BETA = "agent:audit-summary-beta";
// A valid 16-hex params_hash sentinel (audit-payload.ts's HASH shape) — must never render in
// --summary output, which only ever surfaces actor/verb/count for tool-read rows.
const TOOL_HASH = "0123456789abcdef";

async function seedToolRead(actor: string, verb: string): Promise<void> {
  await logEvent({
    actor,
    verb,
    payload: auditPayload.toolResult({
      paramsHash: TOOL_HASH,
      returnedIds: [],
      returnedCount: 0,
      delivery: "direct",
    }),
  });
}

async function seedUnlock(actor: string, minutes: number): Promise<{ requestId: string }> {
  const sessionId = crypto.randomUUID();
  const request = await withActorDbSession(actor, () => requestTier2Unlock(minutes), sessionId);
  await logEvent({
    actor,
    verb: "unlock:tier2:requested",
    entityType: "session_unlock",
    entityId: request.id,
    payload: auditPayload.tier2Unlock({ requestId: request.id, minutes }),
  });
  await withAdminDbTransaction(() => approveTier2UnlockRequest(request.id, "owner:cli"));
  return { requestId: request.id };
}

async function spawnAuditCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  // `audit` sits after cli.ts's ollamaPreflight gate (unlike tx/health list), so a syntactically
  // valid loopback OLLAMA_URL is required to clear it even though audit itself never talks to
  // Ollama — same override test/tier0-cli-read.test.ts's own audit-render case (8) uses.
  const child = Bun.spawn([process.execPath, "--no-env-file", "run", "src/cli.ts", ...args], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, OLLAMA_URL: "http://localhost:11434" },
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

describe("audit --summary rollups and raw-mode --verb/--actor filters (W4-11)", () => {
  let unlockAlpha: { requestId: string };
  let unlockBeta: { requestId: string };

  beforeAll(async () => {
    await resetDb();

    // Tool reads: 3 + 2 for alpha across two verbs, 1 for beta — deliberately distinct counts
    // (3/2/1) so the "ordered by count desc" claim is unambiguous to assert on.
    await seedToolRead(ACTOR_ALPHA, "tool:minime_search");
    await seedToolRead(ACTOR_ALPHA, "tool:minime_search");
    await seedToolRead(ACTOR_ALPHA, "tool:minime_search");
    await seedToolRead(ACTOR_ALPHA, "tool:minime_get_context");
    await seedToolRead(ACTOR_ALPHA, "tool:minime_get_context");
    await seedToolRead(ACTOR_BETA, "tool:minime_search");

    // Egress intents: 2x anthropic/tier2 classify (one rollup row, count 2), 1x bedrock/tier1
    // classify, 1x openai embed (embed never carries route_tier — llmEgress's own embed branch
    // rejects one). Two paired :outcome events prove the rollup excludes them (they carry only
    // {intent_event_id, status}, no provider/route_tier).
    const classifyIntentId = await logEgressIntent({
      kind: "classify",
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      items: 1,
      routeTier: 2,
    });
    await logEgressIntent({
      kind: "classify",
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      items: 1,
      routeTier: 2,
    });
    await logEgressIntent({
      kind: "classify",
      provider: "bedrock",
      model: "us.anthropic.claude-3-5-haiku-20241022-v1:0",
      items: 1,
      routeTier: 1,
    });
    const embedIntentId = await logEgressIntent({
      kind: "embed",
      provider: "openai",
      model: "text-embedding-3-small",
      items: 5,
    });
    await logEgressOutcome({
      kind: "classify",
      intentEventId: classifyIntentId,
      status: "succeeded",
    });
    await logEgressOutcome({ kind: "embed", intentEventId: embedIntentId, status: "succeeded" });

    // Unlock: one requested+approved pair per actor.
    unlockAlpha = await seedUnlock(ACTOR_ALPHA, 30);
    unlockBeta = await seedUnlock(ACTOR_BETA, 15);

    // Noise: a differently-shaped payload family whose own field names (row_count, match_used)
    // must never surface in --summary output — makes the deep "no other payload keys" assertion
    // below meaningful rather than vacuous.
    await logEvent({
      actor: "owner:cli",
      verb: "cli:tx:list",
      payload: auditPayload.cliTxList({ month: "2026-08", rowCount: 5, matchUsed: true }),
    });
  });

  test("(1) auditSummarySince groups per-actor/verb counts, rolls up egress by provider/route_tier excluding paired outcome events, and lists unlock request+approval history newest first", async () => {
    const summary = await auditSummarySince(new Date(0));

    expect(summary.actorVerbCounts).toContainEqual({
      actor: ACTOR_ALPHA,
      verb: "tool:minime_search",
      count: 3,
    });
    expect(summary.actorVerbCounts).toContainEqual({
      actor: ACTOR_ALPHA,
      verb: "tool:minime_get_context",
      count: 2,
    });
    expect(summary.actorVerbCounts).toContainEqual({
      actor: ACTOR_BETA,
      verb: "tool:minime_search",
      count: 1,
    });
    // count-desc ordering: alpha's 3-count row outranks beta's 1-count row on the same verb.
    const alphaIdx = summary.actorVerbCounts.findIndex(
      (r) => r.actor === ACTOR_ALPHA && r.verb === "tool:minime_search",
    );
    const betaIdx = summary.actorVerbCounts.findIndex(
      (r) => r.actor === ACTOR_BETA && r.verb === "tool:minime_search",
    );
    expect(alphaIdx).toBeGreaterThanOrEqual(0);
    expect(betaIdx).toBeGreaterThan(alphaIdx);

    // Egress rollup: exactly 3 groups — the 2 anthropic/tier2 intents collapse into 1 row — and
    // never the 2 paired :outcome events.
    expect(summary.egressRollup).toHaveLength(3);
    expect(summary.egressRollup).toContainEqual({ provider: "anthropic", routeTier: 2, count: 2 });
    expect(summary.egressRollup).toContainEqual({ provider: "bedrock", routeTier: 1, count: 1 });
    expect(summary.egressRollup).toContainEqual({ provider: "openai", routeTier: null, count: 1 });
    expect(summary.egressEventCount).toBe(4); // 2 + 1 + 1 intents; outcomes excluded

    expect(summary.unlockHistory).toHaveLength(4);
    const unlockVerbs = summary.unlockHistory.map((r) => r.verb);
    expect(unlockVerbs.filter((v) => v === "unlock:tier2:requested")).toHaveLength(2);
    expect(unlockVerbs.filter((v) => v === "unlock:tier2:approved")).toHaveLength(2);
    expect(summary.unlockHistory).toContainEqual({
      at: expect.any(Date),
      verb: "unlock:tier2:requested",
      actor: ACTOR_ALPHA,
      requestId: unlockAlpha.requestId,
      minutes: 30,
    });
    expect(summary.unlockHistory).toContainEqual({
      at: expect.any(Date),
      verb: "unlock:tier2:approved",
      actor: "owner:cli",
      requestId: unlockBeta.requestId,
      minutes: 15,
    });
    for (let i = 1; i < summary.unlockHistory.length; i++) {
      expect(summary.unlockHistory[i - 1]!.at.getTime()).toBeGreaterThanOrEqual(
        summary.unlockHistory[i]!.at.getTime(),
      );
    }

    // Exact totals: nothing but this test's own seeding has touched `events` since resetDb().
    // 6 tool reads + 4 egress intents + 2 egress outcomes + 4 unlock events + 1 noise = 17.
    expect(summary.totalEvents).toBe(17);
    expect(summary.distinctActors).toBe(4); // alpha, beta, system:llm, owner:cli
  });

  test("(2) CLI subprocess: --verb 'egress:*' filters the raw per-line listing via glob-to-LIKE translation", async () => {
    const result = await spawnAuditCli(["audit", "--since", "1d", "--verb", "egress:*"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("egress:classify");
    expect(result.stdout).toContain("egress:embed");
    expect(result.stdout).toContain("egress:classify:outcome");
    expect(result.stdout).toContain("egress:embed:outcome");
    expect(result.stdout).not.toContain("tool:minime_search");
    expect(result.stdout).not.toContain("tool:minime_get_context");
    expect(result.stdout).not.toContain("unlock:tier2");
    expect(result.stdout).not.toContain("cli:tx:list");
    // 4 intents + 2 outcomes, nothing else seeded matches 'egress:%'.
    expect(result.stdout).toContain("-- 6 events in last 1d");
  });

  test("(3) CLI subprocess: --actor filters the raw per-line listing to one exact actor", async () => {
    const result = await spawnAuditCli(["audit", "--since", "1d", "--actor", ACTOR_BETA]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(ACTOR_BETA);
    expect(result.stdout).not.toContain(ACTOR_ALPHA);
    expect(result.stdout).not.toContain("system:llm");
    expect(result.stdout).not.toContain("owner:cli");
    // beta's own-actor rows only: 1 tool read + 1 unlock:tier2:requested (the paired approval's
    // actor is the approver, "owner:cli", not beta, so it is correctly excluded).
    expect(result.stdout).toContain("-- 2 events in last 1d");
  });

  test("(4) CLI subprocess: --summary renders the three rollups on one screen and the output string carries no payload keys or values beyond the fixed provider/route_tier/minutes set (deep assertion)", async () => {
    const result = await spawnAuditCli(["audit", "--summary", "--since", "1d"]);
    expect(result.code).toBe(0);
    const out = result.stdout;

    // The three rollups plus footer, in one screen.
    expect(out).toContain("events by actor/verb");
    expect(out).toContain("egress rollup");
    expect(out).toContain("unlock history");
    expect(out).toContain("-- 17 events, 4 distinct actor(s), 4 egress event(s) in last 1d --");

    // Allowed fields do render.
    expect(out).toContain(ACTOR_ALPHA);
    expect(out).toContain(ACTOR_BETA);
    expect(out).toContain("anthropic");
    expect(out).toContain("bedrock");
    expect(out).toContain("openai");
    expect(out).toContain(unlockAlpha.requestId);
    expect(out).toContain(unlockBeta.requestId);
    expect(out).toContain("30");
    expect(out).toContain("15");

    // Never a payload key (or value) outside the fixed allowlist this renderer touches — every
    // one of these is a real field name from a payload family this test actually seeded
    // (toolResult, the egress :outcome events, cliTxList), not an arbitrary guess.
    for (const forbidden of [
      "params_hash",
      "returned_ids",
      "returned_count",
      "delivery",
      "intent_event_id",
      "row_count",
      "match_used",
      "month",
      TOOL_HASH,
    ]) {
      expect(out).not.toContain(forbidden);
    }
  });
});

describe("audit --summary on an empty range (W4-11)", () => {
  beforeAll(async () => {
    await resetDb();
  });

  test("(5) renders three empty sections and a zeroed footer without crashing, both at the function level and through the CLI", async () => {
    const summary = await auditSummarySince(new Date(Date.now() - 86_400_000));
    expect(summary.totalEvents).toBe(0);
    expect(summary.distinctActors).toBe(0);
    expect(summary.egressEventCount).toBe(0);
    expect(summary.actorVerbCounts).toEqual([]);
    expect(summary.egressRollup).toEqual([]);
    expect(summary.unlockHistory).toEqual([]);

    const result = await spawnAuditCli(["audit", "--summary", "--since", "1d"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("events by actor/verb");
    expect(result.stdout).toContain("egress rollup");
    expect(result.stdout).toContain("unlock history");
    expect(result.stdout).toContain(
      "-- 0 events, 0 distinct actor(s), 0 egress event(s) in last 1d --",
    );
  });
});
