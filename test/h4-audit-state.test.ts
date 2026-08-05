import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { CallToolResult, RequestId } from "@modelcontextprotocol/sdk/types.js";
import {
  type AuditDisposition,
  type AuditSink,
  type DurableResultAudit,
  type ResultAuditRecord,
  paramsHash,
} from "../src/mcp/audit";
import {
  AuditCoordinator,
  type AuditedCallMeta,
  type CallbackResult,
  type OutboundClaim,
  type OutboundCorrelation,
} from "../src/mcp/audit-coordinator";
import { type Envelope, envelope } from "../src/mcp/envelope";
import {
  AUDIT_UNAVAILABLE_RESULT,
  COMPLETED_RESULT_WITHHELD,
  type ToolDef,
  type ToolResult,
  invokeTool,
  toAuditableToolResult,
} from "../src/mcp/tools/registry";

class RecordingSink implements AuditSink {
  events: Array<{
    phase: "attempt" | "result";
    tool: string;
    ids?: string[];
    count?: number;
    error?: string;
    delivery?: "transport" | "direct";
    requestedNameHash?: string;
  }> = [];
  fail: "attempt" | "result" | null = null;
  failDisposition = false;
  attemptGate?: Promise<void>;
  resultDurableGate?: Promise<void>;
  resultSubmitted?: (actor: string, tool: string, record: ResultAuditRecord) => void;
  dispositionStarted?: (disposition: AuditDisposition) => void;
  dispositionGate?: Promise<void>;
  dispositionAttempts = 0;
  dispositions: Array<{ resultEventId: string; disposition: AuditDisposition }> = [];
  private nextEventId = 1;

  async attempt(
    _actor: string,
    tool: string,
    params: unknown,
    _nameHash?: string,
  ): Promise<string> {
    await this.attemptGate;
    if (this.fail === "attempt") throw new Error("injected attempt failure");
    const hash = paramsHash(params);
    this.events.push({ phase: "attempt", tool });
    return hash;
  }

  private recordResult(
    tool: string,
    ids: string[],
    returnedCount: number,
    error?: string,
    delivery?: "transport" | "direct",
    requestedNameHash?: string,
  ): void {
    if (this.fail === "result") throw new Error("injected result failure");
    this.events.push({
      phase: "result",
      tool,
      ids: ids.slice(0, 100),
      count: returnedCount,
      error,
      delivery,
      requestedNameHash,
    });
  }

  async result(
    actor: string,
    tool: string,
    _hash: string,
    record: ResultAuditRecord,
    requestedNameHash?: string,
  ): Promise<DurableResultAudit> {
    this.resultSubmitted?.(actor, tool, record);
    await this.resultDurableGate;
    this.recordResult(
      tool,
      record.returnedIds,
      record.returnedCount,
      record.error,
      record.delivery,
      requestedNameHash,
    );
    return { eventId: String(this.nextEventId++) };
  }

  async disposition(
    _actor: string,
    _tool: string,
    resultEventId: string,
    disposition: AuditDisposition,
  ): Promise<void> {
    this.dispositionAttempts += 1;
    this.dispositionStarted?.(disposition);
    await this.dispositionGate;
    if (this.failDisposition) throw new Error("raw disposition secret");
    this.dispositions.push({ resultEventId, disposition });
  }
}

function toolWithSources(handler: ToolDef["handler"]): ToolDef {
  return {
    name: "fictional_sources",
    description: "fictional",
    schema: {},
    handler,
  };
}

function meta(overrides: Partial<AuditedCallMeta> = {}): AuditedCallMeta {
  return {
    requestId: "req-1",
    actor: "agent:test",
    tool: "fictional_sources",
    paramsForAudit: {},
    refusalClass: "known",
    ...overrides,
  };
}

function callbackResult(overrides: Partial<CallbackResult> = {}): CallbackResult {
  return {
    ok: true,
    callToolResult: { content: [{ type: "text", text: "ok" }] } satisfies CallToolResult,
    returnedIds: [],
    returnedCount: 0,
    ...overrides,
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function claimCaptured(
  coordinator: AuditCoordinator,
  requestId: RequestId,
  correlation: OutboundCorrelation,
): Promise<OutboundClaim> {
  return correlation.kind !== "untracked" && correlation.result === "no_result"
    ? coordinator.claimNoResultOutbound(requestId, correlation)
    : coordinator.claimOutbound(requestId, correlation);
}

async function completeCaptured(
  coordinator: AuditCoordinator,
  requestId: RequestId,
  correlation: OutboundCorrelation,
  claim: OutboundClaim,
): Promise<void> {
  if (claim.action === "untracked" || (claim.action === "drop" && claim.completion === "none")) {
    return;
  }
  if (correlation.kind !== "untracked" && correlation.result === "no_result") {
    await coordinator.completeNoResultOutbound(requestId, claim.generation);
  } else if (claim.action === "send") {
    await coordinator.completeOutbound(requestId, claim.generation, { status: "released" });
  } else {
    await coordinator.completeOutbound(requestId, claim.generation, {
      status: "suppressed",
      ...(claim.outcome ? { outcome: claim.outcome } : {}),
    });
  }
}

async function settleCurrent(
  coordinator: AuditCoordinator,
  requestId: RequestId,
): Promise<OutboundClaim> {
  const outbound = await coordinator.handleOutbound({
    jsonrpc: "2.0",
    id: requestId,
    result: { content: [] },
  });
  const claim = await claimCaptured(coordinator, requestId, outbound.correlation);
  await completeCaptured(coordinator, requestId, outbound.correlation, claim);
  return claim;
}

describe("H4 direct two-phase audit", () => {
  test("records uncapped returned count and caps returned IDs", async () => {
    const sink = new RecordingSink();
    const ids = Array.from({ length: 137 }, (_, i) => `source-${i}`);
    const tool = toolWithSources(async () =>
      envelope(
        { ok: true },
        ids.map((id) => ({ type: "note", id })),
      ),
    );

    const result = await invokeTool(tool, { q: "x" }, { actor: "agent:test" }, sink);

    expect(result.ok).toBe(true);
    expect(sink.events.map((e) => e.phase)).toEqual(["attempt", "result"]);
    const event = sink.events[1]!;
    expect(event.ids).toEqual(ids.slice(0, 100));
    expect(event.count).toBe(137);
    expect(event.delivery).toBe("direct");
    expect(sink.dispositionAttempts).toBe(0);
  });

  test("attempt failure prevents handler execution and returns fixed retryable error", async () => {
    const sink = new RecordingSink();
    sink.fail = "attempt";
    let executed = false;
    const tool = toolWithSources(async () => {
      executed = true;
      return envelope({}, []);
    });

    const result = await invokeTool(tool, {}, { actor: "agent:test" }, sink);

    expect(executed).toBe(false);
    expect(result).toEqual({
      ok: false,
      error: { code: "INTERNAL", message: "Tool unavailable before execution.", retry: true },
    });
    expect(sink.events).toHaveLength(0);
  });

  test("result audit failure with success withholds content", async () => {
    const sink = new RecordingSink();
    sink.fail = "result";
    const tool = toolWithSources(async () =>
      envelope({ secret: "source" }, [{ type: "note", id: "id-1" }]),
    );

    const result = await invokeTool(tool, {}, { actor: "agent:test" }, sink);

    expect(result).toEqual({
      ok: true,
      envelope: {
        data: { status: "completed_result_withheld", retry: false },
        sources: [],
        gaps: ["completion audit unavailable; result withheld"],
      },
    });
  });

  test("result audit failure with handler error returns fixed audit error", async () => {
    const sink = new RecordingSink();
    sink.fail = "result";
    const tool = toolWithSources(async () => {
      throw new Error("raw handler secret");
    });

    const result = await invokeTool(tool, {}, { actor: "agent:test" }, sink);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "AUDIT_UNAVAILABLE",
        message: "Tool result withheld because completion audit is unavailable.",
        retry: false,
      },
    });
  });

  test("bad timezone still records attempt before BAD_INPUT result", async () => {
    const sink = new RecordingSink();
    let executed = false;
    const tool = toolWithSources(async () => {
      executed = true;
      return envelope({}, []);
    });

    const result = await invokeTool(
      tool,
      { time_zone: "Not/AZone" },
      { actor: "agent:test" },
      sink,
    );

    expect(executed).toBe(false);
    expect(result.ok).toBe(false);
    expect((result as Extract<ToolResult, { ok: false }>).error.code).toBe("BAD_INPUT");
    expect(sink.events.map((e) => e.phase)).toEqual(["attempt", "result"]);
  });
});

describe("H4 coordinator transitions", () => {
  test("attempt_pending + cancel audits zero IDs and never invokes execution", async () => {
    const sink = new RecordingSink();
    const coordinator = new AuditCoordinator(sink);
    const received = coordinator.receiveCall(meta());
    const cancelled = await coordinator.cancel("req-1");
    expect(cancelled).toEqual({ forwardNotification: false, closeTransport: false });
    expect(await received).toEqual({ action: "drop", closeTransport: false });
    expect(sink.events.map((e) => e.phase)).toEqual(["attempt", "result"]);
    expect(sink.events[1]).toMatchObject({ ids: [], count: 0 });
    expect(sink.dispositions.at(-1)).toMatchObject({
      disposition: { status: "suppressed", outcome: "cancelled_before_execution" },
    });
    let invoked = false;
    const result = await coordinator.handleCallback("req-1", async () => {
      invoked = true;
      return callbackResult();
    });
    expect(invoked).toBe(false);
    expect(result.content).toEqual([]);
    await coordinator.drain();
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("attempt_pending + close records the disconnect outcome", async () => {
    const sink = new RecordingSink();
    const coordinator = new AuditCoordinator(sink);
    const received = coordinator.receiveCall(meta({ requestId: "closed" }));
    const closed = coordinator.transportClosed();
    await Promise.all([received, closed]);
    expect(sink.events[1]).toMatchObject({ ids: [], count: 0 });
    expect(sink.dispositions.at(-1)).toMatchObject({
      disposition: { status: "suppressed", outcome: "transport_closed_before_execution" },
    });
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("close at callback-start barrier skips the handler", async () => {
    const sink = new RecordingSink();
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = new AuditCoordinator(sink, {
      beforeCallbackStart: async () => {
        entered();
        await barrier;
      },
    });
    await coordinator.receiveCall(meta({ requestId: "close-at-start" }));
    let invoked = false;
    const callback = coordinator.handleCallback("close-at-start", async () => {
      invoked = true;
      return callbackResult({ returnedIds: ["must-not-release"], returnedCount: 1 });
    });
    await enteredPromise;
    const closed = coordinator.transportClosed();
    release();
    await closed;
    const suppressed = await callback;
    expect(suppressed).toEqual({ isError: true, content: [] });
    expect(invoked).toBe(false);
    expect(sink.events.at(-1)).toMatchObject({ ids: [], count: 0 });
    expect(sink.dispositions.at(-1)).toMatchObject({
      disposition: { status: "suppressed", outcome: "transport_closed_before_execution" },
    });
    expect(coordinator.pendingCount()).toBe(1);
    const outbound = await coordinator.handleOutbound({
      jsonrpc: "2.0",
      id: "close-at-start",
      result: suppressed,
    });
    expect(outbound.action).toBe("send");
    expect(outbound.message).toEqual({ jsonrpc: "2.0", id: "close-at-start", result: suppressed });
    expect(outbound.correlation?.kind).toBe("pending");
    if (outbound.correlation?.kind !== "pending")
      throw new Error("expected pending outbound correlation");
    expect(typeof outbound.correlation.generation).toBe("symbol");
    expect(outbound.correlation.result).toBe("durable");
    const claim = await claimCaptured(coordinator, "close-at-start", outbound.correlation);
    expect(claim.action).toBe("drop");
    await completeCaptured(coordinator, "close-at-start", outbound.correlation, claim);
    await Promise.resolve();
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("cancel at callback-start barrier retains suppression through outbound completion", async () => {
    const sink = new RecordingSink();
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = new AuditCoordinator(sink, {
      beforeCallbackStart: async () => {
        entered();
        await barrier;
      },
    });
    await coordinator.receiveCall(meta({ requestId: "cancel-at-start" }));
    let invoked = false;
    const callback = coordinator.handleCallback("cancel-at-start", async () => {
      invoked = true;
      return callbackResult({ returnedIds: ["must-not-release"], returnedCount: 1 });
    });
    await enteredPromise;
    const cancelled = coordinator.cancel("cancel-at-start");
    release();
    await cancelled;
    const suppressed = await callback;
    expect(invoked).toBe(false);
    expect(sink.events.at(-1)).toMatchObject({ ids: [], count: 0 });
    expect(sink.dispositions.at(-1)).toMatchObject({
      disposition: { status: "suppressed", outcome: "cancelled_before_execution" },
    });
    expect(suppressed).toEqual({ isError: true, content: [] });
    expect(coordinator.pendingCount()).toBe(1);
    const outbound = await coordinator.handleOutbound({
      jsonrpc: "2.0",
      id: "cancel-at-start",
      result: suppressed,
    });
    expect(outbound.action).toBe("send");
    expect(outbound.message).toEqual({ jsonrpc: "2.0", id: "cancel-at-start", result: suppressed });
    expect(outbound.correlation?.kind).toBe("pending");
    if (outbound.correlation?.kind !== "pending")
      throw new Error("expected pending outbound correlation");
    expect(typeof outbound.correlation.generation).toBe("symbol");
    expect(outbound.correlation.result).toBe("durable");
    const claim = await claimCaptured(coordinator, "cancel-at-start", outbound.correlation);
    expect(claim.action).toBe("drop");
    await completeCaptured(coordinator, "cancel-at-start", outbound.correlation, claim);
    await Promise.resolve();
    expect(coordinator.pendingCount()).toBe(0);
  });

  const forwardedLifecycleCases = [
    {
      key: "forwarded:cancel",
      id: "forwarded-cancel",
      outcome: "cancelled_before_execution",
      action: "cancel",
    },
    {
      key: "forwarded:close",
      id: "forwarded-close",
      outcome: "transport_closed_before_execution",
      action: "close",
    },
  ] as const;

  test("forwarded lifecycle cases are exactly cancel and close", () => {
    expect(forwardedLifecycleCases.map((scenario) => scenario.key)).toEqual([
      "forwarded:cancel",
      "forwarded:close",
    ]);
  });

  for (const scenario of forwardedLifecycleCases) {
    test(scenario.key, async () => {
      const sink = new RecordingSink();
      const coordinator = new AuditCoordinator(sink);
      expect(await coordinator.receiveCall(meta({ requestId: scenario.id }))).toEqual({
        action: "forward",
      });
      if (scenario.action === "cancel") await coordinator.cancel(scenario.id);
      else await coordinator.transportClosed();
      expect(sink.events.filter((event) => event.phase === "result")).toHaveLength(1);
      expect(sink.events.at(-1)).toMatchObject({ ids: [], count: 0 });
      expect(sink.dispositions.at(-1)).toMatchObject({
        disposition: { status: "suppressed", outcome: scenario.outcome },
      });
      expect(coordinator.pendingCount()).toBe(1);
      let invoked = false;
      const suppressed = await coordinator.handleCallback(scenario.id, async () => {
        invoked = true;
        return callbackResult({ returnedIds: ["must-not-release"], returnedCount: 1 });
      });
      expect(invoked).toBe(false);
      expect(suppressed).toEqual({ isError: true, content: [] });
      const outbound = await coordinator.handleOutbound({
        jsonrpc: "2.0",
        id: scenario.id,
        result: suppressed,
      });
      expect(outbound.action).toBe("send");
      expect(outbound.message).toEqual({ jsonrpc: "2.0", id: scenario.id, result: suppressed });
      expect(outbound.correlation?.kind).toBe("pending");
      if (outbound.correlation?.kind !== "pending")
        throw new Error("expected pending outbound correlation");
      expect(typeof outbound.correlation.generation).toBe("symbol");
      expect(outbound.correlation.result).toBe("durable");
      const claim = await claimCaptured(coordinator, scenario.id, outbound.correlation);
      expect(claim.action).toBe("drop");
      await completeCaptured(coordinator, scenario.id, outbound.correlation, claim);
      await Promise.resolve();
      expect(coordinator.pendingCount()).toBe(0);
    });
  }

  test("successful callback audit withholding survives outbound ownership", async () => {
    const sink = new RecordingSink();
    sink.fail = "result";
    const coordinator = new AuditCoordinator(sink);
    await coordinator.receiveCall(meta({ requestId: "withheld" }));
    const callback = await coordinator.handleCallback("withheld", async () => callbackResult());
    expect(callback).toEqual(COMPLETED_RESULT_WITHHELD);
    const outbound = await coordinator.handleOutbound({
      jsonrpc: "2.0",
      id: "withheld",
      result: callback,
    });
    expect(outbound.action).toBe("send");
    expect(outbound.message).toEqual({
      jsonrpc: "2.0",
      id: "withheld",
      result: COMPLETED_RESULT_WITHHELD,
    });
    expect(outbound.correlation?.kind).toBe("pending");
    if (outbound.correlation?.kind !== "pending")
      throw new Error("expected pending outbound correlation");
    expect(typeof outbound.correlation.generation).toBe("symbol");
    expect(outbound.correlation.result).toBe("no_result");
    const claim = await claimCaptured(coordinator, "withheld", outbound.correlation);
    expect(claim.action).toBe("send");
    await completeCaptured(coordinator, "withheld", outbound.correlation, claim);
  });

  test("handler-error audit failure remains a sendable fixed replacement", async () => {
    const sink = new RecordingSink();
    sink.fail = "result";
    const coordinator = new AuditCoordinator(sink);
    await coordinator.receiveCall(meta({ requestId: "handler-error-audit" }));
    const callback = await coordinator.handleCallback("handler-error-audit", async () =>
      callbackResult({
        ok: false,
        callToolResult: { isError: true, content: [{ type: "text", text: "handler error" }] },
        error: "INTERNAL",
      }),
    );
    expect(callback).toEqual(AUDIT_UNAVAILABLE_RESULT);
    expect((await settleCurrent(coordinator, "handler-error-audit")).action).toBe("send");
  });

  test("fallback refusal audit failure is replaced without SDK text and remains sendable", async () => {
    const sink = new RecordingSink();
    sink.fail = "result";
    const coordinator = new AuditCoordinator(sink);
    await coordinator.receiveCall(meta({ requestId: "fallback-audit", refusalClass: "unknown" }));
    const outbound = await coordinator.handleOutbound({
      jsonrpc: "2.0",
      id: "fallback-audit",
      error: { code: -32601, message: "raw SDK refusal" },
    });
    expect(outbound.action).toBe("send");
    expect(outbound.message).toEqual({
      jsonrpc: "2.0",
      id: "fallback-audit",
      result: AUDIT_UNAVAILABLE_RESULT,
    });
    expect(outbound.correlation?.kind).toBe("pending");
    if (outbound.correlation?.kind !== "pending")
      throw new Error("expected pending outbound correlation");
    expect(typeof outbound.correlation.generation).toBe("symbol");
    expect(outbound.correlation.result).toBe("no_result");
    expect(JSON.stringify(outbound)).not.toContain("raw SDK refusal");
    const claim = await claimCaptured(coordinator, "fallback-audit", outbound.correlation);
    expect(claim.action).toBe("send");
    await completeCaptured(coordinator, "fallback-audit", outbound.correlation, claim);
  });

  test("task refusal audit failure does not call handler and remains sendable as fixed replacement", async () => {
    const sink = new RecordingSink();
    sink.fail = "result";
    const coordinator = new AuditCoordinator(sink);
    await coordinator.receiveCall(meta({ requestId: "task-audit", refusalClass: "task" }));
    let invoked = false;
    const callback = await coordinator.handleCallback("task-audit", async () => {
      invoked = true;
      return callbackResult();
    });
    expect(invoked).toBe(false);
    expect(callback.content).toEqual([]);
    const outbound = await coordinator.handleOutbound({
      jsonrpc: "2.0",
      id: "task-audit",
      error: { code: -32601, message: "raw task refusal" },
    });
    expect(outbound.action).toBe("send");
    expect(outbound.message).toEqual({
      jsonrpc: "2.0",
      id: "task-audit",
      result: AUDIT_UNAVAILABLE_RESULT,
    });
    expect(outbound.correlation?.kind).toBe("pending");
    if (outbound.correlation?.kind !== "pending")
      throw new Error("expected pending outbound correlation");
    expect(typeof outbound.correlation.generation).toBe("symbol");
    expect(outbound.correlation.result).toBe("no_result");
    const claim = await claimCaptured(coordinator, "task-audit", outbound.correlation);
    expect(claim.action).toBe("send");
    await completeCaptured(coordinator, "task-audit", outbound.correlation, claim);
  });

  test("normal callback audits uncapped IDs while retaining only first 100", async () => {
    const sink = new RecordingSink();
    const coordinator = new AuditCoordinator(sink);
    await coordinator.receiveCall(meta({ requestId: "normal" }));
    const ids = Array.from({ length: 137 }, (_, i) => `id-${i}`);
    const callback = await coordinator.handleCallback("normal", async () =>
      callbackResult({ returnedIds: ids, returnedCount: ids.length }),
    );
    expect(callback.content).toEqual([{ type: "text", text: "ok" }]);
    expect(sink.events.at(-1)).toMatchObject({ ids: ids.slice(0, 100), count: 137 });
    expect((await settleCurrent(coordinator, "normal")).action).toBe("send");
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("task refusal never invokes handler and is audited once", async () => {
    const sink = new RecordingSink();
    const coordinator = new AuditCoordinator(sink);
    await coordinator.receiveCall(meta({ requestId: "task", refusalClass: "task" }));
    let invoked = false;
    const result = await coordinator.handleCallback("task", async () => {
      invoked = true;
      return callbackResult({ returnedIds: ["must-not-release"], returnedCount: 1 });
    });
    expect(invoked).toBe(false);
    expect(result.content).toEqual([]);
    expect(sink.events.filter((event) => event.phase === "result")).toHaveLength(1);
    expect(sink.events.at(-1)).toMatchObject({ error: "SDK_REFUSAL", ids: [], count: 0 });
    await settleCurrent(coordinator, "task");
  });

  test("SDK refusal result audit failure replaces the entire outbound result", async () => {
    const sink = new RecordingSink();
    const coordinator = new AuditCoordinator(sink);
    await coordinator.receiveCall(meta({ requestId: "refused", refusalClass: "unknown" }));
    sink.fail = "result";
    const outbound = await coordinator.handleOutbound({
      jsonrpc: "2.0",
      id: "refused",
      error: { code: -32601, message: "raw SDK text" },
    });
    expect(outbound.action).toBe("send");
    if (outbound.action === "send") {
      expect(JSON.stringify(outbound.message)).not.toContain("raw SDK text");
      expect(JSON.stringify(outbound.message)).toContain("AUDIT_UNAVAILABLE");
    }
    const claim = await claimCaptured(coordinator, "refused", outbound.correlation);
    await completeCaptured(coordinator, "refused", outbound.correlation, claim);
  });

  test("independent IDs do not block each other's attempt/result phases", async () => {
    const sink = new RecordingSink();
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let pauseSlow = true;
    const originalAttempt = sink.attempt.bind(sink);
    sink.attempt = async (...args) => {
      const result = originalAttempt(...args);
      if (pauseSlow && args[1] === "slow") {
        pauseSlow = false;
        await slowGate;
      }
      return result;
    };
    const coordinator = new AuditCoordinator(sink);
    const slow = coordinator.receiveCall(meta({ requestId: "slow", tool: "slow" }));
    const fast = coordinator.receiveCall(meta({ requestId: "fast", tool: "fast" }));
    expect((await fast).action).toBe("forward");
    await coordinator.handleCallback("fast", async () =>
      callbackResult({ returnedIds: ["fast-id"], returnedCount: 1 }),
    );
    releaseSlow();
    expect((await slow).action).toBe("forward");
    await coordinator.handleCallback("slow", async () =>
      callbackResult({ returnedIds: ["slow-id"], returnedCount: 1 }),
    );
    const phases = sink.events.map((event) => `${event.tool}:${event.phase}`);
    expect(phases.indexOf("fast:result")).toBeGreaterThan(phases.indexOf("fast:attempt"));
    expect(phases.indexOf("slow:result")).toBeGreaterThan(phases.indexOf("slow:attempt"));
    await settleCurrent(coordinator, "fast");
    await coordinator.cancel("slow");
    await settleCurrent(coordinator, "slow");
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("running cancellation suppresses IDs and keeps one terminal audit", async () => {
    const sink = new RecordingSink();
    let releaseResult!: () => void;
    sink.resultDurableGate = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    let resultAuditStarted!: () => void;
    const resultAuditStartedPromise = new Promise<void>((resolve) => {
      resultAuditStarted = resolve;
    });
    sink.resultSubmitted = resultAuditStarted;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let callbackStarted!: () => void;
    const callbackStartedPromise = new Promise<void>((resolve) => {
      callbackStarted = resolve;
    });
    const coordinator = new AuditCoordinator(sink);
    await coordinator.receiveCall(meta({ requestId: 0 }));
    const callback = coordinator.handleCallback(0, async () => {
      callbackStarted();
      await barrier;
      return callbackResult({ returnedIds: ["secret-id"], returnedCount: 1 });
    });
    await callbackStartedPromise;
    release();
    await resultAuditStartedPromise;
    const cancel = coordinator.cancel(0);
    releaseResult();
    await cancel;
    const suppressed = await callback;
    expect(suppressed).toEqual({ isError: true, content: [] });
    expect(sink.events.filter((e) => e.phase === "result")).toHaveLength(1);
    expect(sink.events[1]).toMatchObject({ ids: ["secret-id"], count: 1 });
    expect(sink.dispositions.at(-1)).toMatchObject({
      disposition: { status: "suppressed", outcome: "completed_not_released" },
    });
    expect(coordinator.pendingCount()).toBe(1);
    const outbound = await coordinator.handleOutbound({
      jsonrpc: "2.0",
      id: 0,
      result: suppressed,
    });
    expect(outbound.action).toBe("send");
    expect(outbound.message).toEqual({ jsonrpc: "2.0", id: 0, result: suppressed });
    expect(outbound.correlation?.kind).toBe("pending");
    if (outbound.correlation?.kind !== "pending")
      throw new Error("expected pending outbound correlation");
    expect(typeof outbound.correlation.generation).toBe("symbol");
    expect(outbound.correlation.result).toBe("durable");
    const claim = await claimCaptured(coordinator, 0, outbound.correlation);
    expect(claim.action).toBe("drop");
    const completion = completeCaptured(coordinator, 0, outbound.correlation, claim);
    await Promise.resolve();
    expect(coordinator.pendingCount()).toBe(1);
    const duplicate = await coordinator.receiveCall(meta({ requestId: 0 }));
    expect(duplicate).toEqual({ action: "drop", closeTransport: true });
    await completion;
    await Promise.resolve();
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("pre-submission cancellation authorizes zero IDs even after the handler returns IDs", async () => {
    const sink = new RecordingSink();
    const afterHandlerEntered = deferred<void>();
    const afterHandlerGate = deferred<void>();
    const submitted = deferred<ResultAuditRecord>();
    sink.resultSubmitted = (_actor, _tool, record) => submitted.resolve(record);
    const coordinator = new AuditCoordinator(sink, {
      afterHandlerResult: async () => {
        afterHandlerEntered.resolve();
        await afterHandlerGate.promise;
      },
    });
    await coordinator.receiveCall(meta({ requestId: "pre-submit-cancel" }));
    const callback = coordinator.handleCallback("pre-submit-cancel", async () =>
      callbackResult({ returnedIds: ["must-zero"], returnedCount: 1 }),
    );
    await afterHandlerEntered.promise;
    const cancelled = coordinator.cancel("pre-submit-cancel");
    afterHandlerGate.resolve();
    expect(await submitted.promise).toMatchObject({ returnedIds: [], returnedCount: 0 });
    await cancelled;
    expect(await callback).toEqual({ isError: true, content: [] });
    expect(sink.dispositions[0]?.disposition).toEqual({
      status: "suppressed",
      outcome: "completed_not_released",
    });
    await coordinator.drain();
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("pre-submission close authorizes zero IDs even after the handler returns IDs", async () => {
    const sink = new RecordingSink();
    const afterHandlerEntered = deferred<void>();
    const afterHandlerGate = deferred<void>();
    const submitted = deferred<ResultAuditRecord>();
    sink.resultSubmitted = (_actor, _tool, record) => submitted.resolve(record);
    const coordinator = new AuditCoordinator(sink, {
      afterHandlerResult: async () => {
        afterHandlerEntered.resolve();
        await afterHandlerGate.promise;
      },
    });
    await coordinator.receiveCall(meta({ requestId: "pre-submit-close" }));
    const callback = coordinator.handleCallback("pre-submit-close", async () =>
      callbackResult({ returnedIds: ["must-zero"], returnedCount: 1 }),
    );
    await afterHandlerEntered.promise;
    const closed = coordinator.transportClosed();
    afterHandlerGate.resolve();
    expect(await submitted.promise).toMatchObject({ returnedIds: [], returnedCount: 0 });
    await closed;
    expect(await callback).toEqual({ isError: true, content: [] });
    expect(sink.dispositions[0]?.disposition).toEqual({
      status: "suppressed",
      outcome: "completed_after_disconnect",
    });
    await coordinator.drain();
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("running transport close suppresses IDs with disconnect outcome", async () => {
    const sink = new RecordingSink();
    let releaseResult!: () => void;
    sink.resultDurableGate = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    let resultAuditStarted!: () => void;
    const resultAuditStartedPromise = new Promise<void>((resolve) => {
      resultAuditStarted = resolve;
    });
    sink.resultSubmitted = resultAuditStarted;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let callbackStarted!: () => void;
    const callbackStartedPromise = new Promise<void>((resolve) => {
      callbackStarted = resolve;
    });
    const coordinator = new AuditCoordinator(sink);
    await coordinator.receiveCall(meta({ requestId: "running-close" }));
    const callback = coordinator.handleCallback("running-close", async () => {
      callbackStarted();
      await barrier;
      return callbackResult({ returnedIds: ["secret-id"], returnedCount: 1 });
    });
    await callbackStartedPromise;
    release();
    await resultAuditStartedPromise;
    const closed = coordinator.transportClosed();
    releaseResult();
    await closed;
    const suppressed = await callback;
    expect(suppressed).toEqual({ isError: true, content: [] });
    expect(sink.events.at(-1)).toMatchObject({ ids: ["secret-id"], count: 1 });
    expect(sink.dispositions.at(-1)).toMatchObject({
      disposition: { status: "suppressed", outcome: "completed_after_disconnect" },
    });
    expect(coordinator.pendingCount()).toBe(1);
    const outbound = await coordinator.handleOutbound({
      jsonrpc: "2.0",
      id: "running-close",
      result: suppressed,
    });
    expect(outbound.action).toBe("send");
    expect(outbound.message).toEqual({ jsonrpc: "2.0", id: "running-close", result: suppressed });
    expect(outbound.correlation?.kind).toBe("pending");
    if (outbound.correlation?.kind !== "pending")
      throw new Error("expected pending outbound correlation");
    expect(typeof outbound.correlation.generation).toBe("symbol");
    expect(outbound.correlation.result).toBe("durable");
    const claim = await claimCaptured(coordinator, "running-close", outbound.correlation);
    expect(claim.action).toBe("drop");
    await completeCaptured(coordinator, "running-close", outbound.correlation, claim);
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("first terminal signal wins while the result audit gate is held", async () => {
    const sink = new RecordingSink();
    let releaseResult!: () => void;
    sink.resultDurableGate = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    let resultAuditStarted!: () => void;
    const resultAuditStartedPromise = new Promise<void>((resolve) => {
      resultAuditStarted = resolve;
    });
    sink.resultSubmitted = resultAuditStarted;
    const coordinator = new AuditCoordinator(sink);
    await coordinator.receiveCall(meta({ requestId: "winner" }));
    const callback = coordinator.handleCallback("winner", async () =>
      callbackResult({ returnedIds: ["secret-id"], returnedCount: 1 }),
    );
    await resultAuditStartedPromise;

    const cancelled = coordinator.cancel("winner");
    const closed = coordinator.transportClosed();
    releaseResult();
    await Promise.all([cancelled, closed]);
    expect(await callback).toEqual({ isError: true, content: [] });
    expect(sink.events.at(-1)).toMatchObject({ ids: ["secret-id"], count: 1 });
    expect(sink.dispositions.at(-1)).toMatchObject({
      disposition: { status: "suppressed", outcome: "completed_not_released" },
    });
    const outbound = await coordinator.handleOutbound({
      jsonrpc: "2.0",
      id: "winner",
      result: { isError: true, content: [] },
    });
    const claim = await claimCaptured(coordinator, "winner", outbound.correlation);
    expect(claim.action).toBe("drop");
    await completeCaptured(coordinator, "winner", outbound.correlation, claim);
    await Promise.resolve();
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("close wins over cancel while a durable result is pending", async () => {
    const sink = new RecordingSink();
    const resultSubmitted = deferred<void>();
    const resultDurableGateRelease = deferred<void>();
    sink.resultSubmitted = () => resultSubmitted.resolve();
    sink.resultDurableGate = resultDurableGateRelease.promise;
    const coordinator = new AuditCoordinator(sink);
    await coordinator.receiveCall(meta({ requestId: "close-wins" }));
    const callback = coordinator.handleCallback("close-wins", async () =>
      callbackResult({ returnedIds: ["secret-id"], returnedCount: 1 }),
    );
    await resultSubmitted.promise;
    const closed = coordinator.transportClosed();
    const cancelled = coordinator.cancel("close-wins");
    resultDurableGateRelease.resolve();
    await Promise.all([closed, cancelled]);
    expect(await callback).toEqual({ isError: true, content: [] });
    expect(sink.dispositionAttempts).toBe(1);
    expect(sink.dispositions[0]?.disposition).toEqual({
      status: "suppressed",
      outcome: "completed_after_disconnect",
    });
    const outbound = await coordinator.handleOutbound({
      jsonrpc: "2.0",
      id: "close-wins",
      result: { isError: true, content: [] },
    });
    const claim = await claimCaptured(coordinator, "close-wins", outbound.correlation);
    expect(claim.action).toBe("drop");
    await completeCaptured(coordinator, "close-wins", outbound.correlation, claim);
    await Promise.resolve();
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("post-submission cancel suppresses a durable result before its first claim", async () => {
    const sink = new RecordingSink();
    const coordinator = new AuditCoordinator(sink);
    await coordinator.receiveCall(meta({ requestId: "post-cancel" }));
    const callback = await coordinator.handleCallback("post-cancel", async () =>
      callbackResult({ returnedIds: ["secret-id"], returnedCount: 1 }),
    );
    expect(callback.content).toEqual([{ type: "text", text: "ok" }]);
    expect(sink.dispositionAttempts).toBe(0);
    await coordinator.cancel("post-cancel");
    expect(sink.dispositionAttempts).toBe(1);
    expect(sink.dispositions[0]?.disposition).toEqual({
      status: "suppressed",
      outcome: "completed_not_released",
    });
    const outbound = await coordinator.handleOutbound({
      jsonrpc: "2.0",
      id: "post-cancel",
      result: callback,
    });
    const claim = await claimCaptured(coordinator, "post-cancel", outbound.correlation);
    expect(claim.action).toBe("drop");
    await completeCaptured(coordinator, "post-cancel", outbound.correlation, claim);
    await Promise.resolve();
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("post-submission close suppresses a durable result before its first claim", async () => {
    const sink = new RecordingSink();
    const coordinator = new AuditCoordinator(sink);
    await coordinator.receiveCall(meta({ requestId: "post-close" }));
    const callback = await coordinator.handleCallback("post-close", async () =>
      callbackResult({ returnedIds: ["secret-id"], returnedCount: 1 }),
    );
    expect(callback.content).toEqual([{ type: "text", text: "ok" }]);
    await coordinator.transportClosed();
    expect(sink.dispositionAttempts).toBe(1);
    expect(sink.dispositions[0]?.disposition).toEqual({
      status: "suppressed",
      outcome: "completed_after_disconnect",
    });
    const outbound = await coordinator.handleOutbound({
      jsonrpc: "2.0",
      id: "post-close",
      result: callback,
    });
    const claim = await claimCaptured(coordinator, "post-close", outbound.correlation);
    expect(claim.action).toBe("drop");
    await completeCaptured(coordinator, "post-close", outbound.correlation, claim);
    await Promise.resolve();
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("duplicate request ID gets an independent audit and no second execution", async () => {
    const sink = new RecordingSink();
    const coordinator = new AuditCoordinator(sink);
    await coordinator.receiveCall(meta({ requestId: "same" }));
    const duplicate = await coordinator.receiveCall(meta({ requestId: "same" }));
    expect(duplicate).toEqual({ action: "drop", closeTransport: true });
    expect(sink.events.filter((e) => e.phase === "attempt")).toHaveLength(2);
    expect(sink.events.filter((e) => e.phase === "result")).toHaveLength(1);
    expect(sink.events.at(-1)).toMatchObject({ error: "DUPLICATE_REQUEST_ID" });
    expect(sink.dispositionAttempts).toBe(1);
    expect(sink.dispositions[0]?.disposition).toEqual({ status: "suppressed" });
  });

  test("duplicate attempt failure skips the duplicate result audit and closes", async () => {
    const sink = new RecordingSink();
    const coordinator = new AuditCoordinator(sink);
    await coordinator.receiveCall(meta({ requestId: "duplicate-attempt" }));
    sink.fail = "attempt";
    const duplicate = await coordinator.receiveCall(meta({ requestId: "duplicate-attempt" }));
    expect(duplicate).toEqual({ action: "drop", closeTransport: true });
    expect(sink.events.filter((event) => event.phase === "result")).toHaveLength(0);
    expect(sink.dispositionAttempts).toBe(0);
  });

  test("duplicate result failure still closes without a duplicate response", async () => {
    const sink = new RecordingSink();
    const coordinator = new AuditCoordinator(sink);
    await coordinator.receiveCall(meta({ requestId: "duplicate-result" }));
    sink.fail = "result";
    const duplicate = await coordinator.receiveCall(meta({ requestId: "duplicate-result" }));
    expect(duplicate).toEqual({ action: "drop", closeTransport: true });
    expect(sink.events.filter((event) => event.phase === "attempt")).toHaveLength(2);
    expect(sink.events.filter((event) => event.phase === "result")).toHaveLength(0);
    expect(sink.dispositionAttempts).toBe(0);
  });

  test("duplicate disposition failure is attempted once and remains fail-closed", async () => {
    const sink = new RecordingSink();
    sink.failDisposition = true;
    const coordinator = new AuditCoordinator(sink);
    await coordinator.receiveCall(meta({ requestId: "duplicate-disposition" }));
    const duplicate = await coordinator.receiveCall(meta({ requestId: "duplicate-disposition" }));
    expect(duplicate).toEqual({ action: "drop", closeTransport: true });
    expect(sink.dispositionAttempts).toBe(1);
    expect(sink.dispositions).toHaveLength(0);
    expect(coordinator.pendingCount()).toBe(1);
    await expect(coordinator.cancel("duplicate-disposition")).rejects.toThrow(
      "raw disposition secret",
    );
    await coordinator.drain();
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("numeric zero and string zero are independent request IDs", async () => {
    const sink = new RecordingSink();
    const coordinator = new AuditCoordinator(sink);
    const numeric = coordinator.receiveCall(meta({ requestId: 0, tool: "numeric" }));
    const string = coordinator.receiveCall(meta({ requestId: "0", tool: "string" }));
    expect(await numeric).toEqual({ action: "forward" });
    expect(await string).toEqual({ action: "forward" });
    await coordinator.handleCallback(0, async () =>
      callbackResult({ returnedIds: ["numeric-id"], returnedCount: 1 }),
    );
    await coordinator.handleCallback("0", async () =>
      callbackResult({ returnedIds: ["string-id"], returnedCount: 1 }),
    );
    expect(sink.events.filter((event) => event.phase === "attempt")).toHaveLength(2);
    expect(sink.events.filter((event) => event.phase === "result")).toHaveLength(2);
    await settleCurrent(coordinator, 0);
    await settleCurrent(coordinator, "0");
  });

  test("handler/conversion rejection becomes fixed INTERNAL result and cleans pending", async () => {
    const sink = new RecordingSink();
    const coordinator = new AuditCoordinator(sink);
    await coordinator.receiveCall(meta({ requestId: "reject" }));
    const result = await coordinator.handleCallback("reject", async () => {
      throw new Error("raw conversion failure");
    });
    expect(result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('"code":"INTERNAL"') }],
    });
    expect(sink.events.at(-1)).toMatchObject({ error: "INTERNAL", ids: [], count: 0 });
    await settleCurrent(coordinator, "reject");
    await coordinator.drain();
    expect(coordinator.pendingCount()).toBe(0);
  });
});

describe("H4 normal success wire shape", () => {
  test("omits optional isError false on normal tool results", () => {
    const converted = toAuditableToolResult({ ok: true, envelope: envelope({ ok: true }, []) });
    expect(converted.callToolResult).toEqual({
      content: [{ type: "text", text: '{\n  "data": {\n    "ok": true\n  },\n  "sources": []\n}' }],
    });
  });
});

describe("H4 tombstone privacy", () => {
  test("uses the explicit delivery state contract", () => {
    const source = readFileSync(
      new URL("../src/mcp/audit-coordinator.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("deliveryState:");
    expect(source).toContain('"no_result"');
    expect(source).toContain('"result_pending"');
    expect(source).toContain('"preclaim"');
    expect(source).toContain('"release_claimed"');
    expect(source).toContain('"disposed"');
    expect(source).toContain("dispositionAttempted: boolean;");
    expect(source).not.toContain("resultAuditLinearized");
    expect(source).not.toContain("releaseClaimed");
    expect(source).not.toContain("dispositionState");
  });

  test("tombstones are opaque ID-only tokens", () => {
    const source = readFileSync(
      new URL("../src/mcp/audit-coordinator.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("private readonly tombstones = new Map<RequestId, symbol>();");
    expect(source).not.toContain("tombstones = new Map<RequestId, PendingCall>");
    expect(source).not.toMatch(/tombstones\.set\([^,]+,\s*entry\)/);
  });
});

describe("H4 final delivery-state corrections", () => {
  test("claimed durable completion rejects suppression until the send owner settles", async () => {
    const terminalStatuses: Array<"released" | "send_uncertain"> = ["released", "send_uncertain"];

    for (const terminalStatus of terminalStatuses) {
      const sink = new RecordingSink();
      const coordinator = new AuditCoordinator(sink);
      const requestId = `claimed-${terminalStatus}`;
      await coordinator.receiveCall(meta({ requestId }));
      const callback = await coordinator.handleCallback(requestId, async () =>
        callbackResult({ returnedIds: ["claimed-id"], returnedCount: 1 }),
      );
      const outbound = await coordinator.handleOutbound({
        jsonrpc: "2.0",
        id: requestId,
        result: callback,
      });
      if (outbound.correlation.kind !== "pending" || outbound.correlation.result !== "durable") {
        throw new Error("expected pending durable correlation");
      }
      const claim = await coordinator.claimOutbound(requestId, outbound.correlation);
      if (claim.action !== "send") throw new Error("expected durable send claim");

      await expect(
        coordinator.completeOutbound(requestId, claim.generation, { status: "suppressed" }),
      ).rejects.toThrow();
      expect(sink.dispositionAttempts).toBe(0);
      expect(sink.dispositions).toHaveLength(0);
      expect(coordinator.pendingCount()).toBe(1);

      let drainSettled = false;
      const draining = coordinator.drain().then(() => {
        drainSettled = true;
      });
      for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
      expect(drainSettled).toBe(false);
      expect(await coordinator.receiveCall(meta({ requestId }))).toEqual({
        action: "drop",
        closeTransport: true,
      });

      await coordinator.completeOutbound(requestId, claim.generation, {
        status: terminalStatus,
      });
      await draining;
      expect(
        sink.dispositions.filter(({ disposition }) => disposition.status === terminalStatus),
      ).toHaveLength(1);
      expect(coordinator.pendingCount()).toBe(0);

      await Promise.resolve();
      expect(await coordinator.receiveCall(meta({ requestId }))).toEqual({ action: "forward" });
      await coordinator.completeOutbound(requestId, claim.generation, { status: terminalStatus });
      expect(coordinator.pendingCount()).toBe(1);
      const reusedCallback = await coordinator.handleCallback(requestId, async () =>
        callbackResult(),
      );
      const reusedOutbound = await coordinator.handleOutbound({
        jsonrpc: "2.0",
        id: requestId,
        result: reusedCallback,
      });
      if (reusedOutbound.correlation.kind !== "pending") {
        throw new Error("expected reused pending correlation");
      }
      const reusedClaim = await coordinator.claimOutbound(requestId, reusedOutbound.correlation);
      if (reusedClaim.action !== "send") throw new Error("expected reused send claim");
      await coordinator.completeOutbound(requestId, reusedClaim.generation, {
        status: "released",
      });
      expect(coordinator.pendingCount()).toBe(0);
    }
  });

  test("same-generation durable entry offered to no-result claim drops and stays durable", async () => {
    const sink = new RecordingSink();
    const coordinator = new AuditCoordinator(sink);
    await coordinator.receiveCall(meta({ requestId: "durable-no-result" }));
    const result = await coordinator.handleCallback("durable-no-result", async () =>
      callbackResult({ returnedIds: ["durable-id"], returnedCount: 1 }),
    );
    const outbound = await coordinator.handleOutbound({
      jsonrpc: "2.0",
      id: "durable-no-result",
      result,
    });
    if (outbound.correlation.kind !== "pending") {
      throw new Error("expected pending durable correlation");
    }
    expect(outbound.correlation.result).toBe("durable");
    const noResultCorrelation: OutboundCorrelation = {
      kind: "pending",
      generation: outbound.correlation.generation,
      result: "no_result",
    };
    const invalidClaim = await coordinator.claimNoResultOutbound(
      "durable-no-result",
      noResultCorrelation,
    );
    expect(invalidClaim.action).toBe("drop");
    expect(coordinator.pendingCount()).toBe(1);

    const durableClaim = await coordinator.claimOutbound("durable-no-result", outbound.correlation);
    expect(durableClaim.action).toBe("send");
    if (durableClaim.action !== "send") throw new Error("expected durable send claim");
    await coordinator.completeOutbound("durable-no-result", durableClaim.generation, {
      status: "released",
    });
    expect(coordinator.pendingCount()).toBe(0);
  });

  test("same-generation no-result entry without a fixed replacement drops", async () => {
    const sink = new RecordingSink();
    sink.fail = "attempt";
    const coordinator = new AuditCoordinator(sink);
    const decision = await coordinator.receiveCall(meta({ requestId: "no-fixed-replacement" }));
    expect(decision.action).toBe("respond");
    if (decision.action !== "respond") throw new Error("expected fixed attempt response");
    const outbound = await coordinator.handleOutbound({
      jsonrpc: "2.0",
      id: "no-fixed-replacement",
      result: decision.result,
    });
    if (outbound.correlation.kind !== "pending") {
      throw new Error("expected pending no-result correlation");
    }
    expect(outbound.correlation.result).toBe("no_result");
    if (outbound.correlation.result !== "no_result") {
      throw new Error("expected no-result correlation");
    }
    const claim = await coordinator.claimNoResultOutbound(
      "no-fixed-replacement",
      outbound.correlation,
    );
    expect(claim.action).toBe("drop");
    expect(coordinator.pendingCount()).toBe(1);
    await coordinator.completeNoResultOutbound(
      "no-fixed-replacement",
      outbound.correlation.generation,
    );
    expect(coordinator.pendingCount()).toBe(0);
  });
});
